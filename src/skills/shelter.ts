import { z } from 'zod';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { body } from '../reflexes/body.js';
import { HOSTILE } from '../reflexes/guard.js';
import { withInventoryLock, settleInventory } from '../actions/reliable_craft.js';
import { techniquePillarUp } from '../actions/techniques.js';
import { FailureCause, Precondition, SkillDefinition, SkillOutcome } from './contract.js';
import { equipItem } from './equip.js';
import { travel } from './go_to.js';
import { planTool } from './mine.js';
import { sleep, stopMotion } from './world.js';

/**
 * shelter: the "no bed at night" move. Seal the bot into a closed 1x1x2 space no mob can reach, wait there until
 * morning (or for `minutes`), then open it again.
 *
 * Two ways in, and the cheaper one that is possible is used:
 *  - walls: fill the side cells at feet and head level and the cell above the head with held blocks wherever they are
 *    not already solid. A cell above the head has nothing to be placed against, so one extra "scaffold" block is put
 *    beside it first (counted).
 *  - hole: dig straight down two blocks (only where the 8 side cells of both levels are already solid and the floor
 *    below is solid, never into air, water or lava), put a scaffold beside the hole on the surface and cap it from
 *    inside. Two blocks in total.
 * The blocks needed are counted first; if fewer are held the skill refuses with missing_item and the exact number.
 *
 * Success is read from the world after building: each of the 8 side cells and the cell above the head is a full
 * solid cube (or the result says which one is open). While waiting the enclosure is re-checked every two seconds
 * and repaired if a block disappears. Reflexes may fight a mob beside the bot while it builds; the skill waits for them.
 */

const Args = z.object({
  minutes: z.number().positive().max(240).optional(),
  until: z.literal('morning').optional(),
  open_after: z.boolean().default(true),
});
type ShelterArgs = z.infer<typeof Args>;

export interface Cell {
  x: number;
  y: number;
  z: number;
}
const key = (c: Cell) => `${c.x},${c.y},${c.z}`;
const HORIZONTAL: Array<{ dx: number; dz: number; name: string }> = [
  { dx: 1, dz: 0, name: 'east' },
  { dx: -1, dz: 0, name: 'west' },
  { dx: 0, dz: 1, name: 'south' },
  { dx: 0, dz: -1, name: 'north' },
];
/** From 12000 on the mobs spawn; the wait ends when the clock wraps to the new day. */
const NIGHT_FROM = 12000;
const MAX_WAIT_MORNING_MS = 15 * 60 * 1000;
const RECHECK_MS = 2000;
/** Hostile mobs this close are dealt with before building starts. */
const NEAR_MOBS = 8;
const NEAR_MOBS_WAIT_MS = 25000;

// ---------------------------------------------------------------------------------------------
// Pure planning (unit tested)
// ---------------------------------------------------------------------------------------------

export interface ShelterView {
  /** A full solid cube: nothing walks through it. */
  solid(c: Cell): boolean;
  /** A block placement simply replaces: air, plants, water. Never lava. */
  replaceable(c: Cell): boolean;
  lava(c: Cell): boolean;
  /** For messages: the block's name, or "unloaded". */
  describe(c: Cell): string;
}

export interface PlanStep {
  cell: Cell;
  kind: 'wall' | 'top' | 'scaffold';
}

export type EnclosurePlan =
  | { ok: true; steps: PlanStep[]; needed: number }
  | { ok: false; reason: 'occupied' | 'lava' | 'no_support'; cell: Cell; message: string };

/** The 8 side cells (feet and head level) and the cell above the head, for a bot whose feet are in `feet`. */
export function enclosureCells(feet: Cell): { sides: Cell[]; top: Cell } {
  const sides: Cell[] = [];
  for (const dy of [0, 1]) for (const d of HORIZONTAL) sides.push({ x: feet.x + d.dx, y: feet.y + dy, z: feet.z + d.dz });
  return { sides, top: { x: feet.x, y: feet.y + 2, z: feet.z } };
}

const neighbours = (c: Cell): Cell[] => [
  { x: c.x, y: c.y - 1, z: c.z },
  { x: c.x + 1, y: c.y, z: c.z },
  { x: c.x - 1, y: c.y, z: c.z },
  { x: c.x, y: c.y, z: c.z + 1 },
  { x: c.x, y: c.y, z: c.z - 1 },
  { x: c.x, y: c.y + 1, z: c.z },
];

/**
 * Which cells need a block, in a placeable order, and how many blocks that costs. Every placement needs a solid
 * neighbour to click on; the cell above the head has none on open ground, so a scaffold cell beside it (itself
 * resting on a wall block) is added when needed. Returns why not when a cell holds something that cannot be placed
 * over (a fence, a torch, a door) or lava is adjacent.
 */
