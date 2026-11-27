import { z } from 'zod';
import type { Bot } from 'mineflayer';
import { goals } from 'mineflayer-pathfinder';
import { updatePathfinderMovements } from '../actions/techniques.js';
import { getPlaces, normalizeName } from '../memory/places.js';
import { ProgressWatchdog, SkillContext, SkillDefinition, SkillOutcome, FailureCause } from './contract.js';

/**
 * go_to: walk to a point. No distance cap: a long trip is split into legs of at most LEG blocks so the
 * pathfinder never has to search a huge area at once. Progress is measured as the distance still to go.
 *
 * `travel` is exported for the other skills (place, store, take) that need to walk somewhere first.
 */

const Args = z
  .object({
    x: z.number().finite().optional(),
    y: z.number().finite().optional(),
    z: z.number().finite().optional(),
    /** A name set with remember_place ("base"); used instead of x, y, z. */
    place: z.string().min(1).max(40).optional(),
    range: z.number().min(0).max(64).default(1),
  })
  .refine((a) => a.place !== undefined || (a.x !== undefined && a.y !== undefined && a.z !== undefined), { message: 'give x, y and z, or a place name' });
type GoToArgs = z.infer<typeof Args>;

/** Longest straight stretch handed to the pathfinder in one go. */
const LEG = 64;
/** How long the distance left may fail to improve. Detours around walls legitimately move away first. */
const STALL_MS = 15000;

export interface TravelResult {
  ok: boolean;
  cause?: FailureCause;
  message: string;
  start: string;
  end: string;
  /** Straight-line distance still to go (to the target point). */
  left: number;
}

const fmt = (v: { x: number; y: number; z: number }) => `${v.x.toFixed(1)}, ${v.y.toFixed(1)}, ${v.z.toFixed(1)}`;

function centre(x: number, y: number, z: number) {
  return { x: Math.floor(x) + 0.5, y, z: Math.floor(z) + 0.5 };
}

function distanceLeft(bot: Bot, x: number, y: number, z: number): number {
  const p = bot.entity.position;
  const c = centre(x, y, z);
  return Math.hypot(p.x - c.x, p.y - c.y, p.z - c.z);
}

/** Runs one pathfinder goal; resolves to an error message or null on success. Stops the pathfinder on abort or stall. */
async function runGoal(ctx: SkillContext, goal: any, watchdog: ProgressWatchdog, measure: () => number): Promise<{ error: string | null; stalled: boolean; aborted: boolean }> {
  const bot: any = ctx.bot;
  const done = bot.pathfinder.goto(goal).then(
    () => null as string | null,
    (e: Error) => String(e?.message ?? e)
  );
  for (;;) {
    const finished = await Promise.race([done, new Promise<'tick'>((r) => setTimeout(() => r('tick'), 250))]);
    if (finished !== 'tick') return { error: finished, stalled: false, aborted: false };
    watchdog.report(measure());
    if (ctx.signal.aborted || watchdog.stuck) {
      bot.pathfinder.stop();
      await Promise.race([done, new Promise((r) => setTimeout(r, 1000))]);
      return { error: null, stalled: !ctx.signal.aborted, aborted: ctx.signal.aborted };
    }
  }
}

/**
 * Walks to within `range` blocks of (x, y, z). Never throws.
 */
