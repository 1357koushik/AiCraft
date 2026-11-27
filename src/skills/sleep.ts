import { z } from 'zod';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { body } from '../reflexes/body.js';
import { HOSTILE } from '../reflexes/guard.js';
import { FailureCause, Precondition, SkillContext, SkillDefinition, SkillOutcome } from './contract.js';
import { equipItem } from './equip.js';
import { travel } from './go_to.js';
import { sleep } from './world.js';
import { settleInventory } from '../actions/reliable_craft.js';

/**
 * sleep: use a bed to skip the night.
 *
 * It finds a bed within 32 blocks (or uses the one at x, y, z). With none, and a *_bed item in the inventory, it
 * places the bed on a flat spot nearby first. It walks next to the bed, right-clicks it, and waits until the bot
 * is asleep and then until the night is over. The result is read from the game: `bot.isSleeping` must have become
 * true, and then the world's time of day must have rolled over to morning. The server's refusals (not night, monsters
 * nearby, bed too far, obstructed, occupied) arrive as chat / action-bar text and are mapped to causes below.
 *
 * Using a bed also sets the bot's respawn point to it (the server says "Respawn point set"); death recovery uses that.
 * In multiplayer the night is only skipped when enough players sleep (gamerule playersSleepingPercentage, default
 * 100): if another player stays awake the bot stays in bed for a while, then gets up and says so.
 */

const Args = z.object({
  x: z.number().int().optional(),
  y: z.number().int().optional(),
  z: z.number().int().optional(),
});
type SleepArgs = z.infer<typeof Args>;

const SEARCH_RADIUS = 32;
/** Vanilla only lets a player start sleeping within 3 blocks horizontally and 2 vertically of the bed. */
const BED_STAND_RANGE = 2;
/** Night as the server counts it (a bed works from tick 12542 to 23459), and a margin of the morning after. */
export const NIGHT_START = 12542;
export const NIGHT_END = 23459;
/** Time of day that counts as "the night was skipped": the skip sets it to 0; a natural dawn is just before 24000. */
export const MORNING_BELOW = 1500;
/** The bot stays in bed this long (real time) waiting for the skip; five seconds of game time is enough alone. */
const SLEEP_WAIT_MS = 45000;
const MONSTER_RANGE_XZ = 8;
const MONSTER_RANGE_Y = 5;

const BED_RE = /_bed$/;
const DIRS = [
  { dx: 0, dz: -1, name: 'north' },
  { dx: 0, dz: 1, name: 'south' },
  { dx: -1, dz: 0, name: 'west' },
  { dx: 1, dz: 0, name: 'east' },
];

export interface Cell {
  x: number;
  y: number;
  z: number;
}

// ---------------------------------------------------------------------------------------------
// Pure helpers (unit tested)
// ---------------------------------------------------------------------------------------------

/** True when the time of day allows a bed to be used: night, or a thunderstorm. `undefined` time counts as unknown, allowed. */
export function isNightTime(timeOfDay: number | undefined | null, thunder = false): boolean {
  if (thunder) return true;
  if (timeOfDay === undefined || timeOfDay === null) return true;
  return timeOfDay >= NIGHT_START && timeOfDay <= NIGHT_END;
}

export function isMorning(timeOfDay: number | undefined | null): boolean {
  return typeof timeOfDay === 'number' && timeOfDay < MORNING_BELOW;
}

export interface BedRefusal {
  cause: FailureCause;
  message: string;
  fix: string;
  /** True when walking closer and trying again may help. */
  retryCloser?: boolean;
}

