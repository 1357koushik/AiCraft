import { describe, it, expect, vi } from 'vitest';
import { Vec3 } from 'vec3';
import {
  yawToDirectionVector,
  triangulateStronghold,
} from '../src/dimensions/stronghold/triangulation.js';
import {
  isStrongholdBlock,
  findPortalRoom,
  findAllPortalFrames,
} from '../src/dimensions/stronghold/stronghold_navigator.js';
import {
  isFrameFilled,
  neutralizeSilverfishSpawner,
  activateEndPortal,
} from '../src/dimensions/stronghold/portal_activator.js';
import { DynamicDAGCompiler } from '../src/agent/planner/dag.js';
import { defaultOperatorRegistry } from '../src/agent/planner/operator.js';
import { loadConfig } from '../src/config/index.js';

describe('Phase 11: Stronghold Discovery and End Portal Activation', () => {
  const config = loadConfig();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  // =========================================================================
  // 1. Ray Intersection & Triangulation Math
  // =========================================================================
  describe('1. Eye of Ender Triangulation Math', () => {
    it('accurately converts Minecraft yaw degrees into directional vectors', () => {
      // 0 deg = South (+Z)
      const vSouth = yawToDirectionVector(0);
      expect(vSouth.dx).toBeCloseTo(0, 4);
      expect(vSouth.dz).toBeCloseTo(1, 4);

      // 90 deg = West (-X)
      const vWest = yawToDirectionVector(90);
      expect(vWest.dx).toBeCloseTo(-1, 4);
      expect(vWest.dz).toBeCloseTo(0, 4);

      // 180 deg = North (-Z)
      const vNorth = yawToDirectionVector(180);
      expect(vNorth.dx).toBeCloseTo(0, 4);
      expect(vNorth.dz).toBeCloseTo(-1, 4);

      // 270 deg = East (+X)
      const vEast = yawToDirectionVector(270);
      expect(vEast.dx).toBeCloseTo(1, 4);
      expect(vEast.dz).toBeCloseTo(0, 4);
    });

    it('triangulates exact Stronghold coordinates from two intersecting throws', () => {
      // Stronghold target is at (1000, 1000)
      // Throw 1: from (0, 0), bearing points northeast towards (1000, 1000) -> dx=1, dz=1 -> yaw = 315 deg
      // Throw 2: from (1000, 0), bearing points directly South towards (1000, 1000) -> dx=0, dz=1 -> yaw = 0 deg
      const throw1 = { playerPos: { x: 0, z: 0 }, yawDegrees: 315 };
      const throw2 = { playerPos: { x: 1000, z: 0 }, yawDegrees: 0 };

      const stronghold = triangulateStronghold(throw1, throw2);
      expect(stronghold).toBeDefined();
      expect(stronghold?.x).toBeCloseTo(1000, 0);
      expect(stronghold?.z).toBeCloseTo(1000, 0);
    });

    it('returns null when two throws are collinear or parallel', () => {
      const throw1 = { playerPos: { x: 0, z: 0 }, yawDegrees: 0 };
      const throw2 = { playerPos: { x: 0, z: 100 }, yawDegrees: 0 }; // Same heading

      const res = triangulateStronghold(throw1, throw2);
      expect(res).toBeNull();
    });
  });

  // =========================================================================
  // 2. Stronghold Structure & Portal Frame Recognition
  // =========================================================================
  describe('2. Stronghold & Portal Room Recognition', () => {
    it('recognizes authentic Stronghold architectural blocks', () => {
      expect(isStrongholdBlock('stone_bricks')).toBe(true);
      expect(isStrongholdBlock('mossy_stone_bricks')).toBe(true);
      expect(isStrongholdBlock('cracked_stone_bricks')).toBe(true);
      expect(isStrongholdBlock('iron_bars')).toBe(true);
      expect(isStrongholdBlock('end_portal_frame')).toBe(true);
      expect(isStrongholdBlock('dirt')).toBe(false);
      expect(isStrongholdBlock('oak_planks')).toBe(false);
    });

    it('identifies portal frame eye status accurately', () => {
      const emptyFrame = { name: 'end_portal_frame', _properties: { eye: false } };
      expect(isFrameFilled(emptyFrame)).toBe(false);

      const filledFrame = { name: 'end_portal_frame', _properties: { eye: true } };
      expect(isFrameFilled(filledFrame)).toBe(true);
    });
  });

  // =========================================================================
  // 3. Silverfish Spawner Neutralization & Portal Activation
  // =========================================================================
  describe('3. Spawner Neutralization & End Portal Activation', () => {
    it('neutralizes silverfish spawner using pickaxe', async () => {
      const digSpy = vi.fn().mockResolvedValue(undefined);
      const equipSpy = vi.fn().mockResolvedValue(undefined);

      const mockBot: any = {
        inventory: {
          items: () => [{ name: 'diamond_pickaxe', count: 1 }],
        },
        equip: equipSpy,
        dig: digSpy,
      };

      const neutralized = await neutralizeSilverfishSpawner(mockBot, { name: 'spawner' });
      expect(neutralized).toBe(true);
      expect(digSpy).toHaveBeenCalled();
    });

    it('fails portal activation if inventory has insufficient Eyes of Ender', async () => {
      const mockFrames = [
        { name: 'end_portal_frame', position: new Vec3(1, 0, 0), _properties: { eye: false } },
        { name: 'end_portal_frame', position: new Vec3(2, 0, 0), _properties: { eye: false } },
      ];

      const mockBot: any = {
        findBlocks: vi.fn().mockReturnValue(mockFrames.map((f) => f.position)),
        blockAt: vi.fn().mockImplementation((pos: Vec3) => mockFrames.find((f) => f.position.equals(pos))),
        inventory: {
          items: () => [{ name: 'ender_eye', count: 1 }], // Needs 2, only has 1
        },
      };

      const ctx: any = { config, logger, isCurrent: () => true };
      const res = await activateEndPortal(mockBot, new Vec3(0, 0, 0), ctx);

      expect(res.status).toBe('failed');
      expect(res.reason).toContain('Insufficient Eyes of Ender');
    });

    it('inserts missing Eyes of Ender into empty frames and activates portal', async () => {
      const mockFrames = [
        { name: 'end_portal_frame', position: new Vec3(1, 0, 0), _properties: { eye: true } }, // Already filled
        { name: 'end_portal_frame', position: new Vec3(2, 0, 0), _properties: { eye: false } }, // Needs eye
      ];

      const activateSpy = vi.fn().mockResolvedValue(undefined);
      const equipSpy = vi.fn().mockResolvedValue(undefined);

      const mockBot: any = {
        findBlocks: vi.fn().mockReturnValue(mockFrames.map((f) => f.position)),
        blockAt: vi.fn().mockImplementation((pos: Vec3) => mockFrames.find((f) => f.position.equals(pos))),
        findBlock: vi.fn().mockReturnValue({ name: 'end_portal', position: new Vec3(0, 0, 0) }),
        inventory: {
          items: () => [{ name: 'ender_eye', count: 4 }],
        },
        equip: equipSpy,
        activateBlock: activateSpy,
        lookAt: vi.fn().mockResolvedValue(undefined),
      };

      const ctx: any = { config, logger, isCurrent: () => true };
      const res = await activateEndPortal(mockBot, new Vec3(0, 0, 0), ctx);

      expect(res.status).toBe('success');
      expect(res.details?.filled).toBe(1);
      expect(activateSpy).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 4. DAG Planning for Eye of Ender
  // =========================================================================
  describe('4. DAG Planning for Eye of Ender', () => {
    const compiler = new DynamicDAGCompiler(defaultOperatorRegistry);

    it('generates a complete plan for Eye of Ender requiring pearl hunting and blaze powder', () => {
      const plan = compiler.compilePlan('goal_ender_eye', 'ender_eye', 1, {});
      expect(plan).toBeDefined();
      const taskIds = plan?.tasks.map((t) => t.id) || [];
      expect(taskIds.some((id) => id.includes('op_craft_eye_of_ender'))).toBe(true);
      expect(taskIds.some((id) => id.includes('op_hunt_enderman'))).toBe(true);
      expect(taskIds.some((id) => id.includes('op_craft_blaze_powder'))).toBe(true);
      expect(taskIds.some((id) => id.includes('op_farm_blaze_rods'))).toBe(true);
    });
  });
});
