import { MetricsAggregator, SeedRunReport, CampaignSuiteReport, DiagnosticSnapshot } from '../runner/metrics_aggregator.js';
import { logDir } from '../utils/paths.js';

export const BENCHMARK_SEEDS = [
  '8675309', // Plains & Oak Forest baseline
  '123456789', // Ocean / Island spawn
  '987654321', // Badlands / Mesa spawn
  '1122334455', // Mountain & Snowy Peaks spawn
  '5544332211', // Desert & Savannah spawn
  '2026102501', // Birch Forest & Meadow
  '2026102502', // Dark Forest & Swampland
  '2026102503', // Jungle & Bamboo Jungle
  '2026102504', // Taiga & Old Growth Pine
  '2026102505', // Windswept Hills & Coastal Cliff
];

export type SurvivalMilestone =
  | 'SPAWN'
  | 'WOOD_AGE'
  | 'STONE_AGE'
  | 'IRON_AGE'
  | 'DIAMOND_AGE'
  | 'NETHER_PORTAL'
  | 'NETHER_FORTRESS'
  | 'ENDER_PEARL'
  | 'STRONGHOLD'
  | 'ENDER_DRAGON'
  | 'SAFE_RETURN';

export interface EvaluatorOptions {
  seeds?: string[];
  tickBudgetMs?: number;
  lagSpikeToleranceMs?: number;
  outputDir?: string;
  metricsAggregator?: MetricsAggregator;
}

export interface RunProgressTracker {
  reachMilestone: (milestone: SurvivalMilestone) => void;
  recordDeath: () => void;
  recordTokens: (tokens: number) => void;
  recordLlmCall: () => void;
  sampleTickLatency: (latencyMs: number) => void;
  setDiagnostics: (snapshot: Partial<DiagnosticSnapshot>) => void;
}

export type SeedRunnerFn = (seed: string, tracker: RunProgressTracker) => Promise<Partial<SeedRunReport>>;

/**
 * Aggregates results from a caller-supplied seed runner.
 *
 * This class does not run Minecraft itself. Its numbers are only as real as
 * the runnerFn passed in: a runner that drives a live server produces live
 * results, a runner backed by mocks produces mock results. There is no
 * built-in default run.
 */
export class MultiSeedSurvivalEvaluator {
  private seeds: string[];
  private tickBudgetMs: number;
  private lagSpikeToleranceMs: number;
  private outputDir: string;
  private aggregator: MetricsAggregator;

  constructor(options: EvaluatorOptions = {}) {
    this.seeds = options.seeds || BENCHMARK_SEEDS;
    this.tickBudgetMs = options.tickBudgetMs ?? 50;
    this.lagSpikeToleranceMs = options.lagSpikeToleranceMs ?? 500;
    this.outputDir = options.outputDir || logDir('evaluation');
    this.aggregator = options.metricsAggregator || new MetricsAggregator();
  }

  public get metricsAggregator(): MetricsAggregator {
    return this.aggregator;
  }

  public async evaluateSeedRun(seed: string, runnerFn: SeedRunnerFn): Promise<SeedRunReport> {
    if (typeof runnerFn !== 'function') {
      throw new Error(
        'MultiSeedSurvivalEvaluator requires a runnerFn that actually executes the seed. No simulated default exists.'
      );
    }
    const startTime = Date.now();
    const milestonesReached = new Set<SurvivalMilestone>();
    let botDeaths = 0;
    let llmTokensSpent = 0;
    let llmCallsCount = 0;
    const latencySamples: number[] = [];
    let diagnosticsPartial: Partial<DiagnosticSnapshot> = {};

    const tracker: RunProgressTracker = {
      reachMilestone: (m) => milestonesReached.add(m),
      recordDeath: () => botDeaths++,
      recordTokens: (tokens) => (llmTokensSpent += tokens),
      recordLlmCall: () => llmCallsCount++,
      sampleTickLatency: (latencyMs) => latencySamples.push(latencyMs),
      setDiagnostics: (d) => {
        diagnosticsPartial = { ...diagnosticsPartial, ...d };
      },
    };

    let runResult: Partial<SeedRunReport> = {};
    let status: 'SUCCESS' | 'FAILED' = 'SUCCESS';
    let failureReason: string | undefined = undefined;

    try {
      runResult = await runnerFn(seed, tracker);
      status = runResult.status || (milestonesReached.has('SAFE_RETURN') ? 'SUCCESS' : 'FAILED');
      failureReason = runResult.failureReason;
    } catch (err: any) {
      status = 'FAILED';
      failureReason = err.message || 'Execution error';
    }

    const durationMs = runResult.durationMs ?? (Date.now() - startTime);
    const reachedIronAge = milestonesReached.has('IRON_AGE');
    const reachedNether = milestonesReached.has('NETHER_PORTAL') || milestonesReached.has('NETHER_FORTRESS');
    const reachedEnd = milestonesReached.has('STRONGHOLD') || milestonesReached.has('ENDER_DRAGON') || milestonesReached.has('SAFE_RETURN');
    const dragonDefeated = milestonesReached.has('ENDER_DRAGON') || milestonesReached.has('SAFE_RETURN');

    let diagnostics: DiagnosticSnapshot | undefined = undefined;
    if (status === 'FAILED' || botDeaths > 0) {
      // Only record what the runner actually observed; leave unknown fields empty.
      diagnostics = {
        timestamp: new Date().toISOString(),
        seed,
        failureReason: failureReason || 'Unknown failure',
        botPosition: diagnosticsPartial.botPosition,
        botVitals: diagnosticsPartial.botVitals,
        inventory: diagnosticsPartial.inventory,
        lastWorldEvents: diagnosticsPartial.lastWorldEvents || [],
        activeGoal: diagnosticsPartial.activeGoal,
        activeTask: diagnosticsPartial.activeTask,
        pathfinderGoal: diagnosticsPartial.pathfinderGoal,
      };
      this.aggregator.saveDiagnosticsSnapshot(diagnostics);
    }

    const report: SeedRunReport = {
      seed,
      durationMs,
      status,
      reachedIronAge,
      reachedNether,
      reachedEnd,
      dragonDefeated,
      botDeaths,
      llmTokensSpent,
      llmCallsCount,
      failureReason,
      diagnostics,
    };

    this.aggregator.addRun(report);
    return report;
  }

  public async runBenchmarkSuite(runnerFn: SeedRunnerFn): Promise<CampaignSuiteReport> {
    for (const seed of this.seeds) {
      await this.evaluateSeedRun(seed, runnerFn);
    }

    const suiteReport = this.aggregator.computeSuiteReport();
    this.aggregator.saveSuiteReport(suiteReport, this.outputDir);
    return suiteReport;
  }
}
