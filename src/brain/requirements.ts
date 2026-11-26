/**
 * Requirements calculator: what is still missing for a goal item, worked out from the game's own data
 * (recipes, loot tables, tags, harvest tiers) so the LLM never does recipe arithmetic.
 * Pure functions: no bot, no network. Item ids are written without "minecraft:".
 */
import { getLootTables, getRecipes, resolveTag } from '../knowledge/vanilla.js';
import {
  SUGGEST_ORDER,
  blockRequiresTool,
  lootDrops,
  lootTableItems,
  minimumTool,
  stripNamespace as strip,
  toolPlanFor,
} from '../knowledge/harvest.js';

export interface Have {
  [item: string]: number;
}

export interface Need {
  item: string;
  count: number;
  have: number;
  /** Every way to get it, best first. */
  how: Array<
    | { kind: 'craft'; recipeId: string; station: 'inventory' | 'crafting_table'; makes: number; inputs: { item: string; count: number; options?: string[] }[] }
    | { kind: 'smelt'; recipeId: string; station: 'furnace' | 'blast_furnace' | 'smoker' | 'campfire'; input: string; options?: string[]; cookTicks: number }
    | { kind: 'stonecut'; recipeId: string; input: string; makes: number }
    | { kind: 'mine'; blocks: string[]; tool?: string; minTool?: string }
    | { kind: 'drop'; entities: string[] }
    | { kind: 'loot'; tables: string[] }
  >;
}

type Way = Need['how'][number];

// ---------------------------------------------------------------------------------------------------------------
// Recipe index
// ---------------------------------------------------------------------------------------------------------------

interface Slot {
  /** Acceptable item ids (tags and lists expanded), in game-data order. */
  options: string[];
  count: number;
  /** Tag name without namespace when the ingredient was a tag. */
  tag?: string;
}

interface Recipe {
  id: string;
  kind: 'craft' | 'smelt' | 'stonecut';
  /** inventory | crafting_table | furnace | blast_furnace | smoker | campfire | stonecutter */
  station: string;
  result: string;
  makes: number;
  slots: Slot[];
  cookTicks: number;
  category: string;
}

const COOK_STATION: Record<string, string> = {
  'minecraft:smelting': 'furnace',
  'minecraft:blasting': 'blast_furnace',
  'minecraft:smoking': 'smoker',
  'minecraft:campfire_cooking': 'campfire',
};

function ingredientOptions(x: any): { options: string[]; tag?: string } {
  if (Array.isArray(x)) {
    const options: string[] = [];
    for (const e of x) for (const o of ingredientOptions(e).options) if (!options.includes(o)) options.push(o);
    return { options };
  }
  if (typeof x === 'string' && x.startsWith('#')) {
    return { options: resolveTag('item', x).map(strip), tag: strip(x.slice(1)) };
  }
  if (typeof x === 'string') return { options: [strip(x)] };
  return { options: [] };
}

/** Merges identical ingredients (same acceptable items) into one slot with a summed count. */
function addSlot(slots: Slot[], x: any, count = 1): boolean {
  const { options, tag } = ingredientOptions(x);
  if (!options.length) return false;
  const sig = options.join('|');
  const found = slots.find((s) => s.options.join('|') === sig);
  if (found) found.count += count;
  else slots.push({ options, count, tag });
  return true;
}

let recipeList: Recipe[] | null = null;
let byResult: Map<string, Recipe[]> | null = null;

