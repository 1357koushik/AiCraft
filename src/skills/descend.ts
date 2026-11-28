import { z } from 'zod';
import type { Bot } from 'mineflayer';
import { goals } from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { body } from '../reflexes/body.js';
import { MATERIALS } from '../knowledge/harvest.js';
import { withInventoryLock } from '../actions/reliable_craft.js';
import { ProgressWatchdog, SkillContext, SkillDefinition, SkillOutcome, runSkill } from './contract.js';
import { craftSkill } from './craft.js';
import { FACE_OFFSETS, countItems, goTo, isLiquid, sleep, stopOnAbort, stopPathfinder } from './world.js';

/**
 * descend: dig a staircase down to a target height (y), one step at a time, and verify the height from the game.
 *
 * Why a staircase and not straight down: the bot never stands over a hole it cannot see the bottom of. Each step
 * digs the three cells it will pass through (head height, foot height and the one below), and a step is only taken
 * when none of those cells has lava or water next to it and the floor under the new foot cell is solid. When the
 * way ahead is unsafe it turns; when no direction is safe it stops with too_dangerous.
 * Torches go down when the light is low, so nothing spawns on the way.
 */

const Args = z.object({
  y: z.number().int().min(-64).max(320),
});
type DescendArgs = z.infer<typeof Args>;

/** Height to dig down to for ores that sit deep (the best level for diamonds and redstone is about -58), else null. */
export function deepTargetY(block: string): number | null {
  return /^(deepslate_)?(diamond|redstone)_ore$/.test(block) ? -58 : null;
}

/**
 * Where to dig down to before looking for / mining a deep ore, or null when no digging is needed. With an ore already
 * known (`knownOreY`) go to its level, no deeper than needed and never above the best level; with none known, go to the
 * best level. Within 3 blocks of the answer there is nothing to dig.
 */
export function descentTarget(block: string, currentY: number, knownOreY: number | null): number | null {
  const best = deepTargetY(block);
  if (best === null) return null;
  const target = knownOreY === null ? best : Math.max(best, knownOreY);
  return currentY > target + 3 ? target : null;
}

/** The kinds of one ore the world has: iron_ore gives iron_ore and deepslate_iron_ore. `has` says which block names exist. */
export function oreVariants(name: string, has: (n: string) => boolean): string[] {
  const base = name.replace(/^deepslate_/, '');
  if (!/_ore$/.test(base)) return [name];
  return [base, `deepslate_${base}`].filter(has);
}

/** True when the cell, or any of the six cells touching it, holds lava or water. `blockName` returns null for unloaded ground. */
export function liquidNear(blockName: (p: Vec3) => string | null, pos: Vec3): boolean {
  for (const off of [new Vec3(0, 0, 0), ...FACE_OFFSETS]) {
    const n = blockName(pos.plus(off));
    if (n === null || isLiquid(n)) return true; // unloaded counts as unsafe
  }
  return false;
}

/** Light level below which a torch is placed (monsters spawn on dark blocks). */
const TORCH_BELOW = 8;
/** Pathfinder hops down into caves allowed per descent, so a maze of caves cannot keep it going forever. */
const MAX_PATHFINDER_LEGS = 12;
const HEADINGS = [new Vec3(1, 0, 0), new Vec3(0, 0, 1), new Vec3(-1, 0, 0), new Vec3(0, 0, -1)];

const nameAt = (bot: Bot, p: Vec3) => bot.blockAt(p)?.name ?? null;
const solid = (bot: Bot, p: Vec3) => {
  const b = bot.blockAt(p);
  return Boolean(b) && b!.boundingBox === 'block' && !isLiquid(b!.name);
};

