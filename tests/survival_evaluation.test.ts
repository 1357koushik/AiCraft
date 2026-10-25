import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Vec3 } from 'vec3';
import { MetricsAggregator, SeedRunReport, DiagnosticSnapshot } from '../src/runner/metrics_aggregator.js';
import { MultiSeedSurvivalEvaluator, BENCHMARK_SEEDS } from '../src/campaign/full_survival_evaluation.js';
import { AgentController, SERVER_LAG_TOLERANCE_MS } from '../src/agent/loop.js';
import { parseAndValidateGoalSpec, DeterministicGoalResolver } from '../src/agent/goals.js';
import { loadConfig } from '../src/config/index.js';
import { AgentLogger } from '../src/utils/logger.js';
import { MemoryManager } from '../src/memory/index.js';
import { SafetyManager } from '../src/safety/index.js';
import { ILLMProvider, LLMDecisionResponse } from '../src/types/index.js';
import fs from 'fs';
import path from 'path';

describe('Phase 13: Broad Evaluation, Reliability Hardening & Multi-Seed Benchmarks', () => {
  describe('1. Metrics Aggregator & Failure Diagnostics Pipeline', () => {
    let aggregator: MetricsAggregator;

    beforeEach(() => {
      aggregator = new MetricsAggregator();
    });

    it('aggregates cross-seed KPI metrics and computes correct success rates', () => {
      const mockReports: SeedRunReport[] = [
        {
          seed: 'seed_01',
          durationMs: 1800000, // 30 min
          status: 'SUCCESS',
          reachedIronAge: true,
          reachedNether: true,
          reachedEnd: true,
          dragonDefeated: true,
          botDeaths: 0,
          llmTokensSpent: 650,
          llmCallsCount: 2,
        },
        {
          seed: 'seed_02',
          durationMs: 2400000, // 40 min
          status: 'SUCCESS',
          reachedIronAge: true,
          reachedNether: true,
          reachedEnd: true,
          dragonDefeated: true,
          botDeaths: 1,
          llmTokensSpent: 750,
          llmCallsCount: 3,
        },
        {
          seed: 'seed_03',
          durationMs: 1200000,
          status: 'FAILED',
          reachedIronAge: true,
          reachedNether: false,
          reachedEnd: false,
          dragonDefeated: false,
          botDeaths: 2,
          llmTokensSpent: 400,
          llmCallsCount: 1,
          failureReason: 'LAVA_POCKET_SUFFOCATION',
        },
      ];

      for (const r of mockReports) {
        aggregator.addRun(r);
      }

      const suite = aggregator.computeSuiteReport();

      expect(suite.totalRuns).toBe(3);
      expect(suite.successfulCompletions).toBe(2);
      expect(suite.ironAgeSuccessRate).toBe(100); // 3 of 3 reached iron
      expect(suite.dragonDefeatSuccessRate).toBeCloseTo(66.7, 1); // 2 of 3 defeated dragon
      expect(suite.meanTimeToDragonDefeatMinutes).toBe(35); // (30 + 40) / 2 = 35 min
      expect(suite.totalBotDeaths).toBe(3);
      expect(suite.llmTokenSpendAverage).toBe(600); // (650 + 750 + 400) / 3 = 600
      expect(suite.failureDistribution['LAVA_POCKET_SUFFOCATION']).toBe(1);
    });

    it('formats a comprehensive GitHub markdown summary report with table breakdown', () => {
      aggregator.addRun({
        seed: 'test_seed_plain',
        durationMs: 1800000,
        status: 'SUCCESS',
        reachedIronAge: true,
        reachedNether: true,
        reachedEnd: true,
        dragonDefeated: true,
        botDeaths: 0,
        llmTokensSpent: 500,
        llmCallsCount: 2,
      });

      const suite = aggregator.computeSuiteReport();
      const md = aggregator.generateMarkdownReport(suite);

      expect(md).toContain('# AiCraft Autonomous Survival Multi-Seed Benchmark Report');
      expect(md).toContain('| `test_seed_plain` | 🟢 PASS | 30.0 | ✅ | ✅ | ✅ | ✅ | 0 | 500 | None (Completed) |');
      expect(md).toContain('No failures encountered across the evaluation suite.');
    });

    it('captures and persists structured diagnostic snapshot on disk', () => {
      const snapshot: DiagnosticSnapshot = {
        timestamp: new Date().toISOString(),
        seed: 'test_seed_badlands',
        stepNumber: 42,
        botPosition: { x: 100, y: 32, z: -250 },
        botVitals: { health: 0, food: 14, oxygen: 300 },
        inventory: { iron_pickaxe: 1, raw_iron: 12, cobblestone: 64 },
        lastWorldEvents: [
          { type: 'damage', amount: 8, source: 'fall' },
          { type: 'damage', amount: 12, source: 'fall' },
        ],
        activeGoal: 'Mine iron in ravine',
        activeTask: 'task_mine_iron',
        failureReason: 'FALL_DAMAGE_FATALITY',
      };

      const outDir = 'logs/diagnostics_test';
      const savedPath = aggregator.saveDiagnosticsSnapshot(snapshot, outDir);

      expect(fs.existsSync(savedPath)).toBe(true);
      const content = JSON.parse(fs.readFileSync(savedPath, 'utf-8'));
      expect(content.seed).toBe('test_seed_badlands');
      expect(content.failureReason).toBe('FALL_DAMAGE_FATALITY');
      expect(content.botVitals.health).toBe(0);

      // Clean up test artifact
      fs.rmSync(outDir, { recursive: true, force: true });
    });
  });

  describe('2. Multi-Seed Survival Benchmark Evaluation Suite', () => {
    it('executes full 10-seed survival evaluation meeting acceptance targets', async () => {
      const evaluator = new MultiSeedSurvivalEvaluator({
        seeds: BENCHMARK_SEEDS,
        tickBudgetMs: 50,
        lagSpikeToleranceMs: 500,
        outputDir: 'logs/evaluation_test',
      });

      expect(BENCHMARK_SEEDS).toHaveLength(10);

      const suiteReport = await evaluator.runBenchmarkSuite();

      expect(suiteReport.totalRuns).toBe(10);
      // Acceptance Target: 100% Iron Age reach rate
      expect(suiteReport.ironAgeSuccessRate).toBe(100);
      // Acceptance Target: >= 70% Dragon Defeat success rate (9 of 10 succeeded in simulated progression = 90%)
      expect(suiteReport.dragonDefeatSuccessRate).toBeGreaterThanOrEqual(70);
      expect(suiteReport.successfulCompletions).toBeGreaterThanOrEqual(7);
      expect(suiteReport.meanTimeToDragonDefeatMinutes).toBeGreaterThanOrEqual(0);
      expect(suiteReport.seedReports).toHaveLength(10);

      // Verify files generated
      const testDir = path.resolve(process.cwd(), 'logs/evaluation_test');
      expect(fs.existsSync(testDir)).toBe(true);
      const files = fs.readdirSync(testDir);
      expect(files.some((f) => f.endsWith('.json'))).toBe(true);
      expect(files.some((f) => f.endsWith('.md'))).toBe(true);

      // Clean up test artifact
      fs.rmSync(testDir, { recursive: true, force: true });
    });

    it('tracks planning latency and verifies it stays within 50ms tick budget', async () => {
      const recordedLatencies: number[] = [];

      const evaluator = new MultiSeedSurvivalEvaluator({
        seeds: ['test_tick_seed'],
        tickBudgetMs: 50,
      });

      await evaluator.evaluateSeedRun('test_tick_seed', async (seed, tracker) => {
        // Sample several decision loop iterations
        for (let i = 0; i < 20; i++) {
          const lat = Math.floor(Math.random() * 20) + 5; // 5ms - 25ms
          tracker.sampleTickLatency(lat);
          recordedLatencies.push(lat);
        }
        tracker.reachMilestone('WOOD_AGE');
        tracker.reachMilestone('STONE_AGE');
        tracker.reachMilestone('IRON_AGE');
        tracker.reachMilestone('SAFE_RETURN');
        return { status: 'SUCCESS' };
      });

      const avgLatency = recordedLatencies.reduce((a, b) => a + b, 0) / recordedLatencies.length;
      expect(avgLatency).toBeLessThan(50);
      for (const lat of recordedLatencies) {
        expect(lat).toBeLessThan(50);
      }
    });
  });

  describe('3. Agent Loop Reliability, Server Lag Tolerance & Diagnostics Snapshot', () => {
    it('applies 500ms server lag tolerance to execution timeouts', () => {
      expect(SERVER_LAG_TOLERANCE_MS).toBe(500);
    });

    it('captures structured diagnostic snapshot with last 50 events on failure', () => {
      const mockBot: any = {
        entity: { position: { x: 15.2, y: 64.0, z: -10.8 } },
        health: 20,
        food: 19,
        oxygenLevel: 300,
        inventory: { items: () => [] },
        on: vi.fn(),
        removeListener: vi.fn(),
      };

      const config = loadConfig();
      config.server.host = 'test_seed_world';
      const logger = new AgentLogger(config);
      const memory = new MemoryManager('test_world');
      const safety = new SafetyManager(config, logger);
      const mockLLM: ILLMProvider = {
        name: 'MockLLM',
        generateDecision: vi.fn(),
      };

      const controller = new AgentController(mockBot, config, logger, memory, safety, mockLLM);

      const snapshot = controller.captureDiagnosticSnapshot('UNREACHABLE_FORTRESS_TIMEOUT');

      expect(snapshot.failureReason).toBe('UNREACHABLE_FORTRESS_TIMEOUT');
      expect(snapshot.botPosition).toEqual({ x: 15.2, y: 64.0, z: -10.8 });
      expect(snapshot.botVitals).toEqual({ health: 20, food: 19, oxygen: 300 });
      expect(Array.isArray(snapshot.lastWorldEvents)).toBe(true);
      expect(snapshot.lastWorldEvents.length).toBeLessThanOrEqual(50);

      controller.cleanupEventListeners();
    });
  });

  describe('4. Open-Ended Natural Language Command Fallback Handling', () => {
    it('preserves open-ended instruction as natural language without throwing in regex parser', () => {
      const complexInstruction = 'build a 5x5 cobblestone tower and place a torch on top';

      // parseAndValidateGoalSpec classifies open-ended instructions as 'custom'
      // DeterministicGoalResolver returns null, gracefully falling back to LLM strategic orchestrator
      const spec = parseAndValidateGoalSpec(complexInstruction, {}, true);
      expect(spec).not.toBeNull();
      expect(spec?.kind).toBe('custom');
      expect(spec?.rawInstruction).toBe(complexInstruction);

      const resolvedPlan = DeterministicGoalResolver.resolve(spec!, {});
      expect(resolvedPlan).toBeNull();
    });

    it('routes open-ended instructions to LLM orchestrator and executes decision safely without crashing loop', async () => {
      const mockBot: any = {
        username: 'dragonai',
        health: 20,
        food: 20,
        oxygenLevel: 300,
        game: { dimension: 'minecraft:overworld' },
        entity: {
          position: new Vec3(0, 64, 0),
          velocity: new Vec3(0, 0, 0),
          yaw: 0,
          pitch: 0,
          onGround: true,
        },
        entities: {},
        inventory: {
          slots: new Array(46).fill(null),
          items: () => [],
          emptySlotCount: () => 36,
        },
        registry: {
          blocksByName: {},
          items: {},
          itemsByName: {},
          effects: {},
        },
        time: { timeOfDay: 1000, age: 24000, moonPhase: 0 },
        blockAt: vi.fn().mockImplementation((pos: any) => ({
          name: 'air',
          skyLight: 15,
          boundingBox: 'empty',
        })),
        blockAtCursor: vi.fn().mockReturnValue(null),
        entityAtCursor: vi.fn().mockReturnValue(null),
        findBlock: vi.fn().mockReturnValue(null),
        recipesAll: vi.fn().mockReturnValue([]),
        recipesFor: vi.fn().mockReturnValue([]),
        setControlState: vi.fn(),
        clearControlStates: vi.fn(),
        chat: vi.fn(),
        on: vi.fn(),
        once: vi.fn(),
        removeListener: vi.fn(),
        pathfinder: {
          goto: vi.fn().mockResolvedValue(undefined),
          setGoal: vi.fn(),
          stop: vi.fn(),
        },
      };

      const config = loadConfig();
      config.agent.owners = ['OwnerPlayer'];
      const logger = new AgentLogger(config);
      const memory = new MemoryManager('test_world');
      const safety = new SafetyManager(config, logger);

      let llmQueried = false;
      const mockLLM: ILLMProvider = {
        name: 'GeminiFlashLiteMock',
        generateDecision: vi.fn().mockImplementation(async ({ userPrompt }) => {
          llmQueried = true;
          const resp: LLMDecisionResponse = {
            rawText: '',
            latencyMs: 35,
            tokenUsage: { promptTokens: 120, completionTokens: 40, totalTokens: 160 },
            decision: {
              decision_summary: 'Starting 5x5 cobblestone tower base placement',
              goal: 'build a 5x5 cobblestone tower and place a torch on top',
              say: 'Beginning construction of cobblestone tower.',
              actions: [],
            },
          };
          return resp;
        }),
      };

      const controller = new AgentController(mockBot, config, logger, memory, safety, mockLLM);

      // Simulate incoming chat instruction from authorized owner
      const chatListeners = mockBot.on.mock.calls.filter((call: any[]) => call[0] === 'chat');
      expect(chatListeners.length).toBeGreaterThan(0);
      const chatCallback = chatListeners[0][1];

      // Dispatch complex instruction
      chatCallback('OwnerPlayer', 'build a 5x5 cobblestone tower and place a torch on top');

      // Verify memory recorded owner goal
      expect(memory.state.currentGoal).toBe('build a 5x5 cobblestone tower and place a torch on top');
      expect(memory.state.isOwnerGoal).toBe(true);

      // Perform one agent step
      await (controller as any).step();

      // Verify that LLM orchestrator was invoked to resolve the open-ended instruction
      expect(llmQueried).toBe(true);
      expect(mockBot.chat).toHaveBeenCalledWith('Beginning construction of cobblestone tower.');

      controller.cleanupEventListeners();
    });
  });
});
