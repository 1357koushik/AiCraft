import { describe, it, expect, vi } from 'vitest';
import { Vec3 } from 'vec3';
import { ReflexLayer } from '../src/agent/reflex.js';
import { loadConfig } from '../src/config/index.js';

describe('Auto Attack Mod & Reflex Layer', () => {
  const config = loadConfig();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  it('is disabled by default adhering to opt-in safety', () => {
    const reflex = new ReflexLayer(config, logger);
    expect(reflex.isAutoAttackEnabled()).toBe(false);
  });

  it('triggers auto-attack against nearby hostile mobs when enabled', async () => {
    const reflex = new ReflexLayer(config, logger);
    reflex.setAutoAttackEnabled(true);

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
          isValid: true,
          health: 20,
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
    reflex.setAutoAttackEnabled(true);

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

  it('retaliates against an identified hostile attacker, but ignores owner attacks', async () => {
    const reflex = new ReflexLayer(config, logger);
    reflex.setAutoAttackEnabled(true);

    const mockBot: any = {
      entity: { position: new Vec3(0, 64, 0), height: 1.6 },
      inventory: { items: () => [] },
      attack: vi.fn(),
      lookAt: vi.fn().mockResolvedValue(undefined),
    };

    const hostileAttacker = { name: 'skeleton', type: 'hostile', position: new Vec3(2, 64, 0), height: 1.8, isValid: true, health: 20 };
    const res1 = await reflex.autoDefendAttacker(mockBot, hostileAttacker);
    expect(res1).toBe(true);
    expect(mockBot.attack).toHaveBeenCalledWith(hostileAttacker);

    // If attacker is owner, retaliation must be strictly refused
    const ownerAttacker = { username: 'OwnerPlayer', name: 'OwnerPlayer', type: 'player', position: new Vec3(1, 64, 0) };
    const res2 = await reflex.autoDefendAttacker(mockBot, ownerAttacker);
    expect(res2).toBe(false);

    // If no attacker (environmental damage), returns false
    const res3 = await reflex.autoDefendAttacker(mockBot, null);
    expect(res3).toBe(false);
  });

  it('refuses retaliation against a dead or invalid attacker', async () => {
    const reflex = new ReflexLayer(config, logger);
    reflex.setAutoAttackEnabled(true);

    const mockBot: any = {
      entity: { position: new Vec3(0, 64, 0), height: 1.6 },
      inventory: { items: () => [] },
      attack: vi.fn(),
    };

    const deadAttacker = { name: 'zombie', type: 'hostile', position: new Vec3(2, 64, 0), isValid: true, health: 0 };
    expect(await reflex.autoDefendAttacker(mockBot, deadAttacker)).toBe(false);

    const invalidAttacker = { name: 'zombie', type: 'hostile', position: new Vec3(2, 64, 0), isValid: false, health: 20 };
    expect(await reflex.autoDefendAttacker(mockBot, invalidAttacker)).toBe(false);
    expect(mockBot.attack).not.toHaveBeenCalled();
  });

  it('prevents overlapping eating requests when eating is already in progress', async () => {
    const reflex = new ReflexLayer(config, logger);
    (reflex as any).isEating = true; // eating is in progress

    const mockBot: any = {
      entity: { position: new Vec3(0, 64, 0) },
      inventory: { items: () => [{ name: 'bread', count: 3 }] },
    };

    const mockObs: any = {
      vitals: { isAlive: true, underwater: false, oxygen: 20, health: 20, food: 6, movementState: {} },
      inventory: { foodList: [{ name: 'bread', count: 3 }] },
      entities: [],
    };

    const res = await reflex.evaluateReflexes(mockBot, mockObs);
    expect(res.triggered).toBe(false); // suppressed because already eating
  });

  it('interrupts eating and swims up when drowning emergency occurs', async () => {
    const reflex = new ReflexLayer(config, logger);
    (reflex as any).isEating = true;

    const mockBot: any = {
      entity: { position: new Vec3(0, 64, 0) },
      setControlState: vi.fn(),
      deactivateItem: vi.fn(),
    };

    const mockObs: any = {
      vitals: { isAlive: true, underwater: true, oxygen: 5, health: 18, food: 6, movementState: {} },
      inventory: { foodList: [] },
      entities: [],
    };

    const res = await reflex.evaluateReflexes(mockBot, mockObs);
    expect(res.triggered).toBe(true);
    expect(res.name).toBe('swim_up_low_oxygen');
    expect(mockBot.deactivateItem).toHaveBeenCalled();
    expect(reflex.getIsEating()).toBe(false);
  });

  it('scans for and escapes towards safe non-lava ground during lava hazard', async () => {
    const reflex = new ReflexLayer(config, logger);

    const mockBot: any = {
      entity: { position: new Vec3(0, 64, 0) },
      blockAt: vi.fn().mockImplementation((pos: Vec3) => {
        // Safe ground on east bank at x = 1, y = 63 with air at feet (64) and head (65)
        if (pos.x === 1 && pos.y === 63 && pos.z === 0) return { name: 'stone', boundingBox: 'block' };
        if (pos.x === 1 && pos.y >= 64 && pos.z === 0) return { name: 'air', boundingBox: 'empty' };
        // Current position is lava
        return { name: 'lava', boundingBox: 'empty' };
      }),
      lookAt: vi.fn().mockResolvedValue(undefined),
      setControlState: vi.fn(),
      clearControlStates: vi.fn(),
    };

    const mockObs: any = {
      vitals: { isAlive: true, underwater: false, oxygen: 20, health: 15, food: 20, movementState: { inLava: true } },
      inventory: { foodList: [] },
      entities: [],
    };

    const res = await reflex.evaluateReflexes(mockBot, mockObs);
    expect(res.triggered).toBe(true);
    expect(res.name).toBe('flee_lava_hazard');
    expect(res.result?.reason).toContain('safe ground');
    expect(mockBot.setControlState).toHaveBeenCalledWith('jump', true);
    expect(mockBot.clearControlStates).toHaveBeenCalled();
  });

  it('detects underwater ceiling obstruction and searches for horizontal air exit', async () => {
    const reflex = new ReflexLayer(config, logger);
    const mockBot: any = {
      entity: { position: new Vec3(0, 50, 0) },
      blockAt: vi.fn().mockImplementation((pos: Vec3) => {
        // Ceiling directly above feet at y = 52 is solid ice
        if (pos.x === 0 && pos.y === 52 && pos.z === 0) return { name: 'ice', boundingBox: 'block' };
        // Air pocket at (2, 52, 0)
        if (pos.x === 2 && pos.y === 52 && pos.z === 0) return { name: 'air', boundingBox: 'empty' };
        if (pos.x === 2 && pos.y === 51 && pos.z === 0) return { name: 'water', boundingBox: 'empty' };
        return { name: 'water', boundingBox: 'empty' };
      }),
      lookAt: vi.fn().mockResolvedValue(undefined),
      setControlState: vi.fn(),
      clearControlStates: vi.fn(),
    };

    const mockObs: any = {
      vitals: { isAlive: true, underwater: true, oxygen: 4, health: 18, food: 20, movementState: {} },
      inventory: { foodList: [] },
      entities: [],
    };

    const res = await reflex.evaluateReflexes(mockBot, mockObs);
    expect(res.triggered).toBe(true);
    expect(res.name).toBe('swim_up_low_oxygen');
    expect(res.result?.reason).toContain('Navigated toward air pocket away from underwater ceiling obstruction');
    expect(mockBot.lookAt).toHaveBeenCalledWith(expect.any(Vec3), true);
  });

  it('tracks active combat target id and allows clearing it', () => {
    const reflex = new ReflexLayer(config, logger);
    expect(reflex.getCurrentCombatTargetId()).toBeNull();
    (reflex as any).currentCombatTargetId = 42;
    expect(reflex.getCurrentCombatTargetId()).toBe(42);
    reflex.clearCombatTarget();
    expect(reflex.getCurrentCombatTargetId()).toBeNull();
  });

  it('rejects one-block air cavities or water-filled spaces when head cannot breathe', async () => {
    const reflex = new ReflexLayer(config, logger);
    const mockBot: any = {
      entity: { position: new Vec3(0, 50, 0) },
      blockAt: vi.fn().mockImplementation((pos: Vec3) => {
        // Ceiling directly above feet at y = 52 is solid ice
        if (pos.x === 0 && pos.y === 52 && pos.z === 0) return { name: 'ice', boundingBox: 'block' };
        // Cavity at (2, 50, 0) has air at feet, but head at (2, 51, 0) is solid stone!
        if (pos.x === 2 && pos.y === 50 && pos.z === 0) return { name: 'air', boundingBox: 'empty' };
        if (pos.x === 2 && pos.y === 51 && pos.z === 0) return { name: 'stone', boundingBox: 'block' };
        return { name: 'water', boundingBox: 'empty' };
      }),
      setControlState: vi.fn(),
      clearControlStates: vi.fn(),
    };

    const mockObs: any = {
      vitals: { isAlive: true, underwater: true, oxygen: 4, health: 18, food: 20, movementState: {} },
      inventory: { foodList: [] },
      entities: [],
    };

    const res = await reflex.evaluateReflexes(mockBot, mockObs);
    expect(res.triggered).toBe(true);
    expect(res.result?.status).toBe('failed');
    expect(res.result?.reason).toContain('No reachable air pocket found');
  });

  it('rejects air targets blocked by intermediate solid cave walls', async () => {
    const reflex = new ReflexLayer(config, logger);
    const mockBot: any = {
      entity: { position: new Vec3(0, 50, 0) },
      blockAt: vi.fn().mockImplementation((pos: Vec3) => {
        // Ceiling at (0, 52, 0) is solid stone
        if (pos.x === 0 && pos.y === 52 && pos.z === 0) return { name: 'stone', boundingBox: 'block' };
        // Genuine 2-block air pocket at (3, 50, 0)
        if (pos.x === 3 && pos.y === 50 && pos.z === 0) return { name: 'air', boundingBox: 'empty' };
        if (pos.x === 3 && pos.y === 51 && pos.z === 0) return { name: 'air', boundingBox: 'empty' };
        // Intermediate wall at x = 1 is solid stone across all z!
        if (pos.x === 1 && (pos.y >= 50 && pos.y <= 52)) return { name: 'stone', boundingBox: 'block' };
        return { name: 'water', boundingBox: 'empty' };
      }),
      setControlState: vi.fn(),
      clearControlStates: vi.fn(),
    };

    const mockObs: any = {
      vitals: { isAlive: true, underwater: true, oxygen: 4, health: 18, food: 20, movementState: {} },
      inventory: { foodList: [] },
      entities: [],
    };

    const res = await reflex.evaluateReflexes(mockBot, mockObs);
    expect(res.triggered).toBe(true);
    expect(res.result?.status).toBe('failed');
    expect(res.result?.reason).toContain('paths blocked');
  });

  it('rejects unloaded chunks during air search', async () => {
    const reflex = new ReflexLayer(config, logger);
    const mockBot: any = {
      entity: { position: new Vec3(0, 50, 0) },
      blockAt: vi.fn().mockImplementation((pos: Vec3) => {
        if (pos.x === 0 && pos.y === 52 && pos.z === 0) return { name: 'stone', boundingBox: 'block' };
        // Unloaded chunk returns null
        return null;
      }),
      setControlState: vi.fn(),
      clearControlStates: vi.fn(),
    };

    const mockObs: any = {
      vitals: { isAlive: true, underwater: true, oxygen: 4, health: 18, food: 20, movementState: {} },
      inventory: { foodList: [] },
      entities: [],
    };

    const res = await reflex.evaluateReflexes(mockBot, mockObs);
    expect(res.triggered).toBe(true);
    expect(res.result?.status).toBe('failed');
  });

  it('handles completely enclosed lava hazard with ceiling without blindly moving forward', async () => {
    const reflex = new ReflexLayer(config, logger);
    const mockBot: any = {
      entity: { position: new Vec3(0, 64, 0) },
      blockAt: vi.fn().mockImplementation((pos: Vec3) => {
        // Ceiling at y = 66 is netherrack
        if (pos.y >= 66) return { name: 'netherrack', boundingBox: 'block' };
        // Surrounding blocks are solid walls or lava
        if (pos.x !== 0 || pos.z !== 0) return { name: 'netherrack', boundingBox: 'block' };
        return { name: 'lava', boundingBox: 'empty' };
      }),
      setControlState: vi.fn(),
      clearControlStates: vi.fn(),
    };

    const mockObs: any = {
      vitals: { isAlive: true, underwater: false, oxygen: 20, health: 12, food: 20, movementState: { inLava: true } },
      inventory: { foodList: [] },
      entities: [],
    };

    const res = await reflex.evaluateReflexes(mockBot, mockObs);
    expect(res.triggered).toBe(true);
    expect(res.name).toBe('flee_lava_hazard');
    expect(res.result?.status).toBe('failed');
    expect(res.result?.reason).toContain('Enclosed in lava hazard');
    // Does NOT push forward into netherrack wall blindly
    expect(mockBot.setControlState).not.toHaveBeenCalledWith('forward', true);
  });

  it('rejects lava escape ground candidates when intermediate route has lava or solid wall', async () => {
    const reflex = new ReflexLayer(config, logger);
    const mockBot: any = {
      entity: { position: new Vec3(0, 64, 0) },
      blockAt: vi.fn().mockImplementation((pos: Vec3) => {
        // Ground at radius 2 (2, 63, 0) is stone, feet & head (2, 64-65, 0) are air
        if (pos.x === 2 && pos.y === 63 && pos.z === 0) return { name: 'stone', boundingBox: 'block' };
        if (pos.x === 2 && pos.y >= 64 && pos.z === 0) return { name: 'air', boundingBox: 'empty' };
        // Intermediate block at radius 1 (1, 64, 0) has a solid cobblestone wall!
        if (pos.x === 1 && pos.y === 64 && pos.z === 0) return { name: 'cobblestone', boundingBox: 'block' };
        return { name: 'lava', boundingBox: 'empty' };
      }),
      setControlState: vi.fn(),
      clearControlStates: vi.fn(),
    };

    const mockObs: any = {
      vitals: { isAlive: true, underwater: false, oxygen: 20, health: 12, food: 20, movementState: { inLava: true } },
      inventory: { foodList: [] },
      entities: [],
    };

    const res = await reflex.evaluateReflexes(mockBot, mockObs);
    expect(res.triggered).toBe(true);
    // Route at x=2 was rejected due to intermediate wall at x=1
    expect(res.result?.status).toBe('failed');
  });

  it('navigates around an intermediate obstacle wall using 3D BFS when a side opening exists', async () => {
    const reflex = new ReflexLayer(config, logger);
    const mockBot: any = {
      entity: { position: new Vec3(0, 50, 0) },
      blockAt: vi.fn().mockImplementation((pos: Vec3) => {
        // Ceiling at (0, 52, 0) is solid stone
        if (pos.x === 0 && pos.y === 52 && pos.z === 0) return { name: 'stone', boundingBox: 'block' };
        // Air pocket destination at (2, 50, 0)
        if (pos.x === 2 && pos.y === 50 && pos.z === 0) return { name: 'water', boundingBox: 'empty' };
        if (pos.x === 2 && pos.y === 51 && pos.z === 0) return { name: 'air', boundingBox: 'empty' };
        // Obstacle wall at x = 1, z = 0
        if (pos.x === 1 && (pos.y === 50 || pos.y === 51) && pos.z === 0) return { name: 'stone', boundingBox: 'block' };
        // Opening / corridor around the wall at z = 1
        return { name: 'water', boundingBox: 'empty' };
      }),
      lookAt: vi.fn().mockResolvedValue(undefined),
      setControlState: vi.fn(),
      clearControlStates: vi.fn(),
    };

    const mockObs: any = {
      vitals: { isAlive: true, underwater: true, oxygen: 4, health: 18, food: 20, movementState: {} },
      inventory: { foodList: [] },
      entities: [],
    };

    const res = await reflex.evaluateReflexes(mockBot, mockObs);
    expect(res.triggered).toBe(true);
    expect(res.result?.status).toBe('success');
    expect(res.result?.reason).toContain('via 3D BFS');
    expect(mockBot.lookAt).toHaveBeenCalled();
  });

  it('dynamically halts and fails if route to air pocket is obstructed during swim', async () => {
    const reflex = new ReflexLayer(config, logger);
    let stepCount = 0;
    const mockBot: any = {
      entity: { position: new Vec3(0, 50, 0) },
      blockAt: vi.fn().mockImplementation((pos: Vec3) => {
        if (pos.x === 0 && pos.y === 52 && pos.z === 0) return { name: 'stone', boundingBox: 'block' };
        if (pos.x === 2 && pos.y === 50 && pos.z === 0) return { name: 'water', boundingBox: 'empty' };
        if (pos.x === 2 && pos.y === 51 && pos.z === 0) return { name: 'air', boundingBox: 'empty' };
        // Dynamic obstruction appears during navigation (after initial BFS search)
        stepCount++;
        if (stepCount > 30 && pos.x === 1 && pos.y === 50 && pos.z === 0) {
          return { name: 'falling_gravel', boundingBox: 'block' };
        }
        return { name: 'water', boundingBox: 'empty' };
      }),
      lookAt: vi.fn().mockResolvedValue(undefined),
      setControlState: vi.fn(),
      clearControlStates: vi.fn(),
    };

    const mockObs: any = {
      vitals: { isAlive: true, underwater: true, oxygen: 4, health: 18, food: 20, movementState: {} },
      inventory: { foodList: [] },
      entities: [],
    };

    const res = await reflex.evaluateReflexes(mockBot, mockObs);
    expect(res.triggered).toBe(true);
    expect(res.result?.status).toBe('failed');
    expect(res.result?.reason).toContain('obstructed dynamically');
  });

  it('fails safely when air pocket is completely enclosed with no passable path', async () => {
    const reflex = new ReflexLayer(config, logger);
    const mockBot: any = {
      entity: { position: new Vec3(0, 50, 0) },
      blockAt: vi.fn().mockImplementation((pos: Vec3) => {
        // Enclosed in a 1x1x2 stone cage
        if (pos.x === 0 && (pos.y === 50 || pos.y === 51) && pos.z === 0) return { name: 'water', boundingBox: 'empty' };
        return { name: 'obsidian', boundingBox: 'block' };
      }),
      setControlState: vi.fn(),
      clearControlStates: vi.fn(),
    };

    const mockObs: any = {
      vitals: { isAlive: true, underwater: true, oxygen: 4, health: 18, food: 20, movementState: {} },
      inventory: { foodList: [] },
      entities: [],
    };

    const res = await reflex.evaluateReflexes(mockBot, mockObs);
    expect(res.triggered).toBe(true);
    expect(res.result?.status).toBe('failed');
    expect(res.result?.reason).toContain('paths blocked');
  });
});
