import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  MemoryNotes,
  AgentInternalState,
  PlanStep,
  PlanTaskType,
  PlanStepRequirement,
  ExploredRegionRecord,
  KnownLocationRecord,
  ResourceObservationRecord,
  FailedTargetMemoryRecord,
  GoalOutcomeRecord,
  StrategyRankingRecord,
} from '../types/index.js';
import { PlanCache, IPlanCacheEntry } from './plan_cache.js';

export { PlanCache, IPlanCacheEntry };

export function countMatchingInventoryItems(
  inventoryCounts: Record<string, number>,
  targetIdentifier: string
): number {
  if (!inventoryCounts || !targetIdentifier) return 0;
  const target = targetIdentifier.toLowerCase().trim();
  let total = 0;

  for (const [name, count] of Object.entries(inventoryCounts)) {
    const lower = name.toLowerCase().trim();
    if (lower === target) {
      total += count;
    } else if (target === 'cobblestone' && (lower === 'cobblestone' || lower === 'cobbled_deepslate')) {
      total += count;
    } else if (
      (target === 'log' || target === 'logs' || target === 'wood') &&
      (lower.endsWith('_log') || lower.endsWith('_wood') || lower === 'log')
    ) {
      total += count;
    } else if (
      (target === 'planks' || target === 'plank') &&
      (lower.endsWith('_planks') || lower === 'planks')
    ) {
      total += count;
    } else if (
      target === 'food' &&
      [
        'bread',
        'cooked_beef',
        'cooked_porkchop',
        'apple',
        'cooked_mutton',
        'cooked_chicken',
        'baked_potato',
        'carrot',
      ].includes(lower)
    ) {
      total += count;
    }
  }
  return total;
}

export function parsePlanStep(stepInput: string | Partial<PlanStep>): PlanStep {
  if (typeof stepInput === 'object' && stepInput !== null) {
    const rawStep = String(stepInput.step || '').trim();
    const parsedFromString = parsePlanStep(rawStep);
    return {
      step: rawStep,
      completed: Boolean(stepInput.completed),
      type: stepInput.type && stepInput.type !== 'generic' ? stepInput.type : parsedFromString.type,
      targetItem: stepInput.targetItem || parsedFromString.targetItem,
      targetCount: stepInput.targetCount !== undefined ? stepInput.targetCount : parsedFromString.targetCount,
      currentCount: stepInput.currentCount ?? 0,
      status: stepInput.status || (stepInput.completed ? 'completed' : parsedFromString.status),
      requirements: stepInput.requirements && stepInput.requirements.length > 0 ? stepInput.requirements : parsedFromString.requirements,
      prerequisites: stepInput.prerequisites || parsedFromString.prerequisites,
    };
  }

  const raw = String(stepInput || '').trim();
  const lower = raw.toLowerCase();

  let type: PlanTaskType = 'generic';
  if (/^(gather|mine|collect|harvest|get|dig)\b/.test(lower)) {
    type = 'gather';
  } else if (/^(craft|make|create)\b/.test(lower)) {
    type = 'craft';
  } else if (/^(smelt|cook)\b/.test(lower)) {
    type = 'smelt';
  } else if (/^(kill|defeat|hunt|attack)\b/.test(lower)) {
    type = 'kill';
  } else if (/^(explore|find|search|locate)\b/.test(lower)) {
    type = 'explore';
  } else if (/^(build|place)\b/.test(lower)) {
    type = 'build';
  }

  const countMatch = lower.match(/\b(\d+)\b/);
  const targetCount = countMatch ? parseInt(countMatch[1], 10) : 1;

  let targetItem: string | undefined;
  if (lower.includes('cobblestone') || lower.includes('cobble')) {
    targetItem = 'cobblestone';
  } else if (lower.includes('wooden pickaxe')) {
    targetItem = 'wooden_pickaxe';
  } else if (lower.includes('stone pickaxe')) {
    targetItem = 'stone_pickaxe';
  } else if (lower.includes('crafting table')) {
    targetItem = 'crafting_table';
  } else if (lower.includes('furnace')) {
    targetItem = 'furnace';
  } else if (lower.includes('log') || lower.includes('wood')) {
    targetItem = 'log';
  } else if (lower.includes('plank')) {
    targetItem = 'planks';
  } else if (lower.includes('stick')) {
    targetItem = 'stick';
  } else if (lower.includes('iron ore') || lower.includes('raw iron')) {
    targetItem = 'raw_iron';
  } else if (lower.includes('iron ingot')) {
    targetItem = 'iron_ingot';
  } else if (lower.includes('coal') || lower.includes('charcoal')) {
    targetItem = 'coal';
  } else if (lower.includes('torch')) {
    targetItem = 'torch';
  } else if (lower.includes('food') || lower.includes('bread')) {
    targetItem = 'food';
  }

  let requirements: PlanStepRequirement[] | undefined;
  if (lower.includes('crafting table') && lower.includes('wooden pickaxe')) {
    requirements = [
      { item: 'crafting_table', count: 1 },
      { item: 'wooden_pickaxe', count: 1 },
    ];
  } else if (lower.includes('stone tools') && lower.includes('food')) {
    requirements = [
      { item: 'stone_pickaxe', count: 1 },
      { item: 'food', count: 1 },
    ];
  }

  return {
    step: raw,
    completed: false,
    type,
    targetItem,
    targetCount: requirements ? undefined : targetCount,
    currentCount: 0,
    status: 'pending',
    requirements,
  };
}

