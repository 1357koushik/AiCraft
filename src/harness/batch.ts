import type { Verdict, VerdictStatus } from '../oracle/session.js';

export interface BatchRunResult {
  runId: string;
  seed: string | undefined;
  verdict: Verdict;
}

export interface BatchCounts {
  runs: number;
  PASS: number;
  FAIL: number;
  ASSISTED: number;
  ERROR: number;
  UNVERIFIED: number;
  /** PASS / runs. ASSISTED does not count as a pass. 0 when there are no runs. */
  passRate: number;
  /** Median durationSec over PASS runs only; null when there are none. */
  medianPassDurationSec: number | null;
  totalDeaths: number;
}

export interface SeedSummary extends BatchCounts {
  /** Seed as given; "random" when the run had no explicit seed. */
  seed: string;
}

export interface BatchSummary {
  perSeed: SeedSummary[];
  overall: BatchCounts;
  runs: Array<{ runId: string; seed: string; status: VerdictStatus }>;
}

const RANDOM_SEED = 'random';

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function count(results: BatchRunResult[]): BatchCounts {
  const counts: BatchCounts = {
    runs: results.length,
    PASS: 0,
    FAIL: 0,
    ASSISTED: 0,
    ERROR: 0,
    UNVERIFIED: 0,
    passRate: 0,
    medianPassDurationSec: null,
    totalDeaths: 0,
  };
  const passDurations: number[] = [];
  for (const { verdict } of results) {
    counts[verdict.status] += 1;
    counts.totalDeaths += verdict.deaths;
    if (verdict.status === 'PASS') passDurations.push(verdict.durationSec);
  }
  counts.passRate = counts.runs > 0 ? counts.PASS / counts.runs : 0;
  counts.medianPassDurationSec = median(passDurations);
  return counts;
}

/** Per-seed and overall counts for a batch of runs. Seeds keep the order in which they first appear. */
export function summarizeBatch(results: BatchRunResult[]): BatchSummary {
  const bySeed = new Map<string, BatchRunResult[]>();
  for (const result of results) {
    const seed = result.seed ?? RANDOM_SEED;
    const group = bySeed.get(seed);
    if (group) group.push(result);
    else bySeed.set(seed, [result]);
  }
  return {
    perSeed: [...bySeed.entries()].map(([seed, group]) => ({ seed, ...count(group) })),
    overall: count(results),
    runs: results.map((r) => ({ runId: r.runId, seed: r.seed ?? RANDOM_SEED, status: r.verdict.status })),
  };
}

function percent(rate: number): string {
  return `${(rate * 100).toFixed(0)}%`;
}

function duration(sec: number | null): string {
  return sec === null ? '-' : `${Math.round(sec)}s`;
}

function row(label: string, c: BatchCounts): string {
  return `| ${label} | ${c.runs} | ${c.PASS} | ${c.FAIL} | ${c.ASSISTED} | ${c.ERROR} | ${c.UNVERIFIED} | ${percent(c.passRate)} | ${duration(c.medianPassDurationSec)} | ${c.totalDeaths} |`;
}

export function formatBatchMarkdown(summary: BatchSummary, taskId: string): string {
  const lines = [
    `# Batch: ${taskId}`,
    '',
    '| Seed | Runs | PASS | FAIL | ASSISTED | ERROR | UNVERIFIED | Pass rate | Median PASS time | Deaths |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...summary.perSeed.map((s) => row(s.seed, s)),
    row('**Total**', summary.overall),
    '',
    '## Runs',
    '',
    ...summary.runs.map((r) => `- ${r.runId} (seed ${r.seed}): ${r.status}`),
    '',
  ];
  return lines.join('\n');
}
