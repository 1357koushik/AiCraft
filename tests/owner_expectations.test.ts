import { describe, it, expect } from 'vitest';
import { evaluateExpectations, hasExpectations, validateExpectations, Evidence } from '../src/oracle/expect.js';
import { validateOwnerSpec } from '../src/harness/owner_sim.js';

const sources = { stats: 's', advancements: 'a' };
const base: Evidence = { items: {}, advancements: new Set(), statDeltas: {}, deaths: 0 };

describe('owner expectations', () => {
  it('counts the owner inventory from the owner snapshot, and fails when it is unknown', () => {
    const e = { ownerInventory: { oak_log: '>=5' } };
    expect(hasExpectations(e)).toBe(true);
    expect(evaluateExpectations(e, { ...base, ownerItems: { oak_log: 5 } }, sources)[0].ok).toBe(true);
    expect(evaluateExpectations(e, { ...base, ownerItems: { oak_log: 4 } }, sources)[0].ok).toBe(false);
    expect(evaluateExpectations(e, base, sources)[0].ok).toBe(false);
  });

  it('judges nearOwner by the fraction of polls, default 0.8', () => {
    const d = (xs: Array<number | null>) => xs.map((v, i) => ({ t: 1000 * i, d: v }));
    const e = { nearOwner: { range: 5 } };
    expect(evaluateExpectations(e, { ...base, ownerDistances: d([1, 2, 3, 4, 9]) }, sources)[0].ok).toBe(true); // 80%
    expect(evaluateExpectations(e, { ...base, ownerDistances: d([1, 2, 3, 9, 9]) }, sources)[0].ok).toBe(false);
    expect(evaluateExpectations(e, { ...base, ownerDistances: d([1, null, null, null, null]) }, sources)[0].ok).toBe(false);
    expect(evaluateExpectations(e, base, sources)[0].ok).toBe(false);
  });

  it('with lastSeconds only the final polls count', () => {
    const samples = [9, 9, 9, 1, 1].map((v, i) => ({ t: 1000 * i, d: v }));
    const e = { nearOwner: { range: 3, minFraction: 1, lastSeconds: 1 } };
    expect(evaluateExpectations(e, { ...base, ownerDistances: samples }, sources)[0].ok).toBe(true);
    expect(evaluateExpectations({ nearOwner: { range: 3, minFraction: 1 } }, { ...base, ownerDistances: samples }, sources)[0].ok).toBe(false);
  });

  it('rejects malformed expectations and owner scripts before a run starts', () => {
    expect(() => validateExpectations({ nearOwner: { range: 0 } })).toThrow();
    expect(() => validateExpectations({ nearOwner: { range: 3, minFraction: 2 } })).toThrow();
    expect(() => validateExpectations({ ownerInventory: { oak_log: 'lots' } })).toThrow();
    expect(() => validateOwnerSpec({ script: [{ say: 'hi' }, { wait: 2 }, { walk: [1, 2, 3] }, { look_at: [0, 0, 0] }] })).not.toThrow();
    expect(() => validateOwnerSpec({ script: [{ jump: true } as any] })).toThrow();
    expect(() => validateOwnerSpec({ script: [{ walk: [1, 2] } as any] })).toThrow();
  });
  it('judges ownerDamageTakenMax in hit points, and fails when it is unknown', () => {
    const e = { ownerDamageTakenMax: 2 };
    expect(hasExpectations(e)).toBe(true);
    expect(evaluateExpectations(e, { ...base, ownerDamageTaken: 0 }, sources)[0].ok).toBe(true);
    expect(evaluateExpectations(e, { ...base, ownerDamageTaken: 2 }, sources)[0].ok).toBe(true);
    expect(evaluateExpectations(e, { ...base, ownerDamageTaken: 2.1 }, sources)[0].ok).toBe(false);
    expect(evaluateExpectations(e, base, sources)[0].ok).toBe(false);
    expect(() => validateExpectations({ ownerDamageTakenMax: -1 })).toThrow();
  });
});
