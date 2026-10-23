import { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { loadConfig, AppConfig } from '../config/index.js';
import { actionMap } from '../actions/registry.js';
import { ACTION_CONTRACT_MANIFEST } from '../contracts/index.js';
import { ActionContract, ContractManifest } from '../contracts/types.js';
import { ActionExecutionContext, ActionResult, Observation } from '../types/index.js';
import {
  ScenarioDefinition,
  ScenarioReport,
  ScenarioExecutionContext,
  ScenarioPhase,
  ScenarioPhaseBudgets,
  AssertionResult,
  ServerObserverSnapshot,
  FixtureOperator,
} from './types.js';
import { NoProgressWatchdog } from './watchdog.js';
import { VanillaBridgeClient } from './bridge_client.js';
import { saveScenarioReports } from './report.js';

export interface ScenarioRunnerOptions {
  config?: AppConfig;
  manifest?: ContractManifest;
  bridgeClient?: VanillaBridgeClient;
  fixtureOperator?: FixtureOperator;
  reportsDir?: string;
  logger?: any;
}

export const ACTION_NAME_ALIASES: Record<string, string> = {
  attack_entity: 'attack',
  block_shield: 'block_with_shield',
  consume_food: 'eat',
  deposit_to_container: 'deposit',
  withdraw_from_container: 'withdraw',
  read_container: 'open_container',
  tidy_inventory: 'manage_full_inventory',
  sort_inventory: 'manage_full_inventory',
  craft_recipe_pipeline: 'craft_pipeline',
  sleep_in_bed: 'sleep',
  wake_up: 'wake',
  follow_entity: 'follow',
  drop_item: 'drop',
  equip_item: 'equip',
  whisper: 'chat',
  feed_animal: 'interact_entity',
  tame_animal: 'interact_entity',
  breed_animals: 'interact_entity',
  interact_with_block: 'interact_block',
  interact_with_entity: 'interact_entity',
  use_item_on_block: 'interact_block',
  till_soil: 'till',
};

export class IntegrationScenarioRunner {
  private config: AppConfig;
  private manifest: ContractManifest;
  private bridgeClient: VanillaBridgeClient;
  private fixtureOperator?: FixtureOperator;
  private reportsDir: string;
  private logger: any;

  constructor(options: ScenarioRunnerOptions = {}) {
    this.config = options.config || loadConfig();
    this.manifest = options.manifest || ACTION_CONTRACT_MANIFEST;
    this.bridgeClient = options.bridgeClient || new VanillaBridgeClient();
    this.fixtureOperator = options.fixtureOperator;
    this.reportsDir = options.reportsDir || 'logs/integration/scenarios';
    this.logger = options.logger || console;
  }

  public get client(): VanillaBridgeClient {
    return this.bridgeClient;
  }

  public async runScenario(
    definition: ScenarioDefinition,
    bot: Bot,
    customBudgets?: Partial<ScenarioPhaseBudgets>
  ): Promise<ScenarioReport> {
    const runId = `run_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const actionId = `act_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const goalId = `goal_${definition.id}_${Date.now()}`;
    const traceId = `trace_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

    const startTime = new Date().toISOString();
    const startWallClock = Date.now();

    const budgets: ScenarioPhaseBudgets = {
      setupTimeoutMs: customBudgets?.setupTimeoutMs ?? definition.phaseBudgets?.setupTimeoutMs ?? 5000,
      actionTimeoutMs: customBudgets?.actionTimeoutMs ?? definition.phaseBudgets?.actionTimeoutMs ?? 20000,
      settlingTimeoutMs: customBudgets?.settlingTimeoutMs ?? definition.phaseBudgets?.settlingTimeoutMs ?? 1500,
      noProgressTimeoutMs: customBudgets?.noProgressTimeoutMs ?? definition.phaseBudgets?.noProgressTimeoutMs ?? 5000,
    };

    const contract: ActionContract | null =
      this.manifest.registeredActions[definition.contractId] ||
      this.manifest.registeredActions[definition.targetAction] ||
      this.manifest.compositeTechniques[definition.contractId] ||
      this.manifest.compositeTechniques[definition.targetAction] ||
      this.manifest.systemAndReflexContracts[definition.contractId] ||
      this.manifest.systemAndReflexContracts[definition.targetAction] ||
      null;

    const report: ScenarioReport = {
      scenarioId: definition.id,
      name: definition.name,
      runId,
      targetMinecraftVersion: '1.21.6',
      serverImplementation: 'Vanilla 1.21.6 (Observer sidecar instrumented)',
      worldId: 'dragon_world',
      playerIdentity: {
        username: bot?.username || 'dragonai',
        uuid: (bot?.entity as any)?.uuid || undefined,
      },
      observerIdentity: {
        username: '1357koushik',
        bridgePort: 25580,
        connected: false,
      },
      startTime,
      endTime: '',
      durationMs: 0,
      status: 'NOT_RUN',
      statusReason: '',
      phaseBudgets: budgets,
      preconditions: { checked: false, passed: false },
      beforeSnapshot: null,
      actionSubmission: {
        actionName: definition.targetAction,
        params: definition.params,
        actionId,
        goalId,
        traceId,
        contractId: definition.contractId,
      },
      agentReportedResult: null,
      commandAccepted: false,
      physicalCompleted: false,
      timedOut: false,
      cancelled: false,
      retriesCount: 0,
      progressMilestones: [],
      afterSnapshot: null,
      observedServerEvents: [],
      expectedResult: {
        contractDescription: contract?.expectedEffects?.contractDescription || `Contract for ${definition.targetAction}`,
        testCaseContract: contract?.expectedEffects?.testCaseContract || definition.name,
        invariants: contract?.expectedEffects?.invariants || [],
        postconditions: contract?.expectedEffects?.postconditions || [],
      },
      actualResult: {
        definitionOfActual: 'Independent server-observer event log + before/after snapshot state comparison',
        observedEventsCount: 0,
        finalCoordinates: null,
        inventoryDeltas: {},
      },
      assertions: [],
      reproductionRecipe: '',
      logPaths: {
        scenarioJsonReport: '',
        scenarioMarkdownReport: '',
      },
    };

    const recordMilestone = (phase: ScenarioPhase, message: string, details?: any) => {
      const elapsedMs = Date.now() - startWallClock;
      report.progressMilestones.push({
        timestamp: new Date().toISOString(),
        phase,
        message,
        elapsedMs,
        details,
      });
      this.logger?.info?.(`[Runner:${definition.id}][+${elapsedMs}ms][${phase}] ${message}`);
    };

    const abortController = new AbortController();

    const executionContext: ScenarioExecutionContext = {
      bot,
      observerSnapshotHandler: () => this.bridgeClient.getSnapshot(),
      queryObserverEvents: (actId: string) => this.bridgeClient.readEventsForAction(actId),
      recordMilestone,
      abortController,
      runId,
      actionId,
      goalId,
      traceId,
      logger: this.logger,
      config: this.config,
      fixtureOperator: this.fixtureOperator,
    };

    let watchdog: NoProgressWatchdog | null = null;
    let serverRunId: string | undefined;

    try {
      recordMilestone('INIT', `Initialized scenario execution for '${definition.id}' (contract: ${definition.contractId})`);

      // 1. Check Observer Bridge Connectivity
      const health = await this.bridgeClient.checkHealth();
      if (!health.ok) {
        report.status = 'INCONCLUSIVE';
        report.statusReason = `Server observer bridge is unreachable or offline (${health.status}). Cannot execute scenario without ground-truth oracle.`;
        recordMilestone('INIT', `Observer health check failed: ${health.status}`);
        return this.finalizeReport(report, startWallClock);
      }
      report.observerIdentity.connected = true;
      serverRunId = health.serverRunId;
      recordMilestone('INIT', `Observer verified ACTIVE on bridge (serverRunId: ${serverRunId}, seq: ${health.currentSeq})`);

      // 2. SETUP Phase
      if (definition.setup) {
        recordMilestone('SETUP', `Running scenario fixture setup (timeout: ${budgets.setupTimeoutMs}ms)...`);
        try {
          await this.withTimeout(
            definition.setup(executionContext),
            budgets.setupTimeoutMs,
            'Setup phase exceeded timeout budget'
          );
          recordMilestone('SETUP', 'Scenario fixture setup completed successfully.');
        } catch (err: any) {
          report.status = 'BLOCKED';
          report.statusReason = `Setup fixture failed: ${err.message}`;
          recordMilestone('SETUP', `Setup failed: ${err.message}`);
          return this.finalizeReport(report, startWallClock);
        }
      }

      // 3. PRECONDITION Phase & Before Snapshot
      recordMilestone('PRECONDITION', 'Capturing independent server before-snapshot...');
      const beforeSnapshot = await this.bridgeClient.getSnapshot();
      if (!beforeSnapshot) {
        report.status = 'INCONCLUSIVE';
        report.statusReason = 'Observer bridge returned null before-snapshot. Cannot establish baseline state.';
        recordMilestone('PRECONDITION', 'Failed to retrieve before-snapshot.');
        return this.finalizeReport(report, startWallClock);
      }
      report.beforeSnapshot = beforeSnapshot;

      recordMilestone('PRECONDITION', 'Verifying scenario preconditions...');
      const preCheck = await definition.preconditionCheck(executionContext);
      report.preconditions.checked = true;
      report.preconditions.passed = preCheck.ok;
      report.preconditions.reason = preCheck.reason;

      if (!preCheck.ok) {
        report.status = 'BLOCKED';
        report.statusReason = `Preconditions not met: ${preCheck.reason || 'unmet requirement'}`;
        recordMilestone('PRECONDITION', `Precondition check failed: ${preCheck.reason}`);
        return this.finalizeReport(report, startWallClock);
      }
      recordMilestone('PRECONDITION', 'Preconditions successfully verified.');

      // 4. ACTION Phase
      recordMilestone('ACTION', `Binding action on observer bridge: ${definition.targetAction} (${actionId})...`);
      await this.bridgeClient.bindAction(runId, goalId, actionId, definition.targetAction);

      // Verify action exists in live action registry or known aliases
      const resolvedActionName = ACTION_NAME_ALIASES[definition.targetAction] || definition.targetAction;
      const actionDef = actionMap.get(resolvedActionName);
      if (!actionDef) {
        report.commandAccepted = false;
        report.status = 'BLOCKED';
        report.statusReason = `Target action '${definition.targetAction}' is not registered in live actionMap.`;
        recordMilestone('ACTION', `Action '${definition.targetAction}' missing from registry.`);
        return this.finalizeReport(report, startWallClock);
      }
      report.commandAccepted = true;

      // Start No-Progress Watchdog
      watchdog = new NoProgressWatchdog(bot, abortController, {
        noProgressTimeoutMs: budgets.noProgressTimeoutMs,
        onTrip: (reason) => {
          recordMilestone('ACTION', `No-Progress Watchdog tripped: ${reason}`);
        },
      });
      watchdog.start();

      // Build Action Execution Context
      const actionCtx: ActionExecutionContext = {
        bot,
        observation: this.buildObservationFromBot(bot, goalId),
        abortSignal: abortController.signal,
        logger: this.logger,
        config: this.config,
        actionId,
        isCurrent: () => !abortController.signal.aborted,
      };

      recordMilestone('ACTION', `Executing action '${definition.targetAction}' (timeout: ${budgets.actionTimeoutMs}ms)...`, definition.params);

      let agentResult: ActionResult | null = null;
      try {
        agentResult = await this.withTimeout(
          actionDef.execute(bot, definition.params, actionCtx),
          budgets.actionTimeoutMs,
          `Action execution exceeded timeout budget (${budgets.actionTimeoutMs}ms)`
        );
        report.agentReportedResult = agentResult;
        recordMilestone('ACTION', `Action finished with agent status: ${agentResult?.status} (${agentResult?.reason || 'no reason'})`);
      } catch (err: any) {
        if (watchdog?.tripped) {
          report.timedOut = true;
          report.statusReason = watchdog.reason;
          report.agentReportedResult = { status: 'failed', reason: watchdog.reason };
          recordMilestone('ACTION', `Action aborted by watchdog: ${watchdog.reason}`);
        } else if (abortController.signal.aborted) {
          report.cancelled = true;
          report.agentReportedResult = { status: 'interrupted', reason: 'Action cancelled via AbortSignal' };
          recordMilestone('ACTION', 'Action execution interrupted via AbortSignal.');
        } else if (err.message?.includes('timeout budget')) {
          report.timedOut = true;
          report.statusReason = err.message;
          report.agentReportedResult = { status: 'failed', reason: err.message };
          recordMilestone('ACTION', `Action timed out: ${err.message}`);
        } else {
          report.statusReason = `Runtime error in action: ${err.message}`;
          report.agentReportedResult = { status: 'failed', reason: err.message };
          recordMilestone('ACTION', `Action threw error: ${err.message}`);
        }
      } finally {
        watchdog?.stop();
      }

      // 5. SETTLING Phase
      recordMilestone('SETTLING', `Settling observation window (${budgets.settlingTimeoutMs}ms)...`);
      await new Promise((resolve) => setTimeout(resolve, budgets.settlingTimeoutMs));
      await this.bridgeClient.unbindAction();
      recordMilestone('SETTLING', 'Action unbound on bridge and settling window concluded.');

      // 6. ASSERTION Phase & After Snapshot
      recordMilestone('ASSERTION', 'Capturing independent server after-snapshot...');
      const afterSnapshot = await this.bridgeClient.getSnapshot();
      report.afterSnapshot = afterSnapshot;
      if (!afterSnapshot) {
        report.status = 'INCONCLUSIVE';
        report.statusReason = 'Observer bridge returned null after-snapshot. Cannot evaluate final ground-truth state.';
        recordMilestone('ASSERTION', 'Failed to retrieve after-snapshot.');
        return this.finalizeReport(report, startWallClock);
      }

      // Query server events captured during action execution
      recordMilestone('ASSERTION', 'Querying server observer event log for action window...');
      const events = await this.bridgeClient.readEventsForAction(actionId, serverRunId);
      report.observedServerEvents = events;
      report.actualResult.observedEventsCount = events.length;
      report.actualResult.finalCoordinates = afterSnapshot.position || (bot.entity ? { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z } : null);

      // Inventory delta accounting
      report.actualResult.inventoryDeltas = this.computeInventoryDeltas(
        beforeSnapshot.inventory,
        afterSnapshot.inventory
      );

      recordMilestone('ASSERTION', `Retrieved ${events.length} observed server events. Evaluating assertions...`);

      const assertionResults = await definition.assertions(executionContext, {
        agentResult: report.agentReportedResult,
        beforeSnapshot,
        afterSnapshot,
        events,
        contract,
      });

      report.assertions = assertionResults;

      // Determine final result status
      const allPassed = assertionResults.length > 0 && assertionResults.every((a) => a.passed);
      if (watchdog?.tripped) {
        report.status = 'FAIL';
        report.statusReason = watchdog.reason;
      } else if (report.timedOut && !report.cancelled) {
        report.status = 'FAIL';
        report.statusReason = report.statusReason || 'Action timed out without progress.';
      } else if (allPassed) {
        report.status = 'PASS';
        report.statusReason = 'All scenario contract assertions and server-observer invariants passed.';
        report.physicalCompleted = true;
      } else {
        report.status = 'FAIL';
        const failedCount = assertionResults.filter((a) => !a.passed).length;
        report.statusReason = `${failedCount} of ${assertionResults.length} contract assertion(s) failed.`;
      }

      recordMilestone('ASSERTION', `Final Scenario Status: ${report.status} (${report.statusReason})`);
      return this.finalizeReport(report, startWallClock);
    } finally {
      // 7. CLEANUP Phase (Guaranteed execution in finally block)
      if (definition.cleanup) {
        try {
          recordMilestone('CLEANUP', 'Executing scenario cleanup...');
          await definition.cleanup(executionContext);
          recordMilestone('CLEANUP', 'Scenario cleanup completed.');
        } catch (cleanupErr: any) {
          this.logger?.warn?.(`[Runner:${definition.id}] Cleanup error: ${cleanupErr.message}`);
        }
      }
      watchdog?.stop();
    }
  }

  private finalizeReport(report: ScenarioReport, startWallClock: number): ScenarioReport {
    const endWallClock = Date.now();
    report.endTime = new Date().toISOString();
    report.durationMs = endWallClock - startWallClock;

    if (report.status === 'FAIL') {
      report.reproductionRecipe = `npm test -- tests/integration_scenarios.test.ts -t "${report.scenarioId}"`;
    }

    try {
      saveScenarioReports(report, this.reportsDir);
    } catch (saveErr: any) {
      this.logger?.error?.(`Failed saving scenario reports: ${saveErr.message}`);
    }

    return report;
  }

  private computeInventoryDeltas(
    before?: Record<string, number>,
    after?: Record<string, number>
  ): Record<string, number> {
    const deltas: Record<string, number> = {};
    const allKeys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
    for (const key of allKeys) {
      const b = before?.[key] || 0;
      const a = after?.[key] || 0;
      if (a !== b) {
        deltas[key] = a - b;
      }
    }
    return deltas;
  }

  private buildObservationFromBot(bot: Bot, currentGoal: string): Observation {
    const pos = bot.entity?.position ?? new Vec3(0, 64, 0);
    const invMap: Record<string, number> = {};
    if (bot.inventory) {
      for (const item of bot.inventory.items()) {
        invMap[item.name] = (invMap[item.name] || 0) + (item.count || 1);
      }
    }

    return {
      version: '1.21.6',
      timestamp: Date.now(),
      vitals: {
        health: bot.health ?? 20,
        food: bot.food ?? 20,
        oxygen: (bot as any).oxygenLevel ?? 20,
        isAlive: (bot.health ?? 20) > 0,
        armor: 0,
        underwater: Boolean((bot.entity as any)?.isInWater),
        isBurning: false,
        movementState: {
          onGround: bot.entity?.onGround ?? true,
          inWater: Boolean((bot.entity as any)?.isInWater),
          isSleeping: false,
          isRiding: false,
        },
      } as any,
      position: {
        x: Math.round(pos.x * 100) / 100,
        y: Math.round(pos.y * 100) / 100,
        z: Math.round(pos.z * 100) / 100,
        blockCoords: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) },
        velocity: bot.entity?.velocity ? { x: bot.entity.velocity.x, y: bot.entity.velocity.y, z: bot.entity.velocity.z } : { x: 0, y: 0, z: 0 },
        yaw: bot.entity?.yaw || 0,
        pitch: bot.entity?.pitch || 0,
        facing: 'north',
        dimension: bot.game?.dimension || 'overworld',
      } as any,
      environment: {
        dayPhase: 'day',
        weather: 'clear',
      } as any,
      statusEffects: [],
      inventory: {
        mainHand: (bot as any).heldItem?.name || null,
        offHand: null,
        heldItemHint: (bot as any).heldItem?.name || 'empty',
        aggregates: { totalItemCounts: invMap },
        toolSummary: {},
        craftableNow: [],
        foodList: [],
        placeableBlocks: {},
      } as any,
      crosshair: { block: null, entity: null } as any,
      blocks: {
        notableBlocks: [],
        hazards: [],
        walkability: { forward: true, back: true, left: true, right: true },
        localMap: { ascii: '', legend: {} },
      } as any,
      entities: [],
      recentEvents: {} as any,
      container: { isOpen: false, type: null, slotsCount: 0, items: [] },
      agentState: {
        currentGoal,
        planSteps: [],
        stepNumber: 1,
        stuckCounter: 0,
        timeSinceLastProgressSeconds: 0,
      },
      memory: {
        namedLocations: {},
        facts: [],
        dangerZones: [],
        completedGoals: [],
      },
      derived: {
        availableActions: [],
      },
    };
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMsg: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(timeoutMsg));
      }, timeoutMs);

      promise
        .then((res) => {
          clearTimeout(timer);
          resolve(res);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }
}