export function planEnclosure(view: ShelterView, feet: Cell): EnclosurePlan {
  const head: Cell = { x: feet.x, y: feet.y + 1, z: feet.z };
  const { sides, top } = enclosureCells(feet);
  const targets: PlanStep[] = [...sides.slice(0, 4), ...sides.slice(4), top].map((cell, i) => ({ cell, kind: i === sides.length ? 'top' : 'wall' }));
  const toFill: PlanStep[] = [];
  for (const t of targets) {
    if (view.solid(t.cell)) continue;
    if (view.lava(t.cell)) return { ok: false, reason: 'lava', cell: t.cell, message: `Lava at ${key(t.cell)} is next to the spot.` };
    if (!view.replaceable(t.cell)) return { ok: false, reason: 'occupied', cell: t.cell, message: `The cell ${key(t.cell)} holds ${view.describe(t.cell)}, which a block cannot be placed over and is not a solid wall.` };
    toFill.push(t);
  }
  const isBotCell = (c: Cell) => key(c) === key(feet) || key(c) === key(head);
  const placed = new Set<string>();
  const have = (c: Cell) => !isBotCell(c) && (view.solid(c) || placed.has(key(c)));
  const ordered: PlanStep[] = [];
  let remaining = [...toFill];
  for (let scaffolds = 0; scaffolds <= 2; scaffolds++) {
    let progress = true;
    while (progress && remaining.length) {
      progress = false;
      for (const step of [...remaining]) {
        if (neighbours(step.cell).some(have)) {
          placed.add(key(step.cell));
          ordered.push(step);
          remaining = remaining.filter((r) => r !== step);
          progress = true;
        }
      }
    }
    if (!remaining.length) return { ok: true, steps: ordered, needed: ordered.length };
    // Nothing to click on for the rest: add one scaffold cell next to a stuck cell, resting on something solid.
    const stuck = remaining[0].cell;
    let scaffold: Cell | null = null;
    for (const n of [...neighbours(stuck)].reverse()) {
      if (isBotCell(n) || view.solid(n) || placed.has(key(n)) || !view.replaceable(n) || view.lava(n)) continue;
      if (remaining.some((r) => key(r.cell) === key(n))) continue;
      if (neighbours(n).some(have)) {
        scaffold = n;
        break;
      }
    }
    if (!scaffold) break;
    placed.add(key(scaffold));
    ordered.push({ cell: scaffold, kind: 'scaffold' });
  }
  const c = remaining[0]?.cell ?? top;
  return { ok: false, reason: 'no_support', cell: c, message: `Nothing solid to place a block against next to ${key(c)}.` };
}

export interface DigView extends ShelterView {
  /** A block that can be dug with the held tools and is not liquid, air or a container. */
  diggable(c: Cell): boolean;
}

export type DigPlan = { ok: true; cells: [Cell, Cell]; steps: PlanStep[]; needed: number } | { ok: false; message: string };

/** The hole method: two cells straight down, all their side cells and the floor solid already. */
export function planDigDown(view: DigView, feet: Cell): DigPlan {
  const d1: Cell = { x: feet.x, y: feet.y - 1, z: feet.z };
  const d2: Cell = { x: feet.x, y: feet.y - 2, z: feet.z };
  const floor: Cell = { x: feet.x, y: feet.y - 3, z: feet.z };
  if (!view.diggable(d1) || !view.diggable(d2)) return { ok: false, message: `The two blocks under the bot (${view.describe(d1)}, ${view.describe(d2)}) cannot be dug with what is held.` };
  if (!view.solid(floor)) return { ok: false, message: `Below the hole is ${view.describe(floor)}, not solid ground.` };
  // The same world, but the two cells dug out: what would the bot have to place then?
  const dug = new Set([key(d1), key(d2)]);
  const virtual: ShelterView = {
    solid: (c) => !dug.has(key(c)) && view.solid(c),
    replaceable: (c) => dug.has(key(c)) || view.replaceable(c),
    lava: (c) => view.lava(c),
    describe: (c) => (dug.has(key(c)) ? 'air' : view.describe(c)),
  };
  const plan = planEnclosure(virtual, d2);
  if (!plan.ok) return { ok: false, message: plan.message };
  const walls = plan.steps.filter((s) => s.kind === 'wall');
  if (walls.length) return { ok: false, message: `The hole's side at ${key(walls[0].cell)} is not solid (${view.describe(walls[0].cell)}).` };
  return { ok: true, cells: [d1, d2], steps: plan.steps, needed: plan.steps.length };
}

/** The cells of the enclosure that are not full solid cubes. Empty means sealed. */
export function openCells(view: ShelterView, feet: Cell): Cell[] {
  const { sides, top } = enclosureCells(feet);
  return [...sides, top].filter((c) => !view.solid(c));
}

export interface HeldBlock {
  name: string;
  count: number;
}

const NOT_SHELTER =
  /(_ore$|^raw_|^(sand|red_sand|gravel|suspicious_sand|suspicious_gravel)$|_powder$|chest|barrel|furnace|smoker|crafting_table|tnt|shulker|spawner|bedrock|obsidian|(diamond|iron|gold|emerald|lapis|redstone|netherite|copper|coal|amethyst|raw_\w+)_block$|beacon|command_block|ice$|glass|slime|honey|bookshelf|jukebox|note_block|dispenser|dropper|observer|piston|hopper|cactus|farmland|grass_block|mycelium|podzol|snow_block|sponge|sculk|leaves|target|lodestone|respawn_anchor|enchanting|anvil|_bed$|loom|cartography|fletching|smithing|grindstone|stonecutter|composter|cauldron|lectern|bell$|campfire|magma|dried_kelp|hay_block|bone_block|bee|nest|hive|crafter|vault|trial)/;

/** Blocks worth spending on walls, cheapest first: dirt and stone kinds, then planks, then any other plain full block. */
export function shelterRank(name: string): number {
  if (NOT_SHELTER.test(name)) return -1;
  if (/^(dirt|coarse_dirt|cobblestone|cobbled_deepslate|netherrack|stone|andesite|diorite|granite|tuff|deepslate|blackstone|mud|rooted_dirt)$/.test(name)) return 0;
  if (/_planks$/.test(name)) return 1;
  if (/^(sandstone|red_sandstone|terracotta|stone_bricks|bricks|calcite|dripstone_block|clay|packed_mud|mud_bricks)$/.test(name)) return 2;
  return 3;
}

