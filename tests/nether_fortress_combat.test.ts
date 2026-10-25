import { describe, it, expect, vi } from 'vitest';
import { Vec3 } from 'vec3';
import {
  isFortressBlock,
  detectNearbyFortress,
  isFortressWalkwaySafe,
  techniqueTraverseFortressCorridor,
} from '../src/dimensions/nether/fortress_navigator.js';
import {
  hasTwoBlockCeiling,
  placeTwoBlockBarricade,
  techniqueEngageWitherSkeleton,
} from '../src/actions/combat/wither_skeleton_tactics.js';
import {
  countBlazeRods,
  findNearestBlaze,
  techniqueFarmBlazeRods,
} from '../src/dimensions/nether/blaze_farmer.js';
import { DynamicDAGCompiler } from '../src/agent/planner/dag.js';
import { defaultOperatorRegistry } from '../src/agent/planner/operator.js';
import { loadConfig } from '../src/config/index.js';

describe('Phase 9: Nether Fortress Discovery and Blaze Rod Acquisition', () => {
  const config = loadConfig();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  // =========================================================================
  // 1. Fortress Recognition and Walkway Safety
  // =========================================================================
  describe('1. Fortress Recognition & Walkway Safety', () => {
    it('correctly classifies fortress architectural blocks', () => {
      expect(isFortressBlock('nether_bricks')).toBe(true);
      expect(isFortressBlock('nether_brick_fence')).toBe(true);
      expect(isFortressBlock('nether_brick_stairs')).toBe(true);
      expect(isFortressBlock('nether_brick_slab')).toBe(true);
      expect(isFortressBlock('netherrack')).toBe(false);
      expect(isFortressBlock('soul_sand')).toBe(false);
    });

    it('detects nearest fortress location from surrounding blocks', () => {
      const fortressPos = new Vec3(200, 58, 300);
      const mockBot: any = {
        findBlock: vi.fn().mockImplementation(({ matching }: any) => {
          if (matching({ name: 'nether_bricks' })) {
            return { position: fortressPos, name: 'nether_bricks' };
          }
          return null;
        }),
      };

      const found = detectNearbyFortress(mockBot, 48);
      expect(found).toBeDefined();
      expect(found?.x).toBe(200);
      expect(found?.y).toBe(58);
      expect(found?.z).toBe(300);
    });

    it('rejects fortress walkways that drop below Y=32 or overhang lava sea', () => {
      const lavaFloorPos = new Vec3(100, 31, 100); // Lava sea elevation
      const mockBot: any = {
        blockAt: vi.fn().mockImplementation((pos: Vec3) => {
          if (pos.equals(lavaFloorPos)) return { name: 'lava' };
          return { name: 'netherrack', boundingBox: 'block' };
        }),
      };

      expect(isFortressWalkwaySafe(mockBot, lavaFloorPos)).toBe(false);
    });

    it('approves solid nether brick walkways elevated safely above lava', () => {
      const safeFloorPos = new Vec3(100, 60, 100);
      const mockBot: any = {
        blockAt: vi.fn().mockImplementation((pos: Vec3) => {
          if (pos.equals(safeFloorPos)) return { name: 'nether_bricks', boundingBox: 'block' };
          return { name: 'air' };
        }),
      };

      expect(isFortressWalkwaySafe(mockBot, safeFloorPos)).toBe(true);
    });
  });

  // =========================================================================
  // 2. Wither Skeleton 2-Block Barricade Tactics
  // =========================================================================
  describe('2. Wither Skeleton Tactics', () => {
    it('detects when a 2-block ceiling exists to block 2.4m wither skeletons', () => {
      const floorPos = new Vec3(10, 60, 10);
      const ceilingPos = new Vec3(10, 62, 10); // y + 2

      const mockBot: any = {
        blockAt: vi.fn().mockImplementation((pos: Vec3) => {
          if (pos.equals(ceilingPos)) return { name: 'nether_bricks', boundingBox: 'block' };
          return { name: 'air' };
        }),
      };

      expect(hasTwoBlockCeiling(mockBot, floorPos)).toBe(true);
    });

    it('places a 2-high doorway barricade block using materials in inventory', async () => {
      const doorFloor = new Vec3(10, 60, 10);
      const ceilingPos = new Vec3(10, 62, 10);
      const refPos = new Vec3(10, 63, 10);

      const placeSpy = vi.fn().mockResolvedValue(undefined);
      const equipSpy = vi.fn().mockResolvedValue(undefined);

      const mockBot: any = {
        inventory: {
          items: () => [{ name: 'cobblestone', count: 16 }],
        },
        equip: equipSpy,
        placeBlock: placeSpy,
        blockAt: vi.fn().mockImplementation((pos: Vec3) => {
          if (pos.equals(refPos)) return { name: 'nether_bricks', boundingBox: 'block', position: refPos };
          return null;
        }),
      };

      const placed = await placeTwoBlockBarricade(mockBot, doorFloor);
      expect(placed).toBe(true);
      expect(equipSpy).toHaveBeenCalledWith(expect.objectContaining({ name: 'cobblestone' }), 'hand');
      expect(placeSpy).toHaveBeenCalled();
    });

    it('strikes wither skeleton legs from safety under barricade', async () => {
      const mockWither: any = {
        name: 'wither_skeleton',
        position: new Vec3(12, 60, 10),
        height: 2.4,
        health: 20,
        isValid: true,
      };

      const mockBot: any = {
        entity: { position: new Vec3(10, 60, 10) },
        heldItem: { name: 'diamond_sword' },
        inventory: {
          slots: { 45: { name: 'shield' } },
          items: () => [{ name: 'diamond_sword' }, { name: 'shield' }],
        },
        supportFeature: () => true,
        lookAt: vi.fn().mockResolvedValue(undefined),
        blockAt: vi.fn().mockImplementation((pos: Vec3) => {
          // 2-high ceiling above bot
          if (pos.equals(new Vec3(10, 62, 10))) return { name: 'nether_bricks', boundingBox: 'block' };
          return { name: 'air' };
        }),
        attack: vi.fn().mockImplementation(() => {
          mockWither.health = 0;
          mockWither.isValid = false;
        }),
      };

      const ctx: any = { config, logger, isCurrent: () => true };
      const res = await techniqueEngageWitherSkeleton(mockBot, mockWither, ctx);

      expect(res.status).toBe('success');
      expect(res.reason).toContain('under 2-high barricade: true');
      expect(mockBot.attack).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 3. Blaze Farming & Shield Fireball Defense
  // =========================================================================
  describe('3. Blaze Farming & Shield Defense', () => {
    it('accurately counts blaze rods in inventory', () => {
      const mockBot: any = {
        inventory: {
          items: () => [
            { name: 'blaze_rod', count: 4 },
            { name: 'coal', count: 10 },
            { name: 'blaze_rod', count: 3 },
          ],
        },
      };

      expect(countBlazeRods(mockBot)).toBe(7);
    });

    it('finds nearest living Blaze entity', () => {
      const mockBot: any = {
        entity: { position: new Vec3(0, 60, 0) },
        entities: {
          10: { name: 'blaze', position: new Vec3(5, 62, 5), health: 20, isValid: true },
          11: { name: 'zombie_pigman', position: new Vec3(2, 60, 2), health: 20, isValid: true },
        },
      };

      const nearest = findNearestBlaze(mockBot, 24);
      expect(nearest).toBeDefined();
      expect(nearest.name).toBe('blaze');
    });

    it('farms blaze rods using shield against fire charges and attacks during cooldown', async () => {
      let currentRods = 5;
      const mockBlaze: any = {
        name: 'blaze',
        position: new Vec3(4, 62, 0),
        height: 1.8,
        health: 20,
        isValid: true,
      };

      const activateSpy = vi.fn();
      const deactivateSpy = vi.fn();

      const mockBot: any = {
        entity: { position: new Vec3(0, 60, 0) },
        heldItem: { name: 'diamond_sword' },
        entities: { 1: mockBlaze },
        inventory: {
          slots: { 45: { name: 'shield' } },
          items: vi.fn().mockImplementation(() => [
            { name: 'diamond_sword' },
            { name: 'shield' },
            { name: 'blaze_rod', count: currentRods },
          ]),
        },
        supportFeature: () => true,
        activateItem: activateSpy,
        deactivateItem: deactivateSpy,
        lookAt: vi.fn().mockResolvedValue(undefined),
        attack: vi.fn().mockImplementation(() => {
          mockBlaze.health = 0;
          mockBlaze.isValid = false;
          currentRods = 8; // Drop acquired!
        }),
      };

      const ctx: any = { config, logger, isCurrent: () => true };
      const res = await techniqueFarmBlazeRods(mockBot, 7, ctx);

      expect(res.status).toBe('success');
      expect(activateSpy).toHaveBeenCalledWith(true); // Raised shield
      expect(mockBot.attack).toHaveBeenCalled();
      expect(res.details?.totalRods).toBeGreaterThanOrEqual(7);
    });
  });

  // =========================================================================
  // 4. DAG Planning for Blaze Powder
  // =========================================================================
  describe('4. DAG Planning for Blaze Powder', () => {
    const compiler = new DynamicDAGCompiler(defaultOperatorRegistry);

    it('generates a complete plan for blaze powder requiring blaze rod farming', () => {
      const plan = compiler.compilePlan('goal_blaze_powder', 'blaze_powder', 2, {});
      expect(plan).toBeDefined();
      const taskIds = plan?.tasks.map((t) => t.id) || [];
      expect(taskIds.some((id) => id.includes('op_craft_blaze_powder'))).toBe(true);
      expect(taskIds.some((id) => id.includes('op_farm_blaze_rods'))).toBe(true);
    });
  });
});
