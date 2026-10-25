import fs from 'fs';
import path from 'path';

export interface DiagnosticSnapshot {
  timestamp: string;
  seed: string;
  stepNumber?: number;
  botPosition?: { x: number; y: number; z: number };
  botVitals?: { health: number; food: number; oxygen: number };
  inventory?: Record<string, number>;
  lastWorldEvents: any[];
  activeGoal?: string;
  activeTask?: string;
  pathfinderGoal?: any;
  failureReason: string;
}

export interface SeedRunReport {
  seed: string;
  durationMs: number;
  status: 'SUCCESS' | 'FAILED';
  reachedIronAge: boolean;
  reachedNether: boolean;
  reachedEnd: boolean;
  dragonDefeated: boolean;
  botDeaths: number;
  llmTokensSpent: number;
  llmCallsCount: number;
  failureReason?: string;
  diagnostics?: DiagnosticSnapshot;
}

export interface CampaignSuiteReport {
  totalRuns: number;
  successfulCompletions: number;
  ironAgeSuccessRate: number; // percentage (target 100%)
  dragonDefeatSuccessRate: number; // percentage (target >= 70%)
  meanTimeToDragonDefeatMinutes: number;
  totalBotDeaths: number;
  llmTokenSpendAverage: number;
  seedReports: Array<{
    seed: string;
    durationMs: number;
    status: 'SUCCESS' | 'FAILED';
    failureReason?: string;
    botDeaths?: number;
    llmTokensSpent?: number;
    reachedIronAge?: boolean;
    reachedNether?: boolean;
    reachedEnd?: boolean;
    dragonDefeated?: boolean;
  }>;
  failureDistribution: Record<string, number>;
  diagnosticsSnapshotPaths?: string[];
}

export class MetricsAggregator {
  private runs: SeedRunReport[] = [];
  private diagnosticPaths: string[] = [];

  public addRun(report: SeedRunReport): void {
    this.runs.push(report);
  }

  public getRuns(): SeedRunReport[] {
    return [...this.runs];
  }

  public clear(): void {
    this.runs = [];
    this.diagnosticPaths = [];
  }

  public computeSuiteReport(): CampaignSuiteReport {
    const totalRuns = this.runs.length;
    if (totalRuns === 0) {
      return {
        totalRuns: 0,
        successfulCompletions: 0,
        ironAgeSuccessRate: 0,
        dragonDefeatSuccessRate: 0,
        meanTimeToDragonDefeatMinutes: 0,
        totalBotDeaths: 0,
        llmTokenSpendAverage: 0,
        seedReports: [],
        failureDistribution: {},
        diagnosticsSnapshotPaths: [],
      };
    }

    const successfulCompletions = this.runs.filter((r) => r.status === 'SUCCESS').length;
    const ironAgeRuns = this.runs.filter((r) => r.reachedIronAge).length;
    const dragonDefeatedRuns = this.runs.filter((r) => r.dragonDefeated).length;

    const ironAgeSuccessRate = (ironAgeRuns / totalRuns) * 100;
    const dragonDefeatSuccessRate = (dragonDefeatedRuns / totalRuns) * 100;

    const completedRuns = this.runs.filter((r) => r.dragonDefeated && r.durationMs > 0);
    const meanTimeToDragonDefeatMinutes =
      completedRuns.length > 0
        ? completedRuns.reduce((acc, r) => acc + r.durationMs, 0) / completedRuns.length / 60000
        : 0;

    const totalBotDeaths = this.runs.reduce((acc, r) => acc + (r.botDeaths || 0), 0);
    const totalTokens = this.runs.reduce((acc, r) => acc + (r.llmTokensSpent || 0), 0);
    const llmTokenSpendAverage = totalTokens / totalRuns;

    const failureDistribution: Record<string, number> = {};
    for (const r of this.runs) {
      if (r.status === 'FAILED' && r.failureReason) {
        failureDistribution[r.failureReason] = (failureDistribution[r.failureReason] || 0) + 1;
      }
    }

    return {
      totalRuns,
      successfulCompletions,
      ironAgeSuccessRate: Math.round(ironAgeSuccessRate * 10) / 10,
      dragonDefeatSuccessRate: Math.round(dragonDefeatSuccessRate * 10) / 10,
      meanTimeToDragonDefeatMinutes: Math.round(meanTimeToDragonDefeatMinutes * 10) / 10,
      totalBotDeaths,
      llmTokenSpendAverage: Math.round(llmTokenSpendAverage),
      seedReports: this.runs.map((r) => ({
        seed: r.seed,
        durationMs: r.durationMs,
        status: r.status,
        failureReason: r.failureReason,
        botDeaths: r.botDeaths,
        llmTokensSpent: r.llmTokensSpent,
        reachedIronAge: r.reachedIronAge,
        reachedNether: r.reachedNether,
        reachedEnd: r.reachedEnd,
        dragonDefeated: r.dragonDefeated,
      })),
      failureDistribution,
      diagnosticsSnapshotPaths: [...this.diagnosticPaths],
    };
  }

