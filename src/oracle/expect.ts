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
}

export interface Evidence {
  items: Record<string, number>;
  advancements: Set<string>;
  statDeltas: Record<string, number>;
  dimension?: string;
  deaths: number;
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
}

export function hasExpectations(expect: TaskExpectations | undefined): boolean {
  if (!expect) return false;
  return Boolean(
    Object.keys(expect.inventory ?? {}).length ||
      (expect.advancements ?? []).length ||
      Object.keys(expect.stats ?? {}).length ||
      expect.dimension
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
  if (expect.maxDeaths !== undefined) {
    results.push({ check: 'deaths', expected: `<=${expect.maxDeaths}`, actual: String(evidence.deaths), ok: evidence.deaths <= expect.maxDeaths, source: 'bot_oracle death events' });
  }
  return results;
}
