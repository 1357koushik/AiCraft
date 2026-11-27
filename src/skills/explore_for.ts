import { z } from 'zod';
import type { Bot } from 'mineflayer';
import { goals } from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { SkillContext, SkillDefinition, SkillOutcome } from './contract.js';
import { goTo } from './world.js';
import { findBlocksAsync, getPlaces, kindOf, scanPlacesNow, stateIdsFor, VILLAGE_BLOCKS } from '../memory/places.js';

/**
 * explore_for: go looking for a kind of block ("iron_ore", "oak_log", "sand") or a village, until one is
 * within reach of sight or the distance budget is used up (ROADMAP.md Phase 3, CAPABILITIES.md 6 and 20).
 *
 * Order of work: look at what is already loaded around the bot; then go to the nearest place the memory
 * (src/memory/places.ts) knows; then walk outward in legs, along `direction` or in an expanding square spiral,
 * looking at the loaded chunks after every leg and during it. Legs use the shared pathfinder settings (no lava,
 * drops of at most 3 blocks, no digging), so it only walks surface ground and caves it can path into. Ores that
 * lie deep underground are reported with their depth: reaching them is a separate mining step.
 */

const DIRECTIONS = ['north', 'south', 'east', 'west', 'northeast', 'northwest', 'southeast', 'southwest'] as const;
type Direction = (typeof DIRECTIONS)[number];

const Args = z.object({
  target: z.string().min(1).transform((s) => s.trim().toLowerCase().replace(/^minecraft:/, '').replace(/[\s-]+/g, '_')),
  maxDistance: z.number().int().min(16).max(1024).default(256),
  direction: z
    .string()
    .transform((s) => s.trim().toLowerCase().replace(/[\s_-]+/g, ''))
    .pipe(z.enum(DIRECTIONS))
    .optional(),
});
type ExploreArgs = z.infer<typeof Args>;

/** How far the bot looks in the loaded chunks (the server sends 10 chunks = 160 blocks around the bot). */
const SIGHT = 112;
/** A block this close counts as "found": mine and chop_tree look 48 blocks around them, and reaching is easier from near. */
const CLOSE = 24;
/** Distance between spiral waypoints. Smaller than 2 x SIGHT so the looked-at squares overlap. */
const SPIRAL_STEP = 80;
/** One straight stretch handed to the pathfinder. */
const LEG = 56;
/** Longest walk is this many times maxDistance. */
const WALK_BUDGET_FACTOR = 8;
/** Legs in a row that could not be walked before the search stops as unreachable. */
const MAX_FAILED_LEGS = 6;

// ---------------------------------------------------------------------------------------------
// Pure parts (unit tested)
// ---------------------------------------------------------------------------------------------

export interface Target {
  label: string;
  /** Registry block names that count. */
  names: string[];
  /** Recorded as a structure in the memory rather than as a resource. */
  structure?: boolean;
}

const ORE_WORDS = ['coal', 'iron', 'copper', 'gold', 'redstone', 'lapis', 'diamond', 'emerald'];
const RAW_TO_ORE: Record<string, string> = { raw_iron: 'iron_ore', raw_copper: 'copper_ore', raw_gold: 'gold_ore', lapis_lazuli: 'lapis_ore' };

export function resolveTarget(blockNames: string[], rawTarget: string): Target | null {
  const t = rawTarget;
  const has = (n: string) => blockNames.includes(n);
  if (t === 'village' || t === 'villages') return { label: 'village', names: VILLAGE_BLOCKS.filter(has), structure: true };
  if (['log', 'logs', 'tree', 'trees', 'wood'].includes(t)) return { label: 'logs', names: blockNames.filter((n) => /_(log|stem)$/.test(n) && !n.startsWith('stripped_')) };
  let name = RAW_TO_ORE[t] ?? t;
  if (ORE_WORDS.includes(name)) name = `${name}_ore`;
  if (name === 'red_sand_dune') return null;
  if (!has(name)) return null;
  const base = kindOf(name);
  const names = [base, `deepslate_${base}`].filter((n) => has(n) && (n === base || /_ore$/.test(base)));
  return { label: base, names: names.length ? names : [name] };
}

