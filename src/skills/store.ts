import { z } from 'zod';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { withInventoryLock } from '../actions/reliable_craft.js';
import { Precondition, SkillDefinition, SkillOutcome } from './contract.js';
import { CONTAINER_RE, ContainerError, closeContainer, moveItems, openContainer } from './container_io.js';
import { travel } from './go_to.js';

/**
 * store: deposit items into a chest, barrel or shulker box, one slot at a time, then compare the bot's counts
 * with what was asked. With no `items` it stores everything except tools, worn armor and food.
 */

const Args = z.object({
  x: z.number().int(),
  y: z.number().int(),
  z: z.number().int(),
  items: z.record(z.number().int().min(1)).optional(),
});
type StoreArgs = z.infer<typeof Args>;

const REACH = 4.0;
const TOOL_RE = /_(pickaxe|axe|shovel|hoe|sword)$|^(shears|flint_and_steel|fishing_rod|bow|crossbow|trident|shield|compass|clock|spyglass|brush|mace|carrot_on_a_stick|warped_fungus_on_a_stick|bucket|water_bucket|lava_bucket)$/;

/** Counts in the bag and hotbar only (slots 9-44): worn armor, the off hand and crafting slots are not storable. */
export function bagCounts(bot: Bot): Record<string, number> {
  const out: Record<string, number> = {};
  const slots: any[] = (bot.inventory as any).slots;
  for (let i = 9; i < 45; i++) if (slots[i]) out[slots[i].name] = (out[slots[i].name] ?? 0) + slots[i].count;
  return out;
}

function defaultItems(bot: Bot): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, n] of Object.entries(bagCounts(bot))) {
    if (TOOL_RE.test(name) || (bot.registry as any).foodsByName?.[name]) continue;
    out[name] = n;
  }
  return out;
}

function evaluate(bot: Bot, args: StoreArgs): Precondition & { wanted?: Record<string, number> } {
  const p = new Vec3(args.x, args.y, args.z);
  const block = bot.blockAt(p);
  if (!block) return { ok: false, cause: 'unreachable', message: `The chunk at ${p} is not loaded.`, fix: 'walk closer first' };
  if (!CONTAINER_RE.test(block.name)) {
    return { ok: false, cause: 'not_found_nearby', message: `There is no container at ${p}; the block there is ${block.name}.`, fix: 'check the coordinates, or place a chest first' };
  }
  const have = bagCounts(bot);
  let wanted: Record<string, number>;
  if (args.items) {
    wanted = {};
    for (const [raw, n] of Object.entries(args.items)) {
      const name = raw.replace(/^minecraft:/, '');
      if (!bot.registry.itemsByName[name]) return { ok: false, cause: 'invalid_args', message: `There is no item called "${name}".` };
      wanted[name] = (wanted[name] ?? 0) + n;
    }
    const short = Object.entries(wanted).filter(([k, n]) => (have[k] ?? 0) < n);
    if (short.length) {
      const list = short.map(([k, n]) => `${n - (have[k] ?? 0)} more ${k}`).join(', ');
      return { ok: false, cause: 'missing_item', message: `Not enough to store: needs ${list}.`, fix: `get ${list}, or store fewer` };
    }
  } else {
    wanted = defaultItems(bot);
    if (!Object.keys(wanted).length) return { ok: false, cause: 'missing_item', message: 'Nothing to store: the inventory holds only tools, armor and food.' };
  }
  return { ok: true, wanted };
}

export const storeSkill: SkillDefinition<StoreArgs> = {
  name: 'store',
  summary: 'store {x, y, z, items?}: walk to the chest/barrel/shulker box at that block and deposit `items` ({name: count}); default is everything except tools, armor and food.',
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
    const wanted = r.wanted!;
    const pos = new Vec3(args.x, args.y, args.z);
    const block = bot.blockAt(pos)!;

    if (bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) > REACH) {
      const t = await travel(ctx, pos.x, pos.y, pos.z, 3);
      evidence.push(`walked ${t.start} -> ${t.end}`);
      if (!t.ok) return { status: t.cause === 'interrupted' ? 'interrupted' : 'failed', cause: t.cause ?? 'unreachable', message: `Could not reach the container: ${t.message}`, evidence };
    }
    if (ctx.signal.aborted) return { status: 'interrupted', cause: 'interrupted', message: 'Cancelled before storing.', evidence };

    return withInventoryLock(async (): Promise<SkillOutcome> => {
      const before = bagCounts(bot);
      let win: any;
      try {
        win = await openContainer(bot, block);
      } catch (err) {
        const e = err as ContainerError;
        return { status: 'failed', cause: e.cause ?? 'blocked', message: e.message, fix: e.fix, evidence };
      }
      evidence.push(`opened ${block.name} with ${win.inventoryStart} slots`);
      let shortReason: string | null = null;
      try {
        for (const [name, n] of Object.entries(wanted)) {
          if (ctx.signal.aborted) break;
          const res = await moveItems(bot, win, name, n, 'in', ctx.signal);
          evidence.push(`${name}: moved ${res.moved}/${n}${res.short ? ` (${res.short})` : ''}`);
          if (res.short && !shortReason) shortReason = res.short;
        }
      } catch (err) {
        evidence.push(`error while moving: ${(err as Error).message}`);
        shortReason = shortReason ?? 'rejected';
      } finally {
        await closeContainer(bot, win);
      }

      const after = bagCounts(bot);
      const problems: string[] = [];
      for (const [name, n] of Object.entries(wanted)) {
        const dropped = (before[name] ?? 0) - (after[name] ?? 0);
        evidence.push(`${name} ${before[name] ?? 0} -> ${after[name] ?? 0}`);
        if (dropped !== n) problems.push(`${name}: stored ${dropped} of ${n}`);
      }
      if ((bot.inventory as any).selectedItem) evidence.push(`cursor still holds ${(bot.inventory as any).selectedItem.name}`);
      if (ctx.signal.aborted) return { status: 'interrupted', cause: 'interrupted', message: `Cancelled while storing; ${problems.join('; ') || 'nothing missing'}.`, evidence };
      if (!problems.length) {
        return { status: 'done', message: `Stored ${Object.entries(wanted).map(([k, n]) => `${n} ${k}`).join(', ')} in the ${block.name}.`, evidence };
      }
      const stored = Object.keys(wanted).some((k) => (before[k] ?? 0) - (after[k] ?? 0) > 0);
      const full = shortReason === 'no_room';
      return {
        status: stored ? 'partial' : 'failed',
        cause: full ? 'blocked' : 'server_rejected',
        message: full ? `The ${block.name} is full: ${problems.join('; ')}.` : `Storing did not match what was asked: ${problems.join('; ')}.`,
        fix: full ? 'empty the container or use another one' : undefined,
        evidence,
      };
    });
  },
};
