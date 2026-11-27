import { z } from 'zod';
import type { Bot } from 'mineflayer';
import { withInventoryLock } from '../actions/reliable_craft.js';
import { Precondition, SkillDefinition, SkillOutcome } from './contract.js';
import { playerEntity } from './come_to.js';
import { travel } from './go_to.js';
import { sleep } from './world.js';

/**
 * give: hand items to a player by tossing them at their feet from close by. Walks to within 2 blocks, faces
 * them, tosses exactly `count` (one stack at a time, under the inventory lock), then checks that the items left
 * the bot's inventory and that no matching item is still lying on the ground nearby after the pickup delay. What
 * the player really received is the judge's business (server-side inventory), not the bot's.
 */

const Args = z.object({
  player: z.string().min(1).max(16),
  item: z.string().min(1).transform((s) => s.replace(/^minecraft:/, '')),
  count: z.number().int().min(1).max(2304),
});
type GiveArgs = z.infer<typeof Args>;

const CLOSE = 2.2;
/** A dropped item cannot be picked up for 40 ticks (2 s). */
const PICKUP_WAIT_MS = 2600;

const held = (bot: Bot, item: string) => bot.inventory.items().filter((i) => i.name === item).reduce((a, i) => a + i.count, 0);

/** Item entities of this kind lying within `radius` of a point. */
function groundItems(bot: Bot, item: string, around: { x: number; y: number; z: number }, radius: number): any[] {
  const out: any[] = [];
  for (const e of Object.values(bot.entities) as any[]) {
    if (!e?.position || e.name !== 'item' || e.isValid === false) continue;
    const dropped = e.getDroppedItem?.();
    if (dropped?.name !== item) continue;
    const p = e.position;
    if (Math.hypot(p.x - around.x, p.y - around.y, p.z - around.z) <= radius) out.push(e);
  }
  return out;
}

function evaluate(bot: Bot, args: GiveArgs): Precondition {
  if (!bot.registry.itemsByName[args.item]) return { ok: false, cause: 'invalid_args', message: `There is no item called "${args.item}".` };
  const n = held(bot, args.item);
  if (n < args.count) {
    return { ok: false, cause: 'missing_item', message: `Giving ${args.count} ${args.item} needs ${args.count - n} more; the bot holds ${n}.`, fix: `get ${args.count - n} more ${args.item}, or give fewer` };
  }
  if (!playerEntity(bot, args.player)) return { ok: false, cause: 'not_found_nearby', message: `${args.player} is not in sight.`, fix: 'use come_to first' };
  return { ok: true };
}

export const giveSkill: SkillDefinition<GiveArgs> = {
  name: 'give',
  summary: 'give {player, item, count}: walk up to the named player and hand them exactly `count` of an item you hold (tossed at their feet from about 2 blocks). Use for "give me 5 logs".',
  args: Args,
  check: (ctx, args) => evaluate(ctx.bot, args),
  async run(ctx, args): Promise<SkillOutcome> {
    const bot = ctx.bot;
    const evidence: string[] = [];
    const pre = evaluate(bot, args);
    if (!pre.ok) return { status: 'failed', cause: pre.cause, message: pre.message, fix: pre.fix, evidence };

    // Get close, and face them.
    for (let attempt = 0; attempt < 3; attempt++) {
      const e = playerEntity(bot, args.player);
      if (!e) return { status: 'failed', cause: 'not_found_nearby', message: `${args.player} went out of sight.`, evidence };
      if (bot.entity.position.distanceTo(e.position) <= CLOSE) break;
      const t = await travel(ctx, e.position.x, e.position.y, e.position.z, 2);
      evidence.push(`walked ${t.start} -> ${t.end} (${t.message})`);
      if (!t.ok) return { status: t.cause === 'interrupted' ? 'interrupted' : 'failed', cause: t.cause ?? 'unreachable', message: `Could not get to ${args.player}: ${t.message}`, evidence };
    }
    if (ctx.signal.aborted) return { status: 'interrupted', cause: 'interrupted', message: 'Cancelled before giving.', evidence };
    const target = playerEntity(bot, args.player);
    if (!target) return { status: 'failed', cause: 'not_found_nearby', message: `${args.player} went out of sight.`, evidence };
    const dist = bot.entity.position.distanceTo(target.position);
    evidence.push(`distance to ${args.player} when giving: ${dist.toFixed(1)}`);
    if (dist > CLOSE + 1.5) return { status: 'failed', cause: 'unreachable', message: `Only got within ${dist.toFixed(1)} blocks of ${args.player}.`, evidence };

    const before = held(bot, args.item);
    return withInventoryLock(async (): Promise<SkillOutcome> => {
      let remaining = args.count;
      let tossed = 0;
      try {
        while (remaining > 0 && !ctx.signal.aborted) {
          const live = playerEntity(bot, args.player);
          if (live) // Aim at their feet: a toss thrown level flies about 3 blocks and lands past them.
          await bot.lookAt(live.position.offset(0, 0.2, 0), true);
          const stack = bot.inventory.items().find((i) => i.name === args.item);
          if (!stack) break;
          const n = Math.min(stack.count, remaining);
          await bot.toss(stack.type, null, n);
          tossed += n;
          remaining -= n;
          evidence.push(`tossed ${n} ${args.item}`);
          await sleep(250);
        }
      } catch (err) {
        evidence.push(`error while tossing: ${(err as Error).message}`);
      }
      const after = held(bot, args.item);
      const left = before - after;
      evidence.push(`${args.item} ${before} -> ${after}`);
      if (ctx.signal.aborted) return { status: 'interrupted', cause: 'interrupted', message: `Cancelled while giving; ${left} ${args.item} left the inventory.`, evidence };
      if (left !== args.count) {
        return { status: left > 0 ? 'partial' : 'failed', cause: 'server_rejected', message: `Meant to give ${args.count} ${args.item}, but ${left} left the inventory (tossed ${tossed}).`, evidence };
      }

      // Wait out the pickup delay, then see whether the items are still lying around.
      await sleep(PICKUP_WAIT_MS);
      const at = playerEntity(bot, args.player)?.position ?? bot.entity.position;
      const unique = [...new Set([...groundItems(bot, args.item, at, 6), ...groundItems(bot, args.item, bot.entity.position, 6)])];
      const onGround = unique.reduce((a, e) => a + (e.getDroppedItem?.()?.count ?? 1), 0);
      evidence.push(`${onGround} ${args.item} still on the ground nearby after ${Math.round(PICKUP_WAIT_MS / 1000)} s`);
      if (onGround > 0) {
        return { status: 'partial', cause: 'blocked', message: `Tossed ${args.count} ${args.item}, but ${onGround} are still lying on the ground; ${args.player} has not picked them up.`, fix: `ask ${args.player} to stand closer, or come_to them and give again`, evidence };
      }
      return { status: 'done', message: `Gave ${args.count} ${args.item} to ${args.player}.`, evidence };
    });
  },
};