const DIR_VECTORS: Record<Direction, [number, number]> = {
  north: [0, -1],
  south: [0, 1],
  east: [1, 0],
  west: [-1, 0],
  northeast: [Math.SQRT1_2, -Math.SQRT1_2],
  northwest: [-Math.SQRT1_2, -Math.SQRT1_2],
  southeast: [Math.SQRT1_2, Math.SQRT1_2],
  southwest: [-Math.SQRT1_2, Math.SQRT1_2],
};

/**
 * Where to walk, in order. With a direction: points along that heading every `step` blocks up to maxDistance.
 * Without: a square spiral around the start with `step` between rings, until a ring would pass maxDistance.
 * Points are offsets from the start.
 */
export function searchWaypoints(maxDistance: number, direction?: Direction, step = SPIRAL_STEP): Array<{ dx: number; dz: number }> {
  const out: Array<{ dx: number; dz: number }> = [];
  if (direction) {
    const [vx, vz] = DIR_VECTORS[direction];
    const n = Math.ceil(maxDistance / step);
    for (let k = 1; k <= n; k++) {
      const d = Math.min(k * step, maxDistance);
      out.push({ dx: Math.round(vx * d), dz: Math.round(vz * d) });
    }
    return out;
  }
  // Square spiral on a grid: (1,0) (1,1) (0,1) (-1,1) (-1,0) (-1,-1) (0,-1) (1,-1) (2,-1) ...
  let i = 0;
  let j = 0;
  let dirI = 1;
  let dirJ = 0;
  let segment = 1;
  let passed = 0;
  let turns = 0;
  const limit = Math.floor(maxDistance / step);
  for (let guard = 0; guard < 10000; guard++) {
    i += dirI;
    j += dirJ;
    if (Math.max(Math.abs(i), Math.abs(j)) > Math.max(limit, 1)) break;
    out.push({ dx: i * Math.min(step, maxDistance), dz: j * Math.min(step, maxDistance) });
    passed++;
    if (passed === segment) {
      passed = 0;
      [dirI, dirJ] = [-dirJ, dirI]; // turn 90 degrees
      turns++;
      if (turns % 2 === 0) segment++;
    }
  }
  return out;
}

const COMPASS = ['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east'];
export function compass(dx: number, dz: number): string {
  const a = (Math.atan2(dz, dx) * 180) / Math.PI;
  return COMPASS[Math.round(((a + 360) % 360) / 45) % 8];
}

// ---------------------------------------------------------------------------------------------
// Walking
// ---------------------------------------------------------------------------------------------

interface Walk {
  /** Blocks walked so far, summed over all legs. */
  walked: number;
  last: { x: number; z: number } | null;
}

type WalkEnd = 'arrived' | 'stopped' | 'no_path' | 'stuck' | 'aborted' | 'error';

/**
 * Walks to within `range` blocks (flat) of x, z in legs of at most LEG blocks. `stop` is asked about once a
 * second and a true answer ends the walk early ('stopped').
 */
