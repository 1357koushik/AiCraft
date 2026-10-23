import fs from 'fs';
import path from 'path';
import mineflayer, { Bot } from 'mineflayer';
import { pathfinder } from 'mineflayer-pathfinder';
import { loadConfig, AppConfig } from '../config/index.js';
import { updatePathfinderMovements } from '../actions/techniques.js';
import {
  IntegrationScenarioRunner,
  VanillaBridgeClient,
  DisposableFixtureManager,
  ScenarioReport,
} from '../runner/index.js';
import { buildCampaignFamilies, ActionFamilySuite } from './scenarios_builder.js';
import {
  buildCampaignProvenance,
  managePerRunArtifacts,
  CampaignProvenance,
} from './provenance.js';
import {
  CampaignSummaryReport,
  FamilyExecutionReport,
  ActionEvidenceRow,
  DefectSummary,
} from './types.js';

export interface CampaignOrchestratorOptions {
  config?: AppConfig;
  outputDir?: string;
  logger?: any;
  observer?: any;
}

export class CampaignOrchestrator {
  private config: AppConfig;
  private outputDir: string;
  private logger: any;
  private observerInstance?: any;
  private currentRunDir?: string;

  constructor(options: CampaignOrchestratorOptions = {}) {
    this.config = options.config || loadConfig();
    this.outputDir = path.resolve(process.cwd(), options.outputDir || 'logs/integration/campaign');
    this.logger = options.logger || console;
    this.observerInstance = options.observer;

    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  public async executeCampaign(providedObserver?: any, familyFilter?: string): Promise<CampaignSummaryReport> {
    const campaignId = `campaign_${Date.now()}`;
    const startTime = new Date().toISOString();
    const startWallClock = Date.now();

    this.logger.info('================================================================');
    this.logger.info(`   STARTING COMPREHENSIVE LIVE ACTION-COVERAGE CAMPAIGN         `);
    this.logger.info(`   Campaign ID: ${campaignId}                                   `);
    this.logger.info('================================================================');

    const serverHost = this.config.server.host || '127.0.0.1';
    const serverPort = this.config.server.port || 25565;
    const bridgePort = 25580;

    const observer = providedObserver || this.observerInstance;
    if (!observer) {
      throw new Error('No observer instance provided to CampaignOrchestrator.');
    }

    const operatorBot = observer.observerBot;
    if (!operatorBot) {
      throw new Error('Observer spectator bot failed to initialize.');
    }
    const fixtureManager = new DisposableFixtureManager(operatorBot, this.logger);

    // 2. Connect Agent Bot (dragonai)
    this.logger.info(`[Campaign] Connecting agent bot 'dragonai' to ${serverHost}:${serverPort}...`);
    let agentBot: Bot;
    try {
      agentBot = await new Promise<Bot>((resolve, reject) => {
        const bot = mineflayer.createBot({
          host: serverHost,
          port: serverPort,
          username: 'dragonai',
          version: '1.21.6',
          auth: 'offline',
        });

        bot.loadPlugin(pathfinder);

        bot.once('spawn', () => {
          this.logger.info(`[Campaign] Agent bot spawned at ${bot.entity?.position?.floored()} in '${bot.game?.dimension}'.`);
          const moves = updatePathfinderMovements(bot);
          (bot as any).pathfinder.setMovements(moves);
          resolve(bot);
        });

        bot.on('error', reject);
        bot.on('kicked', (reason) => reject(new Error(`Kicked: ${JSON.stringify(reason)}`)));
      });
    } catch (err: any) {
      await observer.stop();
      throw err;
    }

    // Delay for entity synchronization
    await new Promise((r) => setTimeout(r, 1200));

    // 3. Initialize Scenario Runner with Fixture Manager
    const bridgeClient = new VanillaBridgeClient({
      host: '127.0.0.1',
      port: bridgePort,
      logDir: 'logs/integration',
    });

    const runner = new IntegrationScenarioRunner({
      config: this.config,
      bridgeClient,
      fixtureOperator: fixtureManager,
      reportsDir: 'logs/integration/scenarios',
      logger: this.logger,
    });

    const allFamilies = buildCampaignFamilies();
    const families = familyFilter
      ? allFamilies.filter((f) => f.id === familyFilter || f.id.includes(familyFilter))
      : allFamilies;
    const totalScenarios = families.reduce((acc, f) => acc + f.scenarios.length, 0);
    const provenance = buildCampaignProvenance(campaignId, families.length, totalScenarios);
    const { runDir, prunedRuns } = managePerRunArtifacts(this.outputDir, campaignId, 10);
    this.currentRunDir = runDir;

    if (prunedRuns.length > 0) {
      this.logger.info(`[Campaign] Pruned ${prunedRuns.length} oldest campaign run(s) to enforce log retention limits.`);
    }

    fs.writeFileSync(path.join(runDir, 'PROVENANCE.json'), JSON.stringify(provenance, null, 2), 'utf8');
    fs.writeFileSync(path.join(this.outputDir, 'PROVENANCE.json'), JSON.stringify(provenance, null, 2), 'utf8');
    fs.writeFileSync(path.join(this.outputDir, 'latest_run_id.txt'), campaignId, 'utf8');

    const familyReports: Record<string, FamilyExecutionReport> = {};
    const perActionMatrix: Record<string, ActionEvidenceRow> = {};
    const topRankedDefects: DefectSummary[] = [];

    let totalRetries = 0;
    let botDeaths = 0;
    let stuckActionsCount = 0;
    let cleanupFailuresCount = 0;

    try {
      for (let i = 0; i < families.length; i++) {
        const suite = families[i];
        this.logger.info('\n----------------------------------------------------------------');
        this.logger.info(`[Campaign] Family ${i + 1}/${families.length}: ${suite.name} (${suite.id})`);
        this.logger.info('----------------------------------------------------------------');

        const famStartTime = new Date().toISOString();
        const famStartClock = Date.now();
        const scenarioReports: ScenarioReport[] = [];

        // Run scenarios for this family
        for (const scenario of suite.scenarios) {
          try {
            const rep = await runner.runScenario(scenario, agentBot);
            scenarioReports.push(rep);
            if (rep.timedOut) stuckActionsCount++;
          } catch (scenarioErr: any) {
            this.logger.error(`[Campaign] Scenario '${scenario.id}' threw uncaught error: ${scenarioErr.message}`);
          }
        }

        // Map scenario outcomes to per-action evidence rows
        const actionResults: ActionEvidenceRow[] = [];
        for (const actionId of suite.actionIds) {
          const matchingReports = scenarioReports.filter(
            (r) => r.actionSubmission.actionName === actionId || r.actionSubmission.contractId === actionId
          );

          let rowStatus: ActionEvidenceRow['status'] = 'NOT_RUN';
          if (suite.id === 'family_17_not_implemented') {
            rowStatus = 'NOT_IMPLEMENTED';
          } else if (matchingReports.length === 0) {
            rowStatus = 'NOT_RUN';
          } else if (matchingReports.every((r) => r.status === 'PASS')) {
            const hasObserverEvidence = matchingReports.some((r) => r.observedServerEvents && r.observedServerEvents.length > 0);
            rowStatus = hasObserverEvidence ? 'LIVE_PASS' : 'UNIT_ONLY';
          } else if (matchingReports.some((r) => r.status === 'BLOCKED')) {
            rowStatus = 'BLOCKED';
          } else if (matchingReports.some((r) => r.status === 'INCONCLUSIVE')) {
            rowStatus = 'INCONCLUSIVE';
          } else {
            rowStatus = 'LIVE_FAIL';
          }

          const firstFailedReport = matchingReports.find((r) => r.status === 'FAIL');
          const firstFailedAssertion = firstFailedReport?.assertions.find((a) => !a.passed);

          const row: ActionEvidenceRow = {
            actionId,
            canonicalName: actionId,
            familyId: suite.id,
            category: suite.id.replace('family_', ''),
            isMacro: actionId.startsWith('technique'),
            status: rowStatus,
            scenariosRun: matchingReports.length || 1,
            scenariosPassed: matchingReports.filter((r) => r.status === 'PASS').length,
            observedServerEventsCount: matchingReports.reduce((acc, r) => acc + r.observedServerEvents.length, 0),
          };

          if (firstFailedReport && firstFailedAssertion) {
            row.firstDivergence = {
              scenarioId: firstFailedReport.scenarioId,
              assertionName: firstFailedAssertion.name,
              expected: firstFailedAssertion.expected,
              actual: firstFailedAssertion.actual,
              evidence: `${firstFailedReport.observedServerEvents.length} events logged`,
              probableRootCause: firstFailedReport.statusReason,
              reproductionRecipe: firstFailedReport.reproductionRecipe || `npm test -t "${firstFailedReport.scenarioId}"`,
            };

            topRankedDefects.push({
              rank: topRankedDefects.length + 1,
              actionId,
              category: suite.name,
              severity: actionId.startsWith('goto') || actionId.startsWith('chop') ? 'HIGH' : 'MEDIUM',
              title: `${actionId}: ${firstFailedAssertion.name} failed`,
              assertionFailure: firstFailedAssertion.message,
              expectedVsActual: `Expected ${JSON.stringify(firstFailedAssertion.expected)}, got ${JSON.stringify(
                firstFailedAssertion.actual
              )}`,
              observedEvidence: `${firstFailedReport.observedServerEvents.length} observer events logged`,
              probableRootCause: firstFailedReport.statusReason,
              reproductionRecipe: row.firstDivergence.reproductionRecipe,
            });
          }

          actionResults.push(row);
          perActionMatrix[actionId] = row;
        }

        const famEndClock = Date.now();
        const familyReport: FamilyExecutionReport = {
          familyId: suite.id,
          familyName: suite.name,
          startTime: famStartTime,
          endTime: new Date().toISOString(),
          durationMs: famEndClock - famStartClock,
          actionsCovered: suite.actionIds,
          actionResults,
          summary: {
            total: suite.actionIds.length,
            passed: actionResults.filter((r) => r.status === 'LIVE_PASS').length,
            failed: actionResults.filter((r) => r.status === 'LIVE_FAIL').length,
            inconclusive: actionResults.filter((r) => r.status === 'INCONCLUSIVE').length,
            blocked: actionResults.filter((r) => r.status === 'BLOCKED').length,
            notImplemented: actionResults.filter((r) => r.status === 'NOT_IMPLEMENTED').length,
          },
        };

        familyReports[suite.id] = familyReport;

        // Write family results immediately to disk before proceeding
        this.saveFamilyReport(familyReport);

        this.logger.info(
          `[Campaign] Completed Family ${i + 1}/${families.length}: ${suite.name} -> PASS: ${
            familyReport.summary.passed
          }, FAIL: ${familyReport.summary.failed}, BLOCKED: ${familyReport.summary.blocked}, NOT_IMPL: ${
            familyReport.summary.notImplemented
          }`
        );
      }
    } finally {
      // 4. Teardown & Disconnect
      this.logger.info('\n[Campaign] Tearing down agent bot and ground-truth observer...');
      if (agentBot) {
        try {
          agentBot.quit();
        } catch {}
      }

      try {
        await observer.stop();
      } catch {}
    }

    const endWallClock = Date.now();
    const totalDurationMs = endWallClock - startWallClock;
    const totalActions = Object.keys(perActionMatrix).length;
    const passedActions = Object.values(perActionMatrix).filter((r) => r.status === 'LIVE_PASS').length;
    const overallPercentage = Math.round((passedActions / totalActions) * 100);

    const liveTestGaps = Object.values(perActionMatrix)
      .filter((r) => r.status === 'BLOCKED' || r.status === 'INCONCLUSIVE')
      .map((r) => `${r.actionId}: ${r.status}`);

    const campaignSummary: CampaignSummaryReport = {
      campaignId,
      minecraftVersion: '1.21.6',
      serverImplementation: 'Vanilla 1.21.6 (Observer sidecar instrumented)',
      worldId: 'dragon_world',
      startTime,
      endTime: new Date().toISOString(),
      totalDurationMs,
      totalActionsEvaluated: totalActions,
      overallActionCoveragePercentage: overallPercentage,
      familySummaries: familyReports,
      perActionMatrix,
      topRankedDefects,
      liveTestGaps,
      provenance,
      diagnostics: {
        totalRetries,
        botDeaths,
        llmCallsCount: 0, // deterministic pipeline execution in test harness
        stuckActionsCount,
        cleanupFailuresCount,
      },
      artifacts: {
        summaryJson: path.join(this.outputDir, 'CAMPAIGN_SUMMARY.json'),
        summaryMarkdown: path.join(this.outputDir, 'CAMPAIGN_SUMMARY.md'),
        familyReports: Object.keys(familyReports).map((id) => path.join(this.outputDir, `family_${id}.md`)),
      },
    };

    // Save final campaign summary
    this.saveCampaignSummary(campaignSummary);

    return campaignSummary;
  }

  private saveFamilyReport(report: FamilyExecutionReport): void {
    const jsonPath = path.join(this.outputDir, `family_${report.familyId}.json`);
    const mdPath = path.join(this.outputDir, `family_${report.familyId}.md`);

    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');

    const md = [
      `# Family Execution Report: ${report.familyName}`,
      `- **Family ID**: \`${report.familyId}\``,
      `- **Duration**: \`${report.durationMs}ms\` (${report.startTime} -> ${report.endTime})`,
      `- **Summary**: Total: ${report.summary.total} | Passed: ${report.summary.passed} | Failed: ${report.summary.failed} | Blocked: ${report.summary.blocked} | Not Implemented: ${report.summary.notImplemented}`,
      '',
      '## Per-Action Evidence Matrix',
      '| Action / Macro ID | Status | Scenarios Run | Passed | Events Captured | Divergence / Notes |',
      '| :--- | :---: | :---: | :---: | :---: | :--- |',
      ...report.actionResults.map((r) => {
        const badge =
          r.status === 'LIVE_PASS'
            ? '🟢 PASS'
            : r.status === 'LIVE_FAIL'
            ? '🔴 FAIL'
            : r.status === 'BLOCKED'
            ? '⛔ BLOCKED'
            : r.status === 'NOT_IMPLEMENTED'
            ? '⚪ NOT_IMPLEMENTED'
            : '🟡 INCONCLUSIVE';
        const notes = r.firstDivergence ? `${r.firstDivergence.assertionName}: ${r.firstDivergence.probableRootCause}` : '-';
        return `| \`${r.actionId}\` | ${badge} | ${r.scenariosRun} | ${r.scenariosPassed} | ${r.observedServerEventsCount} | ${notes} |`;
      }),
    ].join('\n');

    fs.writeFileSync(mdPath, md, 'utf8');

    // Mirror to per-run directory
    if (this.currentRunDir) {
      fs.writeFileSync(path.join(this.currentRunDir, `family_${report.familyId}.json`), JSON.stringify(report, null, 2), 'utf8');
      fs.writeFileSync(path.join(this.currentRunDir, `family_${report.familyId}.md`), md, 'utf8');
    }
  }

  private saveCampaignSummary(summary: CampaignSummaryReport): void {
    const jsonStr = JSON.stringify(summary, null, 2);
    fs.writeFileSync(summary.artifacts.summaryJson, jsonStr, 'utf8');
    if (this.currentRunDir) {
      fs.writeFileSync(path.join(this.currentRunDir, 'CAMPAIGN_SUMMARY.json'), jsonStr, 'utf8');
    }

    const prov = summary.provenance;
    const provSection = prov
      ? [
          `## Provenance & Server Configuration Evaluation`,
          `- **Git Commit**: \`${prov.git.commitHash}\` (branch: \`${prov.git.branch}\`${prov.git.isDirty ? ' [DIRTY]' : ''})`,
          `- **Working-Tree Fingerprint**: \`${prov.git.workingTreeFingerprint}\``,
          `- **Redacted Config Hash**: \`${prov.config.redactedConfigHash}\` (source: \`${prov.config.configPath}\`)`,
          `- **Target Server**: \`${prov.serverImplementation}\` (MC \`${prov.minecraftVersion}\`)`,
          `- **Server Properties**: Difficulty: \`${prov.serverProperties.difficulty}\` | Online Mode: \`${prov.serverProperties.onlineMode}\` | Allow Flight: \`${prov.serverProperties.allowFlight}\` | Spawn Protection: \`${prov.serverProperties.spawnProtection}\` | View Distance: \`${prov.serverProperties.viewDistance}\``,
          prov.serverProperties.invalidatingDifferences.length === 0
            ? `- **Configuration Differences Invalidation Risk**: None detected (configuration is safe for automated survival tests).`
            : `- **Server Configuration Differences That Could Invalidate Results**:\n` +
              prov.serverProperties.invalidatingDifferences.map((d) => `  - ⚠️ \`${d}\``).join('\n'),
          ``,
          `---`,
          ``,
        ].join('\n')
      : '';

    const defectRows =
      summary.topRankedDefects.length === 0
        ? '_No defects encountered._'
        : [
            '| Rank | Action | Severity | Title | Divergent Expected vs Actual | Probable Root Cause |',
            '| :---: | :--- | :---: | :--- | :--- | :--- |',
            ...summary.topRankedDefects.map(
              (d) =>
                `| ${d.rank} | \`${d.actionId}\` | **${d.severity}** | ${d.title} | ${d.expectedVsActual} | ${d.probableRootCause} |`
            ),
          ].join('\n');

    const matrixRows = Object.values(summary.perActionMatrix).map((r) => {
      const badge =
        r.status === 'LIVE_PASS'
          ? '🟢 PASS'
          : r.status === 'LIVE_FAIL'
          ? '🔴 FAIL'
          : r.status === 'BLOCKED'
          ? '⛔ BLOCKED'
          : r.status === 'NOT_IMPLEMENTED'
          ? '⚪ NOT_IMPL'
          : '🟡 INCONCL';
      return `| \`${r.actionId}\` | ${r.isMacro ? 'Macro' : 'Primitive'} | ${r.familyId} | ${badge} | ${r.scenariosRun} | ${
        r.observedServerEventsCount
      } |`;
    });

    const md = [
      `# Comprehensive Live Action-Coverage Campaign Report`,
      ``,
      `## Executive Summary`,
      `- **Campaign ID**: \`${summary.campaignId}\``,
      `- **Target Server**: \`${summary.serverImplementation}\` (MC \`${summary.minecraftVersion}\`)`,
      `- **World ID**: \`${summary.worldId}\``,
      `- **Total Duration**: \`${(summary.totalDurationMs / 1000).toFixed(1)}s\``,
      `- **Overall Action Coverage**: **${summary.overallActionCoveragePercentage}%** (${
        Object.values(summary.perActionMatrix).filter((r) => r.status === 'LIVE_PASS').length
      }/${summary.totalActionsEvaluated} actions passed)`,
      `- **Diagnostics**: Bot Deaths: ${summary.diagnostics.botDeaths} | Retries: ${summary.diagnostics.totalRetries} | Stuck Actions: ${summary.diagnostics.stuckActionsCount} | Cleanup Failures: ${summary.diagnostics.cleanupFailuresCount}`,
      ``,
      `---`,
      ``,
      provSection,
      `## 1. Top-Ranked Defects & Divergent Assertions`,
      defectRows,
      ``,
      `---`,
      ``,
      `## 2. Per-Action Live Ground-Truth Coverage Matrix (${summary.totalActionsEvaluated} Total)`,
      `| Action ID | Type | Family | Status | Scenarios Run | Server Events |`,
      `| :--- | :---: | :--- | :---: | :---: | :---: |`,
      ...matrixRows,
      ``,
      `---`,
      ``,
      `## 3. Live-Test Gaps & Blocked Items`,
      summary.liveTestGaps.length === 0
        ? '_Zero live-test gaps._'
        : summary.liveTestGaps.map((g) => `- \`${g}\``).join('\n'),
    ].join('\n');

    fs.writeFileSync(summary.artifacts.summaryMarkdown, md, 'utf8');
    if (this.currentRunDir) {
      fs.writeFileSync(path.join(this.currentRunDir, 'CAMPAIGN_SUMMARY.md'), md, 'utf8');
    }
  }
}
