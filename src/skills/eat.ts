import { z } from 'zod';
import type { Bot } from 'mineflayer';
import { Precondition, SkillDefinition, SkillOutcome } from './contract.js';
import { equipItem } from './equip.js';
import { settleInventory } from '../actions/reliable_craft.js';

/**
 * eat: eat one food item. With no name it picks the best food held (most food points, then saturation),
 * never one that hurts. Success is read from the game: the food level rose or the item count dropped.
 */

const Args = z.object({
  item: z.string().min(1).transform((s) => s.replace(/^minecraft:/, '')).optional(),
});
type EatArgs = z.infer<typeof Args>;

/** Foods that harm the bot or teleport it. Only eaten when named. */
const BAD_FOOD = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chorus_fruit']);
/** Valuable or effect-giving foods that are never picked automatically. */
const SAVE_FOR_NAMED = new Set(['golden_apple', 'enchanted_golden_apple', 'suspicious_stew']);
/** Foods the game lets the bot eat with a full food bar. */
const EDIBLE_WHEN_FULL = new Set(['golden_apple', 'enchanted_golden_apple', 'honey_bottle', 'chorus_fruit']);

function foodOf(bot: Bot, name: string): { foodPoints: number; saturation: number } | null {
  const f = (bot.registry as any).foodsByName?.[name];
  return f ? { foodPoints: f.foodPoints ?? 0, saturation: f.saturation ?? 0 } : null;
}

function count(bot: Bot, name: string): number {
  return bot.inventory.items().filter((i: any) => i.name === name && i.slot > 4).reduce((a, i) => a + i.count, 0);
}

function pickFood(bot: Bot, wanted?: string): { ok: true; name: string } | Extract<Precondition, { ok: false }> {
  if (wanted) {
    if (!bot.registry.itemsByName[wanted]) return { ok: false, cause: 'invalid_args', message: `There is no item called "${wanted}".` };
    const f = foodOf(bot, wanted);
    if (!f && wanted !== 'honey_bottle') return { ok: false, cause: 'invalid_args', message: `${wanted} is not food.` };
    if (count(bot, wanted) < 1) return { ok: false, cause: 'missing_item', message: `No ${wanted} in the inventory.`, fix: `get ${wanted}` };
    return { ok: true, name: wanted };
  }
  const options = bot.inventory
    .items()
    .filter((i: any) => i.slot > 4)
    .map((i) => ({ name: i.name, f: foodOf(bot, i.name) }))
    .filter((o) => o.f && !BAD_FOOD.has(o.name) && !SAVE_FOR_NAMED.has(o.name));
  if (!options.length) return { ok: false, cause: 'missing_item', message: 'No safe food in the inventory.', fix: 'get food (bread, cooked meat, apples, ...)' };
  options.sort((a, b) => b.f!.foodPoints - a.f!.foodPoints || b.f!.saturation - a.f!.saturation);
  return { ok: true, name: options[0].name };
}

function evaluate(bot: Bot, args: EatArgs): Precondition & { name?: string } {
  const pick = pickFood(bot, args.item);
  if (!pick.ok) return pick;
  if ((bot.food ?? 0) >= 20 && !EDIBLE_WHEN_FULL.has(pick.name)) {
    return { ok: false, cause: 'blocked', message: `The food bar is full (${bot.food}/20), so ${pick.name} cannot be eaten now.`, fix: 'wait until hungry' };
  }
  return { ok: true, name: pick.name };
}

export const eatSkill: SkillDefinition<EatArgs> = {
  name: 'eat',
  summary: 'eat {item?}: eat the named food, or the best safe food held if none is named. Refused while the food bar is full (except golden apples, honey, chorus fruit).',
  args: Args,
  check(ctx, args) {
    const r = evaluate(ctx.bot, args);
    return r.ok ? { ok: true } : r;
  },
  async run(ctx, args): Promise<SkillOutcome> {
    const bot = ctx.bot;
    const evidence: string[] = [];
    const r = evaluate(bot, args);
    if (!r.ok) return { status: 'failed', cause: r.cause, message: r.message, fix: r.fix, evidence };
    const name = r.name!;
    const foodBefore = bot.food;
    const countBefore = count(bot, name);
    evidence.push(`food ${foodBefore}, ${name} x${countBefore}`);

    const err = await equipItem(bot, name, 'hand');
    if (err) return { status: 'failed', cause: 'server_rejected', message: `Could not hold ${name}: ${err}`, evidence };
    if (ctx.signal.aborted) return { status: 'interrupted', cause: 'interrupted', message: 'Cancelled before eating.', evidence };

    let consumeError: string | null = null;
    const eating = (bot.consume() as Promise<void>).then(
      () => undefined,
      (e: Error) => {
        consumeError = e.message;
      }
    );
    // Eating takes about 1.6 s; stop waiting if cancelled. The call itself cannot be cancelled, so release the item.
    for (;;) {
      const state = await Promise.race([eating.then(() => 'done'), new Promise<string>((r) => setTimeout(() => r('tick'), 200))]);
      if (state === 'done') break;
      if (ctx.signal.aborted) {
        bot.deactivateItem();
        return { status: 'interrupted', cause: 'interrupted', message: 'Cancelled while eating.', evidence };
      }
    }
    await settleInventory(bot);
    await bot.waitForTicks(4);
    const foodAfter = bot.food;
    const countAfter = count(bot, name);
    evidence.push(`food ${foodBefore} -> ${foodAfter}`, `${name} ${countBefore} -> ${countAfter}`);
    if (consumeError) evidence.push(`consume reported: ${consumeError}`);
    if (foodAfter > foodBefore || countAfter < countBefore) {
      return { status: 'done', message: `Ate ${name}; food ${foodBefore} -> ${foodAfter}.`, evidence };
    }
    return { status: 'failed', cause: 'server_rejected', message: `Tried to eat ${name} but nothing changed${consumeError ? ` (${consumeError})` : ''}.`, evidence };
  },
};