/** Why a step of `heading` from the foot cell `feet` is unsafe (liquid by its three cells, bedrock, no solid floor), or null when it is safe. */
export function stepHazard(blockName: (p: Vec3) => string | null, solidAt: (p: Vec3) => boolean, feet: Vec3, heading: Vec3, drop = 1): string | null {
  const front = feet.plus(heading).offset(0, -drop, 0);
  const cells = [front.offset(0, 1 + drop, 0), ...(drop ? [front.offset(0, 1, 0)] : []), front];
  for (const c of cells) {
    if (liquidNear(blockName, c)) return `liquid or unloaded ground next to ${c.x} ${c.y} ${c.z}`;
    if (blockName(c) === 'bedrock') return `bedrock at ${c.x} ${c.y} ${c.z}`;
  }
  const floor = front.offset(0, -1, 0);
  return solidAt(floor) ? null : `no solid floor at ${floor.x} ${floor.y} ${floor.z}`;
}

/**
 * How many cells of a shaft going down from the surface at (x, z) are open air, liquid or unloaded: the 2x2 shaft plus
 * the ring of cells around it, from `bottomY` up to `topY`. Zero means solid rock all the way: no caves, lava or water to
 * meet on the way down. Stops counting past `limit`.
 */
export function shaftBad(blockName: (p: Vec3) => string | null, x: number, z: number, bottomY: number, topY: number, limit = Infinity): number {
  let bad = 0;
  for (let y = bottomY; y <= topY; y++)
    for (let dx = -1; dx <= 2; dx++)
      for (let dz = -1; dz <= 2; dz++) {
        const n = blockName(new Vec3(x + dx, y, z + dz));
        if (n === null || isLiquid(n) || /^(air|cave_air|void_air)$/.test(n)) if (++bad > limit) return bad;
      }
  return bad;
}

/** The nearest column within 40 blocks with the fewest caves, lava and water down to `bottomY` (the first with none wins). */
function findShaft(bot: Bot, bottomY: number): { x: number; z: number; bad: number } | null {
  const here = bot.entity.position.floored();
  const topY = here.y - 2;
  if (topY <= bottomY) return null;
  const cands: { x: number; z: number; d: number }[] = [];
  for (let dx = -40; dx <= 40; dx += 2) for (let dz = -40; dz <= 40; dz += 2) cands.push({ x: here.x + dx, z: here.z + dz, d: Math.hypot(dx, dz) });
  cands.sort((p, q) => p.d - q.d);
  let best: { x: number; z: number; bad: number } | null = null;
  for (const c of cands) {
    const bad = shaftBad((p) => nameAt(bot, p), c.x, c.z, bottomY, topY, best ? best.bad : Infinity);
    if (bad === 0) return { x: c.x, z: c.z, bad };
    if (!best || bad < best.bad) best = { x: c.x, z: c.z, bad };
  }
  return best;
}

/** The best pickaxe held, by material tier. */
function bestPickaxe(bot: Bot): any | null {
  let best: any = null;
  let rank = -1;
  for (const it of bot.inventory.items()) {
    const m = /^(\w+)_pickaxe$/.exec(it.name);
    const r = m ? MATERIALS.findIndex((x) => x.item === m[1]) : -1;
    if (r > rank) {
      best = it;
      rank = r;
    }
  }
  return best;
}

/**
 * The pickaxe to dig the staircase with: the weakest held of stone tier or better (stone and deepslate need no more), so
 * an iron or diamond pickaxe is kept for the ore at the bottom. Falls back to the best held.
 */
export function digPickaxeName(held: string[]): string | null {
  const rank = (n: string) => MATERIALS.findIndex((x) => `${x.item}_pickaxe` === n);
  const picks = held.filter((n) => rank(n) >= 0).sort((p, q) => rank(p) - rank(q));
  const stone = MATERIALS.findIndex((x) => x.item === 'stone');
  return picks.find((n) => rank(n) >= stone) ?? picks[picks.length - 1] ?? null;
}

const LOW_TIER = /^(wooden|stone|golden)_pickaxe$/;
const STONE_MATERIAL = /^(cobblestone|cobbled_deepslate|blackstone)$/;
/** Uses of a stone pickaxe, and about how many blocks a staircase digs per block of height. */
const STONE_PICK_USES = 131;
const DIGS_PER_LEVEL = 3.5;

