import { shortId } from './files.js';

/**
 * What a task must achieve, stated in terms the server can confirm.
 * Every field is optional; all given fields must hold.
 */
export interface TaskExpectations {
  /** Bot's item counts (inventory + equipment), e.g. { stone_pickaxe: ">=1" }. */
  inventory?: Record<string, string>;
  /** Advancements the bot must have, e.g. ["story/upgrade_tools"]. */
  advancements?: string[];
  /** Stat increases during the run, e.g. { "crafted:stone_pickaxe": ">=1" }. */
  stats?: Record<string, string>;
  /** Dimension the bot must end in, e.g. "minecraft:the_nether". */
  dimension?: string;
  /** Most deaths allowed during the run (default: unlimited). */
  maxDeaths?: number;
  /** Blocks that must be in place: id, id with states ("oak_stairs[facing=north]"), or a tag ("#minecraft:logs"). */
  blocks?: Array<{ x: number; y: number; z: number; block: string }>;
  /** Boxes (inclusive corners) where every block (mode "all", default) or no block (mode "none") matches `block`. */
  regions?: Array<{ from: [number, number, number]; to: [number, number, number]; block: string; mode?: 'all' | 'none' }>;
  /** Container blocks that must hold these item counts, e.g. { x, y, z, items: { iron_ingot: ">=20" } }. */
  containers?: Array<{ x: number; y: number; z: number; items: Record<string, string> }>;
  /** The bot must end within `range` blocks of this point (read from the server's position data). */
  near?: { x: number; y: number; z: number; range: number };
  /** The owner's item counts (inventory + equipment) read from the server, e.g. { oak_log: ">=5" }. Needs a task owner. */
  ownerInventory?: Record<string, string>;
  /**
   * The bot must have been within `range` blocks of the owner in at least `minFraction` (default 0.8) of the polls
   * made during the measured window. With `lastSeconds`, only the polls of the final that-many seconds count.
   */
  nearOwner?: { range: number; minFraction?: number; lastSeconds?: number };
  /**
   * Most damage the owner may take during the measured window, in hit points (2 = one heart). Read from the owner's
   * `minecraft:custom` `minecraft:damage_taken` stat, which the server counts in tenths of a hit point (a zombie
   * hit of 3 hp adds 30), so the raw value is divided by 10 here. Needs a task owner.
   */
  ownerDamageTakenMax?: number;
}

/** One poll's distance between the bot and the owner (null when either was offline or had no position). */
export interface OwnerDistanceSample {
  /** Epoch ms of the poll. */
  t: number;
  d: number | null;
}

/** Results of the world checks, gathered by the session from RCON. */
export interface WorldEvidence {
  blocks: boolean[];
  regions: Array<{ matching: number; volume: number }>;
  /** null when there is no container at that spot. */
  containers: Array<Record<string, number> | null>;
}

export interface Evidence {
  items: Record<string, number>;
  advancements: Set<string>;
  statDeltas: Record<string, number>;
  dimension?: string;
  deaths: number;
  world?: WorldEvidence;
  pos?: [number, number, number];
  /** The owner's server-side item counts, when an owner is in the run and online. */
  ownerItems?: Record<string, number>;
  /** Bot-to-owner distances from every poll of the measured window. */
  ownerDistances?: OwnerDistanceSample[];
  /** Damage the owner took during the measured window, in hit points (the stat's raw value / 10). */
  ownerDamageTaken?: number;
}

export interface CheckResult {
  check: string;
  expected: string;
  actual: string;
  ok: boolean;
  source: string;
}

export interface Comparison {
  op: '>=' | '<=' | '==' | '>' | '<';
  value: number;
}

export function parseComparison(text: string): Comparison {
  const match = String(text).trim().match(/^(>=|<=|==|=|>|<)?\s*(-?\d+)$/);
  if (!match) throw new Error(`Invalid comparison "${text}" (use e.g. ">=3", "==1", "5")`);
  const op = (match[1] === '=' ? '==' : match[1] ?? '>=') as Comparison['op'];
  return { op, value: parseInt(match[2], 10) };
}

export function compare(actual: number, c: Comparison): boolean {
  switch (c.op) {
    case '>=':
      return actual >= c.value;
    case '<=':
      return actual <= c.value;
    case '==':
      return actual === c.value;
    case '>':
      return actual > c.value;
    case '<':
      return actual < c.value;
  }
}

