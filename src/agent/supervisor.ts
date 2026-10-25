import { Bot } from 'mineflayer';
import { ActionArbiter, ActionPriority } from './arbiter.js';
import { ReflexLayer, ReflexTriggerResult } from './reflex.js';
import { AppConfig } from '../config/index.js';
import { Observation } from '../types/index.js';
import { isAlive } from '../safety/index.js';
import { buildObservation } from '../perception/index.js';
import { SUFFOCATING_GRAVITY_BLOCKS } from '../actions/hazards.js';

export interface SafetySupervisorConfig {
  bot: Bot;
  arbiter: ActionArbiter;
  reflexLayer: ReflexLayer;
  logger: any;
  config: AppConfig;
  auditIntervalMs?: number;
}

export interface LatencyMetric {
  reason: string;
  priority: number;
  triggerTime: number;
  preemptionLatencyMs: number;
  totalDurationMs: number;
}

/**
 * Lightweight Asynchronous Safety Supervisor (Phase 1, Layer 2).
 *
 * Runs safety checks independently of LLM planning latency and normal skills.
 * Adheres to Node.js single-threaded event loop realism:
 * - Event callbacks perform constant-time O(1) hazard classification.
 * - NEVER runs full-map scans, 1,764-block loops, or expensive BFS inside physicsTick.
 * - Preempts normal work asynchronously via ActionArbiter for verified urgent conditions.
 * - Does NOT create a second uncontrolled movement writer: all emergency reflexes
 *   acquire exclusive arbiter ownership and release actuators upon completion.
 * - Instruments event-to-preemption latency and total emergency duration.
 * - Remains active during owner pause/stop without disabling life-preserving responses.
 */
export class SafetySupervisor {
  private bot: Bot;
  private arbiter: ActionArbiter;
  private reflexLayer: ReflexLayer;
  private logger: any;
  private config: AppConfig;
  private auditIntervalMs: number;

  private isRunning: boolean = false;
  private isHandlingEmergency: boolean = false;
  private boundListeners: Array<{ event: string; listener: (...args: any[]) => void }> = [];
  private auditTimer: ReturnType<typeof setInterval> | null = null;
  private lastLatencyMetric: LatencyMetric | null = null;

  constructor(cfg: SafetySupervisorConfig) {
    this.bot = cfg.bot;
    this.arbiter = cfg.arbiter;
    this.reflexLayer = cfg.reflexLayer;
    this.logger = cfg.logger;
    this.config = cfg.config;
    this.auditIntervalMs = cfg.auditIntervalMs ?? 250;
  }

  public get isSupervising(): boolean {
    return this.isRunning;
  }

  public get isEmergencyActive(): boolean {
    return this.isHandlingEmergency;
  }

  public get lastMetric(): LatencyMetric | null {
    return this.lastLatencyMetric;
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.setupListeners();
    this.startAuditTimer();
    this.logger?.info?.('Safety supervisor activated (hybrid trigger model: sharp events + audit timer).');
  }

  public stop(): void {
    this.isRunning = false;
    this.removeListeners();
    if (this.auditTimer) {
      clearInterval(this.auditTimer);
      this.auditTimer = null;
    }
    this.logger?.info?.('Safety supervisor deactivated.');
  }

  private addListener(event: string, listener: (...args: any[]) => void): void {
    if (this.bot && typeof this.bot.on === 'function') {
      this.bot.on(event as any, listener);
      this.boundListeners.push({ event, listener });
    }
  }

  private removeListeners(): void {
    for (const { event, listener } of this.boundListeners) {
      try {
        if (this.bot && typeof this.bot.removeListener === 'function') {
          this.bot.removeListener(event as any, listener);
        }
      } catch {}
    }
    this.boundListeners = [];
  }