/** Maps what the server says when a bed is used (chat or action-bar text) to a cause and a fix, or null if it is not a refusal. */
export function classifyBedMessage(text: string): BedRefusal | null {
  const t = text.toLowerCase();
  if (/sleep only at night|only at night or during thunderstorms/.test(t)) {
    return { cause: 'blocked', message: 'The server says you can sleep only at night or during thunderstorms.', fix: 'wait until night (time of day 12542 or later), or shelter or work until then' };
  }
  if (/monsters nearby|may not rest now; there are monsters/.test(t)) {
    return { cause: 'blocked', message: 'The server says you may not rest now: there are monsters nearby.', fix: 'fight or wait out the monsters near the bed (guard), or move the bed and try again' };
  }
  if (/too far away/.test(t)) {
    return { cause: 'unreachable', message: 'The server says the bed is too far away.', fix: 'walk right next to the bed first', retryCloser: true };
  }
  if (/obstructed/.test(t)) {
    return { cause: 'blocked', message: 'The server says the bed is obstructed (a block is above it, or the other half is missing).', fix: 'clear the blocks above both halves of the bed' };
  }
  if (/occupied/.test(t)) {
    return { cause: 'blocked', message: 'The server says this bed is occupied.', fix: 'use another bed, or wait for the sleeper to get up' };
  }
  if (/not safe|you can.?t sleep|can.?t use the bed/.test(t)) {
    return { cause: 'blocked', message: `The server refused the bed: ${text}`, fix: 'check for monsters, the time of day and the dimension' };
  }
  return null;
}

/** The text of a respawn-point message, if `text` is one. */
export function isRespawnSetMessage(text: string): boolean {
  return /respawn point set|spawn point set/i.test(text);
}

export interface SpotView {
  /** The block at c is a full solid cube a bed can rest on and the bot can stand on. */
  solid(c: Cell): boolean;
  /** The cell is free to place into or stand in: air or a plant that placement replaces. No liquid. */
  free(c: Cell): boolean;
  /** A player or mob (other than the bot when `self` is false) stands in the cell; the server will not place a bed there. */
  occupied?(c: Cell, self: boolean): boolean;
}

export interface BedSpot {
  foot: Cell;
  head: Cell;
  /** Where the bot stands to place it: the cell behind the foot, looking along the bed. */
  stand: Cell;
  dx: number;
  dz: number;
}

/**
 * A flat spot for a bed: two free cells in a row on solid ground with free air above both (the server refuses a bed
 * with a block above either half), and a free standing cell behind the foot. The nearest to `origin` wins.
 */
export function findBedSpot(view: SpotView, origin: Cell, radius = 6): BedSpot | null {
  let best: { spot: BedSpot; d: number } | null = null;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const foot: Cell = { x: origin.x + dx, y: origin.y + dy, z: origin.z + dz };
        if (!view.solid({ ...foot, y: foot.y - 1 }) || !view.free(foot) || !view.free({ ...foot, y: foot.y + 1 }) || view.occupied?.(foot, true)) continue;
        for (const dir of DIRS) {
          const head: Cell = { x: foot.x + dir.dx, y: foot.y, z: foot.z + dir.dz };
          const stand: Cell = { x: foot.x - dir.dx, y: foot.y, z: foot.z - dir.dz };
          if (!view.solid({ ...head, y: head.y - 1 }) || !view.free(head) || !view.free({ ...head, y: head.y + 1 }) || view.occupied?.(head, true)) continue;
          if (!view.solid({ ...stand, y: stand.y - 1 }) || !view.free(stand) || !view.free({ ...stand, y: stand.y + 1 }) || view.occupied?.(stand, false)) continue;
          const d = Math.hypot(stand.x - origin.x, stand.y - origin.y, stand.z - origin.z);
          if (!best || d < best.d) best = { spot: { foot, head, stand, dx: dir.dx, dz: dir.dz }, d };
        }
      }
    }
  }
  return best ? best.spot : null;
}

/** Yaw (mineflayer convention) that faces the horizontal direction (dx, dz). */
export function yawFor(dx: number, dz: number): number {
  return Math.atan2(-dx, -dz);
}

// ---------------------------------------------------------------------------------------------
// World readers
// ---------------------------------------------------------------------------------------------

