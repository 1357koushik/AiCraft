import { z } from 'zod';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { ProgressWatchdog, Precondition, SkillContext, SkillDefinition, SkillOutcome, FailureCause } from './contract.js';
import { withInventoryLock } from '../actions/reliable_craft.js';
import { findSafePlacementSpot } from '../actions/techniques.js';
import { getRecipes, resolveTag } from '../knowledge/vanilla.js';
import { ContainerError, closeContainer, moveBetween, openContainer } from './container_io.js';
import { travel } from './go_to.js';
import { sleep } from './world.js';
import { bagCounts } from './store.js';

/**
 * use_station: run a furnace, smoker, blast furnace or stonecutter job from start to finish.
 *
 * `count` is the number of INPUT items to process for every station (4 raw_iron, 8 cobblestone). A furnace makes one
 * output per input; a stonecutter recipe may make several (cobblestone -> 2 slabs), so 8 cobblestone gives 16 slabs.
 *
 * Every slot move is a single click, settled and verified against the server's window contents (container_io), never
 * Mineflayer's furnace helpers, which pipeline their clicks. Success is judged by what the inventory gained.
 */

const STATIONS = ['furnace', 'smoker', 'blast_furnace', 'stonecutter'] as const;
type Station = (typeof STATIONS)[number];

const Args = z
  .object({
    station: z.enum(STATIONS),
    input: z.string().min(1).transform((s) => s.replace(/^minecraft:/, '')),
    count: z.number().int().min(1).max(2304),
    output: z.string().min(1).transform((s) => s.replace(/^minecraft:/, '')).optional(),
    fuel: z.string().min(1).transform((s) => s.replace(/^minecraft:/, '')).optional(),
    x: z.number().int().optional(),
    y: z.number().int().optional(),
    z: z.number().int().optional(),
  })
  .refine((a) => [a.x, a.y, a.z].every((v) => v === undefined) || [a.x, a.y, a.z].every((v) => v !== undefined), { message: 'give all of x, y, z or none' });
type UseStationArgs = z.infer<typeof Args>;

const REACH = 4.0;
const FIND_DISTANCE = 32;
const RECIPE_TYPE: Record<Station, string> = {
  furnace: 'minecraft:smelting',
  smoker: 'minecraft:smoking',
  blast_furnace: 'minecraft:blasting',
  stonecutter: 'minecraft:stonecutting',
};
const DEFAULT_COOK_TICKS: Record<string, number> = { furnace: 200, smoker: 100, blast_furnace: 100 };

// ---------------------------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------------------------

interface StationRecipe {
  id: string;
  input: string;
  output: string;
  outCount: number;
  cookTicks: number;
}

const recipeCache = new Map<Station, StationRecipe[]>();

function ingredientNames(ing: any): string[] {
  if (typeof ing === 'string') {
    return ing.startsWith('#') ? resolveTag('item', ing.slice(1)).map((s) => s.replace(/^minecraft:/, '')) : [ing.replace(/^minecraft:/, '')];
  }
  if (Array.isArray(ing)) return ing.flatMap(ingredientNames);
  if (ing && typeof ing === 'object') return ingredientNames(ing.item ?? ing.tag ?? ing.id ?? '');
  return [];
}

/** Every recipe for the station, one entry per (input item, recipe), in recipe-id order. */
function stationRecipes(station: Station): StationRecipe[] {
  const cached = recipeCache.get(station);
  if (cached) return cached;
  const out: StationRecipe[] = [];
  const all = getRecipes();
  for (const id of Object.keys(all).sort()) {
    const r = all[id];
    if (r.type !== RECIPE_TYPE[station]) continue;
    const result = typeof r.result === 'string' ? { id: r.result, count: 1 } : r.result;
    if (!result?.id) continue;
    for (const input of ingredientNames(r.ingredient)) {
      out.push({
        id,
        input,
        output: String(result.id).replace(/^minecraft:/, ''),
        outCount: result.count ?? 1,
        cookTicks: r.cookingtime ?? DEFAULT_COOK_TICKS[station] ?? 200,
      });
    }
  }
  recipeCache.set(station, out);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Fuel. Burn times in game ticks (20 per second): Minecraft Wiki, "Fuel" page (Java Edition table).
// Tools, armor and other items that merely burn are left out on purpose: they are never wanted as fuel.
// ---------------------------------------------------------------------------------------------

const FUEL_EXACT: Record<string, number> = {
  lava_bucket: 20000,
  coal_block: 16000,
  dried_kelp_block: 4000,
  blaze_rod: 2400,
  coal: 1600,
  charcoal: 1600,
  crafting_table: 300,
  chest: 300,
  trapped_chest: 300,
  bookshelf: 300,
  bamboo_mosaic: 300,
  stick: 100,
  bamboo: 50,
  scaffolding: 50,
};
const NON_FUEL_WOODS = /^(crimson|warped)_/;

export function burnTicks(name: string): number {
  if (FUEL_EXACT[name] !== undefined) return FUEL_EXACT[name];
  if (NON_FUEL_WOODS.test(name)) return 0;
  if (/_(planks|log|wood)$/.test(name)) return 300; // planks, logs, stripped logs, wood
  if (/^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|bamboo)_slab$/.test(name)) return 150;
  if (/_sapling$/.test(name)) return 100;
  return 0;
}

