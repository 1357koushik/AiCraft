import { describe, it, expect } from 'vitest';
import { summarizeBatch, formatBatchMarkdown } from '../src/harness/batch.js';
import type { Verdict, VerdictStatus } from '../src/oracle/session.js';

function verdict(status: VerdictStatus, durationSec = 100, deaths = 0): Verdict {
  return {
    status,
    reason: '',
    checks: [],
    assists: [],
    deaths,
    deathMessages: [],
    discrepancies: [],
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:01:40.000Z',
    durationSec,
    finalSnapshot: null,
  };
}

const run = (runId: string, seed: string | undefined, v: Verdict) => ({ runId, seed, verdict: v });

describe('summarizeBatch', () => {
  it('counts mixed statuses per seed and overall', () => {
    const s = summarizeBatch([
      run('r1', '1', verdict('PASS', 60, 0)),
      run('r2', '1', verdict('FAIL', 300, 2)),
      run('r3', '2', verdict('ERROR', 0, 0)),
      run('r4', '2', verdict('UNVERIFIED', 10, 1)),
      run('r5', '2', verdict('PASS', 90, 0)),
    ]);
    expect(s.perSeed.map((p) => p.seed)).toEqual(['1', '2']);
    const [a, b] = s.perSeed;
    expect(a).toMatchObject({ runs: 2, PASS: 1, FAIL: 1, ASSISTED: 0, ERROR: 0, UNVERIFIED: 0, passRate: 0.5, totalDeaths: 2 });
    expect(b).toMatchObject({ runs: 3, PASS: 1, FAIL: 0, ERROR: 1, UNVERIFIED: 1, totalDeaths: 1 });
    expect(b.passRate).toBeCloseTo(1 / 3);
    expect(s.overall).toMatchObject({ runs: 5, PASS: 2, FAIL: 1, ERROR: 1, UNVERIFIED: 1, totalDeaths: 3 });
    expect(s.overall.passRate).toBeCloseTo(0.4);
  });

  it('does not count ASSISTED as a pass or in the median', () => {
    const s = summarizeBatch([run('r1', '1', verdict('ASSISTED', 5)), run('r2', '1', verdict('PASS', 50))]);
    expect(s.overall.ASSISTED).toBe(1);
    expect(s.overall.PASS).toBe(1);
    expect(s.overall.passRate).toBe(0.5);
    expect(s.overall.medianPassDurationSec).toBe(50);
  });

  it('computes the median of PASS durations for odd and even counts', () => {
    const odd = summarizeBatch([
      run('a', '1', verdict('PASS', 30)),
      run('b', '1', verdict('PASS', 10)),
      run('c', '1', verdict('PASS', 20)),
    ]);
    expect(odd.overall.medianPassDurationSec).toBe(20);
    const even = summarizeBatch([
      run('a', '1', verdict('PASS', 10)),
      run('b', '1', verdict('PASS', 40)),
      run('c', '1', verdict('PASS', 20)),
      run('d', '1', verdict('PASS', 30)),
      run('e', '1', verdict('FAIL', 999)),
    ]);
    expect(even.overall.medianPassDurationSec).toBe(25);
  });

  it('handles a seed with zero passes', () => {
    const s = summarizeBatch([run('a', '7', verdict('FAIL', 100, 1)), run('b', '7', verdict('ERROR'))]);
    expect(s.perSeed[0].passRate).toBe(0);
    expect(s.perSeed[0].medianPassDurationSec).toBeNull();
  });

  it('groups runs without a seed under "random" and handles an empty batch', () => {
    expect(summarizeBatch([run('a', undefined, verdict('PASS'))]).perSeed[0].seed).toBe('random');
    const empty = summarizeBatch([]);
    expect(empty.overall.runs).toBe(0);
    expect(empty.overall.passRate).toBe(0);
    expect(empty.perSeed).toEqual([]);
  });
});

describe('formatBatchMarkdown', () => {
  it('writes one row per seed, a total row and the run folders', () => {
    const md = formatBatchMarkdown(
      summarizeBatch([
        run('run_x_1', '1', verdict('PASS', 61)),
        run('run_x_2', '1', verdict('FAIL', 100, 1)),
        run('run_x_3', '2', verdict('ERROR', 0)),
      ]),
      'wooden_pickaxe',
    );
    expect(md).toContain('wooden_pickaxe');
    const rows = md.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Seed') && !l.startsWith('| ---'));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toBe('| 1 | 2 | 1 | 1 | 0 | 0 | 0 | 50% | 61s | 1 |');
    expect(rows[1]).toBe('| 2 | 1 | 0 | 0 | 0 | 1 | 0 | 0% | - | 0 |');
    expect(rows[2]).toContain('**Total**');
    expect(rows[2]).toContain('33%');
    expect(md).toContain('- run_x_1 (seed 1): PASS');
    expect(md).toContain('- run_x_3 (seed 2): ERROR');
  });
});
