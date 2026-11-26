import { z } from 'zod';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { goals } from 'mineflayer-pathfinder';
import { Precondition, ProgressWatchdog, SkillContext, SkillDefinition, SkillOutcome } from './contract.js';
import { canHold, countItems, goTo, isLava, sleep, stopOnAbort, stopPathfinder, stripNs } from './world.js';

/**
 * collect_drops: walk over nearby dropped items until none are left in the radius or progress stops.
 * pickUpDrops is also used by chop_tree and mine to collect what they just broke.
 */

const Args = z.object({
  radius: z.number().min(1).max(64).default(8),
  item: z.string().min(1).transform(stripNs).optional(),
});
type CollectArgs = z.infer<typeof Args>;

export interface Drop {
  id: number;
  name: string;
  count: number;
  pos: Vec3;
}

/** Item entities on the ground, with the item they hold. */
export function listDrops(bot: Bot): Drop[] {
  const out: Drop[] = [];
  for (const e of Object.values(bot.entities ?? {}) as any[]) {
    if (!e || !e.position || (e.name !== 'item' && e.displayName !== 'Item' && e.type !== 'item')) continue;
    let item: any = null;
    try {
      item = typeof e.getDroppedItem === 'function' ? e.getDroppedItem() : null;
    } catch {
      item = null;
    }
    if (!item?.name) continue;
    out.push({ id: e.id, name: item.name, count: item.count ?? 1, pos: e.position.clone() });
  }
  return out;
}

function dropsInRange(bot: Bot, origin: Vec3, radius: number, wanted?: (name: string) => boolean): Drop[] {
  return listDrops(bot).filter((d) => {
    if (wanted && !wanted(d.name)) return false;
    if (d.pos.distanceTo(origin) > radius) return false;
    if (Math.abs(d.pos.y - origin.y) > 10) return false;
    const here = bot.blockAt(d.pos);
    const below = bot.blockAt(d.pos.offset(0, -1, 0));
    if (isLava(here?.name) || isLava(below?.name) || here?.name === 'fire') return false;
    return true;
  });
}

export interface PickUpResult {
  /** Items (any kind) that entered the inventory while collecting. */
  pickedUp: number;
  /** Drops still lying in range that could not be collected. */
  left: Drop[];
  stoppedBy: 'none_left' | 'no_progress' | 'aborted' | 'inventory_full';
}

/**
 * Collects drops within `radius` of `around` (default: where the bot is now). Stops when none are left, when the
 * watchdog sees no drop collected and no step closer for its whole window, or when the step is cancelled.
 */
