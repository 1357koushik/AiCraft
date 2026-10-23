import { describe, it, expect, vi } from 'vitest';
import { Vec3 } from 'vec3';
import {
  techniqueBridge,
  techniquePillarUp,
  techniqueMineStaircase,
  techniqueVacuumDrops,
  techniqueChopTreeFull,
  techniqueCollectResource,
  isMatchingResourceBlock,
  getExpectedResourceItemNames,
  countResourceInInventory,
  autoEquipBestToolForBlock,
  updatePathfinderMovements,
  findSafePlacementSpot,
  withWorkstation,
  techniqueCraftPipeline,
} from '../src/actions/techniques.js';
import { miningBuildingActions } from '../src/actions/mining_building.js';
import { inventoryCraftingActions } from '../src/actions/inventory_crafting.js';

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

  it('verifies pillar up aims downwards with negative pitch and restores controls', async () => {
    const mockDirt = { name: 'dirt', count: 5 };
    const mockBot: any = {
      entity: { position: new Vec3(0, 64, 0), yaw: 0 },
      inventory: { items: () => [mockDirt] },
      blockAt: vi.fn().mockImplementation((pos: Vec3) => {
        // Ground at 63 is solid; feet level at 64 is air before placement and solid after placement; ceiling at 66 is air
        if (pos.y <= 63) return { name: 'stone', boundingBox: 'block' };
        if (pos.y === 64) return mockBot.placed ? { name: 'dirt', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' };
        return { name: 'air', boundingBox: 'empty' };
      }),
      placed: false,
      equip: vi.fn().mockResolvedValue(undefined),
      look: vi.fn().mockResolvedValue(undefined),
      setControlState: vi.fn().mockImplementation((state: string, val: boolean) => {
        if (state === 'jump' && val) {
          mockBot.entity.position.y = 65.2; // simulate jump apex
        }
      }),
      clearControlStates: vi.fn(),
      placeBlock: vi.fn().mockImplementation(async () => {
        mockBot.placed = true;
      }),
    };

    await techniquePillarUp(mockBot, 1);

    // Verified negative pitch down (-π/2)
    expect(mockBot.look).toHaveBeenCalledWith(0, -Math.PI / 2, true);
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
        if (pos.x === 0 && pos.y === 62 && pos.z === -1) return { name: 'stone', boundingBox: 'block' };
        // Lava in front of bot
        if (pos.z === -1 && pos.y === 64) return { name: 'lava' };
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
        if (pos.y === 62 && pos.z === -1) return { name: 'air', boundingBox: 'empty' };
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
        if (pos.y === 62 && pos.z === -1) return null;
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
        if (pos.y === 62 && pos.z === -1) return { name: 'water', boundingBox: 'empty' };
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

  it('halts pillar up when ceiling obstruction directly overhead is detected', async () => {
    const mockDirt = { name: 'dirt', count: 5 };
    const mockBot: any = {
      entity: { position: new Vec3(0, 64, 0), yaw: 0 },
      inventory: { items: () => [mockDirt] },
      blockAt: vi.fn().mockImplementation((pos: Vec3) => {
        // Ceiling at y = 66 is solid
        if (pos.y === 66) return { name: 'bedrock', boundingBox: 'block' };
        if (pos.y === 63) return { name: 'stone', boundingBox: 'block' };
        return { name: 'air', boundingBox: 'empty' };
      }),
      equip: vi.fn().mockResolvedValue(undefined),
      look: vi.fn().mockResolvedValue(undefined),
      setControlState: vi.fn(),
      clearControlStates: vi.fn(),
      placeBlock: vi.fn(),
    };

    const res = await techniquePillarUp(mockBot, 2);
    expect(res.status).toBe('failed');
    expect(res.reason).toContain('ceiling obstruction directly overhead');
    expect(mockBot.placeBlock).not.toHaveBeenCalled();
  });

  it('halts bridge when destination space is obstructed', async () => {
    const mockDirt = { name: 'dirt', count: 5 };
    const mockBot: any = {
      entity: { position: new Vec3(0, 64, 0), yaw: 0 },
      inventory: { items: () => [mockDirt] },
      blockAt: vi.fn().mockImplementation((pos: Vec3) => {
        // Current ground under feet
        if (pos.x === 0 && pos.y === 63 && pos.z === 0) return { name: 'stone', boundingBox: 'block' };
        // Placed block ahead
        if (pos.x === 0 && pos.y === 63 && pos.z === 1) return { name: 'dirt', boundingBox: 'block' };
        // Destination foot space at (0, 64, 1) is blocked by a solid wall
        if (pos.x === 0 && pos.y === 64 && pos.z === 1) return { name: 'stone', boundingBox: 'block' };
        return { name: 'air', boundingBox: 'empty' };
      }),
      equip: vi.fn().mockResolvedValue(undefined),
      lookAt: vi.fn().mockResolvedValue(undefined),
      setControlState: vi.fn(),
      clearControlStates: vi.fn(),
      placeBlock: vi.fn().mockResolvedValue(undefined),
    };

    const res = await techniqueBridge(mockBot, 'south', 2);
    expect(res.status).toBe('failed');
    expect(res.reason).toContain('destination space obstructed');
  });

  it('configures pathfinder movements with inventory item types and hazard avoidance', () => {
    const mockBot: any = {
      inventory: {
        items: () => [
          { name: 'dirt', type: 10 },
          { name: 'cobblestone', type: 20 },
        ],
      },
      registry: {
        blocksByName: {
          lava: { id: 100 },
          fire: { id: 101 },
          magma_block: { id: 102 },
          sweet_berry_bush: { id: 103 },
          cactus: { id: 104 },
        },
      },
      pathfinder: {
        movements: {
          blocksToAvoid: new Set(),
          blocksCantBreak: new Set(),
          scafoldingBlocks: [],
        },
      },
    };

    const movements = updatePathfinderMovements(mockBot);
    expect(movements.scafoldingBlocks).toContain(10);
    expect(movements.scafoldingBlocks).toContain(20);
    expect(movements.blocksToAvoid.has(102)).toBe(true); // magma_block
    expect(movements.blocksToAvoid.has(103)).toBe(true); // sweet_berry_bush
  });

  it('strictly excludes redstone, torches, non-solid items, and gravity blocks from scaffolding', () => {
    const mockBot: any = {
      inventory: {
        items: () => [
          { name: 'dirt', type: 10 },
          { name: 'redstone', type: 30 },
          { name: 'redstone_torch', type: 31 },
          { name: 'glowstone_dust', type: 32 },
          { name: 'sand', type: 33 },
          { name: 'gravel', type: 34 },
          { name: 'crafting_table', type: 35 },
        ],
      },
      registry: {
        blocksByName: {
          dirt: { id: 10, boundingBox: 'block' },
          redstone: { id: 30, boundingBox: 'empty' },
          redstone_torch: { id: 31, boundingBox: 'empty' },
          glowstone_dust: { id: 32, boundingBox: 'empty' },
          sand: { id: 33, boundingBox: 'block' },
          gravel: { id: 34, boundingBox: 'block' },
          crafting_table: { id: 35, boundingBox: 'block' },
        },
      },
      pathfinder: {
        movements: {
          blocksToAvoid: new Set(),
          blocksCantBreak: new Set(),
          scafoldingBlocks: [],
        },
      },
    };

    const movements = updatePathfinderMovements(mockBot);
    expect(movements.scafoldingBlocks).toContain(10); // dirt is safe
    expect(movements.scafoldingBlocks).not.toContain(30); // redstone excluded
    expect(movements.scafoldingBlocks).not.toContain(31); // redstone_torch excluded
    expect(movements.scafoldingBlocks).not.toContain(32); // glowstone_dust excluded
    expect(movements.scafoldingBlocks).not.toContain(33); // sand excluded
    expect(movements.scafoldingBlocks).not.toContain(34); // gravel excluded
    expect(movements.scafoldingBlocks).not.toContain(35); // crafting_table excluded
  });

  describe('Workstation Lifecycle & Teardown', () => {
    it('finds safe adjacent placement spot with solid floor and air target', () => {
      const mockBot: any = {
        entity: { position: new Vec3(10, 64, 10) },
        blockAt: vi.fn().mockImplementation((pos: Vec3) => {
          // Candidate in front (11, 64, 10): air, floor (11, 63, 10): stone
          if (pos.x === 11 && pos.y === 64 && pos.z === 10) return { name: 'air', position: pos, boundingBox: 'empty' };
          if (pos.x === 11 && pos.y === 63 && pos.z === 10) return { name: 'stone', position: pos, boundingBox: 'block' };
          return { name: 'dirt', position: pos, boundingBox: 'block' };
        }),
      };

      const spot = findSafePlacementSpot(mockBot);
      expect(spot).not.toBeNull();
      expect(spot!.placePos).toEqual(new Vec3(11, 64, 10));
      expect(spot!.refBlock.name).toBe('stone');
      expect(spot!.placeVector).toEqual(new Vec3(0, 1, 0));
    });

    it('skips adjacent positions that have lava floors or solid walls', () => {
      const mockBot: any = {
        entity: { position: new Vec3(10, 64, 10) },
        blockAt: vi.fn().mockImplementation((pos: Vec3) => {
          // First offset (11, 64, 10) has lava floor
          if (pos.x === 11 && pos.y === 64 && pos.z === 10) return { name: 'air', position: pos };
          if (pos.x === 11 && pos.y === 63 && pos.z === 10) return { name: 'lava', position: pos, boundingBox: 'block' };
          // Second offset (10, 64, 11) is air with grass floor
          if (pos.x === 10 && pos.y === 64 && pos.z === 11) return { name: 'air', position: pos };
          if (pos.x === 10 && pos.y === 63 && pos.z === 11) return { name: 'grass_block', position: pos, boundingBox: 'block' };
          return { name: 'stone', position: pos, boundingBox: 'block' };
        }),
      };

      const spot = findSafePlacementSpot(mockBot);
      expect(spot).not.toBeNull();
      expect(spot!.placePos).toEqual(new Vec3(10, 64, 11));
      expect(spot!.refBlock.name).toBe('grass_block');
    });

    it('reuses existing nearby crafting table without placing a new one', async () => {
      const existingTable = { name: 'crafting_table', position: new Vec3(11, 64, 10) };
      const mockBot: any = {
        findBlock: vi.fn().mockReturnValue(existingTable),
        placeBlock: vi.fn(),
        dig: vi.fn(),
      };

      let operationCalledWith: any = null;
      await withWorkstation(mockBot, 'crafting_table', async (station) => {
        operationCalledWith = station;
        return 'success';
      });

      expect(operationCalledWith).toBe(existingTable);
      expect(mockBot.placeBlock).not.toHaveBeenCalled();
      expect(mockBot.dig).not.toHaveBeenCalled(); // existing table must not be torn down
    });

    it('places table from inventory, runs craft, and tears it down in finally', async () => {
      const tableItem = { name: 'crafting_table', count: 1 };
      let tablePlaced = false;
      const placedTableBlock = { name: 'crafting_table', position: new Vec3(11, 64, 10) };

      const mockBot: any = {
        entity: { position: new Vec3(10, 64, 10) },
        findBlock: vi.fn().mockImplementation((filter: any) => {
          return tablePlaced ? placedTableBlock : null;
        }),
        inventory: {
          items: () => [tableItem],
        },
        blockAt: vi.fn().mockImplementation((pos: Vec3) => {
          if (pos.x === 11 && pos.y === 64 && pos.z === 10) {
            return tablePlaced ? placedTableBlock : { name: 'air', position: pos, boundingBox: 'empty' };
          }
          if (pos.x === 11 && pos.y === 63 && pos.z === 10) return { name: 'stone', position: pos, boundingBox: 'block' };
          return { name: 'stone', position: pos, boundingBox: 'block' };
        }),
        equip: vi.fn().mockResolvedValue(undefined),
        placeBlock: vi.fn().mockImplementation(async () => {
          tablePlaced = true;
        }),
        dig: vi.fn().mockImplementation(async () => {
          tablePlaced = false;
        }),
        entities: {},
      };

      let operationExecuted = false;
      await withWorkstation(mockBot, 'crafting_table', async (station) => {
        operationExecuted = true;
        expect(station.name).toBe('crafting_table');
      });

      expect(operationExecuted).toBe(true);
      expect(mockBot.placeBlock).toHaveBeenCalled();
      // Teardown: bot.dig must have been called to recover the crafting table
      expect(mockBot.dig).toHaveBeenCalledWith(placedTableBlock);
    });

    it('tears down placed table even if the crafting operation throws an error', async () => {
      const tableItem = { name: 'crafting_table', count: 1 };
      let tablePlaced = false;
      const placedTableBlock = { name: 'crafting_table', position: new Vec3(11, 64, 10) };

      const mockBot: any = {
        entity: { position: new Vec3(10, 64, 10) },
        findBlock: vi.fn().mockImplementation(() => (tablePlaced ? placedTableBlock : null)),
        inventory: { items: () => [tableItem] },
        blockAt: vi.fn().mockImplementation((pos: Vec3) => {
          if (pos.x === 11 && pos.y === 64 && pos.z === 10) {
            return tablePlaced ? placedTableBlock : { name: 'air', position: pos, boundingBox: 'empty' };
          }
          if (pos.x === 11 && pos.y === 63 && pos.z === 10) return { name: 'stone', position: pos, boundingBox: 'block' };
          return { name: 'stone', position: pos, boundingBox: 'block' };
        }),
        equip: vi.fn().mockResolvedValue(undefined),
        placeBlock: vi.fn().mockImplementation(async () => { tablePlaced = true; }),
        dig: vi.fn().mockImplementation(async () => { tablePlaced = false; }),
        entities: {},
      };

      await expect(
        withWorkstation(mockBot, 'crafting_table', async () => {
          throw new Error('Craft recipe failed due to inventory mismatch');
        })
      ).rejects.toThrow('Craft recipe failed');

      // Teardown must STILL execute
      expect(mockBot.dig).toHaveBeenCalledWith(placedTableBlock);
    });

    it('bypasses teardown digging and vacuuming when preemption / cancellation occurs during craft', async () => {
      const tableItem = { name: 'crafting_table', count: 1 };
      let tablePlaced = false;
      const placedTableBlock = { name: 'crafting_table', position: new Vec3(11, 64, 10) };
      const abortController = new AbortController();

      const mockBot: any = {
        entity: { position: new Vec3(10, 64, 10) },
        findBlock: vi.fn().mockImplementation(() => (tablePlaced ? placedTableBlock : null)),
        inventory: { items: () => [tableItem] },
        blockAt: vi.fn().mockImplementation((pos: Vec3) => {
          if (pos.x === 11 && pos.y === 64 && pos.z === 10) {
            return tablePlaced ? placedTableBlock : { name: 'air', position: pos, boundingBox: 'empty' };
          }
          return { name: 'stone', position: pos, boundingBox: 'block' };
        }),
        equip: vi.fn().mockResolvedValue(undefined),
        placeBlock: vi.fn().mockImplementation(async () => { tablePlaced = true; }),
        dig: vi.fn().mockImplementation(async () => { tablePlaced = false; }),
        pathfinder: { goto: vi.fn().mockResolvedValue(undefined) },
        entities: {},
      };

      // Preemption occurs during operation
      await expect(
        withWorkstation(
          mockBot,
          'crafting_table',
          async () => {
            // Survival reflex aborts active task
            abortController.abort();
            throw new Error('Preempted by emergency reflex');
          },
          abortController.signal
        )
      ).rejects.toThrow('Preempted by emergency reflex');

      // Since abortSignal was active, teardown MUST NOT dig or vacuum to avoid delaying escape
      expect(mockBot.dig).not.toHaveBeenCalled();
      expect(mockBot.pathfinder.goto).not.toHaveBeenCalled();
    });

    it('preserves the original crafting error without concealment when teardown also fails', async () => {
      const tableItem = { name: 'crafting_table', count: 1 };
      let tablePlaced = false;
      const placedTableBlock = { name: 'crafting_table', position: new Vec3(11, 64, 10) };

      const mockBot: any = {
        entity: { position: new Vec3(10, 64, 10) },
        findBlock: vi.fn().mockImplementation(() => (tablePlaced ? placedTableBlock : null)),
        inventory: { items: () => [tableItem] },
        blockAt: vi.fn().mockImplementation((pos: Vec3) => {
          if (pos.x === 11 && pos.y === 64 && pos.z === 10) {
            return tablePlaced ? placedTableBlock : { name: 'air', position: pos, boundingBox: 'empty' };
          }
          return { name: 'stone', position: pos, boundingBox: 'block' };
        }),
        equip: vi.fn().mockResolvedValue(undefined),
        placeBlock: vi.fn().mockImplementation(async () => { tablePlaced = true; }),
        dig: vi.fn().mockRejectedValue(new Error('Teardown dig failed: pickaxe shattered')),
        entities: {},
      };

      let caughtError: any = null;
      try {
        await withWorkstation(mockBot, 'crafting_table', async () => {
          throw new Error('Original crafting error: invalid recipe');
        });
      } catch (err: any) {
        caughtError = err;
      }

      // The original crafting error MUST be preserved and thrown
      expect(caughtError).not.toBeNull();
      expect(caughtError.message).toContain('Original crafting error: invalid recipe');
      // The teardown error is attached for diagnostics rather than silently concealing the craft error
      expect(caughtError.teardownError).toBeDefined();
      expect(caughtError.teardownError.message).toContain('Teardown dig failed: pickaxe shattered');
    });

    it('handles missing workstation block safely without crashing or digging air', async () => {
      const tableItem = { name: 'crafting_table', count: 1 };
      let tablePlaced = false;
      let blockDestroyed = false;
      const placedTableBlock = { name: 'crafting_table', position: new Vec3(11, 64, 10) };

      const mockBot: any = {
        entity: { position: new Vec3(10, 64, 10) },
        findBlock: vi.fn().mockImplementation(() => (tablePlaced && !blockDestroyed ? placedTableBlock : null)),
        inventory: { items: () => [tableItem] },
        blockAt: vi.fn().mockImplementation((pos: Vec3) => {
          if (pos.x === 11 && pos.y === 64 && pos.z === 10) {
            if (tablePlaced && !blockDestroyed) return placedTableBlock;
            return { name: 'air', position: pos, boundingBox: 'empty' };
          }
          return { name: 'stone', position: pos, boundingBox: 'block' };
        }),
        equip: vi.fn().mockResolvedValue(undefined),
        placeBlock: vi.fn().mockImplementation(async () => { tablePlaced = true; }),
        dig: vi.fn(),
        entities: {},
      };

      const result = await withWorkstation(mockBot, 'crafting_table', async () => {
        // Table destroyed mid-craft by creeper or environment
        blockDestroyed = true;
        return 'craft_completed';
      });

      expect(result).toBe('craft_completed');
      // Since blockAt returned 'air', bot.dig must not be invoked on non-table block
      expect(mockBot.dig).not.toHaveBeenCalled();
    });

    it('returns craft result successfully even if item drop collection (vacuum) fails', async () => {
      const tableItem = { name: 'crafting_table', count: 1 };
      let tablePlaced = false;
      const placedTableBlock = { name: 'crafting_table', position: new Vec3(11, 64, 10) };

      const mockBot: any = {
        entity: { position: new Vec3(10, 64, 10) },
        findBlock: vi.fn().mockImplementation(() => (tablePlaced ? placedTableBlock : null)),
        inventory: { items: () => [tableItem] },
        blockAt: vi.fn().mockImplementation((pos: Vec3) => {
          if (pos.x === 11 && pos.y === 64 && pos.z === 10) {
            return tablePlaced ? placedTableBlock : { name: 'air', position: pos, boundingBox: 'empty' };
          }
          return { name: 'stone', position: pos, boundingBox: 'block' };
        }),
        equip: vi.fn().mockResolvedValue(undefined),
        placeBlock: vi.fn().mockImplementation(async () => { tablePlaced = true; }),
        dig: vi.fn().mockImplementation(async () => { tablePlaced = false; }),
        entities: {
          99: { id: 99, name: 'item', type: 'item', position: new Vec3(11, 64, 10) },
        },
        pathfinder: {
          movements: {},
          goto: vi.fn().mockRejectedValue(new Error('Path to drop obstructed by wall')),
          stop: vi.fn(),
        },
      };

      const result = await withWorkstation(mockBot, 'crafting_table', async () => {
        return 'wooden_pickaxe_crafted';
      });

      // Craft succeeds and table was dug, even though vacuum drops failed
      expect(result).toBe('wooden_pickaxe_crafted');
      expect(mockBot.dig).toHaveBeenCalledWith(placedTableBlock);
    });
  });

  describe('Autonomous Resource Collection and Macro Actions', () => {
    it('accurately matches resource blocks and drop items', () => {
      expect(isMatchingResourceBlock('oak_log', 'wood')).toBe(true);
      expect(isMatchingResourceBlock('birch_log', 'wood')).toBe(true);
      expect(isMatchingResourceBlock('stone', 'stone')).toBe(true);
      expect(isMatchingResourceBlock('deepslate', 'stone')).toBe(true);
      expect(isMatchingResourceBlock('cobblestone', 'cobblestone')).toBe(true);
      expect(isMatchingResourceBlock('coal_ore', 'coal')).toBe(true);
      expect(isMatchingResourceBlock('iron_ore', 'iron')).toBe(true);
      expect(isMatchingResourceBlock('dirt', 'dirt')).toBe(true);
      expect(isMatchingResourceBlock('grass_block', 'dirt')).toBe(true);
      expect(isMatchingResourceBlock('sand', 'sand')).toBe(true);
      expect(isMatchingResourceBlock('glass', 'stone')).toBe(false);

      expect(getExpectedResourceItemNames('stone')).toContain('cobblestone');
      expect(getExpectedResourceItemNames('iron')).toContain('raw_iron');
      expect(getExpectedResourceItemNames('coal')).toContain('coal');
    });

    it('counts resources in inventory correctly', () => {
      const mockBot: any = {
        inventory: {
          items: () => [
            { name: 'cobblestone', count: 5 },
            { name: 'deepslate', count: 3 },
            { name: 'dirt', count: 12 },
            { name: 'oak_log', count: 4 },
          ],
        },
      };

      expect(countResourceInInventory(mockBot, 'stone')).toBe(8); // 5 + 3
      expect(countResourceInInventory(mockBot, 'dirt')).toBe(12);
      expect(countResourceInInventory(mockBot, 'wood')).toBe(4);
      expect(countResourceInInventory(mockBot, 'coal')).toBe(0);
    });

    it('auto-equips best tool according to block type', async () => {
      const pickaxe = { name: 'wooden_pickaxe', type: 101 };
      const axe = { name: 'wooden_axe', type: 102 };
      const shovel = { name: 'wooden_shovel', type: 103 };

      const mockBot: any = {
        inventory: {
          items: () => [pickaxe, axe, shovel],
        },
        heldItem: null,
        equip: vi.fn().mockImplementation(async (item: any) => {
          mockBot.heldItem = item;
        }),
      };

      // Stone block requires pickaxe
      await autoEquipBestToolForBlock(mockBot, { name: 'stone' });
      expect(mockBot.equip).toHaveBeenCalledWith(pickaxe, 'hand');

      // Log block requires axe
      await autoEquipBestToolForBlock(mockBot, { name: 'oak_log' });
      expect(mockBot.equip).toHaveBeenCalledWith(axe, 'hand');

      // Dirt block requires shovel
      await autoEquipBestToolForBlock(mockBot, { name: 'dirt' });
      expect(mockBot.equip).toHaveBeenCalledWith(shovel, 'hand');
    });

    it('returns success immediately if requested resource count is already met', async () => {
      const mockBot: any = {
        inventory: {
          items: () => [{ name: 'cobblestone', count: 16 }],
        },
      };

      const res = await techniqueCollectResource(mockBot, 'stone', 0);
      expect(res.status).toBe('success');
      expect(res.reason).toContain('satisfied');
    });

    it('navigates, mines stone block, vacuums drops, and increments inventory', async () => {
      let stoneMined = false;
      const stonePos = new Vec3(5, 64, 5);
      const stoneBlock = {
        name: 'stone',
        position: stonePos,
        boundingBox: 'block',
      };
      const pickaxe = { name: 'wooden_pickaxe', type: 101 };

      let invItems = [pickaxe];

      const mockBot: any = {
        entity: { position: new Vec3(0, 64, 0) },
        findBlock: vi.fn().mockImplementation(() => (stoneMined ? null : stoneBlock)),
        blockAt: vi.fn().mockImplementation((pos: Vec3) => {
          if (pos.equals(stonePos)) return stoneMined ? { name: 'air', position: pos } : stoneBlock;
          return { name: 'stone', position: pos, boundingBox: 'block' };
        }),
        inventory: {
          items: () => invItems,
        },
        heldItem: null,
        equip: vi.fn().mockImplementation(async (item) => { mockBot.heldItem = item; }),
        dig: vi.fn().mockImplementation(async () => {
          stoneMined = true;
          invItems.push({ name: 'cobblestone', count: 1 } as any);
        }),
        pathfinder: {
          goto: vi.fn().mockResolvedValue(undefined),
          stop: vi.fn(),
          movements: {},
        },
        entities: {},
        clearControlStates: vi.fn(),
        deactivateItem: vi.fn(),
      };

      const res = await techniqueCollectResource(mockBot, 'stone', 1);
      expect(res.status).toBe('success');
      expect(mockBot.dig).toHaveBeenCalledWith(stoneBlock);
      expect(mockBot.equip).toHaveBeenCalled();
    });

    it('safely handles chunk palette matching where block.position is undefined', async () => {
      // In Mineflayer, isBlockInSection passes palette Block objects without world position
      const mockBot: any = {
        entity: { position: new Vec3(0, 64, 0) },
        findBlock: vi.fn().mockImplementation((opts: any) => {
          // Simulate palette check where position is undefined
          const paletteBlock = { name: 'coal_ore', type: 16 };
          const matches = opts.matching(paletteBlock);
          expect(matches).toBe(true); // Should not throw Cannot read properties of undefined (reading 'offset')
          return null;
        }),
        inventory: { items: () => [] },
      };

      const res = await techniqueCollectResource(mockBot, 'coal', 1);
      expect(res.status).toBe('failed');
      expect(res.reason).toContain('No coal found');
    });

    it('aborts resource collection when preemption signal fires', async () => {
      const abortController = new AbortController();
      abortController.abort();

      const mockBot: any = {
        entity: { position: new Vec3(0, 64, 0) },
        inventory: { items: () => [] },
      };

      const res = await techniqueCollectResource(mockBot, 'stone', 3, abortController.signal);
      expect(res.status).toBe('interrupted');
      expect(res.reason).toContain('cancelled');
    });

    it('registers chop_tree and collect_resource in miningBuildingActions', () => {
      const chopAction = miningBuildingActions.find((a) => a.name === 'chop_tree');
      expect(chopAction).toBeDefined();
      expect(chopAction?.category).toBe('mining_building');

      const collectAction = miningBuildingActions.find((a) => a.name === 'collect_resource');
      expect(collectAction).toBeDefined();
      expect(collectAction?.category).toBe('mining_building');
    });

    it('registers craft_item in inventoryCraftingActions', () => {
      const craftAction = inventoryCraftingActions.find((a) => a.name === 'craft_item');
      expect(craftAction).toBeDefined();
      expect(craftAction?.category).toBe('inventory_crafting');
    });
  });
});