/** The held items that can serve as shelter blocks, cheapest first. `isFullBlock` says whether an item is one full solid cube. */
export function pickShelterBlocks(items: HeldBlock[], isFullBlock: (name: string) => boolean): HeldBlock[] {
  const merged = new Map<string, number>();
  for (const it of items) merged.set(it.name, (merged.get(it.name) ?? 0) + it.count);
  return [...merged.entries()]
    .filter(([name, count]) => count > 0 && shelterRank(name) >= 0 && isFullBlock(name))
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => shelterRank(a.name) - shelterRank(b.name) || b.count - a.count);
}

export type MethodChoice =
  | { method: 'walls' | 'hole'; needed: number; short: number; other?: { method: 'walls' | 'hole'; needed: number } }
  | { method: 'none'; why: string };

/** Picks the method needing fewer blocks (walls on a tie). `held` is the usable block count. */
export function chooseMethod(walls: EnclosurePlan, hole: DigPlan | null, held: number): MethodChoice {
  const options: Array<{ method: 'walls' | 'hole'; needed: number }> = [];
  if (walls.ok) options.push({ method: 'walls', needed: walls.needed });
  if (hole && hole.ok) options.push({ method: 'hole', needed: hole.needed });
  if (!options.length) {
    const why = [!walls.ok ? walls.message : '', hole && !hole.ok ? `Digging down: ${hole.message}` : ''].filter(Boolean).join(' ');
    return { method: 'none', why };
  }
  options.sort((a, b) => a.needed - b.needed || (a.method === 'walls' ? -1 : 1));
  const best = options[0];
  return { method: best.method, needed: best.needed, short: Math.max(0, best.needed - held), other: options[1] };
}

// ---------------------------------------------------------------------------------------------
// The world, as the planner sees it
// ---------------------------------------------------------------------------------------------

const PLANTS = /^(air|cave_air|void_air|short_grass|tall_grass|fern|large_fern|dead_bush|snow|vine|glow_lichen|light|water|seagrass|tall_seagrass)$/;
const UNDIGGABLE = /^(air|cave_air|void_air|water|lava|bedrock|obsidian|crying_obsidian|end_portal_frame|barrier|spawner|chest|trapped_chest|barrel|ender_chest|furnace|crafting_table|reinforced_deepslate)$/;

function isFullCube(b: any): boolean {
  if (!b || b.boundingBox !== 'block') return false;
  const shapes: number[][] | undefined = b.shapes;
  if (!shapes) return true;
  return shapes.length === 1 && shapes[0][0] <= 0.001 && shapes[0][1] <= 0.001 && shapes[0][2] <= 0.001 && shapes[0][3] >= 0.999 && shapes[0][4] >= 0.999 && shapes[0][5] >= 0.999;
}

function viewOf(bot: Bot): DigView {
  const at = (c: Cell): any => bot.blockAt(new Vec3(c.x, c.y, c.z));
  return {
    solid: (c) => isFullCube(at(c)),
    replaceable: (c) => {
      const b = at(c);
      return Boolean(b) && PLANTS.test(b.name);
    },
    lava: (c) => at(c)?.name === 'lava',
    describe: (c) => at(c)?.name ?? 'unloaded',
    diggable: (c) => {
      const b = at(c);
      if (!b || UNDIGGABLE.test(b.name) || b.hardness === undefined || b.hardness < 0 || !isFullCube(b)) return false;
      return harvestOk(bot, b);
    },
  };
}

/** A tool among those held that harvests the block (or none needed). */
function bestTool(bot: Bot, block: any): { ok: boolean; tool: any | null } {
  const plan = planTool(bot, block.name);
  let best: any = null;
  let bestTime = Infinity;
  const consider = (item: any | null) => {
    let t = Infinity;
    try {
      t = block.digTime(item ? item.type : null, false, false, false, [], {});
    } catch {
      return;
    }
    if (t < bestTime) {
      bestTime = t;
      best = item;
    }
  };
  if (!plan.requiresTool) consider(null);
  for (const it of bot.inventory.items()) {
    if (!/_(pickaxe|axe|shovel|hoe)$/.test(it.name)) continue;
    if (plan.requiresTool && !plan.workingTools.includes(it.name)) continue;
    consider(it);
  }
  return { ok: bestTime < Infinity, tool: best };
}

function harvestOk(bot: Bot, block: any): boolean {
  return bestTool(bot, block).ok;
}

const cellOf = (bot: Bot): Cell => {
  const p = bot.entity.position;
  return { x: Math.floor(p.x), y: Math.floor(p.y + 0.001), z: Math.floor(p.z) };
};

function heldBlocks(bot: Bot): HeldBlock[] {
  const reg: any = bot.registry;
  const isFull = (name: string): boolean => {
    const b = reg.blocksByName?.[name];
    if (!b || b.boundingBox !== 'block') return false;
    const shapes = reg.blockCollisionShapes;
    if (!shapes) return true;
    const ids = shapes.blocks?.[name];
    if (typeof ids !== 'number') return false;
    const s = shapes.shapes?.[ids];
    return Array.isArray(s) && s.length === 1 && s[0][0] === 0 && s[0][1] === 0 && s[0][2] === 0 && s[0][3] === 1 && s[0][4] === 1 && s[0][5] === 1;
  };
  const items = bot.inventory.items().filter((i: any) => i.slot > 4 && i.slot < 45).map((i: any) => ({ name: i.name, count: i.count }));
  return pickShelterBlocks(items, isFull);
}

