import { describe, it, expect, vi } from 'vitest';
import { Vec3 } from 'vec3';
import {
  findRemainingEndCrystals,
  techniqueDestroyCrystalWithBow,
  techniqueClimbAndDestroyCagedCrystal,
} from '../src/dimensions/the_end/end_crystal_destroyer.js';
import {
  findEnderDragon,
  detectDragonBreathHazard,
  isDragonPerched,
  evadeDragonBreath,
  techniqueExecuteDragonPerchMelee,
  FOUNTAIN_CENTER,
} from '../src/dimensions/the_end/dragon_combat_controller.js';
import {
  findExitPortal,
  techniqueEnterExitPortal,
  CENTRAL_EXIT_PORTAL,
} from '../src/dimensions/the_end/exit_portal_navigator.js';
import { loadConfig } from '../src/config/index.js';

describe('Phase 12: Ender Dragon Combat and Safe Return', () => {
  const config = loadConfig();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  // =========================================================================
  // 1. End Crystal Targeting & Destruction
  // =========================================================================
  describe('1. End Crystal Targeting & Sniping', () => {
    it('finds all remaining active End Crystals', () => {
      const mockBot: any = {
        entities: {
          10: { name: 'end_crystal', position: new Vec3(40, 80, 0), isValid: true },
          11: { name: 'end_crystal', position: new Vec3(-40, 85, 0), isValid: true },
          12: { name: 'enderman', position: new Vec3(5, 60, 5), isValid: true },
        },
      };

      const crystals = findRemainingEndCrystals(mockBot);
      expect(crystals.length).toBe(2);
      expect(crystals.every((c) => c.name === 'end_crystal')).toBe(true);
    });

    it('snipes End Crystal with bow accounting for ballistic elevation', async () => {
      const crystalPos = new Vec3(30, 80, 0);
      const lookAtSpy = vi.fn().mockResolvedValue(undefined);
      const equipSpy = vi.fn().mockResolvedValue(undefined);
      const activateSpy = vi.fn();
      const deactivateSpy = vi.fn();

      const mockBot: any = {
        entity: { position: new Vec3(0, 65, 0) },
        inventory: {
          items: () => [
            { name: 'bow', count: 1 },
            { name: 'arrow', count: 32 },
          ],
        },
        equip: equipSpy,
        lookAt: lookAtSpy,
        activateItem: activateSpy,
        deactivateItem: deactivateSpy,
      };

      const res = await techniqueDestroyCrystalWithBow(mockBot, { position: crystalPos }, { config, logger } as any);
      expect(res.status).toBe('success');
      expect(equipSpy).toHaveBeenCalledWith(expect.objectContaining({ name: 'bow' }), 'hand');
      expect(activateSpy).toHaveBeenCalled();
      expect(deactivateSpy).toHaveBeenCalled();
      // Verifies aim elevation compensation (aims higher than crystal Y)
      const targetArg = lookAtSpy.mock.calls[0][0];
      expect(targetArg.y).toBeGreaterThan(80);
      expect(lookAtSpy.mock.calls[0][1]).toBe(true);
    });

    it('climbs caged pillar, destroys iron bars, and eliminates crystal', async () => {
      const digSpy = vi.fn().mockResolvedValue(undefined);
      const attackSpy = vi.fn();

      const mockCrystal = { name: 'end_crystal', position: new Vec3(20, 80, 0), isValid: true };
      const mockBars = { name: 'iron_bars', position: new Vec3(20, 79, 0) };

      const mockBot: any = {
        entity: { position: new Vec3(20, 65, 0), pitch: 0, yaw: 0 },
        entities: { 1: mockCrystal },
        inventory: {
          items: () => [{ name: 'dirt', count: 64 }, { name: 'diamond_sword' }],
        },
        equip: vi.fn().mockResolvedValue(undefined),
        look: vi.fn().mockResolvedValue(undefined),
        setControlState: vi.fn(),
        blockAt: vi.fn().mockReturnValue({ name: 'dirt', boundingBox: 'block' }),
        findBlock: vi.fn().mockReturnValue(mockBars),
        dig: digSpy,
        attack: attackSpy,
        lookAt: vi.fn().mockResolvedValue(undefined),
      };

      const ctx: any = { config, logger, isCurrent: () => true };
      const res = await techniqueClimbAndDestroyCagedCrystal(mockBot, new Vec3(20, 65, 0), 15, ctx);

      expect(res.status).toBe('success');
      expect(digSpy).toHaveBeenCalledWith(mockBars);
      expect(attackSpy).toHaveBeenCalledWith(mockCrystal);
    });
  });

  // =========================================================================
  // 2. Dragon Breath Evasion and Perch Detection
  // =========================================================================
  describe('2. Dragon Breath Evasion and Perch Detection', () => {
    it('detects dragon breath hazard cloud nearby and sprints away', async () => {
      const breathCloudPos = new Vec3(2, 65, 2);
      const setControlSpy = vi.fn();

      const mockBot: any = {
        entity: { position: new Vec3(0, 65, 0), yaw: 0 },
        entities: {
          10: { name: 'area_effect_cloud', position: breathCloudPos },
        },
        setControlState: setControlSpy,
      };

      const detected = detectDragonBreathHazard(mockBot, 6);
      expect(detected).toBeDefined();

      await evadeDragonBreath(mockBot, detected!);
      expect(setControlSpy).toHaveBeenCalledWith('sprint', true);
      expect(setControlSpy).toHaveBeenCalledWith('forward', true);
    });

    it('accurately identifies when dragon is in perched phase at central fountain', () => {
      // Circling high above or far away -> not perched
      const circlingDragon = { position: new Vec3(45, 95, 30) };
      expect(isDragonPerched(circlingDragon)).toBe(false);

      // Low altitude at center fountain (0, 0) -> perched!
      const perchedDragon = { position: new Vec3(2, 66, 1) };
      expect(isDragonPerched(perchedDragon)).toBe(true);
    });
  });

  // =========================================================================
  // 3. Perch Phase Melee Execution
  // =========================================================================
  describe('3. Perch Phase Melee Execution', () => {
    it('executes synchronized melee strikes on dragon during perch phase', async () => {
      let dragonAlive = true;
      let strikes = 0;

      const mockDragon: any = {
        name: 'ender_dragon',
        position: new Vec3(1, 66, 1),
        health: 200,
        isValid: true,
      };

      const mockBot: any = {
        entity: { position: new Vec3(0, 65, 0) },
        heldItem: { name: 'diamond_sword' },
        entities: { 1: mockDragon },
        inventory: { items: () => [{ name: 'diamond_sword' }] },
        lookAt: vi.fn().mockResolvedValue(undefined),
        attack: vi.fn().mockImplementation(() => {
          strikes++;
          if (strikes >= 2) {
            mockDragon.health = 0;
            mockDragon.isValid = false;
          }
        }),
      };

      const ctx: any = { config, logger, isCurrent: () => true };
      const res = await techniqueExecuteDragonPerchMelee(mockBot, mockDragon, ctx);

      expect(res.status).toBe('success');
      expect(mockBot.attack).toHaveBeenCalled();
      expect(res.details?.strikes).toBeGreaterThanOrEqual(2);
    });
  });

  // =========================================================================
  // 4. Exit Portal Navigation
  // =========================================================================
  describe('4. Exit Portal Navigation & Campaign Completion', () => {
    it('locates activated Exit Portal block at center island', () => {
      const exitPos = new Vec3(0, 65, 0);
      const mockBot: any = {
        findBlock: vi.fn().mockReturnValue({ name: 'end_portal', position: exitPos }),
      };

      const found = findExitPortal(mockBot);
      expect(found).toBeDefined();
      expect(found?.equals(exitPos)).toBe(true);
    });

    it('navigates into Exit Portal confirming campaign victory', async () => {
      const setControlSpy = vi.fn();
      const mockBot: any = {
        findBlock: vi.fn().mockReturnValue({ name: 'end_portal', position: CENTRAL_EXIT_PORTAL }),
        pathfinder: {
          goto: vi.fn().mockResolvedValue(undefined),
        },
        lookAt: vi.fn().mockResolvedValue(undefined),
        setControlState: setControlSpy,
      };

      const ctx: any = { config, logger, isCurrent: () => true };
      const res = await techniqueEnterExitPortal(mockBot, ctx);

      expect(res.status).toBe('success');
      expect(res.details?.victory).toBe(true);
      expect(setControlSpy).toHaveBeenCalledWith('forward', true);
    });
  });
});