function buildRecipes() {
  if (recipeList) return;
  recipeList = [];
  byResult = new Map();
  for (const [id, r] of Object.entries(getRecipes())) {
    const resultId = r.result?.id;
    if (!resultId) continue; // crafting_special_* recipes have no fixed result
    const slots: Slot[] = [];
    let ok = true;
    let kind: Recipe['kind'];
    let station = 'inventory';
    let cookTicks = 0;
    switch (r.type) {
      case 'minecraft:crafting_shaped': {
        kind = 'craft';
        const pattern: string[] = r.pattern;
        for (const row of pattern) {
          for (const ch of row) {
            if (ch === ' ') continue;
            ok = addSlot(slots, r.key[ch]) && ok;
          }
        }
        const width = Math.max(...pattern.map((p) => p.length));
        station = pattern.length <= 2 && width <= 2 ? 'inventory' : 'crafting_table';
        break;
      }
      case 'minecraft:crafting_shapeless': {
        kind = 'craft';
        for (const ing of r.ingredients) ok = addSlot(slots, ing) && ok;
        station = r.ingredients.length <= 4 ? 'inventory' : 'crafting_table';
        break;
      }
      case 'minecraft:crafting_transmute': {
        kind = 'craft';
        ok = addSlot(slots, r.input) && addSlot(slots, r.material);
        break;
      }
      case 'minecraft:stonecutting': {
        kind = 'stonecut';
        station = 'stonecutter';
        ok = addSlot(slots, r.ingredient);
        break;
      }
      default: {
        const cook = COOK_STATION[r.type];
        if (!cook) continue; // smithing_* and special/decorated recipes are not expressible as Need ways
        kind = 'smelt';
        station = cook;
        cookTicks = r.cookingtime ?? 200;
        ok = addSlot(slots, r.ingredient);
      }
    }
    if (!ok || !slots.length) continue;
    const recipe: Recipe = { id, kind, station, result: strip(resultId), makes: r.result.count ?? 1, slots, cookTicks, category: r.category ?? 'misc' };
    recipeList.push(recipe);
    const list = byResult.get(recipe.result) ?? [];
    list.push(recipe);
    byResult.set(recipe.result, list);
  }
}

const recipesFor = (item: string): Recipe[] => {
  buildRecipes();
  return byResult!.get(item) ?? [];
};

// ---------------------------------------------------------------------------------------------------------------
// Loot indexes (blocks -> mine, entities -> drop, chests/gameplay/... -> loot)
// ---------------------------------------------------------------------------------------------------------------

let blockIndex: Map<string, string[]> | null = null;
let entityIndex: Map<string, string[]> | null = null;
let lootIndex: Map<string, string[]> | null = null;
const LOOT_PREFIX_ORDER = ['gameplay/', 'shearing/', 'archaeology/', 'pots/', 'chests/', 'spawners/'];

function push(map: Map<string, string[]>, key: string, value: string) {
  const list = map.get(key);
  if (!list) map.set(key, [value]);
  else if (!list.includes(value)) list.push(value);
}

function buildLoot() {
  if (blockIndex) return;
  blockIndex = new Map();
  entityIndex = new Map();
  lootIndex = new Map();
  const keys = Object.keys(getLootTables()).sort();
  for (const key of keys) {
    if (key.startsWith('blocks/')) {
      const name = key.slice('blocks/'.length);
      for (const item of lootDrops(name)) push(blockIndex, item, name);
    } else if (key.startsWith('entities/')) {
      const name = key.slice('entities/'.length);
      for (const item of lootTableItems(key, { followRefs: true })) push(entityIndex, item, name);
    } else {
      const pi = LOOT_PREFIX_ORDER.findIndex((p) => key.startsWith(p));
      if (pi < 0) continue;
      for (const item of lootTableItems(key, { followRefs: true })) push(lootIndex, item, key);
    }
  }
  const rank = (k: string) => LOOT_PREFIX_ORDER.findIndex((p) => k.startsWith(p));
  for (const list of lootIndex.values()) list.sort((a, b) => rank(a) - rank(b) || a.length - b.length || (a < b ? -1 : 1));
}

// ---------------------------------------------------------------------------------------------------------------
// Ways to get an item
// ---------------------------------------------------------------------------------------------------------------

interface MineInfo {
  blocks: string[];
  tool?: string;
  minTool?: string;
  /** Item names that harvest the primary block (any tier at or above minTool). Empty when no tool is needed. */
  workingTools: string[];
}

interface Internal {
  way: Way;
  /** 0 normal craft/smelt, 1 mine, 2 drop, 2.5 smelting an ore that already drops the item when mined, 3 reverse (compress/uncompress) craft, 4 loot. */
  tier: number;
  stationCost: number;
  recipe?: Recipe;
  mine?: MineInfo;
}

const STATION_COST: Record<string, number> = { inventory: 0, crafting_table: 1, furnace: 1, stonecutter: 2, smoker: 2, blast_furnace: 2, campfire: 3 };