const totalHeld = (blocks: HeldBlock[]) => blocks.reduce((a, b) => a + b.count, 0);

function entityIn(bot: Bot, c: Cell): any | null {
  for (const e of Object.values(bot.entities) as any[]) {
    if (!e?.position || e === bot.entity) continue;
    if (e.name === 'item' || e.name === 'experience_orb' || e.type === 'orb' || e.type === 'other' || e.name === 'arrow') continue;
    const w = (e.width ?? 0.6) / 2;
    const h = e.height ?? 1.8;
    if (e.position.x + w > c.x + 0.001 && e.position.x - w < c.x + 1 - 0.001 && e.position.z + w > c.z + 0.001 && e.position.z - w < c.z + 1 - 0.001 && e.position.y + h > c.y + 0.001 && e.position.y < c.y + 1 - 0.001) return e;
  }
  return null;
}

function timeOfDay(bot: Bot): number | undefined {
  const t = bot.time?.timeOfDay;
  return typeof t === 'number' ? t : undefined;
}

// ---------------------------------------------------------------------------------------------
// Acting
// ---------------------------------------------------------------------------------------------

type Ctx = { bot: Bot; signal: AbortSignal; log: (l: string) => void; died?: () => boolean };

async function yieldToReflex(ctx: Ctx): Promise<void> {
  if (body.reflexActive) await body.waitForRelease(ctx.signal);
}

/** Stands the bot in the middle of its cell so a block can go in every neighbour without an overlap. */
async function centre(ctx: Ctx, c: Cell): Promise<boolean> {
  const bot = ctx.bot;
  const dist = () => Math.hypot(bot.entity.position.x - (c.x + 0.5), bot.entity.position.z - (c.z + 0.5));
  const here = cellOf(bot);
  if (here.x !== c.x || here.z !== c.z || Math.abs(bot.entity.position.y - c.y) > 1.2) {
    await travel(ctx, c.x, c.y, c.z, 0);
  }
  const started = Date.now();
  while (dist() > 0.15 && Date.now() - started < 4000 && !ctx.signal.aborted) {
    await yieldToReflex(ctx);
    await bot.lookAt(new Vec3(c.x + 0.5, bot.entity.position.y + 1.62, c.z + 0.5), true);
    bot.setControlState('sneak', true);
    bot.setControlState('forward', dist() > 0.15);
    await sleep(45);
  }
  bot.clearControlStates();
  return dist() <= 0.35;
}

type PlaceResult = 'placed' | 'entity' | 'no_ref' | 'failed' | 'no_item';

/** Places one block of the cheapest held kind at `cell`, against any solid neighbour. Reads the world to confirm. */
async function placeAt(ctx: Ctx, cell: Cell, evidence: string[]): Promise<PlaceResult> {
  const bot = ctx.bot;
  const view = viewOf(bot);
  if (view.solid(cell)) return 'placed';
  const ent = entityIn(bot, cell);
  if (ent) return 'entity';
  const mine = cellOf(bot);
  const botCells = new Set([key(mine), key({ x: mine.x, y: mine.y + 1, z: mine.z })]);
  const refs = neighbours(cell).filter((n) => !botCells.has(key(n)) && view.solid(n));
  if (!refs.length) return 'no_ref';
  const stock = heldBlocks(bot);
  if (!stock.length) return 'no_item';
  const item = stock[0].name;
  // A reflex swapping to its sword at the same moment can leave the stack on the cursor for a moment: retry.
  let err = bot.heldItem?.name === item ? null : await equipItem(bot, item, 'hand');
  for (let i = 0; err && i < 3; i++) {
    await sleep(150);
    await settleInventory(bot);
    err = await equipItem(bot, item, 'hand');
  }
  if (err) {
    evidence.push(`could not hold ${item}: ${err}`);
    return 'failed';
  }
  // A reflex may have taken the body (and put a sword in the hand) while the item was being equipped.
  if (body.reflexActive || bot.heldItem?.name !== item) return 'entity';
  const eye = bot.entity.position.offset(0, 1.62, 0);
  refs.sort((a, b) => eye.distanceTo(new Vec3(a.x + 0.5, a.y + 0.5, a.z + 0.5)) - eye.distanceTo(new Vec3(b.x + 0.5, b.y + 0.5, b.z + 0.5)));
  const ref = refs[0];
  const refBlock = bot.blockAt(new Vec3(ref.x, ref.y, ref.z));
  if (!refBlock) return 'failed';
  const face = new Vec3(cell.x - ref.x, cell.y - ref.y, cell.z - ref.z);
  bot.setControlState('sneak', true);
  let said = '';
  try {
    await (bot.placeBlock(refBlock, face) as Promise<void>).catch((e: Error) => {
      said = e.message;
    });
  } finally {
    bot.setControlState('sneak', false);
  }
  // placeBlock already waited for the server's answer about this cell; only a slow update needs a short extra wait.
  if (viewOf(bot).solid(cell)) return 'placed';
  await bot.waitForTicks(3);
  if (viewOf(bot).solid(cell)) return 'placed';
  evidence.push(`placing ${item} at ${key(cell)} against ${key(ref)} did not hold${said ? `: ${said}` : ''} (bot at ${bot.entity.position.x.toFixed(2)} ${bot.entity.position.y.toFixed(2)} ${bot.entity.position.z.toFixed(2)}, ref ${bot.blockAt(new Vec3(ref.x, ref.y, ref.z))?.name}, entity in cell: ${entityIn(bot, cell)?.name ?? 'none'})`);
  return 'failed';
}