/** Stone pickaxes to have before digging `levels` down: enough for the whole staircase, counting the ones already held. */
export function pickaxesToCraft(levels: number, lowTierHeld: number, sticks: number, stone: number): number {
  const need = Math.ceil((levels * DIGS_PER_LEVEL) / STONE_PICK_USES) - lowTierHeld;
  return Math.max(0, Math.min(need, Math.floor(sticks / 2), Math.floor(stone / 3)));
}

/**
 * Tool replacement: with no stone (or wooden) pickaxe left, craft a stone one from the stone just dug (cobblestone or
 * cobbled deepslate) and held sticks, so the better pickaxe stays sharp for the ore. Returns what happened, for the log.
 */
async function replaceDigPickaxe(ctx: SkillContext): Promise<string | null> {
  const names = ctx.bot.inventory.items().map((i) => i.name);
  if (names.some((n) => LOW_TIER.test(n)) || !names.includes('stick')) return null;
  const r = await runSkill(craftSkill, ctx, { item: 'stone_pickaxe', count: 1 });
  return `${r.status}: ${r.message}`;
}

/** Breaks the block at `pos` until the cell is passable (falling gravel and sand refill it). False if it will not clear. */
async function clearCell(bot: Bot, pos: Vec3, signal: AbortSignal): Promise<boolean> {
  for (let i = 0; i < 6; i++) {
    if (signal.aborted) return false;
    while (body.reflexActive && !signal.aborted) await sleep(200);
    const b = bot.blockAt(pos);
    if (!b) return false;
    if (isLiquid(b.name)) return false;
    if (b.boundingBox !== 'block') return true;
    try {
      await bot.dig(b, true);
    } catch {
      return false;
    }
    await sleep(40);
    // Gravel or sand above may fall into the cell: give it a moment to land, then look again.
    if (/^(gravel|sand|red_sand)$/.test(bot.blockAt(pos.offset(0, 1, 0))?.name ?? '')) await sleep(400);
  }
  return bot.blockAt(pos)?.boundingBox !== 'block';
}

/** Walks straight into the cell `dest` (a step down or a level step) by holding forward, and says whether the bot ended up in it. */
async function walkInto(bot: Bot, dest: Vec3, signal: AbortSignal): Promise<boolean> {
  const centre = dest.offset(0.5, 0, 0.5);
  const flat = () => Math.hypot(bot.entity.position.x - centre.x, bot.entity.position.z - centre.z);
  const startFlat = flat();
  try {
    await bot.lookAt(centre.offset(0, 1.6, 0), true);
    bot.setControlState('forward', true);
    for (let i = 0; i < 40 && !signal.aborted; i++) {
      await sleep(50);
      // Let go once over the cell (or past it): holding forward longer walks the bot out of the shaft.
      if (flat() < 0.3 || flat() > startFlat + 0.5) break;
    }
  } finally {
    bot.setControlState('forward', false);
  }
  // Land: the bot still reads as on the ground for a tick after it walks over the edge, so wait first.
  await sleep(150);
  for (let i = 0; i < 20 && !signal.aborted && !bot.entity.onGround; i++) await sleep(50);
  const p = bot.entity.position.floored();
  return p.x === dest.x && p.y === dest.y && p.z === dest.z;
}

/** Puts the digging pickaxe back in the hand (placing a torch or a block leaves something else there; digging by hand takes ages). */
async function holdPickaxe(bot: Bot): Promise<void> {
  const name = digPickaxeName(bot.inventory.items().map((i) => i.name));
  const pick = name ? bot.inventory.items().find((i) => i.name === name) : null;
  if (pick && bot.heldItem?.type !== pick.type) await withInventoryLock(() => bot.equip(pick, 'hand')).catch(() => undefined);
}