export async function travel(ctx: SkillContext, x: number, y: number, z: number, range: number): Promise<TravelResult> {
  const bot: any = ctx.bot;
  const start = fmt(bot.entity.position);
  const result = (ok: boolean, message: string, cause?: FailureCause): TravelResult => ({
    ok,
    cause,
    message,
    start,
    end: fmt(bot.entity.position),
    left: Number(distanceLeft(ctx.bot, x, y, z).toFixed(2)),
  });
  if (!bot.pathfinder) return result(false, 'The pathfinder is not loaded.', 'unknown');
  updatePathfinderMovements(ctx.bot);

  const watchdog = new ProgressWatchdog(STALL_MS, distanceLeft(ctx.bot, x, y, z));
  const measure = () => distanceLeft(ctx.bot, x, y, z);
  let replans = 0;

  for (let leg = 0; leg < 200; leg++) {
    if (ctx.signal.aborted) return result(false, 'Cancelled while walking.', 'interrupted');
    const p = bot.entity.position;
    const flat = Math.hypot(p.x - (Math.floor(x) + 0.5), p.z - (Math.floor(z) + 0.5));
    let goal: any;
    if (flat > LEG) {
      // Intermediate waypoint straight toward the target; only x and z matter, the pathfinder finds the ground.
      const f = (LEG - 4) / flat;
      const wx = p.x + ((Math.floor(x) + 0.5) - p.x) * f;
      const wz = p.z + ((Math.floor(z) + 0.5) - p.z) * f;
      goal = new goals.GoalNearXZ(Math.floor(wx), Math.floor(wz), 3);
    } else {
      goal = new goals.GoalNear(Math.floor(x), Math.floor(y), Math.floor(z), range);
    }
    const r = await runGoal(ctx, goal, watchdog, measure);
    if (r.aborted) return result(false, 'Cancelled while walking.', 'interrupted');
    if (r.stalled) return result(false, `No progress toward the target for ${Math.round(STALL_MS / 1000)} s; ${measure().toFixed(1)} blocks left.`, 'no_progress');
    if (r.error) {
      if (/No path/i.test(r.error)) return result(false, `The pathfinder found no path (${r.error}).`, 'unreachable');
      if (/too long|timeout|timed out/i.test(r.error) && replans++ < 2) {
        watchdog.touch();
        continue; // The search ran out of time; the bot has moved a little, so search again from here.
      }
      if (/cancel|stopped|changed/i.test(r.error)) return result(false, `The walk was cut short (${r.error}).`, ctx.signal.aborted ? 'interrupted' : 'no_progress');
      return result(false, `The pathfinder failed: ${r.error}`, /too long|timeout|timed out/i.test(r.error) ? 'no_progress' : 'unknown');
    }
    watchdog.touch();
    if (goal instanceof goals.GoalNear) {
      return result(true, 'Arrived.');
    }
  }
  return result(false, 'Too many legs; the target is farther than 12000 blocks or the bot keeps being pushed back.', 'no_progress');
}

/** Resolves the target of a go_to step: the coordinates, or the named place. */
function targetOf(a: GoToArgs): { x: number; y: number; z: number } | null {
  if (a.x !== undefined && a.y !== undefined && a.z !== undefined && a.place === undefined) return { x: a.x, y: a.y, z: a.z };
  const p = a.place !== undefined ? getPlaces().getNamed(a.place) : null;
  return p ? { x: p.x, y: p.y, z: p.z } : null;
}

export const goToSkill: SkillDefinition<GoToArgs> = {
  name: 'go_to',
  summary: 'go_to {x, y, z, range?=1} or {place, range?}: walk (pathfinding around obstacles, any distance) to within `range` blocks of a point, or of a place named with remember_place.',
  args: Args,
  check(ctx, args) {
    if (!(ctx.bot as any).pathfinder) return { ok: false, cause: 'unknown', message: 'The pathfinder is not available.' };
    if (!ctx.bot.entity) return { ok: false, cause: 'unknown', message: 'The bot is not in the world.' };
    const t = targetOf(args);
    if (!t) {
      const known = getPlaces().listNamed().map((p) => p.name);
      return { ok: false, cause: 'invalid_args', message: `I do not know a place called "${normalizeName(args.place ?? '')}".${known.length ? ` Known places: ${known.join(', ')}.` : ' No places are remembered yet.'}`, fix: 'use remember_place first, or give x, y, z' };
    }
    if (Math.abs(t.y) > 400) return { ok: false, cause: 'invalid_args', message: `y=${t.y} is outside the world.` };
    return { ok: true };
  },
  async run(ctx, args): Promise<SkillOutcome> {
    const target = targetOf(args)!;
    const t = await travel(ctx, target.x, target.y, target.z, args.range);
    const evidence = [`start ${t.start}`, `end ${t.end}`, `distance left ${t.left}`];
    if (t.ok) return { status: 'done', message: `Arrived at ${t.end} (${t.left} blocks from the target).`, evidence };
    return {
      status: t.cause === 'interrupted' ? 'interrupted' : 'failed',
      cause: t.cause ?? 'unknown',
      message: t.message,
      evidence,
      fix: t.cause === 'unreachable' ? 'pick a different target, or clear or bridge the way' : undefined,
    };
  },
};