const reverseCache = new Map<string, boolean>();
/** True when the recipe just converts between a compact and a loose form (ingot <-> block, ingot <-> nugget). */
function isReverse(r: Recipe): boolean {
  let v = reverseCache.get(r.id);
  if (v !== undefined) return v;
  v = false;
  if (r.kind === 'craft') {
    outer: for (const slot of r.slots) {
      for (const o of slot.options) {
        for (const other of recipesFor(o)) {
          if (other.kind === 'craft' && other.slots.some((s) => s.options.includes(r.result))) {
            v = true;
            break outer;
          }
        }
      }
    }
  }
  reverseCache.set(r.id, v);
  return v;
}

const TIER_INDEX = (toolName: string) => SUGGEST_ORDER.findIndex((m) => toolName.startsWith(`${m}_`));

function mineInfoFor(item: string): MineInfo | null {
  buildLoot();
  let blocks = blockIndex!.get(item) ?? [];
  if (!blocks.length) return null;
  // Blocks that drop only themselves (cobblestone, placed logs) are the player-placed form; skip when a natural source exists.
  const natural = blocks.filter((b) => b !== item && !b.startsWith('potted_') && !b.startsWith('infested_'));
  if (natural.length) blocks = natural;
  blocks = [...blocks].sort((a, b) => a.length - b.length || (a < b ? -1 : 1)).slice(0, 8);
  const plans = blocks.map((b) => ({ b, plan: toolPlanFor(b, blockRequiresTool(b)) })).filter((p) => !p.plan.requiresTool || p.plan.workingTools.length > 0);
  if (!plans.length) return null;
  const primary = plans[0].plan;
  const type = primary.type;
  const sameType = plans.filter((p) => p.plan.type === type);
  let minTool: string | undefined;
  let working: string[] = [];
  let strongest = -1;
  for (const { plan } of sameType) {
    if (!plan.requiresTool) continue;
    const t = minimumTool(plan);
    if (t && TIER_INDEX(t) > strongest) {
      strongest = TIER_INDEX(t);
      minTool = t;
      working = plan.workingTools;
    }
  }
  return { blocks: plans.map((p) => p.b), tool: type ?? undefined, minTool, workingTools: minTool ? working : [] };
}

function obtainable(item: string): boolean {
  buildLoot();
  return recipesFor(item).length > 0 || blockIndex!.has(item) || entityIndex!.has(item) || lootIndex!.has(item);
}

const waysCache = new Map<string, Internal[]>();

function internalWays(item: string): Internal[] {
  const cached = waysCache.get(item);
  if (cached) return cached;
  buildLoot();
  const out: Internal[] = [];
  for (const r of recipesFor(item)) {
    let way: Way;
    let tier = 0;
    if (r.kind === 'craft') {
      way = {
        kind: 'craft',
        recipeId: r.id,
        station: r.station as 'inventory' | 'crafting_table',
        makes: r.makes,
        inputs: r.slots.map((s) => ({ item: s.options[0], count: s.count, ...(s.options.length > 1 ? { options: s.options } : {}) })),
      };
      if (isReverse(r)) tier = 3;
    } else if (r.kind === 'smelt') {
      const s = r.slots[0];
      way = { kind: 'smelt', recipeId: r.id, station: r.station as any, input: s.options[0], ...(s.options.length > 1 ? { options: s.options } : {}), cookTicks: r.cookTicks };
      const droppers = new Set(blockIndex!.get(item) ?? []);
      if (s.options.some((o) => droppers.has(o))) tier = 2.5;
    } else {
      const s = r.slots[0];
      way = { kind: 'stonecut', recipeId: r.id, input: s.options[0], makes: r.makes };
    }
    // A recipe that needs an input nothing in the game yields (iron_ore without silk touch) ranks below its siblings.
    if (tier === 0 && r.slots.some((sl) => !sl.options.some(obtainable))) tier = 0.5;
    out.push({ way, tier, stationCost: STATION_COST[r.station] ?? 2, recipe: r });
  }
  const mine = mineInfoFor(item);
  if (mine) {
    out.push({ way: { kind: 'mine', blocks: mine.blocks, ...(mine.tool ? { tool: mine.tool } : {}), ...(mine.minTool ? { minTool: mine.minTool } : {}) }, tier: 1, stationCost: 0, mine });
  }
  const ent = entityIndex!.get(item);
  if (ent?.length) out.push({ way: { kind: 'drop', entities: ent.slice(0, 12) }, tier: 2, stationCost: 0 });
  const loot = lootIndex!.get(item);
  if (loot?.length) out.push({ way: { kind: 'loot', tables: loot.slice(0, 12) }, tier: 4, stationCost: 0 });
  out.sort((a, b) => a.tier - b.tier || a.stationCost - b.stationCost || (a.recipe?.slots.length ?? 0) - (b.recipe?.slots.length ?? 0) || (a.recipe?.id.length ?? 0) - (b.recipe?.id.length ?? 0) || ((a.recipe?.id ?? '') < (b.recipe?.id ?? '') ? -1 : 1));
  waysCache.set(item, out);
  return out;
}

