import fs from 'fs';
import path from 'path';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { dataDir } from '../utils/paths.js';

/**
 * Places memory (ROADMAP.md Phase 3): what the bot knows about where things are.
 *
 *  - named places: "base", "the furnace" (set by the owner or the LLM through remember_place),
 *  - resources it has seen: block kind -> a few known positions with when they were seen,
 *  - structures it has seen: a village is recognised by its bell and job blocks.
 *
 * The store is plain data (JSON on disk, bounded per kind) and has no game dependency, so it is unit tested
 * without a server. `startPlacesScan` feeds it cheaply from the loaded chunks around the bot.
 */

export interface Vec {
  x: number;
  y: number;
  z: number;
}

export interface Sighting extends Vec {
  /** The block that was seen (oak_log, diamond_ore, bell...). */
  block: string;
  /** Epoch ms of the last time it was seen. */
  t: number;
}

export interface NamedPlace extends Vec {
  t: number;
}

export interface PlacesData {
  version: 1;
  named: Record<string, NamedPlace>;
  resources: Record<string, Sighting[]>;
  structures: Record<string, Sighting[]>;
}

export interface PlacesOptions {
  /** Most sightings kept per kind. */
  maxPerKind?: number;
  /** Sightings of one kind closer than this are the same place; the newer one replaces the older. */
  mergeRadius?: number;
  now?: () => number;
}

const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const floor = (p: Vec): Vec => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });

/** "The Furnace", "the_furnace" and "furnace" are the same name. */
export function normalizeName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '_')
    .replace(/^(the|my)_/, '');
}

/** Ores and a few others have a deepslate form that counts as the same kind. */
export function kindOf(blockName: string): string {
  return blockName.replace(/^deepslate_(?=.*_ore$)/, '');
}

export class PlacesMemory {
  data: PlacesData = { version: 1, named: {}, resources: {}, structures: {} };
  private readonly maxPerKind: number;
  private readonly mergeRadius: number;
  private readonly now: () => number;
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(readonly file?: string, opts: PlacesOptions = {}) {
    this.maxPerKind = opts.maxPerKind ?? 8;
    this.mergeRadius = opts.mergeRadius ?? 8;
    this.now = opts.now ?? Date.now;
    if (file) this.load();
  }

  // ----- named places -------------------------------------------------------------------------------------

  setNamed(name: string, pos: Vec): { replaced?: NamedPlace } {
    const key = normalizeName(name);
    const replaced = this.data.named[key];
    this.data.named[key] = { ...floor(pos), t: this.now() };
    this.changed();
    return { replaced };
  }

  getNamed(name: string): (NamedPlace & { name: string }) | null {
    const key = normalizeName(name);
    const p = this.data.named[key];
    return p ? { ...p, name: key } : null;
  }

  listNamed(): Array<NamedPlace & { name: string }> {
    return Object.entries(this.data.named).map(([name, p]) => ({ name, ...p }));
  }

  // ----- resources and structures -------------------------------------------------------------------------

  /** Records a sighting. Returns true if it was new (not merged into one already known). */
  see(kind: string, pos: Vec, block = kind, structure = false): boolean {
    const store = structure ? this.data.structures : this.data.resources;
    const list = (store[kind] ??= []);
    const p = floor(pos);
    const t = this.now();
    const same = list.findIndex((s) => dist(s, p) < this.mergeRadius);
    if (same >= 0) {
      // Keep the place the bot has actually seen most recently.
      list[same] = { ...p, block, t };
      this.changed();
      return false;
    }
    list.push({ ...p, block, t });
    if (list.length > this.maxPerKind) {
      // Drop the stalest sighting.
      let oldest = 0;
      for (let i = 1; i < list.length; i++) if (list[i].t < list[oldest].t) oldest = i;
      list.splice(oldest, 1);
    }
    this.changed();
    return true;
  }

  /** Known positions of a kind, nearest to `from` first (or most recent first without `from`). */
  known(kind: string, from?: Vec, structure = false): Sighting[] {
    const list = (structure ? this.data.structures : this.data.resources)[kind] ?? [];
    return [...list].sort((a, b) => (from ? dist(a, from) - dist(b, from) : b.t - a.t));
  }

  nearest(kind: string, from: Vec, structure = false): Sighting | null {
    return this.known(kind, from, structure)[0] ?? null;
  }

  forget(kind: string, pos: Vec, structure = false): void {
    const store = structure ? this.data.structures : this.data.resources;
    const list = store[kind];
    if (!list) return;
    const p = floor(pos);
    store[kind] = list.filter((s) => !(s.x === p.x && s.y === p.y && s.z === p.z));
    if (!store[kind].length) delete store[kind];
    this.changed();
  }

