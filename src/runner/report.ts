import fs from 'fs';
import path from 'path';
import { ScenarioReport } from './types.js';

export function saveScenarioReports(
  report: ScenarioReport,
  outputDir: string = 'logs/integration/scenarios'
): { jsonPath: string; markdownPath: string } {
  const resolvedDir = path.resolve(process.cwd(), outputDir);
  if (!fs.existsSync(resolvedDir)) {
    fs.mkdirSync(resolvedDir, { recursive: true });
  }

  const baseName = `scenario_${report.scenarioId}_${report.runId}`;
  const jsonPath = path.join(resolvedDir, `${baseName}.json`);
  const markdownPath = path.join(resolvedDir, `${baseName}.md`);

  report.logPaths.scenarioJsonReport = jsonPath;
  report.logPaths.scenarioMarkdownReport = markdownPath;

  // 1. Write structured JSON
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');

  // 2. Generate Markdown report
  const markdownContent = formatScenarioMarkdown(report);
  fs.writeFileSync(markdownPath, markdownContent, 'utf8');

  return { jsonPath, markdownPath };
}

export function formatScenarioMarkdown(report: ScenarioReport): string {
  const statusBadge =
    report.status === 'PASS'
      ? '🟢 **PASS**'
      : report.status === 'FAIL'
      ? '🔴 **FAIL**'
      : report.status === 'INCONCLUSIVE'
      ? '🟡 **INCONCLUSIVE**'
      : report.status === 'BLOCKED'
      ? '⛔ **BLOCKED**'
      : '⚪ **NOT_RUN**';

  const formatVec = (v?: { x: number; y: number; z: number } | null) =>
    v ? `(${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})` : 'N/A';

  const assertionsTable =
    report.assertions.length === 0
      ? '_No assertions evaluated._'
      : [
          '| Assertion | Expected | Actual | Result | Details |',
          '| :--- | :--- | :--- | :---: | :--- |',
          ...report.assertions.map(
            (a) =>
              `| \`${a.name}\` | \`${JSON.stringify(a.expected)}\` | \`${JSON.stringify(a.actual)}\` | ${
                a.passed ? '✅ PASS' : '❌ FAIL'
              } | ${a.message} |`
          ),
        ].join('\n');

  const milestonesList =
    report.progressMilestones.length === 0
      ? '_No milestones recorded._'
      : report.progressMilestones
          .map(
            (m) =>
              `- **[+${m.elapsedMs}ms | ${m.phase}]** ${m.message}${
                m.details ? ` \`${JSON.stringify(m.details)}\`` : ''
              }`
          )
          .join('\n');

  const eventsTable =
    report.observedServerEvents.length === 0
      ? '_No server events captured for this action window._'
      : [
          '| Seq | Time | Event Type | Position | Block / Item | Details |',
          '| :---: | :---: | :--- | :--- | :--- | :--- |',
          ...report.observedServerEvents.map(
            (e) =>
              `| ${e.seq} | ${e.timestamp.split('T')[1]?.replace('Z', '') || e.timestamp} | \`${e.eventType}\` | ${formatVec(
                e.coordinates
              )} | ${e.blockId || e.itemId || '-'} | ${e.details ? JSON.stringify(e.details) : '-'} |`
          ),
        ].join('\n');

  const reproductionSection = report.reproductionRecipe
    ? `### Minimal Reproduction Recipe\n\`\`\`bash\n${report.reproductionRecipe}\n\`\`\`\n`
    : '';

  return `# Scenario Execution Report: ${report.name}

## Summary
- **Scenario ID**: \`${report.scenarioId}\`
- **Run ID**: \`${report.runId}\`
- **Result Status**: ${statusBadge}
- **Status Reason**: ${report.statusReason}
- **Duration**: \`${report.durationMs}ms\` (${report.startTime} -> ${report.endTime})

---

## 1. Environment & Identities
| Property | Value |
| :--- | :--- |
| **Minecraft Version** | \`${report.targetMinecraftVersion}\` |
| **Server Implementation** | \`${report.serverImplementation}\` |
| **World ID** | \`${report.worldId}\` |
| **Agent Player** | \`${report.playerIdentity.username}\` (UUID: \`${report.playerIdentity.uuid || 'offline'}\`) |
| **Ground-Truth Observer** | \`${report.observerIdentity.username || 'spectator'}\` (Bridge Port: \`${report.observerIdentity.bridgePort}\`, Connected: \`${report.observerIdentity.connected}\`) |

---

## 2. Phase Timeout Budgets
| Phase | Budget (ms) | Description |
| :--- | :---: | :--- |
| **Setup Budget** | ${report.phaseBudgets.setupTimeoutMs}ms | Fixture & environment readiness |
| **Action Budget** | ${report.phaseBudgets.actionTimeoutMs}ms | Maximum execution time for action |
| **Settling Budget** | ${report.phaseBudgets.settlingTimeoutMs}ms | Post-action physics and drop settling |
| **No-Progress Watchdog** | ${report.phaseBudgets.noProgressTimeoutMs}ms | Max idle duration before aborting stall |

---

## 3. Preconditions & Before-Snapshot
- **Preconditions Checked**: \`${report.preconditions.checked}\`
- **Preconditions Passed**: \`${report.preconditions.passed}\`
${report.preconditions.reason ? `- **Precondition Notes**: ${report.preconditions.reason}` : ''}

### Server-Observer Before-Snapshot:
- **Timestamp**: \`${report.beforeSnapshot?.timestamp || 'N/A'}\`
- **Dimension**: \`${report.beforeSnapshot?.dimension || 'N/A'}\`
- **Position**: \`${formatVec(report.beforeSnapshot?.position)}\`
- **Health**: \`${report.beforeSnapshot?.health ?? 'N/A'}\` | **Food**: \`${report.beforeSnapshot?.food ?? 'N/A'}\`
- **Online Players**: \`${JSON.stringify(report.beforeSnapshot?.onlinePlayers || [])}\`

---

## 4. Action Submission & Execution Diagnostics
- **Target Action**: \`${report.actionSubmission.actionName}\`
- **Contract ID**: \`${report.actionSubmission.contractId || 'none'}\`
- **Action ID**: \`${report.actionSubmission.actionId}\`
- **Goal ID**: \`${report.actionSubmission.goalId}\`
- **Trace ID**: \`${report.actionSubmission.traceId}\`
- **Parameters**:
\`\`\`json
${JSON.stringify(report.actionSubmission.params, null, 2)}
\`\`\`

### Execution Status:
- **Command Accepted**: \`${report.commandAccepted}\`
- **Physical Completed**: \`${report.physicalCompleted}\`
- **Timed Out**: \`${report.timedOut}\`
- **Cancelled**: \`${report.cancelled}\`
- **Retries**: \`${report.retriesCount}\`
- **Agent Reported Result**:
\`\`\`json
${JSON.stringify(report.agentReportedResult, null, 2)}
\`\`\`

---

## 5. Progress Milestones
${milestonesList}

---

## 6. Independently Observed Server Events
${eventsTable}

---

## 7. After-Snapshot & State Deltas
- **Timestamp**: \`${report.afterSnapshot?.timestamp || 'N/A'}\`
- **Final Position**: \`${formatVec(report.afterSnapshot?.position)}\`
- **Final Health**: \`${report.afterSnapshot?.health ?? 'N/A'}\` | **Final Food**: \`${report.afterSnapshot?.food ?? 'N/A'}\`
- **Inventory Deltas**:
\`\`\`json
${JSON.stringify(report.actualResult.inventoryDeltas, null, 2)}
\`\`\`

---

## 8. Expected vs Actual Assertions
### Expected Contract:
- **Contract**: ${report.expectedResult.contractDescription}
- **Test-Case Specification**: ${report.expectedResult.testCaseContract}
- **Invariants**: ${report.expectedResult.invariants.map((i) => `\`${i}\``).join(', ')}
- **Postconditions**: ${report.expectedResult.postconditions.map((p) => `\`${p}\``).join(', ')}

### Actual Result Summary:
- **Definition of Actual**: ${report.actualResult.definitionOfActual}
- **Observed Server Events Count**: ${report.actualResult.observedEventsCount}

### Assertion Table:
${assertionsTable}

---

${reproductionSection}
## 9. Artifacts & Log References
- **JSON Report**: [${path.basename(report.logPaths.scenarioJsonReport)}](file:///${report.logPaths.scenarioJsonReport.replace(/\\/g, '/')})
- **Markdown Report**: [${path.basename(report.logPaths.scenarioMarkdownReport)}](file:///${report.logPaths.scenarioMarkdownReport.replace(/\\/g, '/')})
${report.logPaths.observerLog ? `- **Observer Raw NDJSON Log**: [${path.basename(report.logPaths.observerLog)}](file:///${report.logPaths.observerLog.replace(/\\/g, '/')})` : ''}
`;
}