/** Every way to get `item` (craft, smelt, stonecut, mine, mob drop, loot table), best first. */
export function waysToGet(item: string): Need['how'] {
  return internalWays(strip(item)).map((i) => i.way);
}

// ---------------------------------------------------------------------------------------------------------------
// Allocation helpers
// ---------------------------------------------------------------------------------------------------------------

const normalizeHave = (have: Have): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(have)) if (v > 0) out[strip(k)] = (out[strip(k)] ?? 0) + v;
  return out;
};

const heldOf = (slot: Slot, have: Record<string, number>) => slot.options.reduce((n, o) => n + (have[o] ?? 0), 0);

/** Takes up to `need` from the options (most held first) out of `have`; returns the amount that could not be covered. */
function take(have: Record<string, number>, slot: Slot, need: number): number {
  const opts = slot.options.filter((o) => (have[o] ?? 0) > 0).sort((a, b) => have[b] - have[a]);
  let rem = need;
  for (const o of opts) {
    if (rem <= 0) break;
    const t = Math.min(have[o], rem);
    have[o] -= t;
    rem -= t;
  }
  return rem;
}

/** The option to show for a slot: the one held most, else the first listed. */
function repOf(slot: Slot, have: Record<string, number>): string {
  let best = slot.options.find(obtainable) ?? slot.options[0];
  let bestN = have[best] ?? 0;
  for (const o of slot.options) {
    if ((have[o] ?? 0) > bestN) {
      best = o;
      bestN = have[o];
    }
  }
  return best;
}

interface SlotEval {
  slot: Slot;
  need: number;
  held: number;
  deficit: number;
  rep: string;
}
interface Eval {
  times: number;
  slots: SlotEval[];
  deficitTotal: number;
  /** have after reserving every input of this recipe. */
  remaining: Record<string, number>;
}

function evalRecipe(r: Recipe, count: number, have: Record<string, number>): Eval {
  const times = Math.max(1, Math.ceil(count / r.makes));
  const remaining = { ...have };
  const slots: SlotEval[] = r.slots.map((slot) => {
    const need = slot.count * times;
    const held = heldOf(slot, have);
    const rep = repOf(slot, have);
    const deficit = take(remaining, slot, need);
    return { slot, need, held, deficit, rep };
  });
  return { times, slots, deficitTotal: slots.reduce((n, s) => n + s.deficit, 0), remaining };
}

// ---------------------------------------------------------------------------------------------------------------
// Choosing a way for a given inventory
// ---------------------------------------------------------------------------------------------------------------

interface Choice {
  it: Internal;
  ev?: Eval;
  /** craft/smelt/stonecut with every input held. */
  satisfiable: boolean;
  stationHeld: boolean;
}

function choose(item: string, count: number, have: Record<string, number>): Choice | null {
  const ways = internalWays(item);
  if (!ways.length) return null;
  const evaluated: Choice[] = ways.map((it) => {
    if (!it.recipe) return { it, satisfiable: false, stationHeld: true };
    const ev = evalRecipe(it.recipe, count, have);
    const stationHeld = it.recipe.station === 'inventory' || (have[it.recipe.station] ?? 0) > 0;
    return { it, ev, satisfiable: ev.deficitTotal === 0, stationHeld };
  });
  const cost = (c: Choice) => (c.stationHeld ? 0 : c.it.stationCost);
  const held = evaluated.filter((c) => c.satisfiable);
  if (held.length) {
    return [...held].sort((a, b) => cost(a) - cost(b) || a.it.tier - b.it.tier)[0];
  }
  const normal = evaluated.filter((c) => c.it.recipe && c.it.tier < 1);
  if (normal.length) {
    return [...normal].sort((a, b) => a.ev!.deficitTotal - b.ev!.deficitTotal || cost(a) - cost(b))[0];
  }
  return evaluated[0];
}

