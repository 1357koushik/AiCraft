import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import recipeLoader from 'prismarine-recipe';
import {
  RecipeResolver,
  ClosedLoopCraftingExecutor,
  workstationRegistry,
  getInventoryCount,
} from '../src/actions/crafting.js';
import { ActionExecutionContext, Observation } from '../src/types/index.js';
import { techniqueSmeltItem, techniqueSmeltPipeline } from '../src/actions/techniques.js';

describe('Production Skills: Recipe Resolver & Closed-Loop Crafting', () => {
  const mcData = (minecraftData as any)('1.21.6');
  const Recipe = (recipeLoader as any)(mcData).Recipe;

  const createMockObservation = (): Observation => ({
    version: '1.21.6',
    timestamp: Date.now(),
    vitals: {
      health: 20,
      food: 20,
      oxygen: 20,
      isAlive: true,
      armor: 0,
      underwater: false,
      isBurning: false,
      movementState: { onGround: true, inWater: false, isSleeping: false, isRiding: false },
    } as any,
    position: { x: 10, y: 64, z: 10, blockCoords: { x: 10, y: 64, z: 10 }, velocity: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, facing: 'north', dimension: 'overworld' } as any,
    environment: { dayPhase: 'day', weather: 'clear' } as any,
    statusEffects: [],
    inventory: {
      mainHand: null,
      offHand: null,
      heldItemHint: 'empty',
      aggregates: { totalItemCounts: {} },
      toolSummary: {},
      craftableNow: [],
      foodList: [],
      placeableBlocks: {},
    } as any,
    crosshair: {},
    blocks: { notableBlocks: [], hazards: [], walkability: { forward: true, back: true, left: true, right: true }, localMap: { ascii: '', legend: {} } } as any,
    entities: [],
    recentEvents: {} as any,
    container: { isOpen: false, type: null, slotsCount: 0, items: [] },
    agentState: { currentGoal: 'Craft', planSteps: [], stepNumber: 1, stuckCounter: 0, timeSinceLastProgressSeconds: 0 },
    memory: { namedLocations: {}, facts: [], dangerZones: [], completedGoals: [] },
    derived: { availableActions: [] },
  });

  const createMockBot = (inventoryItems: { name: string; count: number }[] = []) => {
    // Populate with real items
    const items = inventoryItems.map((inv) => {
      const def = mcData.itemsByName[inv.name];
      return {
        type: def ? def.id : 999,
        name: inv.name,
        count: inv.count,
      };
    });

    const placedBlocks: Record<string, any> = {};

    const mockBot: any = {
      registry: mcData,
      entity: { position: new Vec3(10, 64, 10), yaw: 0 },
      inventory: {
        items: vi.fn(() => items),
      },
      heldItem: null,
      recipesAll: vi.fn((id: number) => Recipe.find(id, null)),
      findBlock: vi.fn().mockReturnValue(null),
      blockAt: vi.fn().mockImplementation((pos: Vec3) => {
        const key = `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
        if (placedBlocks[key]) return placedBlocks[key];
        if (pos.y >= 64) return { name: 'air', position: pos, boundingBox: 'empty' };
        return { name: 'stone', position: pos, boundingBox: 'block' };
      }),
      equip: vi.fn().mockImplementation(async (item: any) => {
        mockBot.heldItem = item;
      }),
      placeBlock: vi.fn().mockImplementation(async (ref: any, vec: Vec3) => {
        const pPos = ref.position.plus(vec);
        const key = `${Math.floor(pPos.x)},${Math.floor(pPos.y)},${Math.floor(pPos.z)}`;
        placedBlocks[key] = { name: mockBot.heldItem?.name || 'furnace', position: pPos, boundingBox: 'block' };
      }),
      dig: vi.fn().mockImplementation(async (target: any) => {
        if (target?.position) {
          const key = `${Math.floor(target.position.x)},${Math.floor(target.position.y)},${Math.floor(target.position.z)}`;
          delete placedBlocks[key];
        }
      }),
      clearControlStates: vi.fn(),
      craft: vi.fn().mockImplementation(async (recipe: any, count: number) => {
        // Default simulated craft: deduct inputs from items and add output
        const resDef = mcData.items[recipe.result.id];
        const outName = resDef ? resDef.name : `item_${recipe.result.id}`;
        const totalOut = (recipe.result.count || 1) * count;

        for (const d of recipe.delta || []) {
          if (d.count < 0) {
            const ingDef = mcData.items[d.id];
            const ingName = ingDef ? ingDef.name : `item_${d.id}`;
            const needed = Math.abs(d.count) * count;
            const invIt = items.find((i) => i.name === ingName);
            if (invIt) invIt.count = Math.max(0, invIt.count - needed);
          }
        }

        const outIt = items.find((i) => i.name === outName);
        if (outIt) {
          outIt.count += totalOut;
        } else {
          items.push({ type: recipe.result.id, name: outName, count: totalOut });
        }
      }),
      currentWindow: null,
      closeWindow: vi.fn().mockImplementation((win: any) => {
        mockBot.currentWindow = null;
      }),
      openFurnace: vi.fn().mockImplementation(async (furnaceBlock: any) => {
        let inputItem: any = null;
        let fuelItem: any = null;
        let outputItem: any = null;

        const furnaceWindow = {
          id: 2,
          type: 'minecraft:furnace',
          putFuel: vi.fn().mockImplementation(async (type, meta, count) => {
            const fDef = mcData.items[type];
            fuelItem = { type, name: fDef?.name || 'coal', count };
          }),
          putInput: vi.fn().mockImplementation(async (type, meta, count) => {
            const inDef = mcData.items[type];
            inputItem = { type, name: inDef?.name || 'raw_iron', count };
            outputItem = { type: 265, name: 'iron_ingot', count };
          }),
          takeOutput: vi.fn().mockImplementation(async () => {
            const out = outputItem;
            outputItem = null;
            if (out) {
              const existing = items.find((i) => i.name === out.name);
              if (existing) existing.count += out.count;
              else items.push({ type: out.type, name: out.name, count: out.count });
            }
            return out;
          }),
          inputItem: () => inputItem,
          fuelItem: () => fuelItem,
          outputItem: () => outputItem,
          close: vi.fn(),
        };
        return furnaceWindow;
      }),
    };

    return { mockBot, items };
  };

  beforeEach(() => {
    workstationRegistry.clear();
  });

  // -------------------------------------------------------------------------
  // 1. Correct Requested-Quantity Semantics & Multiplicity
  // -------------------------------------------------------------------------
  describe('Requested-Quantity Semantics & Recipe Multiplicity', () => {
    it('computes exact recipe execution count for 8 oak planks (yield 4 each -> 2 executions, 2 logs)', () => {
      const { mockBot } = createMockBot([{ name: 'oak_log', count: 5 }]);
      const resolver = new RecipeResolver(mockBot);

      const plan = resolver.resolvePlan('oak_planks', 8);

      expect(plan.feasible).toBe(true);
      expect(plan.requestedCount).toBe(8);
      // 1 log -> 4 planks. To get 8 planks, we need exactly 2 recipe executions!
      const plankStep = plan.steps.find((s) => s.targetItemName === 'oak_planks')!;
      expect(plankStep).toBeDefined();
      expect(plankStep.executionCount).toBe(2);
      expect(plankStep.yieldCount).toBe(8);
      expect(plankStep.requiresTable).toBe(false);
      // Consumed ingredients must be 2 oak_logs
      expect(plankStep.consumedIngredients[0].count).toBe(2);
    });

    it('computes 1 recipe execution when requesting 4 sticks from 2 planks', () => {
      const { mockBot } = createMockBot([{ name: 'oak_planks', count: 4 }]);
      const resolver = new RecipeResolver(mockBot);

      const plan = resolver.resolvePlan('stick', 4);

      expect(plan.feasible).toBe(true);
      expect(plan.requestedCount).toBe(4);
      // 2 planks -> 4 sticks in 1 execution
      const stickStep = plan.steps.find((s) => s.targetItemName === 'stick')!;
      expect(stickStep).toBeDefined();
      expect(stickStep.executionCount).toBe(1);
      expect(stickStep.yieldCount).toBe(4);
      expect(stickStep.requiresTable).toBe(false);
    });

    it('closed-loop crafting executes exact requested count and verifies inventory increase', async () => {
      const { mockBot } = createMockBot([{ name: 'oak_log', count: 5 }]);
      const executor = new ClosedLoopCraftingExecutor(mockBot);

      const ctx: ActionExecutionContext = {
        bot: mockBot,
        observation: createMockObservation(),
        config: {},
        isCurrent: () => true,
      };

      const result = await executor.craftItem('oak_planks', 8, ctx);

      expect(result.status).toBe('success');
      expect(result.reason).toContain('Successfully crafted 8x oak_planks');
      // Verify mockBot.craft was invoked with execution count 2, NOT 8!
      expect(mockBot.craft).toHaveBeenCalledWith(expect.anything(), 2, undefined);
      // Verify inventory count is now 8
      expect(getInventoryCount(mockBot, 'oak_planks')).toBe(8);
      // Verify 2 logs were consumed (5 - 2 = 3 logs remaining)
      expect(getInventoryCount(mockBot, 'oak_log')).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Insufficient Materials & Feasibility Rejection
  // -------------------------------------------------------------------------
  describe('Insufficient Materials & Feasibility', () => {
    it('returns feasible: false and lists exact missing items when materials are insufficient', () => {
      const { mockBot } = createMockBot([]); // Empty inventory
      const resolver = new RecipeResolver(mockBot);

      const plan = resolver.resolvePlan('wooden_pickaxe', 1);

      expect(plan.feasible).toBe(false);
      expect(plan.missingIngredients.length).toBeGreaterThan(0);
      expect(plan.steps.length).toBe(0);
    });

    it('craftItem aborts early without world mutation when materials are insufficient', async () => {
      const { mockBot } = createMockBot([{ name: 'oak_planks', count: 1 }]); // Need 3 planks + 2 sticks
      const executor = new ClosedLoopCraftingExecutor(mockBot);

      const ctx: ActionExecutionContext = {
        bot: mockBot,
        observation: createMockObservation(),
        config: {},
        isCurrent: () => true,
      };

      const result = await executor.craftItem('wooden_pickaxe', 1, ctx);

      expect(result.status).toBe('failed');
      expect(result.reason).toContain('missing required ingredients');
      expect(result.details?.failureKind).toBe('INSUFFICIENT_MATERIALS');
      expect(mockBot.craft).not.toHaveBeenCalled();
      expect(mockBot.placeBlock).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 3. Recipe Alternatives & Version Differences (Wood Species)
  // -------------------------------------------------------------------------
  describe('Recipe Alternatives & Wood Species Resolution', () => {
    it('adapts to birch_log in inventory, resolving birch_planks instead of hardcoded oak', async () => {
      // Bot has birch logs instead of oak logs
      const { mockBot } = createMockBot([{ name: 'birch_log', count: 4 }]);
      const resolver = new RecipeResolver(mockBot);

      const plan = resolver.resolvePlan('wooden_pickaxe', 1);

      expect(plan.feasible).toBe(true);
      expect(plan.requiresCraftingTable).toBe(true);
      // Must craft birch_planks, crafting_table, sticks, and wooden_pickaxe
      const stepNames = plan.steps.map((s) => s.targetItemName);
      expect(stepNames).toContain('birch_planks');
      expect(stepNames).toContain('crafting_table');
      expect(stepNames).toContain('stick');
      expect(stepNames).toContain('wooden_pickaxe');
    });

    it('adapts to dark_oak_planks for tools when dark oak wood is available', () => {
      const { mockBot } = createMockBot([
        { name: 'dark_oak_planks', count: 10 },
        { name: 'crafting_table', count: 1 },
      ]);
      const resolver = new RecipeResolver(mockBot);

      const plan = resolver.resolvePlan('wooden_pickaxe', 1);

      expect(plan.feasible).toBe(true);
      // Sticks step consumes dark_oak_planks
      const stickStep = plan.steps.find((s) => s.targetItemName === 'stick')!;
      expect(stickStep).toBeDefined();
      expect(stickStep.consumedIngredients.some((i) => i.itemName === 'dark_oak_planks')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Material Reservations
  // -------------------------------------------------------------------------
  describe('Materials Reserved for Parent Goal', () => {
    it('respects reserved materials and refuses to steal them for sub-crafts', () => {
      // Bot has 4 oak planks. But 3 are reserved for building a shelter or a pickaxe head!
      const { mockBot } = createMockBot([{ name: 'oak_planks', count: 4 }]);
      const resolver = new RecipeResolver(mockBot);

      // Request to craft sticks (requires 2 planks).
      // With 3 reserved, only 4 - 3 = 1 plank is available!
      const plan = resolver.resolvePlan('stick', 4, {
        reservedMaterials: { oak_planks: 3 },
      });

      // Feasible should be false because unreserved planks (1) < needed planks (2) and no logs exist
      expect(plan.feasible).toBe(false);
      expect(plan.missingIngredients.some((m) => m.itemName === 'stick')).toBe(true);
    });

    it('crafts additional planks from logs when existing planks are reserved', () => {
      // Bot has 4 oak planks (3 reserved) AND 2 oak logs
      const { mockBot } = createMockBot([
        { name: 'oak_planks', count: 4 },
        { name: 'oak_log', count: 2 },
      ]);
      const resolver = new RecipeResolver(mockBot);

      const plan = resolver.resolvePlan('stick', 4, {
        reservedMaterials: { oak_planks: 3 },
      });

      // Now feasible = true because it crafts new planks from the unreserved logs!
      expect(plan.feasible).toBe(true);
      const stepNames = plan.steps.map((s) => s.targetItemName);
      expect(stepNames).toContain('oak_planks');
      expect(stepNames).toContain('stick');
    });
  });

  // -------------------------------------------------------------------------
  // 5. Inventory / Window Desync & False-Success Postcondition Detection
  // -------------------------------------------------------------------------
  describe('Closed-Loop Verification & False-Success Postconditions', () => {
    it('detects false-success when bot.craft resolves but actual inventory delta is 0', async () => {
      const { mockBot } = createMockBot([{ name: 'oak_log', count: 5 }]);
      // Mock bot.craft to return successfully without actually modifying items (simulating server desync)
      mockBot.craft = vi.fn().mockResolvedValue(undefined);

      const executor = new ClosedLoopCraftingExecutor(mockBot);
      const ctx: ActionExecutionContext = {
        bot: mockBot,
        observation: createMockObservation(),
        config: {},
        isCurrent: () => true,
      };

      const result = await executor.craftItem('oak_planks', 4, ctx);

      expect(result.status).toBe('failed');
      expect(result.details?.failureKind).toBe('POSTCONDITION_FAILED');
      expect(result.reason).toContain('Crafting postcondition failed');
      expect(result.reason).toContain('possible window desync');
    });
  });

  // -------------------------------------------------------------------------
  // 6. Workstation Ownership & Safe Lifecycle Teardown
  // -------------------------------------------------------------------------
  describe('Workstation Ownership Protection', () => {
    it('preserves pre-existing village/base workstations and NEVER dismantles them', async () => {
      const preExistingTable = { name: 'crafting_table', position: new Vec3(5, 64, 5) };
      const { mockBot } = createMockBot([
        { name: 'oak_planks', count: 3 },
        { name: 'stick', count: 2 },
      ]);
      // World already has a crafting table nearby
      mockBot.findBlock = vi.fn().mockReturnValue(preExistingTable);

      const executor = new ClosedLoopCraftingExecutor(mockBot);
      const ctx: ActionExecutionContext = {
        bot: mockBot,
        observation: createMockObservation(),
        config: {},
        isCurrent: () => true,
      };

      const result = await executor.craftItem('wooden_pickaxe', 1, ctx);

      expect(result.status).toBe('success');
      // Crucial: Bot must NOT place a new table, and must NOT dismantle the pre-existing table!
      expect(mockBot.placeBlock).not.toHaveBeenCalled();
      expect(mockBot.dig).not.toHaveBeenCalled();
      expect(workstationRegistry.isOwnedByBot(preExistingTable.position)).toBe(false);
    });

    it('proves ownership of self-placed workstations, dismantling and recovering only owned stations', async () => {
      const { mockBot } = createMockBot([
        { name: 'crafting_table', count: 1 },
        { name: 'oak_planks', count: 3 },
        { name: 'stick', count: 2 },
      ]);
      // No table in world initially; track placed state for blockAt
      let tablePlaced = false;
      mockBot.placeBlock = vi.fn().mockImplementation(async () => {
        tablePlaced = true;
      });
      mockBot.dig = vi.fn().mockImplementation(async () => {
        tablePlaced = false;
      });
      mockBot.blockAt = vi.fn().mockImplementation((pos: Vec3) => {
        if (tablePlaced && pos.x === 11 && pos.y === 64 && pos.z === 10) {
          return { name: 'crafting_table', position: pos, boundingBox: 'block' };
        }
        if (pos.y >= 64) return { name: 'air', position: pos, boundingBox: 'empty' };
        return { name: 'stone', position: pos, boundingBox: 'block' };
      });

      const executor = new ClosedLoopCraftingExecutor(mockBot);
      const ctx: ActionExecutionContext = {
        bot: mockBot,
        observation: createMockObservation(),
        config: {},
        isCurrent: () => true,
      };

      const result = await executor.craftItem('wooden_pickaxe', 1, ctx);

      expect(result.status).toBe('success');
      // Table was placed
      expect(mockBot.placeBlock).toHaveBeenCalled();
      // Table was dismantled and recovered because the bot owned it!
      expect(mockBot.dig).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 7. GUI/Window Ownership & Preemption Cleanup
  // -------------------------------------------------------------------------
  describe('Exclusive Window Ownership & Cancellation Cleanup', () => {
    it('closes open GUI window and releases control when cancelled mid-craft', async () => {
      const { mockBot } = createMockBot([
        { name: 'crafting_table', count: 1 },
        { name: 'oak_planks', count: 3 },
        { name: 'stick', count: 2 },
      ]);

      const abortController = new AbortController();
      const mockWindow = { id: 1, type: 'minecraft:crafting' };

      // Simulate bot opening crafting window and awaiting craft
      mockBot.craft = vi.fn().mockImplementation(async () => {
        mockBot.currentWindow = mockWindow;
        // Trigger abort mid-craft
        abortController.abort();
        throw new Error('Craft aborted by preemption');
      });

      const executor = new ClosedLoopCraftingExecutor(mockBot);
      const ctx: ActionExecutionContext = {
        bot: mockBot,
        observation: createMockObservation(),
        config: {},
        abortSignal: abortController.signal,
        isCurrent: () => !abortController.signal.aborted,
      };

      const result = await executor.craftItem('wooden_pickaxe', 1, ctx);

      expect(result.status).toBe('interrupted');
      expect(result.reason).toContain('Crafting cancelled');
      // Open window was closed
      expect(mockBot.closeWindow).toHaveBeenCalledWith(mockWindow);
    });
  });

  // -------------------------------------------------------------------------
  // 8. Autonomous Furnace Smelting & Fuel Lifecycle
  // -------------------------------------------------------------------------
  describe('Autonomous Furnace Smelting & Fuel Lifecycle', () => {
    it('normal success: places furnace, deposits fuel and raw iron, waits for smelt, takes iron ingot, and recovers furnace', async () => {
      const { mockBot, items } = createMockBot([
        { name: 'furnace', count: 1 },
        { name: 'raw_iron', count: 2 },
        { name: 'coal', count: 1 },
        { name: 'stone_pickaxe', count: 1 },
      ]);

      const result = await techniqueSmeltItem(mockBot, 'raw_iron', 1);

      expect(result.status).toBe('success');
      expect(result.reason).toContain('Smelted 1x iron_ingot in furnace');

      // Verified furnace was placed via withWorkstation
      expect(mockBot.placeBlock).toHaveBeenCalled();
      // Verified furnace was opened
      expect(mockBot.openFurnace).toHaveBeenCalled();
      // Verified furnace was recovered via dig teardown
      expect(mockBot.dig).toHaveBeenCalled();

      // Output inventory verification: iron_ingot created
      const ironIngot = items.find((i) => i.name === 'iron_ingot');
      expect(ironIngot).toBeDefined();
      expect(ironIngot!.count).toBeGreaterThanOrEqual(1);
    });

    it('meaningful failure: rejects immediately when no furnace is nearby and none in inventory', async () => {
      const { mockBot } = createMockBot([
        { name: 'raw_iron', count: 1 },
        { name: 'coal', count: 1 },
      ]);

      const result = await techniqueSmeltItem(mockBot, 'raw_iron', 1);

      expect(result.status).toBe('failed');
      expect(result.reason).toContain('No furnace nearby and no furnace in inventory to place');
      expect(mockBot.openFurnace).not.toHaveBeenCalled();
    });

    it('meaningful failure: rejects when input item is missing from inventory', async () => {
      const { mockBot } = createMockBot([
        { name: 'furnace', count: 1 },
        { name: 'coal', count: 1 },
      ]);

      const result = await techniqueSmeltItem(mockBot, 'raw_iron', 1);

      expect(result.status).toBe('failed');
      expect(result.reason).toContain("Insufficient 'raw_iron' in inventory");
    });

    it('meaningful failure: rejects when fuel is missing from inventory', async () => {
      const { mockBot } = createMockBot([
        { name: 'furnace', count: 1 },
        { name: 'raw_iron', count: 1 },
      ]);

      const result = await techniqueSmeltItem(mockBot, 'raw_iron', 1);

      expect(result.status).toBe('failed');
      expect(result.reason).toContain('No suitable fuel');
    });

    it('meaningful failure: rejects non-smeltable item (e.g. dirt)', async () => {
      const { mockBot } = createMockBot([
        { name: 'furnace', count: 1 },
        { name: 'dirt', count: 5 },
        { name: 'coal', count: 1 },
      ]);

      const result = await techniqueSmeltItem(mockBot, 'dirt', 1);

      expect(result.status).toBe('failed');
      expect(result.reason).toContain("Item 'dirt' is not recognized as a smeltable item");
    });

    it('cancellation / preemption: halts cleanly without leaving open GUI when cancelled', async () => {
      const { mockBot } = createMockBot([
        { name: 'furnace', count: 1 },
        { name: 'raw_iron', count: 1 },
        { name: 'coal', count: 1 },
      ]);

      const abortController = new AbortController();
      abortController.abort(); // Cancelled before start

      const result = await techniqueSmeltItem(mockBot, 'raw_iron', 1, undefined, abortController.signal);

      expect(result.status).toBe('interrupted');
      expect(result.reason).toContain('Smelting cancelled');
    });
  });
});
