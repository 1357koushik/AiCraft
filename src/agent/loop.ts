import { Bot } from 'mineflayer';
import { AppConfig } from '../config/index.js';
import { AgentLogger } from '../utils/logger.js';
import { MemoryManager } from '../memory/index.js';
import { SafetyManager } from '../safety/index.js';
import { ReflexLayer } from './reflex.js';
import { StuckDetector } from './stuck.js';
import { ActionArbiter, ActionPriority } from './arbiter.js';
import { buildObservation } from '../perception/index.js';
import { AvailabilityEngine } from '../actions/availability.js';
import { ILLMProvider, Observation, RecentEventsState, ActionResult } from '../types/index.js';
import { buildSystemPrompt, buildUserPrompt } from '../prompt/index.js';
import { distance3D } from '../utils/math.js';

export class AgentController {
  private bot: Bot;
  private config: AppConfig;
  private logger: AgentLogger;
  private memory: MemoryManager;
  private safety: SafetyManager;
  private reflex: ReflexLayer;
  private stuckDetector: StuckDetector;
  private arbiter: ActionArbiter;
  private llmProvider: ILLMProvider;

  private isRunning = false;
  private isPaused = false;
  private stepApproved = false;
  private recentEvents: RecentEventsState = {
    damageTaken: [],
    healthRegained: 0,
    itemsPickedUp: [],
    itemsBroken: [],
    blocksBroken: [],
    blocksPlaced: [],
    mobsKilled: [],
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

    this.setupEventListeners();
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
    this.logger.info('Stopping agent loop...');
  }

