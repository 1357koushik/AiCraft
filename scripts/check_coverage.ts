/**
 * Checks that every entry of five game registries is covered by the capability catalogue.
 *
 *   npm run coverage
 *
 * Reads data/coverage/<version>.json (the mapping) and data/vanilla/<version>/registries.json (the game's
 * own lists), and fails (exit 1) on:
 *   - an entry with no mapping
 *   - an entry mapped to a section number that is not a "## N." or "### N." heading in CAPABILITIES.md
 *   - an entry marked "gap" (the catalogue does not cover it yet)
 *   - a mapping key that is not in the registry (stale after a version change)
 *   - a malformed mapping entry
 */
import fs from 'fs';
import path from 'path';
import { VANILLA_VERSION } from '../src/knowledge/vanilla.js';

const ROOT = path.resolve(__dirname, '..');

export const COVERAGE_REGISTRIES = [
  'minecraft:custom_stat',
  'minecraft:trigger_type',
  'minecraft:block_type',
  'minecraft:menu',
  'minecraft:entity_type',
] as const;

export type CoverageEntry = { sections?: number[]; not_survival?: string; gap?: string };
export interface CoverageFile {
  version: string;
  registries: Record<string, Record<string, CoverageEntry>>;
}

export interface RegistryReport {
  registry: string;
  total: number;
  covered: number;
  not_survival: number;
  gaps: number;
}

export interface CoverageProblems {
  unmapped: string[];
  badSections: string[];
  gaps: string[];
  stale: string[];
  malformed: string[];
}

export interface CoverageResult {
  reports: RegistryReport[];
  problems: CoverageProblems;
  failures: string[];
}

/** Section numbers that exist as a "## N." or "### N." heading. */
export function loadCatalogueSections(file = path.join(ROOT, 'CAPABILITIES.md')): Set<number> {
  const text = fs.readFileSync(file, 'utf8');
  const sections = new Set<number>();
  for (const m of text.matchAll(/^#{2,3} (\d+)\./gm)) sections.add(Number(m[1]));
  return sections;
}

export function loadCoverageFile(version: string = VANILLA_VERSION): CoverageFile {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'coverage', `${version}.json`), 'utf8'));
}

export function loadRegistries(version: string = VANILLA_VERSION): Record<string, Record<string, number>> {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'vanilla', version, 'registries.json'), 'utf8'));
}

export function checkCoverage(
  mapping: CoverageFile,
  registries: Record<string, Record<string, number>>,
  sections: Set<number>,
): CoverageResult {
  const problems: CoverageProblems = { unmapped: [], badSections: [], gaps: [], stale: [], malformed: [] };
  const reports: RegistryReport[] = [];

  for (const name of COVERAGE_REGISTRIES) {
    const entries = registries[name];
    const mapped = mapping.registries?.[name];
    if (!entries) {
      problems.malformed.push(`${name}: registry missing from registries.json`);
      continue;
    }
    if (!mapped) problems.malformed.push(`${name}: no mapping section in the coverage file`);

    const report: RegistryReport = { registry: name, total: Object.keys(entries).length, covered: 0, not_survival: 0, gaps: 0 };
    for (const id of Object.keys(entries)) {
      const e = mapped?.[id];
      if (!e) {
        problems.unmapped.push(`${name} ${id}`);
        continue;
      }
      const kinds = [e.sections !== undefined, e.not_survival !== undefined, e.gap !== undefined].filter(Boolean).length;
      if (kinds !== 1) {
        problems.malformed.push(`${name} ${id}: needs exactly one of sections, not_survival, gap`);
        continue;
      }
      if (e.gap !== undefined) {
        report.gaps++;
        problems.gaps.push(`${name} ${id}: ${e.gap}`);
      } else if (e.not_survival !== undefined) {
        if (typeof e.not_survival !== 'string' || e.not_survival.trim() === '') {
          problems.malformed.push(`${name} ${id}: not_survival needs a reason`);
        } else report.not_survival++;
      } else {
        const secs = e.sections;
        if (!Array.isArray(secs) || secs.length === 0) {
          problems.malformed.push(`${name} ${id}: sections must be a non-empty array`);
          continue;
        }
        const bad = secs.filter((s) => !sections.has(s));
        if (bad.length) problems.badSections.push(`${name} ${id}: no section ${bad.join(', ')} in CAPABILITIES.md`);
        else report.covered++;
      }
    }
    for (const id of Object.keys(mapped ?? {})) {
      if (!(id in entries)) problems.stale.push(`${name} ${id}`);
    }
    reports.push(report);
  }

  for (const name of Object.keys(mapping.registries ?? {})) {
    if (!(COVERAGE_REGISTRIES as readonly string[]).includes(name)) problems.stale.push(`${name} (registry not checked)`);
  }

  const failures: string[] = [];
  const add = (title: string, list: string[]) => {
    if (list.length) failures.push(`${title} (${list.length}):`, ...list.map((l) => `  ${l}`));
  };
  add('Registry entries with no mapping', problems.unmapped);
  add('Entries mapped to a section that does not exist', problems.badSections);
  add('Entries marked as gaps', problems.gaps);
  add('Mapping keys not in the registry (stale)', problems.stale);
  add('Malformed mapping entries', problems.malformed);
  return { reports, problems, failures };
}

export function runCheck(version: string = VANILLA_VERSION): CoverageResult {
  return checkCoverage(loadCoverageFile(version), loadRegistries(version), loadCatalogueSections());
}

export function formatSummary(reports: RegistryReport[]): string {
  return reports
    .map(
      (r) =>
        `${r.registry.padEnd(24)} total ${String(r.total).padStart(4)}  covered ${String(r.covered).padStart(4)}  not_survival ${String(r.not_survival).padStart(3)}  gaps ${String(r.gaps).padStart(3)}`,
    )
    .join('\n');
}

if (require.main === module) {
  const result = runCheck();
  console.log(formatSummary(result.reports));
  if (result.failures.length) {
    console.error('\nCoverage check FAILED\n' + result.failures.join('\n'));
    process.exit(1);
  }
  console.log('\nCoverage check passed.');
}
