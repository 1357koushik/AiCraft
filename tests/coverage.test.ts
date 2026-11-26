import { describe, expect, it } from 'vitest';
import { checkCoverage, loadCatalogueSections, loadCoverageFile, loadRegistries, runCheck } from '../scripts/check_coverage';

/**
 * Registry entries that CAPABILITIES.md does not cover yet. Each must either be closed (add the behaviour to
 * the catalogue, then change its mapping from "gap" to sections) or justified as not_survival. Keys are
 * "<registry> <entry>". The script `npm run coverage` still reports these as failures.
 */
const KNOWN_GAPS = [
  'minecraft:trigger_type minecraft:kill_mob_near_sculk_catalyst',
  'minecraft:block_type minecraft:sculk_catalyst',
  'minecraft:block_type minecraft:budding_amethyst',
  'minecraft:block_type minecraft:big_dripleaf',
  'minecraft:block_type minecraft:big_dripleaf_stem',
];

describe('capability catalogue coverage', () => {
  it('maps every registry entry, and only reviewed gaps remain', () => {
    const { problems } = runCheck();
    expect(problems.unmapped).toEqual([]);
    expect(problems.badSections).toEqual([]);
    expect(problems.stale).toEqual([]);
    expect(problems.malformed).toEqual([]);
    // Every gap must be a reviewed one, and every reviewed gap must still be one (so closed gaps leave the list).
    const gaps = problems.gaps.map((g) => g.split(': ')[0]).sort();
    expect(gaps).toEqual([...KNOWN_GAPS].sort());
  });

  it('reports a new, unmapped or stale entry', () => {
    const registries = loadRegistries();
    const mapping = structuredClone(loadCoverageFile());
    const sections = loadCatalogueSections();
    delete mapping.registries['minecraft:menu']['minecraft:anvil'];
    mapping.registries['minecraft:menu']['minecraft:removed_menu'] = { sections: [10] };
    mapping.registries['minecraft:menu']['minecraft:hopper'] = { sections: [999] };
    const { problems } = checkCoverage(mapping, registries, sections);
    expect(problems.unmapped).toContain('minecraft:menu minecraft:anvil');
    expect(problems.stale).toContain('minecraft:menu minecraft:removed_menu');
    expect(problems.badSections.some((b) => b.includes('minecraft:hopper'))).toBe(true);
  });
});
