import { describe, it, expect, vi } from 'vitest';
import { Vec3 } from 'vec3';
import {
  techniqueBridge,
  techniquePillarUp,
  techniqueMineStaircase,
  techniqueVacuumDrops,
  techniqueChopTreeFull,
} from '../src/actions/techniques.js';

describe('Autonomous Physical Techniques & Macros', () => {
  it('executes safe sneak-bridging with crouch and verified block placement', async () => {
    const mockDirt = { name: 'dirt', count: 10 };
    let placedOnServer = false;
    const mockBot: any = {
      entity: { position: new Vec3(0, 64, 0), yaw: 0 },
      inventory: {
        items: () => [mockDirt],
      },
      blockAt: vi.fn().mockImplementation((pos: Vec3) => {
        // Current standing block is stone
        if (pos.x === 0 && pos.y === 63 && pos.z === 0) return { name: 'stone', position: pos, boundingBox: 'block' };
        // Target ground block starts as air, then becomes dirt after placement
        if (pos.x === 0 && pos.y === 63 && pos.z === 1) {
          if (!placedOnServer) return { name: 'air', position: pos, boundingBox: 'empty' };
          return { name: 'dirt', position: pos, boundingBox: 'block' };
        }
        return { name: 'stone', position: pos, boundingBox: 'block' };
      }),
      equip: vi.fn().mockResolvedValue(undefined),
      setControlState: vi.fn(),
      clearControlStates: vi.fn(),
      lookAt: vi.fn().mockResolvedValue(undefined),
      look: vi.fn().mockResolvedValue(undefined),
      placeBlock: vi.fn().mockImplementation(async () => {
        placedOnServer = true;
      }),
      deactivateItem: vi.fn(),
    };

    const res = await techniqueBridge(mockBot, 'south', 1);

    expect(mockBot.setControlState).toHaveBeenCalledWith('sneak', true);
    expect(mockBot.placeBlock).toHaveBeenCalled();
    expect(res.status).toBe('success');
  });

  it('aborts sneak-bridging and does not walk into the void if placement fails', async () => {
    const mockDirt = { name: 'dirt', count: 10 };
    const mockBot: any = {
      entity: { position: new Vec3(0, 64, 0), yaw: 0 },
      inventory: {
        items: () => [mockDirt],
      },
      blockAt: vi.fn().mockImplementation((pos: Vec3) => {
        if (pos.x === 0 && pos.y === 63 && pos.z === 0) return { name: 'stone', position: pos, boundingBox: 'block' };
        return { name: 'air', position: pos }; // never placed
      }),
      equip: vi.fn().mockResolvedValue(undefined),
      setControlState: vi.fn(),
      clearControlStates: vi.fn(),
      lookAt: vi.fn().mockResolvedValue(undefined),
      look: vi.fn().mockResolvedValue(undefined),
      placeBlock: vi.fn().mockResolvedValue(undefined),
      deactivateItem: vi.fn(),
    };

    const res = await techniqueBridge(mockBot, 'south', 1);

    expect(res.status).toBe('failed');
    expect(res.reason).toContain('Bridging halted');
    expect(mockBot.clearControlStates).toHaveBeenCalled();
  });

  it('fails bridging immediately if no scaffolding blocks are in inventory', async () => {
    const mockBot: any = {
      entity: { position: new Vec3(0, 64, 0), yaw: 0 },
      inventory: { items: () => [] },
      setControlState: vi.fn(),
      clearControlStates: vi.fn(),
    };

    const res = await techniqueBridge(mockBot, 'south', 3);
    expect(res.status).toBe('failed');
    expect(res.reason).toContain('No scaffolding blocks in inventory');
  });

  it('aborts bridging when abortSignal is triggered', async () => {
    const abortController = new AbortController();
    abortController.abort();

    const mockDirt = { name: 'dirt', count: 10 };
    const mockBot: any = {
      entity: { position: new Vec3(0, 64, 0), yaw: 0 },
      inventory: { items: () => [mockDirt] },
      setControlState: vi.fn(),
      clearControlStates: vi.fn(),
    };

    const res = await techniqueBridge(mockBot, 'south', 3, abortController.signal);
    expect(res.status).toBe('interrupted');
    expect(res.reason).toContain('cancelled by abort signal');
  });

  it('verifies pillar up aims downwards with positive pitch and restores controls', async () => {
    const mockDirt = { name: 'dirt', count: 5 };
    const mockBot: any = {
      entity: { position: new Vec3(0, 64, 0), yaw: 0 },
      inventory: { items: () => [mockDirt] },
      blockAt: vi.fn().mockReturnValue({ name: 'stone', boundingBox: 'block' }),
      equip: vi.fn().mockResolvedValue(undefined),
      look: vi.fn().mockResolvedValue(undefined),
      setControlState: vi.fn(),
      clearControlStates: vi.fn(),
      placeBlock: vi.fn().mockResolvedValue(undefined),
    };

    await techniquePillarUp(mockBot, 1);

    // Verified positive pitch down
    expect(mockBot.look).toHaveBeenCalledWith(0, Math.PI / 2, true);
    // Verified restoration to pitch 0
    expect(mockBot.look).toHaveBeenCalledWith(0, 0, true);
  });

  it('fails pillaring when block placement cannot be verified', async () => {
    const mockDirt = { name: 'dirt', count: 5 };
    const mockBot: any = {
      entity: { position: new Vec3(0, 64, 0), yaw: 0 },
      inventory: { items: () => [mockDirt] },
      blockAt: vi.fn().mockImplementation((pos: Vec3) => {
        // Ground before jumping is solid
        if (pos.y === 63) return { name: 'stone', boundingBox: 'block' };
        // The block where the bot jumped remains air (placement failed)
        return { name: 'air', boundingBox: 'empty' };
      }),
      equip: vi.fn().mockResolvedValue(undefined),
      look: vi.fn().mockResolvedValue(undefined),
      setControlState: vi.fn(),
      clearControlStates: vi.fn(),
      placeBlock: vi.fn().mockResolvedValue(undefined),
    };

    // Simulate jump elevation
    setTimeout(() => {
      mockBot.entity.position.y = 65.2;
    }, 40);

    const res = await techniquePillarUp(mockBot, 1);
    expect(res.status).toBe('failed');
    expect(res.reason).toContain('Pillaring halted');
  });

  it('halts staircase mining if lava hazard is detected ahead', async () => {
    const mockPickaxe = { name: 'iron_pickaxe' };
    const mockBot: any = {
      entity: { position: new Vec3(0, 64, 0), yaw: 0 },
      inventory: { items: () => [mockPickaxe] },
      heldItem: mockPickaxe,
      blockAt: vi.fn().mockImplementation((pos: Vec3) => {
        // Target floor is solid stone
        if (pos.x === 0 && pos.y === 62 && pos.z === 1) return { name: 'stone', boundingBox: 'block' };
        // Lava in front of bot
        if (pos.z === 1 && pos.y === 64) return { name: 'lava' };
        return { name: 'stone', boundingBox: 'block' };
      }),
      equip: vi.fn().mockResolvedValue(undefined),
      dig: vi.fn().mockResolvedValue(undefined),
      setControlState: vi.fn(),
      clearControlStates: vi.fn(),
    };

    const res = await techniqueMineStaircase(mockBot, 2);
    expect(res.status).toBe('failed');
    expect(res.reason).toContain('lava hazard');
  });

  it('halts staircase mining if unsupported drop/void is detected beneath step', async () => {
    const mockPickaxe = { name: 'iron_pickaxe' };
    const mockBot: any = {
      entity: { position: new Vec3(0, 64, 0), yaw: 0 },
      inventory: { items: () => [mockPickaxe] },
      heldItem: mockPickaxe,
      blockAt: vi.fn().mockImplementation((pos: Vec3) => {
        // Target floor is open air (drop/ravine)
        if (pos.y === 62 && pos.z === 1) return { name: 'air', boundingBox: 'empty' };
        return { name: 'stone', boundingBox: 'block' };
      }),
      equip: vi.fn().mockResolvedValue(undefined),
      dig: vi.fn().mockResolvedValue(undefined),
      setControlState: vi.fn(),
      clearControlStates: vi.fn(),
    };

    const res = await techniqueMineStaircase(mockBot, 2);
    expect(res.status).toBe('failed');
    expect(res.reason).toContain('unsupported drop');
  });

  it('halts staircase mining if block data is missing/unloaded (null)', async () => {
    const mockPickaxe = { name: 'iron_pickaxe' };
    const mockBot: any = {
      entity: { position: new Vec3(0, 64, 0), yaw: 0 },
      inventory: { items: () => [mockPickaxe] },
      heldItem: mockPickaxe,
      blockAt: vi.fn().mockImplementation((pos: Vec3) => {
        // Chunk boundary not loaded
        if (pos.y === 62 && pos.z === 1) return null;
        return { name: 'stone', boundingBox: 'block' };
      }),
      equip: vi.fn().mockResolvedValue(undefined),
      dig: vi.fn().mockResolvedValue(undefined),
      setControlState: vi.fn(),
      clearControlStates: vi.fn(),
    };

    const res = await techniqueMineStaircase(mockBot, 2);
    expect(res.status).toBe('failed');
    expect(res.reason).toContain('unloaded block data');
  });

  it('halts staircase mining if water hazard is detected', async () => {
    const mockPickaxe = { name: 'iron_pickaxe' };
    const mockBot: any = {
      entity: { position: new Vec3(0, 64, 0), yaw: 0 },
      inventory: { items: () => [mockPickaxe] },
      heldItem: mockPickaxe,
      blockAt: vi.fn().mockImplementation((pos: Vec3) => {
        // Floor is water
        if (pos.y === 62 && pos.z === 1) return { name: 'water', boundingBox: 'empty' };
        return { name: 'stone', boundingBox: 'block' };
      }),
      equip: vi.fn().mockResolvedValue(undefined),
      dig: vi.fn().mockResolvedValue(undefined),
      setControlState: vi.fn(),
      clearControlStates: vi.fn(),
    };

    const res = await techniqueMineStaircase(mockBot, 2);
    expect(res.status).toBe('failed');
    expect(res.reason).toContain('water hazard');
  });

  it('aborts staircase mining cleanly when abortSignal is triggered', async () => {
    const abortController = new AbortController();
    abortController.abort();

    const mockPickaxe = { name: 'iron_pickaxe' };
    const mockBot: any = {
      entity: { position: new Vec3(0, 64, 0), yaw: 0 },
      inventory: { items: () => [mockPickaxe] },
      clearControlStates: vi.fn(),
    };

    const res = await techniqueMineStaircase(mockBot, 3, abortController.signal);
    expect(res.status).toBe('interrupted');
    expect(res.reason).toContain('cancelled by abort signal');
  });

  it('executes safe staircase mining when preconditions and floors are verified', async () => {
    const mockPickaxe = { name: 'iron_pickaxe' };
    const mockBot: any = {
      entity: { position: new Vec3(0, 64, 0), yaw: 0 },
      inventory: {
        items: () => [mockPickaxe],
      },
      heldItem: mockPickaxe,
      blockAt: vi.fn().mockImplementation((pos: Vec3) => ({
        name: 'stone',
        position: pos,
        boundingBox: 'block',
      })),
      equip: vi.fn().mockResolvedValue(undefined),
      dig: vi.fn().mockResolvedValue(undefined),
      setControlState: vi.fn(),
      clearControlStates: vi.fn(),
    };

    const res = await techniqueMineStaircase(mockBot, 2);

    expect(mockBot.dig).toHaveBeenCalled();
    expect(res.status).toBe('success');
  });

  it('executes vacuum drops macro to gather nearby items', async () => {
    const mockBot: any = {
      entity: { position: new Vec3(0, 64, 0) },
      entities: {
        10: { id: 10, name: 'item', type: 'item', position: new Vec3(3, 64, 2) },
      },
      pathfinder: {
        movements: {},
        goto: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn(),
      },
      inventory: { items: () => [] },
      registry: { blocksByName: {} },
      clearControlStates: vi.fn(),
    };

    const res = await techniqueVacuumDrops(mockBot, 8);

    expect(mockBot.pathfinder.goto).toHaveBeenCalled();
    expect(res.status).toBe('success');
  });
});