export interface HistoryStepRecord {
  step: number;
  summary: string;
  action: string;
  result: string;
  timestamp: number;
}

export class MemoryManager {
  private dataDir: string;
  private worldId: string;
  private filePath: string;
  private memoryNotes: MemoryNotes;
  private history: HistoryStepRecord[] = [];
  private agentState: AgentInternalState;
  public planCache: PlanCache = new PlanCache();

  constructor(worldId: string = 'local_world', dataDir: string = './data') {
    // Sanitize worldId to strictly prevent path traversal while appending a hash to prevent world collisions
    const trimmedWorldId = String(worldId || '').trim();
    const rawWorldId = trimmedWorldId || 'local_world';
    let safeBase = rawWorldId.replace(/[^a-zA-Z0-9_-]/g, '_');
    if (!safeBase.replace(/_/g, '')) {
      safeBase = 'local_world';
    }
    const hash = crypto.createHash('sha256').update(rawWorldId).digest('hex').substring(0, 8);
    const safeWorldId = `${safeBase}_${hash}`;
    this.worldId = safeWorldId;
    this.dataDir = path.resolve(process.cwd(), dataDir);
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
    const candidatePath = path.resolve(this.dataDir, `memory-${safeWorldId}.json`);
    if (!candidatePath.startsWith(this.dataDir)) {
      throw new Error(`Path traversal attempt detected in worldId: ${worldId}`);
    }
    this.filePath = candidatePath;

    // Migrate legacy unhashed memory file if present and modern file does not exist
    const legacyPath = path.resolve(this.dataDir, `memory-${safeBase}.json`);
    if (!fs.existsSync(this.filePath) && fs.existsSync(legacyPath)) {
      try {
        fs.copyFileSync(legacyPath, this.filePath);
      } catch {}
    }

    this.memoryNotes = {
      namedLocations: {},
      facts: [],
      dangerZones: [],
      completedGoals: [],
      exploredRegions: [],
      knownLocations: [],
      resourceObservations: [],
      failedTargets: [],
      goalOutcomes: [],
      strategyRankings: {},
    };

    this.agentState = {
      currentGoal: 'Survive the first day and gather resources',
      planSteps: [
        parsePlanStep('Collect wood logs'),
        parsePlanStep('Craft crafting table and wooden pickaxe'),
        parsePlanStep('Gather cobblestone'),
        parsePlanStep('Craft stone tools and find food'),
      ],
      stepNumber: 0,
      stuckCounter: 0,
      timeSinceLastProgressSeconds: 0,
      isOwnerGoal: false,
    };

    this.loadFromDisk();
  }

  public get notes(): MemoryNotes {
    return this.memoryNotes;
  }

  public get state(): AgentInternalState {
    return this.agentState;
  }

  public get rollingHistory(): HistoryStepRecord[] {
    return this.history;
  }

