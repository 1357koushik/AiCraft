import { describe, it, expect, vi } from 'vitest';
import { Vec3 } from 'vec3';
import {
  computePortalGeometry,
  buildPortalFrame,
  ignitePortal,
} from '../src/dimensions/nether/portal_builder.js';
import {
  computeBunkerBlocks,
  buildPortalBunker,
  BLAST_RESISTANT_BLOCKS,
} from '../src/dimensions/nether/portal_bunker.js';
import {
  DimensionManager,
  defaultDimensionManager,
} from '../src/dimensions/dimension_transition.js';
import { MemoryManager } from '../src/memory/index.js';
import { loadConfig } from '../src/config/index.js';

describe('Phase 8: Nether Portal Construction and Nether Entry', () => {
  const config = loadConfig();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  // =========================================================================
  // 1. Portal Geometry Computation
  // =========================================================================
  describe('1. 4x5 Portal Geometry Computation', () => {
    it('computes minimal 10-block obsidian frame along X axis', () => {
      const origin = new Vec3(100, 64, 200);
      const geo = computePortalGeometry(origin, 'x', true);

      expect(geo.frameBlocks.length).toBe(10);
      expect(geo.interiorBlocks.length).toBe(6); // 2 wide x 3 high opening
      expect(geo.orientation).toBe('x');

      // Bottom sill: 2 blocks (x+1, x+2 at y=64)
      expect(geo.frameBlocks.some((p) => p.equals(new Vec3(101, 64, 200)))).toBe(true);
      expect(geo.frameBlocks.some((p) => p.equals(new Vec3(102, 64, 200)))).toBe(true);

      // Top lintel: 2 blocks (x+1, x+2 at y=68)
      expect(geo.frameBlocks.some((p) => p.equals(new Vec3(101, 68, 200)))).toBe(true);
      expect(geo.frameBlocks.some((p) => p.equals(new Vec3(102, 68, 200)))).toBe(true);

      // Left column: 3 blocks (x=100 at y=65, 66, 67)
      expect(geo.frameBlocks.some((p) => p.equals(new Vec3(100, 65, 200)))).toBe(true);
      expect(geo.frameBlocks.some((p) => p.equals(new Vec3(100, 66, 200)))).toBe(true);
      expect(geo.frameBlocks.some((p) => p.equals(new Vec3(100, 67, 200)))).toBe(true);

      // Right column: 3 blocks (x=103 at y=65, 66, 67)
      expect(geo.frameBlocks.some((p) => p.equals(new Vec3(103, 65, 200)))).toBe(true);
      expect(geo.frameBlocks.some((p) => p.equals(new Vec3(103, 66, 200)))).toBe(true);
      expect(geo.frameBlocks.some((p) => p.equals(new Vec3(103, 67, 200)))).toBe(true);

      // Ignition spot is inside the opening at y=65
      expect(geo.ignitionSpot.equals(new Vec3(101, 65, 200))).toBe(true);
    });

    it('computes minimal 10-block obsidian frame along Z axis', () => {
      const origin = new Vec3(50, 70, 50);
      const geo = computePortalGeometry(origin, 'z', true);

      expect(geo.frameBlocks.length).toBe(10);
      expect(geo.orientation).toBe('z');
      expect(geo.frameBlocks.some((p) => p.equals(new Vec3(50, 70, 51)))).toBe(true);
      expect(geo.frameBlocks.some((p) => p.equals(new Vec3(50, 70, 52)))).toBe(true);
      expect(geo.ignitionSpot.equals(new Vec3(50, 71, 51))).toBe(true);
    });

    it('computes full 14-block obsidian frame when corners are included', () => {
      const origin = new Vec3(0, 64, 0);
      const geo = computePortalGeometry(origin, 'x', false);

      expect(geo.frameBlocks.length).toBe(14);
      // Corners included
      expect(geo.frameBlocks.some((p) => p.equals(new Vec3(0, 64, 0)))).toBe(true);
      expect(geo.frameBlocks.some((p) => p.equals(new Vec3(3, 64, 0)))).toBe(true);
      expect(geo.frameBlocks.some((p) => p.equals(new Vec3(0, 68, 0)))).toBe(true);
      expect(geo.frameBlocks.some((p) => p.equals(new Vec3(3, 68, 0)))).toBe(true);
    });
  });

  // =========================================================================
  // 2. Portal Frame Construction and Ignition
  // =========================================================================
  describe('2. Portal Construction and Ignition', () => {
    it('fails portal construction if inventory has fewer than 10 obsidian blocks', async () => {
      const mockBot: any = {
        inventory: {
          items: () => [{ name: 'obsidian', count: 8 }],
        },
      };

      const res = await buildPortalFrame(mockBot, new Vec3(0, 64, 0), 'x', true);
      expect(res.status).toBe('failed');
      expect(res.reason).toContain('Insufficient obsidian');
    });

    it('places all 10 frame blocks when obsidian is sufficient', async () => {
      const placeSpy = vi.fn().mockResolvedValue(undefined);
      const equipSpy = vi.fn().mockResolvedValue(undefined);

      const mockBot: any = {
        inventory: {
          items: () => [{ name: 'obsidian', count: 12 }],
        },
        equip: equipSpy,
        placeBlock: placeSpy,
        blockAt: vi.fn().mockReturnValue({ name: 'air', boundingBox: 'empty' }),
      };

      const res = await buildPortalFrame(mockBot, new Vec3(0, 64, 0), 'x', true);
      expect(res.status).toBe('success');
      expect(res.details?.placed).toBe(10);
      expect(equipSpy).toHaveBeenCalled();
      expect(placeSpy).toHaveBeenCalled();
    });

    it('ignites portal using flint and steel on the bottom opening', async () => {
      const origin = new Vec3(10, 64, 10);
      const activateSpy = vi.fn().mockResolvedValue(undefined);
      const equipSpy = vi.fn().mockResolvedValue(undefined);

      const mockBot: any = {
        inventory: {
          items: () => [{ name: 'flint_and_steel', count: 1 }],
        },
        equip: equipSpy,
        activateBlock: activateSpy,
        lookAt: vi.fn().mockResolvedValue(undefined),
        blockAt: vi.fn().mockImplementation((pos: Vec3) => {
          if (pos.equals(new Vec3(11, 65, 10))) {
            return { name: 'nether_portal', boundingBox: 'empty' };
          }
          return { name: 'obsidian', boundingBox: 'block' };
        }),
      };

      const res = await ignitePortal(mockBot, origin, 'x');
      expect(res.status).toBe('success');
      expect(equipSpy).toHaveBeenCalledWith(expect.objectContaining({ name: 'flint_and_steel' }), 'hand');
      expect(activateSpy).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 3. Blast-Proof Nether Portal Bunker
  // =========================================================================
  describe('3. Blast-Proof Bunker Construction', () => {
    it('computes 6x6x5 hollow protective shell leaving a 1x2 doorway', () => {
      const portalOrigin = new Vec3(100, 64, 100);
      const { wallBlocks, roofBlocks, doorBlocks } = computeBunkerBlocks(portalOrigin, 6, 6, 5);

      expect(doorBlocks.length).toBe(2);
      expect(roofBlocks.length).toBe(36); // 6x6 roof
      expect(wallBlocks.length).toBeGreaterThan(50);

      // Ensures doorway blocks are excluded from wall blocks
      for (const d of doorBlocks) {
        expect(wallBlocks.some((w) => w.equals(d))).toBe(false);
      }
    });

    it('builds bunker using blast-resistant materials (cobblestone/deepslate/basalt)', async () => {
      const placeSpy = vi.fn().mockResolvedValue(undefined);
      const equipSpy = vi.fn().mockResolvedValue(undefined);

      const mockBot: any = {
        inventory: {
          items: () => [{ name: 'cobblestone', count: 128 }],
        },
        equip: equipSpy,
        placeBlock: placeSpy,
        blockAt: vi.fn().mockReturnValue(null),
      };

      const res = await buildPortalBunker(mockBot, new Vec3(10, 64, 10));
      expect(res.status).toBe('success');
      expect(res.details?.placed).toBeGreaterThan(0);
      expect(equipSpy).toHaveBeenCalledWith(expect.objectContaining({ name: 'cobblestone' }), 'hand');
    });
  });

  // =========================================================================
  // 4. Dimension Transition & Memory Recording
  // =========================================================================
  describe('4. Dimension Transition & Memory Recording', () => {
    it('detects dimension changes from bot environment state', () => {
      const manager = new DimensionManager();

      const overworldBot: any = { game: { dimension: 'minecraft:overworld' } };
      expect(manager.detectDimension(overworldBot)).toBe('overworld');

      const netherBot: any = { game: { dimension: 'minecraft:the_nether' } };
      expect(manager.detectDimension(netherBot)).toBe('the_nether');

      const endBot: any = { game: { dimension: 'minecraft:the_end' } };
      expect(manager.detectDimension(endBot)).toBe('the_end');
    });

    it('handles dimension transition: stops pathfinder, updates state, and records portal in memory', async () => {
      const manager = new DimensionManager();
      const stopSpy = vi.fn();
      const setGoalSpy = vi.fn();

      const memory = new MemoryManager('test_world_dim');

      const mockBot: any = {
        entity: { position: new Vec3(15, 64, -25) },
        pathfinder: {
          stop: stopSpy,
          setGoal: setGoalSpy,
          setMovements: vi.fn(),
        },
        registry: {},
      };

      await manager.handleDimensionTransition(mockBot, 'the_nether', memory);

      expect(manager.getCurrentDimension()).toBe('the_nether');
      expect(stopSpy).toHaveBeenCalled();
      expect(setGoalSpy).toHaveBeenCalledWith(null);

      // Verify portal was recorded in memory
      const portalPos = memory.getPortal('the_nether');
      expect(portalPos).toBeDefined();
      expect(portalPos?.x).toBe(15);
      expect(portalPos?.y).toBe(64);
      expect(portalPos?.z).toBe(-25);
    });
  });
});
