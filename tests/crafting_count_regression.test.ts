import { describe, it, expect, vi } from 'vitest';
import { ClosedLoopCraftingExecutor, RecipeResolver } from '../src/actions/crafting.js';
import { inventoryCraftingActions } from '../src/actions/inventory_crafting.js';
import { techniqueCraftPipeline } from '../src/actions/techniques.js';
import { ActionExecutionContext } from '../src/types/index.js';

describe('Regression: Crafting-Count Correctness & Net Delta Verification', () => {
  const createMockBot = (initialInventory: Array<{ type: number; name: string; count: number }>) => {
    let inventoryItems = initialInventory.map((i) => ({ ...i }));

    const oakLogRecipe = {
      result: { id: 20, name: 'oak_planks', count: 4 },
      delta: [
        { id: 10, count: -1 },
        { id: 20, count: 4 },
      ],
      requiresTable: false,
    };

    const stickRecipe = {
      result: { id: 30, name: 'stick', count: 4 },
      delta: [
        { id: 20, count: -2 },
        { id: 30, count: 4 },
      ],
      requiresTable: false,
    };

    const registry: any = {
      itemsByName: {
        oak_log: { id: 10, name: 'oak_log' },
        oak_planks: { id: 20, name: 'oak_planks' },
        stick: { id: 30, name: 'stick' },
      },
      items: {
        10: { id: 10, name: 'oak_log' },
        20: { id: 20, name: 'oak_planks' },
        30: { id: 30, name: 'stick' },
      },
    };

    const bot: any = {
      registry,
      inventory: {
        items: () => inventoryItems.filter((it) => it.count > 0),
      },
      recipesAll: (itemId: number) => {
        if (itemId === 20) return [oakLogRecipe];
        if (itemId === 30) return [stickRecipe];
        return [];
      },
      recipesFor: (itemId: number) => {
        if (itemId === 20) return [oakLogRecipe];
        if (itemId === 30) return [stickRecipe];
        return [];
      },
      craft: vi.fn(async (recipe: any, count: number) => {
        // Apply recipe delta multiplied by count
        for (const d of recipe.delta) {
          const existing = inventoryItems.find((it) => it.type === d.id);
          const deltaChange = d.count * count;
          if (existing) {
            existing.count += deltaChange;
          } else if (deltaChange > 0) {
            const def = registry.items[d.id];
            inventoryItems.push({ type: d.id, name: def.name, count: deltaChange });
          }
        }
      }),
      findBlock: vi.fn(() => null),
      blockAt: vi.fn(() => null),
      clearControlStates: vi.fn(),
    };

    return {
      bot,
      getInventory: () => inventoryItems,
      setInventory: (items: any[]) => {
        inventoryItems = items;
      },
    };
  };

  const createMockCtx = (bot: any): ActionExecutionContext => ({
    bot,
    observation: null as any,
  });

  it('resolves 12 oak_planks to exactly 3 recipe executions yielding 12 planks and consuming 3 logs', () => {
    const { bot } = createMockBot([{ type: 10, name: 'oak_log', count: 3 }]);
    const resolver = new RecipeResolver(bot);

    const plan = resolver.resolvePlan('oak_planks', 12);

    expect(plan.feasible).toBe(true);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].executionCount).toBe(3);
    expect(plan.steps[0].yieldCount).toBe(12);
    expect(plan.missingIngredients).toHaveLength(0);
  });

  it('fails with INSUFFICIENT_MATERIALS when requesting 12 planks with only 1 log', () => {
    const { bot } = createMockBot([{ type: 10, name: 'oak_log', count: 1 }]);
    const resolver = new RecipeResolver(bot);

    const plan = resolver.resolvePlan('oak_planks', 12);

    expect(plan.feasible).toBe(false);
    expect(plan.missingIngredients).toHaveLength(1);
    expect(plan.missingIngredients[0].itemName).toBe('oak_planks');
    expect(plan.missingIngredients[0].count).toBe(12);
  });

  it('crafts 12 planks end-to-end and verifies net inventory delta (+12)', async () => {
    const { bot, getInventory } = createMockBot([{ type: 10, name: 'oak_log', count: 5 }]);
    const ctx = createMockCtx(bot);
    const executor = new ClosedLoopCraftingExecutor(bot);

    const result = await executor.craftItem('oak_planks', 12, ctx);

    expect(result.status).toBe('success');
    expect(result.details.netIncrease).toBe(12);
    expect(bot.craft).toHaveBeenCalledWith(expect.anything(), 3, undefined);

    const planks = getInventory().find((it) => it.name === 'oak_planks');
    expect(planks?.count).toBe(12);
    const logs = getInventory().find((it) => it.name === 'oak_log');
    expect(logs?.count).toBe(2); // 5 - 3 = 2
  });

  it('craft_pipeline action normalizes count=12 and produces 12 planks', async () => {
    const { bot, getInventory } = createMockBot([{ type: 10, name: 'oak_log', count: 4 }]);
    const ctx = createMockCtx(bot);
    const pipelineAction = inventoryCraftingActions.find((a) => a.name === 'craft_pipeline')!;

    const result = await pipelineAction.execute(bot, { targetItem: 'oak_planks', count: 12 }, ctx);

    expect(result.status).toBe('success');
    expect(bot.craft).toHaveBeenCalledWith(expect.anything(), 3, undefined);
    const planks = getInventory().find((it) => it.name === 'oak_planks');
    expect(planks?.count).toBe(12);
  });

  it('techniqueCraftPipeline accepts count parameter and verifies postcondition yield >= 12', async () => {
    const { bot, getInventory } = createMockBot([{ type: 10, name: 'oak_log', count: 4 }]);

    const result = await techniqueCraftPipeline(bot, 'oak_planks', 12);

    expect(result.status).toBe('success');
    expect(bot.craft).toHaveBeenCalledWith(expect.anything(), 3, undefined);
    const planks = getInventory().find((it) => it.name === 'oak_planks');
    expect(planks?.count).toBe(12);
  });
});
