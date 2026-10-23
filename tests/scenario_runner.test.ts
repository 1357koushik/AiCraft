import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Vec3 } from 'vec3';
import fs from 'fs';
import path from 'path';
import {
  IntegrationScenarioRunner,
  NoProgressWatchdog,
  VanillaBridgeClient,
  saveScenarioReports,
  formatScenarioMarkdown,
  breakLogScenario,
  unreachableTargetScenario,
  cancelMovementScenario,
  ScenarioDefinition,
  ScenarioReport,
} from '../src/runner/index.js';

describe('Integration Scenario Runner Subsystem', () => {
  const testOutputDir = 'logs/test_integration/scenarios';

  beforeEach(() => {
    if (fs.existsSync(testOutputDir)) {
      fs.rmSync(testOutputDir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(testOutputDir)) {
      fs.rmSync(testOutputDir, { recursive: true, force: true });
    }
  });

  function createMockBot(pos = new Vec3(10, 64, 10)) {
    return {
      username: 'dragonai',
      health: 20,
      food: 20,
      game: { dimension: 'minecraft:overworld' },
      entity: {
        position: pos.clone(),
        velocity: new Vec3(0, 0, 0),
        yaw: 0,
        pitch: 0,
        onGround: true,
      },
      inventory: {
        items: () => [],
      },
      findBlock: vi.fn(),
      setControlState: vi.fn(),
      clearControlStates: vi.fn(),
      pathfinder: {
        goto: vi.fn().mockResolvedValue(undefined),
        setGoal: vi.fn(),
        stop: vi.fn(),
      },
    } as any;
  }

  it('labels scenario as INCONCLUSIVE / BLOCKED when server observer bridge is unreachable (no guessing)', async () => {
    // Create client pointing to closed port
    const bridgeClient = new VanillaBridgeClient({
      host: '127.0.0.1',
      port: 59999, // inactive port
      timeoutMs: 500,
    });

    const runner = new IntegrationScenarioRunner({
      bridgeClient,
      reportsDir: testOutputDir,
    });

    const mockBot = createMockBot();
    const report = await runner.runScenario(breakLogScenario, mockBot);

    // Strict rule: missing observer must produce INCONCLUSIVE or BLOCKED, never guess or pass
    expect(report.status).toBe('INCONCLUSIVE');
    expect(report.statusReason).toContain('Server observer bridge is unreachable');
    expect(report.observerIdentity.connected).toBe(false);
    expect(report.beforeSnapshot).toBeNull();
    expect(report.afterSnapshot).toBeNull();

    // Verify report was written to disk
    expect(fs.existsSync(report.logPaths.scenarioJsonReport)).toBe(true);
    expect(fs.existsSync(report.logPaths.scenarioMarkdownReport)).toBe(true);
  });

  it('NoProgressWatchdog aborts execution when bot makes zero physical progress for timeout budget', async () => {
    const mockBot = createMockBot(new Vec3(5, 64, 5));
    const abortController = new AbortController();
    let trippedReason = '';

    const watchdog = new NoProgressWatchdog(mockBot, abortController, {
      noProgressTimeoutMs: 150,
      checkIntervalMs: 50,
      onTrip: (reason) => {
        trippedReason = reason;
      },
    });

    expect(watchdog.tripped).toBe(false);
    watchdog.start();

    // Wait 250ms with 0 movement or inventory delta
    await new Promise((r) => setTimeout(r, 250));

    expect(watchdog.tripped).toBe(true);
    expect(trippedReason).toContain('No-progress watchdog tripped');
    expect(abortController.signal.aborted).toBe(true);
    watchdog.stop();
  });

  it('distinguishes command acceptance from physical completion and evaluates contract assertions with observer', async () => {
    // Mock working observer bridge client
    const mockBridgeClient: any = {
      checkHealth: vi.fn().mockResolvedValue({
        ok: true,
        status: 'ACTIVE',
        serverRunId: 'test_srv_123',
        currentSeq: 42,
      }),
      getSnapshot: vi.fn().mockResolvedValue({
        timestamp: new Date().toISOString(),
        dimension: 'minecraft:overworld',
        playerName: '1357koushik',
        position: { x: 10, y: 64, z: 10 },
        health: 20,
        food: 20,
        inventory: { oak_log: 0 },
        onlinePlayers: ['1357koushik', 'dragonai'],
      }),
      bindAction: vi.fn().mockResolvedValue({ ok: true, seq: 43 }),
      unbindAction: vi.fn().mockResolvedValue({ ok: true, seq: 44 }),
      readEventsForAction: vi.fn().mockResolvedValue([
        {
          seq: 43,
          timestamp: new Date().toISOString(),
          serverRunId: 'test_srv_123',
          dimension: 'minecraft:overworld',
          eventType: 'BLOCK_BREAK',
          blockId: 'oak_log',
          coordinates: { x: 11, y: 64, z: 10 },
        },
      ]),
    };

    const runner = new IntegrationScenarioRunner({
      bridgeClient: mockBridgeClient,
      reportsDir: testOutputDir,
    });

    // Mock bot with a nearby log block
    const mockBot = createMockBot(new Vec3(10, 64, 10));
    mockBot.findBlock.mockReturnValue({
      name: 'oak_log',
      position: new Vec3(11, 64, 10),
    });

    // Run custom test scenario
    const testScenario: ScenarioDefinition = {
      id: 'mock_test_scenario',
      name: 'Mock Test Log Gathering Action',
      contractId: 'chop_tree',
      targetAction: 'wait', // use wait action for predictable pass
      params: { seconds: 0.1 },
      phaseBudgets: {
        setupTimeoutMs: 2000,
        actionTimeoutMs: 3000,
        settlingTimeoutMs: 500,
        noProgressTimeoutMs: 2000,
      },
      preconditionCheck: async () => ({ ok: true }),
      assertions: async (ctx, exec) => [
        {
          name: 'command_accepted',
          passed: exec.agentResult !== null && exec.agentResult.status === 'success',
          expected: 'success',
          actual: exec.agentResult?.status,
          message: 'Action completed successfully',
        },
        {
          name: 'observer_event_captured',
          passed: exec.events.some((e) => e.eventType === 'BLOCK_BREAK'),
          expected: 'BLOCK_BREAK',
          actual: exec.events[0]?.eventType,
          message: 'Server observer captured BLOCK_BREAK event',
        },
      ],
    };

    const report = await runner.runScenario(testScenario, mockBot);

    expect(report.status).toBe('PASS');
    expect(report.commandAccepted).toBe(true);
    expect(report.physicalCompleted).toBe(true);
    expect(report.observedServerEvents.length).toBe(1);
    expect(report.assertions.length).toBe(2);
    expect(report.assertions.every((a) => a.passed)).toBe(true);
    expect(report.progressMilestones.length).toBeGreaterThanOrEqual(5);

    // Verify reports generated and structured
    expect(fs.existsSync(report.logPaths.scenarioJsonReport)).toBe(true);
    expect(fs.existsSync(report.logPaths.scenarioMarkdownReport)).toBe(true);

    const jsonContent = JSON.parse(fs.readFileSync(report.logPaths.scenarioJsonReport, 'utf8'));
    expect(jsonContent.scenarioId).toBe('mock_test_scenario');
    expect(jsonContent.status).toBe('PASS');
    expect(jsonContent.phaseBudgets.actionTimeoutMs).toBe(3000);

    const mdContent = fs.readFileSync(report.logPaths.scenarioMarkdownReport, 'utf8');
    expect(mdContent).toContain('# Scenario Execution Report: Mock Test Log Gathering Action');
    expect(mdContent).toContain('🟢 **PASS**');
    expect(mdContent).toContain('`command_accepted`');
  });

  it('guarantees cleanup is executed in finally path even when scenario throws or times out', async () => {
    let cleanupExecuted = false;

    const mockBridgeClient: any = {
      checkHealth: vi.fn().mockResolvedValue({ ok: true, status: 'ACTIVE', serverRunId: 'srv' }),
      getSnapshot: vi.fn().mockResolvedValue({
        timestamp: new Date().toISOString(),
        dimension: 'overworld',
        playerName: '1357koushik',
      }),
      bindAction: vi.fn().mockResolvedValue({ ok: true }),
      unbindAction: vi.fn().mockResolvedValue({ ok: true }),
      readEventsForAction: vi.fn().mockResolvedValue([]),
    };

    const runner = new IntegrationScenarioRunner({
      bridgeClient: mockBridgeClient,
      reportsDir: testOutputDir,
    });

    const failingScenario: ScenarioDefinition = {
      id: 'failing_timeout_scenario',
      name: 'Failing Timeout Scenario',
      contractId: 'goto',
      targetAction: 'wait',
      params: { seconds: 10 },
      phaseBudgets: {
        setupTimeoutMs: 1000,
        actionTimeoutMs: 200, // Very tight action budget to force timeout
        settlingTimeoutMs: 200,
        noProgressTimeoutMs: 2000,
      },
      preconditionCheck: async () => ({ ok: true }),
      assertions: async () => [],
      cleanup: async () => {
        cleanupExecuted = true;
      },
    };

    const mockBot = createMockBot();
    const report = await runner.runScenario(failingScenario, mockBot);

    expect(report.status).toBe('FAIL');
    expect(report.timedOut).toBe(true);
    expect(cleanupExecuted).toBe(true);
    expect(report.progressMilestones.some((m) => m.phase === 'CLEANUP')).toBe(true);
  });

  it('validates unreachableTargetScenario assertions for rejection without stall', async () => {
    const mockContext: any = {
      recordMilestone: vi.fn(),
      bot: createMockBot(new Vec3(0, 64, 0)),
    };

    // Precondition check passes when target is 35 blocks above
    unreachableTargetScenario.params.y = 100;
    const pre = await unreachableTargetScenario.preconditionCheck(mockContext);
    expect(pre.ok).toBe(true);

    // Assertions check rejection
    const assertions = await unreachableTargetScenario.assertions(mockContext, {
      agentResult: {
        status: 'failed',
        reason: 'Target is unreachable: deep chasm drop or no ground support.',
        details: { attempt: 1 },
      },
      beforeSnapshot: null,
      afterSnapshot: null,
      events: [],
      contract: null,
    });

    expect(assertions.length).toBe(4);
    expect(assertions.every((a) => a.passed)).toBe(true);
  });

  it('validates cancelMovementScenario assertions for halted movement without superseded side effects', async () => {
    const mockBot = createMockBot(new Vec3(0, 64, 0));
    const mockContext: any = {
      bot: mockBot,
      recordMilestone: vi.fn(),
    };

    cancelMovementScenario.params.x = 20;
    cancelMovementScenario.params.y = 64;
    cancelMovementScenario.params.z = 0;

    // Bot stopped at (2, 64, 0) - early before reaching (20, 64, 0)
    mockBot.entity.position = new Vec3(2, 64, 0);

    const assertions = await cancelMovementScenario.assertions(mockContext, {
      agentResult: {
        status: 'interrupted',
        reason: 'Action cancelled via AbortSignal',
      },
      beforeSnapshot: null,
      afterSnapshot: null,
      events: [],
      contract: null,
    });

    expect(assertions.length).toBe(3);
    expect(assertions.every((a) => a.passed)).toBe(true);
  });
});