const REPLACEABLE = /^(air|cave_air|void_air|short_grass|tall_grass|fern|large_fern|dead_bush|snow|vine|glow_lichen|light)$/;

function isFullCube(b: any): boolean {
  if (!b || b.boundingBox !== 'block') return false;
  const shapes: number[][] | undefined = b.shapes;
  if (!shapes) return true;
  return shapes.length === 1 && shapes[0][0] <= 0.001 && shapes[0][1] <= 0.001 && shapes[0][2] <= 0.001 && shapes[0][3] >= 0.999 && shapes[0][4] >= 0.999 && shapes[0][5] >= 0.999;
}

function viewOf(bot: Bot): SpotView {
  const at = (c: Cell) => bot.blockAt(new Vec3(c.x, c.y, c.z));
  return {
    solid: (c) => {
      const b = at(c);
      return isFullCube(b) && !/^(chest|trapped_chest|ender_chest|barrel|crafting_table|furnace|blast_furnace|smoker|ice|packed_ice|blue_ice|slime_block|honey_block|magma_block|cactus|tnt|lava|water)$/.test(b!.name);
    },
    free: (c) => {
      const b = at(c);
      return Boolean(b) && REPLACEABLE.test(b!.name);
    },
    occupied: (c, self) => {
      for (const e of Object.values(bot.entities) as any[]) {
        if (!e?.position || e.name === 'item' || e.type === 'orb' || e.type === 'projectile') continue;
        if (e === bot.entity && !self) continue;
        const half = (e.width ?? 0.6) / 2;
        const p = e.position;
        // The entity's box overlaps the cell's column at that height.
        if (p.x + half > c.x && p.x - half < c.x + 1 && p.z + half > c.z && p.z - half < c.z + 1 && p.y < c.y + 1 && p.y + (e.height ?? 1.8) > c.y) return true;
      }
      return false;
    },
  };
}

function heldBedItem(bot: Bot): string | null {
  const it = bot.inventory.items().find((i: any) => BED_RE.test(i.name) && i.slot > 4 && i.slot < 45);
  return it ? it.name : null;
}

interface BedInfo {
  pos: Vec3;
  part: 'head' | 'foot';
  facing: string;
  occupied: boolean;
  other: Vec3;
}

const FACING: Record<string, Vec3> = { north: new Vec3(0, 0, -1), south: new Vec3(0, 0, 1), west: new Vec3(-1, 0, 0), east: new Vec3(1, 0, 0) };

function bedInfo(bot: Bot, pos: Vec3): BedInfo | null {
  const b: any = bot.blockAt(pos);
  if (!b || !BED_RE.test(b.name)) return null;
  const p = b.getProperties?.() ?? {};
  const facing = String(p.facing ?? 'south');
  const part = p.part === 'head' ? 'head' : 'foot';
  const v = FACING[facing] ?? FACING.south;
  return { pos: b.position, part, facing, occupied: p.occupied === true || p.occupied === 'true', other: part === 'foot' ? b.position.plus(v) : b.position.minus(v) };
}

/** Beds within the radius, nearest first, with both halves present. */
function nearbyBeds(bot: Bot, radius: number): BedInfo[] {
  const ids = Object.values((bot.registry as any).blocksByName as Record<string, any>)
    .filter((b: any) => BED_RE.test(b.name))
    .map((b: any) => b.id);
  const found = bot.findBlocks({ matching: ids, maxDistance: radius, count: 24 });
  const out: BedInfo[] = [];
  const seen = new Set<string>();
  for (const p of found) {
    const info = bedInfo(bot, p);
    if (!info) continue;
    const key = [info.pos, info.other].map((v) => v.toString()).sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    if (!bedInfo(bot, info.other)) continue; // half a bed cannot be used
    out.push(info);
  }
  const me = bot.entity.position;
  return out.sort((a, b) => a.pos.distanceTo(me) - b.pos.distanceTo(me));
}

