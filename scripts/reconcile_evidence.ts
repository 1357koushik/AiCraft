import fs from 'fs';
import path from 'path';
import { actionContractManifest, CoverageStatus } from '../src/contracts/index.js';
import { allActions } from '../src/actions/registry.js';

interface ActionEvidenceRow {
  actionId: string;
  canonicalName: string;
  familyId: string;
  category: string;
  isMacro: boolean;
  status: 'LIVE_PASS' | 'LIVE_FAIL' | 'UNIT_ONLY' | 'BLOCKED' | 'NOT_IMPLEMENTED' | 'INCONCLUSIVE' | 'NOT_RUN';
  scenariosRun: number;
  scenariosPassed: number;
  observedServerEventsCount: number;
  firstDivergence?: {
    scenarioId: string;
    assertionName: string;
    expected: any;
    actual: any;
    evidence?: string;
    probableRootCause?: string;
    reproductionRecipe?: string;
  };
  limitations?: string;
}

export function reconcileAllEvidence(): {
  reconciledRows: ActionEvidenceRow[];
  counts: Record<string, number>;
  summaryText: string;
} {
  const campaignDir = path.resolve(process.cwd(), 'logs/integration/campaign');
  const familyFiles = fs.readdirSync(campaignDir).filter((f) => f.startsWith('family_') && f.endsWith('.json')).sort();

  const reconciledRows: ActionEvidenceRow[] = [];
  const counts: Record<string, number> = {
    LIVE_PASS: 0,
    LIVE_FAIL: 0,
    UNIT_ONLY: 0,
    BLOCKED: 0,
    NOT_IMPLEMENTED: 0,
    INCONCLUSIVE: 0,
    NOT_RUN: 0,
  };

  for (const f of familyFiles) {
    const filePath = path.join(campaignDir, f);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    let updatedResults: ActionEvidenceRow[] = [];

    for (const raw of data.actionResults) {
      let trueStatus: ActionEvidenceRow['status'] = raw.status;

      if (data.familyId === 'family_17_not_implemented') {
        trueStatus = 'NOT_IMPLEMENTED';
      } else if (raw.status === 'LIVE_FAIL') {
        trueStatus = 'LIVE_FAIL';
      } else if (raw.status === 'BLOCKED') {
        trueStatus = 'BLOCKED';
      } else if (raw.status === 'LIVE_PASS') {
        // Strict Independent Oracle Check:
        // Must have actually run its own matching scenario and captured observer events
        if (raw.scenariosPassed >= 1 && raw.observedServerEventsCount > 0) {
          trueStatus = 'LIVE_PASS';
        } else {
          // Did not actually have a passed scenario or captured events: reclassify to UNIT_ONLY
          trueStatus = 'UNIT_ONLY';
        }
      } else if (raw.status === 'NOT_RUN') {
        trueStatus = 'NOT_RUN';
      } else {
        trueStatus = raw.status || 'UNIT_ONLY';
      }

      counts[trueStatus] = (counts[trueStatus] || 0) + 1;

      const row: ActionEvidenceRow = {
        ...raw,
        status: trueStatus,
      };

      updatedResults.push(row);
      reconciledRows.push(row);
    }

    // Update family json & md
    data.actionResults = updatedResults;
    data.summary = {
      total: updatedResults.length,
      passed: updatedResults.filter((r) => r.status === 'LIVE_PASS').length,
      failed: updatedResults.filter((r) => r.status === 'LIVE_FAIL').length,
      inconclusive: updatedResults.filter((r) => r.status === 'INCONCLUSIVE').length,
      blocked: updatedResults.filter((r) => r.status === 'BLOCKED').length,
      notImplemented: updatedResults.filter((r) => r.status === 'NOT_IMPLEMENTED').length,
      unitOnly: updatedResults.filter((r) => r.status === 'UNIT_ONLY').length,
      notRun: updatedResults.filter((r) => r.status === 'NOT_RUN').length,
    };

    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');

    // Update markdown
    const mdPath = path.join(campaignDir, f.replace('.json', '.md'));
    const md = [
      `# Family Execution Report: ${data.familyName}`,
      `- **Family ID**: \`${data.familyId}\``,
      `- **Duration**: \`${data.durationMs}ms\` (${data.startTime} -> ${data.endTime})`,
      `- **Summary**: Total: ${data.summary.total} | Passed: ${data.summary.passed} | Failed: ${data.summary.failed} | Blocked: ${data.summary.blocked} | Not Implemented: ${data.summary.notImplemented} | Unit Only: ${data.summary.unitOnly}`,
      '',
      '## Per-Action Evidence Matrix',
      '| Action / Macro ID | Status | Scenarios Run | Passed | Events Captured | Divergence / Notes |',
      '| :--- | :---: | :---: | :---: | :---: | :--- |',
      ...data.actionResults.map((r: ActionEvidenceRow) => {
        const badge =
          r.status === 'LIVE_PASS'
            ? '🟢 LIVE_PASS'
            : r.status === 'LIVE_FAIL'
            ? '🔴 LIVE_FAIL'
            : r.status === 'BLOCKED'
            ? '⛔ BLOCKED'
            : r.status === 'NOT_IMPLEMENTED'
            ? '⚪ NOT_IMPLEMENTED'
            : r.status === 'UNIT_ONLY'
            ? '🔵 UNIT_ONLY'
            : '🟡 INCONCLUSIVE';
        const notes = r.firstDivergence ? `${r.firstDivergence.assertionName}: ${r.firstDivergence.probableRootCause}` : '-';
        return `| \`${r.actionId}\` | ${badge} | ${r.scenariosRun} | ${r.scenariosPassed} | ${r.observedServerEventsCount} | ${notes} |`;
      }),
    ].join('\n');
    fs.writeFileSync(mdPath, md, 'utf8');
  }

  const summaryText = `Reconciled ${reconciledRows.length} actions/techniques:\n` +
    `  LIVE_PASS       : ${counts.LIVE_PASS}\n` +
    `  LIVE_FAIL       : ${counts.LIVE_FAIL}\n` +
    `  UNIT_ONLY       : ${counts.UNIT_ONLY}\n` +
    `  BLOCKED         : ${counts.BLOCKED}\n` +
    `  NOT_IMPLEMENTED : ${counts.NOT_IMPLEMENTED}\n` +
    `  INCONCLUSIVE    : ${counts.INCONCLUSIVE}\n` +
    `  NOT_RUN         : ${counts.NOT_RUN}`;

  return { reconciledRows, counts, summaryText };
}

if (process.argv[1]?.endsWith('reconcile_evidence.ts')) {
  const res = reconcileAllEvidence();
  console.log(res.summaryText);
}