  private setupListeners(): void {
    // 1. Sharp health/damage crossing (O(1))
    this.addListener('health', () => {
      if (!this.isRunning || !this.bot.entity) return;
      const health = this.bot.health;
      if (health !== undefined && health > 0 && health <= this.config.safety.reflexes.fleeHealthThreshold) {
        this.requestUrgentEvaluation('Critical health emergency', ActionPriority.SURVIVAL_EMERGENCY);
      }
    });

    // 2. Sharp breath/oxygen crossing (O(1))
    this.addListener('breath', () => {
      if (!this.isRunning || !this.bot.entity) return;
      const oxygen = (this.bot as any).oxygenLevel ?? (this.bot as any).oxygen;
      if (oxygen !== undefined && oxygen < 8) {
        this.requestUrgentEvaluation('Low oxygen drowning emergency', ActionPriority.SURVIVAL_EMERGENCY);
      }
    });

    // 3. Fast constant-time physics tick classification (O(1), no heavy loops)
    this.addListener('physicsTick', () => {
      if (!this.isRunning || !this.bot.entity) return;

      // Constant-time check 1: Lava or fire
      const inLava = Boolean((this.bot.entity as any).isInLava);
      const isBurning = Boolean((this.bot.entity as any).isBurning);
      if (inLava || isBurning) {
        this.requestUrgentEvaluation('Lava/fire hazard', ActionPriority.SURVIVAL_EMERGENCY);
        return;
      }

      // Constant-time check 2: Water drowning / submersion (1 block lookup at head)
      const inWater = Boolean((this.bot.entity as any).isInWater);
      if (inWater) {
        const headPos = this.bot.entity.position.offset(0, 1.5, 0);
        const headBlock = this.bot.blockAt ? this.bot.blockAt(headPos) : null;
        const isSubmerged = headBlock?.name === 'water' || headBlock?.name === 'flowing_water';
        const oxygen = (this.bot as any).oxygenLevel ?? (this.bot as any).oxygen;
        const oxygenLow = oxygen !== undefined && oxygen < 10;

        if (isSubmerged || oxygenLow) {
          this.requestUrgentEvaluation('Water drowning emergency', ActionPriority.SURVIVAL_EMERGENCY);
          return;
        }
      }

      // Constant-time check 3: Free fall (Y velocity falling fast or fallDistance > 3)
      const onGround = Boolean(this.bot.entity.onGround);
      const inLiquid = inLava || inWater;
      const velocityY = this.bot.entity.velocity?.y ?? 0;
      const fallDist = (this.bot.entity as any)?.fallDistance ?? 0;
      if (!onGround && !inLiquid && (fallDist >= 3.0 || velocityY < -0.5)) {
        this.requestUrgentEvaluation('Free-fall hazard', ActionPriority.SURVIVAL_EMERGENCY);
        return;
      }

      // Constant-time check 4: Suffocation (head inside falling gravity block)
      if (this.bot.blockAt) {
        const headPos = this.bot.entity.position.offset(0, 1.6, 0).floored();
        const headBlock = this.bot.blockAt(headPos);
        if (headBlock && headBlock.boundingBox === 'block' && SUFFOCATING_GRAVITY_BLOCKS.has(headBlock.name)) {
          this.requestUrgentEvaluation('Suffocation hazard', ActionPriority.SURVIVAL_EMERGENCY);
          return;
        }
      }
    });
  }

  private startAuditTimer(): void {
    if (this.auditTimer) clearInterval(this.auditTimer);
    this.auditTimer = setInterval(() => {
      if (!this.isRunning || !this.bot.entity) return;
      this.auditEnvironmentAndThreats();
    }, this.auditIntervalMs);
  }

  private auditEnvironmentAndThreats(): void {
    if (this.isHandlingEmergency) return;
    if (!this.bot.entity || !isAlive(this.bot.entity)) return;

    // Lava/fire check
    const inLava = Boolean((this.bot.entity as any).isInLava);
    const isBurning = Boolean((this.bot.entity as any).isBurning);
    if (inLava || isBurning) {
      this.requestUrgentEvaluation('Lava/fire audit detected', ActionPriority.SURVIVAL_EMERGENCY);
      return;
    }

    // Drowning check
    const inWater = Boolean((this.bot.entity as any).isInWater);
    const oxygen = (this.bot as any).oxygenLevel ?? (this.bot as any).oxygen;
    if (inWater && (oxygen !== undefined && oxygen < 8)) {
      this.requestUrgentEvaluation('Drowning audit detected', ActionPriority.SURVIVAL_EMERGENCY);
      return;
    }

    // Suffocation check (head inside falling gravity block)
    if (this.bot.blockAt) {
      const headPos = this.bot.entity.position.offset(0, 1.6, 0).floored();
      const headBlock = this.bot.blockAt(headPos);
      if (headBlock && headBlock.boundingBox === 'block' && SUFFOCATING_GRAVITY_BLOCKS.has(headBlock.name)) {
        this.requestUrgentEvaluation('Suffocation audit detected', ActionPriority.SURVIVAL_EMERGENCY);
        return;
      }
    }

    // Free fall check
    const onGround = Boolean(this.bot.entity.onGround);
    const inLiquid = inLava || inWater;
    const velocityY = this.bot.entity.velocity?.y ?? 0;
    const fallDist = (this.bot.entity as any)?.fallDistance ?? 0;
    if (!onGround && !inLiquid && (fallDist >= 3.0 || velocityY < -0.5)) {
      this.requestUrgentEvaluation('Free-fall audit detected', ActionPriority.SURVIVAL_EMERGENCY);
      return;
    }

    // Imminent creeper explosion check
    if (this.findImminentExplosionThreat()) {
      this.requestUrgentEvaluation('Imminent creeper explosion detected', ActionPriority.COMBAT_REFLEX);
      return;
    }

    // Critical health check with nearby hostile
    const health = this.bot.health ?? 20;
    if (health <= this.config.safety.reflexes.fleeHealthThreshold) {
      const nearestHostile = this.findNearestHostileDistance();
      if (nearestHostile < 8) {
        this.requestUrgentEvaluation('Critical health with hostile nearby', ActionPriority.SURVIVAL_EMERGENCY);
        return;
      }
    }

    // Auto-defense check
    if (this.reflexLayer.isAutoAttackEnabled()) {
      const hostileDist = this.findNearestHostileDistance();
      if (hostileDist <= (this.config.safety.reflexes.autoAttackRadius || 3.8)) {
        this.requestUrgentEvaluation('Hostile within auto-defense range', ActionPriority.COMBAT_REFLEX);
      }
    }
  }