function bag(bot: Bot): Record<string, number> {
  return bagCounts(bot);
}

/** Held fuels in the order they should be used: one that covers the whole job alone (the weakest such), then the rest weakest first. */
function fuelOrder(bot: Bot, args: UseStationArgs, needTicks: number): string[] {
  const held = bag(bot);
  if (args.fuel) return [args.fuel];
  const names = Object.keys(held).filter((n) => burnTicks(n) > 0 && n !== args.input && n !== args.output);
  names.sort((a, b) => burnTicks(a) - burnTicks(b));
  const single = names.find((n) => held[n] * burnTicks(n) >= needTicks);
  return single ? [single, ...names.filter((n) => n !== single)] : names;
}

// ---------------------------------------------------------------------------------------------
// Checking
// ---------------------------------------------------------------------------------------------

interface Plan {
  recipe: StationRecipe;
}

const hasItem = (bot: Bot, name: string) => (bag(bot)[name] ?? 0) > 0;

function stationAt(bot: Bot, args: UseStationArgs): any | null {
  if (args.x !== undefined) {
    const b = bot.blockAt(new Vec3(args.x, args.y!, args.z!));
    return b && b.name === args.station ? b : null;
  }
  return bot.findBlock({ matching: (b: any) => b.name === args.station, maxDistance: FIND_DISTANCE }) ?? null;
}

function evaluate(bot: Bot, args: UseStationArgs): (Precondition & { plan?: Plan }) {
  const reg: any = bot.registry;
  if (!reg.itemsByName[args.input]) return { ok: false, cause: 'invalid_args', message: `There is no item called "${args.input}".` };
  const recipes = stationRecipes(args.station).filter((r) => r.input === args.input);
  if (!recipes.length) {
    return { ok: false, cause: 'invalid_args', message: `A ${args.station} has no recipe that takes ${args.input}.`, fix: args.station === 'furnace' ? 'check the item, or try the smoker (food) or blast_furnace (ores and metal gear)' : `check the item or use another station` };
  }
  let recipe: StationRecipe | undefined;
  if (args.output) {
    recipe = recipes.find((r) => r.output === args.output);
    if (!recipe) return { ok: false, cause: 'invalid_args', message: `A ${args.station} cannot turn ${args.input} into ${args.output}; it makes ${recipes.map((r) => r.output).join(', ')}.` };
  } else if (recipes.length === 1) {
    recipe = recipes[0];
  } else {
    return { ok: false, cause: 'invalid_args', message: `${args.input} has several results in a ${args.station}; name one with "output": ${recipes.map((r) => r.output).join(', ')}.` };
  }

  const have = bag(bot)[args.input] ?? 0;
  if (have < args.count) {
    return { ok: false, cause: 'missing_item', message: `Needs ${args.count} ${args.input}, the inventory holds ${have}.`, fix: `get ${args.count - have} more ${args.input}, or ask for fewer` };
  }
  if (args.station !== 'stonecutter') {
    if (args.fuel && burnTicks(args.fuel) <= 0) return { ok: false, cause: 'invalid_args', message: `${args.fuel} is not a fuel.` };
    const order = fuelOrder(bot, args, 1);
    const fuelHeld = order.filter((n) => hasItem(bot, n));
    if (!fuelHeld.length) {
      return { ok: false, cause: 'missing_item', message: `No fuel held${args.fuel ? ` (no ${args.fuel})` : ''}; ${args.count} ${args.input} needs ${((recipe.cookTicks * args.count) / 20).toFixed(0)} s of burning.`, fix: 'get coal, charcoal, logs or planks' };
    }
  }
  if (!stationAt(bot, args) && !(args.x === undefined && hasItem(bot, args.station))) {
    return {
      ok: false,
      cause: 'missing_station',
      message: args.x !== undefined ? `There is no ${args.station} at ${args.x}, ${args.y}, ${args.z}.` : `No ${args.station} within ${FIND_DISTANCE} blocks and none in the inventory to place.`,
      fix: args.station === 'stonecutter' ? 'craft a stonecutter (1 iron_ingot + 3 stone)' : `craft a ${args.station} or go to one`,
    };
  }
  return { ok: true, plan: { recipe } };
}

