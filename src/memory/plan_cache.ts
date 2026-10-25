import { TaskPlan, TaskNode } from '../types/index.js';

export interface IPlanCacheEntry {
  goalHash: string;
  successfulDAG: TaskPlan;
  averageExecutionDurationMs: number;
  resourceYieldRatio: number;
  failureCount: number;
  lastUsedAt: number;
  environmentalContext?: {
    requiredWorkstations?: string[];
    startingInventorySnapshot?: Record<string, number>;
  };
}

/**
 * Validated Plan Cache Subsystem.
 * Caches proven DAG execution topologies to minimize dynamic compilation overhead
 * and track plan execution costs and performance over time.
 */
export class PlanCache {
  private cache: Map<string, IPlanCacheEntry> = new Map();

  constructor(initialData?: Record<string, IPlanCacheEntry>) {
    if (initialData) {
      this.deserialize(initialData);
    }
  }

  /**
   * Generates a canonical hash string from goal parameters.
   */
  public static computeGoalHash(goal: string, targetCount: number = 1): string {
    const normalized = String(goal || '')
      .toLowerCase()
      .trim()
      .replace(/[\s-]+/g, '_');
    return `${normalized}:${targetCount}`;
  }

  /**
   * Retrieves a previously validated plan if environmental preconditions still hold.
   */
  public get(
    goalHash: string,
    currentInventory: Record<string, number> = {},
    knownWorkstations: string[] = []
  ): TaskPlan | null {
    const entry = this.cache.get(goalHash);
    if (!entry) return null;

    // Invalidation 1: Exceeded failure threshold (3 consecutive failures)
    if (entry.failureCount >= 3) {
      return null;
    }

    // Invalidation 2: Environmental context mismatch (e.g. requires workstation that is unavailable)
    if (entry.environmentalContext?.requiredWorkstations) {
      for (const ws of entry.environmentalContext.requiredWorkstations) {
        const inInv = (currentInventory[ws] || 0) > 0;
        const inWorld = knownWorkstations.includes(ws);
        if (!inInv && !inWorld) {
          // Precondition invalidated: required workstation unavailable
          return null;
        }
      }
    }

    // Clone plan with fresh task IDs and reset statuses
    const now = Date.now();
    const clonedPlan: TaskPlan = {
      goalId: entry.successfulDAG.goalId,
      tasks: entry.successfulDAG.tasks.map((t, idx) => ({
        ...t,
        id: `cached_${t.actionName}_${idx}_${now}`,
        status: idx === 0 ? 'ready' : 'pending',
        retryCount: 0,
        evidence: [],
      })),
      createdAt: now,
      status: 'active',
    };

    return clonedPlan;
  }

  /**
   * Records a successful execution of a plan, updating running duration metrics and yield ratios.
   */
  public recordSuccess(
    goalHash: string,
    plan: TaskPlan,
    durationMs: number,
    resourceYieldRatio: number = 1.0,
    context?: IPlanCacheEntry['environmentalContext']
  ): void {
    const existing = this.cache.get(goalHash);
    if (existing) {
      const totalExecutions = (existing as any)._execCount ? (existing as any)._execCount + 1 : 2;
      existing.averageExecutionDurationMs = Math.round(
        (existing.averageExecutionDurationMs * (totalExecutions - 1) + durationMs) / totalExecutions
      );
      existing.resourceYieldRatio = Math.round(((existing.resourceYieldRatio + resourceYieldRatio) / 2) * 100) / 100;
      existing.failureCount = 0;
      existing.lastUsedAt = Date.now();
      existing.successfulDAG = plan;
      (existing as any)._execCount = totalExecutions;
    } else {
      this.cache.set(goalHash, {
        goalHash,
        successfulDAG: plan,
        averageExecutionDurationMs: Math.round(durationMs),
        resourceYieldRatio,
        failureCount: 0,
        lastUsedAt: Date.now(),
        environmentalContext: context,
      });
    }
  }

  /**
   * Records an execution failure, incrementing failure counter toward cache eviction.
   */
  public recordFailure(goalHash: string): void {
    const existing = this.cache.get(goalHash);
    if (existing) {
      existing.failureCount++;
      if (existing.failureCount >= 3) {
        existing.failureCount = 3;
      }
    }
  }

  /**
   * Checks whether a cached plan exists and is currently valid.
   */
  public has(goalHash: string): boolean {
    const entry = this.cache.get(goalHash);
    return Boolean(entry && entry.failureCount < 3);
  }

  /**
   * Invalidates a cache entry manually.
   */
  public invalidate(goalHash: string): void {
    this.cache.delete(goalHash);
  }

  public clear(): void {
    this.cache.clear();
  }

  public serialize(): Record<string, IPlanCacheEntry> {
    const result: Record<string, IPlanCacheEntry> = {};
    for (const [key, value] of this.cache.entries()) {
      result[key] = value;
    }
    return result;
  }

  public deserialize(data: Record<string, IPlanCacheEntry>): void {
    this.cache.clear();
    if (!data || typeof data !== 'object') return;
    for (const [key, value] of Object.entries(data)) {
      if (value && value.goalHash && value.successfulDAG) {
        this.cache.set(key, value);
      }
    }
  }
}

export const defaultPlanCache = new PlanCache();
