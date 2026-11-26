import { z } from 'zod';
import { Vec3 } from 'vec3';
import type { Bot } from 'mineflayer';
import { withInventoryLock } from '../actions/reliable_craft.js';
import { Precondition, SkillDefinition, SkillOutcome } from './contract.js';
import { CONTAINER_RE, ContainerError, closeContainer, countRange, moveItems, openContainer } from './container_io.js';
import { travel } from './go_to.js';
import { bagCounts } from './store.js';

/**
 * take: withdraw exact counts from a chest, barrel or shulker box. All or nothing on the contents: if the
 * container does not hold enough of every item, nothing is taken and the evidence lists what it does hold.
 */

const Args = z.object({
  x: z.number().int(),
  y: z.number().int(),
  z: z.number().int(),
  items: z.record(z.number().int().min(1)).refine((r) => Object.keys(r).length > 0, 'name at least one item'),
});
type TakeArgs = z.infer<typeof Args>;

const REACH = 4.0;

function evaluate(bot: Bot, args: TakeArgs): Precondition & { wanted?: Record<string, number> } {
  const p = new Vec3(args.x, args.y, args.z);
  const block = bot.blockAt(p);
  if (!block) return { ok: false, cause: 'unreachable', message: `The chunk at ${p} is not loaded.`, fix: 'walk closer first' };
  if (!CONTAINER_RE.test(block.name)) {
    return { ok: false, cause: 'not_found_nearby', message: `There is no container at ${p}; the block there is ${block.name}.`, fix: 'check the coordinates' };
  }
  const wanted: Record<string, number> = {};
  for (const [raw, n] of Object.entries(args.items)) {
    const name = raw.replace(/^minecraft:/, '');
    if (!bot.registry.itemsByName[name]) return { ok: false, cause: 'invalid_args', message: `There is no item called "${name}".` };
    wanted[name] = (wanted[name] ?? 0) + n;
  }
  return { ok: true, wanted };
}

export const takeSkill: SkillDefinition<TakeArgs> = {
  name: 'take',
  summary: 'take {x, y, z, items}: walk to the chest/barrel/shulker box at that block and withdraw exactly `items` ({name: count}).',
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
    if (ctx.signal.aborted) return { status: 'interrupted', cause: 'interrupted', message: 'Cancelled before taking.', evidence };

    return withInventoryLock(async (): Promise<SkillOutcome> => {
      const before = bagCounts(bot);
      let win: any;
      try {
        win = await openContainer(bot, block);
      } catch (err) {
        const e = err as ContainerError;
        return { status: 'failed', cause: e.cause ?? 'blocked', message: e.message, fix: e.fix, evidence };
      }
      let shortReason: string | null = null;
      try {
        const holds = countRange(win, 0, win.inventoryStart);
        evidence.push(`container holds: ${Object.keys(holds).length ? Object.entries(holds).map(([k, n]) => `${k} x${n}`).join(', ') : 'nothing'}`);
        const lacking = Object.entries(wanted).filter(([k, n]) => (holds[k] ?? 0) < n);
        if (lacking.length) {
          const list = lacking.map(([k, n]) => `${n - (holds[k] ?? 0)} more ${k}`).join(', ');
          return { status: 'failed', cause: 'missing_item', message: `The ${block.name} does not hold enough: needs ${list}. Nothing was taken.`, fix: `find ${list} elsewhere, or take less`, evidence };
        }
        for (const [name, n] of Object.entries(wanted)) {
          if (ctx.signal.aborted) break;
          const res = await moveItems(bot, win, name, n, 'out', ctx.signal);
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
        const gained = (after[name] ?? 0) - (before[name] ?? 0);
        evidence.push(`${name} ${before[name] ?? 0} -> ${after[name] ?? 0}`);
        if (gained !== n) problems.push(`${name}: took ${gained} of ${n}`);
      }
      if (ctx.signal.aborted) return { status: 'interrupted', cause: 'interrupted', message: `Cancelled while taking; ${problems.join('; ') || 'nothing missing'}.`, evidence };
      if (!problems.length) {
        return { status: 'done', message: `Took ${Object.entries(wanted).map(([k, n]) => `${n} ${k}`).join(', ')} from the ${block.name}.`, evidence };
      }
      const took = Object.keys(wanted).some((k) => (after[k] ?? 0) - (before[k] ?? 0) > 0);
      const full = shortReason === 'no_room';
      return {
        status: took ? 'partial' : 'failed',
        cause: full ? 'inventory_full' : 'server_rejected',
        message: full ? `The inventory is full: ${problems.join('; ')}.` : `Taking did not match what was asked: ${problems.join('; ')}.`,
        fix: full ? 'free inventory slots (store or drop something)' : undefined,
        evidence,
      };
    });
  },
};