// ---------------------------------------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------------------------------------

const pretty = (id: string) => id.replace(/_/g, ' ');

function slotLabel(slot: Slot, rep: string): { head: string; alt?: string } {
  if (slot.options.length === 1) return { head: rep };
  if (slot.options.length <= 3) {
    return { head: rep, alt: `also accepted: ${slot.options.filter((o) => o !== rep).join(', ')}` };
  }
  return { head: `of any ${slot.tag ? slot.tag : slot.options.slice(0, 3).join('/') + '/...'}` };
}

const have0 = (n: number) => (n > 0 ? String(n) : '0');

function toolHeld(plan: MineInfo, have: Record<string, number>): string | null {
  for (const t of plan.workingTools) if ((have[t] ?? 0) > 0) return t;
  return null;
}

function mineClause(m: MineInfo, have: Record<string, number>): string {
  const blocks = m.blocks.slice(0, 3).join(' or ') + (m.blocks.length > 3 ? ' ...' : '');
  if (!m.minTool) return `mine ${blocks} (${m.tool ? `any ${m.tool} or by hand` : 'by hand'})`;
  const type = m.tool ?? 'tool';
  const need = m.minTool.startsWith('wooden_') ? `any ${type}` : `${m.minTool} or better`;
  const got = toolHeld(m, have);
  return `mine ${blocks} with ${need}: have ${got ?? 'none'}`;
}

function sourceLabel(table: string): string {
  if (table === 'gameplay/piglin_bartering') return 'bartering with piglins';
  if (table.startsWith('gameplay/')) return table.slice('gameplay/'.length);
  if (table.startsWith('chests/')) return `${table.slice('chests/'.length)} chest`;
  const i = table.indexOf('/');
  return `${table.slice(i + 1)} (${table.slice(0, i)})`;
}

function stationText(station: string): string {
  return station === 'crafting_table' ? 'a crafting table' : `a ${pretty(station)}`;
}

/** One short clause on how to get `count` of `item` given `have`; one level, no recursion into the inputs' own inputs. */
function clause(item: string, count: number, have: Record<string, number>): string {
  const c = choose(item, count, have);
  if (!c) return 'no known way to get it';
  const w = c.it.way;
  if (c.it.recipe && c.ev) {
    const parts = c.ev.slots.map((s) => {
      const l = slotLabel(s.slot, s.rep);
      return { text: `${s.need} ${l.head}`, held: s.held };
    });
    const list = parts.length === 1 ? `${parts[0].text}: have ${have0(parts[0].held)}` : parts.map((p) => `${p.text} (have ${have0(p.held)})`).join(' and ');
    const at = c.it.recipe.station === 'inventory' || c.stationHeld ? '' : ` at ${stationText(c.it.recipe.station)}`;
    if (w.kind === 'smelt') return `smelt in ${stationText(c.it.recipe.station)}${c.stationHeld ? '' : ' (have none)'} from ${list}`;
    if (w.kind === 'stonecut') return `stonecut${c.stationHeld ? '' : ' (stonecutter: have none)'} from ${list}`;
    return `craftable${at} from ${list}`;
  }
  if (w.kind === 'mine' && c.it.mine) return mineClause(c.it.mine, have);
  if (w.kind === 'drop') return `dropped by ${w.entities.slice(0, 3).join(', ')}${w.entities.length > 3 ? ' ...' : ''}`;
  if (w.kind === 'loot') return `found via ${w.tables.slice(0, 3).map(sourceLabel).join(', ')}${w.tables.length > 3 ? ' ...' : ''}`;
  return 'no known way to get it';
}

// ---------------------------------------------------------------------------------------------------------------
// missingFor
// ---------------------------------------------------------------------------------------------------------------