  public setGoal(goal: string, steps?: (string | Partial<PlanStep>)[], isOwnerGoal: boolean = true): void {
    const trimmedGoal = String(goal || '').trim().substring(0, 300);
    this.agentState.currentGoal = trimmedGoal || 'Survive and explore';
    this.agentState.isOwnerGoal = isOwnerGoal;
    if (steps && steps.length > 0) {
      this.agentState.planSteps = steps
        .slice(0, 10)
        .map((s) => parsePlanStep(s));
    }
    this.saveToDisk();
  }

  /**
   * Updates plan progress deterministically by evaluating inventory contents against plan steps.
   * Marks milestones completed so the cognitive planner advances through subgoals without looping.
   * Preserves quantity thresholds: partial progress (e.g. 1/8 cobblestone) does not mark a task complete.
   */
  public updatePlanProgress(inventoryCounts: Record<string, number>): void {
    if (!inventoryCounts || !this.agentState.planSteps) return;

    let changed = false;
    for (const item of this.agentState.planSteps) {
      if (item.targetItem && item.targetCount !== undefined && item.targetCount > 0) {
        item.currentCount = countMatchingInventoryItems(inventoryCounts, item.targetItem);
      }

      // Completed steps remain completed milestones across inventory shifts (e.g. crafting consumption)
      if (item.completed) continue;

      if (item.requirements && item.requirements.length > 0) {
        let allSatisfied = true;
        let anyProgress = false;
        for (const req of item.requirements) {
          const count = countMatchingInventoryItems(inventoryCounts, req.item);
          if (count < req.count) {
            allSatisfied = false;
          }
          if (count > 0) {
            anyProgress = true;
          }
        }
        if (allSatisfied) {
          item.completed = true;
          item.status = 'completed';
          changed = true;
        } else {
          item.completed = false;
          item.status = anyProgress ? 'in_progress' : 'pending';
        }
      } else if (item.targetItem && item.targetCount !== undefined && item.targetCount > 0) {
        const count = countMatchingInventoryItems(inventoryCounts, item.targetItem);
        item.currentCount = count;

        if (count >= item.targetCount) {
          item.completed = true;
          item.status = 'completed';
          changed = true;
        } else {
          item.completed = false;
          item.status = count > 0 ? 'in_progress' : 'pending';
        }
      }
    }

    if (changed) {
      this.saveToDisk();
    }
  }

  public addHistoryRecord(record: HistoryStepRecord, maxHistory: number = 10): void {
    this.history.push(record);
    if (this.history.length > maxHistory) {
      this.history.shift();
    }
  }

  public rememberLocation(name: string, pos: { x: number; y: number; z: number }): void {
    const safeName = String(name || '').trim().substring(0, 50);
    if (!safeName) return;

    // Bound total named locations to 50
    const keys = Object.keys(this.memoryNotes.namedLocations);
    if (keys.length >= 50 && !this.memoryNotes.namedLocations[safeName]) {
      delete this.memoryNotes.namedLocations[keys[0]]; // remove oldest
    }

    this.memoryNotes.namedLocations[safeName] = {
      x: Math.round(pos.x),
      y: Math.round(pos.y),
      z: Math.round(pos.z),
    };
    this.saveToDisk();
  }

  public rememberFact(fact: string): void {
    const safeFact = String(fact || '').trim().substring(0, 250);
    if (!safeFact) return;

    if (!this.memoryNotes.facts.includes(safeFact)) {
      if (this.memoryNotes.facts.length >= 50) {
        this.memoryNotes.facts.shift(); // discard oldest
      }
      this.memoryNotes.facts.push(safeFact);
      this.saveToDisk();
    }
  }

  public addDangerZone(name: string, pos: { x: number; y: number; z: number }, radius: number = 10): void {
    const safeName = String(name || '').trim().substring(0, 50);
    const safeRadius = Math.min(Math.max(radius || 10, 1), 100);

    if (this.memoryNotes.dangerZones.length >= 50) {
      this.memoryNotes.dangerZones.shift();
    }

    this.memoryNotes.dangerZones.push({
      name: safeName,
      x: Math.round(pos.x),
      y: Math.round(pos.y),
      z: Math.round(pos.z),
      radius: safeRadius,
    });
    this.saveToDisk();
  }

