import { describe, it, expect, vi } from 'vitest';
import { Vec3 } from 'vec3';
import {
  computeEndermanCanopy,
  buildEndermanCanopy,
  provokeEndermanEyeContact,
  countEnderPearls,
  techniqueHuntEnderman,
} from '../src/actions/combat/enderman_tactics.js';
import {
  isWearingGoldArmor,
  ensureGoldArmorEquipped,
  techniqueBarterWithPiglins,
  findNearbyPiglin,
} from '../src/dimensions/nether/piglin_barter.js';
import { DynamicDAGCompiler } from '../src/agent/planner/dag.js';
import { defaultOperatorRegistry } from '../src/agent/planner/operator.js';
import { parseAndValidateGoalSpec } from '../src/agent/goals.js';
import { loadConfig } from '../src/config/index.js';

describe('Phase 10: Ender Pearl Acquisition (Enderman Hunting & Bartering)', () => {
  const config = loadConfig();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  // =========================================================================
  // 1. 2-High Enderman Combat Shelter
  // =========================================================================
  describe('1. 2-High Enderman Combat Canopy Shelter', () => {
    it('computes 3x3 canopy platform at height y+2 with exact 2.0 block clearance', () => {
      const groundPos = new Vec3(50, 60, 50);
      const canopy = computeEndermanCanopy(groundPos);

      expect(canopy.interiorClearance).toBe(2.0);
      expect(canopy.canopyBlocks.length).toBe(9); // 3x3

      // All canopy blocks must be at y = 62 (groundY + 2)
      for (const b of canopy.canopyBlocks) {
        expect(b.y).toBe(62);
      }

      // Center block must be at (50, 62, 50)
      expect(canopy.canopyBlocks.some((b) => b.equals(new Vec3(50, 62, 50)))).toBe(true);
    });

    it('builds canopy platform using solid blocks in inventory', async () => {
      const placeSpy = vi.fn().mockResolvedValue(undefined);
      const equipSpy = vi.fn().mockResolvedValue(undefined);

      const mockBot: any = {
        inventory: {
          items: () => [{ name: 'cobblestone', count: 64 }],
        },
        equip: equipSpy,
        placeBlock: placeSpy,
        blockAt: vi.fn().mockReturnValue(null),
      };

      const built = await buildEndermanCanopy(mockBot, new Vec3(0, 60, 0));
      expect(built).toBe(true);
      expect(equipSpy).toHaveBeenCalledWith(expect.objectContaining({ name: 'cobblestone' }), 'hand');
      expect(placeSpy).toHaveBeenCalled();
    });

    it('provokes Enderman by staring into eye coordinates at height ~2.7', async () => {
      const lookAtSpy = vi.fn().mockResolvedValue(undefined);
      const mockEnderman = {
        position: new Vec3(10, 60, 10),
        height: 2.9,
      };

      const mockBot: any = {
        lookAt: lookAtSpy,
      };

      const provoked = await provokeEndermanEyeContact(mockBot, mockEnderman);
      expect(provoked).toBe(true);
      expect(lookAtSpy).toHaveBeenCalledWith(
        expect.objectContaining({ y: expect.closeTo(62.61, 0.1) }),
        true
      );
    });
  });

  // =========================================================================
  // 2. Piglin Gold Bartering Pipeline
  // =========================================================================
  describe('2. Piglin Gold Bartering', () => {
    it('detects when gold armor is equipped', () => {
      const botNoGold: any = {
        inventory: { slots: { 5: null, 6: null, 7: null, 8: null } },
      };
      expect(isWearingGoldArmor(botNoGold)).toBe(false);

      const botWithGoldBoots: any = {
        inventory: { slots: { 8: { name: 'golden_boots' } } },
      };
      expect(isWearingGoldArmor(botWithGoldBoots)).toBe(true);
    });

    it('auto-equips gold armor piece from inventory to appease Piglins', async () => {
      const equipSpy = vi.fn().mockImplementation(async (item, slot) => {
        mockBot.inventory.slots[8] = item;
      });

      const mockBot: any = {
        inventory: {
          slots: { 8: null },
          items: () => [{ name: 'golden_boots', type: 70 }],
        },
        equip: equipSpy,
      };

      const equipped = await ensureGoldArmorEquipped(mockBot);
      expect(equipped).toBe(true);
      expect(equipSpy).toHaveBeenCalledWith(expect.objectContaining({ name: 'golden_boots' }), 'feet');
    });

    it('tosses gold ingots to adult Piglin and vacuums drops', async () => {
      const tossSpy = vi.fn().mockResolvedValue(undefined);
      const lookAtSpy = vi.fn().mockResolvedValue(undefined);

      const mockPiglin = {
        name: 'piglin',
        position: new Vec3(3, 60, 0),
        isValid: true,
      };

      const mockBot: any = {
        entity: { position: new Vec3(0, 60, 0) },
        entities: { 1: mockPiglin },
        inventory: {
          slots: { 8: { name: 'golden_boots' } },
          items: () => [{ name: 'gold_ingot', count: 4, type: 80 }],
        },
        lookAt: lookAtSpy,
        toss: tossSpy,
      };

      const ctx: any = { config, logger, isCurrent: () => true };
      const res = await techniqueBarterWithPiglins(mockBot, 2, ctx);

      expect(res.status).toBe('success');
      expect(tossSpy).toHaveBeenCalled();
      expect(res.details?.tradedGold).toBe(2);
    });
  });

  // =========================================================================
  // 3. Enderman Hunting Routine
  // =========================================================================
  describe('3. Enderman Hunting Routine', () => {
    it('accurately counts ender pearls in inventory', () => {
      const mockBot: any = {
        inventory: {
          items: () => [
            { name: 'ender_pearl', count: 12 },
            { name: 'blaze_rod', count: 7 },
            { name: 'ender_pearl', count: 2 },
          ],
        },
      };

      expect(countEnderPearls(mockBot)).toBe(14);
    });

    it('hunts Endermen under 2-high shelter until target pearl quota is satisfied', async () => {
      let currentPearls = 10;
      const mockEnderman: any = {
        name: 'enderman',
        position: new Vec3(5, 60, 0),
        height: 2.9,
        health: 40,
        isValid: true,
      };

      const mockBot: any = {
        entity: { position: new Vec3(0, 60, 0) },
        heldItem: { name: 'diamond_sword' },
        entities: { 1: mockEnderman },
        inventory: {
          items: vi.fn().mockImplementation(() => [
            { name: 'diamond_sword' },
            { name: 'cobblestone', count: 64 },
            { name: 'ender_pearl', count: currentPearls },
          ]),
        },
        lookAt: vi.fn().mockResolvedValue(undefined),
        blockAt: vi.fn().mockReturnValue(null),
        placeBlock: vi.fn().mockResolvedValue(undefined),
        attack: vi.fn().mockImplementation(() => {
          mockEnderman.health = 0;
          mockEnderman.isValid = false;
          currentPearls = 14; // Acquired required quota
        }),
      };

      const ctx: any = { config, logger, isCurrent: () => true };
      const res = await techniqueHuntEnderman(mockBot, 14, ctx);

      expect(res.status).toBe('success');
      expect(mockBot.attack).toHaveBeenCalled();
      expect(res.details?.totalPearls).toBeGreaterThanOrEqual(14);
    });
  });

  // =========================================================================
  // 4. Goal Parsing and DAG Planning for Ender Pearls
  // =========================================================================
  describe('4. Goal Parsing & DAG Planning for Ender Pearls', () => {
    it('correctly parses goal spec for 14 ender pearls', () => {
      const spec = parseAndValidateGoalSpec('have 14 ender pearls');
      expect(spec).toBeDefined();
      expect(spec?.kind).toBe('have');
      expect(spec?.item).toBe('ender_pearl');
      expect(spec?.count).toBe(14);
    });

    it('compiles DAG task plan to hunt Endermen for ender pearls', () => {
      const compiler = new DynamicDAGCompiler(defaultOperatorRegistry);
      const plan = compiler.compilePlan('goal_ender_pearls', 'ender_pearl', 14, {});

      expect(plan).toBeDefined();
      const taskIds = plan?.tasks.map((t) => t.id) || [];
      expect(taskIds.some((id) => id.includes('op_hunt_enderman'))).toBe(true);
    });
  });
});