  private findImminentExplosionThreat(): boolean {
    if (!this.bot.entities || !this.bot.entity) return false;
    const botPos = this.bot.entity.position;
    for (const id of Object.keys(this.bot.entities)) {
      const e = this.bot.entities[id];
      if (!e || e === this.bot.entity || !isAlive(e) || e.name !== 'creeper' || !e.position) continue;
      const dist = Math.hypot(e.position.x - botPos.x, e.position.y - botPos.y, e.position.z - botPos.z);
      if (dist <= 5.0) {
        const isSwelling = (e as any).metadata?.[16] === 1 || (e as any).fuse > 0 || (e as any).ignited === true;
        if (isSwelling || dist <= 3.2) {
          return true;
        }
      }
    }
    return false;
  }

  private findNearestHostileDistance(): number {
    if (!this.bot.entities || !this.bot.entity) return Infinity;
    let minDist = Infinity;
    const botPos = this.bot.entity.position;

    for (const id of Object.keys(this.bot.entities)) {
      const e = this.bot.entities[id];
      if (!e || e === this.bot.entity || !isAlive(e)) continue;
      const type = e.type || e.name || '';
      const isHostile =
        type === 'mob' ||
        ['zombie', 'skeleton', 'creeper', 'spider', 'enderman', 'witch', 'drowned', 'husk', 'stray'].includes(
          e.name || ''
        );
      if (isHostile && e.position) {
        const d = Math.hypot(e.position.x - botPos.x, e.position.y - botPos.y, e.position.z - botPos.z);
        if (d < minDist) minDist = d;
      }
    }
    return minDist;
  }

  public requestUrgentEvaluation(reason: string, priority: ActionPriority): void {
    if (this.isHandlingEmergency) return;
    if (this.arbiter.activePriority >= priority) {
      return;
    }

    this.isHandlingEmergency = true;
    const triggerTime = performance.now();

    // Fast asynchronous dispatch keeping synchronous event-handler duration < 0.1ms
    queueMicrotask(async () => {
      await this.runEmergencySequence(reason, priority, triggerTime);
    });
  }

  public async evaluateUrgentSafety(): Promise<ReflexTriggerResult> {
    if (!this.bot.entity || !isAlive(this.bot.entity)) {
      return { triggered: false };
    }
    const obs = this.buildFastObservation();
    return this.reflexLayer.evaluateReflexes(this.bot, obs, this.arbiter);
  }

  private async runEmergencySequence(reason: string, priority: ActionPriority, triggerTime: number): Promise<void> {
    try {
      const preemptionStart = performance.now();
      const preemptionLatencyMs = preemptionStart - triggerTime;

      // Preempt any lower priority work (e.g. NORMAL)
      const preempted = this.arbiter.preempt(this.bot, reason, priority);
      this.logger?.info?.(
        {
          reason,
          priority,
          preemptionLatencyMs: Number(preemptionLatencyMs.toFixed(2)),
          preempted,
        },
        `[SAFETY_SUPERVISOR] Preempted normal work for emergency: ${reason} in ${preemptionLatencyMs.toFixed(2)}ms`
      );

      // Execute life-preserving response under Arbiter lock
      const obs = this.buildFastObservation();
      const result = await this.reflexLayer.evaluateReflexes(this.bot, obs, this.arbiter);

      const totalDurationMs = performance.now() - triggerTime;
      this.lastLatencyMetric = {
        reason,
        priority,
        triggerTime,
        preemptionLatencyMs,
        totalDurationMs,
      };

      this.logger?.info?.(
        {
          reason,
          totalDurationMs: Number(totalDurationMs.toFixed(2)),
          result,
        },
        `[SAFETY_SUPERVISOR] Emergency handling completed in ${totalDurationMs.toFixed(2)}ms`
      );
    } catch (err: any) {
      this.logger?.error?.({ err, reason }, `[SAFETY_SUPERVISOR] Error during emergency handling: ${err.message}`);
    } finally {
      if (!this.lastLatencyMetric) {
        this.lastLatencyMetric = {
          reason,
          priority,
          triggerTime,
          preemptionLatencyMs: performance.now() - triggerTime,
          totalDurationMs: performance.now() - triggerTime,
        };
      }
      this.isHandlingEmergency = false;
    }
  }

  public buildFastObservation(): Observation {
    return buildObservation(
      this.bot,
      this.config,
      {
        stepNumber: 0,
        currentGoal: 'Survive',
        planSteps: [],
        stuckCounter: 0,
        timeSinceLastProgressSeconds: 0,
        activeActionName: this.arbiter.activeActionName ?? undefined,
      },
      {
        namedLocations: {},
        facts: [],
        dangerZones: [],
        completedGoals: [],
      },
      {
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
      },
      []
    );
  }
}