  public markGoalComplete(goal: string): void {
    const safeGoal = String(goal || '').trim().substring(0, 200);
    if (!safeGoal) return;

    if (!this.memoryNotes.completedGoals.includes(safeGoal)) {
      if (this.memoryNotes.completedGoals.length >= 50) {
        this.memoryNotes.completedGoals.shift();
      }
      this.memoryNotes.completedGoals.push(safeGoal);
      this.saveToDisk();
    }
  }

  // =========================================================================
  // Phase 5 Bounded Memory Layer: Explored Regions, Locations, Resources, Outcomes
  // =========================================================================

  /**
   * 1. Records an explored chunk/region with bounded capacity (max 100).
   * Coalesces repeated visits by updating lastVisitedAt, incrementing visitCount, and updating biome.
   */
  public recordExploredRegion(pos: { x: number; z: number }, dimension: string = 'overworld', biome?: string): void {
    if (!this.memoryNotes.exploredRegions) this.memoryNotes.exploredRegions = [];
    const chunkX = Math.floor(pos.x / 16);
    const chunkZ = Math.floor(pos.z / 16);
    const dim = String(dimension || 'overworld').substring(0, 30);

    const existing = this.memoryNotes.exploredRegions.find(
      (r) => r.chunkX === chunkX && r.chunkZ === chunkZ && r.dimension === dim
    );

    if (existing) {
      existing.lastVisitedAt = Date.now();
      existing.visitCount = (existing.visitCount || 1) + 1;
      if (biome) existing.biome = biome;
    } else {
      if (this.memoryNotes.exploredRegions.length >= 100) {
        this.memoryNotes.exploredRegions.shift(); // Bound FIFO to 100
      }
      this.memoryNotes.exploredRegions.push({
        chunkX,
        chunkZ,
        dimension: dim,
        lastVisitedAt: Date.now(),
        visitCount: 1,
        biome,
      });
    }
    this.saveToDisk();
  }

  /**
   * Records a confirmed landmark or prominent terrain feature into persistent memory.
   */
  public recordLandmark(
    name: string,
    pos: { x: number; y: number; z: number },
    type: KnownLocationRecord['type'] = 'landmark',
    metadata?: Record<string, any>
  ): void {
    this.recordKnownLocation({
      name,
      type,
      position: pos,
      metadata,
    });
  }

  /**
   * Records a confirmed portal location in persistent memory.
   */
  public recordPortal(
    dimension: 'overworld' | 'the_nether' | 'the_end',
    pos: { x: number; y: number; z: number },
    metadata?: Record<string, any>
  ): void {
    this.recordKnownLocation({
      name: `${dimension}_portal`,
      type: 'portal',
      position: pos,
      dimension,
      metadata: { dimension, ...metadata },
    });
  }

  /**
   * Retrieves the recorded portal location for the given dimension, if known.
   */
  public getPortal(dimension: 'overworld' | 'the_nether' | 'the_end'): { x: number; y: number; z: number } | null {
    const loc = (this.memoryNotes.knownLocations || []).find(
      (l) => l.type === 'portal' && (l.metadata?.dimension === dimension || l.name === `${dimension}_portal`)
    );
    return loc ? loc.position : null;
  }


  public getExploredRegions(): ExploredRegionRecord[] {
    return this.memoryNotes.exploredRegions || [];
  }

  public isRegionExplored(pos: { x: number; z: number }, dimension: string = 'overworld'): boolean {
    const chunkX = Math.floor(pos.x / 16);
    const chunkZ = Math.floor(pos.z / 16);
    return (this.memoryNotes.exploredRegions || []).some(
      (r) => r.chunkX === chunkX && r.chunkZ === chunkZ && r.dimension === dimension
    );
  }