  kinds(structure = false): string[] {
    return Object.keys(structure ? this.data.structures : this.data.resources);
  }

  /**
   * At most `maxLines` short lines for the decision brief: named places first, then the nearest remembered
   * sighting of each kind. A kind with a sighting within `skipWithin` of `from` is left out (the NEARBY section
   * already shows it). `groupOf` merges kinds that read as one thing (every log species -> "logs").
   */
  summary(from: Vec, maxLines = 6, skipWithin = 32, groupOf: (kind: string) => string = (k) => k): string[] {
    const lines: string[] = [];
    const named = this.listNamed().sort((a, b) => dist(a, from) - dist(b, from));
    for (const p of named) lines.push(`${p.name}: ${p.x} ${p.y} ${p.z} (${Math.round(dist(p, from))} blocks away, named)`);
    const groups = new Map<string, Sighting & { structure: boolean }>();
    const consider = (kind: string, structure: boolean) => {
      for (const s of this.known(kind, from, structure)) {
        const g = groupOf(kind);
        const key = `${structure ? 's:' : 'r:'}${g}`;
        const best = groups.get(key);
        if (!best || dist(s, from) < dist(best, from)) groups.set(key, { ...s, structure, block: g });
      }
    };
    for (const k of this.kinds(false)) consider(k, false);
    for (const k of this.kinds(true)) consider(k, true);
    // A group is hidden when a sighting of it lies within skipWithin, even if its nearest is another kind.
    const items = [...groups.values()]
      .filter((g) => dist(g, from) > skipWithin)
      .sort((a, b) => Number(b.structure) - Number(a.structure) || RARITY(a.block) - RARITY(b.block) || dist(a, from) - dist(b, from));
    for (const g of items) lines.push(`${g.block}${g.structure ? ' (structure)' : ''}: ${g.x} ${g.y} ${g.z} (${Math.round(dist(g, from))} blocks away)`);
    return lines.slice(0, maxLines);
  }

  // ----- persistence --------------------------------------------------------------------------------------

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file!, 'utf8'));
      if (raw && raw.version === 1) {
        this.data = { version: 1, named: raw.named ?? {}, resources: raw.resources ?? {}, structures: raw.structures ?? {} };
      }
    } catch {
      // No file yet, or it is damaged: start empty rather than refuse to run.
    }
  }

  /** Writes the file now (a no-op without a file). */
  save(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.file || !this.dirty) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
      this.dirty = false;
    } catch {
      // A full disk must not stop the bot.
    }
  }

  private changed(): void {
    this.dirty = true;
    if (this.file && !this.timer) {
      this.timer = setTimeout(() => this.save(), 2000);
      this.timer.unref?.();
    }
  }
}

/** Lower is shown first in the brief: what is hard to find before what is everywhere. */
function RARITY(kind: string): number {
  if (/diamond|emerald|ancient|debris/.test(kind)) return 0;
  if (/_ore$/.test(kind)) return 1;
  if (kind === 'village') return 0;
  if (kind === 'sand' || kind === 'water' || kind === 'lava') return 3;
  if (kind === 'logs') return 4;
  return 5;
}

/** Where the bot's memory file for one world or server lives. `key` is a seed or "host-port". */
export function placesFileFor(key: string): string {
  return dataDir('places', `${key.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 60) || 'default'}.json`);
}

// ---------------------------------------------------------------------------------------------------------
// The active store: skills and the brief read it from here, the harness (or main) sets it.
// ---------------------------------------------------------------------------------------------------------

let active: PlacesMemory | null = null;
let fallback: PlacesMemory | null = null;

export function setActivePlaces(p: PlacesMemory | null): void {
  active = p;
}

/** The store in use. With none set (a unit test, a bare script) an in-memory one stands in. */
export function getPlaces(): PlacesMemory {
  if (active) return active;
  return (fallback ??= new PlacesMemory());
}

export function hasActivePlaces(): boolean {
  return active !== null;
}

// ---------------------------------------------------------------------------------------------------------
// Background scan of the loaded chunks.
// ---------------------------------------------------------------------------------------------------------

export const VILLAGE_BLOCKS = ['bell', 'lectern', 'composter', 'loom', 'cartography_table', 'fletching_table', 'grindstone', 'smithing_table', 'stonecutter', 'brewing_stand'];
const ORES = ['coal', 'iron', 'copper', 'gold', 'redstone', 'lapis', 'diamond', 'emerald'];

interface ScanGroup {
  label: string;
  /** Matches block names (as registered, without namespace). */
  match: (name: string) => boolean;
  count: number;
  /** Looks no farther than this (cheap for common blocks). */
  radius?: number;
  structure?: string;
}

const isLogName = (n: string) => /_(log|stem)$/.test(n) && !n.startsWith('stripped_');