/** Lays cobblestone on the cell below the way ahead (the bot's own floor block is the thing it is placed against). */
async function bridge(bot: Bot, feet: Vec3, heading: Vec3): Promise<boolean> {
  const cobble = bot.inventory.items().find((i) => i.name === 'cobblestone');
  const ref = bot.blockAt(feet.offset(0, -1, 0));
  const target = feet.plus(heading).offset(0, -1, 0);
  if (!cobble || !ref || ref.boundingBox !== 'block') return false;
  try {
    await withInventoryLock(() => bot.equip(cobble, 'hand'));
    await bot.placeBlock(ref, heading);
  } catch {
    // the world is read below
  }
  return solid(bot, target);
}

/** Puts a torch at the bot's feet when the light there is low and a torch is held. Returns true when one was placed. */
export async function lightIfDark(bot: Bot): Promise<boolean> {
  const feet = bot.entity.position.floored();
  const here = bot.blockAt(feet);
  if (!here || here.name !== 'air' || (here.light ?? 15) >= TORCH_BELOW) return false;
  const torch = bot.inventory.items().find((i) => i.name === 'torch');
  const floor = bot.blockAt(feet.offset(0, -1, 0));
  if (!torch || !floor || floor.boundingBox !== 'block') return false;
  try {
    await withInventoryLock(() => bot.equip(torch, 'hand'));
    await bot.placeBlock(floor, new Vec3(0, 1, 0));
    return bot.blockAt(feet)?.name === 'torch';
  } catch {
    return false;
  }
}

