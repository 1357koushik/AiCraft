import { describe, it, expect, vi } from 'vitest';
import { Vec3 } from 'vec3';
import {
  getAttackCooldownMs,
  techniqueEngageCreeper,
  techniqueEngageSkeleton,
  techniqueEngageSpider,
  techniqueEngageEnderman,
  techniqueEngageZombie,
  techniqueEmergencyCombatRetreat,
  techniqueTacticalCombat,
} from '../src/actions/combat/mob_tactics.js';
import {
  isShieldEquipped,
  ensureShieldInOffHand,
  raiseShieldAgainst,
} from '../src/actions/combat/shield_manager.js';
import { loadConfig } from '../src/config/index.js';

describe('Phase 6: Combat and Hostile Mob Handling', () => {
  const config = loadConfig();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  // =========================================================================
  // 1. Attack Cooldown Synchronization
  // =========================================================================
  describe('1. Attack Cooldown Synchronization', () => {
    it('returns 625ms for swords (1.6 attacks/sec)', () => {
      expect(getAttackCooldownMs('diamond_sword')).toBe(625);
      expect(getAttackCooldownMs('iron_sword')).toBe(625);
      expect(getAttackCooldownMs('stone_sword')).toBe(625);
      expect(getAttackCooldownMs('wooden_sword')).toBe(625);
    });

    it('returns appropriate cooldowns for axes (0.8 - 1.0 attacks/sec)', () => {
      expect(getAttackCooldownMs('wooden_axe')).toBe(1250);
      expect(getAttackCooldownMs('stone_axe')).toBe(1250);
      expect(getAttackCooldownMs('iron_axe')).toBe(1111);
      expect(getAttackCooldownMs('diamond_axe')).toBe(1000);
      expect(getAttackCooldownMs('netherite_axe')).toBe(1000);
    });

    it('returns correct cooldowns for tools and hand', () => {
      expect(getAttackCooldownMs('iron_pickaxe')).toBe(833);
      expect(getAttackCooldownMs('iron_shovel')).toBe(1000);
      expect(getAttackCooldownMs(null)).toBe(250);
      expect(getAttackCooldownMs('stick')).toBe(250);
    });
  });

  // =========================================================================
  // 2. Shield Manager
  // =========================================================================
  describe('2. Shield Manager', () => {
    it('detects when shield is equipped in off-hand slot (slot 45)', () => {
      const botWithoutShield: any = {
        inventory: { slots: { 45: null } },
        supportFeature: () => true,
      };
      expect(isShieldEquipped(botWithoutShield)).toBe(false);

      const botWithShield: any = {
        inventory: { slots: { 45: { name: 'shield' } } },
        supportFeature: () => true,
      };
      expect(isShieldEquipped(botWithShield)).toBe(true);
    });

    it('equips shield from inventory into off-hand', async () => {
      const equipSpy = vi.fn().mockImplementation(async (item, slot) => {
        mockBot.inventory.slots[45] = item;
      });

      const mockBot: any = {
        inventory: {
          slots: { 45: null },
          items: () => [{ name: 'shield', type: 100 }],
        },
        equip: equipSpy,
        supportFeature: () => true,
      };

      const success = await ensureShieldInOffHand(mockBot);
      expect(success).toBe(true);
      expect(equipSpy).toHaveBeenCalledWith(expect.objectContaining({ name: 'shield' }), 'off-hand');
    });

    it('raises shield towards threat and deactivates after duration', async () => {
      const lookAtSpy = vi.fn().mockResolvedValue(undefined);
      const activateSpy = vi.fn();
      const deactivateSpy = vi.fn();

      const mockBot: any = {
        inventory: {
          slots: { 45: { name: 'shield' } },
        },
        supportFeature: () => true,
        lookAt: lookAtSpy,
        activateItem: activateSpy,
        deactivateItem: deactivateSpy,
      };

      const threat = { position: new Vec3(10, 64, 0) };
      const raised = await raiseShieldAgainst(mockBot, threat, 50);

      expect(raised).toBe(true);
      expect(lookAtSpy).toHaveBeenCalled();
      expect(activateSpy).toHaveBeenCalledWith(true);
      expect(deactivateSpy).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 3. Mob-Specific Tactics
  // =========================================================================
  describe('3. Mob-Specific Tactics', () => {
    it('executes hit-and-retreat sprint cycles against creepers', async () => {
      const mockCreeper: any = {
        name: 'creeper',
        position: new Vec3(2, 64, 0),
        health: 20,
        isValid: true,
      };

      const controlStates: Record<string, boolean> = {};

      const mockBot: any = {
        entity: { position: new Vec3(0, 64, 0) },
        heldItem: { name: 'iron_sword' },
        inventory: { items: () => [{ name: 'iron_sword' }] },
        lookAt: vi.fn().mockResolvedValue(undefined),
        attack: vi.fn().mockImplementation(() => {
          mockCreeper.health = 0;
          mockCreeper.isValid = false;
        }),
        setControlState: vi.fn().mockImplementation((state, val) => {
          controlStates[state] = val;
        }),
        clearControlStates: vi.fn(),
      };

      const ctx: any = { config, logger, isCurrent: () => true };
      const res = await techniqueEngageCreeper(mockBot, mockCreeper, ctx);

      expect(res.status).toBe('success');
      expect(mockBot.attack).toHaveBeenCalled();
      expect(mockBot.setControlState).toHaveBeenCalledWith('back', true);
      expect(mockBot.setControlState).toHaveBeenCalledWith('sprint', true);
    });

    it('raises shield against skeleton when at range and rushes during reload', async () => {
      const mockSkeleton: any = {
        name: 'skeleton',
        position: new Vec3(6, 64, 0),
        health: 20,
        isValid: true,
      };

      const activateSpy = vi.fn();
      const deactivateSpy = vi.fn();

      const mockBot: any = {
        entity: { position: new Vec3(0, 64, 0) },
        heldItem: { name: 'iron_sword' },
        inventory: {
          slots: { 45: { name: 'shield' } },
          items: () => [{ name: 'iron_sword' }, { name: 'shield' }],
        },
        supportFeature: () => true,
        lookAt: vi.fn().mockResolvedValue(undefined),
        activateItem: activateSpy,
        deactivateItem: deactivateSpy,
        attack: vi.fn().mockImplementation(() => {
          mockSkeleton.health = 0;
          mockSkeleton.isValid = false;
        }),
        pathfinder: {
          setGoal: vi.fn().mockImplementation(() => {
            mockSkeleton.position = new Vec3(1.5, 64, 0);
          }),
        },
      };

      const ctx: any = { config, logger, isCurrent: () => true };
      const res = await techniqueEngageSkeleton(mockBot, mockSkeleton, ctx);

      expect(res.status).toBe('success');
      expect(activateSpy).toHaveBeenCalledWith(true);
      expect(mockBot.attack).toHaveBeenCalled();
    });

    it('backpedals when spider is in leap range to evade jump attack', async () => {
      const mockSpider: any = {
        name: 'spider',
        position: new Vec3(3, 64, 0),
        health: 16,
        isValid: true,
      };

      const controlStates: Record<string, boolean> = {};

      const mockBot: any = {
        entity: { position: new Vec3(0, 64, 0) },
        heldItem: { name: 'iron_sword' },
        inventory: { items: () => [{ name: 'iron_sword' }] },
        lookAt: vi.fn().mockResolvedValue(undefined),
        attack: vi.fn().mockImplementation(() => {
          mockSpider.health = 0;
          mockSpider.isValid = false;
        }),
        setControlState: vi.fn().mockImplementation((state, val) => {
          controlStates[state] = val;
        }),
        clearControlStates: vi.fn(),
      };

      const ctx: any = { config, logger, isCurrent: () => true };
      const res = await techniqueEngageSpider(mockBot, mockSpider, ctx);

      expect(res.status).toBe('success');
      expect(mockBot.setControlState).toHaveBeenCalledWith('back', true);
      expect(mockBot.attack).toHaveBeenCalled();
    });

    it('pillars up 3 blocks high to attack enderman safely from above', async () => {
      const mockEnderman: any = {
        name: 'enderman',
        position: new Vec3(1, 64, 0),
        height: 2.9,
        health: 40,
        isValid: true,
      };

      const mockBot: any = {
        entity: { position: new Vec3(0, 67, 0) },
        heldItem: { name: 'iron_sword' },
        inventory: { items: () => [{ name: 'iron_sword' }, { name: 'dirt', count: 64 }] },
        blockAt: vi.fn().mockReturnValue({ name: 'dirt', boundingBox: 'block' }),
        lookAt: vi.fn().mockResolvedValue(undefined),
        attack: vi.fn().mockImplementation(() => {
          mockEnderman.health = 0;
          mockEnderman.isValid = false;
        }),
      };

      const ctx: any = { config, logger, isCurrent: () => true };
      const res = await techniqueEngageEnderman(mockBot, mockEnderman, ctx);

      expect(res.status).toBe('success');
      expect(res.reason).toContain('3-block safety pillar');
      expect(mockBot.attack).toHaveBeenCalled();
    });

    it('engages zombies with spacing and attack cooldown rhythm', async () => {
      const mockZombie: any = {
        name: 'zombie',
        position: new Vec3(2, 64, 0),
        health: 20,
        isValid: true,
      };

      const mockBot: any = {
        entity: { position: new Vec3(0, 64, 0) },
        heldItem: { name: 'iron_sword' },
        inventory: { items: () => [{ name: 'iron_sword' }] },
        lookAt: vi.fn().mockResolvedValue(undefined),
        attack: vi.fn().mockImplementation(() => {
          mockZombie.health = 0;
          mockZombie.isValid = false;
        }),
      };

      const ctx: any = { config, logger, isCurrent: () => true };
      const res = await techniqueEngageZombie(mockBot, mockZombie, ctx);

      expect(res.status).toBe('success');
      expect(mockBot.attack).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 4. Emergency Combat Retreat & Universal Dispatcher
  // =========================================================================
  describe('4. Emergency Combat Retreat & Universal Dispatcher', () => {
    it('executes emergency retreat and raises shield when health <= 8 HP', async () => {
      const activateSpy = vi.fn();
      const deactivateSpy = vi.fn();

      const mockHostile = {
        type: 'mob',
        isValid: true,
        health: 20,
        position: new Vec3(5, 64, 0),
      };

      const mockBot: any = {
        health: 6,
        entity: { position: new Vec3(0, 64, 0) },
        entities: { 1: mockHostile },
        inventory: {
          slots: { 45: { name: 'shield' } },
          items: () => [{ name: 'shield' }],
        },
        supportFeature: () => true,
        activateItem: activateSpy,
        deactivateItem: deactivateSpy,
        pathfinder: { setGoal: vi.fn() },
      };

      const ctx: any = { config, logger, isCurrent: () => true };
      const res = await techniqueEmergencyCombatRetreat(mockBot, ctx);

      expect(res.status).toBe('success');
      expect(activateSpy).toHaveBeenCalledWith(true);
      expect(res.reason).toContain('emergency combat retreat');
    });

    it('techniqueTacticalCombat automatically redirects to retreat when health is low', async () => {
      const mockZombie = {
        name: 'zombie',
        isValid: true,
        health: 20,
        position: new Vec3(3, 64, 0),
      };

      const mockBot: any = {
        health: 7, // <= 8 HP
        entity: { position: new Vec3(0, 64, 0) },
        entities: { 1: mockZombie },
        inventory: {
          slots: { 45: { name: 'shield' } },
          items: () => [{ name: 'shield' }, { name: 'iron_sword' }],
        },
        supportFeature: () => true,
        activateItem: vi.fn(),
        deactivateItem: vi.fn(),
        pathfinder: { setGoal: vi.fn() },
      };

      const ctx: any = { config, logger, isCurrent: () => true };
      const res = await techniqueTacticalCombat(mockBot, mockZombie, ctx);

      expect(res.status).toBe('success');
      expect(res.reason).toContain('emergency combat retreat');
    });
  });
});