// ---------------------------------------------------------------------------------------------
// Slot helpers (all clicks go through container_io's moveBetween: one slot per click, settled, verified)
// ---------------------------------------------------------------------------------------------

const at = (win: any, i: number): any => win.slots?.[i] ?? null;
const stackOf = (bot: Bot, it: any): number => it.stackSize ?? (bot.registry as any).items?.[it.type]?.stackSize ?? 64;

/** A player-inventory slot that can take `n` more of `name` in one placement, or -1. */
function destFor(bot: Bot, win: any, name: string, n: number): number {
  for (let i = win.inventoryStart; i < win.inventoryEnd; i++) {
    const it = at(win, i);
    if (it && it.name === name && stackOf(bot, it) - it.count >= n) return i;
  }
  for (let i = win.inventoryStart; i < win.inventoryEnd; i++) if (!at(win, i)) return i;
  return -1;
}

/** Moves up to `k` of `name` from the player's inventory into window slot `dst`, across stacks. Returns how many arrived. */
async function putInto(bot: Bot, win: any, name: string, dst: number, k: number): Promise<number> {
  let moved = 0;
  let stalls = 0;
  while (moved < k) {
    let src = -1;
    for (let i = win.inventoryStart; i < win.inventoryEnd; i++) {
      const it = at(win, i);
      if (it && it.name === name && (src < 0 || it.count < at(win, src).count)) src = i;
    }
    if (src < 0) break;
    const room = (() => {
      const cur = at(win, dst);
      return cur ? stackOf(bot, cur) - cur.count : stackOf(bot, at(win, src));
    })();
    const kk = Math.min(at(win, src).count, k - moved, room);
    if (kk <= 0) break;
    const arrived = await moveBetween(bot, win, src, dst, kk);
    if (arrived <= 0) {
      if (++stalls >= 2) break;
      continue;
    }
    moved += arrived;
  }
  return moved;
}

/** Moves everything in window slot `slot` into the inventory. Returns how many items moved; -1 when there was no room. */
async function takeSlot(bot: Bot, win: any, slot: number): Promise<number> {
  const it = at(win, slot);
  if (!it) return 0;
  const n = it.count;
  const dst = destFor(bot, win, it.name, n);
  if (dst < 0) return -1;
  return moveBetween(bot, win, slot, dst, n);
}

// ---------------------------------------------------------------------------------------------
// Getting to a station (walk, or place one that is held)
// ---------------------------------------------------------------------------------------------

async function placeStation(ctx: SkillContext, name: string, evidence: string[]): Promise<any | null> {
  const bot = ctx.bot;
  const item = bot.inventory.items().find((i) => i.name === name);
  if (!item) return null;
  const spot = findSafePlacementSpot(bot);
  if (!spot) return null;
  await bot.equip(item, 'hand');
  try {
    await bot.placeBlock(spot.refBlock, spot.placeVector);
  } catch {
    // Mineflayer can time out waiting for the block update although the server placed it; the world decides.
  }
  await bot.waitForTicks(4);
  const placed = bot.blockAt(spot.placePos);
  evidence.push(`placed ${name} at ${spot.placePos}: ${placed?.name}`);
  return placed?.name === name ? placed : null;
}

interface Acquired {
  block?: any;
  placed?: { x: number; y: number; z: number; block: string };
  failure?: SkillOutcome;
}