interface BuildResult {
  ok: boolean;
  placed: Cell[];
  message: string;
  feet: Cell;
  cause?: FailureCause;
}

/**
 * Fills the enclosure around `home` until every side cell and the top is solid. Re-plans from the live world after
 * every block, so a reflex fight, a knock-back or a mob in the way only costs time.
 */
async function buildEnclosure(ctx: Ctx, home: Cell, evidence: string[], budgetMs = 90000): Promise<BuildResult> {
  const bot = ctx.bot;
  const placedCells: Cell[] = [];
  let feet = home;
  const failures = new Map<string, number>();
  const started = Date.now();
  for (let iter = 0; iter < 60; iter++) {
    if (ctx.signal.aborted) return { ok: false, placed: placedCells, message: 'Cancelled while building.', feet, cause: 'interrupted' };
    if (Date.now() - started > budgetMs) return { ok: false, placed: placedCells, message: `Building took longer than ${Math.round(budgetMs / 1000)} s.`, feet, cause: 'no_progress' };
    await yieldToReflex(ctx);
    const view = viewOf(bot);
    // Back to the chosen spot after a fight pushed the bot away; if it is no longer free, build where the bot stands.
    const here = cellOf(bot);
    if (key(here) !== key(feet)) {
      if (!view.solid(feet) && !view.solid({ x: feet.x, y: feet.y + 1, z: feet.z })) {
        const ok = await centre(ctx, feet);
        if (!ok) {
          feet = cellOf(bot);
          evidence.push(`could not get back to the chosen cell; building at ${key(feet)} instead`);
        }
      } else {
        feet = here;
      }
    } else if (Math.hypot(bot.entity.position.x - (feet.x + 0.5), bot.entity.position.z - (feet.z + 0.5)) > 0.3) {
      await centre(ctx, feet);
    }
    const plan = planEnclosure(viewOf(bot), feet);
    if (!plan.ok) return { ok: false, placed: placedCells, message: plan.message, feet, cause: plan.reason === 'lava' ? 'too_dangerous' : 'blocked' };
    if (!plan.steps.length) return { ok: true, placed: placedCells, message: `Sealed after ${placedCells.length} block(s).`, feet };
    const step = plan.steps.find((s) => (failures.get(key(s.cell)) ?? 0) < 6) ?? plan.steps[0];
    const r = await placeAt(ctx, step.cell, evidence);
    if (r === 'placed') {
      placedCells.push(step.cell);
      failures.delete(key(step.cell));
      continue;
    }
    if (r === 'no_item') return { ok: false, placed: placedCells, message: 'Ran out of blocks while building.', feet, cause: 'missing_item' };
    failures.set(key(step.cell), (failures.get(key(step.cell)) ?? 0) + 1);
    if (r === 'entity') await sleep(400); // a reflex is dealing with it
    else if (r === 'no_ref') await sleep(150);
    if ([...failures.values()].some((n) => n >= 8)) {
      return { ok: false, placed: placedCells, message: `Could not place a block at ${key(step.cell)} (${r}).`, feet, cause: r === 'no_ref' ? 'blocked' : 'server_rejected' };
    }
  }
  return { ok: false, placed: placedCells, message: 'Too many building steps.', feet, cause: 'no_progress' };
}

/** Digs one block with the best held tool and waits for it to be gone. */
async function digBlock(ctx: Ctx, c: Cell, evidence: string[]): Promise<boolean> {
  const bot = ctx.bot;
  const block: any = bot.blockAt(new Vec3(c.x, c.y, c.z));
  if (!block || UNDIGGABLE.test(block.name)) return false;
  const { ok, tool } = bestTool(bot, block);
  if (!ok) return false;
  if (tool && bot.heldItem?.type !== tool.type) {
    try {
      await withInventoryLock(() => bot.equip(tool, 'hand'));
    } catch (err) {
      evidence.push(`equip ${tool.name} failed: ${(err as Error).message}`);
    }
  } else if (!tool && bot.heldItem) {
    try {
      await withInventoryLock(() => bot.unequip('hand'));
    } catch {
      // keep what is held
    }
  }
  try {
    await bot.dig(block, true);
  } catch (err) {
    evidence.push(`dig ${block.name} at ${key(c)} failed: ${(err as Error).message}`);
  }
  await sleep(60);
  const after = bot.blockAt(new Vec3(c.x, c.y, c.z));
  return !after || !isFullCube(after);
}

/** Waits (bounded) until the bot stands on the floor of `feet`. */
async function waitDropTo(ctx: Ctx, feet: Cell): Promise<boolean> {
  const bot = ctx.bot;
  for (let i = 0; i < 40; i++) {
    const p = bot.entity.position;
    if (Math.floor(p.y + 0.001) <= feet.y && (bot.entity as any).onGround) return true;
    await sleep(100);
  }
  return cellOf(bot).y <= feet.y;
}

