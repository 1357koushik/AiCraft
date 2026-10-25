import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Vec3 } from 'vec3';
import { DynamicDAGCompiler } from '../src/agent/planner/dag.js';
import { defaultOperatorRegistry } from '../src/agent/planner/operator.js';
import {
  getEquippedArmor,
  getMissingArmorPieces,
  techniqueAutoEquipBestGear,
  techniqueCraftAndEquipArmorSet,
} from '../src/actions/equipment/armor_manager.js';
import {
  countCookedFood,
  countRawMeat,
  findNearbyHuntableAnimal,
  techniqueHarvestAndCookFood,
} from '../src/actions/farming/food_pipeline.js';
import { techniqueAutomateIronSmeltCycle } from '../src/actions/techniques.js';
import { techniqueStaircaseMineIron } from '../src/actions/mining.js';
import { loadConfig } from '../src/config/index.js';

describe('Phase 5: Iron Age and Mid-game Progression', () => {
  const config = loadConfig();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  // =========================================================================
  // 1. DAG Plan Generation for Iron Age Gear
  // =========================================================================
  describe('1. DAG Plan Generation for Iron Age Gear', () => {
    const compiler = new DynamicDAGCompiler(defaultOperatorRegistry);

    it('generates a complete backward-chained plan for full iron armor set', () => {
      const items = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'];
      for (const item of items) {
        const plan = compiler.compilePlan(`goal_${item}`, item, 1, {});
        expect(plan).toBeDefined();
        expect(plan?.tasks.length).toBeGreaterThan(0);

        // Target task should produce the armor piece
        const targetTask = plan?.tasks[plan.tasks.length - 1];
        expect(targetTask?.id).toContain(`op_craft_${item}`);

        // Dependencies must include smelting iron ingot and mining iron ore
        const taskIds = plan?.tasks.map((t) => t.id) || [];
        expect(taskIds.some((id) => id.includes('op_smelt_iron_ingot'))).toBe(true);
        expect(taskIds.some((id) => id.includes('op_mine_iron_ore'))).toBe(true);
        expect(taskIds.some((id) => id.includes('op_craft_table'))).toBe(true);
        expect(taskIds.some((id) => id.includes('op_craft_furnace'))).toBe(true);
      }
    });

    it('generates dependency-aware plans for iron pickaxe, sword, shield, and bucket', () => {
      const gear = [
        { item: 'iron_pickaxe', op: 'op_craft_iron_pickaxe' },
        { item: 'iron_sword', op: 'op_craft_iron_sword' },
        { item: 'shield', op: 'op_craft_shield' },
        { item: 'bucket', op: 'op_craft_bucket' },
      ];

      for (const { item, op } of gear) {
        const plan = compiler.compilePlan(`goal_${item}`, item, 1, {});
        expect(plan).toBeDefined();
        const taskIds = plan?.tasks.map((t) => t.id) || [];
        expect(taskIds.some((id) => id.includes(op))).toBe(true);
        expect(taskIds.some((id) => id.includes('op_smelt_iron_ingot'))).toBe(true);
      }
    });

    it('bypasses workstation crafting if workstations and iron ingots already in inventory', () => {
      const plan = compiler.compilePlan('goal_iron_sword', 'iron_sword', 1, {
        iron_ingot: 2,
        stick: 1,
        crafting_table: 1,
      });

      expect(plan).toBeDefined();
      const taskIds = plan?.tasks.map((t) => t.id) || [];
      expect(taskIds.some((id) => id.includes('op_craft_iron_sword'))).toBe(true);
      expect(taskIds.some((id) => id.includes('op_smelt_iron_ingot'))).toBe(false);
      expect(taskIds.some((id) => id.includes('op_craft_table'))).toBe(false);
    });
  });

  // =========================================================================
  // 2. Armor Manager & Auto-Equipping Pipeline
  // =========================================================================
  describe('2. Armor Manager & Auto-Equipping', () => {
    it('accurately identifies currently equipped armor slots and off-hand shield', () => {
      const mockBot: any = {
        inventory: {
          slots: {
            5: { name: 'iron_helmet' },
            6: { name: 'iron_chestplate' },
            7: null,
            8: { name: 'leather_boots' },
            45: { name: 'shield' },
          },
        },
        supportFeature: () => true,
      };

      const summary = getEquippedArmor(mockBot);
      expect(summary.helmet).toBe('iron_helmet');
      expect(summary.chestplate).toBe('iron_chestplate');
      expect(summary.leggings).toBeNull();
      expect(summary.boots).toBe('leather_boots');
      expect(summary.shield).toBe(true);
    });

    it('identifies missing armor pieces when desired tier is iron', () => {
      const mockBot: any = {
        inventory: {
          slots: {
            5: { name: 'iron_helmet' },
            6: null,
            7: null,
            8: { name: 'leather_boots' }, // Lower tier than iron
          },
          items: () => [{ name: 'iron_leggings', count: 1 }], // Leggings are in inventory
        },
        supportFeature: () => true,
      };

      const missing = getMissingArmorPieces(mockBot, 'iron');
      expect(missing).toContain('iron_chestplate');
      expect(missing).toContain('iron_boots');
      expect(missing).not.toContain('iron_helmet');
      expect(missing).not.toContain('iron_leggings');
    });

    it('auto-equips best available gear from inventory into equipment slots', async () => {
      const equipSpy = vi.fn().mockResolvedValue(undefined);
      const mockBot: any = {
        inventory: {
          slots: { 5: null, 6: null, 7: null, 8: null, 45: null },
          items: () => [
            { name: 'leather_chestplate', type: 1 },
            { name: 'iron_chestplate', type: 2 },
            { name: 'iron_helmet', type: 3 },
            { name: 'shield', type: 4 },
          ],
        },
        equip: equipSpy,
      };

      await techniqueAutoEquipBestGear(mockBot);

      expect(equipSpy).toHaveBeenCalledWith(expect.objectContaining({ name: 'iron_helmet' }), 'head');
      expect(equipSpy).toHaveBeenCalledWith(expect.objectContaining({ name: 'iron_chestplate' }), 'torso');
      expect(equipSpy).toHaveBeenCalledWith(expect.objectContaining({ name: 'shield' }), 'off-hand');
    });

    it('crafts missing pieces and equips full armor set', async () => {
      const equipSpy = vi.fn().mockResolvedValue(undefined);
      const mockBot: any = {
        entity: { position: new Vec3(0, 64, 0) },
        inventory: {
          slots: {
            5: { name: 'iron_helmet' },
            6: null,
            7: null,
            8: null,
          },
          items: vi.fn().mockReturnValue([
            { name: 'iron_ingot', count: 20 },
            { name: 'iron_chestplate', count: 1 },
            { name: 'iron_leggings', count: 1 },
            { name: 'iron_boots', count: 1 },
          ]),
        },
        equip: equipSpy,
      };

      const ctx = {
        bot: mockBot,
        config,
        logger,
        isCurrent: () => true,
      };

      const res = await techniqueCraftAndEquipArmorSet(mockBot, 'iron', ctx as any);
      expect(res.status).toBe('success');
    });
  });

  // =========================================================================
  // 3. Automated Iron Smelting Cycle
  // =========================================================================
  describe('3. Automated Iron Smelting Cycle', () => {
    it('fails gracefully if no raw iron or iron ore is present in inventory', async () => {
      const mockBot: any = {
        inventory: {
          items: () => [{ name: 'cobblestone', count: 10 }],
        },
      };

      const res = await techniqueAutomateIronSmeltCycle(mockBot, 5);
      expect(res.status).toBe('failed');
      expect(res.reason).toContain('No raw iron');
    });

    it('returns interrupted if aborted before start', async () => {
      const mockBot: any = { inventory: { items: () => [] } };
      const abortController = new AbortController();
      abortController.abort();

      const res = await techniqueAutomateIronSmeltCycle(mockBot, 5, undefined, abortController.signal);
      expect(res.status).toBe('interrupted');
    });

    it('executes smelting cycle using furnace and fuel when items are present', async () => {
      let furnaceOpen = false;
      let furnaceOutCount = 0;
      let ironIngotCount = 0;

      const mockFurnace: any = {
        putFuel: vi.fn().mockResolvedValue(undefined),
        putInput: vi.fn().mockImplementation(async () => {
          furnaceOutCount = 4;
        }),
        outputItem: vi.fn().mockImplementation(() => {
          return furnaceOutCount > 0 ? { name: 'iron_ingot', count: furnaceOutCount } : null;
        }),
        inputItem: vi.fn().mockReturnValue(null),
        takeOutput: vi.fn().mockImplementation(async () => {
          ironIngotCount = 4;
          furnaceOutCount = 0;
        }),
        close: vi.fn().mockImplementation(() => { furnaceOpen = false; }),
      };

      const mockBot: any = {
        entity: { position: new Vec3(0, 64, 0) },
        findBlock: vi.fn().mockReturnValue({ name: 'furnace', position: new Vec3(1, 64, 0) }),
        openFurnace: vi.fn().mockImplementation(async () => {
          furnaceOpen = true;
          return mockFurnace;
        }),
        inventory: {
          items: vi.fn().mockImplementation(() => [
            { name: 'raw_iron', count: 4, type: 50 },
            { name: 'coal', count: 2, type: 51 },
            { name: 'iron_ingot', count: ironIngotCount, type: 52 },
          ]),
        },
      };

      const res = await techniqueAutomateIronSmeltCycle(mockBot, 4);
      expect(res.status).toBe('success');
      expect(res.details?.outputItem).toBe('iron_ingot');
      expect(mockFurnace.putFuel).toHaveBeenCalled();
      expect(mockFurnace.putInput).toHaveBeenCalled();
      expect(mockFurnace.takeOutput).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 4. Food Hunting and Cooking Pipeline
  // =========================================================================
  describe('4. Food Pipeline', () => {
    it('accurately counts cooked food and raw meat in inventory', () => {
      const mockBot: any = {
        inventory: {
          items: () => [
            { name: 'cooked_beef', count: 8 },
            { name: 'bread', count: 5 },
            { name: 'beef', count: 6 },
            { name: 'porkchop', count: 4 },
            { name: 'cobblestone', count: 64 },
          ],
        },
      };

      expect(countCookedFood(mockBot)).toBe(13); // 8 cooked_beef + 5 bread
      expect(countRawMeat(mockBot)).toBe(10); // 6 beef + 4 porkchop
    });

    it('finds nearest huntable animal within search radius', () => {
      const mockBot: any = {
        entity: { position: new Vec3(0, 64, 0) },
        entities: {
          10: { name: 'cow', position: new Vec3(5, 64, 5), height: 1.4 },
          11: { name: 'pig', position: new Vec3(20, 64, 20), height: 0.9 },
          12: { name: 'zombie', position: new Vec3(2, 64, 2) }, // Hostile, not food
        },
      };

      const nearest = findNearbyHuntableAnimal(mockBot, 32);
      expect(nearest).toBeDefined();
      expect(nearest.name).toBe('cow');
    });

    it('satisfies food pipeline immediately if cooked food reserve is already met', async () => {
      const mockBot: any = {
        entity: { position: new Vec3(0, 64, 0) },
        inventory: {
          items: () => [{ name: 'cooked_beef', count: 20 }],
        },
      };

      const res = await techniqueHarvestAndCookFood(mockBot, 16);
      expect(res.status).toBe('success');
      expect(res.reason).toContain('reserve already satisfied');
    });
  });

  // =========================================================================
  // 5. Staircase Mining for Iron
  // =========================================================================
  describe('5. Staircase Mining for Iron', () => {
    it('fails if no stone pickaxe or higher is available in inventory', async () => {
      const mockBot: any = {
        inventory: {
          items: () => [
            { name: 'wooden_pickaxe', count: 1 }, // Tier 1, cannot harvest iron
            { name: 'torches', count: 10 },
          ],
        },
      };

      const ctx: any = { config, logger, isCurrent: () => true };
      const res = await techniqueStaircaseMineIron(mockBot, 5, 16, ctx);
      expect(res.status).toBe('failed');
      expect(res.details?.failureKind).toBe('WRONG_TOOL_TIER');
    });

    it('harvests iron ore vein when exposed ore is detected nearby', async () => {
      let rawIronInInv = 0;
      const orePos = new Vec3(1, 20, 0); // Within 1.5m reach
      const mockOreBlock: any = {
        name: 'iron_ore',
        position: orePos,
        boundingBox: 'block',
      };

      const mockBot: any = {
        entity: { position: new Vec3(0, 20, 0), yaw: 0 },
        blockAt: vi.fn().mockImplementation((pos: Vec3) => {
          if (pos.equals(orePos)) return mockOreBlock;
          return { name: 'stone', boundingBox: 'block', position: pos };
        }),
        findBlock: vi.fn().mockImplementation(({ matching }: any) => {
          if (matching(mockOreBlock)) return mockOreBlock;
          return null;
        }),
        dig: vi.fn().mockImplementation(async () => {
          rawIronInInv += 4;
          mockOreBlock.name = 'air';
        }),
        inventory: {
          items: vi.fn().mockImplementation(() => [
            { name: 'stone_pickaxe', count: 1 },
            { name: 'raw_iron', count: rawIronInInv },
          ]),
        },
        pathfinder: {
          goto: vi.fn().mockResolvedValue(undefined),
          stop: vi.fn(),
        },
      };

      const ctx: any = { config, logger, isCurrent: () => true };
      const res = await techniqueStaircaseMineIron(mockBot, 4, 16, ctx);
      expect(res.status).toBe('success');
      expect(res.details?.totalCount).toBeGreaterThanOrEqual(4);
    });
  });
});