async function acquire(ctx: SkillContext, args: UseStationArgs, evidence: string[]): Promise<Acquired> {
  const bot = ctx.bot;
  const fail = (cause: FailureCause, message: string, fix?: string): Acquired => ({ failure: { status: cause === 'interrupted' ? 'interrupted' : 'failed', cause, message, fix, evidence } });
  let block = stationAt(bot, args);
  let placed: Acquired['placed'];
  if (!block && args.x === undefined && hasItem(bot, args.station)) {
    block = await placeStation(ctx, args.station, evidence);
    if (!block) return fail('blocked', `Could not place the ${args.station} from the inventory.`, 'stand on open flat ground');
    placed = { x: block.position.x, y: block.position.y, z: block.position.z, block: args.station };
  }
  if (!block) return fail('missing_station', `No ${args.station} to use.`);
  if (bot.entity.position.distanceTo(block.position.offset(0.5, 0.5, 0.5)) > REACH) {
    const t = await travel(ctx, block.position.x, block.position.y, block.position.z, 3);
    evidence.push(`walked ${t.start} -> ${t.end}`);
    if (!t.ok) return fail(t.cause === 'interrupted' ? 'interrupted' : (t.cause ?? 'unreachable'), `Could not reach the ${args.station}: ${t.message}`);
  }
  return { block, placed };
}

// ---------------------------------------------------------------------------------------------
// Furnace, smoker, blast furnace
// ---------------------------------------------------------------------------------------------

interface Session {
  win: any;
}

async function ensureOpen(bot: Bot, block: any, s: Session): Promise<void> {
  if (s.win && bot.currentWindow === s.win) return;
  s.win = await withInventoryLock(() => openContainer(bot, block));
}