/**
 * Digs the two cells under `feet`, with the scaffold for the cap placed first. Works from the state of the world, not
 * from a fixed sequence, so a reflex fight that drags the bot away (or out of the hole) only costs a walk back.
 * Returns the cell the bot ended in.
 */
async function digHole(ctx: Ctx, feet: Cell, plan: Extract<DigPlan, { ok: true }>, evidence: string[], built: Cell[]): Promise<{ ok: boolean; feet: Cell; message: string }> {
  const bot = ctx.bot;
  const [d1, d2] = plan.cells;
  const solid = (c: Cell) => viewOf(bot).solid(c);
  const failed = (message: string) => ({ ok: false, feet: cellOf(bot), message });
  for (const s of plan.steps.filter((p) => p.kind === 'scaffold')) {
    for (let i = 0; i < 12 && !solid(s.cell); i++) {
      await yieldToReflex(ctx);
      if (ctx.signal.aborted) return failed('Cancelled while digging down.');
      if (!(await centre(ctx, feet))) continue;
      const r = await placeAt(ctx, s.cell, evidence);
      if (r === 'no_ref' || r === 'no_item') return failed(`Could not place the scaffold block at ${key(s.cell)} (${r}).`);
      if (r !== 'placed') await sleep(400);
    }
    if (!solid(s.cell)) return failed(`The scaffold block at ${key(s.cell)} did not stay.`);
    built.push(s.cell);
  }
  const digStart = Date.now();
  for (let iter = 0; Date.now() - digStart < 90000; iter++) {
    await yieldToReflex(ctx);
    if (ctx.signal.aborted) return failed('Cancelled while digging down.');
    const here = cellOf(bot);
    const inHole = key(here) === key(d2) && !solid(d1) && !solid(d2);
    if (inHole) return { ok: true, feet: d2, message: 'Dug down two blocks.' };
    // The cell the bot must stand in to dig the next block, and the block it digs.
    const next = solid(d1) ? { stand: feet, dig: d1 } : solid(d2) ? { stand: d1, dig: d2 } : { stand: d2, dig: null };
    if (!(await centre(ctx, next.stand))) {
      if (iter < 40) evidence.push(`iter ${iter}: could not centre on ${key(next.stand)} (bot at ${bot.entity.position.floored()}, y ${bot.entity.position.y.toFixed(2)})`);
      await sleep(300);
      continue;
    }
    if (!next.dig) continue;
    if (!(await digBlock(ctx, next.dig, evidence))) return failed(`Could not dig ${viewOf(bot).describe(next.dig)} at ${key(next.dig)}.`);
    await waitDropTo(ctx, next.dig);
  }
  return failed('The bot did not get into the hole.');
}

/** Breaks a cell we built, or any breakable block, with the best tool. */
async function breakCell(ctx: Ctx, c: Cell, evidence: string[]): Promise<boolean> {
  const b: any = ctx.bot.blockAt(new Vec3(c.x, c.y, c.z));
  if (!b || !isFullCube(b)) return true;
  return digBlock(ctx, c, evidence);
}

/** Opens the shelter again so the bot is not left trapped. Returns a sentence for the result. */
async function openUp(ctx: Ctx, method: 'walls' | 'hole', feet: Cell, surface: Cell, built: Cell[], evidence: string[]): Promise<string> {
  const bot = ctx.bot;
  if (ctx.died?.()) return 'The bot died; nothing to open.';
  if (method === 'hole' && cellOf(bot).y < surface.y) {
    const cap = { x: feet.x, y: feet.y + 2, z: feet.z };
    await breakCell(ctx, cap, evidence);
    const climb = Math.max(1, surface.y - cellOf(bot).y);
    const r = await techniquePillarUp(bot, climb, ctx.signal);
    evidence.push(`pillar up ${climb}: ${r.status} ${r.reason ?? ''}`);
    const now = cellOf(bot);
    return now.y >= surface.y ? `Opened the cap and climbed back to the surface at ${key(now)}.` : `Opened the cap but could not climb out (${r.reason ?? r.status}); the bot is at ${key(now)}.`;
  }
  const builtKeys = new Set(built.map(key));
  const view = viewOf(bot);
  const choices = HORIZONTAL.map((d) => {
    const lo = { x: feet.x + d.dx, y: feet.y, z: feet.z + d.dz };
    const hi = { x: lo.x, y: lo.y + 1, z: lo.z };
    const beyond = [{ x: lo.x + d.dx, y: lo.y, z: lo.z + d.dz }, { x: hi.x + d.dx, y: hi.y, z: hi.z + d.dz }];
    const unsafe = beyond.some((c) => view.lava(c));
    const ours = (builtKeys.has(key(lo)) ? 1 : 0) + (builtKeys.has(key(hi)) ? 1 : 0);
    return { d, lo, hi, unsafe, ours, ok: (view.solid(lo) ? view.diggable(lo) : true) && (view.solid(hi) ? view.diggable(hi) : true) };
  })
    .filter((c) => !c.unsafe && c.ok)
    .sort((a, b) => b.ours - a.ours);
  for (const c of choices) {
    const a = await breakCell(ctx, c.hi, evidence);
    const b = await breakCell(ctx, c.lo, evidence);
    if (a && b) return `Opened the ${c.d.name} side (${key(c.lo)} and ${key(c.hi)}).`;
  }
  return 'Could not open any side; the bot is still enclosed.';
}

