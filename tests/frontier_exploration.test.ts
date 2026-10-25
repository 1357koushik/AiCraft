import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Vec3 } from 'vec3';
import {
  ExplorationGrid,
  globalExplorationGrid,
} from '../src/actions/exploration/frontier.js';
import {
  evaluateCaveLighting,
  techniquePlaceCaveTorch,
  techniqueTraverseCaveBranch,
} from '../src/actions/exploration/cave_traversal.js';
import { movementActions } from '../src/actions/movement.js';
import { MemoryManager } from '../src/memory/index.js';
import { loadConfig } from '../src/config/index.js';

describe('Phase 3: Exploration, Navigation, and Environmental Reasoning', () => {
  const config = loadConfig();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  // =========================================================================
  // 1. 2D Chunk Grid Frontier Tracking
  // =========================================================================
  describe('1. 2D Chunk Grid Frontier Tracking', () => {
    it('correctly maps world coordinates to chunk coordinates and keys', () => {
      expect(ExplorationGrid.toChunkCoord(0)).toBe(0);
      expect(ExplorationGrid.toChunkCoord(15)).toBe(0);
      expect(ExplorationGrid.toChunkCoord(16)).toBe(1);
      expect(ExplorationGrid.toChunkCoord(-1)).toBe(-1);
      expect(ExplorationGrid.toChunkCoord(-16)).toBe(-1);
      expect(ExplorationGrid.toChunkCoord(-17)).toBe(-2);

      expect(ExplorationGrid.chunkKey(2, -3)).toBe('2,-3');
      expect(ExplorationGrid.parseChunkKey('2,-3')).toEqual({ cx: 2, cz: -3 });
    });

    it('records chunk status and associates detected biomes', () => {
      const grid = new ExplorationGrid();
      grid.markChunk(0, 0, 'MAPPED', 'plains');
      grid.markChunk(1, 0, 'MAPPED', 'forest');

      expect(grid.chunkStatus.get('0,0')).toBe('MAPPED');
      expect(grid.detectedBiomes.get('0,0')).toBe('plains');
      expect(grid.detectedBiomes.get('1,0')).toBe('forest');
    });

    it('records and deduplicates exposed ore sightings', () => {
      const grid = new ExplorationGrid();
      grid.recordOre('iron_ore', new Vec3(10, 32, 10));
      grid.recordOre('iron_ore', new Vec3(10.5, 32.2, 10.1)); // Duplicate nearby
      grid.recordOre('iron_ore', new Vec3(25, 30, 25)); // Distinct vein

      const ores = grid.getOres('iron_ore');
      expect(ores.length).toBe(2);
      expect(ores[0].x).toBe(10);
      expect(ores[1].x).toBe(25);
    });

    it('selects nearest unmapped boundary chunk as the next frontier', () => {
      const grid = new ExplorationGrid();
      const origin = new Vec3(8, 64, 8); // chunk 0,0

      // Mark origin chunk as mapped
      grid.markChunk(0, 0, 'MAPPED', 'plains');

      const nextFrontier = grid.getNextFrontier(origin);

      expect(nextFrontier).toBeDefined();
      // Target must be adjacent chunk (offset by ~16 blocks)
      const dist = Math.hypot(nextFrontier.x - origin.x, nextFrontier.z - origin.z);
      expect(dist).toBeGreaterThanOrEqual(14);
      expect(dist).toBeLessThanOrEqual(35);
    });

    it('biases frontier selection towards preferred biome', () => {
      const grid = new ExplorationGrid();
      const origin = new Vec3(8, 64, 8); // chunk 0,0

      grid.markChunk(0, 0, 'MAPPED', 'plains');
      grid.markChunk(1, 0, 'UNEXPLORED', 'desert');
      grid.markChunk(0, 1, 'UNEXPLORED', 'badlands');

      // Request badlands
      const frontier = grid.getNextFrontier(origin, 'badlands');
      const targetCx = ExplorationGrid.toChunkCoord(frontier.x);
      const targetCz = ExplorationGrid.toChunkCoord(frontier.z);

      expect(targetCx).toBe(0);
      expect(targetCz).toBe(1);
    });

    it('systematically explores a 10-chunk grid without infinite looping', () => {
      const grid = new ExplorationGrid();
      let pos = new Vec3(8, 64, 8);
      const visited = new Set<string>();

      for (let step = 0; step < 10; step++) {
        const cx = ExplorationGrid.toChunkCoord(pos.x);
        const cz = ExplorationGrid.toChunkCoord(pos.z);
        const key = ExplorationGrid.chunkKey(cx, cz);

        visited.add(key);
        grid.markChunk(cx, cz, 'MAPPED');

        const next = grid.getNextFrontier(pos);
        expect(next).toBeDefined();
        pos = next;
      }

      // Assert that multiple distinct chunks were mapped
      expect(visited.size).toBe(10);
    });
  });

  // =========================================================================
  // 2. Cave Traversal, Lighting, and Automatic Torch Placement
  // =========================================================================
  describe('2. Cave Traversal, Lighting, and Automatic Torch Placement', () => {
    it('detects low light condition requiring torch illumination (< 4)', () => {
      const mockDarkBot: any = {
        entity: { position: new Vec3(0, 30, 0) },
        blockAt: () => ({ light: 2 }),
      };
      const darkAssessment = evaluateCaveLighting(mockDarkBot);
      expect(darkAssessment.needsLight).toBe(true);
      expect(darkAssessment.lightLevel).toBe(2);

      const mockBrightBot: any = {
        entity: { position: new Vec3(0, 64, 0) },
        blockAt: () => ({ light: 12 }),
      };
      const brightAssessment = evaluateCaveLighting(mockBrightBot);
      expect(brightAssessment.needsLight).toBe(false);
      expect(brightAssessment.lightLevel).toBe(12);
    });

    it('fails cleanly when attempting to place torch without torches in inventory', async () => {
      const mockBot: any = {
        entity: { position: new Vec3(0, 30, 0) },
        inventory: { items: () => [] },
        blockAt: () => ({ name: 'stone', boundingBox: 'block' }),
      };

      const result = await techniquePlaceCaveTorch(mockBot);
      expect(result.status).toBe('failed');
      expect(result.reason).toContain('No torches in inventory');
    });

    it('equips and places torch onto solid floor block when available', async () => {
      const mockTorch = { type: 50, name: 'torch', count: 8 };
      const floorStone = { position: new Vec3(0, 29, 0), name: 'stone', boundingBox: 'block' };
      const airSpace = { position: new Vec3(0, 30, 0), name: 'air', boundingBox: 'empty' };

      const mockBot: any = {
        entity: { position: new Vec3(0, 30, 0) },
        inventory: { items: () => [mockTorch] },
        heldItem: null,
        equip: vi.fn().mockImplementation((item) => {
          mockBot.heldItem = item;
          return Promise.resolve();
        }),
        lookAt: vi.fn().mockResolvedValue(undefined),
        placeBlock: vi.fn().mockResolvedValue(undefined),
        blockAt: (pos: Vec3) => {
          if (pos.y === 29) return floorStone;
          return airSpace;
        },
      };

      const result = await techniquePlaceCaveTorch(mockBot);

      expect(result.status).toBe('success');
      expect(mockBot.equip).toHaveBeenCalledWith(mockTorch, 'hand');
      expect(mockBot.lookAt).toHaveBeenCalled();
      expect(mockBot.placeBlock).toHaveBeenCalledWith(floorStone, expect.any(Vec3));
    });

    it('detects pit / ravine drop hazard (> 3 blocks drop) ahead and halts safely', async () => {
      const mockBot: any = {
        entity: { position: new Vec3(0, 30, 0), yaw: 0 },
        blockAt: (pos: Vec3) => {
          // Sheer pit: all blocks below next step are air
          return { position: pos, name: 'air', boundingBox: 'empty' };
        },
      };

      const result = await techniqueTraverseCaveBranch(mockBot, { autoTorch: false });
      expect(result.status).toBe('failed');
      expect(result.reason).toContain('ravine drop');
    });

    it('catalogs exposed ore veins during cave traversal', async () => {
      const ironOrePos = new Vec3(3, 28, 3);
      const mockBot: any = {
        entity: { position: new Vec3(0, 30, 0), yaw: 0 },
        findBlock: (opt: any) => {
          if (opt.matching({ name: 'iron_ore' })) {
            return { name: 'iron_ore', position: ironOrePos };
          }
          return null;
        },
        blockAt: (pos: Vec3) => ({ position: pos, name: 'stone', boundingBox: 'block', light: 8 }),
      };

      const result = await techniqueTraverseCaveBranch(mockBot, { autoTorch: false });

      expect(result.status).toBe('success');
      expect(result.reason).toContain('iron_ore');
      expect(globalExplorationGrid.getOres('iron_ore').length).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // 3. Movement Action & Memory Integration
  // =========================================================================
  describe('3. Movement Action & Memory Integration', () => {
    it('supports explore target "cave" by delegating to cave branch traversal', async () => {
      const exploreDef = movementActions.find((a) => a.name === 'explore');
      expect(exploreDef).toBeDefined();

      const mockBot: any = {
        entity: { position: new Vec3(0, 30, 0), yaw: 0 },
        findBlock: () => null,
        blockAt: (pos: Vec3) => ({ position: pos, name: 'deepslate', boundingBox: 'block', light: 10 }),
      };

      const result = await exploreDef!.execute(mockBot, { target: 'cave' }, {
        bot: mockBot,
        observation: { vitals: { isAlive: true } } as any,
        logger,
        config,
      });

      expect(result.status).toBe('success');
      expect(result.reason).toContain('cave branch');
    });

    it('records visited regions and landmarks into MemoryManager', () => {
      const memory = new MemoryManager(`test_explore_${Date.now()}`, './data/test_memory');

      memory.recordExploredRegion({ x: 32, z: 48 }, 'overworld', 'savanna');
      expect(memory.isRegionExplored({ x: 32, z: 48 })).toBe(true);

      const regions = memory.getExploredRegions();
      expect(regions.length).toBe(1);
      expect(regions[0].chunkX).toBe(2);
      expect(regions[0].chunkZ).toBe(3);
      expect(regions[0].biome).toBe('savanna');

      memory.recordLandmark('Village Outpost', { x: 35, y: 64, z: 50 }, 'landmark');
      const landmarks = memory.getKnownLocations('landmark');
      expect(landmarks.length).toBe(1);
      expect(landmarks[0].name).toBe('Village Outpost');
    });
  });
});