const FUEL_ITEMS = ['coal', 'charcoal', 'coal_block', 'blaze_rod', 'lava_bucket', 'stick', 'dried_kelp_block', 'bamboo'];
let fuelSet: Set<string> | null = null;
function hasFuel(have: Record<string, number>): boolean {
  if (!fuelSet) {
    fuelSet = new Set(FUEL_ITEMS);
    for (const t of ['logs_that_burn', 'planks']) for (const id of resolveTag('item', t)) fuelSet.add(strip(id));
  }
  for (const k of Object.keys(have)) if (have[k] > 0 && fuelSet.has(k)) return true;
  return false;
}
const NEEDS_FUEL = new Set(['furnace', 'blast_furnace', 'smoker']);

function needFor(item: string, count: number, have: Record<string, number>): Need {
  return { item, count, have: have[item] ?? 0, how: waysToGet(item) };
}

/** Is `item` something that can be made right now from `have` (inventory crafting or a held table)? */
function makeableNow(item: string, have: Record<string, number>): boolean {
  for (const r of recipesFor(item)) {
    if (r.kind !== 'craft') continue;
    if (r.station !== 'inventory' && !(have.crafting_table > 0)) continue;
    if (evalRecipe(r, 1, have).deficitTotal === 0) return true;
  }
  return false;
}

interface Analysis {
  inputs: string[];
  station?: string;
  stationClause?: string;
  fuel?: string;
  info?: string;
  needs: Need[];
  stationNeeded?: string;
  ready: boolean;
}

function analyze(item: string, count: number, have: Have): Analysis {
  const inv = normalizeHave(have);
  const c = choose(item, count, inv);
  if (!c) return { inputs: [`${item}: no known way to get it in the game data`], needs: [needFor(item, count, inv)], ready: false };

  const a: Analysis = { inputs: [], needs: [], ready: true };
  if (c.it.recipe && c.ev) {
    const r = c.it.recipe;
    for (const s of c.ev.slots) {
      a.needs.push(needFor(s.rep, s.need, inv));
      if (s.deficit <= 0) continue;
      a.ready = false;
      const l = slotLabel(s.slot, s.rep);
      const extra = [l.alt, clause(s.rep, s.deficit, inv)].filter(Boolean).join('; ');
      a.inputs.push(`${s.deficit} ${l.head} (have ${have0(s.held)}; ${extra})`);
    }
    if (r.station !== 'inventory') {
      a.needs.push(needFor(r.station, 1, inv));
      if (!c.stationHeld) {
        a.stationNeeded = r.station;
        a.station = stationText(r.station);
        a.stationClause = `have none; ${clause(r.station, 1, c.ev.remaining)}`;
        if (!makeableNow(r.station, c.ev.remaining)) a.ready = false;
      }
    }
    if (NEEDS_FUEL.has(r.station) && !hasFuel(inv)) {
      a.ready = false;
      a.fuel = `fuel for the ${pretty(r.station)} (have none; coal, charcoal, planks or logs)`;
    }
    if (!a.inputs.length && !a.station && !a.fuel) {
      a.info = `all inputs for ${item} x${count} are held (${r.kind} in ${r.station === 'inventory' ? 'the inventory grid' : pretty(r.station)})`;
    } else if (!a.inputs.length) {
      a.info = `inputs for ${item} x${count} are held`;
    }
  } else {
    a.needs.push(needFor(item, count, inv));
    a.inputs.push(`${count} ${item} (have ${have0(inv[item] ?? 0)}; ${clause(item, count, inv)})`);
    if (c.it.way.kind === 'mine' && c.it.mine?.minTool && !toolHeld(c.it.mine, inv)) a.ready = false;
  }
  return a;
}

/** Missing requirements for `count` more of `item`, expanded one level deep for each input, using `have`. */
export function missingFor(item: string, count: number, have: Have): { lines: string[]; needs: Need[]; stationNeeded?: string; ready: boolean } {
  item = strip(item);
  const a = analyze(item, count, have);
  const lines = [...a.inputs];
  if (a.station) lines.push(`${a.station} nearby (${a.stationClause})`);
  if (a.fuel) lines.push(a.fuel);
  if (!lines.length && a.info) lines.push(a.info);
  return { lines, needs: a.needs, ...(a.stationNeeded ? { stationNeeded: a.stationNeeded } : {}), ready: a.ready };
}

