import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { ProgressWatchdog, SkillContext } from './contract.js';
import { updatePathfinderMovements } from '../actions/techniques.js';

/**
 * Small helpers shared by the gathering skills (chop_tree, mine, collect_drops).
 * Everything here honours ctx.signal: a Mineflayer call cannot be cancelled, so on abort we stop the
 * pathfinder and the dig ourselves and let the awaiting call settle.
 */

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const stripNs = (s: string) => s.replace(/^minecraft:/, '');

export const EYE_HEIGHT = 1.62;
/** How far from the eye a block may be and still be broken. Vanilla allows about 4.5; keep a margin. */
export const DIG_REACH = 4.3;

/**
 * Stops the pathfinder only if it has a goal. Calling stop() while idle leaves a flag set that makes the next
 * goto() reject at once with "Path was stopped", so an idle stop must be avoided.
 */
export function stopPathfinder(bot: Bot): void {
  try {
    const pf = (bot as any).pathfinder;
    if (pf && (pf.goal || pf.isMoving?.())) {
      pf.stop();
      pf.setGoal(null);
    }
  } catch {
    // nothing to stop
  }
}

export function stopMotion(bot: Bot): void {
  stopPathfinder(bot);
  try {
    bot.stopDigging();
  } catch {
    // not digging
  }
  try {
    bot.clearControlStates();
  } catch {
    // ignore
  }
}

/** Stops movement and digging the moment the step is cancelled. Returns a function that removes the listener. */
export function stopOnAbort(ctx: SkillContext): () => void {
  const handler = () => stopMotion(ctx.bot);
  if (ctx.signal.aborted) handler();
  else ctx.signal.addEventListener('abort', handler, { once: true });
  return () => ctx.signal.removeEventListener('abort', handler);
}

export function eyeDistance(bot: Bot, pos: Vec3): number {
  const eye = bot.entity.position.offset(0, EYE_HEIGHT, 0);
  return eye.distanceTo(pos.offset(0.5, 0.5, 0.5));
}

export function isLava(name?: string): boolean {
  return name === 'lava';
}
export function isLiquid(name?: string): boolean {
  return name === 'lava' || name === 'water';
}

export const FACE_OFFSETS: Vec3[] = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 1, 0), new Vec3(0, -1, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];

/** True when the bot can add one more of `itemName` (a free slot, or a partial stack of it). */
export function canHold(bot: Bot, itemName: string, stackSize = 64): boolean {
  if (bot.inventory.emptySlotCount() > 0) return true;
  return bot.inventory.items().some((i) => i.name === itemName && i.count < Math.min(stackSize, i.stackSize ?? stackSize));
}

export function countItems(bot: Bot, match: (name: string) => boolean): number {
  let n = 0;
  for (const it of bot.inventory.items()) if (match(it.name)) n += it.count;
  return n;
}

/**
 * A goal that is reached from any standing position whose eye is within `reach` of the block's centre,
 * except a position in the block's own column at or above it (standing on a block you mean to break).
 */
export class GoalReachBlock {
  constructor(private readonly pos: Vec3, private readonly reach = DIG_REACH - 0.4) {}
  heuristic(node: { x: number; y: number; z: number }): number {
    const dx = node.x + 0.5 - (this.pos.x + 0.5);
    const dz = node.z + 0.5 - (this.pos.z + 0.5);
    const dy = node.y + EYE_HEIGHT - (this.pos.y + 0.5);
    return Math.max(0, Math.hypot(dx, dy, dz) - this.reach);
  }
  isEnd(node: { x: number; y: number; z: number }): boolean {
    if (node.x === this.pos.x && node.z === this.pos.z && node.y >= this.pos.y) return false;
    const dx = node.x + 0.5 - (this.pos.x + 0.5);
    const dz = node.z + 0.5 - (this.pos.z + 0.5);
    const dy = node.y + EYE_HEIGHT - (this.pos.y + 0.5);
    return Math.hypot(dx, dy, dz) <= this.reach;
  }
  hasChanged(): boolean {
    return false;
  }
  isValid(): boolean {
    return true;
  }
}

/** Cancels a goto that is pending: stop() makes it reject; never wait on it forever. */
async function cancelGoto(bot: any, done: Promise<boolean>): Promise<void> {
  try {
    bot.pathfinder.stop();
    // stop() only raises a flag the pathfinder acts on at its next reset; clear it now so the next goto starts clean.
    bot.pathfinder.setGoal(null);
  } catch {
    // ignore
  }
  try {
    bot.stopDigging();
    bot.clearControlStates();
  } catch {
    // ignore
  }
  await Promise.race([done, sleep(1500)]);
}

export interface GoResult {
  ok: boolean;
  reason: 'arrived' | 'no_path' | 'stuck' | 'aborted' | 'error';
  detail?: string;
}

/**
 * Runs the pathfinder to a goal. `remaining` returns a number that shrinks as the bot gets closer; the walk
 * is abandoned only when that number stops improving for `stuckMs`, not after a fixed time.
 */
export async function goTo(ctx: SkillContext, goal: any, remaining: () => number, stuckMs = 8000, canDig = true): Promise<GoResult> {
  const bot: any = ctx.bot;
  if (!bot.pathfinder) return { ok: false, reason: 'error', detail: 'pathfinder plugin not loaded' };
  if (ctx.signal.aborted) return { ok: false, reason: 'aborted' };
  const movements = updatePathfinderMovements(ctx.bot);
  if (movements) movements.canDig = canDig;
  const watchdog = new ProgressWatchdog(stuckMs, remaining());
  let failure: string | null = null;
  const done: Promise<boolean> = bot.pathfinder.goto(goal).then(
    () => true,
    (err: Error) => {
      failure = err?.message ?? String(err);
      return false;
    }
  );
  for (;;) {
    const finished = await Promise.race([done, sleep(250).then(() => null)]);
    if (finished !== null) {
      if (finished) return { ok: true, reason: 'arrived' };
      if (ctx.signal.aborted) return { ok: false, reason: 'aborted' };
      const msg = String(failure ?? '');
      // Stopped by us (stop() rejects with "Path was stopped before it could be completed").
      return { ok: false, reason: /no path/i.test(msg) ? 'no_path' : 'error', detail: msg };
    }
    if (ctx.signal.aborted) {
      await cancelGoto(bot, done);
      return { ok: false, reason: 'aborted' };
    }
    watchdog.report(remaining());
    if (watchdog.stuck) {
      await cancelGoto(bot, done);
      return { ok: false, reason: 'stuck', detail: `no closer for ${Math.round(watchdog.stalledForMs / 1000)} s` };
    }
  }
}

export const posKey = (p: { x: number; y: number; z: number }) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