export const descendSkill: SkillDefinition<DescendArgs> = {
  name: 'descend',
  summary: 'descend {y}: dig a safe staircase down to height y (for example -58 for diamonds), turning away from lava and water and lighting the way with torches. Digs with the cheapest pickaxe (keeping better ones for the ore) and crafts new stone pickaxes from the stone it digs when it holds sticks. Needs a pickaxe. Stops with too_dangerous when no direction is safe.',
  args: Args,
  check(ctx, a) {
    if (!bestPickaxe(ctx.bot)) return { ok: false, cause: 'missing_tool', message: 'descend needs a pickaxe and none is held.', fix: 'get a pickaxe' };
    if (Math.floor(ctx.bot.entity.position.y) <= a.y) return { ok: false, cause: 'invalid_args', message: `Already at or below y ${a.y}.` };
    return { ok: true };
  },
  async run(ctx, a): Promise<SkillOutcome> {
    const bot = ctx.bot;
    const evidence: string[] = [];
    const startY = Math.floor(bot.entity.position.y);
    const watchdog = new ProgressWatchdog(90000, startY);
    const dispose = stopOnAbort(ctx);
    // A spiral: turning every step keeps the shaft inside a 2x2 column, so one clear column is all it needs.
    let heading = 3;
    let died = false;
    const onDeath = () => {
      died = true;
    };
    bot.once('death', onDeath);
    let torches = 0;
    let pathfinderLegs = 0;
    let nextCraftTry = 0;
    let missingTool = false;
    let stop: { cause: 'too_dangerous' | 'no_progress' | 'blocked'; message: string } | null = null;
    try {
      const spot = findShaft(bot, a.y);
      if (spot) {
        ctx.log(`[descend] shaft at ${spot.x} ${spot.z}: ${spot.bad} cells of caves or liquid on the way down`);
        const here = bot.entity.position;
        if (Math.hypot(here.x - spot.x - 0.5, here.z - spot.z - 0.5) > 1.5) {
          const target = new Vec3(spot.x + 0.5, here.y, spot.z + 0.5);
          await goTo(ctx, new goals.GoalXZ(target.x, target.z), () => Math.hypot(bot.entity.position.x - target.x, bot.entity.position.z - target.z), 8000, true, 3000);
        }
      }
      // Kit up before going down: a crafting table needs room that a 2x2 shaft does not have.
      const held = () => bot.inventory.items();
      const sum = (re: RegExp) => held().filter((i) => re.test(i.name)).reduce((n, i) => n + i.count, 0);
      const extra = pickaxesToCraft(startY - a.y, sum(LOW_TIER), sum(/^stick$/), sum(STONE_MATERIAL));
      if (extra > 0) {
        const r = await runSkill(craftSkill, ctx, { item: 'stone_pickaxe', count: extra });
        ctx.log(`[descend] crafting ${extra} stone pickaxe(s) for the way down: ${r.status}: ${r.message}`);
        evidence.push(`crafted stone pickaxes before digging: ${r.status}`);
      }
      const startedWithCheapPick = sum(LOW_TIER) > 0;
      await holdPickaxe(bot);
      while (Math.floor(bot.entity.position.y) > a.y) {
        if (ctx.signal.aborted) break;
        if (died) {
          stop = { cause: 'too_dangerous', message: 'the bot died on the way down' };
          break;
        }
        if (watchdog.stuck) {
          stop = { cause: 'no_progress', message: `the height stopped dropping at y ${Math.floor(bot.entity.position.y)}` };
          break;
        }
        // The digging pickaxe broke: make another, or stop rather than dig deepslate by hand.
        if (!bot.inventory.items().some((i) => LOW_TIER.test(i.name)) && Date.now() >= nextCraftTry) {
          const made = await replaceDigPickaxe(ctx);
          if (made) {
            ctx.log(`[descend] out of stone pickaxes; crafting one: ${made}`);
            if (!made.startsWith('done')) nextCraftTry = Date.now() + 60000;
          }
          await holdPickaxe(bot);
        }
        const cheapLeft = bot.inventory.items().some((i) => LOW_TIER.test(i.name));
        if (startedWithCheapPick && !cheapLeft) {
          stop = { cause: 'blocked', message: 'the stone pickaxes are used up and no more could be made here; the better pickaxe is kept for the ore' };
          missingTool = true;
          break;
        }
        if (!digPickaxeName(bot.inventory.items().map((i) => i.name))) {
          stop = { cause: 'blocked', message: 'every pickaxe is used up; digging on by hand would take minutes per step' };
          missingTool = true;
          break;
        }
        const feet = bot.entity.position.floored();
        const stepStart = Date.now();
        // Keep going the way we were; otherwise turn left, then right, then back round.
        let moved = false;
        let sawUnsafe = false;
        // Down first; when every way down is over an open cave, a level step along its rim (floor still solid) instead.
        for (const drop of [1, 0]) {
          for (const turn of [1, 0, 3, 2]) {
            const h = HEADINGS[(heading + turn) % 4];
            // A level step over a missing floor is bridged with cobblestone.
            const bridgeable = !drop && countItems(bot, (n) => n === 'cobblestone') > 0;
            const hazardOf = () => {
              const hz = stepHazard((p) => nameAt(bot, p), (p) => solid(bot, p), feet, h, drop);
              return bridgeable && hz?.startsWith('no solid floor') ? null : hz;
            };
            const hazard = hazardOf();
            if (hazard) {
              sawUnsafe = true;
              if (drop && evidence.length < 20) evidence.push(`not going ${h.x},${h.z} from ${feet.x} ${feet.y} ${feet.z}: ${hazard}`);
              ctx.log(`[descend] not going ${h.x},${h.z} (drop ${drop}) from ${feet.x} ${feet.y} ${feet.z}: ${hazard}`);
              continue;
            }
            const front = feet.plus(h);
            let ok = true;
            for (const dy of [1, 0, -1]) if (ok && dy >= -drop) ok = await clearCell(bot, front.offset(0, dy, 0), ctx.signal);
            if (ctx.signal.aborted) break;
            if (!ok) {
              ctx.log(`[descend] could not clear the way ${h.x},${h.z} (drop ${drop}) from ${feet.x} ${feet.y} ${feet.z}: ${[1, 0, -1].map((dy) => bot.blockAt(front.offset(0, dy, 0))?.name ?? '?').join('/')}`);
              continue;
            }
            // Look again now that the cells are open: a liquid may have been behind one of them.
            if (hazardOf()) {
              sawUnsafe = true;
              continue;
            }
            const dest = front.offset(0, -drop, 0);
            if (!drop && !solid(bot, dest.offset(0, -1, 0))) {
              const bridged = await bridge(bot, feet, h);
              await holdPickaxe(bot);
              if (!bridged) continue;
            }
            if (!(await walkInto(bot, dest, ctx.signal))) {
              ctx.log(`[descend] could not step into ${dest.x} ${dest.y} ${dest.z}; the bot is at ${bot.entity.position.floored()}`);
              // Somewhere else now: plan the next step from where it really is, not from the old cell.
              if (!bot.entity.position.floored().equals(feet)) {
                moved = true;
                break;
              }
              continue;
            }
            heading = (heading + turn) % 4;
            moved = true;
            break;
          }
          if (moved || ctx.signal.aborted) break;
        }
        if (ctx.signal.aborted) break;
        if (!moved && sawUnsafe && pathfinderLegs < MAX_PATHFINDER_LEGS) {
          // Every staircase step is over an open cave: let the pathfinder (which keeps away from liquids) take the bot a
          // few blocks down into it, then carry on with the staircase from there.
          pathfinderLegs++;
          const goalY = Math.max(a.y, feet.y - 6);
          const r = await goTo(ctx, new goals.GoalY(goalY), () => Math.max(0, Math.floor(bot.entity.position.y) - goalY), 15000, true, 8000);
          ctx.log(`[descend] pathfinder leg to y ${goalY} from ${feet.x} ${feet.y} ${feet.z}: ${r.reason}${r.detail ? ` ${r.detail}` : ''}; now at ${bot.entity.position.floored()}`);
          await holdPickaxe(bot);
          if (Math.floor(bot.entity.position.y) < feet.y) {
            watchdog.report(Math.floor(bot.entity.position.y));
            continue;
          }
        }
        if (!moved) {
          stop = sawUnsafe
            ? { cause: 'too_dangerous', message: `no safe way down at ${feet.x} ${feet.y} ${feet.z}: lava, water, an open drop or unloaded ground on every side` }
            : { cause: 'blocked', message: `could not dig or walk down from ${feet.x} ${feet.y} ${feet.z}` };
          break;
        }
        watchdog.report(Math.floor(bot.entity.position.y));
        if (Date.now() - stepStart > 15000) ctx.log(`[descend] slow step from ${feet.x} ${feet.y} ${feet.z}: ${Math.round((Date.now() - stepStart) / 1000)} s, holding ${bot.heldItem?.name ?? 'nothing'}`);
        if (await lightIfDark(bot)) torches++;
        await holdPickaxe(bot);
      }
    } finally {
      bot.removeListener('death', onDeath);
      dispose();
      stopPathfinder(bot);
    }
    const endY = Math.floor(bot.entity.position.y);
    evidence.push(`height ${startY} -> ${endY}${torches ? `, ${torches} torches placed (${countItems(bot, (n) => n === 'torch')} left)` : ''}`);
    if (ctx.signal.aborted) return { status: 'interrupted', cause: 'interrupted', message: `descend was cancelled at y ${endY}.`, evidence };
    if (endY <= a.y) return { status: 'done', message: `Dug down from y ${startY} to y ${endY}.`, evidence };
    return {
      status: endY < startY ? 'partial' : 'failed',
      cause: missingTool ? 'missing_tool' : stop?.cause ?? 'no_progress',
      message: `Stopped at y ${endY} (wanted ${a.y}): ${stop?.message ?? 'no progress'}.`,
      fix: missingTool ? 'get pickaxes (or sticks and a crafting table: descend crafts stone pickaxes from the stone it digs)' : stop?.cause === 'too_dangerous' ? 'try again from another spot a few blocks away, or place cobblestone over the lava' : undefined,
      evidence,
    };
  },
};