export async function pickUpDrops(ctx: SkillContext, opts: { radius: number; wanted?: (name: string) => boolean; around?: Vec3; windowMs?: number }): Promise<PickUpResult> {
  const bot = ctx.bot;
  const origin = (opts.around ?? bot.entity.position).clone();
  const total = () => countItems(bot, () => true);
  const startTotal = total();
  const failures = new Map<number, number>();
  const watchdog = new ProgressWatchdog(opts.windowMs ?? 6000, 0, false);
  const dispose = stopOnAbort(ctx);
  let stoppedBy: PickUpResult['stoppedBy'] = 'none_left';
  let fullFor = false;
  let handled = 0;
  try {
    for (;;) {
      if (ctx.signal.aborted) {
        stoppedBy = 'aborted';
        break;
      }
      if (watchdog.stuck) {
        stoppedBy = 'no_progress';
        break;
      }
      const all = dropsInRange(bot, origin, opts.radius, opts.wanted);
      const targets = all.filter((d) => (failures.get(d.id) ?? 0) < 2 && canHold(bot, d.name));
      fullFor = all.some((d) => !canHold(bot, d.name));
      if (!targets.length) {
        stoppedBy = fullFor && all.length ? 'inventory_full' : all.some((d) => (failures.get(d.id) ?? 0) >= 2) ? 'no_progress' : 'none_left';
        break;
      }
      const me = bot.entity.position;
      targets.sort((a, b) => a.pos.distanceTo(me) - b.pos.distanceTo(me));
      const t = targets[0];
      ctx.log(`[collect] bot ${me.floored()} -> ${t.name} x${t.count} at ${t.pos.floored()} (id ${t.id}); ${targets.length} target(s)`);
      const before = total();
      // Already on top of it: items are picked up within about a block, give the server a moment.
      if (t.pos.distanceTo(me) > 1.2) {
        const goal = new goals.GoalNear(t.pos.x, t.pos.y, t.pos.z, 0.8);
        const gr = await goTo(ctx, goal, () => bot.entity.position.distanceTo(t.pos), 5000);
        ctx.log(`[collect] goTo ${gr.reason} ${gr.detail ?? ''}`);
        if (ctx.signal.aborted) {
          stoppedBy = 'aborted';
          break;
        }
      }
      // Wait briefly for the item entity to vanish (picked up) or the inventory to grow.
      for (let i = 0; i < 8 && bot.entities[t.id] && total() === before; i++) await sleep(100);
      const gone = !bot.entities[t.id];
      ctx.log(`[collect] after: bot ${bot.entity.position.floored()} gone=${gone} total ${before} -> ${total()}`);
      if (total() > before || gone) watchdog.report(++handled);
      else failures.set(t.id, (failures.get(t.id) ?? 0) + 1);
    }
  } finally {
    dispose();
    stopPathfinder(bot);
  }
  const left = dropsInRange(bot, origin, opts.radius, opts.wanted);
  return { pickedUp: Math.max(0, total() - startTotal), left, stoppedBy };
}

export const collectDropsSkill: SkillDefinition<CollectArgs> = {
  name: 'collect_drops',
  summary: 'collect_drops {radius?=8, item?}: walk over dropped items within `radius` blocks (optionally only one kind) and pick them up.',
  args: Args,
  check(ctx, args): Precondition {
    const wanted = args.item ? (n: string) => n === args.item : undefined;
    if (args.item && !ctx.bot.registry.itemsByName[args.item]) return { ok: false, cause: 'invalid_args', message: `There is no item called "${args.item}".` };
    const drops = dropsInRange(ctx.bot, ctx.bot.entity.position, args.radius, wanted);
    if (!drops.length) {
      return { ok: false, cause: 'not_found_nearby', message: `No dropped ${args.item ?? 'items'} within ${args.radius} blocks.` };
    }
    return { ok: true };
  },
  async run(ctx, args): Promise<SkillOutcome> {
    const wanted = args.item ? (n: string) => n === args.item : undefined;
    const seen = dropsInRange(ctx.bot, ctx.bot.entity.position, args.radius, wanted);
    if (!seen.length) return { status: 'failed', cause: 'not_found_nearby', message: `No dropped ${args.item ?? 'items'} within ${args.radius} blocks.`, evidence: [] };
    const evidence = [`drops seen: ${seen.map((d) => `${d.name} x${d.count}`).join(', ')}`];
    const r = await pickUpDrops(ctx, { radius: args.radius, wanted });
    evidence.push(`picked up ${r.pickedUp} item(s); stopped by ${r.stoppedBy}`);
    if (r.left.length) evidence.push(`left behind: ${r.left.map((d) => `${d.name} x${d.count} at ${d.pos.floored()}`).join(', ')}`);
    if (r.stoppedBy === 'aborted') return { status: 'interrupted', cause: 'interrupted', message: 'collect_drops was cancelled.', evidence };
    if (!r.left.length) return { status: 'done', message: `Picked up ${r.pickedUp} item(s).`, evidence };
    const cause = r.stoppedBy === 'inventory_full' ? 'inventory_full' : r.pickedUp > 0 ? 'unreachable' : 'no_progress';
    return {
      status: r.pickedUp > 0 ? 'partial' : 'failed',
      cause,
      message: `Picked up ${r.pickedUp} item(s); ${r.left.length} drop(s) could not be collected (${r.stoppedBy}).`,
      fix: cause === 'inventory_full' ? 'free inventory slots (drop or store items)' : undefined,
      evidence,
    };
  },
};