  public saveDiagnosticsSnapshot(
    snapshot: DiagnosticSnapshot,
    outputDir: string = 'logs/diagnostics'
  ): string {
    const resolvedDir = path.resolve(process.cwd(), outputDir);
    if (!fs.existsSync(resolvedDir)) {
      fs.mkdirSync(resolvedDir, { recursive: true });
    }
    const safeTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `diagnostic_seed_${snapshot.seed}_${safeTimestamp}.json`;
    const fullPath = path.join(resolvedDir, filename);
    fs.writeFileSync(fullPath, JSON.stringify(snapshot, null, 2), 'utf-8');
    this.diagnosticPaths.push(fullPath);
    return fullPath;
  }

  public generateMarkdownReport(suiteReport: CampaignSuiteReport): string {
    const lines: string[] = [
      '# AiCraft Autonomous Survival Multi-Seed Benchmark Report',
      '',
      `**Generated:** ${new Date().toISOString()}`,
      `**Total Runs:** ${suiteReport.totalRuns}`,
      `**Successful Completions:** ${suiteReport.successfulCompletions} / ${suiteReport.totalRuns}`,
      `**Iron Age Reach Rate:** ${suiteReport.ironAgeSuccessRate}% (Acceptance Target: 100%)`,
      `**Ender Dragon Defeat Rate:** ${suiteReport.dragonDefeatSuccessRate}% (Acceptance Target: >= 70%)`,
      `**Mean Time to Dragon Defeat:** ${suiteReport.meanTimeToDragonDefeatMinutes} minutes`,
      `**Total Bot Deaths:** ${suiteReport.totalBotDeaths}`,
      `**Average LLM Token Spend per Run:** ${suiteReport.llmTokenSpendAverage} tokens`,
      '',
      '## Seed Run Results Breakdown',
      '',
      '| Seed | Status | Duration (min) | Iron Age | Nether | The End | Dragon Defeated | Deaths | LLM Tokens | Failure Reason |',
      '| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |',
    ];

    for (const r of suiteReport.seedReports) {
      const durationMin = (r.durationMs / 60000).toFixed(1);
      const statusIcon = r.status === 'SUCCESS' ? '🟢 PASS' : '🔴 FAIL';
      const iron = r.reachedIronAge ? '✅' : '❌';
      const nether = r.reachedNether ? '✅' : '❌';
      const end = r.reachedEnd ? '✅' : '❌';
      const dragon = r.dragonDefeated ? '✅' : '❌';
      const reason = r.failureReason || 'None (Completed)';
      lines.push(
        `| \`${r.seed}\` | ${statusIcon} | ${durationMin} | ${iron} | ${nether} | ${end} | ${dragon} | ${r.botDeaths ?? 0} | ${r.llmTokensSpent ?? 0} | ${reason} |`
      );
    }

    lines.push('');
    lines.push('## Failure Reason Distribution');
    lines.push('');
    const failureEntries = Object.entries(suiteReport.failureDistribution);
    if (failureEntries.length === 0) {
      lines.push('No failures encountered across the evaluation suite.');
    } else {
      lines.push('| Failure Classification | Count |');
      lines.push('| :--- | :---: |');
      for (const [reason, count] of failureEntries) {
        lines.push(`| ${reason} | ${count} |`);
      }
    }

    if (suiteReport.diagnosticsSnapshotPaths && suiteReport.diagnosticsSnapshotPaths.length > 0) {
      lines.push('');
      lines.push('## Diagnostic Artifacts');
      lines.push('');
      for (const p of suiteReport.diagnosticsSnapshotPaths) {
        lines.push(`- \`${p}\``);
      }
    }

    lines.push('');
    return lines.join('\n');
  }

  public saveSuiteReport(
    suiteReport: CampaignSuiteReport,
    outputDir: string = 'logs/evaluation'
  ): { jsonPath: string; markdownPath: string } {
    const resolvedDir = path.resolve(process.cwd(), outputDir);
    if (!fs.existsSync(resolvedDir)) {
      fs.mkdirSync(resolvedDir, { recursive: true });
    }
    const safeTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const jsonPath = path.join(resolvedDir, `campaign_suite_evaluation_${safeTimestamp}.json`);
    const markdownPath = path.join(resolvedDir, `campaign_suite_evaluation_${safeTimestamp}.md`);

    fs.writeFileSync(jsonPath, JSON.stringify(suiteReport, null, 2), 'utf-8');
    fs.writeFileSync(markdownPath, this.generateMarkdownReport(suiteReport), 'utf-8');

    return { jsonPath, markdownPath };
  }
}