async function runCooking(ctx: SkillContext, args: UseStationArgs, recipe: StationRecipe, block: any, evidence: string[]): Promise<SkillOutcome> {
  const bot = ctx.bot;
  const held0 = bag(bot);
  const outBefore = held0[recipe.output] ?? 0;
  const inBefore = held0[args.input] ?? 0;
  const fuelNames = fuelOrder(bot, args, recipe.cookTicks * args.count);
  const fuelBefore = Object.fromEntries(fuelNames.map((n) => [n, held0[n] ?? 0]));
  const s: Session = { win: null };
  const cookMs = recipe.cookTicks * 50;
  evidence.push(`${args.station}: ${args.count} ${args.input} -> ${recipe.output}, ${recipe.cookTicks / 20} s each, expect about ${Math.round((cookMs * args.count) / 1000)} s; fuel order ${fuelNames.join(', ') || 'none'}`);

  let taken = 0;
  let outOfFuel = false;
  let stuck = false;
  let invFull = false;
  let rejected = '';
  let startedWork = false;

  const isLit = () => {
    try {
      return bot.blockAt(block.position)?.getProperties?.()?.lit === true;
    } catch {
      return false;
    }
  };

  /** Puts fuel in slot 1 for what is still in the input slot. Returns how many fuel items were added. */
  const topUpFuel = async (): Promise<number> => {
    const win = s.win;
    const pending = at(win, 0)?.count ?? 0;
    if (pending <= 0) return 0;
    const cur = at(win, 1);
    const curTicks = cur ? cur.count * burnTicks(cur.name) : 0;
    const deficit = pending * recipe.cookTicks - curTicks;
    if (deficit <= 0) return 0;
    for (const name of fuelNames) {
      if (cur && cur.name !== name) continue;
      const have = bag(bot)[name] ?? 0;
      if (have <= 0) continue;
      const room = cur ? stackOf(bot, cur) - cur.count : 64;
      const want = Math.min(have, Math.ceil(deficit / burnTicks(name)), room);
      if (want <= 0) continue;
      const moved = await withInventoryLock(() => putInto(bot, win, name, 1, want));
      evidence.push(`fuel: put ${moved} ${name}`);
      if (moved > 0) return moved;
    }
    return 0;
  };

  const collect = async (): Promise<void> => {
    const out = at(s.win, 2);
    if (!out) return;
    const n = await withInventoryLock(() => takeSlot(bot, s.win, 2));
    if (n < 0) {
      invFull = true;
      return;
    }
    taken += n;
  };

  try {
    await ensureOpen(bot, block, s);
    evidence.push(`opened ${block.name}: input ${at(s.win, 0)?.name ?? '-'}, fuel ${at(s.win, 1)?.name ?? '-'}, output ${at(s.win, 2)?.name ?? '-'}`);
    const slot0 = at(s.win, 0);
    if (slot0 && slot0.name !== args.input) {
      return { status: 'failed', cause: 'blocked', message: `The ${args.station} is busy: its input slot holds ${slot0.name}.`, fix: 'use another station or empty it', evidence };
    }
    const slot2 = at(s.win, 2);
    if (slot2 && slot2.name !== recipe.output) {
      return { status: 'failed', cause: 'blocked', message: `The ${args.station}'s output slot holds ${slot2.name}.`, fix: 'empty it first', evidence };
    }

    let remaining = args.count;
    while (remaining > 0 && !ctx.signal.aborted && !outOfFuel && !stuck && !invFull && !rejected) {
      await ensureOpen(bot, block, s);
      const heldNow = bag(bot)[args.input] ?? 0;
      const room = stackOf(bot, { type: bot.registry.itemsByName[args.input].id }) - (at(s.win, 0)?.count ?? 0);
      const batch = Math.min(remaining, heldNow, room);
      if (batch <= 0) break;
      const before0 = at(s.win, 0)?.count ?? 0;
      const moved = await withInventoryLock(() => putInto(bot, s.win, args.input, 0, batch));
      evidence.push(`input: put ${moved}/${batch} ${args.input} (slot had ${before0})`);
      if (moved <= 0) {
        rejected = `the server did not accept ${args.input} into the input slot`;
        break;
      }
      startedWork = true;
      const added = await topUpFuel();
      if (added <= 0 && !at(s.win, 1)) {
        outOfFuel = true;
        break;
      }

      const gotAtStart = taken;
      const wd = new ProgressWatchdog(cookMs + 20000, taken, false);
      let lastIn = at(s.win, 0)?.count ?? 0;
      let darkPolls = 0;
      for (;;) {
        if (ctx.signal.aborted) break;
        await sleep(400);
        await ensureOpen(bot, block, s);
        const beforeTaken = taken;
        await collect();
        if (invFull) break;
        if (taken > beforeTaken) wd.report(taken);
        const inNow = at(s.win, 0)?.count ?? 0;
        if (inNow !== lastIn) {
          lastIn = inNow;
          wd.touch();
        }
        if (taken - gotAtStart >= moved) break;
        if (inNow === 0 && !at(s.win, 2)) {
          // Nothing left cooking and nothing to take. Give the server one more look before deciding.
          await sleep(700);
          if (!at(s.win, 0) && !at(s.win, 2)) break;
          continue;
        }
        if (inNow > 0 && !at(s.win, 1) && !isLit()) {
          if (++darkPolls >= 2) {
            const more = await topUpFuel();
            if (more <= 0) {
              outOfFuel = true;
              break;
            }
            darkPolls = 0;
            wd.touch();
          }
        } else {
          darkPolls = 0;
        }
        if (wd.stuck) {
          stuck = true;
          break;
        }
      }
      remaining -= taken - gotAtStart;
      if (taken - gotAtStart < moved) break;
    }
  } catch (err) {
    if (err instanceof ContainerError) {
      evidence.push(`container error: ${err.message}`);
      rejected = err.message;
    } else {
      evidence.push(`error: ${(err as Error).message}`);
      rejected = (err as Error).message;
    }
  } finally {
    // Take back everything we put there that did not get used, plus any output, then close.
    if (s.win) {
      try {
        await ensureOpen(bot, block, s);
        await withInventoryLock(async () => {
          const out = at(s.win, 2);
          if (out && out.name === recipe.output) {
            const n = await takeSlot(bot, s.win, 2);
            if (n > 0) taken += n;
          }
          for (const slot of [0, 1]) {
            const it = at(s.win, slot);
            if (it && (it.name === args.input || fuelNames.includes(it.name))) {
              const n = await takeSlot(bot, s.win, slot);
              evidence.push(`took back ${it.name} x${it.count} from slot ${slot}${n < 0 ? ' (no room, left in the station)' : ''}`);
            }
          }
          await closeContainer(bot, s.win);
        });
      } catch (err) {
        evidence.push(`cleanup error: ${(err as Error).message}`);
      }
    }
  }

  const after = bag(bot);
  const gained = (after[recipe.output] ?? 0) - outBefore;
  const used = inBefore - (after[args.input] ?? 0);
  evidence.push(`${recipe.output} ${outBefore} -> ${after[recipe.output] ?? 0}; ${args.input} ${inBefore} -> ${after[args.input] ?? 0}`);
  for (const n of fuelNames) if ((fuelBefore[n] ?? 0) !== (after[n] ?? 0)) evidence.push(`fuel ${n} ${fuelBefore[n]} -> ${after[n] ?? 0}`);
  if ((bot.inventory as any).selectedItem) evidence.push(`cursor still holds ${(bot.inventory as any).selectedItem.name}`);

  if (gained >= args.count) {
    return { status: 'done', message: `Made ${gained} ${recipe.output} from ${used} ${args.input} in the ${args.station}.`, evidence };
  }
  let cause: FailureCause = 'server_rejected';
  let why = rejected || 'it stopped short';
  let fix: string | undefined;
  if (ctx.signal.aborted) {
    cause = 'interrupted';
    why = 'it was cancelled';
  } else if (invFull) {
    cause = 'inventory_full';
    why = 'there was no room for the output';
    fix = 'free inventory slots, then use_station again';
  } else if (outOfFuel) {
    cause = 'missing_item';
    why = 'the fuel ran out';
    fix = `get more fuel (coal, charcoal, logs) for the remaining ${args.count - gained} ${args.input}`;
  } else if (stuck) {
    cause = 'no_progress';
    why = 'the station stopped producing';
  } else if (!startedWork && !rejected) {
    cause = 'missing_item';
    why = 'there was no input to load';
  }
  return {
    status: ctx.signal.aborted ? 'interrupted' : gained > 0 ? 'partial' : 'failed',
    cause,
    message: `${args.station} made ${gained} of ${args.count} ${recipe.output}: ${why}.`,
    fix,
    evidence,
  };
}