  /**
   * 2. Records a confirmed base, container, or workstation location (bounded max 50).
   * Coalesces duplicate observations by updating timestamp and metadata.
   */
  public recordKnownLocation(loc: {
    name: string;
    type: KnownLocationRecord['type'];
    position: { x: number; y: number; z: number };
    dimension?: string;
    provenance?: 'direct_observation' | 'event';
    metadata?: Record<string, any>;
  }): void {
    if (!this.memoryNotes.knownLocations) this.memoryNotes.knownLocations = [];
    const pos = { x: Math.round(loc.position.x), y: Math.round(loc.position.y), z: Math.round(loc.position.z) };
    const dim = String(loc.dimension || 'overworld').substring(0, 30);
    const id = `${loc.type}_${pos.x}_${pos.y}_${pos.z}`;

    const existing = this.memoryNotes.knownLocations.find((k) => k.id === id);
    if (existing) {
      existing.observedAt = Date.now();
      existing.name = String(loc.name || existing.name).substring(0, 50);
      existing.metadata = { ...(existing.metadata || {}), ...(loc.metadata || {}) };
    } else {
      if (this.memoryNotes.knownLocations.length >= 50) {
        this.memoryNotes.knownLocations.shift(); // Bound FIFO to 50
      }
      this.memoryNotes.knownLocations.push({
        id,
        name: String(loc.name || loc.type).substring(0, 50),
        type: loc.type,
        position: pos,
        dimension: dim,
        observedAt: Date.now(),
        provenance: loc.provenance || 'direct_observation',
        metadata: loc.metadata,
      });
    }
    this.saveToDisk();
  }

  public getKnownLocations(typeFilter?: KnownLocationRecord['type']): KnownLocationRecord[] {
    const list = this.memoryNotes.knownLocations || [];
    if (!typeFilter) return list;
    return list.filter((l) => l.type === typeFilter);
  }

  /**
   * 3. Records a verified resource observation with confidence, provenance, and TTL expiry (bounded max 100).
   * Coalesces re-observations at same coordinates without duplicating records.
   */
  public recordResourceObservation(obs: {
    resourceType: string;
    position: { x: number; y: number; z: number };
    dimension?: string;
    confidence?: number;
    provenance?: 'direct_observation' | 'event';
    ttlMs?: number;
  }): void {
    if (!this.memoryNotes.resourceObservations) this.memoryNotes.resourceObservations = [];
    const pos = { x: Math.round(obs.position.x), y: Math.round(obs.position.y), z: Math.round(obs.position.z) };
    const dim = String(obs.dimension || 'overworld').substring(0, 30);
    const resType = String(obs.resourceType || '').toLowerCase().substring(0, 40);
    const id = `${resType}_${pos.x}_${pos.y}_${pos.z}`;

    const now = Date.now();
    const expiresAt = now + (obs.ttlMs ?? 600_000); // Default 10 min TTL

    const existing = this.memoryNotes.resourceObservations.find((r) => r.id === id);
    if (existing) {
      existing.observedAt = now;
      existing.expiresAt = expiresAt;
      existing.confidence = Math.min(Math.max(obs.confidence ?? existing.confidence, 0.1), 1.0);
      existing.provenance = obs.provenance || existing.provenance;
    } else {
      // Purge expired records first
      this.memoryNotes.resourceObservations = this.memoryNotes.resourceObservations.filter((r) => r.expiresAt > now);
      if (this.memoryNotes.resourceObservations.length >= 100) {
        this.memoryNotes.resourceObservations.shift(); // Bound to 100
      }
      this.memoryNotes.resourceObservations.push({
        id,
        resourceType: resType,
        position: pos,
        dimension: dim,
        observedAt: now,
        expiresAt,
        confidence: Math.min(Math.max(obs.confidence ?? 1.0, 0.1), 1.0),
        provenance: obs.provenance || 'direct_observation',
      });
    }
    this.saveToDisk();
  }

  public getFreshResourceObservations(typeQuery?: string): ResourceObservationRecord[] {
    const now = Date.now();
    const fresh = (this.memoryNotes.resourceObservations || []).filter((r) => r.expiresAt > now);
    if (!typeQuery) return fresh;
    const q = typeQuery.toLowerCase();
    return fresh.filter((r) => r.resourceType.includes(q));
  }