  public async start(): Promise<void> {
    this.isRunning = true;
    this.logger.info('Agent loop started.');

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
    this.memory.state.stepNumber++;
    const stepNum = this.memory.state.stepNumber;

    // 1. Initial quick perception for reflexes and availability
    const dummyObs = buildObservation(
      this.bot,
      this.config,
      this.memory.state,
      this.memory.notes,
      this.recentEvents,
      []
    );

    // 2. Reflex layer: fast check without LLM latency
    const reflexResult = await this.reflex.evaluateReflexes(this.bot, dummyObs);
    if (reflexResult.triggered) {
      this.arbiter.preempt(this.bot, reflexResult.name || 'Emergency reflex');
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
      availableCatalog
    );

    // 5. Stuck detection
    const stuckStatus = this.stuckDetector.check(observation, this.recentEvents.lastActionResult);
    if (stuckStatus.isStuck) {
      this.logger.warn(`Stuck condition detected: ${stuckStatus.reason}. Forcing jump and small reposition.`);
      this.bot.clearControlStates();
      this.bot.setControlState('jump', true);
      this.bot.setControlState('back', true);
      await new Promise((res) => setTimeout(res, 600));
      this.bot.clearControlStates();
      this.stuckDetector.reset();
    }

    // 6. Build prompts and query LLM with bounded retries
    const systemPrompt = buildSystemPrompt(this.config);
    const userPrompt = buildUserPrompt(
      observation,
      availableCatalog,
      this.memory.rollingHistory,
      this.config
    );

    let llmResponse = await this.llmProvider.generateDecision({ systemPrompt, userPrompt });
    let retries = 0;

    while (llmResponse.error && retries < this.config.agent.maxRetriesOnMalformedJson) {
      retries++;
      this.logger.warn(`LLM decision failed (${llmResponse.error}). Retry attempt ${retries}...`);
      const retryPrompt = `${userPrompt}\n\nPREVIOUS ATTEMPT RETURNED INVALID FORMAT: ${llmResponse.error}\nRespond ONLY with valid JSON matching the schema.`;
      llmResponse = await this.llmProvider.generateDecision({ systemPrompt, userPrompt: retryPrompt });
    }

    if (llmResponse.error || !llmResponse.decision) {
      this.logger.error(`Failed to get valid LLM decision after retries: ${llmResponse.error}. Idling safely.`);
      this.bot.clearControlStates();
      return;
    }

    const decision = llmResponse.decision;
    this.logger.info(`[Step ${stepNum}] Decision: "${decision.decision_summary}" | Goal: "${decision.goal}"`);

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

    // Update goal in memory
    if (decision.goal) {
      this.memory.state.currentGoal = decision.goal;
    }

    // 7. Execute action(s) in order with fresh observation before each step
    const executedActions: any[] = [];
    const actionResults: ActionResult[] = [];

    const maxActions = Math.min(this.config.agent.maxActionsPerStep || 1, 5);
    const actionsToRun = decision.actions.slice(0, maxActions);
    const batchStartTime = Date.now();
    const maxBatchDurationMs = this.config.agent.requestTimeoutMs || 30000;

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
      if (!this.bot.entity || (this.bot as any).isAlive === false || (this.bot.health !== undefined && this.bot.health <= 0)) {
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
              []
            );

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

      // Execute action with timeout and arbiter coordination
      this.logger.info(`Executing action: ${item.action} params: ${JSON.stringify(item.params)}`);
      executedActions.push(item);

      const { actionId, signal } = this.arbiter.startAction(item.action, ActionPriority.NORMAL, this.bot);
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
          25000
        );
      } finally {
        this.arbiter.finishAction(actionId, this.bot);
      }

      actionResults.push(result);
      this.logger.info(`Action ${item.action} completed: ${result.status} (${result.reason})`);

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
    this.recentEvents.damageTaken = [];
    this.recentEvents.healthRegained = 0;
    this.recentEvents.itemsPickedUp = [];
    this.recentEvents.itemsBroken = [];
    this.recentEvents.blocksBroken = [];
    this.recentEvents.blocksPlaced = [];
    this.recentEvents.mobsKilled = [];
    this.recentEvents.deathRespawn = false;
    this.recentEvents.chatMessages = [];
    this.recentEvents.reflexFired = undefined;
  }

  private setupEventListeners(): void {
    // Health and damage
    this.bot.on('health', () => {
      // Checked directly in vitals
    });

    // Death
    this.bot.on('death', () => {
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

      // Clean physical pathfinding and controls immediately
      try {
        (this.bot as any).pathfinder?.stop();
        (this.bot as any).pathfinder?.setGoal(null);
      } catch {}
      this.bot.clearControlStates();

      // Auto respawn after 1.5s
      setTimeout(() => {
        try {
          this.bot.respawn();
          this.logger.info('Auto-respawn triggered.');
        } catch {}
      }, 1500);
    });

    // Chat messages (owner instructions & untrusted player chat)
    this.bot.on('chat', (username: string, message: string) => {
      if (username === this.bot.username) return;

      const isOwner = this.config.agent.owners.includes(username);
      this.logger.info(`[Chat] <${username}> ${message} (isOwner: ${isOwner})`);

      this.recentEvents.chatMessages.push({
        sender: username,
        message,
        isOwner,
      });

      // Handle owner commands
      if (isOwner && (message.startsWith('!') || message.startsWith('/'))) {
        this.handleOwnerChatCommand(message);
      }
    });

    // Block break and place tracking
    this.bot.on('blockBreakProgressEnd', (block: any) => {
      if (block?.name) this.recentEvents.blocksBroken.push(block.name);
    });

    // Entity hurt: verifies attacker from event source (Mineflayer damage_event / entityStatus)
    this.bot.on('entityHurt', (entity: any, source?: any) => {
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

      // Check attacker is loaded and alive
      const liveAttacker = this.bot.entities[source.id];
      if (!liveAttacker || (liveAttacker as any).isValid === false) return;
      if (typeof (liveAttacker as any).health === 'number' && (liveAttacker as any).health <= 0) return;

      const dist = distance3D(this.bot.entity.position, liveAttacker.position);
      const maxRadius = this.config.safety.reflexes.autoAttackRadius || 4.5;
      if (dist > maxRadius) return;

      this.arbiter.preempt(this.bot, `Retaliating against ${attackerName}`, ActionPriority.COMBAT_REFLEX);
      this.reflex.autoDefendAttacker(this.bot, liveAttacker).catch(() => {});
    });
  }

  private handleOwnerChatCommand(commandText: string): void {
    const trimmed = commandText.replace(/^[!/]/, '').trim();
    const [cmd, ...args] = trimmed.split(' ');
    const argStr = args.join(' ');

    this.logger.info(`Executing owner command: ${cmd} "${argStr}"`);

    switch (cmd.toLowerCase()) {
      case 'stop':
      case 'pause':
        this.pause();
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
      case 'goal':
        if (argStr) {
          this.memory.setGoal(argStr);
          this.bot.chat(`New goal set: ${argStr}`);
        }
        break;
      default:
        this.bot.chat(`Unknown command '${cmd}'. Available: !stop, !resume, !step, !attack [on|off], !goal <text>`);
    }
  }

  public updateBotInstance(newBot: Bot): void {
    this.bot = newBot;
    this.setupEventListeners();
    this.logger.info('AgentController successfully rebound to new bot instance after reconnect.');
  }
}