function bedBlocked(bot: Bot, info: BedInfo): boolean {
  const above = (p: Vec3) => {
    const b = bot.blockAt(p.offset(0, 1, 0));
    return Boolean(b) && b!.boundingBox === 'block';
  };
  return above(info.pos) || above(info.other);
}

function monstersNear(bot: Bot, bed: Vec3): any[] {
  return Object.values(bot.entities).filter((e: any) => {
    if (!e?.position || e === bot.entity || e.isValid === false || !HOSTILE.has(e.name)) return false;
    return Math.abs(e.position.x - bed.x) <= MONSTER_RANGE_XZ && Math.abs(e.position.z - bed.z) <= MONSTER_RANGE_XZ && Math.abs(e.position.y - bed.y) <= MONSTER_RANGE_Y;
  });
}

function thunder(bot: Bot): boolean {
  return Boolean((bot as any).isRaining) && Number((bot as any).thunderState) > 0;
}

function dimensionOf(bot: Bot): string {
  return String((bot as any).game?.dimension ?? 'overworld').replace(/^minecraft:/, '');
}

function evaluate(bot: Bot, args: SleepArgs): Precondition {
  if (!bot.entity) return { ok: false, cause: 'unknown', message: 'The bot is not in the world.' };
  const given = [args.x, args.y, args.z].filter((v) => v !== undefined).length;
  if (given !== 0 && given !== 3) return { ok: false, cause: 'invalid_args', message: 'Give all of x, y and z for the bed, or none of them.' };
  const dim = dimensionOf(bot);
  if (dim !== 'overworld') return { ok: false, cause: 'too_dangerous', message: `Beds explode in the ${dim}.`, fix: 'sleep only in the overworld' };
  if (!isNightTime(bot.time?.timeOfDay, thunder(bot))) {
    const t = bot.time?.timeOfDay ?? 0;
    const secs = Math.max(0, Math.round((NIGHT_START - t) / 20));
    return { ok: false, cause: 'blocked', message: `It is not night (time of day ${t}); a bed only works from ${NIGHT_START} or in a thunderstorm.`, fix: `wait about ${secs} seconds until night, or do something else until then` };
  }
  if (given === 3) {
    const info = bedInfo(bot, new Vec3(args.x!, args.y!, args.z!));
    if (!bot.blockAt(new Vec3(args.x!, args.y!, args.z!))) return { ok: false, cause: 'unreachable', message: `The chunk at ${args.x} ${args.y} ${args.z} is not loaded.`, fix: 'walk closer first' };
    // A wrong spot is not fatal when another bed is near or one is held: run() falls back to those.
    if (!info && !nearbyBeds(bot, SEARCH_RADIUS).length && !heldBedItem(bot)) {
      return { ok: false, cause: 'invalid_args', message: `There is no bed at ${args.x} ${args.y} ${args.z}, none within ${SEARCH_RADIUS} blocks, and none held.`, fix: 'craft a bed (3 wool + 3 planks) or find one; shelter is the fallback' };
    }
    return { ok: true };
  }
  if (nearbyBeds(bot, SEARCH_RADIUS).length === 0 && !heldBedItem(bot)) {
    return { ok: false, cause: 'missing_item', message: `No bed within ${SEARCH_RADIUS} blocks and none in the inventory.`, fix: 'craft a bed (3 wool + 3 planks) or find one; shelter is the fallback' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// The skill
// ---------------------------------------------------------------------------------------------

async function placeBedNearby(ctx: SkillContext, item: string, evidence: string[]): Promise<{ pos: Vec3 } | { fail: SkillOutcome }> {
  const bot = ctx.bot;
  const fail = (cause: FailureCause, message: string, fix?: string): { fail: SkillOutcome } => ({ fail: { status: cause === 'interrupted' ? 'interrupted' : 'failed', cause, message, fix, evidence } });
  const me = bot.entity.position.floored();
  const spot = findBedSpot(viewOf(bot), { x: me.x, y: me.y, z: me.z });
  if (!spot) return fail('blocked', 'No flat spot for a bed within 6 blocks (needs two free cells in a row on solid ground with air above).', 'move to open flat ground, or clear a 1x2 spot');
  evidence.push(`bed spot: foot ${spot.foot.x} ${spot.foot.y} ${spot.foot.z}, head ${spot.head.x} ${spot.head.y} ${spot.head.z}, stand ${spot.stand.x} ${spot.stand.y} ${spot.stand.z}`);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (ctx.signal.aborted) return fail('interrupted', 'Cancelled before placing the bed.');
    const t = await travel(ctx, spot.stand.x, spot.stand.y, spot.stand.z, 0);
    if (!t.ok && t.cause === 'interrupted') return fail('interrupted', t.message);
    await body.waitForRelease(ctx.signal);
    const p = bot.entity.position;
    if (Math.floor(p.x) !== spot.stand.x || Math.floor(p.z) !== spot.stand.z) {
      evidence.push(`attempt ${attempt + 1}: not on the standing cell (at ${p.floored()}): ${t.message}`);
      continue;
    }
    const err = await equipItem(bot, item, 'hand');
    if (err) return fail('server_rejected', `Could not hold ${item}: ${err}`);
    // Face along the bed: the bed's direction is the way the player looks when placing.
    await bot.look(yawFor(spot.dx, spot.dz), 0.4, true);
    const floor = bot.blockAt(new Vec3(spot.foot.x, spot.foot.y - 1, spot.foot.z));
    if (!floor) return fail('unreachable', 'The floor under the bed spot is not loaded.');
    let lastError = '';
    bot.setControlState('sneak', true);
    try {
      await (bot.placeBlock(floor, new Vec3(0, 1, 0)) as Promise<void>).catch((e: Error) => {
        lastError = e.message;
      });
    } finally {
      bot.setControlState('sneak', false);
    }
    await settleInventory(bot);
    await bot.waitForTicks(6);
    const placed = bedInfo(bot, new Vec3(spot.foot.x, spot.foot.y, spot.foot.z));
    if (placed && bedInfo(bot, placed.other)) {
      evidence.push(`placed ${item} at ${placed.pos} (${placed.part}, facing ${placed.facing})${lastError ? `; placeBlock said: ${lastError}` : ''}`);
      return { pos: placed.pos };
    }
    evidence.push(`attempt ${attempt + 1}: no bed at the foot cell afterwards${lastError ? `; placeBlock said: ${lastError}` : ''}`);
    await sleep(300);
  }
  return fail('server_rejected', 'The server did not place the bed.', 'check the spot is flat, free above and not protected');
}

/** Lets a reflex that took the body finish, then returns. */
async function yieldToReflex(ctx: { signal: AbortSignal }): Promise<void> {
  if (body.reflexActive) await body.waitForRelease(ctx.signal);
}

export const sleepSkill: SkillDefinition<SleepArgs> = {
  name: 'sleep',
  summary:
    'sleep {x?, y?, z?}: use a bed to skip the night. Finds a bed within 32 blocks (or the one at x,y,z; only give coordinates of a bed you have seen); with none and a bed item held, places it on flat ground first. Needs night or a thunderstorm, no monsters within 8 blocks of the bed, and the overworld. Done only when the night really passed (time of day back to morning). It also sets the respawn point to that bed.',
  args: Args,
  check: (ctx, args) => evaluate(ctx.bot, args),
  async run(ctx, args): Promise<SkillOutcome> {
    const bot = ctx.bot;
    const evidence: string[] = [];
    const out = (status: SkillOutcome['status'], message: string, cause?: FailureCause, fix?: string): SkillOutcome => ({ status, cause, message, fix, evidence });
    const pre = evaluate(bot, args);
    if (!pre.ok) return out('failed', pre.message, pre.cause, pre.fix);

    // Everything the server says while we work: refusals arrive as chat or action-bar text.
    const heard: string[] = [];
    let respawnSet = false;
    const onMsg = (text: string) => {
      heard.push(text);
      if (isRespawnSetMessage(text)) respawnSet = true;
    };
    bot.on('messagestr', onMsg);
    try {
      return await runSleep(ctx, args, evidence, heard, () => respawnSet, out);
    } finally {
      bot.off('messagestr', onMsg);
      if (ctx.signal.aborted && bot.isSleeping) await bot.wake().catch(() => undefined);
    }
  },
};

async function runSleep(
  ctx: { bot: Bot; signal: AbortSignal; log: (l: string) => void },
  args: SleepArgs,
  evidence: string[],
  heard: string[],
  respawnSet: () => boolean,
  out: (status: SkillOutcome['status'], message: string, cause?: FailureCause, fix?: string) => SkillOutcome
): Promise<SkillOutcome> {
  const bot = ctx.bot;

  // 1. Which bed.
  let bed: BedInfo | null = null;
  if (args.x !== undefined) bed = bedInfo(bot, new Vec3(args.x, args.y!, args.z!));
  if (args.x !== undefined && !bed) evidence.push(`no bed at ${args.x} ${args.y} ${args.z}; using one nearby or the one held`);
  if (!bed) {
    const beds = nearbyBeds(bot, SEARCH_RADIUS).filter((b) => !b.occupied);
    bed = beds.find((b) => !bedBlocked(bot, b)) ?? null;
    if (beds.length && !bed) evidence.push(`${beds.length} bed(s) nearby, all with a block above`);
  }
  if (!bed) {
    const item = heldBedItem(bot);
    if (!item) return out('failed', `No usable bed within ${SEARCH_RADIUS} blocks (occupied or covered) and none in the inventory.`, 'missing_item', 'craft or find a bed');
    const placed = await placeBedNearby(ctx, item, evidence);
    if ('fail' in placed) return placed.fail;
    bed = bedInfo(bot, placed.pos);
    if (!bed) return out('failed', 'The bed vanished right after placing it.', 'server_rejected');
  }
  evidence.push(`bed at ${bed.pos} (${bed.part}), other half ${bed.other}`);

  // 2. Next to it, and never with monsters beside it.
  const near = monstersNear(bot, bed.pos);
  if (near.length) {
    return out('failed', `${near.length} hostile mob(s) (${[...new Set(near.map((e: any) => e.name))].join(', ')}) within ${MONSTER_RANGE_XZ} blocks of the bed; the server will not let the bot rest.`, 'blocked', 'fight or wait out the monsters near the bed (guard), then try again');
  }

  let attempts = 0;
  let sleptOnce = false;
  let lastRefusal: BedRefusal | null = null;
  while (attempts < 3) {
    attempts++;
    if (ctx.signal.aborted) return out('interrupted', 'Cancelled before getting into bed.', 'interrupted');
    await yieldToReflex(ctx);
    const t = await travel(ctx, bed.pos.x, bed.pos.y, bed.pos.z, BED_STAND_RANGE);
    evidence.push(`walked ${t.start} -> ${t.end}`);
    if (!t.ok) {
      if (t.cause === 'interrupted') return out('interrupted', t.message, 'interrupted');
      return out('failed', `Could not get next to the bed: ${t.message}`, t.cause ?? 'unreachable', 'clear a way to the bed');
    }
    await yieldToReflex(ctx);
    const target: any = bot.blockAt(bed.pos);
    if (!target || !BED_RE.test(target.name)) return out('failed', 'The bed is gone.', 'blocked');

    const heardBefore = heard.length;
    bot.activateBlock(target).catch(() => undefined);
    // Wait for the server's answer: the bot lying down, or a refusal message.
    let refusal: BedRefusal | null = null;
    for (let i = 0; i < 30 && !bot.isSleeping && !refusal; i++) {
      await sleep(100);
      for (const m of heard.slice(heardBefore)) refusal = refusal ?? classifyBedMessage(m);
    }
    if (bot.isSleeping) {
      sleptOnce = true;
      break;
    }
    if (refusal) {
      lastRefusal = refusal;
      evidence.push(`server: ${heard.slice(heardBefore).join(' | ')}`);
      if (refusal.retryCloser) continue;
      return out('failed', refusal.message, refusal.cause, refusal.fix);
    }
    evidence.push(`attempt ${attempts}: no sleep and no message (heard: ${heard.slice(heardBefore).join(' | ') || 'nothing'})`);
  }
  if (!sleptOnce) {
    if (lastRefusal) return out('failed', lastRefusal.message, lastRefusal.cause, lastRefusal.fix);
    return out('failed', 'Clicked the bed but the bot never lay down and the server said nothing.', 'server_rejected', 'check that it is night, the bed is free above and no monsters are near');
  }
  evidence.push(`lay down at time of day ${bot.time?.timeOfDay}${respawnSet() ? ' (respawn point set)' : ''}`);
  const sleepStartedAt = Date.now();
  const timeAtSleep = bot.time?.timeOfDay ?? null;
  const healthAtSleep = bot.health;

  // 3. Wait in bed until the night is skipped, the bot is woken, or the wait runs out.
  let timedOut = false;
  while (bot.isSleeping) {
    if (ctx.signal.aborted) {
      await bot.wake().catch(() => undefined);
      return out('interrupted', 'Cancelled while sleeping; got up.', 'interrupted');
    }
    if (Date.now() - sleepStartedAt > SLEEP_WAIT_MS) {
      timedOut = true;
      break;
    }
    await sleep(200);
  }
  if (timedOut) {
    await bot.wake().catch(() => undefined);
    await sleep(500);
    evidence.push(`still in bed after ${Math.round(SLEEP_WAIT_MS / 1000)} s; time of day ${bot.time?.timeOfDay}`);
    return out('partial', `Slept but the night did not skip within ${Math.round(SLEEP_WAIT_MS / 1000)} s (time of day ${bot.time?.timeOfDay}). Probably another player is awake (playersSleepingPercentage) or the daylight cycle is off.${respawnSet() ? ' The respawn point is set to this bed.' : ''}`, 'blocked', 'the other players must sleep too, or shelter until morning');
  }

  // 4. Awake again. Read the clock; the time update can lag the wake-up by up to a second.
  let tod = bot.time?.timeOfDay;
  for (let i = 0; i < 40 && !isMorning(tod); i++) {
    await sleep(100);
    tod = bot.time?.timeOfDay;
  }
  evidence.push(`woke at time of day ${tod} (was ${timeAtSleep} when lying down), health ${healthAtSleep} -> ${bot.health}`);
  if (isMorning(tod)) {
    return out('done', `Slept through the night; it is morning (time of day ${tod}). The respawn point is now this bed at ${bed.pos}${respawnSet() ? '' : ' (the server did not confirm it in chat)'}.`);
  }
  const hurt = typeof healthAtSleep === 'number' && bot.health < healthAtSleep;
  const mobs = monstersNear(bot, bot.entity.position);
  if (hurt || mobs.length) {
    return out('partial', `Woken before morning (time of day ${tod})${hurt ? ' after taking damage' : ''}${mobs.length ? `; ${mobs.length} hostile mob(s) nearby` : ''}.${respawnSet() ? ' The respawn point is set to this bed.' : ''}`, 'too_dangerous', 'deal with the mobs (guard), then sleep again or shelter');
  }
  return out('partial', `The bot got up before the night ended (time of day ${tod}).`, 'interrupted', 'try sleeping again');
}
