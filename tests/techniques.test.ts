import { describe, it, expect, vi } from 'vitest';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import {
  updatePathfinderMovements,
  techniquePillarUp,
  techniqueBridge,
  techniqueVacuumDrops,
  techniqueMineStaircase,
  techniqueBuildShelter,
  getScaffoldingItem,
} from '../src/actions/techniques.js';

describe('Autonomous Physical Techniques & Macros', () => {
  const mcData = minecraftData('1.21.6');

  it('updates pathfinder movements with inventory scaffolding blocks and enabling 1x1 towers and digging', () => {
    const mockBot: any = {
      inventory: {
        items: () => [
          { name: 'dirt', count: 32 },
          { name: 'cobblestone', count: 64 },
          { name: 'apple', count: 5 },
        ],
      },
      registry: mcData,
      pathfinder: { movements: null, setMovements: vi.fn() },
    };

    const movements = updatePathfinderMovements(mockBot);

    expect(movements.canDig).toBe(true);
    expect(movements.allow1by1towers).toBe(true);
    expect(movements.allowParkour).toBe(true);
    expect((movements as any).scafoldingBlocks).toContain(mcData.blocksByName['dirt'].id);
    expect((movements as any).scafoldingBlocks).toContain(mcData.blocksByName['cobblestone'].id);
  });

  it('identifies scaffolding block items in inventory', () => {
    const mockBot: any = {
      inventory: {
        items: () => [
          { name: 'apple', count: 5 },
          { name: 'oak_planks', count: 16 },
        ],
      },
    };

    const scaffold = getScaffoldingItem(mockBot);
    expect(scaffold).not.toBeNull();
    expect(scaffold.name).toBe('oak_planks');
  });

  it('executes safe sneak-bridging with crouch and block placement', async () => {
    const mockDirt = { name: 'dirt', count: 10 };
    const mockBot: any = {
      entity: { position: new Vec3(0, 64, 0), yaw: 0 },
      inventory: {
        items: () => [mockDirt],
      },
      blockAt: vi.fn().mockImplementation((pos: Vec3) => {
        // Ground at 0, 63, 0 exists; open air ahead at 0, 63, 1
        if (pos.x === 0 && pos.y === 63 && pos.z === 0) return { name: 'stone', position: pos };
        return { name: 'air', position: pos };
      }),
      equip: vi.fn().mockResolvedValue(undefined),
      setControlState: vi.fn(),
      clearControlStates: vi.fn(),
      lookAt: vi.fn().mockResolvedValue(undefined),
      placeBlock: vi.fn().mockResolvedValue(undefined),
    };

    const res = await techniqueBridge(mockBot, 'south', 1);

    expect(mockBot.setControlState).toHaveBeenCalledWith('sneak', true);
    expect(mockBot.placeBlock).toHaveBeenCalled();
    expect(res.status).toBe('success');
  });

  it('executes staircase mining without digging straight down', async () => {
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
      })),
      equip: vi.fn().mockResolvedValue(undefined),
      dig: vi.fn().mockResolvedValue(undefined),
      setControlState: vi.fn(),
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
      },
      inventory: { items: () => [] },
      registry: { blocksByName: {} },
    };

    const res = await techniqueVacuumDrops(mockBot, 8);

    expect(mockBot.pathfinder.goto).toHaveBeenCalled();
    expect(res.status).toBe('success');
  });
});