export const SCAN_GROUPS: ScanGroup[] = [
  { label: 'logs', match: isLogName, count: 24 },
  { label: 'stone', match: (n) => n === 'stone', count: 2 },
  ...ORES.map((o): ScanGroup => ({ label: `${o}_ore`, match: (n) => n === `${o}_ore` || n === `deepslate_${o}_ore`, count: 4 })),
  { label: 'sand', match: (n) => n === 'sand' || n === 'red_sand', count: 6 },
  { label: 'water', match: (n) => n === 'water', count: 4 },
  { label: 'lava', match: (n) => n === 'lava', count: 4 },
  { label: 'crafting_table', match: (n) => n === 'crafting_table', count: 2 },
  { label: 'furnace', match: (n) => n === 'furnace' || n === 'blast_furnace' || n === 'smoker', count: 2 },
  { label: 'chest', match: (n) => n === 'chest' || n === 'barrel' || n === 'trapped_chest', count: 2 },
  { label: 'village', match: (n) => VILLAGE_BLOCKS.includes(n), count: 8, structure: 'village' },
];

const idCache = new WeakMap<object, number[][]>();

function groupIds(bot: Bot): number[][] {
  const reg: any = bot.registry;
  let ids = idCache.get(reg);
  if (!ids) {
    const all = Object.values(reg.blocksByName as Record<string, any>);
    ids = SCAN_GROUPS.map((g) => all.filter((b) => g.match(b.name)).map((b) => b.id));
    idCache.set(reg, ids);
  }
  return ids;
}

const isOverworld = (bot: Bot) => /overworld/.test(String((bot as any).game?.dimension ?? 'overworld'));

/** Longest stretch of scanning work done without handing control back to the event loop, in ms (for the report). */
export const scanStats = { maxSliceMs: 0, passes: 0, maxPassMs: 0 };

/** Work is handed back to the event loop after this many ms, so the reflex clock never waits on a scan. */
const SLICE_MS = 3;
const yieldLoop = () => new Promise<void>((r) => setImmediate(r));

const stateCache = new WeakMap<object, Map<string, Set<number>>>();

/** Every block state id of the named blocks. */
export function stateIdsFor(bot: Bot, names: string[]): Set<number> {
  const reg: any = bot.registry;
  let byKey = stateCache.get(reg);
  if (!byKey) stateCache.set(reg, (byKey = new Map()));
  const key = names.join(',');
  let set = byKey.get(key);
  if (!set) {
    set = new Set();
    for (const n of names) {
      const b = reg.blocksByName[n];
      if (!b) continue;
      for (let id = b.minStateId; id <= b.maxStateId; id++) set.add(id);
    }
    byKey.set(key, set);
  }
  return set;
}

/**
 * Like bot.findBlocks (nearest `count` blocks whose state is in `states` within `radius`), but made of small
 * steps: it reads the chunk sections' palettes directly, scans one section at a time, and awaits setImmediate
 * whenever SLICE_MS have passed, so it never holds the event loop for more than a section's worth of work.
 */
export async function findBlocksAsync(bot: Bot, states: Set<number>, radius: number, count: number): Promise<Vec3[]> {
  const t0 = performance.now();
  const me = bot.entity.position;
  const minY = (bot.game as any).minY ?? -64;
  const height = (bot.game as any).height ?? 384;
  const cx0 = Math.floor(me.x / 16);
  const cz0 = Math.floor(me.z / 16);
  const rc = Math.ceil(radius / 16) + 1;
  const cells: Array<{ cx: number; cz: number; sy: number; d: number }> = [];
  const sections = height >> 4;
  for (let dx = -rc; dx <= rc; dx++) {
    for (let dz = -rc; dz <= rc; dz++) {
      for (let sy = 0; sy < sections; sy++) {
        const cx = cx0 + dx;
        const cz = cz0 + dz;
        const d = Math.hypot(cx * 16 + 8 - me.x, sy * 16 + minY + 8 - me.y, cz * 16 + 8 - me.z);
        if (d <= radius + 14) cells.push({ cx, cz, sy, d });
      }
    }
  }
  cells.sort((a, b) => a.d - b.d);
  const hits: Vec3[] = [];
  let sliceStart = performance.now();
  const endSlice = () => {
    const ms = performance.now() - sliceStart;
    if (ms > scanStats.maxSliceMs) scanStats.maxSliceMs = ms;
  };
  for (const c of cells) {
    // Sections come nearest first: once enough hits are in and the next section cannot hold a nearer one, stop.
    if (hits.length >= count && c.d - 14 > hits[count - 1].distanceTo(me)) break;
    const column: any = bot.world.getColumn(c.cx, c.cz);
    const section = column?.sections?.[c.sy];
    if (section) {
      let possible = true;
      if (section.palette) {
        possible = false;
        for (const id of section.palette) if (states.has(id)) { possible = true; break; }
      }
      if (possible) {
        const y0 = c.sy * 16 + minY;
        const v = new Vec3(0, 0, 0);
        for (let x = 0; x < 16; x++) {
          for (let y = 0; y < 16; y++) {
            for (let z = 0; z < 16; z++) {
              v.set(x, y0 + y, z);
              if (states.has(column.getBlockStateId(v))) {
                const p = new Vec3(c.cx * 16 + x, y0 + y, c.cz * 16 + z);
                if (p.distanceTo(me) <= radius) {
                  hits.push(p);
                  hits.sort((a, b) => a.distanceTo(me) - b.distanceTo(me));
                  if (hits.length > count * 2) hits.length = count * 2;
                }
              }
            }
          }
        }
      }
    }
    if (performance.now() - sliceStart > SLICE_MS) {
      endSlice();
      await yieldLoop();
      sliceStart = performance.now();
    }
  }
  endSlice();
  const total = performance.now() - t0;
  scanStats.passes++;
  if (total > scanStats.maxPassMs) scanStats.maxPassMs = total;
  return hits.slice(0, count);
}