// ---------------------------------------------------------------------------------------------
// Stonecutter. Window slots: 0 input, 1 result, player inventory 2..37. The recipe is chosen with a window button
// (container_button_click, which minecraft-protocol calls enchant_item): the button index is the recipe's position
// in the list the server offers for the input. The order is not assumed: each button is tried and the result slot
// is read until it shows the wanted item.
// ---------------------------------------------------------------------------------------------

async function selectRecipe(bot: Bot, win: any, args: UseStationArgs, recipe: StationRecipe, evidence: string[]): Promise<boolean> {
  const options = stationRecipes('stonecutter').filter((r) => r.input === args.input);
  const wantIdx = options.findIndex((r) => r === recipe);
  const order = [wantIdx, ...options.map((_, i) => i).filter((i) => i !== wantIdx)];
  for (const idx of order) {
    (bot as any)._client.write('enchant_item', { windowId: win.id, enchantment: idx });
    for (let wait = 0; wait < 8; wait++) {
      await sleep(150);
      const res = at(win, 1);
      if (res) {
        if (res.name === recipe.output) {
          evidence.push(`stonecutter button ${idx} gives ${recipe.output} (listed ${options.map((o) => o.output).join(', ')}; guessed index ${wantIdx})`);
          return true;
        }
        break; // a different result: try the next button
      }
    }
  }
  return false;
}