/** One sentence for the decision brief, e.g. "stone_pickaxe x1 needs: 3 cobblestone (...) and 2 stick (...). A crafting table is needed (...)." */
export function formatMissing(item: string, count: number, have: Have): string {
  item = strip(item);
  const a = analyze(item, count, have);
  const head = `${item} x${count}`;
  let out = a.inputs.length ? `${head} needs: ${a.inputs.join(' and ')}.` : `${head}: ${a.ready ? 'ready, ' : ''}${a.info ?? 'all inputs held'}.`;
  if (a.station) out += ` ${a.station.replace(/^a /, 'A ')} is needed (${a.stationClause}).`;
  if (a.fuel) out += ` ${a.fuel.replace(/^fuel/, 'Fuel')}.`;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// craftableNow
// ---------------------------------------------------------------------------------------------------------------

const BASICS = [
  'crafting_table', 'oak_planks', 'stick', 'torch', 'chest', 'furnace',
  'wooden_pickaxe', 'wooden_axe', 'wooden_sword', 'wooden_shovel', 'wooden_hoe',
  'stone_pickaxe', 'stone_axe', 'stone_sword', 'stone_shovel', 'stone_hoe',
  'iron_pickaxe', 'iron_axe', 'iron_sword', 'iron_shovel', 'iron_hoe',
  'diamond_pickaxe', 'diamond_axe', 'diamond_sword', 'diamond_shovel', 'diamond_hoe',
  'bread', 'bucket', 'shield', 'iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots',
  'bow', 'arrow', 'boat', 'bed', 'white_bed', 'ladder', 'door', 'oak_door', 'oak_boat', 'oak_fence',
];
const CATEGORY_RANK: Record<string, number> = { equipment: 0, food: 1, misc: 2, building: 3, redstone: 4 };

/** Items the goal needs, following the best normal way down a few levels (inputs, their inputs, stations). */
function goalChain(goal: string): Set<string> {
  const seen = new Set<string>();
  let frontier = [strip(goal)];
  for (let depth = 0; depth < 4 && frontier.length; depth++) {
    const next: string[] = [];
    for (const item of frontier) {
      const ways = internalWays(item).filter((w) => w.recipe && w.tier < 1);
      const best = ways[0];
      if (!best?.recipe) continue;
      if (best.recipe.station !== 'inventory' && !seen.has(best.recipe.station)) {
        seen.add(best.recipe.station);
        next.push(best.recipe.station);
      }
      for (const s of best.recipe.slots) for (const o of s.options) if (!seen.has(o)) {
        seen.add(o);
        next.push(o);
      }
    }
    frontier = next;
  }
  return seen;
}

/** Every item craftable right now from `have` alone (2x2 grid unless hasTable), with how many. Capped at 40, goal inputs first. */
export function craftableNow(have: Have, opts: { hasTable?: boolean; goal?: string } = {}): { item: string; times: number; makes: number }[] {
  buildRecipes();
  const inv = normalizeHave(have);
  const hasTable = opts.hasTable ?? false;
  const best = new Map<string, { item: string; times: number; makes: number; category: string }>();
  for (const r of recipeList!) {
    if (r.kind !== 'craft') continue;
    if (r.station === 'crafting_table' && !hasTable) continue;
    let times = Infinity;
    for (const s of r.slots) times = Math.min(times, Math.floor(heldOf(s, inv) / s.count));
    if (!Number.isFinite(times) || times < 1) continue;
    while (times >= 1 && evalRecipe({ ...r, makes: 1 }, times, inv).deficitTotal > 0) times--;
    if (times < 1) continue;
    const prev = best.get(r.result);
    if (!prev || times * r.makes > prev.times * prev.makes) best.set(r.result, { item: r.result, times, makes: r.makes, category: r.category });
  }
  const chain = opts.goal ? goalChain(opts.goal) : new Set<string>();
  const rank = (e: { item: string; category: string }) => {
    if (chain.has(e.item)) return 0;
    const b = BASICS.indexOf(e.item);
    if (b >= 0) return 1 + b / 100;
    return 2 + (CATEGORY_RANK[e.category] ?? 5);
  };
  return [...best.values()]
    .sort((a, b) => rank(a) - rank(b) || b.times * b.makes - a.times * a.makes || (a.item < b.item ? -1 : 1))
    .slice(0, 40)
    .map(({ item, times, makes }) => ({ item, times, makes }));
}
