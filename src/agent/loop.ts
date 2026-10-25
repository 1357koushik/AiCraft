import { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { AppConfig } from '../config/index.js';
import { AgentLogger } from '../utils/logger.js';
import { MemoryManager } from '../memory/index.js';
import { SafetyManager, isAlive } from '../safety/index.js';
import { ReflexLayer } from './reflex.js';
import { StuckDetector } from './stuck.js';
import { ActionArbiter, ActionPriority } from './arbiter.js';
import { SafetySupervisor } from './supervisor.js';
import { buildObservation } from '../perception/index.js';
import { WorldStateTracker } from '../perception/world_state.js';
import { AvailabilityEngine } from '../actions/availability.js';
import { TaskExecutor, parseAndValidateGoalSpec, getBotInventoryCounts } from './goals.js';
import { validateActionParams } from '../prompt/schema.js';
import { ILLMProvider, Observation, RecentEventsState, ActionResult } from '../types/index.js';
import { buildSystemPrompt, buildUserPrompt } from '../prompt/index.js';
import { distance3D } from '../utils/math.js';
import { DiagnosticSnapshot } from '../runner/metrics_aggregator.js';

export const SERVER_LAG_TOLERANCE_MS = 500;

export class AgentController {
  private bot: Bot;
  private config: AppConfig;
  private logger: AgentLogger;
  private memory: MemoryManager;
  private safety: SafetyManager;
  private reflex: ReflexLayer;
  private stuckDetector: StuckDetector;
  private arbiter: ActionArbiter;
  private safetySupervisor: SafetySupervisor;
  private worldState: WorldStateTracker;
  private taskExecutor: TaskExecutor;
  private llmProvider: ILLMProvider;
  private respawnTimer: NodeJS.Timeout | null = null;
  private autosaveTimer: NodeJS.Timeout | null = null;
  private recentAttackedTargets: Map<number, number> = new Map();

  private isRunning = false;
  private isPaused = false;
  private stepApproved = false;
  private boundListeners: Array<{ event: string; listener: (...args: any[]) => void }> = [];
  private recentEvents: RecentEventsState = {
    damageTaken: [],
    healthRegained: 0,
    itemsPickedUp: [],
    itemsBroken: [],
    blocksBroken: [],
    blocksPlaced: [],
    mobsKilled: [],
    nearbyEntityDeaths: [],
    deathRespawn: false,
    chatMessages: [],
  };

  constructor(
    bot: Bot,
    config: AppConfig,
    logger: AgentLogger,
    memory: MemoryManager,
    safety: SafetyManager,
    llmProvider: ILLMProvider
  ) {
    this.bot = bot;
    this.config = config;
    this.logger = logger;
    this.memory = memory;
    this.safety = safety;
    this.reflex = new ReflexLayer(config, logger);
    this.stuckDetector = new StuckDetector();
    this.arbiter = new ActionArbiter(logger);
    this.llmProvider = llmProvider;
    this.worldState = new WorldStateTracker(logger.logger);
    this.safetySupervisor = new SafetySupervisor({
      bot,
      arbiter: this.arbiter,
      reflexLayer: this.reflex,
      logger: this.logger.logger,
      config,
    });
    this.taskExecutor = new TaskExecutor(this.logger.logger);

    this.setupEventListeners();
  }

  public get actionArbiter(): ActionArbiter {
    return this.arbiter;
  }

  public get reflexLayer(): ReflexLayer {
    return this.reflex;
  }

  public get supervisor(): SafetySupervisor {
    return this.safetySupervisor;
  }

  public get stateTracker(): WorldStateTracker {
    return this.worldState;
  }

  public get goalExecutor(): TaskExecutor {
    return this.taskExecutor;
  }

  public pause(): void {
    this.isPaused = true;
    this.logger.info('Agent loop paused.');
  }

  public resume(): void {
    this.isPaused = false;
    this.logger.info('Agent loop resumed.');
  }

  public approveStep(): void {
    this.stepApproved = true;
    this.logger.info('Step approved.');
  }

  public toggleAutoAttack(enabled?: boolean): boolean {
    const newState = enabled !== undefined ? enabled : !this.reflex.isAutoAttackEnabled();
    this.reflex.setAutoAttackEnabled(newState);
    this.logger.info(`Auto-attack defense mode set to ${newState ? 'ENABLED' : 'DISABLED'}`);
    return newState;
  }

  public isAutoAttackEnabled(): boolean {
    return this.reflex.isAutoAttackEnabled();
  }

  public stop(): void {
    this.isRunning = false;
    if (this.autosaveTimer) {
      clearInterval(this.autosaveTimer);
      this.autosaveTimer = null;
    }
    this.cleanupEventListeners();
    try {
      this.memory.saveToDisk();
      this.logger.info('Flushed persistent memory to disk on stop.');
    } catch {}
    this.logger.info('Stopping agent loop...');
  }

  public async start(): Promise<void> {
    this.isRunning = true;
    this.logger.info('Agent loop started.');

    if (!this.autosaveTimer) {
      this.autosaveTimer = setInterval(() => {
        try {
          this.memory.saveToDisk();
          this.logger.debug?.('Periodic autosave flushed memory to disk.');
        } catch (err: any) {
          this.logger.error({ err }, 'Autosave error: ' + err.message);
        }
      }, 60000);
    }

    while (this.isRunning) {
      if (this.isPaused) {
        await new Promise((res) => setTimeout(res, 500));
        continue;
      }

      if (this.config.agent.stepMode && !this.stepApproved) {
        await new Promise((res) => setTimeout(res, 300));
        continue;
      }
      this.stepApproved = false;

      try {
        await this.step();
      } catch (err: any) {
        this.logger.error({ err }, `Error in agent step: ${err.message}`);
        await new Promise((res) => setTimeout(res, 2000));
      }

      // Small pause between decision turns
      await new Promise((res) => setTimeout(res, this.config.agent.heartbeatIntervalMs));
    }
  }

  private async step(): Promise<void> {
    const planStartTime = Date.now();
    this.memory.state.stepNumber++;
    const stepNum = this.memory.state.stepNumber;

    // Entity ID map: ensures consistent entity ID assignment (e1..eN) within this step
    const entityIdMap = new Map<number, string>();

    // 1. Initial quick perception for reflexes and availability
    const dummyObs = buildObservation(
      this.bot,
      this.config,
      this.memory.state,
      this.memory.notes,
      this.recentEvents,
      [],
      entityIdMap
    );

    // 2. Reflex layer: fast check without LLM latency (arbiter lock managed inside)
    const reflexResult = await this.safetySupervisor.evaluateUrgentSafety();
    if (reflexResult.triggered) {
      this.recentEvents.reflexFired = reflexResult.name;
      this.logger.info(`Handled reflex: ${reflexResult.name}`);
      return;
    }

    // 3. Compute available actions catalog
    const availableCatalog = AvailabilityEngine.computeAvailableCatalog(
      this.bot,
      dummyObs,
      this.config,
      this.logger.logger
    );

    // 4. Build complete structured observation
    const observation = buildObservation(
      this.bot,
      this.config,
      this.memory.state,
      this.memory.notes,
      this.recentEvents,
      availableCatalog,
      entityIdMap
    );

    // Deterministic plan progress verification: check inventory against active plan milestones
    this.memory.updatePlanProgress(observation.inventory.aggregates.totalItemCounts);

    this.logger.info(
      `[STEP ${stepNum}:STATE] HP: ${observation.vitals.health}/20 | Food: ${observation.vitals.food}/20 | Air: ${observation.vitals.oxygen}/300 | Pos: (${observation.position.x.toFixed(1)}, ${observation.position.y.toFixed(1)}, ${observation.position.z.toFixed(1)}) [${observation.position.biome}] | Held: ${observation.inventory.heldItemHint}`
    );
    const invItems = Object.entries(observation.inventory.aggregates.totalItemCounts)
      .map(([name, count]) => `${name} x${count}`)
      .slice(0, 10)
      .join(', ');
    this.logger.info(`[STEP ${stepNum}:INVENTORY] ${invItems || 'Empty'}`);

    const activeStep = observation.agentState.planSteps?.find((s) => !s.completed);
    if (activeStep) {
      this.logger.info(
        `[STEP ${stepNum}:ACTIVE_GOAL] Goal: "${observation.agentState.currentGoal}" | Active Task: "${activeStep.step}" [${activeStep.status}] (Progress: ${activeStep.currentCount}/${activeStep.targetCount ?? 1})`
      );
    }

    // 5. Stuck detection
    const stuckStatus = this.stuckDetector.check(observation, this.recentEvents.lastActionResult);
    if (stuckStatus.isStuck) {
      this.logger.warn(`Stuck condition detected: ${stuckStatus.reason}. Executing active unstick reposition.`);
      const { actionId, epoch } = this.arbiter.startAction(
        'unstick_reposition',
        ActionPriority.NORMAL,
        this.bot,
        ['movement', 'look']
      );
      try {
        this.bot.clearControlStates();
        // Jump and turn to face away from the obstacle
        this.bot.setControlState('jump', true);
        this.bot.setControlState('left', true);
        await new Promise((res) => setTimeout(res, 800));
        if (this.arbiter.isCurrent(actionId, epoch)) {
          this.bot.clearControlStates();
          this.bot.setControlState('forward', true);
          await new Promise((res) => setTimeout(res, 600));
        }
      } finally {
        this.arbiter.finishAction(actionId, epoch, this.bot);
      }
      this.stuckDetector.reset();
    }

    // 5.5. Deterministic Goal/Task Execution: execute ready deterministic task without LLM call
    const planLatencyMs = Date.now() - planStartTime;
    if (planLatencyMs > 50) {
      this.logger.debug?.(
        `[STEP ${stepNum}:PERF] Step planning latency ${planLatencyMs}ms exceeded 50ms tick budget (lag spike tolerance applied).`
      );
    }

    const readyTask = this.taskExecutor.getNextReadyTask();
    if (readyTask) {
      this.logger.info(
        `[STEP ${stepNum}:GOAL_EXECUTOR] Executing deterministic task '${readyTask.id}' (${readyTask.actionName}) for goal '${this.taskExecutor.activeGoal?.id}'. Bypassing LLM call.`
      );
      const taskResult = await this.taskExecutor.executeTask(
        readyTask,
        this.bot,
        this.arbiter,
        this.config,
        this.logger.logger,
        dummyObs
      );
      this.syncPlanStepsWithMemory();

      this.recentEvents.lastActionResult = {
        action: readyTask.actionName,
        status: taskResult.status === 'succeeded' ? 'success' : taskResult.status === 'failed' ? 'failed' : 'interrupted',
        reason: taskResult.failureReason || 'Deterministic task executed',
      };

      if (this.taskExecutor.isPlanCompleted()) {
        this.logger.info(`[GOAL_EXECUTOR] Goal '${this.taskExecutor.activeGoal?.id}' fully completed!`);
        try {
          this.bot.chat(`Goal completed: ${this.taskExecutor.activeGoal?.rawInstruction || this.taskExecutor.activeGoal?.id}`);
        } catch {}
        this.memory.setGoal('Survive the first day and gather resources', undefined, false);
      }
      this.clearOneShotEvents();
      return;
    }

    // 6. Build prompts and query LLM with bounded retries
    const systemPrompt = buildSystemPrompt(this.config);
    const userPrompt = buildUserPrompt(
      observation,
      availableCatalog,
      this.memory.rollingHistory,
      this.config
    );

    this.logger.info(`[STEP ${stepNum}:LLM_QUERY] Prompting ${this.llmProvider.name} with ${availableCatalog.length} available actions...`);
    let llmResponse = await this.llmProvider.generateDecision({ systemPrompt, userPrompt });
    let retries = 0;

    while (llmResponse.error && retries < this.config.agent.maxRetriesOnMalformedJson) {
      retries++;
      this.logger.warn(`LLM decision failed (${llmResponse.error}). Retry attempt ${retries}...`);
      const retryPrompt = `${userPrompt}\n\nCORRECTION: Previous attempt failed validation (${llmResponse.error}). Return a decision JSON object with exactly 1 action, for example:\n{\n  "decision_summary": "Chopping trees to gather logs for survival tools",\n  "goal": "Survive and gather resources",\n  "actions": [{"action": "chop_tree", "params": {}}]\n}`;
      llmResponse = await this.llmProvider.generateDecision({ systemPrompt, userPrompt: retryPrompt });
    }

    if (llmResponse.error || !llmResponse.decision) {
      this.logger.error(`Failed to get valid LLM decision after retries: ${llmResponse.error}. Idling safely.`);
      this.bot.clearControlStates();
      return;
    }

    this.logger.info(
      `[STEP ${stepNum}:LLM_RESPONSE] Latency: ${llmResponse.latencyMs}ms | Tokens: ${llmResponse.tokenUsage?.totalTokens ?? 'N/A'}`
    );
    const decision = llmResponse.decision;
    this.logger.info(`[STEP ${stepNum}:DECISION] Summary: "${decision.decision_summary}" | Goal: "${decision.goal}"`);
    this.logger.info(
      `[STEP ${stepNum}:PLANNED_ACTION] ${decision.actions.map((a) => `${a.action}(${JSON.stringify(a.params)})`).join(', ')}`
    );

    // In-game chat message from bot if specified
    if (decision.say) {
      try {
        this.bot.chat(decision.say.slice(0, 150));
      } catch {}
    }

    // Update memory if LLM requested notes or named locations
    if (decision.memory) {
      if (decision.memory.note) {
        this.memory.rememberFact(decision.memory.note);
      }
      if (decision.memory.namedLocation) {
        this.memory.rememberLocation(
          decision.memory.namedLocation.name,
          decision.memory.namedLocation.position
        );
      }
      if (decision.memory.dangerZone) {
        this.memory.addDangerZone(
          decision.memory.dangerZone.name,
          decision.memory.dangerZone.position,
          decision.memory.dangerZone.radius
        );
      }
    }

    // Update goal in memory (do not overwrite owner-specified goals, validate model proposals)
    if (decision.goal) {
      if (!this.memory.state.isOwnerGoal) {
        const validatedGoal = parseAndValidateGoalSpec(decision.goal, observation.inventory.aggregates.totalItemCounts, false);
        if (validatedGoal) {
          this.memory.state.currentGoal = decision.goal;
        } else {
          this.logger.warn(`Model suggested invalid goal "${decision.goal}"; preserving existing goal.`);
        }
      } else {
        this.logger.debug(
          `Preserving owner goal "${this.memory.state.currentGoal}" (ignoring model suggestion: "${decision.goal}")`
        );
      }
    }

    // 7. Execute action(s) in order with fresh observation before each step
    const executedActions: any[] = [];
    const actionResults: ActionResult[] = [];

    const maxActions = Math.min(this.config.agent.maxActionsPerStep || 1, 5);
    const actionsToRun = decision.actions.slice(0, maxActions);
    const batchStartTime = Date.now();
    const maxBatchDurationMs = 45000;

    for (let actionIdx = 0; actionIdx < actionsToRun.length; actionIdx++) {
      const item = actionsToRun[actionIdx];

      // Check overall batch timeout
      if (Date.now() - batchStartTime > maxBatchDurationMs) {
        actionResults.push({
          status: 'interrupted',
          reason: `Multi-action execution time limit (${maxBatchDurationMs}ms) exceeded.`,
        });
        break;
      }

      // Check bot vitality before every action in the batch
      if (!this.bot.entity || !isAlive(this.bot.entity)) {
        actionResults.push({
          status: 'failed',
          reason: 'Bot died or is dead; aborting remaining multi-action sequence.',
        });
        break;
      }

      // Rebuild fresh observation for subsequent actions in the sequence so assumptions are never stale
      const currentObs: Observation =
        actionIdx === 0
          ? observation
          : buildObservation(
              this.bot,
              this.config,
              this.memory.state,
              this.memory.notes,
              this.recentEvents,
              [],
              entityIdMap
            );

      // Validate model-proposed action parameters before execution
      const paramValidation = validateActionParams(item.action, item.params);
      if (!paramValidation.valid) {
        this.logger.warn(`Model action parameter validation failed for ${item.action}: ${paramValidation.reason}`);
        actionResults.push({ status: 'failed', reason: paramValidation.reason || 'Invalid parameters' });
        break;
      }

      // Safety check
      const safetyCheck = this.safety.validateActionSafety(item.action, item.params, currentObs);
      if (!safetyCheck.allowed) {
        this.logger.warn(`Safety rejected action ${item.action}: ${safetyCheck.reason}`);
        actionResults.push({ status: 'failed', reason: safetyCheck.reason || 'Safety rejected' });
        break;
      }

      // Revalidate action against fresh world state immediately before execution!
      const revalidation = AvailabilityEngine.revalidateAction(
        item.action,
        item.params,
        this.bot,
        currentObs,
        this.config,
        this.logger.logger
      );

      if (!revalidation.valid) {
        this.logger.warn(`Action ${item.action} invalid at execution time: ${revalidation.reason}`);
        actionResults.push({ status: 'failed', reason: revalidation.reason || 'Revalidation failed' });
        break;
      }

      const elapsed = Date.now() - batchStartTime;
      const remainingBatchMs = maxBatchDurationMs - elapsed;
      if (remainingBatchMs <= 500) {
        actionResults.push({
          status: 'interrupted',
          reason: `Multi-action execution time limit (${maxBatchDurationMs}ms) reached before action ${item.action}.`,
        });
        break;
      }

      // Execute action with bounded timeout and arbiter coordination
      this.logger.info(`[STEP ${stepNum}:DISPATCH] Action [${actionIdx + 1}/${actionsToRun.length}]: ${item.action} | Priority: NORMAL | Params: ${JSON.stringify(item.params)}`);
      executedActions.push(item);

      const actionTimeout = Math.min(25000, remainingBatchMs) + SERVER_LAG_TOLERANCE_MS;
      const { actionId, signal, epoch } = this.arbiter.startAction(item.action, ActionPriority.NORMAL, this.bot);
      let result: ActionResult;
      try {
        result = await AvailabilityEngine.executeWithTimeout(
          item.action,
          item.params,
          this.bot,
          currentObs,
          this.config,
          this.logger.logger,
          signal,
          actionTimeout,
          actionId,
          this.arbiter,
          epoch
        );
      } finally {
        this.arbiter.finishAction(actionId, epoch, this.bot);
      }

      actionResults.push(result);
      this.logger.info(`[STEP ${stepNum}:ACTION_RESULT] ${item.action} -> ${result.status.toUpperCase()} (${result.reason})`);

      // Store in recent events
      this.recentEvents.lastActionResult = {
        action: item.action,
        status: result.status,
        reason: result.reason,
      };

      // Stop batch execution on failure or interruption
      if (result.status !== 'success') {
        break;
      }
    }

    // 8. Update rolling history
    const primaryAction = executedActions[0]?.action || 'none';
    const primaryResult = actionResults[0]?.status || 'none';
    this.memory.addHistoryRecord({
      step: stepNum,
      summary: decision.decision_summary,
      action: primaryAction,
      result: primaryResult,
      timestamp: Date.now(),
    });

    // 9. Write JSONL step record to disk
    this.logger.recordStep({
      step: stepNum,
      timestamp: new Date().toISOString(),
      goal: decision.goal,
      vitals: {
        health: observation.vitals.health,
        food: observation.vitals.food,
        isAlive: observation.vitals.isAlive,
      },
      position: observation.position.blockCoords,
      decisionSummary: decision.decision_summary,
      selectedActions: executedActions,
      actionResults,
      latencyMs: llmResponse.latencyMs,
      tokens: llmResponse.tokenUsage
        ? {
            prompt: llmResponse.tokenUsage.promptTokens,
            completion: llmResponse.tokenUsage.completionTokens,
            total: llmResponse.tokenUsage.totalTokens,
          }
        : undefined,
      reflexFired: this.recentEvents.reflexFired,
    });

    // Clear one-shot recent events
    this.clearOneShotEvents();
  }

  private clearOneShotEvents(): void {
    this.recentEvents.damageTaken = [];
    this.recentEvents.healthRegained = 0;
    this.recentEvents.itemsPickedUp = [];
    this.recentEvents.itemsBroken = [];
    this.recentEvents.blocksBroken = [];
    this.recentEvents.blocksPlaced = [];
    this.recentEvents.mobsKilled = [];
    this.recentEvents.nearbyEntityDeaths = [];
    this.recentEvents.deathRespawn = false;
    this.recentEvents.chatMessages = [];
    this.recentEvents.reflexFired = undefined;
    this.memory.state.pendingOwnerInstruction = undefined;
  }

  private setupEventListeners(): void {
    // Intercept bot.attack to maintain defensible kill attribution
    const origAttack = typeof this.bot.attack === 'function' ? this.bot.attack.bind(this.bot) : null;
    if (origAttack) {
      (this.bot as any).attack = (entity: any, ...rest: any[]) => {
        if (entity?.id !== undefined) {
          this.recentAttackedTargets.set(entity.id, Date.now());
        }
        return (origAttack as any)(entity, ...rest);
      };
    }

    // Continuous asynchronous safety supervision (Phase 1, Layer 2)
    this.safetySupervisor.start();

    // Authoritative live world-state event reducer (Phase 2, Layer 1)
    this.worldState.attachBot(this.bot);

    // Health and damage
    this.addBotListener('health', () => {
      // Checked directly in vitals
    });

    // Death
    this.addBotListener('death', () => {
      this.logger.warn('Bot died! Recording death location and preempting running actions.');
      this.arbiter.preempt(this.bot, 'Bot died', ActionPriority.SURVIVAL_EMERGENCY);
      const pos = this.bot.entity?.position;
      if (pos) {
        this.memory.rememberLocation('last_death', {
          x: Math.round(pos.x),
          y: Math.round(pos.y),
          z: Math.round(pos.z),
        });
      }
      this.recentEvents.deathRespawn = true;
      try {
        this.captureDiagnosticSnapshot('Bot death event');
      } catch {}

      // Clean physical pathfinding and controls immediately
      try {
        (this.bot as any).pathfinder?.setGoal(null);
        (this.bot as any).pathfinder?.stop();
      } catch {}
      this.bot.clearControlStates();

      // Auto respawn after 1.5s
      if (this.respawnTimer) clearTimeout(this.respawnTimer);
      this.respawnTimer = setTimeout(() => {
        this.respawnTimer = null;
        try {
          this.bot.respawn();
          this.logger.info('Auto-respawn triggered.');
        } catch {}
      }, 1500);
    });

    // Chat messages (owner instructions & untrusted player chat)
    this.addBotListener('chat', (username: string, message: string) => {
      if (username === this.bot.username) return;

      const isOwner = this.config.agent.owners.includes(username);
      this.logger.info(`[Chat] <${username}> ${message} (isOwner: ${isOwner})`);

      this.recentEvents.chatMessages.push({
        sender: username,
        message,
        isOwner,
      });

      // Handle owner commands or instructions
      const sanitized = message.replace(/^[\s\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]+/, '');
      if (isOwner && (sanitized.startsWith('!') || sanitized.startsWith('/'))) {
        this.handleOwnerChatCommand(sanitized);
      } else if (isOwner) {
        this.memory.state.pendingOwnerInstruction = sanitized;
        this.memory.setGoal(sanitized, undefined, true);
        this.logger.info(`Owner instruction received: "${sanitized}". Updated active goal.`);

        const invCounts = getBotInventoryCounts(this.bot);
        const goalSpec = parseAndValidateGoalSpec(sanitized, invCounts, true);
        if (goalSpec) {
          const res = this.taskExecutor.setGoal(goalSpec, invCounts);
          if (res.accepted && this.taskExecutor.activePlan) {
            this.syncPlanStepsWithMemory();
          }
        }
      }
    });

    // Block break and place tracking
    this.addBotListener('blockBreakProgressEnd', (block: any) => {
      if (block?.name) this.recentEvents.blocksBroken.push(block.name);
    });

    // Player collection of dropped items: verifies that collector is this bot
    this.addBotListener('playerCollect', (collector: any, collected: any) => {
      const isBotCollector =
        collector === this.bot.entity ||
        (collector?.id !== undefined && this.bot.entity?.id !== undefined && collector.id === this.bot.entity.id) ||
        (collector?.username !== undefined && collector.username === this.bot.username);

      if (!isBotCollector) return;

      let itemName = 'unknown_item';
      let count = 1;

      try {
        if (!collected) {
          itemName = 'unknown_item';
        } else if (typeof collected?.getDroppedItem === 'function') {
          const item = collected.getDroppedItem();
          if (item) {
            itemName = item.name || itemName;
            count = item.count ?? count;
          }
        } else if (collected?.name && collected.name !== 'item') {
          itemName = collected.name;
        } else if (collected?.metadata && Array.isArray(collected.metadata)) {
          const itemMeta = collected.metadata.find((m: any) => m && (m.itemId !== undefined || m.name !== undefined));
          if (itemMeta?.name) {
            itemName = itemMeta.name;
          } else if (itemMeta?.itemId !== undefined && (this.bot as any).registry?.items?.[itemMeta.itemId]) {
            itemName = (this.bot as any).registry.items[itemMeta.itemId].name;
            count = itemMeta.itemCount ?? count;
          }
        }
      } catch {}

      this.logger.info(`Bot collected item drop: ${itemName} x${count}`);
      this.recentEvents.itemsPickedUp.push({ name: itemName, count });
    });

    // Mob death tracking: distinguishes verified bot kills from ambient/unrelated entity deaths
    this.addBotListener('entityDead', (entity: any) => {
      if (!entity || entity === this.bot.entity) return;
      if (entity.id !== undefined && this.bot.entity?.id !== undefined && entity.id === this.bot.entity.id) return;

      if (this.bot.entity?.position && entity.position) {
        const dist = distance3D(this.bot.entity.position, entity.position);
        if (dist > 16) return;
      }

      const entityName = entity.name || entity.displayName || entity.username || entity.type || 'unknown_mob';

      // Defensible kill attribution: bot must have directly attacked this entity within the last 5 seconds
      const lastAttackTime = entity.id !== undefined ? this.recentAttackedTargets.get(entity.id) : undefined;
      const isAttributedKill = lastAttackTime !== undefined && (Date.now() - lastAttackTime) < 5000;

      if (isAttributedKill) {
        this.logger.info(`Entity killed by bot: ${entityName} (id: ${entity.id})`);
        this.recentEvents.mobsKilled.push(entityName);
        if (entity.id !== undefined) this.recentAttackedTargets.delete(entity.id);
      } else {
        this.logger.info(`Nearby entity died without bot attack (environmental/third-party): ${entityName} (id: ${entity.id})`);
        this.recentEvents.nearbyEntityDeaths.push(entityName);
      }
    });

    // Entity hurt: verifies attacker from event source (Mineflayer damage_event / entityStatus)
    this.addBotListener('entityHurt', (entity: any, source?: any) => {
      if (!entity || entity !== this.bot.entity) return;

      if (!source) {
        // Environmental or unattributed damage (fall, fire, lava, cactus, suffocation, drowning)
        this.recentEvents.damageTaken.push({ amount: 1, source: 'environmental', timeAgoMs: 0 });
        this.logger.info('Bot took environmental/unattributed damage; no attacker entity identified.');
        return;
      }

      if (source === this.bot.entity) {
        // Self-inflicted damage
        this.recentEvents.damageTaken.push({ amount: 1, source: 'self', timeAgoMs: 0 });
        return;
      }

      const attackerName = source.username || source.name || source.type || 'unknown';
      this.recentEvents.damageTaken.push({ amount: 1, source: attackerName, timeAgoMs: 0 });
      this.logger.info(`Bot hurt by attacker: ${attackerName} (type: ${source.type || 'unknown'}, id: ${source.id})`);

      // Retaliation check: strictly opt-in, disabled by default
      if (!this.reflex.isAutoAttackEnabled()) return;

      // Do not override higher-priority survival emergencies (e.g. lava, drowning)
      if (this.bot.entity) {
        const isUnderLava = this.bot.blockAt(this.bot.entity.position)?.name === 'lava';
        const isDrowning = Boolean((this.bot.entity as any).isInWater) && (this.bot.oxygenLevel ?? 20) < 8;
        if (isUnderLava || isDrowning) {
          this.logger.warn('Retaliation suppressed: immediate survival emergency in progress.');
          return;
        }
      }

      // Safety immunity checks against owner and protected friends
      if (this.config.agent.owners.includes(attackerName) || this.config.agent.friends.includes(attackerName)) {
        this.logger.warn(`Attacker ${attackerName} is owner or friend. Retaliation strictly forbidden.`);
        return;
      }
      if (this.config.safety.protectedEntities.includes(source.type || attackerName)) {
        this.logger.warn(`Attacker ${source.type || attackerName} is protected entity. Retaliation forbidden.`);
        return;
      }

      // Projectiles (arrows, tridents, fireballs) are indirect damage; do not melee attack projectile entity
      const isProjectile =
        ['arrow', 'spectral_arrow', 'trident', 'fireball', 'small_fireball', 'llama_spit', 'wind_charge'].includes(source.name || '') ||
        source.type === 'projectile' ||
        source.type === 'object';
      if (isProjectile) {
        this.logger.info(`Damage caused by projectile entity (${source.name || source.type}). Direct melee retaliation skipped.`);
        return;
      }

      // Avoid rapid target twitching if currently engaging an active live target within radius
      const currentTargetId = this.reflex.getCurrentCombatTargetId();
      if (currentTargetId && currentTargetId !== source.id) {
        const activeTarget = this.bot.entities[currentTargetId];
        if (
          isAlive(activeTarget) &&
          distance3D(this.bot.entity.position, activeTarget.position) <= (this.config.safety.reflexes.autoAttackRadius || 4.5)
        ) {
          this.logger.info(`Damage taken from ${attackerName}, but bot is already engaging active target ${activeTarget.name || currentTargetId}.`);
          return;
        }
      }

      // Check attacker is loaded and alive using universal isAlive check
      const liveAttacker = this.bot.entities[source.id];
      if (!isAlive(liveAttacker)) return;

      const dist = distance3D(this.bot.entity.position, liveAttacker.position);
      const maxRadius = this.config.safety.reflexes.autoAttackRadius || 4.5;
      if (dist > maxRadius) return;

      this.reflex.autoDefendAttacker(this.bot, liveAttacker, this.arbiter).catch(() => {});
    });

    // Handle bot disconnection and kick events to preempt running tasks and persist state
    this.addBotListener('end', () => {
      this.logger.warn('Bot connection ended. Preempting active tasks and persisting state.');
      this.arbiter.preempt(this.bot, 'Bot disconnected', ActionPriority.SURVIVAL_EMERGENCY);
      try {
        this.memory.saveToDisk();
      } catch {}
      this.cleanupEventListeners();
    });

    this.addBotListener('kicked', (reason: any) => {
      const reasonStr = typeof reason === 'string' ? reason : JSON.stringify(reason);
      this.logger.warn(`Bot kicked from server (${reasonStr}). Preempting active tasks.`);
      this.arbiter.preempt(this.bot, 'Bot kicked', ActionPriority.SURVIVAL_EMERGENCY);
      this.cleanupEventListeners();
    });
  }

  private addBotListener(event: string, listener: (...args: any[]) => void): void {
    if (this.bot && typeof this.bot.on === 'function') {
      this.bot.on(event as any, listener);
      this.boundListeners.push({ event, listener });
    }
  }

  private handleOwnerChatCommand(commandText: string): void {
    const sanitized = commandText.replace(/^[\s\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]+/, '');
    const trimmed = sanitized.replace(/^[!/]/, '').trim();
    const [cmd, ...args] = trimmed.split(/\s+/);
    const argStr = args.join(' ');

    this.logger.info(`Executing owner command: ${cmd} "${argStr}"`);

    switch (cmd.toLowerCase()) {
      case 'stop':
      case 'pause':
        this.pause();
        this.arbiter.preempt(this.bot, 'Owner pause command', ActionPriority.OWNER_URGENT);
        this.bot.chat('Pausing AI decision loop.');
        break;
      case 'resume':
      case 'start':
        this.resume();
        this.bot.chat('Resuming AI decision loop.');
        break;
      case 'step':
        this.approveStep();
        this.bot.chat('Single step approved.');
        break;
      case 'attack':
      case 'defend':
      case 'autoattack': {
        const state = argStr.toLowerCase() === 'off' ? false : true;
        this.toggleAutoAttack(state);
        this.bot.chat(`Auto-attack mode set to ${state ? 'ENABLED' : 'DISABLED'}.`);
        break;
      }
      case 'cancel':
        this.taskExecutor.cancelGoal('Owner cancelled');
        this.memory.setGoal('Survive the first day and gather resources', undefined, false);
        this.memory.state.pendingOwnerInstruction = undefined;
        this.arbiter.preempt(this.bot, 'Owner cancel goal', ActionPriority.OWNER_URGENT);
        this.bot.chat('Active goal and tasks cancelled.');
        break;
      case 'goal':
        if (argStr) {
          const invCounts = getBotInventoryCounts(this.bot);
          const goalSpec = parseAndValidateGoalSpec(argStr, invCounts, true);
          if (goalSpec) {
            const res = this.taskExecutor.setGoal(goalSpec, invCounts);
            if (!res.accepted) {
              this.bot.chat(`Goal rejected: ${res.reason}`);
              return;
            }
            this.syncPlanStepsWithMemory();
          }
          this.memory.setGoal(argStr, undefined, true);
          this.memory.state.pendingOwnerInstruction = argStr;
          this.bot.chat(`New goal set: ${argStr}`);
        }
        break;
      case 'cleargoal':
      case 'clear_goal':
      case 'resetgoal':
      case 'reset_goal':
        this.taskExecutor.cancelGoal('Owner cleared goal');
        this.memory.setGoal('Survive the first day and gather resources', undefined, false);
        this.memory.state.pendingOwnerInstruction = undefined;
        this.bot.chat('Owner goal cleared; resuming autonomous goal selection.');
        break;
      default:
        this.bot.chat(`Unknown command '${cmd}'. Available: !stop, !resume, !step, !attack [on|off], !goal <text>, !cancel, !clear_goal`);
    }
  }

  private syncPlanStepsWithMemory(): void {
    if (!this.taskExecutor.activePlan) return;
    this.memory.state.planSteps = this.taskExecutor.activePlan.tasks.map((t) => ({
      step: `${t.actionName}: ${JSON.stringify(t.params)}`,
      completed: t.status === 'succeeded' || t.status === 'satisfied',
      status: t.status === 'succeeded' || t.status === 'satisfied' ? 'completed' : t.status === 'failed' ? 'failed' : 'in_progress',
      prerequisites: t.prerequisites,
    }));
  }

  public cleanupEventListeners(): void {
    this.safetySupervisor.stop();
    this.worldState.detachBot();
    if (this.bot && this.boundListeners.length > 0) {
      for (const { event, listener } of this.boundListeners) {
        try {
          if (typeof this.bot.removeListener === 'function') {
            this.bot.removeListener(event as any, listener);
          }
        } catch {}
      }
      this.boundListeners = [];
    }
  }

  public captureDiagnosticSnapshot(failureReason: string): DiagnosticSnapshot {
    const pos = this.bot?.entity?.position;
    const inv = getBotInventoryCounts(this.bot);
    const vitals = {
      health: this.bot?.health ?? 20,
      food: this.bot?.food ?? 20,
      oxygen: this.bot?.oxygenLevel ?? 300,
    };
    const activeTask = this.taskExecutor?.getNextReadyTask()?.id;
    const pathfinderGoal = (this.bot as any)?.pathfinder?.goal;

    const lastWorldEvents = [
      ...this.recentEvents.damageTaken.map((d) => ({ type: 'damage', ...d })),
      ...this.recentEvents.blocksBroken.map((b) => ({ type: 'blockBroken', block: b })),
      ...this.recentEvents.blocksPlaced.map((b) => ({ type: 'blockPlaced', block: b })),
      ...this.recentEvents.mobsKilled.map((m) => ({ type: 'mobKilled', mob: m })),
      ...this.recentEvents.itemsPickedUp.map((i) => ({ type: 'itemPickedUp', item: i })),
      ...this.recentEvents.chatMessages.map((c) => ({ type: 'chat', ...c })),
    ].slice(-50);

    return {
      timestamp: new Date().toISOString(),
      seed: this.config?.server?.host || 'default',
      stepNumber: this.memory?.state?.stepNumber,
      botPosition: pos
        ? { x: Math.round(pos.x * 10) / 10, y: Math.round(pos.y * 10) / 10, z: Math.round(pos.z * 10) / 10 }
        : undefined,
      botVitals: vitals,
      inventory: inv,
      lastWorldEvents,
      activeGoal: this.taskExecutor?.activeGoal?.id || this.memory?.state?.currentGoal,
      activeTask,
      pathfinderGoal: pathfinderGoal ? String(pathfinderGoal) : undefined,
      failureReason,
    };
  }

  public updateBotInstance(newBot: Bot): void {
    try {
      this.arbiter.cancelAll(this.bot);
    } catch {}
    if (this.respawnTimer) {
      clearTimeout(this.respawnTimer);
      this.respawnTimer = null;
    }
    // Clean up event listeners from old bot instance to prevent memory leaks and zombie event callbacks
    this.cleanupEventListeners();
    this.bot = newBot;
    this.safetySupervisor = new SafetySupervisor({
      bot: newBot,
      arbiter: this.arbiter,
      reflexLayer: this.reflex,
      logger: this.logger.logger,
      config: this.config,
    });
    this.setupEventListeners();
    this.logger.info('AgentController successfully rebound to new bot instance after reconnect.');
  }
}
