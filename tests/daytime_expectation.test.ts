import { describe, it, expect } from 'vitest';
import { evaluateExpectations, hasExpectations, validateExpectations, Evidence } from '../src/oracle/expect.js';

const base: Evidence = { items: {}, advancements: new Set(), statDeltas: {}, deaths: 0 };
const src = { stats: 's', advancements: 'a' };

describe('daytime expectation', () => {
  it('counts as an expectation and validates the comparison', () => {
    expect(hasExpectations({ daytime: '<2000' })).toBe(true);
    expect(() => validateExpectations({ daytime: '<2000' })).not.toThrow();
    expect(() => validateExpectations({ daytime: 'morning' })).toThrow(/Invalid comparison/);
  });

  it('passes and fails on the world time read over RCON', () => {
    const pass = evaluateExpectations({ daytime: '<2000' }, { ...base, daytime: 120 }, src);
    expect(pass).toHaveLength(1);
    expect(pass[0]).toMatchObject({ ok: true, actual: '120', expected: '<2000', source: 'RCON time query daytime' });
    expect(evaluateExpectations({ daytime: '<2000' }, { ...base, daytime: 18000 }, src)[0].ok).toBe(false);
    expect(evaluateExpectations({ daytime: '>=12000' }, { ...base, daytime: 12000 }, src)[0].ok).toBe(true);
  });

  it('fails when the time could not be read', () => {
    const r = evaluateExpectations({ daytime: '<2000' }, base, src)[0];
    expect(r.ok).toBe(false);
    expect(r.actual).toBe('unknown');
  });
});