/** Throws if the expectations are malformed, so a bad task file fails before the run starts. */
export function validateExpectations(expect: TaskExpectations): void {
  for (const value of Object.values(expect.inventory ?? {})) parseComparison(value);
  for (const [key, value] of Object.entries(expect.stats ?? {})) {
    if (!/^[a-z_]+:[a-z0-9_./]+$/.test(key)) throw new Error(`Invalid stat key "${key}" (use e.g. "crafted:stone_pickaxe")`);
    parseComparison(value);
  }
  for (const value of Object.values(expect.ownerInventory ?? {})) parseComparison(value);
  if (expect.nearOwner) {
    const n = expect.nearOwner;
    if (typeof n.range !== 'number' || !(n.range > 0)) throw new Error(`nearOwner.range must be a positive number, got ${JSON.stringify(n.range)}`);
    if (n.minFraction !== undefined && !(typeof n.minFraction === 'number' && n.minFraction >= 0 && n.minFraction <= 1)) throw new Error('nearOwner.minFraction must be between 0 and 1');
    if (n.lastSeconds !== undefined && !(typeof n.lastSeconds === 'number' && n.lastSeconds > 0)) throw new Error('nearOwner.lastSeconds must be a positive number');
  }
  if (expect.ownerDamageTakenMax !== undefined && !(typeof expect.ownerDamageTakenMax === 'number' && expect.ownerDamageTakenMax >= 0)) {
    throw new Error(`ownerDamageTakenMax must be a number of hit points >= 0, got ${JSON.stringify(expect.ownerDamageTakenMax)}`);
  }
  const isNum = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
  for (const b of expect.blocks ?? []) {
    if (![b.x, b.y, b.z].every(isNum) || typeof b.block !== 'string' || !b.block) throw new Error(`Invalid block expectation ${JSON.stringify(b)}`);
  }
  for (const r of expect.regions ?? []) {
    if (!Array.isArray(r.from) || !Array.isArray(r.to) || ![...r.from, ...r.to].every(isNum) || typeof r.block !== 'string') {
      throw new Error(`Invalid region expectation ${JSON.stringify(r)}`);
    }
    if (r.mode && r.mode !== 'all' && r.mode !== 'none') throw new Error(`Region mode must be "all" or "none", got "${r.mode}"`);
  }
  for (const c of expect.containers ?? []) {
    if (![c.x, c.y, c.z].every(isNum) || !c.items || typeof c.items !== 'object') throw new Error(`Invalid container expectation ${JSON.stringify(c)}`);
    for (const v of Object.values(c.items)) parseComparison(v);
  }
}

export function hasWorldExpectations(expect: TaskExpectations | undefined): boolean {
  return Boolean(expect && ((expect.blocks ?? []).length || (expect.regions ?? []).length || (expect.containers ?? []).length));
}

export function hasExpectations(expect: TaskExpectations | undefined): boolean {
  if (!expect) return false;
  return Boolean(
    Object.keys(expect.inventory ?? {}).length ||
      (expect.advancements ?? []).length ||
      Object.keys(expect.stats ?? {}).length ||
      expect.dimension ||
      expect.near ||
      Object.keys(expect.ownerInventory ?? {}).length ||
      expect.nearOwner ||
      expect.ownerDamageTakenMax !== undefined ||
      hasWorldExpectations(expect)
  );
}