  /**
   * 4. Records a failed target with typed reason and TTL expiry (bounded max 100).
   * Prevents repeated futile navigation or interaction attempts.
   */
  public recordFailedTarget(
    pos: { x: number; y: number; z: number },
    reason: string,
    failureKind: string = 'UNKNOWN',
    ttlMs: number = 60_000
  ): void {
    if (!this.memoryNotes.failedTargets) this.memoryNotes.failedTargets = [];
    const targetPos = { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) };
    const now = Date.now();
    const expiresAt = now + ttlMs;

    const existing = this.memoryNotes.failedTargets.find(
      (f) => f.position.x === targetPos.x && f.position.y === targetPos.y && f.position.z === targetPos.z
    );

    if (existing) {
      existing.reason = String(reason || '').substring(0, 100);
      existing.failureKind = String(failureKind).substring(0, 30);
      existing.failedAt = now;
      existing.expiresAt = expiresAt;
    } else {
      this.memoryNotes.failedTargets = this.memoryNotes.failedTargets.filter((f) => f.expiresAt > now);
      if (this.memoryNotes.failedTargets.length >= 100) {
        this.memoryNotes.failedTargets.shift();
      }
      this.memoryNotes.failedTargets.push({
        position: targetPos,
        reason: String(reason || '').substring(0, 100),
        failureKind: String(failureKind).substring(0, 30),
        failedAt: now,
        expiresAt,
      });
    }
    this.saveToDisk();
  }

  public isTargetFailed(pos: { x: number; y: number; z: number }, toleranceRadius: number = 1.0): { failed: boolean; reason?: string; failureKind?: string } {
    const now = Date.now();
    for (const f of this.memoryNotes.failedTargets || []) {
      if (f.expiresAt > now) {
        const dx = Math.abs(f.position.x - pos.x);
        const dy = Math.abs(f.position.y - pos.y);
        const dz = Math.abs(f.position.z - pos.z);
        if (dx <= toleranceRadius && dy <= toleranceRadius && dz <= toleranceRadius) {
          return { failed: true, reason: f.reason, failureKind: f.failureKind };
        }
      }
    }
    return { failed: false };
  }

  /**
   * 5. Records a verified goal outcome with duration and evidence (bounded max 20).
   */
  public recordGoalOutcome(outcome: {
    goalId: string;
    description: string;
    outcome: 'success' | 'failed' | 'cancelled';
    durationMs: number;
    evidence: string;
  }): void {
    if (!this.memoryNotes.goalOutcomes) this.memoryNotes.goalOutcomes = [];
    if (this.memoryNotes.goalOutcomes.length >= 20) {
      this.memoryNotes.goalOutcomes.shift();
    }
    this.memoryNotes.goalOutcomes.push({
      goalId: String(outcome.goalId).substring(0, 60),
      description: String(outcome.description).substring(0, 200),
      outcome: outcome.outcome,
      completedAt: Date.now(),
      durationMs: Math.max(0, outcome.durationMs),
      evidence: String(outcome.evidence).substring(0, 300),
    });
    this.saveToDisk();
  }

  public getGoalOutcomes(): GoalOutcomeRecord[] {
    return this.memoryNotes.goalOutcomes || [];
  }

  // =========================================================================
  // Phase 5 Simple Statistical Learning & Strategy Ranking
  // =========================================================================

  /**
   * Records execution outcome for a skill variant.
   * Uses Laplace-smoothed Bayesian score: (successes + 1) / (successes + failures + 2).
   * Bounded between 0.0 and 1.0. Completely inspectable and reversible.
   */
  public recordSkillOutcome(skill: string, variant: string, success: boolean, durationMs: number): void {
    if (!this.memoryNotes.strategyRankings) this.memoryNotes.strategyRankings = {};
    const key = `${skill}:${variant}`;

    let record = this.memoryNotes.strategyRankings[key];
    if (!record) {
      record = {
        skill,
        variant,
        successCount: 0,
        failureCount: 0,
        totalDurationMs: 0,
        lastUsedAt: Date.now(),
        score: 0.5,
      };
      this.memoryNotes.strategyRankings[key] = record;
    }

    if (success) {
      record.successCount++;
    } else {
      record.failureCount++;
    }
    record.totalDurationMs += Math.max(0, durationMs);
    record.lastUsedAt = Date.now();

    // Laplace smoothing: (S + 1) / (S + F + 2)
    record.score = Number(((record.successCount + 1) / (record.successCount + record.failureCount + 2)).toFixed(3));

    // Bound total strategy ranking keys to 50
    const keys = Object.keys(this.memoryNotes.strategyRankings);
    if (keys.length > 50) {
      delete this.memoryNotes.strategyRankings[keys[0]];
    }

    this.saveToDisk();
  }

  public getRankedVariants(skill: string): StrategyRankingRecord[] {
    const list: StrategyRankingRecord[] = [];
    for (const record of Object.values(this.memoryNotes.strategyRankings || {})) {
      if (record.skill === skill) list.push(record);
    }
    return list.sort((a, b) => b.score - a.score);
  }

  public getPreferredVariant(skill: string, fallbackVariant: string): string {
    const ranked = this.getRankedVariants(skill);
    if (ranked.length > 0 && ranked[0].score >= 0.5) {
      return ranked[0].variant;
    }
    return fallbackVariant;
  }

  public resetStrategyRankings(): void {
    this.memoryNotes.strategyRankings = {};
    this.saveToDisk();
  }

  /**
   * Invariant Check: Learning NEVER overrides safety thresholds or owner intent.
   */
  public canLearningOverrideSafety(): false {
    return false;
  }

  // =========================================================================
  // Atomic Storage & Safe Schema Migrations (v1 -> v2)
  // =========================================================================

  public saveToDisk(): void {
    const tempPath = `${this.filePath}.tmp`;
    try {
      const now = Date.now();

      // Prune expired records prior to disk persistence
      const activeResourceObservations = (this.memoryNotes.resourceObservations || []).filter((r) => r.expiresAt > now).slice(-100);
      const activeFailedTargets = (this.memoryNotes.failedTargets || []).filter((f) => f.expiresAt > now).slice(-100);

      const dataToSave = {
        schemaVersion: 2, // Modern Phase 5 schema
        worldId: this.worldId,
        updatedAt: new Date().toISOString(),
        memory: {
          namedLocations: this.memoryNotes.namedLocations || {},
          facts: (this.memoryNotes.facts || []).slice(-50),
          dangerZones: (this.memoryNotes.dangerZones || []).slice(-50),
          completedGoals: (this.memoryNotes.completedGoals || []).slice(-50),
          exploredRegions: (this.memoryNotes.exploredRegions || []).slice(-100),
          knownLocations: (this.memoryNotes.knownLocations || []).slice(-50),
          resourceObservations: activeResourceObservations,
          failedTargets: activeFailedTargets,
          goalOutcomes: (this.memoryNotes.goalOutcomes || []).slice(-20),
          strategyRankings: this.memoryNotes.strategyRankings || {},
          planCache: this.planCache.serialize(),
        },
        agentState: this.agentState,
      };

      fs.writeFileSync(tempPath, JSON.stringify(dataToSave, null, 2), 'utf-8');
      fs.renameSync(tempPath, this.filePath);
    } catch (err: any) {
      console.error('Failed to save memory to disk atomically:', err.message);
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch {}
    }
  }

  private loadFromDisk(): void {
    if (fs.existsSync(this.filePath)) {
      try {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(raw);

        const version = typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : 1;

        if (parsed.memory && typeof parsed.memory === 'object') {
          const validatedLocations: Record<string, { x: number; y: number; z: number }> = {};
          if (parsed.memory.namedLocations && typeof parsed.memory.namedLocations === 'object') {
            for (const [k, v] of Object.entries(parsed.memory.namedLocations)) {
              if (v && typeof v === 'object' && Number.isFinite((v as any).x) && Number.isFinite((v as any).y) && Number.isFinite((v as any).z)) {
                validatedLocations[k.substring(0, 50)] = {
                  x: Math.round((v as any).x),
                  y: Math.round((v as any).y),
                  z: Math.round((v as any).z),
                };
              }
            }
          }

          const validatedDangerZones: { name: string; x: number; y: number; z: number; radius: number }[] = [];
          if (Array.isArray(parsed.memory.dangerZones)) {
            for (const z of parsed.memory.dangerZones) {
              if (z && typeof z === 'object' && Number.isFinite(z.x) && Number.isFinite(z.y) && Number.isFinite(z.z)) {
                validatedDangerZones.push({
                  name: String(z.name || 'danger').substring(0, 50),
                  x: Math.round(z.x),
                  y: Math.round(z.y),
                  z: Math.round(z.z),
                  radius: Math.min(Math.max(z.radius || 10, 1), 100),
                });
              }
            }
          }

          const now = Date.now();

          // Phase 5 Collections with validation & bounding
          const exploredRegions: ExploredRegionRecord[] = Array.isArray(parsed.memory.exploredRegions)
            ? parsed.memory.exploredRegions.filter((r: any) => Number.isFinite(r.chunkX) && Number.isFinite(r.chunkZ)).slice(-100)
            : [];

          const knownLocations: KnownLocationRecord[] = Array.isArray(parsed.memory.knownLocations)
            ? parsed.memory.knownLocations.filter((l: any) => l && l.position && Number.isFinite(l.position.x)).slice(-50)
            : [];

          const resourceObservations: ResourceObservationRecord[] = Array.isArray(parsed.memory.resourceObservations)
            ? parsed.memory.resourceObservations
                .filter((r: any) => r && r.position && Number.isFinite(r.position.x) && r.expiresAt > now)
                .slice(-100)
            : [];

          const failedTargets: FailedTargetMemoryRecord[] = Array.isArray(parsed.memory.failedTargets)
            ? parsed.memory.failedTargets
                .filter((f: any) => f && f.position && Number.isFinite(f.position.x) && f.expiresAt > now)
                .slice(-100)
            : [];

          const goalOutcomes: GoalOutcomeRecord[] = Array.isArray(parsed.memory.goalOutcomes)
            ? parsed.memory.goalOutcomes.slice(-20)
            : [];

          const strategyRankings: Record<string, StrategyRankingRecord> =
            parsed.memory.strategyRankings && typeof parsed.memory.strategyRankings === 'object'
              ? parsed.memory.strategyRankings
              : {};

          this.memoryNotes = {
            namedLocations: validatedLocations,
            facts: Array.isArray(parsed.memory.facts)
              ? parsed.memory.facts.filter((f: any) => typeof f === 'string').map((f: string) => f.substring(0, 250)).slice(-50)
              : [],
            dangerZones: validatedDangerZones.slice(-50),
            completedGoals: Array.isArray(parsed.memory.completedGoals)
              ? parsed.memory.completedGoals.filter((g: any) => typeof g === 'string').map((g: string) => g.substring(0, 200)).slice(-50)
              : [],
            exploredRegions,
            knownLocations,
            resourceObservations,
            failedTargets,
            goalOutcomes,
            strategyRankings,
            planCache: parsed.memory.planCache,
          };

          if (parsed.memory.planCache && typeof parsed.memory.planCache === 'object') {
            this.planCache.deserialize(parsed.memory.planCache);
          }
        }

        if (parsed.agentState && typeof parsed.agentState === 'object') {
          this.agentState = {
            currentGoal: typeof parsed.agentState.currentGoal === 'string'
              ? parsed.agentState.currentGoal.substring(0, 300)
              : this.agentState.currentGoal,
            planSteps: Array.isArray(parsed.agentState.planSteps)
              ? parsed.agentState.planSteps
                  .filter((s: any) => s && typeof s.step === 'string')
                  .map((s: any) => parsePlanStep(s))
                  .slice(0, 10)
              : this.agentState.planSteps,
            stepNumber: typeof parsed.agentState.stepNumber === 'number' ? parsed.agentState.stepNumber : 0,
            stuckCounter: 0,
            timeSinceLastProgressSeconds: 0,
          };
        }

        // Schema migration: If legacy schema (v1 or unversioned), upgrade to v2 and save atomically
        if (version < 2) {
          console.log(`[MEMORY] Migrated memory schema from v${version} to v2 for world ${this.worldId}.`);
          this.saveToDisk();
        }
      } catch (err: any) {
        console.error('Corrupted memory file detected. Quarantining:', err.message);
        try {
          const quarantinePath = `${this.filePath}.corrupted-${Date.now()}`;
          fs.renameSync(this.filePath, quarantinePath);
        } catch {}
      }
    }
  }
}
