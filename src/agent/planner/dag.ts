import { TaskNode, TaskPlan, TaskBaseline } from '../../types/index.js';
import { IOperatorDefinition, OperatorRegistry, defaultOperatorRegistry, TOOL_TIERS } from './operator.js';
import { normalizeItemName, getBotInventoryCounts } from '../goals.js';

export interface PlanGenerationOptions {
  registry?: OperatorRegistry;
  allowWorkstationRecursion?: boolean;
  knownWorkstations?: string[];
}

export class DynamicDAGCompiler {
  private registry: OperatorRegistry;
  private taskCounter = 0;

  constructor(registry: OperatorRegistry = defaultOperatorRegistry) {
    this.registry = registry;
  }

  /**
   * Compiles an executable DAG plan to acquire `targetItem` with `targetCount`.
   * Recursively backward-chains dependencies (ingredients, workstations, tools).
   */
  public compilePlan(
    goalId: string,
    targetItemRaw: string,
    targetCount: number = 1,
    currentInventory: Record<string, number> = {},
    options: PlanGenerationOptions = {}
  ): TaskPlan | null {
    const targetItem = normalizeItemName(targetItemRaw);
    const virtualInv: Record<string, number> = { ...currentInventory };

    // Group common item aliases (e.g. birch_log -> oak_log pool if generic log needed)
    this.normalizeVirtualInventory(virtualInv);

    if ((virtualInv[targetItem] || 0) >= targetCount) {
      return {
        goalId,
        tasks: [],
        createdAt: Date.now(),
        status: 'completed',
      };
    }

    const tasks: TaskNode[] = [];
    const visitedInStack = new Set<string>();

    const rootTaskId = this.resolveRequirement(
      targetItem,
      targetCount,
      virtualInv,
      tasks,
      visitedInStack,
      currentInventory,
      options
    );

    if (!rootTaskId) {
      return null;
    }

    // Deduplicate and topologically order tasks
    const orderedTasks = this.topologicalSort(tasks);

    // Initial readiness evaluation
    const satisfiedIds = new Set(orderedTasks.filter((t) => t.status === 'satisfied').map((t) => t.id));
    for (const t of orderedTasks) {
      if (t.status === 'pending') {
        const prereqsDone = t.prerequisites.every((pid) => satisfiedIds.has(pid));
        if (prereqsDone) {
          t.status = 'ready';
        }
      }
    }

    const allSatisfied = orderedTasks.every((t) => t.status === 'satisfied');

    return {
      goalId,
      tasks: orderedTasks,
      createdAt: Date.now(),
      status: allSatisfied ? 'completed' : 'active',
    };
  }

  /**
   * Recursively resolves a requirement for `item` with `count`.
   * Returns the TaskNode ID that fulfills the requirement, or null if unresolvable.
   */
  private resolveRequirement(
    item: string,
    count: number,
    virtualInv: Record<string, number>,
    tasks: TaskNode[],
    visitedInStack: Set<string>,
    currentInventory: Record<string, number>,
    options: PlanGenerationOptions = {}
  ): string | null {
    const currentCount = virtualInv[item] || 0;
    if (currentCount >= count) {
      // Already satisfied by virtual inventory
      return null;
    }

    if (visitedInStack.has(item)) {
      // Cycle detected
      console.warn(`[DAG_COMPILER] Cycle detected when resolving requirement '${item}'!`);
      return null;
    }

    visitedInStack.add(item);

    const needed = count - currentCount;
    const candidates = this.registry.getOperatorsFor(item);
    if (candidates.length === 0) {
      visitedInStack.delete(item);
      return null;
    }

    // Pick first candidate operator
    const op = candidates[0];
    const yieldAmount = op.producedItems.find((p) => p.item === item)?.count || 1;
    const batches = Math.ceil(needed / yieldAmount);
    const totalYield = batches * yieldAmount;

    const prereqTaskIds: string[] = [];

    // 1. Tool requirements
    if (op.requiredTools) {
      for (const reqTool of op.requiredTools) {
        const hasTool = this.checkHasTool(reqTool.toolType, reqTool.minTier, virtualInv);
        if (!hasTool) {
          const toolItem = this.getToolForTier(reqTool.toolType, reqTool.minTier);
          if (!toolItem) {
            visitedInStack.delete(item);
            return null;
          }
          const toolTaskId = this.resolveRequirement(
            toolItem,
            1,
            virtualInv,
            tasks,
            visitedInStack,
            currentInventory,
            options
          );
          if (!toolTaskId && !this.checkHasTool(reqTool.toolType, reqTool.minTier, virtualInv)) {
            visitedInStack.delete(item);
            return null;
          }
          if (toolTaskId) prereqTaskIds.push(toolTaskId);
        }
      }
    }

    // 2. Workstation requirements
    if (op.workstation) {
      const isKnownInWorld = options.knownWorkstations?.includes(op.workstation);
      const workstationCount = virtualInv[op.workstation] || 0;
      if (!isKnownInWorld && workstationCount < 1) {
        const wsTaskId = this.resolveRequirement(
          op.workstation,
          1,
          virtualInv,
          tasks,
          visitedInStack,
          currentInventory,
          options
        );
        if (!wsTaskId && (virtualInv[op.workstation] || 0) < 1) {
          visitedInStack.delete(item);
          return null;
        }
        if (wsTaskId) prereqTaskIds.push(wsTaskId);
      }
    }

    // 3. Consumed items requirements
    for (const ingredient of op.consumedItems) {
      const totalIngredientNeeded = ingredient.count * batches;
      const availableIngredient = virtualInv[ingredient.item] || 0;

      if (availableIngredient < totalIngredientNeeded) {
        const ingTaskId = this.resolveRequirement(
          ingredient.item,
          totalIngredientNeeded,
          virtualInv,
          tasks,
          visitedInStack,
          currentInventory,
          options
        );
        if (!ingTaskId && (virtualInv[ingredient.item] || 0) < totalIngredientNeeded) {
          visitedInStack.delete(item);
          return null;
        }
        if (ingTaskId) prereqTaskIds.push(ingTaskId);
      }

      // Deduct from virtual inventory
      virtualInv[ingredient.item] = Math.max(0, (virtualInv[ingredient.item] || 0) - totalIngredientNeeded);
    }

    visitedInStack.delete(item);

    // Create the task node for this operator
    this.taskCounter++;
    const taskId = `task_${op.id}_${Date.now()}_${this.taskCounter}`;
    const params = op.buildParams(needed, currentInventory);

    // Initial status
    const status = prereqTaskIds.length === 0 ? 'ready' : 'pending';

    const node: TaskNode = {
      id: taskId,
      type: op.category,
      actionName: op.actionName,
      params,
      prerequisites: prereqTaskIds,
      status,
      retryCount: 0,
      maxRetries: op.maxRetries || 3,
      budgetMs: op.budgetMs || 30000,
      evidence: [],
      postcondition: (bot: any, baseline: TaskBaseline) => {
        const counts = getBotInventoryCounts(bot);
        const actualCount = counts[item] || 0;
        const initialCount = baseline?.inventoryCounts?.[item] || 0;
        return actualCount >= initialCount + needed || actualCount >= count;
      },
    };

    tasks.push(node);

    // Add produced items to virtual inventory
    virtualInv[item] = (virtualInv[item] || 0) + totalYield;

    return taskId;
  }