/** Hostile mobs within `range` blocks of the bot. */
function hostilesNear(bot: Bot, range: number): any[] {
  return Object.values(bot.entities).filter((e: any) => e?.position && e !== bot.entity && e.isValid !== false && HOSTILE.has(e.name) && e.position.distanceTo(bot.entity.position) <= range);
}

/** Waits (bounded) until no hostile mob is within NEAR_MOBS blocks; the reflexes fight what comes close. True if it waited at all. */
async function waitOutNearbyMobs(ctx: Ctx, evidence: string[]): Promise<boolean> {
  const started = Date.now();
  let waited = false;
  while (hostilesNear(ctx.bot, NEAR_MOBS).length && Date.now() - started < NEAR_MOBS_WAIT_MS && !ctx.signal.aborted) {
    waited = true;
    if (body.reflexActive) await body.waitForRelease(ctx.signal);
    await sleep(250);
  }
  if (waited) evidence.push(`waited ${Math.round((Date.now() - started) / 1000)} s for ${hostilesNear(ctx.bot, NEAR_MOBS).length} hostile mob(s) within ${NEAR_MOBS} blocks`);
  return waited;
}

function evaluate(bot: Bot, args: ShelterArgs): Precondition {
  if (!bot.entity) return { ok: false, cause: 'unknown', message: 'The bot is not in the world.' };
  if (!(bot as any).blockAt) return { ok: false, cause: 'unknown', message: 'The world is not available.' };
  const feet = cellOf(bot);
  const view = viewOf(bot);
  if (!view.solid({ x: feet.x, y: feet.y - 1, z: feet.z })) {
    return { ok: false, cause: 'blocked', message: `The bot is not standing on solid ground (below: ${view.describe({ x: feet.x, y: feet.y - 1, z: feet.z })}).`, fix: 'walk to dry, solid ground first' };
  }
  if (view.describe(feet) === 'water' || view.describe({ x: feet.x, y: feet.y + 1, z: feet.z }) === 'water') {
    return { ok: false, cause: 'too_dangerous', message: 'The bot is standing in water.', fix: 'get out of the water first' };
  }
  const tod = timeOfDay(bot);
  if (args.minutes === undefined && tod !== undefined && tod < NIGHT_FROM) {
    return { ok: false, cause: 'invalid_args', message: `It is daytime (time of day ${tod}); there is no night to wait out.`, fix: 'give `minutes` to shelter for a set time anyway, or wait until it is dark' };
  }
  const blocks = heldBlocks(bot);
  const walls = planEnclosure(view, feet);
  const hole = planDigDown(view, feet);
  const choice = chooseMethod(walls, hole, totalHeld(blocks));
  if (choice.method === 'none') return { ok: false, cause: 'blocked', message: `Cannot enclose the bot here. ${choice.why}`, fix: 'move to flat open ground or a spot with solid walls, then try again' };
  if (choice.short > 0) {
    const have = totalHeld(blocks);
    return {
      ok: false,
      cause: 'missing_item',
      message: `Sealing in needs ${choice.needed} placeable blocks (${choice.method === 'hole' ? 'dig down two and cap it' : 'walls and a roof'}); the bot holds ${have}. Needs ${choice.short} more (dirt, cobblestone or planks).`,
      fix: `get ${choice.short} more dirt, cobblestone or planks (${choice.short} more)`,
    };
  }
  return { ok: true };
}

export const shelterSkill: SkillDefinition<ShelterArgs> = {
  name: 'shelter',
  summary:
    'shelter {minutes?, open_after?=true}: the emergency move when there is no bed at night. Seals the bot into a closed 1x1x2 space with held blocks (dirt, cobblestone, planks; or digs down 2 and caps the hole, whichever needs fewer blocks), waits until morning (or `minutes`), then opens it again. Reports exactly how many blocks are missing if short.',
  args: Args,
  check: (ctx, args) => evaluate(ctx.bot, args),
  async run(outer, args): Promise<SkillOutcome> {
    // A death ends the skill: the bot respawns far away and nothing built here matters any more.
    const ac = new AbortController();
    let died = false;
    const onAbort = () => ac.abort();
    const onDeath = () => {
      died = true;
      ac.abort();
    };
    if (outer.signal.aborted) ac.abort();
    outer.signal.addEventListener('abort', onAbort, { once: true });
    outer.bot.once('death', onDeath);
    try {
      const r = await runShelter({ bot: outer.bot, log: outer.log, signal: ac.signal, died: () => died }, args);
      if (died) return { ...r, status: 'failed', cause: 'too_dangerous', message: `The bot died while sheltering and respawned elsewhere. ${r.message}`, fix: 'start again from the respawn point with more blocks, a weapon, and before the mobs arrive' };
      return r;
    } finally {
      outer.signal.removeEventListener('abort', onAbort);
      outer.bot.off('death', onDeath);
    }
  },
};