async function walkXZ(ctx: SkillContext, walk: Walk, x: number, z: number, range: number, stop: () => boolean): Promise<WalkEnd> {
  const bot = ctx.bot;
  const flatTo = (tx: number, tz: number) => Math.hypot(bot.entity.position.x - tx, bot.entity.position.z - tz);
  for (let leg = 0; leg < 80; leg++) {
    if (ctx.signal.aborted) return 'aborted';
    const flat = flatTo(x, z);
    if (flat <= range + 0.5) return 'arrived';
    let wx = x;
    let wz = z;
    let wr = range;
    const intermediate = flat > LEG + 8;
    if (intermediate) {
      const p = bot.entity.position;
      wx = p.x + ((x - p.x) * LEG) / flat;
      wz = p.z + ((z - p.z) * LEG) / flat;
      wr = 3;
    }
    const child = new AbortController();
    const onParent = () => child.abort();
    ctx.signal.addEventListener('abort', onParent, { once: true });
    let stoppedEarly = false;
    let lastLook = Date.now();
    const remaining = () => {
      const p = bot.entity.position;
      if (walk.last) walk.walked += Math.hypot(p.x - walk.last.x, p.z - walk.last.z);
      walk.last = { x: p.x, z: p.z };
      if (!stoppedEarly && Date.now() - lastLook > 1000) {
        lastLook = Date.now();
        if (stop()) {
          stoppedEarly = true;
          child.abort();
        }
      }
      return flatTo(wx, wz);
    };
    walk.last = { x: bot.entity.position.x, z: bot.entity.position.z };
    let r;
    try {
      // canDig false: exploring never tunnels, it goes around.
      r = await goTo({ ...ctx, signal: child.signal }, new goals.GoalNearXZ(Math.floor(wx), Math.floor(wz), wr), remaining, 15000, false, 8000, true);
    } finally {
      ctx.signal.removeEventListener('abort', onParent);
    }
    remaining(); // count the last stretch
    if (ctx.signal.aborted) return 'aborted';
    if (stoppedEarly) return 'stopped';
    if (!r.ok) ctx.log(`[explore_for] walk to ${Math.floor(wx)} ${Math.floor(wz)} failed: ${r.reason} ${r.detail ?? ''} (at ${bot.entity.position.x.toFixed(0)} ${bot.entity.position.y.toFixed(0)} ${bot.entity.position.z.toFixed(0)})`);
    if (!r.ok) return r.reason === 'no_path' ? 'no_path' : r.reason === 'stuck' ? 'stuck' : r.reason === 'aborted' ? 'aborted' : 'error';
  }
  return 'stuck';
}

// ---------------------------------------------------------------------------------------------
// The skill
// ---------------------------------------------------------------------------------------------

function resolve(bot: Bot, target: string): Target | null {
  return resolveTarget(Object.keys((bot.registry as any).blocksByName), target);
}

const fmtPos = (p: { x: number; y: number; z: number }) => `${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}`;