export function evaluateExpectations(expect: TaskExpectations, evidence: Evidence, sources: { stats: string; advancements: string }): CheckResult[] {
  const results: CheckResult[] = [];
  for (const [item, expr] of Object.entries(expect.inventory ?? {})) {
    const id = shortId(item);
    const actual = evidence.items[id] ?? 0;
    results.push({ check: `inventory ${id}`, expected: expr, actual: String(actual), ok: compare(actual, parseComparison(expr)), source: 'RCON data get entity' });
  }
  for (const adv of expect.advancements ?? []) {
    const id = shortId(adv);
    const ok = evidence.advancements.has(id);
    results.push({ check: `advancement ${id}`, expected: 'done', actual: ok ? 'done' : 'not done', ok, source: sources.advancements });
  }
  for (const [key, expr] of Object.entries(expect.stats ?? {})) {
    const actual = evidence.statDeltas[key] ?? 0;
    results.push({ check: `stat ${key} (increase)`, expected: expr, actual: String(actual), ok: compare(actual, parseComparison(expr)), source: sources.stats });
  }
  if (expect.dimension) {
    const want = expect.dimension.includes(':') ? expect.dimension : `minecraft:${expect.dimension}`;
    results.push({ check: 'dimension', expected: want, actual: evidence.dimension ?? 'unknown', ok: evidence.dimension === want, source: 'RCON data get entity' });
  }
  const world = evidence.world;
  (expect.blocks ?? []).forEach((b, i) => {
    const ok = world?.blocks[i];
    results.push({
      check: `block ${b.block} at ${b.x} ${b.y} ${b.z}`,
      expected: 'present',
      actual: ok === undefined ? 'not checked' : ok ? 'present' : 'absent',
      ok: ok === true,
      source: 'RCON execute if block',
    });
  });
  (expect.regions ?? []).forEach((r, i) => {
    const res = world?.regions[i];
    const mode = r.mode ?? 'all';
    const ok = res !== undefined && (mode === 'all' ? res.matching === res.volume : res.matching === 0);
    results.push({
      check: `region ${r.from.join(' ')} to ${r.to.join(' ')}: ${mode === 'all' ? 'all' : 'no'} ${r.block}`,
      expected: mode === 'all' ? `${res?.volume ?? '?'} of ${res?.volume ?? '?'}` : `0 of ${res?.volume ?? '?'}`,
      actual: res === undefined ? 'not checked' : `${res.matching} of ${res.volume}`,
      ok,
      source: 'RCON execute if block',
    });
  });
  (expect.containers ?? []).forEach((c, i) => {
    const items = world?.containers[i];
    for (const [item, expr] of Object.entries(c.items)) {
      const id = shortId(item);
      const actual = items ? items[id] ?? 0 : null;
      results.push({
        check: `container at ${c.x} ${c.y} ${c.z}: ${id}`,
        expected: expr,
        actual: actual === null ? (items === undefined ? 'not checked' : 'no container') : String(actual),
        ok: actual !== null && compare(actual, parseComparison(expr)),
        source: 'RCON data get block',
      });
    }
  });
  if (expect.near) {
    const n = expect.near;
    const p = evidence.pos;
    const d = p ? Math.hypot(p[0] - (n.x + 0.5), p[1] - n.y, p[2] - (n.z + 0.5)) : null;
    results.push({
      check: `bot within ${n.range} of ${n.x} ${n.y} ${n.z}`,
      expected: `<=${n.range}`,
      actual: d === null ? 'unknown' : d.toFixed(1),
      ok: d !== null && d <= n.range,
      source: 'RCON data get entity Pos',
    });
  }
  for (const [item, expr] of Object.entries(expect.ownerInventory ?? {})) {
    const id = shortId(item);
    const known = evidence.ownerItems !== undefined;
    const actual = evidence.ownerItems?.[id] ?? 0;
    results.push({ check: `owner inventory ${id}`, expected: expr, actual: known ? String(actual) : 'unknown', ok: known && compare(actual, parseComparison(expr)), source: 'RCON data get entity (owner)' });
  }
  if (expect.nearOwner) {
    const n = expect.nearOwner;
    const minFraction = n.minFraction ?? 0.8;
    let samples = evidence.ownerDistances ?? [];
    if (n.lastSeconds !== undefined && samples.length) {
      const tEnd = samples[samples.length - 1].t;
      samples = samples.filter((s) => s.t >= tEnd - n.lastSeconds! * 1000);
    }
    const within = samples.filter((s) => s.d !== null && s.d <= n.range).length;
    const fraction = samples.length ? within / samples.length : 0;
    const worst = samples.reduce((m, s) => (s.d === null ? m : Math.max(m, s.d)), 0);
    results.push({
      check: `bot within ${n.range} of the owner${n.lastSeconds !== undefined ? ` (last ${n.lastSeconds} s)` : ''}`,
      expected: `>=${Math.round(minFraction * 100)}% of polls`,
      actual: samples.length ? `${Math.round(fraction * 100)}% of ${samples.length} polls (farthest ${worst.toFixed(1)})` : 'no polls',
      ok: samples.length > 0 && fraction >= minFraction,
      source: 'RCON data get entity Pos, both players, every poll',
    });
  }
  if (expect.ownerDamageTakenMax !== undefined) {
    const known = evidence.ownerDamageTaken !== undefined;
    results.push({
      check: 'owner damage taken (hit points)',
      expected: `<=${expect.ownerDamageTakenMax}`,
      actual: known ? String(evidence.ownerDamageTaken) : 'unknown',
      ok: known && evidence.ownerDamageTaken! <= expect.ownerDamageTakenMax,
      source: 'owner damage_taken stat / 10',
    });
  }
  if (expect.maxDeaths !== undefined) {
    results.push({ check: 'deaths', expected: `<=${expect.maxDeaths}`, actual: String(evidence.deaths), ok: evidence.deaths <= expect.maxDeaths, source: 'bot_oracle death events' });
  }
  return results;
}