async function runShelter(ctx: Ctx, args: ShelterArgs): Promise<SkillOutcome> {
  const bot = ctx.bot;
  const evidence: string[] = [];
  const out = (status: SkillOutcome['status'], message: string, cause?: FailureCause, fix?: string): SkillOutcome => ({ status, cause, message, fix, evidence });
  const pre = evaluate(bot, args);
  if (!pre.ok) return out('failed', pre.message, pre.cause, pre.fix);

  // Mobs already next to the bot would hit it while it is half-built (worst in a hole): let the reflexes deal with them first.
  const waited = await waitOutNearbyMobs(ctx, evidence);
  if (ctx.signal.aborted) return out('interrupted', 'Cancelled while waiting for nearby mobs to be dealt with.', 'interrupted');
  if (waited) {
    const pre2 = evaluate(bot, args);
    if (!pre2.ok) return out('failed', pre2.message, pre2.cause, pre2.fix);
  }

  const home = cellOf(bot);
  const view = viewOf(bot);
  const walls = planEnclosure(view, home);
  const hole = planDigDown(view, home);
  const choice = chooseMethod(walls, hole, totalHeld(heldBlocks(bot)));
  if (choice.method === 'none') return out('failed', `Cannot enclose the bot here. ${choice.why}`, 'blocked');
  evidence.push(`method ${choice.method}: needs ${choice.needed} block(s), holds ${totalHeld(heldBlocks(bot))}${choice.other ? `; the other way needs ${choice.other.needed}` : ''}`);
  const startedAt = Date.now();
  const surface = home;
  const built: Cell[] = [];
  let feet = home;

  // Build.
  if (choice.method === 'hole') {
    const d = await digHole(ctx, home, hole as Extract<DigPlan, { ok: true }>, evidence, built);
    feet = d.feet;
    evidence.push(`hole stage: ok=${d.ok}, bot at ${bot.entity.position.x.toFixed(2)} ${bot.entity.position.y.toFixed(2)} ${bot.entity.position.z.toFixed(2)}, feet cell ${key(feet)}`);
    if (!d.ok) {
      evidence.push(`digging down failed: ${d.message}`);
      if (cellOf(bot).y < surface.y) await openUp(ctx, 'hole', feet, surface, built, evidence);
      return out(ctx.signal.aborted ? 'interrupted' : 'failed', d.message, ctx.signal.aborted ? 'interrupted' : 'blocked', 'try on flat solid ground');
    }
  }
  const b = await buildEnclosure(ctx, feet, evidence);
  built.push(...b.placed);
  feet = b.feet;
  const open = openCells(viewOf(bot), feet);
  evidence.push(`placed ${b.placed.length} block(s); open cells: ${open.length ? open.map(key).join(' ') : 'none'}`);
  if (!b.ok || open.length) {
    const opened = args.open_after ? await openUp(ctx, choice.method, feet, surface, built, evidence) : '';
    return out(b.cause === 'interrupted' || ctx.signal.aborted ? 'interrupted' : 'failed', `${b.message}${open.length ? ` Still open: ${open.map(key).join(', ')} (${open.map((c) => viewOf(bot).describe(c)).join(', ')}).` : ''} ${opened}`.trim(), b.cause ?? 'blocked', 'check the surroundings and the blocks held');
  }
  ctx.log(`[shelter] sealed in at ${key(feet)} after ${b.placed.length} block(s)`);

  // Wait.
  const startTod = timeOfDay(bot);
  const untilMorning = args.minutes === undefined;
  const deadline = untilMorning ? startedAt + MAX_WAIT_MORNING_MS : Date.now() + args.minutes! * 60000;
  let repairs = 0;
  let ended = 'time ran out';
  let lastCheck = 0;
  let ok = true;
  let waitFailure = '';
  while (Date.now() < deadline) {
    if (ctx.signal.aborted) {
      ended = 'cancelled';
      break;
    }
    const tod = timeOfDay(bot);
    if (untilMorning && startTod !== undefined && tod !== undefined && tod < NIGHT_FROM) {
      ended = `morning (time of day ${tod})`;
      break;
    }
    if (Date.now() - lastCheck > RECHECK_MS) {
      lastCheck = Date.now();
      if (!body.reflexActive) {
        const now = cellOf(bot);
        const gaps = openCells(viewOf(bot), key(now) === key(feet) ? feet : now);
        if (gaps.length) {
          evidence.push(`enclosure opened at ${gaps.map(key).join(' ')}; repairing (${repairs + 1})`);
          if (repairs++ >= 4) {
            ok = false;
            waitFailure = `The enclosure kept being broken (open: ${gaps.map(key).join(', ')}).`;
            break;
          }
          const r = await buildEnclosure(ctx, now, evidence, 40000);
          built.push(...r.placed);
          feet = r.feet;
          if (!r.ok) {
            ok = false;
            waitFailure = `Could not repair the enclosure: ${r.message}`;
            break;
          }
        }
      }
    }
    await sleep(250);
  }
  const tod = timeOfDay(bot);
  evidence.push(`waited ${Math.round((Date.now() - startedAt) / 1000)} s; ended: ${ended}; time of day ${startTod} -> ${tod}`);

  // Open.
  let openedNote = 'The bot is still sealed in (open_after was false).';
  if (args.open_after || ctx.signal.aborted) {
    stopMotion(bot);
    openedNote = await openUp(ctx, choice.method, feet, surface, built, evidence);
  }
  if (ctx.signal.aborted) return out('interrupted', `Cancelled while sheltering. ${openedNote}`, 'interrupted');
  if (!ok) return out('partial', `${waitFailure} ${openedNote}`, 'blocked', 'build again or move somewhere safer');
  if (untilMorning && !ended.startsWith('morning')) {
    return out('partial', `Sheltered for ${Math.round((Date.now() - startedAt) / 1000)} s but morning had not come (time of day ${tod}). ${openedNote}`, 'no_progress', 'shelter again or keep waiting');
  }
  return out('done', `Sealed in with ${built.length} block(s) (${choice.method}), waited until ${ended}. ${openedNote}`);
}