export const exploreForSkill: SkillDefinition<ExploreArgs> = {
  name: 'explore_for',
  summary:
    'explore_for {target, maxDistance?=256, direction?}: walk the surface looking for a block kind (iron_ore, oak_log, sand, water, ...) or a "village", going to a remembered place first, else outward in legs along direction (north/south/east/west/northeast...) or in a spiral. Ends within ~40 blocks of what it found and says where. Deep underground ores are only located, not reached: mining down is a separate step.',
  args: Args,
  check(ctx, a) {
    if (!(ctx.bot as any).pathfinder) return { ok: false, cause: 'unknown', message: 'The pathfinder is not available.' };
    if (!ctx.bot.entity) return { ok: false, cause: 'unknown', message: 'The bot is not in the world.' };
    if (!resolve(ctx.bot, a.target)) {
      return { ok: false, cause: 'invalid_args', message: `"${a.target}" is not a block I can search for (use a block id such as iron_ore, oak_log, sand, water, or "village", "logs").`, fix: 'use a block name' };
    }
    return { ok: true };
  },
  async run(ctx, a): Promise<SkillOutcome> {
    const bot = ctx.bot;
    const target = resolve(bot, a.target)!;
    const places = getPlaces();
    const start = bot.entity.position.clone();
    const evidence: string[] = [`start ${fmtPos(start)}`, `target ${target.label} (${target.names.join(', ')})`];
    const walk: Walk = { walked: 0, last: null };
    const rejected: Vec3[] = [];
    const startedAt = Date.now();
    let legs = 0;
    let okLegs = 0;
    let failedInRow = 0;
    let reach = 0;
    const headings = new Set<string>();

    const isRejected = (p: Vec3) => rejected.some((r) => r.distanceTo(p) < 24);
    const states = stateIdsFor(bot, target.names);
    const look = async (radius: number): Promise<Vec3[]> => (await findBlocksAsync(bot, states, radius, 16)).filter((p) => !isRejected(p));
    const nearestHit = async (radius: number): Promise<Vec3 | null> => (await look(radius))[0] ?? null;
    // While walking, the pathfinder loop asks a plain yes/no once a second; the look itself runs in the background.
    let peeking = false;
    let peekSaw = false;
    const peek = (): boolean => {
      if (!peeking) {
        peeking = true;
        look(SIGHT).then((h) => { peekSaw = h.length > 0; }, () => undefined).finally(() => { peeking = false; });
      }
      return peekSaw;
    };

    const success = async (p: Vec3, how: string): Promise<SkillOutcome> => {
      const me = bot.entity.position;
      const dy = Math.round(p.y - me.y);
      const d = me.distanceTo(p.offset(0.5, 0.5, 0.5));
      try {
        await scanPlacesNow(bot, places);
      } catch {
        // memory is a convenience
      }
      places.see(target.structure ? target.label : kindOf(bot.blockAt(p)?.name ?? target.label), p, bot.blockAt(p)?.name ?? target.label, Boolean(target.structure));
      const where = `${compass(p.x - me.x, p.z - me.z)} of you, ${d.toFixed(0)} blocks away${dy <= -6 ? `, ${-dy} below you` : dy >= 6 ? `, ${dy} above you` : ''}`;
      const deep = dy <= -8 && /_ore$/.test(target.label) ? ` It is underground: explore_for only walks the surface and caves it can path into, so reaching it means mining down (a separate step, e.g. mine {block, count}).` : '';
      evidence.push(`found ${bot.blockAt(p)?.name ?? target.label} at ${fmtPos(p)}`, `walked ${walk.walked.toFixed(0)} blocks in ${legs} legs`, `end ${fmtPos(me)}`);
      return {
        status: 'done',
        message: `Found ${target.label} at ${fmtPos(p)}, ${where} (${how}; walked ${walk.walked.toFixed(0)} blocks).${deep}`,
        evidence,
      };
    };

    const interrupted = (): SkillOutcome => ({ status: 'interrupted', cause: 'interrupted', message: `explore_for was cancelled after ${walk.walked.toFixed(0)} blocks.`, evidence });

    /** Walks toward a sighting until it is close enough to work on; null when it could not be reached. */
    const approach = async (p: Vec3): Promise<'ok' | 'aborted' | 'failed'> => {
      const me = bot.entity.position;
      if (me.distanceTo(p) <= CLOSE) return 'ok';
      const end = await walkXZ(ctx, walk, p.x + 0.5, p.z + 0.5, 8, () => false);
      if (end === 'aborted') return 'aborted';
      const flat = Math.hypot(bot.entity.position.x - p.x, bot.entity.position.z - p.z);
      if (bot.entity.position.distanceTo(p) <= CLOSE * 1.6 || flat <= 16) return 'ok';
      evidence.push(`could not get near ${fmtPos(p)} (${end}, ${flat.toFixed(0)} blocks away)`);
      return 'failed';
    };

    const tryHit = async (hit: Vec3 | null, how: string): Promise<SkillOutcome | null> => {
      if (!hit) return null;
      const r = await approach(hit);
      if (r === 'aborted') return interrupted();
      if (r === 'ok') return await success((await nearestHit(CLOSE * 1.6)) ?? hit, how);
      rejected.push(hit);
      return null;
    };

    // 1. Anything already loaded around the bot.
    peekSaw = false;
    const first = await tryHit(await nearestHit(SIGHT), 'already in view');
    if (first) return first;

    // 2. A place the memory knows.
    const remembered = places.known(target.label, start, Boolean(target.structure)).filter((s) => !isRejected(new Vec3(s.x, s.y, s.z))).slice(0, 2);
    for (const s of remembered) {
      if (ctx.signal.aborted) return interrupted();
      evidence.push(`going to remembered ${target.label} at ${s.x} ${s.y} ${s.z}`);
      ctx.log(`[explore_for] going to remembered ${target.label} at ${s.x} ${s.y} ${s.z}`);
      const here = new Vec3(s.x, s.y, s.z);
      peekSaw = false;
      const end = await walkXZ(ctx, walk, s.x + 0.5, s.z + 0.5, 12, peek);
      if (end === 'aborted') return interrupted();
      const got = await tryHit(await nearestHit(SIGHT), 'from memory');
      if (got) return got;
      // Either it is gone (someone mined it) or the way is blocked; do not trust this entry again today.
      if (end === 'arrived') places.forget(target.label, s, Boolean(target.structure));
      rejected.push(here);
    }

    // 3. Search outward.
    const cap = a.maxDistance * WALK_BUDGET_FACTOR;
    const waypoints = searchWaypoints(a.maxDistance, a.direction as Direction | undefined);
    for (const w of waypoints) {
      if (ctx.signal.aborted) return interrupted();
      if (walk.walked > cap) break;
      const wx = start.x + w.dx;
      const wz = start.z + w.dz;
      headings.add(compass(w.dx, w.dz));
      legs++;
      peekSaw = false;
      let end = await walkXZ(ctx, walk, wx, wz, 6, peek);
      if (end === 'aborted') return interrupted();
      // Water, a cliff or a thicket in the way: step aside at an angle (never digging), then try the point again.
      for (const turn of end === 'stuck' || end === 'no_path' || end === 'error' ? [60, -60, 120, -120] : []) {
        const me = bot.entity.position;
        const heading = Math.atan2(wz - me.z, wx - me.x) + (turn * Math.PI) / 180;
        peekSaw = false;
        const side = await walkXZ(ctx, walk, me.x + Math.cos(heading) * 40, me.z + Math.sin(heading) * 40, 6, peek);
        if (side === 'aborted') return interrupted();
        if (side === 'stopped') {
          end = 'stopped';
          break;
        }
        if (side !== 'arrived') continue;
        evidence.push(`sidestepped ${turn} degrees around an obstacle`);
        peekSaw = false;
        end = await walkXZ(ctx, walk, wx, wz, 6, peek);
        if (end === 'aborted') return interrupted();
        if (end === 'arrived' || end === 'stopped') break;
      }
      if (end === 'arrived' || end === 'stopped') {
        okLegs++;
        failedInRow = 0;
      } else {
        failedInRow++;
        evidence.push(`leg to ${Math.floor(wx)} ${Math.floor(wz)} ended: ${end}`);
        if (failedInRow >= MAX_FAILED_LEGS) break;
      }
      reach = Math.max(reach, Math.hypot(bot.entity.position.x - start.x, bot.entity.position.z - start.z));
      try {
        await scanPlacesNow(bot, places);
      } catch {
        // ignore
      }
      const got = await tryHit(await nearestHit(SIGHT), end === 'stopped' ? 'seen while walking' : 'seen after a leg');
      if (got) return got;
    }

    const searched = a.direction ? `heading ${a.direction}` : `in a spiral (${[...headings].join(', ') || 'no leg completed'})`;
    evidence.push(`walked ${walk.walked.toFixed(0)} blocks in ${legs} legs (${okLegs} completed)`, `seconds ${Math.round((Date.now() - startedAt) / 1000)}`);
    if (okLegs === 0 && legs > 0) {
      return {
        status: 'failed',
        cause: 'unreachable',
        message: `Could not walk anywhere to look for ${target.label}: ${failedInRow} legs in a row had no path or made no progress.`,
        fix: 'try a different direction, or clear a way out (water, cliffs and lava are avoided)',
        evidence,
      };
    }
    return {
      status: 'failed',
      cause: 'not_found_nearby',
      message: `No ${target.label} found: searched ${searched}, up to about ${Math.round(reach)} blocks from the start (limit ${a.maxDistance}), walking ${walk.walked.toFixed(0)} blocks.${failedInRow >= MAX_FAILED_LEGS ? ' The search stopped early because the way was blocked.' : ''} It may be underground (only surface and cave ground is searched).`,
      fix: a.direction ? 'try another direction or a larger maxDistance' : 'try a direction, a larger maxDistance, or a different place',
      evidence,
    };
  },
};