async function runCutting(ctx: SkillContext, args: UseStationArgs, recipe: StationRecipe, block: any, evidence: string[]): Promise<SkillOutcome> {
  const bot = ctx.bot;
  const held0 = bag(bot);
  const outBefore = held0[recipe.output] ?? 0;
  const inBefore = held0[args.input] ?? 0;
  const s: Session = { win: null };
  let crafts = 0;
  let invFull = false;
  let stuck = false;
  let noButton = false;
  let rejected = '';
  try {
    await ensureOpen(bot, block, s);
    if (at(s.win, 0) && at(s.win, 0).name !== args.input) {
      return { status: 'failed', cause: 'blocked', message: `The stonecutter's input slot holds ${at(s.win, 0).name}.`, evidence };
    }
    let remaining = args.count;
    const wd = new ProgressWatchdog(15000, 0, false);
    while (remaining > 0 && !ctx.signal.aborted && !invFull && !stuck && !noButton && !rejected) {
      await ensureOpen(bot, block, s);
      const batch = Math.min(remaining, bag(bot)[args.input] ?? 0, stackOf(bot, { type: bot.registry.itemsByName[args.input].id }) - (at(s.win, 0)?.count ?? 0));
      if (batch <= 0) break;
      const moved = await withInventoryLock(() => putInto(bot, s.win, args.input, 0, batch));
      evidence.push(`input: put ${moved}/${batch} ${args.input}`);
      if (moved <= 0) {
        rejected = 'the server did not accept the input';
        break;
      }
      if (!(await selectRecipe(bot, s.win, args, recipe, evidence))) {
        noButton = true;
        break;
      }
      let left = at(s.win, 0)?.count ?? 0;
      while (left > 0 && !ctx.signal.aborted) {
        let res = at(s.win, 1);
        for (let w = 0; w < 10 && !res; w++) {
          await sleep(150);
          res = at(s.win, 1);
        }
        if (!res || res.name !== recipe.output) {
          stuck = !res;
          if (res) rejected = `the result slot showed ${res.name}`;
          break;
        }
        const n = await withInventoryLock(() => takeSlot(bot, s.win, 1));
        if (n < 0) {
          invFull = true;
          break;
        }
        if (n === 0) {
          stuck = true;
          break;
        }
        crafts++;
        remaining--;
        wd.report(crafts);
        left = at(s.win, 0)?.count ?? 0;
        if (left === 0 || remaining === 0) break;
      }
    }
  } catch (err) {
    evidence.push(`error: ${(err as Error).message}`);
    rejected = (err as Error).message;
  } finally {
    if (s.win) {
      try {
        await ensureOpen(bot, block, s);
        await withInventoryLock(async () => {
          const out = at(s.win, 1);
          if (out && out.name === recipe.output) await takeSlot(bot, s.win, 1);
          const it = at(s.win, 0);
          if (it && it.name === args.input) {
            const n = await takeSlot(bot, s.win, 0);
            evidence.push(`took back ${it.count} ${it.name}${n < 0 ? ' (no room, left in the station)' : ''}`);
          }
          await closeContainer(bot, s.win);
        });
      } catch (err) {
        evidence.push(`cleanup error: ${(err as Error).message}`);
      }
    }
  }
  const after = bag(bot);
  const gained = (after[recipe.output] ?? 0) - outBefore;
  const used = inBefore - (after[args.input] ?? 0);
  evidence.push(`${recipe.output} ${outBefore} -> ${after[recipe.output] ?? 0}; ${args.input} ${inBefore} -> ${after[args.input] ?? 0}; ${crafts} cuts`);
  if ((bot.inventory as any).selectedItem) evidence.push(`cursor still holds ${(bot.inventory as any).selectedItem.name}`);
  const want = args.count * recipe.outCount;
  if (gained >= want && used === args.count) {
    return { status: 'done', message: `Cut ${used} ${args.input} into ${gained} ${recipe.output}.`, evidence };
  }
  let cause: FailureCause = 'server_rejected';
  let why = rejected || 'it stopped short';
  if (ctx.signal.aborted) {
    cause = 'interrupted';
    why = 'it was cancelled';
  } else if (invFull) {
    cause = 'inventory_full';
    why = 'there was no room for the output';
  } else if (noButton) {
    cause = 'invalid_args';
    why = `no button of the stonecutter produced ${recipe.output} from ${args.input}`;
  } else if (stuck) {
    cause = 'no_progress';
    why = 'the result slot stayed empty';
  }
  return {
    status: ctx.signal.aborted ? 'interrupted' : gained > 0 ? 'partial' : 'failed',
    cause,
    message: `stonecutter made ${gained} of ${want} ${recipe.output}: ${why}.`,
    evidence,
  };
}

// ---------------------------------------------------------------------------------------------

export const useStationSkill: SkillDefinition<UseStationArgs> = {
  name: 'use_station',
  summary:
    'use_station {station: furnace|smoker|blast_furnace|stonecutter, input, count, output? (required for stonecutter), fuel?, x?, y?, z?}: process `count` input items in the nearest station (or the one at x,y,z; places one from the inventory if none is near): smelt, smoke, blast or stonecut. Picks fuel itself. Furnaces make 1 output per input; a stonecutter may make several.',
  args: Args,
  check(ctx, args) {
    const r = evaluate(ctx.bot, args);
    return r.ok ? { ok: true } : r;
  },
  async run(ctx, args): Promise<SkillOutcome> {
    const evidence: string[] = [];
    const r = evaluate(ctx.bot, args);
    if (!r.ok) return { status: 'failed', cause: r.cause, message: r.message, fix: r.fix, evidence };
    const recipe = r.plan!.recipe;
    const acq = await acquire(ctx, args, evidence);
    if (acq.failure) return acq.failure;
    const block = acq.block;
    evidence.push(`using ${block.name} at ${block.position}`);
    const out = args.station === 'stonecutter' ? await runCutting(ctx, args, recipe, block, evidence) : await runCooking(ctx, args, recipe, block, evidence);
    if (acq.placed) out.worldDelta = { placed: [acq.placed], broken: [] };
    return out;
  },
};
