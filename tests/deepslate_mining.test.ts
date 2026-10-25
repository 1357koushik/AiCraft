import { describe, it, expect, vi } from 'vitest';
import { Vec3 } from 'vec3';
import {
  detectAdjacentLavaPocket,
  sealLavaLeak,
  techniqueBranchMineDeepslate,
} from '../src/actions/mining/deepslate_branch.js';
import {
  evaluatePreNetherChecklist,
  techniqueHarvestObsidian,
  techniqueCastObsidian,
  findLavaSourcePool,
} from '../src/actions/mining/obsidian_harvester.ts';
import { DynamicDAGCompiler } from '../src/agent/planner/dag.js';
import { defaultOperatorRegistry } from '../src/agent/planner/operator.js';
import { loadConfig } from '../src/config/index.js';

describe('Phase 7: Diamond Age and Pre-Nether Preparation', () => {
  const config = loadConfig();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  // =========================================================================
  // 1. Lava Pocket Detection and Containment
  // =========================================================================
  describe('1. Lava Pocket Detection and Containment', () => {
    it('detects adjacent lava or flowing lava block', () => {
      const center = new Vec3(10, -58, 10);
      const lavaPos = new Vec3(11, -58, 10);

      const mockBot: any = {
        blockAt: vi.fn().mockImplementation((pos: Vec3) => {
          if (pos.equals(lavaPos)) return { name: 'lava' };
          return { name: 'deepslate', boundingBox: 'block' };
        }),
      };

      const detected = detectAdjacentLavaPocket(mockBot, center);
      expect(detected).toBeDefined();
      expect(detected?.x).toBe(11);
      expect(detected?.y).toBe(-58);
      expect(detected?.z).toBe(10);
    });

    it('returns null when no adjacent lava hazards exist', () => {
      const center = new Vec3(10, -58, 10);
      const mockBot: any = {
        blockAt: vi.fn().mockReturnValue({ name: 'deepslate', boundingBox: 'block' }),
      };

      const detected = detectAdjacentLavaPocket(mockBot, center);
      expect(detected).toBeNull();
    });

    it('seals exposed lava leak using solid cobblestone/deepslate from inventory', async () => {
      const leakPos = new Vec3(11, -58, 10);
      const solidNeighborPos = new Vec3(11, -59, 10); // Floor block below leak

      const equipSpy = vi.fn().mockResolvedValue(undefined);
      const placeSpy = vi.fn().mockResolvedValue(undefined);

      const mockBot: any = {
        inventory: {
          items: () => [{ name: 'cobbled_deepslate', type: 40 }],
        },
        equip: equipSpy,
        placeBlock: placeSpy,
        blockAt: vi.fn().mockImplementation((pos: Vec3) => {
          if (pos.equals(solidNeighborPos)) {
            return { name: 'deepslate', boundingBox: 'block', position: solidNeighborPos };
          }
          if (pos.equals(leakPos)) {
            return { name: 'lava', position: leakPos };
          }
          return { name: 'deepslate', boundingBox: 'block', position: pos };
        }),
      };

      const sealed = await sealLavaLeak(mockBot, leakPos);
      expect(sealed).toBe(true);
      expect(equipSpy).toHaveBeenCalledWith(expect.objectContaining({ name: 'cobbled_deepslate' }), 'hand');
      expect(placeSpy).toHaveBeenCalledWith(
        expect.objectContaining({ position: solidNeighborPos }),
        expect.objectContaining({ y: 1 })
      );
    });
  });

  // =========================================================================
  // 2. Deepslate Branch Mining
  // =========================================================================
  describe('2. Deepslate Branch Mining', () => {
    it('fails if pickaxe tier is insufficient (< tier 3, requires iron pickaxe)', async () => {
      const mockBot: any = {
        inventory: {
          items: () => [{ name: 'stone_pickaxe', count: 1 }], // Tier 2, cannot harvest diamond
        },
      };

      const ctx: any = { config, logger, isCurrent: () => true };
      const res = await techniqueBranchMineDeepslate(mockBot, 3, -58, ctx);

      expect(res.status).toBe('failed');
      expect(res.details?.failureKind).toBe('WRONG_TOOL_TIER');
    });

    it('extracts diamond ore vein when discovered during branch mining', async () => {
      let diamondCount = 0;
      const orePos = new Vec3(1, -58, 0);
      const mockOreBlock: any = {
        name: 'deepslate_diamond_ore',
        position: orePos,
        boundingBox: 'block',
      };

      const mockBot: any = {
        entity: { position: new Vec3(0, -58, 0), yaw: 0 },
        blockAt: vi.fn().mockImplementation((pos: Vec3) => {
          if (pos.equals(orePos)) return mockOreBlock;
          return { name: 'deepslate', boundingBox: 'block', position: pos };
        }),
        findBlock: vi.fn().mockImplementation(({ matching }: any) => {
          if (matching(mockOreBlock)) return mockOreBlock;
          return null;
        }),
        dig: vi.fn().mockImplementation(async () => {
          diamondCount += 3;
          mockOreBlock.name = 'air';
        }),
        setControlState: vi.fn(),
        inventory: {
          items: vi.fn().mockImplementation(() => [
            { name: 'iron_pickaxe', count: 1 },
            { name: 'diamond', count: diamondCount },
          ]),
        },
        pathfinder: {
          goto: vi.fn().mockResolvedValue(undefined),
          stop: vi.fn(),
        },
      };

      const ctx: any = { config, logger, isCurrent: () => true };
      const res = await techniqueBranchMineDeepslate(mockBot, 3, -58, ctx);

      expect(res.status).toBe('success');
      expect(res.details?.totalDiamonds).toBeGreaterThanOrEqual(3);
    });
  });

  // =========================================================================
  // 3. Obsidian Harvesting & Casting
  // =========================================================================
  describe('3. Obsidian Harvesting & Water Casting', () => {
    it('casts obsidian by placing water adjacent to lava pool and retrieves water', async () => {
      const lavaPos = new Vec3(10, -58, 10);
      const adjacentAirPos = new Vec3(10, -57, 10); // Directly above lava

      const activateSpy = vi.fn();
      const equipSpy = vi.fn().mockResolvedValue(undefined);

      const mockBot: any = {
        inventory: {
          items: () => [
            { name: 'water_bucket', count: 1 },
            { name: 'bucket', count: 1 },
          ],
        },
        equip: equipSpy,
        activateItem: activateSpy,
        lookAt: vi.fn().mockResolvedValue(undefined),
        blockAt: vi.fn().mockImplementation((pos: Vec3) => {
          if (pos.equals(adjacentAirPos)) return { name: 'air' };
          return { name: 'deepslate', boundingBox: 'block' };
        }),
      };

      const success = await techniqueCastObsidian(mockBot, { position: lavaPos });
      expect(success).toBe(true);
      expect(equipSpy).toHaveBeenCalledWith(expect.objectContaining({ name: 'water_bucket' }), 'hand');
      expect(activateSpy).toHaveBeenCalled();
    });

    it('rejects obsidian mining if bot lacks a diamond pickaxe (tier >= 4)', async () => {
      const mockBot: any = {
        inventory: {
          items: () => [{ name: 'iron_pickaxe', count: 1 }], // Tier 3, cannot mine obsidian
        },
      };

      const ctx: any = { config, logger, isCurrent: () => true };
      const res = await techniqueHarvestObsidian(mockBot, 10, ctx);

      expect(res.status).toBe('failed');
      expect(res.details?.failureKind).toBe('WRONG_TOOL_TIER');
    });

    it('mines obsidian blocks using diamond pickaxe to satisfy requirement', async () => {
      let obsCount = 0;
      const obsPos = new Vec3(2, -58, 0);
      const mockObsBlock = {
        name: 'obsidian',
        position: obsPos,
        boundingBox: 'block',
      };

      const mockBot: any = {
        entity: { position: new Vec3(0, -58, 0) },
        findBlock: vi.fn().mockImplementation(({ matching }: any) => {
          if (matching(mockObsBlock)) return mockObsBlock;
          return null;
        }),
        dig: vi.fn().mockImplementation(async () => {
          obsCount += 10;
          mockObsBlock.name = 'air';
        }),
        inventory: {
          items: vi.fn().mockImplementation(() => [
            { name: 'diamond_pickaxe', count: 1 },
            { name: 'obsidian', count: obsCount },
          ]),
        },
      };

      const ctx: any = { config, logger, isCurrent: () => true };
      const res = await techniqueHarvestObsidian(mockBot, 10, ctx);

      expect(res.status).toBe('success');
      expect(res.details?.totalObsidian).toBeGreaterThanOrEqual(10);
    });
  });

  // =========================================================================
  // 4. Pre-Nether Survival Checklist
  // =========================================================================
  describe('4. Pre-Nether Survival Checklist', () => {
    it('evaluates incomplete checklist when missing obsidian and flint & steel', () => {
      const mockBot: any = {
        inventory: {
          items: () => [
            { name: 'diamond_pickaxe', count: 1 },
            { name: 'diamond_sword', count: 1 },
            { name: 'water_bucket', count: 1 },
            { name: 'obsidian', count: 4 }, // Only 4, needs 10
          ],
        },
      };

      const status = evaluatePreNetherChecklist(mockBot);
      expect(status.diamondPickaxe).toBe(true);
      expect(status.diamondSword).toBe(true);
      expect(status.obsidianCount).toBe(4);
      expect(status.flintAndSteel).toBe(false);
      expect(status.readyForNether).toBe(false);
    });

    it('evaluates complete checklist when all prerequisites are fulfilled', () => {
      const mockBot: any = {
        inventory: {
          items: () => [
            { name: 'diamond_pickaxe', count: 1 },
            { name: 'diamond_sword', count: 1 },
            { name: 'obsidian', count: 14 },
            { name: 'flint_and_steel', count: 1 },
            { name: 'water_bucket', count: 2 },
          ],
        },
      };

      const status = evaluatePreNetherChecklist(mockBot);
      expect(status.diamondPickaxe).toBe(true);
      expect(status.diamondSword).toBe(true);
      expect(status.obsidianCount).toBe(14);
      expect(status.flintAndSteel).toBe(true);
      expect(status.waterBuckets).toBe(2);
      expect(status.readyForNether).toBe(true);
    });
  });

  // =========================================================================
  // 5. Dynamic DAG Plans for Pre-Nether Gear
  // =========================================================================
  describe('5. Dynamic DAG Plans for Pre-Nether Gear', () => {
    const compiler = new DynamicDAGCompiler(defaultOperatorRegistry);

    it('generates complete task plan for diamond pickaxe', () => {
      const plan = compiler.compilePlan('goal_diamond_pickaxe', 'diamond_pickaxe', 1, {});
      expect(plan).toBeDefined();
      const taskIds = plan?.tasks.map((t) => t.id) || [];
      expect(taskIds.some((id) => id.includes('op_craft_diamond_pickaxe'))).toBe(true);
      expect(taskIds.some((id) => id.includes('op_mine_diamond_ore'))).toBe(true);
      expect(taskIds.some((id) => id.includes('op_craft_table'))).toBe(true);
    });

    it('generates complete task plan for flint and steel', () => {
      const plan = compiler.compilePlan('goal_flint_and_steel', 'flint_and_steel', 1, {});
      expect(plan).toBeDefined();
      const taskIds = plan?.tasks.map((t) => t.id) || [];
      expect(taskIds.some((id) => id.includes('op_craft_flint_and_steel'))).toBe(true);
      expect(taskIds.some((id) => id.includes('op_dig_flint'))).toBe(true);
      expect(taskIds.some((id) => id.includes('op_smelt_iron_ingot'))).toBe(true);
    });

    it('generates task plan for harvesting obsidian requiring diamond pickaxe', () => {
      const plan = compiler.compilePlan('goal_obsidian', 'obsidian', 10, {});
      expect(plan).toBeDefined();
      const taskIds = plan?.tasks.map((t) => t.id) || [];
      expect(taskIds.some((id) => id.includes('op_harvest_obsidian'))).toBe(true);
      expect(taskIds.some((id) => id.includes('op_craft_diamond_pickaxe'))).toBe(true);
    });
  });
});
