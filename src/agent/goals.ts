import { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import {
  GoalSpec,
  TaskNode,
  TaskPlan,
  TaskStatus,
  FailureKind,
  TaskBaseline,
  TaskExecutionResult,
  Observation,
  ActionResult,
} from '../types/index.js';
import { ActionArbiter, ActionPriority } from './arbiter.js';
import { AvailabilityEngine } from '../actions/availability.js';
import { ACTION_ALLOWED_PARAMS } from '../prompt/schema.js';

export function getBotInventoryCounts(bot: any): Record<string, number> {
  const counts: Record<string, number> = {};
  if (!bot || !bot.inventory) return counts;
  const items = typeof bot.inventory.items === 'function' ? bot.inventory.items() : [];
  for (const it of items) {
    if (it && it.name && typeof it.count === 'number') {
      counts[it.name] = (counts[it.name] || 0) + it.count;
    }
  }
  return counts;
}

/**
 * Normalizes item names to standard Minecraft item identifiers.
 */
export function normalizeItemName(raw: string): string {
  const lower = String(raw || '').toLowerCase().trim().replace(/[\s-]+/g, '_');
  if (['log', 'logs', 'wood', 'oak_wood', 'oak_log', 'oak_logs'].includes(lower)) return 'oak_log';
  if (['plank', 'planks', 'wooden_planks', 'oak_plank', 'oak_planks'].includes(lower)) return 'oak_planks';
  if (['cobble', 'cobblestone', 'cobblestones', 'stone', 'stone_block', 'stone_blocks'].includes(lower)) return 'cobblestone';
  if (['table', 'workbench', 'crafting_table'].includes(lower)) return 'crafting_table';
  if (['wooden_pick', 'wood_pickaxe', 'wooden_pickaxe'].includes(lower)) return 'wooden_pickaxe';
  if (['stone_pick', 'stone_pickaxe'].includes(lower)) return 'stone_pickaxe';
  return lower;
}

/**
 * Parses and validates raw input text or partial GoalSpec into a validated GoalSpec.
 * Preserves quantity thresholds and captures baseline count for delta awareness.
 */
export function parseAndValidateGoalSpec(
  input: string | Partial<GoalSpec>,
  currentInventory?: Record<string, number>,
  isOwner: boolean = true
): GoalSpec | null {
  const inv = currentInventory || {};
  const now = Date.now();

  if (typeof input === 'object' && input !== null) {
    if (!input.kind) return null;
    const kind = input.kind;

    if (kind === 'have') {
      if (!input.item || typeof input.item !== 'string') return null;
      const item = normalizeItemName(input.item);
      const count = typeof input.count === 'number' && input.count > 0 ? Math.min(input.count, 256) : 1;
      const mode = input.mode === 'absolute' ? 'absolute' : 'additional';
      const baselineCount = typeof input.baselineCount === 'number' ? input.baselineCount : (inv[item] || 0);

      return {
        id: `goal_have_${item}_${count}_${now}`,
        kind: 'have',
        item,
        count,
        mode,
        baselineCount,
        isOwnerGoal: isOwner,
        rawInstruction: input.rawInstruction,
        createdAt: now,
      };
    }

    if (kind === 'have_tool') {
      if (!input.tool || typeof input.tool !== 'string') return null;
      const tool = normalizeItemName(input.tool);
      return {
        id: `goal_tool_${tool}_${now}`,
        kind: 'have_tool',
        tool,
        tier: input.tier,
        isOwnerGoal: isOwner,
        rawInstruction: input.rawInstruction,
        createdAt: now,
      };
    }

    if (kind === 'reach') {
      if (!input.target || typeof input.target.x !== 'number') return null;
      return {
        id: `goal_reach_${Math.floor(input.target.x)}_${Math.floor(input.target.y)}_${Math.floor(input.target.z)}_${now}`,
        kind: 'reach',
        target: { x: input.target.x, y: input.target.y, z: input.target.z },
        tolerance: input.tolerance ?? 2,
        isOwnerGoal: isOwner,
        rawInstruction: input.rawInstruction,
        createdAt: now,
      };
    }

    if (kind === 'explore') {
      return {
        id: `goal_explore_${now}`,
        kind: 'explore',
        query: input.query,
        budgetSeconds: input.budgetSeconds ?? 60,
        isOwnerGoal: isOwner,
        rawInstruction: input.rawInstruction,
        createdAt: now,
      };
    }

    if (kind === 'kill') {
      if (!input.entityType) return null;
      return {
        id: `goal_kill_${input.entityType}_${now}`,
        kind: 'kill',
        entityType: input.entityType,
        count: typeof input.count === 'number' && input.count > 0 ? input.count : 1,
        isOwnerGoal: isOwner,
        rawInstruction: input.rawInstruction,
        createdAt: now,
      };
    }

    if (kind === 'idle') {
      return {
        id: `goal_idle_${now}`,
        kind: 'idle',
        reason: input.reason || 'idle',
        isOwnerGoal: isOwner,
        rawInstruction: input.rawInstruction,
        createdAt: now,
      };
    }

    return {
      id: `goal_custom_${now}`,
      kind: 'custom',
      description: (input as any).description || 'Custom goal',
      isOwnerGoal: isOwner,
      rawInstruction: input.rawInstruction,
      createdAt: now,
    };
  }

  // Parse natural language string input
  const text = String(input || '').trim();
  if (!text) return null;

  // 1. Cancel / stop / idle
  if (/^(!?(cancel|stop|clear_goal|cleargoal|idle))\b/i.test(text)) {
    return {
      id: `goal_idle_${now}`,
      kind: 'idle',
      reason: 'Owner cancelled goal',
      isOwnerGoal: isOwner,
      rawInstruction: text,
      createdAt: now,
    };
  }

  // 2. Resource gathering: "gather 16 oak logs", "collect 8 cobblestone", "chop 4 trees"
  const gatherMatch = text.match(/\b(?:gather|collect|chop|mine|get)\s+(\d+)\s+([a-zA-Z_]+(?:\s+[a-zA-Z_]+)?)\b/i);
  if (gatherMatch) {
    const count = Math.min(parseInt(gatherMatch[1], 10), 256);
    const item = normalizeItemName(gatherMatch[2]);
    const baselineCount = inv[item] || 0;
    return {
      id: `goal_have_${item}_${count}_${now}`,
      kind: 'have',
      item,
      count,
      mode: 'additional',
      baselineCount,
      isOwnerGoal: isOwner,
      rawInstruction: text,
      createdAt: now,
    };
  }

  // 3. Absolute threshold: "have 16 planks", "need 4 sticks"
  const haveMatch = text.match(/\b(?:have|need|keep)\s+(\d+)\s+([a-zA-Z_]+(?:\s+[a-zA-Z_]+)?)\b/i);
  if (haveMatch) {
    const count = Math.min(parseInt(haveMatch[1], 10), 256);
    const item = normalizeItemName(haveMatch[2]);
    const baselineCount = inv[item] || 0;
    return {
      id: `goal_have_${item}_${count}_${now}`,
      kind: 'have',
      item,
      count,
      mode: 'absolute',
      baselineCount,
      isOwnerGoal: isOwner,
      rawInstruction: text,
      createdAt: now,
    };
  }

  // 4. Tool crafting: "craft wooden_pickaxe", "craft a wooden pickaxe", "make a stone pickaxe"
  const toolMatch = text.match(/\b(?:craft|make|create|get)\s+(?:a\s+)?([a-zA-Z_]+[\s_]pickaxe|crafting_table|furnace)\b/i);
  if (toolMatch) {
    const tool = normalizeItemName(toolMatch[1]);
    return {
      id: `goal_tool_${tool}_${now}`,
      kind: 'have_tool',
      tool,
      isOwnerGoal: isOwner,
      rawInstruction: text,
      createdAt: now,
    };
  }

  // 5. Reach target: "goto 100 64 200", "reach 50 70 80"
  const reachMatch = text.match(/\b(?:goto|reach|walk to)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\b/i);
  if (reachMatch) {
    const x = parseFloat(reachMatch[1]);
    const y = parseFloat(reachMatch[2]);
    const z = parseFloat(reachMatch[3]);
    return {
      id: `goal_reach_${Math.floor(x)}_${Math.floor(y)}_${Math.floor(z)}_${now}`,
      kind: 'reach',
      target: { x, y, z },
      tolerance: 2,
      isOwnerGoal: isOwner,
      rawInstruction: text,
      createdAt: now,
    };
  }

  // 6. Explore: "explore", "explore north"
  if (/^explore\b/i.test(text)) {
    return {
      id: `goal_explore_${now}`,
      kind: 'explore',
      query: text,
      budgetSeconds: 60,
      isOwnerGoal: isOwner,
      rawInstruction: text,
      createdAt: now,
    };
  }

  // 7. Fallback: custom open-ended goal
  return {
    id: `goal_custom_${now}`,
    kind: 'custom',
    description: text,
    isOwnerGoal: isOwner,
    rawInstruction: text,
    createdAt: now,
  };
}

/**
 * Deterministic Goal Resolver (Layer 4):
 * Expands known goals into a bounded DAG of TaskNodes without requiring an LLM call.
 * Detects already-satisfied prerequisites and marks them 'satisfied' at plan start.
 */
export class DeterministicGoalResolver {
  public static resolve(spec: GoalSpec, currentInventory: Record<string, number> = {}): TaskPlan | null {
    const now = Date.now();
    const tasks: TaskNode[] = [];

    // 1. Have Resource Goal
    if (spec.kind === 'have') {
      const currentCount = currentInventory[spec.item] || 0;
      const targetCount = spec.mode === 'additional' ? spec.baselineCount + spec.count : spec.count;
      const needed = targetCount - currentCount;

      if (needed <= 0) {
        tasks.push({
          id: `task_have_${spec.item}_already_satisfied`,
          type: 'gather',
          actionName: 'wait',
          params: { seconds: 0.1 },
          prerequisites: [],
          status: 'satisfied',
          retryCount: 0,
          maxRetries: 1,
          evidence: [`Item count ${spec.item} (${currentCount}) already meets target (${targetCount})`],
        });
      } else {
        const actionName = spec.item.includes('log')
          ? 'chop_tree'
          : spec.item === 'cobblestone' || spec.item === 'stone'
          ? 'collect_resource'
          : spec.item === 'oak_planks' || spec.item === 'stick' || spec.item === 'crafting_table'
          ? 'craft_item'
          : 'collect_resource';

        const params: Record<string, any> = spec.item.includes('log')
          ? { logType: spec.item, count: needed }
          : spec.item === 'cobblestone' || spec.item === 'stone'
          ? { resource: 'stone', count: needed }
          : spec.item === 'oak_planks' || spec.item === 'stick'
          ? { item: spec.item, count: Math.ceil(needed / 4) }
          : spec.item === 'crafting_table'
          ? { item: 'crafting_table', count: needed }
          : { resource: spec.item, count: needed };

        tasks.push({
          id: `task_gather_${spec.item}`,
          type: 'gather',
          actionName,
          params,
          prerequisites: [],
          status: 'ready',
          retryCount: 0,
          maxRetries: 3,
          budgetMs: 40000,
          evidence: [],
          postcondition: (bot: any, baseline: TaskBaseline) => {
            const counts = getBotInventoryCounts(bot);
            const nowCount = counts[spec.item] || 0;
            return nowCount >= targetCount;
          },
        });
      }

      return {
        goalId: spec.id,
        tasks,
        createdAt: now,
        status: tasks.every((t) => t.status === 'satisfied') ? 'completed' : 'active',
      };
    }

    // 2. Have Tool Goal: e.g. wooden_pickaxe
    if (spec.kind === 'have_tool' && spec.tool === 'wooden_pickaxe') {
      const hasPick = (currentInventory['wooden_pickaxe'] || 0) >= 1;
      const hasTable = (currentInventory['crafting_table'] || 0) >= 1;
      const stickCount = currentInventory['stick'] || 0;
      const plankCount = Object.entries(currentInventory)
        .filter(([k]) => k.endsWith('_planks'))
        .reduce((sum, [, v]) => sum + v, 0);
      const logCount = Object.entries(currentInventory)
        .filter(([k]) => k.endsWith('_log') || k.endsWith('_wood'))
        .reduce((sum, [, v]) => sum + v, 0);

      // Task 1: Gather Logs
      const logsSatisfied = hasPick || hasTable || plankCount >= 4 || logCount >= 3;
      tasks.push({
        id: 'task_gather_logs',
        type: 'gather',
        actionName: 'chop_tree',
        params: { count: 3 },
        prerequisites: [],
        status: logsSatisfied ? 'satisfied' : 'ready',
        retryCount: 0,
        maxRetries: 3,
        budgetMs: 60000,
        evidence: logsSatisfied ? ['Log prerequisite already satisfied by current inventory'] : [],
        postcondition: (bot: any) => {
          const c = getBotInventoryCounts(bot);
          const currentLogs = Object.entries(c)
            .filter(([k]) => k.endsWith('_log') || k.endsWith('_wood'))
            .reduce((sum, [, v]) => sum + v, 0);
          const currentPlanks = Object.entries(c)
            .filter(([k]) => k.endsWith('_planks'))
            .reduce((sum, [, v]) => sum + v, 0);
          return currentLogs >= 3 || currentPlanks >= 4 || (c['wooden_pickaxe'] || 0) >= 1;
        },
      });

      // Task 2: Craft Planks
      const planksSatisfied = hasPick || hasTable || plankCount >= 4;
      const detectedLog = Object.keys(currentInventory).find((k) => k.endsWith('_log'));
      const targetPlankName = detectedLog ? detectedLog.replace('_log', '_planks') : 'oak_planks';
      tasks.push({
        id: 'task_craft_planks',
        type: 'craft',
        actionName: 'craft_item',
        params: { item: targetPlankName, count: 12 },
        prerequisites: ['task_gather_logs'],
        status: planksSatisfied ? 'satisfied' : logsSatisfied ? 'ready' : 'pending',
        retryCount: 0,
        maxRetries: 2,
        evidence: planksSatisfied ? ['Planks prerequisite already satisfied'] : [],
        postcondition: (bot: any) => {
          const c = getBotInventoryCounts(bot);
          const currentPlanks = Object.entries(c)
            .filter(([k]) => k.endsWith('_planks'))
            .reduce((sum, [, v]) => sum + v, 0);
          return currentPlanks >= 4 || (c['wooden_pickaxe'] || 0) >= 1;
        },
      });

      // Task 3: Craft Crafting Table
      const tableSatisfied = hasPick || hasTable;
      tasks.push({
        id: 'task_craft_table',
        type: 'craft',
        actionName: 'craft_item',
        params: { item: 'crafting_table', count: 1 },
        prerequisites: ['task_craft_planks'],
        status: tableSatisfied ? 'satisfied' : planksSatisfied ? 'ready' : 'pending',
        retryCount: 0,
        maxRetries: 2,
        evidence: tableSatisfied ? ['Crafting table already present in inventory'] : [],
        postcondition: (bot: any) => {
          const c = getBotInventoryCounts(bot);
          return (c['crafting_table'] || 0) >= 1 || (c['wooden_pickaxe'] || 0) >= 1;
        },
      });

      // Task 4: Craft Sticks
      const sticksSatisfied = hasPick || stickCount >= 2;
      tasks.push({
        id: 'task_craft_sticks',
        type: 'craft',
        actionName: 'craft_item',
        params: { item: 'stick', count: 1 },
        prerequisites: ['task_craft_planks'],
        status: sticksSatisfied ? 'satisfied' : planksSatisfied ? 'ready' : 'pending',
        retryCount: 0,
        maxRetries: 2,
        evidence: sticksSatisfied ? ['Sticks prerequisite already present in inventory'] : [],
        postcondition: (bot: any) => {
          const c = getBotInventoryCounts(bot);
          return (c['stick'] || 0) >= 2 || (c['wooden_pickaxe'] || 0) >= 1;
        },
      });

      // Task 5: Craft Wooden Pickaxe
      tasks.push({
        id: 'task_craft_pickaxe',
        type: 'craft',
        actionName: 'craft_item',
        params: { item: 'wooden_pickaxe', count: 1 },
        prerequisites: ['task_craft_table', 'task_craft_sticks'],
        status: hasPick ? 'satisfied' : tableSatisfied && sticksSatisfied ? 'ready' : 'pending',
        retryCount: 0,
        maxRetries: 2,
        evidence: hasPick ? ['Wooden pickaxe already present in inventory'] : [],
        postcondition: (bot: any) => {
          const c = getBotInventoryCounts(bot);
          return (c['wooden_pickaxe'] || 0) >= 1;
        },
      });

      return {
        goalId: spec.id,
        tasks,
        createdAt: now,
        status: hasPick ? 'completed' : 'active',
      };
    }

    // 3. Reach Goal
    if (spec.kind === 'reach') {
      tasks.push({
        id: `task_reach_${Math.floor(spec.target.x)}_${Math.floor(spec.target.y)}_${Math.floor(spec.target.z)}`,
        type: 'reach',
        actionName: 'goto',
        params: { x: spec.target.x, y: spec.target.y, z: spec.target.z, range: spec.tolerance ?? 2 },
        prerequisites: [],
        status: 'ready',
        retryCount: 0,
        maxRetries: 2,
        evidence: [],
        postcondition: (bot: any) => {
          if (!bot?.entity?.position) return false;
          const pos = bot.entity.position;
          const dx = pos.x - spec.target.x;
          const dy = pos.y - spec.target.y;
          const dz = pos.z - spec.target.z;
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
          return dist <= (spec.tolerance ?? 2) + 0.8;
        },
      });

      return {
        goalId: spec.id,
        tasks,
        createdAt: now,
        status: 'active',
      };
    }

    // 4. Explore Goal
    if (spec.kind === 'explore') {
      tasks.push({
        id: 'task_explore_step',
        type: 'explore',
        actionName: 'explore',
        params: { direction: 'north', distance: 16 },
        prerequisites: [],
        status: 'ready',
        retryCount: 0,
        maxRetries: 2,
        evidence: [],
      });

      return {
        goalId: spec.id,
        tasks,
        createdAt: now,
        status: 'active',
      };
    }

    // Custom or complex goal: requires LLM strategic planner
    return null;
  }
}

/**
 * TaskExecutor (Layer 4):
 * Manages task graph status, execution, postcondition verification, cancellation,
 * and failure cascade. Prevents duplicate simultaneous goals and infinite retries.
 */
export class TaskExecutor {
  public activeGoal: GoalSpec | null = null;
  public activePlan: TaskPlan | null = null;
  private logger?: any;

  constructor(logger?: any) {
    this.logger = logger;
  }

  public hasActiveGoal(): boolean {
    return Boolean(this.activeGoal && this.activePlan && this.activePlan.status === 'active');
  }

  public setGoal(
    spec: GoalSpec,
    currentInventory: Record<string, number> = {}
  ): { accepted: boolean; reason?: string } {
    // 1. Anti-Duplication: Reject duplicate simultaneous goals
    if (this.activeGoal && this.activePlan && this.activePlan.status === 'active') {
      if (this.activeGoal.kind === spec.kind) {
        if (
          spec.kind === 'have' &&
          this.activeGoal.kind === 'have' &&
          this.activeGoal.item === spec.item &&
          this.activeGoal.count === spec.count &&
          this.activeGoal.mode === spec.mode
        ) {
          return { accepted: false, reason: 'Duplicate goal already active' };
        }
        if (
          spec.kind === 'have_tool' &&
          this.activeGoal.kind === 'have_tool' &&
          this.activeGoal.tool === spec.tool
        ) {
          return { accepted: false, reason: 'Duplicate goal already active' };
        }
      }

      // Explicit replacement: Cancel previous goal and its active tasks cleanly
      this.logger?.info?.(
        `[GOAL_EXECUTOR] Replacing active goal '${this.activeGoal.id}' with new goal '${spec.id}'.`
      );
      this.cancelGoal('Replaced by newer owner goal');
    }

    this.activeGoal = spec;
    const resolvedPlan = DeterministicGoalResolver.resolve(spec, currentInventory);
    if (resolvedPlan) {
      this.activePlan = resolvedPlan;
      this.updateTaskReadiness();
    } else {
      // Custom / LLM-guided goal
      this.activePlan = {
        goalId: spec.id,
        tasks: [],
        createdAt: Date.now(),
        status: 'active',
      };
    }

    return { accepted: true };
  }

  public cancelGoal(reason: string = 'Owner cancelled'): void {
    if (this.activePlan) {
      for (const task of this.activePlan.tasks) {
        if (task.status === 'pending' || task.status === 'ready' || task.status === 'running') {
          task.status = 'cancelled';
          task.failureKind = 'CANCELLED';
          task.failureReason = reason;
        }
      }
      this.activePlan.status = 'cancelled';
    }
    this.activeGoal = null;
  }

  public getNextReadyTask(): TaskNode | null {
    if (!this.activePlan || this.activePlan.status !== 'active') return null;

    // Check for any task currently ready
    let ready = this.activePlan.tasks.find((t) => t.status === 'ready');
    if (ready) return ready;

    // Update readiness for pending tasks
    this.updateTaskReadiness();
    return this.activePlan.tasks.find((t) => t.status === 'ready') || null;
  }

  public async executeTask(
    task: TaskNode,
    bot: any,
    arbiter: ActionArbiter,
    config: any,
    logger: any,
    obs: Observation
  ): Promise<TaskExecutionResult> {
    const startTime = Date.now();
    task.status = 'running';
    task.startedAt = startTime;

    // 1. Capture baseline measurements for postcondition verification
    const baseline: TaskBaseline = {
      inventoryCounts: getBotInventoryCounts(bot),
      position: bot?.entity?.position ? { ...bot.entity.position } : undefined,
      time: startTime,
    };

    // 2. Start action through arbiter
    const { actionId, signal, epoch } = arbiter.startAction(
      task.actionName,
      ActionPriority.NORMAL,
      bot,
      ['movement', 'hands', 'window']
    );

    // Dynamically match plank type to whatever log species was actually chopped into inventory
    let executionParams = { ...task.params };
    if (task.id === 'task_craft_planks' || (task.actionName === 'craft_item' && task.params?.item?.endsWith('_planks'))) {
      const counts = getBotInventoryCounts(bot);
      const actualLog = Object.keys(counts).find((k) => (k.endsWith('_log') || k.endsWith('_wood')) && counts[k] > 0);
      if (actualLog) {
        const matchingPlank = actualLog.replace(/_log|_wood/, '_planks');
        const availableLogs = counts[actualLog] || 0;
        const requestedPlanks = executionParams.count || 12;
        const maxPlanks = Math.max(4, availableLogs * 4);
        const actualCount = Math.min(requestedPlanks, maxPlanks);
        executionParams = { ...executionParams, item: matchingPlank, count: actualCount };
      }
    }

    let actionResult: ActionResult;
    try {
      actionResult = await AvailabilityEngine.executeWithTimeout(
        task.actionName,
        executionParams,
        bot,
        obs,
        config,
        logger,
        signal,
        task.budgetMs ?? 30000,
        actionId,
        arbiter,
        epoch
      );
    } catch (err: any) {
      actionResult = { status: 'failed', reason: err?.message || 'Skill execution threw error' };
    } finally {
      arbiter.finishAction(actionId, epoch, bot);
    }

    const durationMs = Date.now() - startTime;

    // 3. Postcondition Verification: "A skill returning without throwing is not proof of success."
    if (typeof task.postcondition === 'function') {
      try {
        const postconditionPassed = await task.postcondition(bot, baseline);
        if (postconditionPassed) {
          // Regardless of whether skill returned success or timed out, the physical goal state was achieved!
          actionResult = { status: 'success', reason: 'Postcondition verified successfully in bot state.' };
        } else if (actionResult.status === 'success') {
          task.failureKind = 'POSTCONDITION_FAILED';
          task.failureReason = 'Postcondition verification failed: required state delta not observed';
          task.evidence.push(`Postcondition check failed despite skill returning success`);
          task.retryCount++;

          if (task.retryCount >= task.maxRetries) {
            task.status = 'failed';
            task.failureKind = 'RETRY_BUDGET_EXHAUSTED';
            this.cascadePrerequisiteFailure(task.id);
          } else {
            task.status = 'ready'; // Allow retry
          }

          return {
            taskId: task.id,
            status: task.status,
            failureKind: task.failureKind,
            failureReason: task.failureReason,
            evidence: [...task.evidence],
            durationMs,
          };
        }
      } catch (err: any) {
        task.failureKind = 'POSTCONDITION_FAILED';
        task.failureReason = `Postcondition evaluation threw: ${err?.message}`;
        task.status = 'failed';
        this.cascadePrerequisiteFailure(task.id);
        return {
          taskId: task.id,
          status: 'failed',
          failureKind: task.failureKind,
          failureReason: task.failureReason,
          evidence: [...task.evidence],
          durationMs,
        };
      }
    }

    // 4. Handle Action Failure
    if (actionResult.status !== 'success') {
      task.failureKind = 'NO_PROGRESS';
      task.failureReason = actionResult.reason;
      task.evidence.push(`Action failed: ${actionResult.reason}`);
      task.retryCount++;

      if (task.retryCount >= task.maxRetries) {
        task.status = 'failed';
        task.failureKind = 'RETRY_BUDGET_EXHAUSTED';
        this.cascadePrerequisiteFailure(task.id);
      } else {
        task.status = 'ready';
      }

      return {
        taskId: task.id,
        status: task.status,
        failureKind: task.failureKind,
        failureReason: task.failureReason,
        evidence: [...task.evidence],
        durationMs,
      };
    }

    // 5. Success
    task.status = 'succeeded';
    task.completedAt = Date.now();
    task.evidence.push('Action completed and postcondition verified successfully.');

    // Update readiness of downstream dependent tasks
    this.updateTaskReadiness();

    // Check if entire plan is completed
    if (this.isPlanCompleted()) {
      if (this.activePlan) this.activePlan.status = 'completed';
    }

    return {
      taskId: task.id,
      status: 'succeeded',
      evidence: [...task.evidence],
      durationMs,
    };
  }

  public isPlanCompleted(): boolean {
    if (!this.activePlan || this.activePlan.tasks.length === 0) return false;
    return this.activePlan.tasks.every(
      (t) => t.status === 'succeeded' || t.status === 'satisfied'
    );
  }

  public updateTaskReadiness(): void {
    if (!this.activePlan) return;

    for (const task of this.activePlan.tasks) {
      if (task.status === 'pending') {
        const allPrereqsMet = task.prerequisites.every((prereqId) => {
          const prereq = this.activePlan?.tasks.find((t) => t.id === prereqId);
          return prereq && (prereq.status === 'succeeded' || prereq.status === 'satisfied');
        });

        if (allPrereqsMet) {
          task.status = 'ready';
        }
      }
    }
  }

  public cascadePrerequisiteFailure(failedTaskId: string): void {
    if (!this.activePlan) return;

    for (const task of this.activePlan.tasks) {
      if (task.prerequisites.includes(failedTaskId) && task.status !== 'failed' && task.status !== 'cancelled') {
        task.status = 'failed';
        task.failureKind = 'PREREQUISITE_FAILED';
        task.failureReason = `Prerequisite task '${failedTaskId}' failed.`;
        task.evidence.push(`Prerequisite task '${failedTaskId}' failed; aborting dependent task.`);
        this.cascadePrerequisiteFailure(task.id);
      }
    }
  }
}
