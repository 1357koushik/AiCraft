import { describe, it, expect, vi } from 'vitest';
import { Vec3 } from 'vec3';
import { ReflexLayer } from '../src/agent/reflex.js';
import { loadConfig } from '../src/config/index.js';

describe('Auto Attack Mod & Reflex Layer', () => {
  const config = loadConfig();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  it('triggers auto-attack against nearby hostile mobs', async () => {
    const reflex = new ReflexLayer(config, logger);

    const mockSword = { type: 267, name: 'iron_sword', count: 1 };
    const mockBot: any = {
      entity: { position: new Vec3(0, 64, 0), height: 1.6 },
      entities: {
        55: {
          id: 55,
          name: 'zombie',
          type: 'mob',
          position: new Vec3(2, 64, 0),
          height: 1.8,
        },
      },
      inventory: {
        items: () => [mockSword],
      },
      heldItem: null,
      equip: vi.fn().mockResolvedValue(undefined),
      lookAt: vi.fn().mockResolvedValue(undefined),
      attack: vi.fn(),
      setControlState: vi.fn(),
    };

    const mockObs: any = {
      vitals: { isAlive: true, underwater: false, oxygen: 20, health: 20, food: 20, movementState: {} },
      inventory: { foodList: [], toolSummary: { hasShield: false } },
      entities: [
        {
          id: 'e1',
          rawId: 55,
          name: 'zombie',
          type: 'zombie',
          isHostile: true,
          isOwner: false,
          distance: 2.0,
        },
      ],
    };

    const res = await reflex.evaluateReflexes(mockBot, mockObs);

    expect(res.triggered).toBe(true);
    expect(res.name).toBe('auto_attack_zombie');
    expect(mockBot.equip).toHaveBeenCalledWith(mockSword, 'hand');
    expect(mockBot.lookAt).toHaveBeenCalled();
    expect(mockBot.attack).toHaveBeenCalled();
  });

  it('strictly refuses to auto-attack the owner or protected entities', async () => {
    const reflex = new ReflexLayer(config, logger);

    const mockBot: any = {
      entity: { position: new Vec3(0, 64, 0) },
      entities: {
        1: { id: 1, username: 'OwnerPlayer', position: new Vec3(1, 64, 0) },
      },
      attack: vi.fn(),
    };

    const mockObs: any = {
      vitals: { isAlive: true, underwater: false, oxygen: 20, health: 20, food: 20, movementState: {} },
      inventory: { foodList: [], toolSummary: { hasShield: false } },
      entities: [
        {
          id: 'e1',
          rawId: 1,
          name: 'OwnerPlayer',
          type: 'player',
          isHostile: false,
          isOwner: true,
          distance: 1.0,
        },
      ],
    };

    const res = await reflex.evaluateReflexes(mockBot, mockObs);
    expect(res.triggered).toBe(false);
    expect(mockBot.attack).not.toHaveBeenCalled();
  });

  it('honors runtime toggle to disable auto-attack', async () => {
    const reflex = new ReflexLayer(config, logger);
    reflex.setAutoAttackEnabled(false);

    const mockBot: any = {
      entity: { position: new Vec3(0, 64, 0) },
      entities: {
        55: { id: 55, name: 'zombie', position: new Vec3(2, 64, 0) },
      },
      attack: vi.fn(),
    };

    const mockObs: any = {
      vitals: { isAlive: true, underwater: false, oxygen: 20, health: 20, food: 20, movementState: {} },
      inventory: { foodList: [], toolSummary: { hasShield: false } },
      entities: [
        { id: 'e1', rawId: 55, name: 'zombie', isHostile: true, isOwner: false, distance: 2.0 },
      ],
    };

    const res = await reflex.evaluateReflexes(mockBot, mockObs);
    expect(res.triggered).toBe(false);
    expect(mockBot.attack).not.toHaveBeenCalled();
  });
});