/** Looks for one group of blocks around the bot and records what it finds. Returns how many were seen. */
export async function scanGroup(bot: Bot, memory: PlacesMemory, index: number, radius = 64): Promise<number> {
  const g = SCAN_GROUPS[index];
  const ids = groupIds(bot)[index];
  if (!g || !ids.length) return 0;
  const names = Object.values((bot.registry as any).blocksByName as Record<string, any>).filter((b) => g.match(b.name)).map((b) => b.name as string);
  const found = await findBlocksAsync(bot, stateIdsFor(bot, names), Math.min(radius, g.radius ?? radius), g.count);
  let seen = 0;
  for (const p of found) {
    const name = bot.blockAt(p, false)?.name;
    if (!name) continue;
    if (g.structure) memory.see(g.structure, p, name, true);
    else memory.see(kindOf(name), p, name);
    seen++;
  }
  return seen;
}

/** Forgets remembered places whose chunk is loaded and no longer holds the block. */
export function pruneStale(bot: Bot, memory: PlacesMemory): number {
  let forgotten = 0;
  const check = (store: Record<string, Sighting[]>, structure: boolean) => {
    for (const [kind, list] of Object.entries(store)) {
      for (const s of [...list]) {
        const at = bot.blockAt(new Vec3(s.x, s.y, s.z), false);
        // blockAt is null for an unloaded chunk: nothing is learned then.
        if (at && at.name !== s.block && !(structure && VILLAGE_BLOCKS.includes(at.name))) {
          memory.forget(kind, s, structure);
          forgotten++;
        }
      }
    }
  };
  check(memory.data.resources, false);
  check(memory.data.structures, true);
  return forgotten;
}

/** One full pass over every group (used when a skill wants fresh data now). */
export async function scanPlacesNow(bot: Bot, memory: PlacesMemory, radius = 64): Promise<{ seen: number; forgotten: number }> {
  if (!bot.entity || !isOverworld(bot)) return { seen: 0, forgotten: 0 };
  let seen = 0;
  for (let i = 0; i < SCAN_GROUPS.length; i++) seen += await scanGroup(bot, memory, i, radius);
  return { seen, forgotten: pruneStale(bot, memory) };
}

/**
 * Background scan: one group of blocks every `intervalMs` (default 600 ms), so no single call holds the event
 * loop long, and a prune of stale entries after each full round. Returns a stop function that saves the file.
 */
export function startPlacesScan(bot: Bot, memory: PlacesMemory, opts: { intervalMs?: number; radius?: number; log?: (l: string) => void } = {}): () => void {
  let stopped = false;
  let busy = false;
  let next = 0;
  const timer = setInterval(async () => {
    if (stopped || busy || !bot.entity || !isOverworld(bot)) return;
    busy = true; // passes never overlap
    const i = next;
    next = (next + 1) % SCAN_GROUPS.length;
    try {
      await scanGroup(bot, memory, i, opts.radius ?? 64);
      if (next === 0) pruneStale(bot, memory);
    } catch (err) {
      opts.log?.(`[places] scan failed: ${(err as Error).message}`);
    } finally {
      busy = false;
    }
  }, opts.intervalMs ?? 600);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
    memory.save();
    opts.log?.(`[places] scan stats: ${scanStats.passes} passes, longest uninterrupted slice ${scanStats.maxSliceMs.toFixed(1)} ms, longest whole pass ${scanStats.maxPassMs.toFixed(0)} ms`);
  };
}