  private checkHasTool(toolType: string, minTier: number, inv: Record<string, number>): boolean {
    const tierMap = TOOL_TIERS[toolType];
    if (!tierMap) return false;

    for (const [toolName, tier] of Object.entries(tierMap)) {
      if (tier >= minTier && (inv[toolName] || 0) > 0) {
        return true;
      }
    }
    return false;
  }

  private getToolForTier(toolType: string, minTier: number): string | null {
    const tierMap = TOOL_TIERS[toolType];
    if (!tierMap) return null;

    // Pick minimum tool that satisfies minTier
    const candidates = Object.entries(tierMap)
      .filter(([, tier]) => tier >= minTier)
      .sort(([, a], [, b]) => a - b);

    return candidates[0] ? candidates[0][0] : null;
  }

  private normalizeVirtualInventory(inv: Record<string, number>): void {
    // If bot has any log species, sum into oak_log pool if oak_log is 0
    let totalLogs = 0;
    for (const [k, v] of Object.entries(inv)) {
      if ((k.endsWith('_log') || k.endsWith('_wood')) && v > 0) {
        totalLogs += v;
      }
    }
    if (totalLogs > 0 && !inv['oak_log']) {
      inv['oak_log'] = totalLogs;
    }

    // If bot has any plank species, sum into oak_planks pool if oak_planks is 0
    let totalPlanks = 0;
    for (const [k, v] of Object.entries(inv)) {
      if (k.endsWith('_planks') && v > 0) {
        totalPlanks += v;
      }
    }
    if (totalPlanks > 0 && !inv['oak_planks']) {
      inv['oak_planks'] = totalPlanks;
    }

    // Cobblestone / deepslate
    const cobbleTotal = (inv['cobblestone'] || 0) + (inv['cobbled_deepslate'] || 0) + (inv['stone'] || 0);
    if (cobbleTotal > 0 && !inv['cobblestone']) {
      inv['cobblestone'] = cobbleTotal;
    }
  }

  private topologicalSort(tasks: TaskNode[]): TaskNode[] {
    const taskMap = new Map<string, TaskNode>();
    for (const t of tasks) {
      taskMap.set(t.id, t);
    }

    const visited = new Set<string>();
    const result: TaskNode[] = [];

    const visit = (node: TaskNode) => {
      if (visited.has(node.id)) return;
      visited.add(node.id);

      for (const pid of node.prerequisites) {
        const parent = taskMap.get(pid);
        if (parent) {
          visit(parent);
        }
      }

      result.push(node);
    };

    for (const t of tasks) {
      visit(t);
    }

    return result;
  }
}

export const defaultDAGCompiler = new DynamicDAGCompiler();
