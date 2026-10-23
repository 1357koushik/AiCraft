import { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { goals } from 'mineflayer-pathfinder';
import recipeLoader from 'prismarine-recipe';
import { ActionExecutionContext, ActionResult } from '../types/index.js';
import { isActionContextActive } from '../agent/arbiter.js';
import { findSafePlacementSpot, techniqueVacuumDrops, updatePathfinderMovements } from './techniques.js';
import { workstationRegistry, WorkstationOwnershipRegistry } from './workstations.js';

export { workstationRegistry, WorkstationOwnershipRegistry };

export interface IngredientRequirement {
  itemId: number;
  itemName: string;
  count: number;
}

export interface CraftingStep {
  targetItemId: number;
  targetItemName: string;
  recipe: any;
  executionCount: number; // How many times to execute the recipe
  yieldCount: number; // Total units produced = executionCount * recipe.result.count
  requiresTable: boolean;
  consumedIngredients: IngredientRequirement[];
}

export interface CraftingPlan {
  targetItemName: string;
  targetItemId: number;
  requestedCount: number;
  totalYield: number;
  steps: CraftingStep[];
  missingIngredients: IngredientRequirement[];
  feasible: boolean;
  requiresCraftingTable: boolean;
}

export interface CraftingOptions {
  reservedMaterials?: Record<string, number>;
  stationBlock?: any;
  allowWorkstationPlacement?: boolean;
  timeoutMs?: number;
}

/**
 * Returns total count of an item in the bot's inventory by name or numerical ID.
 */
export function getInventoryCount(bot: Bot, itemNameOrId: string | number): number {
  if (!bot || !bot.inventory) return 0;
  const items = typeof bot.inventory.items === 'function' ? bot.inventory.items() : [];
  let count = 0;
  for (const it of items) {
    if (!it) continue;
    if (typeof itemNameOrId === 'number') {
      if (it.type === itemNameOrId) count += it.count || 0;
    } else {
      if (it.name === itemNameOrId) count += it.count || 0;
    }
  }
  return count;
}

/**
 * Returns a simulated virtual inventory map counting all items in inventory.
 */
export function getInventoryMap(bot: Bot): Record<string, number> {
  const map: Record<string, number> = {};
  if (!bot || !bot.inventory) return map;
  const items = typeof bot.inventory.items === 'function' ? bot.inventory.items() : [];
  for (const it of items) {
    if (it && it.name) {
      map[it.name] = (map[it.name] || 0) + (it.count || 0);
    }
  }
  return map;
}

/**
 * Helper to get all recipes for an item across prismarine-recipe and bot registry.
 */
export function getAllRecipesForItem(bot: Bot, itemId: number): any[] {
  if (!bot.registry) return [];
  try {
    const RecipeClass = (recipeLoader as any)(bot.registry).Recipe;
    if (RecipeClass && typeof RecipeClass.find === 'function') {
      return RecipeClass.find(itemId, null);
    }
  } catch {}

  if (typeof (bot as any).recipesAll === 'function') {
    try {
      return (bot as any).recipesAll(itemId, null, true);
    } catch {}
  }

  return [];
}

/**
 * Deterministic Dependency & Recipe Resolver
 * Calculates ingredients, feasible quantities, recipe multiplicity,
 * accounts for reserved materials, and recursively resolves prerequisites.
 */
export class RecipeResolver {
  private bot: Bot;

  constructor(bot: Bot) {
    this.bot = bot;
  }

  /**
   * Resolves a dependency plan for crafting `targetItemName` in quantity `requestedCount`.
   */
  public resolvePlan(
    targetItemName: string,
    requestedCount: number = 1,
    options: CraftingOptions = {}
  ): CraftingPlan {
    const registry = (this.bot as any).registry;
    const targetItemDef = registry?.itemsByName?.[targetItemName];

    if (!targetItemDef) {
      return {
        targetItemName,
        targetItemId: -1,
        requestedCount,
        totalYield: 0,
        steps: [],
        missingIngredients: [{ itemId: -1, itemName: targetItemName, count: requestedCount }],
        feasible: false,
        requiresCraftingTable: false,
      };
    }

    const reserved = options.reservedMaterials || {};
    // Clone inventory to track simulated resource consumption across sequential crafting steps
    const simInventory = { ...getInventoryMap(this.bot) };

    // Subtract reserved materials from available inventory pool
    for (const [resItem, resCount] of Object.entries(reserved)) {
      if (simInventory[resItem]) {
        simInventory[resItem] = Math.max(0, simInventory[resItem] - Number(resCount));
      }
    }

    const steps: CraftingStep[] = [];
    const missing: IngredientRequirement[] = [];
    let requiresCraftingTable = false;

    // Recursively resolve prerequisites
    const resolved = this.resolvePrerequisites(
      targetItemDef,
      requestedCount,
      simInventory,
      steps,
      missing,
      new Set<number>()
    );

    for (const step of steps) {
      if (step.requiresTable) {
        requiresCraftingTable = true;
      }
    }

    // Check if crafting table is needed but not available
    if (requiresCraftingTable) {
      const hasTableInInventory = (simInventory['crafting_table'] || 0) > 0;
      const hasTableNearby = Boolean(
        this.bot.findBlock &&
          this.bot.findBlock({ matching: (b: any) => b.name === 'crafting_table', maxDistance: 4.5 })
      );

      if (!hasTableInInventory && !hasTableNearby) {
        // Must craft a crafting table!
        const tableDef = registry.itemsByName['crafting_table'];
        if (tableDef) {
          const tableSteps: CraftingStep[] = [];
          const tableMissing: IngredientRequirement[] = [];
          const canCraftTable = this.resolvePrerequisites(
            tableDef,
            1,
            simInventory,
            tableSteps,
            tableMissing,
            new Set<number>()
          );

          if (canCraftTable) {
            // Prepend crafting table steps before the steps that require it
            steps.unshift(...tableSteps);
          } else {
            missing.push(...tableMissing);
          }
        }
      }
    }

    const feasible = resolved && missing.length === 0;
    const totalYield = steps
      .filter((s) => s.targetItemId === targetItemDef.id)
      .reduce((sum, s) => sum + s.yieldCount, 0);

    return {
      targetItemName,
      targetItemId: targetItemDef.id,
      requestedCount,
      totalYield: totalYield || requestedCount,
      steps,
      missingIngredients: missing,
      feasible,
      requiresCraftingTable,
    };
  }

  private resolvePrerequisites(
    itemDef: any,
    countNeeded: number,
    simInventory: Record<string, number>,
    accumulatedSteps: CraftingStep[],
    missingOut: IngredientRequirement[],
    cycleGuard: Set<number>
  ): boolean {
    if (countNeeded <= 0) return true;

    // Check if item is already in simulated inventory
    const inInv = simInventory[itemDef.name] || 0;
    if (inInv >= countNeeded) {
      simInventory[itemDef.name] -= countNeeded;
      return true;
    }

    const stillNeeded = countNeeded - inInv;
    simInventory[itemDef.name] = 0; // Use all available in inventory

    if (cycleGuard.has(itemDef.id)) {
      missingOut.push({ itemId: itemDef.id, itemName: itemDef.name, count: stillNeeded });
      return false;
    }
    cycleGuard.add(itemDef.id);

    const candidateRecipes = getAllRecipesForItem(this.bot, itemDef.id);
    if (candidateRecipes.length === 0) {
      // Cannot craft this item: must gather or missing
      missingOut.push({ itemId: itemDef.id, itemName: itemDef.name, count: stillNeeded });
      cycleGuard.delete(itemDef.id);
      return false;
    }

    // Rank candidate recipes based on available simulated inventory
    const rankedRecipes = this.rankRecipesByFeasibility(candidateRecipes, simInventory);
    let chosenPlan: { recipe: any; executionCount: number; yieldCount: number; consumed: IngredientRequirement[] } | null = null;

    for (const recipe of rankedRecipes) {
      const resultMultiplier = recipe.result?.count || 1;
      const executionCount = Math.ceil(stillNeeded / resultMultiplier);
      const yieldCount = executionCount * resultMultiplier;

      // Extract required ingredients from recipe delta
      const consumed: IngredientRequirement[] = [];
      let canResolveIngredients = true;
      const tempSim = { ...simInventory };

      for (const d of recipe.delta || []) {
        if (d.count < 0) {
          const ingId = d.id;
          const ingCount = Math.abs(d.count) * executionCount;
          const ingDef = (this.bot as any).registry?.items?.[ingId];
          const ingName = ingDef?.name || `item_${ingId}`;

          consumed.push({ itemId: ingId, itemName: ingName, count: ingCount });

          // Recursively resolve ingredient
          const subSteps: CraftingStep[] = [];
          const subMissing: IngredientRequirement[] = [];
          const ok = this.resolvePrerequisites(
            ingDef || { id: ingId, name: ingName },
            ingCount,
            tempSim,
            subSteps,
            subMissing,
            new Set(cycleGuard)
          );

          if (!ok) {
            canResolveIngredients = false;
            break;
          }
        }
      }

      if (canResolveIngredients) {
        // Recipe viable! Re-run and commit to main steps
        for (const d of recipe.delta || []) {
          if (d.count < 0) {
            const ingId = d.id;
            const ingCount = Math.abs(d.count) * executionCount;
            const ingDef = (this.bot as any).registry?.items?.[ingId];
            const ingName = ingDef?.name || `item_${ingId}`;

            this.resolvePrerequisites(
              ingDef || { id: ingId, name: ingName },
              ingCount,
              simInventory,
              accumulatedSteps,
              missingOut,
              new Set(cycleGuard)
            );
          }
        }

        chosenPlan = { recipe, executionCount, yieldCount, consumed };
        break;
      }
    }

    cycleGuard.delete(itemDef.id);

    if (chosenPlan) {
      accumulatedSteps.push({
        targetItemId: itemDef.id,
        targetItemName: itemDef.name,
        recipe: chosenPlan.recipe,
        executionCount: chosenPlan.executionCount,
        yieldCount: chosenPlan.yieldCount,
        requiresTable: Boolean(chosenPlan.recipe.requiresTable),
        consumedIngredients: chosenPlan.consumed,
      });

      // Credit excess yield to simulated inventory for downstream steps
      const excessYield = chosenPlan.yieldCount - stillNeeded;
      if (excessYield > 0) {
        simInventory[itemDef.name] = (simInventory[itemDef.name] || 0) + excessYield;
      }
      return true;
    }

    missingOut.push({ itemId: itemDef.id, itemName: itemDef.name, count: stillNeeded });
    return false;
  }

  private rankRecipesByFeasibility(recipes: any[], simInventory: Record<string, number>): any[] {
    return [...recipes].sort((a, b) => {
      const costA = this.calculateRecipeInventoryCost(a, simInventory);
      const costB = this.calculateRecipeInventoryCost(b, simInventory);
      return costA - costB;
    });
  }

  private calculateRecipeInventoryCost(recipe: any, simInventory: Record<string, number>): number {
    let penalty = 0;
    if (recipe.requiresTable) penalty += 2;

    for (const d of recipe.delta || []) {
      if (d.count < 0) {
        const ingDef = (this.bot as any).registry?.items?.[d.id];
        const ingName = ingDef?.name;
        const available = ingName ? simInventory[ingName] || 0 : 0;
        if (available < Math.abs(d.count)) {
          penalty += 10; // Penalty for missing ingredient needing recursive craft
        }
      }
    }
    return penalty;
  }
}

/**
 * Closed-Loop Crafting Executor
 * Executes crafting plans with exclusive window management, pre/post inventory
 * verification, workstation ownership tracking, and cancellation safety.
 */
export class ClosedLoopCraftingExecutor {
  private bot: Bot;

  constructor(bot: Bot) {
    this.bot = bot;
  }

  /**
   * Executes a craft operation end-to-end with closed-loop verification.
   */
  public async craftItem(
    targetItemName: string,
    requestedCount: number = 1,
    ctx: ActionExecutionContext,
    options: CraftingOptions = {}
  ): Promise<ActionResult> {
    if (!isActionContextActive(ctx)) {
      return { status: 'interrupted', reason: 'Crafting cancelled before start.' };
    }

    const resolver = new RecipeResolver(this.bot);
    const plan = resolver.resolvePlan(targetItemName, requestedCount, options);

    if (!plan.feasible) {
      const missingText = plan.missingIngredients
        .map((m: IngredientRequirement) => `${m.count}x ${m.itemName}`)
        .join(', ');

      // Calculate any partial batches feasible from currently available materials
      let partialFeasibleCount = 0;
      for (let count = requestedCount - 1; count >= 1; count--) {
        const subPlan = resolver.resolvePlan(targetItemName, count, options);
        if (subPlan.feasible) {
          partialFeasibleCount = count;
          break;
        }
      }

      return {
        status: 'failed',
        reason: `Cannot craft ${requestedCount}x ${targetItemName}: missing required ingredients (${missingText || 'unresolved'}).`,
        details: {
          plan,
          failureKind: 'INSUFFICIENT_MATERIALS',
          requestedCount,
          partialFeasibleCount,
          remainingNeeded: requestedCount - partialFeasibleCount,
          missingIngredients: plan.missingIngredients,
        },
      };
    }

    const baselineTargetCount = getInventoryCount(this.bot, targetItemName);
    console.log(`[CRAFT_LOOP] Target: ${requestedCount}x ${targetItemName} (Current in inventory: ${baselineTargetCount}). Plan has ${plan.steps.length} step(s).`);

    let onAbort: (() => void) | null = null;
    let placedWorkstationPos: Vec3 | null = null;
    let activeWorkstationBlock: any = null;

    try {
      if (ctx.abortSignal) {
        onAbort = () => {
          try {
            if (this.bot.currentWindow) {
              this.bot.closeWindow(this.bot.currentWindow);
            }
          } catch {}
          this.bot.clearControlStates?.();
        };
        ctx.abortSignal.addEventListener('abort', onAbort, { once: true });
      }

      // Step-by-step execution with pre/post verification
      for (let sIdx = 0; sIdx < plan.steps.length; sIdx++) {
        if (!isActionContextActive(ctx)) {
          return { status: 'interrupted', reason: 'Crafting cancelled during step execution.' };
        }

        const step = plan.steps[sIdx];
        const stepTargetName = step.targetItemName;
        const stepBaseline = getInventoryCount(this.bot, stepTargetName);

        console.log(`[CRAFT_LOOP] [Step ${sIdx + 1}/${plan.steps.length}] Crafting ${step.yieldCount}x ${stepTargetName} (${step.executionCount} executions, requiresTable: ${step.requiresTable})...`);

        let craftingTableToUse: any = null;

        if (step.requiresTable) {
          // Look for accessible crafting table
          let existingTable = this.bot.findBlock
            ? this.bot.findBlock({ matching: (b: any) => b.name === 'crafting_table', maxDistance: 4.5 })
            : null;

          if (!existingTable && this.bot.findBlock) {
            // Check within reachable pathfinding distance
            const distantTable = this.bot.findBlock({ matching: (b: any) => b.name === 'crafting_table', maxDistance: 16 });
            if (distantTable && (this.bot as any).pathfinder) {
              try {
                updatePathfinderMovements(this.bot);
                const goal = new goals.GoalGetToBlock(distantTable.position.x, distantTable.position.y, distantTable.position.z);
                await (this.bot as any).pathfinder.goto(goal);
                existingTable = distantTable;
              } catch {}
            }
          }

          if (!existingTable) {
            // Must place crafting table from inventory
            const tableItem = this.bot.inventory?.items().find((i) => i.name === 'crafting_table');
            if (!tableItem) {
              return {
                status: 'failed',
                reason: `Crafting ${stepTargetName} requires a crafting table, but none was found and none is in inventory.`,
                details: { failureKind: 'MISSING_WORKSTATION' },
              };
            }

            const spot = findSafePlacementSpot(this.bot);
            if (!spot) {
              return {
                status: 'failed',
                reason: `No safe position adjacent to bot to place crafting table.`,
                details: { failureKind: 'NO_SAFE_WORKSTATION_SITE' },
              };
            }

            if (!isActionContextActive(ctx)) {
              return { status: 'interrupted', reason: 'Crafting cancelled before placing workstation.' };
            }

            if (this.bot.equip) {
              await this.bot.equip(tableItem, 'hand');
            }
            if (this.bot.placeBlock) {
              console.log(`[CRAFT_LOOP] Placing owned crafting table at (${spot.placePos.x}, ${spot.placePos.y}, ${spot.placePos.z})...`);
              await this.bot.placeBlock(spot.refBlock, spot.placeVector);
            }

            placedWorkstationPos = spot.placePos.clone();
            workstationRegistry.recordPlacement(placedWorkstationPos, 'crafting_table');
            existingTable = this.bot.blockAt ? this.bot.blockAt(spot.placePos) : ({ name: 'crafting_table', position: spot.placePos } as any);
            activeWorkstationBlock = existingTable;
            console.log(`[CRAFT_LOOP] Placed bot-owned crafting table at (${spot.placePos.x}, ${spot.placePos.y}, ${spot.placePos.z}).`);
          } else {
            activeWorkstationBlock = existingTable;
          }

          craftingTableToUse = activeWorkstationBlock;
        }

        if (!isActionContextActive(ctx)) {
          return { status: 'interrupted', reason: 'Crafting cancelled before bot.craft invocation.' };
        }

        // Execute craft
        try {
          if (typeof this.bot.craft === 'function') {
            await this.bot.craft(step.recipe, step.executionCount, craftingTableToUse || undefined);
          }
        } catch (craftErr: any) {
          if (!isActionContextActive(ctx)) {
            return { status: 'interrupted', reason: 'Crafting cancelled during recipe execution.' };
          }
          return {
            status: 'failed',
            reason: `bot.craft failed for ${stepTargetName}: ${craftErr.message}`,
            details: { failureKind: 'CRAFT_EXECUTION_ERROR', error: craftErr.message },
          };
        }

        // Closed-Loop Verification: check actual inventory increase
        const stepAfter = getInventoryCount(this.bot, stepTargetName);
        const stepDelta = stepAfter - stepBaseline;

        console.log(`[CRAFT_LOOP] Verified step result for ${stepTargetName}: before=${stepBaseline}, after=${stepAfter}, delta=${stepDelta} (expected >= ${step.yieldCount})`);

        if (stepDelta < step.yieldCount) {
          // Check for inventory / window desync
          if (this.bot.currentWindow && (this.bot as any)._syncWindow) {
            try {
              await (this.bot as any)._syncWindow(this.bot.currentWindow);
            } catch {}
          }

          const resyncedCount = getInventoryCount(this.bot, stepTargetName);
          const resyncedDelta = resyncedCount - stepBaseline;

          if (resyncedDelta < step.yieldCount) {
            // False-success detected: bot.craft returned but items were not actually produced!
            return {
              status: 'failed',
              reason: `Crafting postcondition failed: Expected ${step.yieldCount} ${stepTargetName}, but inventory only increased by ${resyncedDelta} (possible window desync).`,
              details: {
                failureKind: 'POSTCONDITION_FAILED',
                expectedYield: step.yieldCount,
                actualDelta: resyncedDelta,
              },
            };
          }
        }
      }

      // Final Goal Postcondition Verification
      const finalCount = getInventoryCount(this.bot, targetItemName);
      const netIncrease = finalCount - baselineTargetCount;

      if (netIncrease < requestedCount) {
        return {
          status: 'failed',
          reason: `Crafting postcondition failed: Expected at least ${requestedCount} ${targetItemName}, but net increase was ${netIncrease}.`,
          details: {
            failureKind: 'POSTCONDITION_FAILED',
            requestedCount,
            netIncrease,
            remainingNeeded: requestedCount - netIncrease,
          },
        };
      }

      return {
        status: 'success',
        reason: `Successfully crafted ${netIncrease}x ${targetItemName} (requested ${requestedCount}).`,
        details: {
          targetItemName,
          requestedCount,
          netIncrease,
          finalCount,
          batchesExecuted: plan.steps.reduce((sum, s) => sum + s.executionCount, 0),
          remainingNeeded: Math.max(0, requestedCount - netIncrease),
        },
      };
    } finally {
      if (ctx.abortSignal && onAbort) {
        ctx.abortSignal.removeEventListener('abort', onAbort);
      }

      // Ensure open GUI/window is closed
      if (this.bot.currentWindow) {
        try {
          this.bot.closeWindow(this.bot.currentWindow);
        } catch {}
      }

      // Workstation Lifecycle Teardown:
      // STRICT RULE: Only dismantle a workstation that the bot can prove it owns!
      if (placedWorkstationPos && workstationRegistry.isOwnedByBot(placedWorkstationPos)) {
        const isCancelled = !isActionContextActive(ctx);
        if (!isCancelled) {
          console.log(`[CRAFT_LOOP] Teardown: recovering owned crafting table at (${placedWorkstationPos.x}, ${placedWorkstationPos.y}, ${placedWorkstationPos.z})...`);
          try {
            const tableBlock = this.bot.blockAt
              ? this.bot.blockAt(placedWorkstationPos)
              : { name: 'crafting_table', position: placedWorkstationPos };

            if (tableBlock && tableBlock.name === 'crafting_table') {
              // Auto-equip axe if available to speed recovery
              const bestAxe = this.bot.inventory?.items().find((i) => i.name && i.name.endsWith('_axe') && !i.name.includes('pickaxe'));
              if (bestAxe && this.bot.equip) {
                try { await this.bot.equip(bestAxe, 'hand'); } catch {}
              }

              if (this.bot.dig) {
                await this.bot.dig(tableBlock as any);
              }
              workstationRegistry.forgetPlacement(placedWorkstationPos);

              // Vacuum the dropped crafting table item
              await techniqueVacuumDrops(this.bot, 3.5, ctx.abortSignal, ctx.isCurrent);
              console.log(`[CRAFT_LOOP] Successfully recovered owned crafting table into inventory.`);
            }
          } catch (teardownErr: any) {
            console.log(`[CRAFT_LOOP] Note: Workstation teardown encountered: ${teardownErr.message}`);
          }
        }
      }
    }
  }
}
