import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Vec3 } from 'vec3';
import {
  getRequiredHarvestTier,
  getToolHarvestTier,
  canHarvestBlockWithTool,
  findBestPickaxeInInventory,
  validateBlockHarvestability,
  getFaceAdjacentOreVein,
  getExpectedDropItemName,
  techniqueMineOreVein,
  techniqueGatherSurfaceResource,
  isMatchingOreSpecies,
} from '../src/actions/mining.js';
import { navigationBlacklist } from '../src/actions/blacklist.js';
import { ActionExecutionContext, Observation } from '../src/types/index.js';

describe('Production Skills: Mining & Surface Gathering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    navigationBlacklist.clear();
  });

  const createMockObservation = (): Observation => ({
    version: '1.21.6',
    timestamp: Date.now(),
    vitals: {
      health: 20,
      food: 20,
      oxygen: 20,
      isAlive: true,
      armor: 0,
      underwater: false,
      isBurning: false,
      movementState: { onGround: true, inWater: false, isSleeping: false, isRiding: false },
    } as any,
    position: {
      x: 10,
      y: 64,
      z: 10,
      blockCoords: { x: 10, y: 64, z: 10 },
      velocity: { x: 0, y: 0, z: 0 },
      yaw: 0,
      pitch: 0,
      facing: 'north',
      dimension: 'overworld',
    } as any,
    environment: { dayPhase: 'day', weather: 'clear' } as any,
    statusEffects: [],
    inventory: {
      mainHand: null,
      offHand: null,
      heldItemHint: 'empty',
      aggregates: { totalItemCounts: {} },
      toolSummary: {},
      craftableNow: [],
      foodList: [],
      placeableBlocks: {},
    } as any,
    crosshair: {},
    blocks: {
      notableBlocks: [],
      hazards: [],
      walkability: { forward: true, back: true, left: true, right: true },
      localMap: { ascii: '', legend: {} },
    } as any,
    entities: [],
    recentEvents: {} as any,
    container: { isOpen: false, type: null, slotsCount: 0, items: [] },
    agentState: {
      currentGoal: 'Mine',
      planSteps: [],
      stepNumber: 1,
      stuckCounter: 0,
      timeSinceLastProgressSeconds: 0,
    },
    memory: { namedLocations: {}, facts: [], dangerZones: [], completedGoals: [] },
    derived: { availableActions: [] },
  });

  const createMockBot = (options: {
    inventory?: { name: string; count: number }[];
    blocks?: Map<string, any>;
    botPos?: Vec3;
    heldItem?: any;
  } = {}) => {
    const items = (options.inventory || []).map((inv, idx) => ({
      type: idx + 100,
      name: inv.name,
      count: inv.count,
    }));

    const blockMap = options.blocks || new Map<string, any>();
    const pos = options.botPos || new Vec3(10, 64, 10);

    const mockBot: any = {
      entity: { position: pos.clone(), yaw: 0 },
      inventory: {
        items: vi.fn(() => items),
        emptySlotCount: vi.fn(() => Math.max(0, 36 - items.length)),
      },
      heldItem: options.heldItem || items[0] || null,
      blockAt: vi.fn((p: Vec3) => {
        const key = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
        if (blockMap.has(key)) return blockMap.get(key);
        return {
          name: p.y >= 64 ? 'air' : 'stone',
          position: p.clone(),
          boundingBox: p.y >= 64 ? 'empty' : 'block',
        };
      }),
      findBlock: vi.fn((opts: any) => {
        for (const b of blockMap.values()) {
          if (opts.matching(b)) return b;
        }
        return null;
      }),
      equip: vi.fn(async (item: any) => {
        mockBot.heldItem = item;
      }),
      dig: vi.fn(async (_block: any) => {}),
      stopDigging: vi.fn(),
      clearControlStates: vi.fn(),
      pathfinder: {
        goto: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn(),
      },
    };

    return { mockBot, items, blockMap };
  };

  const createCtx = (mockBot: any): ActionExecutionContext => ({
    bot: mockBot,
    observation: createMockObservation(),
    config: { perception: { scanRadius: 32 } } as any,
    isCurrent: () => true,
  });

  // =========================================================================
  // 1. Tool Harvest Tier Validation (Minecraft Java 1.21.6 Hierarchy)
  // =========================================================================
  describe('1. Harvest Tier Hierarchy & Tool Requirements', () => {
    it('correctly maps required harvest tier across Minecraft Java blocks', () => {
      // Tier 4: Obsidian, Ancient Debris
      expect(getRequiredHarvestTier('obsidian')).toBe(4);
      expect(getRequiredHarvestTier('ancient_debris')).toBe(4);

      // Tier 3: Diamond, Gold, Redstone, Emerald
      expect(getRequiredHarvestTier('diamond_ore')).toBe(3);
      expect(getRequiredHarvestTier('deepslate_diamond_ore')).toBe(3);
      expect(getRequiredHarvestTier('gold_ore')).toBe(3);
      expect(getRequiredHarvestTier('redstone_ore')).toBe(3);
      expect(getRequiredHarvestTier('emerald_ore')).toBe(3);

      // Tier 2: Iron, Copper, Lapis
      expect(getRequiredHarvestTier('iron_ore')).toBe(2);
      expect(getRequiredHarvestTier('deepslate_iron_ore')).toBe(2);
      expect(getRequiredHarvestTier('copper_ore')).toBe(2);
      expect(getRequiredHarvestTier('lapis_ore')).toBe(2);

      // Tier 1: Stone, Coal, Deepslate
      expect(getRequiredHarvestTier('coal_ore')).toBe(1);
      expect(getRequiredHarvestTier('stone')).toBe(1);
      expect(getRequiredHarvestTier('deepslate')).toBe(1);

      // Tier 0: Dirt, Sand, Wood, Hand-harvestable
      expect(getRequiredHarvestTier('dirt')).toBe(0);
      expect(getRequiredHarvestTier('sand')).toBe(0);
      expect(getRequiredHarvestTier('oak_log')).toBe(0);
    });

    it('correctly maps pickaxe tool tiers', () => {
      expect(getToolHarvestTier('wooden_pickaxe')).toBe(1);
      expect(getToolHarvestTier('golden_pickaxe')).toBe(1);
      expect(getToolHarvestTier('stone_pickaxe')).toBe(2);
      expect(getToolHarvestTier('iron_pickaxe')).toBe(3);
      expect(getToolHarvestTier('diamond_pickaxe')).toBe(4);
      expect(getToolHarvestTier('netherite_pickaxe')).toBe(5);
      expect(getToolHarvestTier('iron_axe')).toBe(0); // Axes are tier 0 for pickaxe-mined blocks
    });

    it('rejects mining iron_ore when bot only has wooden_pickaxe (WRONG_TOOL_TIER)', () => {
      const { mockBot, blockMap } = createMockBot({
        inventory: [{ name: 'wooden_pickaxe', count: 1 }],
      });
      const ironOreBlock = { name: 'iron_ore', position: new Vec3(10, 63, 10), boundingBox: 'block' };
      blockMap.set('10,63,10', ironOreBlock);

      const validation = validateBlockHarvestability(mockBot, ironOreBlock);

      expect(validation.valid).toBe(false);
      expect(validation.failureKind).toBe('WRONG_TOOL_TIER');
      expect(validation.reason).toContain('requires at least Stone Pickaxe');
      expect(validation.requiredTier).toBe(2);
      expect(validation.availableTier).toBe(1);
    });

    it('rejects mining diamond_ore when bot only has stone_pickaxe (WRONG_TOOL_TIER)', () => {
      const { mockBot, blockMap } = createMockBot({
        inventory: [{ name: 'stone_pickaxe', count: 1 }],
      });
      const diamondBlock = { name: 'diamond_ore', position: new Vec3(10, 63, 10), boundingBox: 'block' };
      blockMap.set('10,63,10', diamondBlock);

      const validation = validateBlockHarvestability(mockBot, diamondBlock);

      expect(validation.valid).toBe(false);
      expect(validation.failureKind).toBe('WRONG_TOOL_TIER');
      expect(validation.reason).toContain('requires at least Iron Pickaxe');
      expect(validation.requiredTier).toBe(3);
      expect(validation.availableTier).toBe(2);
    });

    it('accepts mining iron_ore with stone_pickaxe and diamond_ore with iron_pickaxe', () => {
      const { mockBot: botStone } = createMockBot({ inventory: [{ name: 'stone_pickaxe', count: 1 }] });
      const ironBlock = { name: 'iron_ore', position: new Vec3(10, 63, 10), boundingBox: 'block' };
      expect(validateBlockHarvestability(botStone, ironBlock).valid).toBe(true);

      const { mockBot: botIron } = createMockBot({ inventory: [{ name: 'iron_pickaxe', count: 1 }] });
      const diamondBlock = { name: 'diamond_ore', position: new Vec3(10, 63, 10), boundingBox: 'block' };
      expect(validateBlockHarvestability(botIron, diamondBlock).valid).toBe(true);
    });
  });

  // =========================================================================
  // 2. Observation Freshness & Stale Block Target Detection
  // =========================================================================
  describe('2. Observation Freshness & Stale Target Rejection', () => {
    it('rejects target when blockAt returns air (STALE_TARGET)', () => {
      const { mockBot } = createMockBot();
      const staleBlock = { name: 'iron_ore', position: new Vec3(12, 63, 12) };

      // World state changed: block was mined or unloaded, now returns air
      mockBot.blockAt.mockReturnValue({ name: 'air', position: staleBlock.position, boundingBox: 'empty' });

      const validation = validateBlockHarvestability(mockBot, staleBlock);

      expect(validation.valid).toBe(false);
      expect(validation.failureKind).toBe('STALE_TARGET');
      expect(validation.reason).toContain('Target block is stale');
    });

    it('rejects target when block is blacklisted due to recent failure (PATH_UNREACHABLE)', () => {
      const { mockBot, blockMap } = createMockBot({
        inventory: [{ name: 'iron_pickaxe', count: 1 }],
      });
      const pos = new Vec3(10, 63, 10);
      const targetBlock = { name: 'iron_ore', position: pos, boundingBox: 'block' };
      blockMap.set('10,63,10', targetBlock);

      // Blacklist this position
      navigationBlacklist.recordFailure(pos, 'Unreachable cliff', 'UNREACHABLE', 60_000);

      const validation = validateBlockHarvestability(mockBot, targetBlock);

      expect(validation.valid).toBe(false);
      expect(validation.failureKind).toBe('PATH_UNREACHABLE');
      expect(validation.reason).toContain('blacklisted');
    });
  });

  // =========================================================================
  // 3. Face-Adjacent Ore Vein Traversal (Strict 6 Orthogonal vs Diagonal Rejection)
  // =========================================================================
  describe('3. Strict 6-Face Adjacent Ore Vein Traversal', () => {
    it('rejects diagonal-only neighbor by default and connects ONLY 6 orthogonal neighbors', () => {
      const { mockBot, blockMap } = createMockBot();

      // Start ore at (10, 63, 10)
      const startOre = { name: 'iron_ore', position: new Vec3(10, 63, 10) };
      blockMap.set('10,63,10', startOre);

      // Diagonal neighbor at (11, 64, 10) -> dx=+1, dy=+1, dz=0 (corner diagonal!)
      const diagonalOre = { name: 'iron_ore', position: new Vec3(11, 64, 10) };
      blockMap.set('11,64,10', diagonalOre);

      // Orthogonal neighbor at (10, 63, 11) -> dz=+1 (face adjacent)
      const orthogonalOre = { name: 'iron_ore', position: new Vec3(10, 63, 11) };
      blockMap.set('10,63,11', orthogonalOre);

      // Default traversal (allowDiagonal: false): strict 6 face neighbors
      const discovered = getFaceAdjacentOreVein(mockBot, startOre, { allowDiagonal: false });

      expect(discovered.length).toBe(2);
      expect(discovered.some((b) => b.position.equals(startOre.position))).toBe(true);
      expect(discovered.some((b) => b.position.equals(orthogonalOre.position))).toBe(true);
      // Crucial: Diagonal ore must NOT be discovered!
      expect(discovered.some((b) => b.position.equals(diagonalOre.position))).toBe(false);
    });

    it('connects deepslate and regular variants of the same ore species', () => {
      const { mockBot, blockMap } = createMockBot();

      const startOre = { name: 'iron_ore', position: new Vec3(10, 0, 10) };
      const deepslateNeighbor = { name: 'deepslate_iron_ore', position: new Vec3(10, -1, 10) }; // dy = -1 (orthogonal)

      blockMap.set('10,0,10', startOre);
      blockMap.set('10,-1,10', deepslateNeighbor);

      const discovered = getFaceAdjacentOreVein(mockBot, startOre);

      expect(discovered.length).toBe(2);
      expect(discovered[1].name).toBe('deepslate_iron_ore');
    });
  });

  // =========================================================================
  // 4. Traversal Bounds (Count & Distance Budgets)
  // =========================================================================
  describe('4. Traversal Bounding by Count and Distance', () => {
    it('strictly caps traversal at maxCount limit', () => {
      const { mockBot, blockMap } = createMockBot();

      // Create a straight orthogonal vein of 6 iron ore blocks along X-axis
      const blocks: any[] = [];
      for (let x = 10; x <= 15; x++) {
        const b = { name: 'iron_ore', position: new Vec3(x, 63, 10) };
        blockMap.set(`${x},63,10`, b);
        blocks.push(b);
      }

      // Limit maxCount to 3
      const discovered = getFaceAdjacentOreVein(mockBot, blocks[0], { maxCount: 3 });

      expect(discovered.length).toBe(3);
      expect(discovered[0].position.x).toBe(10);
      expect(discovered[1].position.x).toBe(11);
      expect(discovered[2].position.x).toBe(12);
    });

    it('strictly caps traversal at maxDistance bound', () => {
      const { mockBot, blockMap } = createMockBot();

      // Blocks stretching 10 blocks away
      const blocks: any[] = [];
      for (let x = 10; x <= 20; x++) {
        const b = { name: 'coal_ore', position: new Vec3(x, 63, 10) };
        blockMap.set(`${x},63,10`, b);
        blocks.push(b);
      }

      // Bound maxDistance to 3 meters from start block (10, 63, 10)
      const discovered = getFaceAdjacentOreVein(mockBot, blocks[0], { maxDistance: 3, maxCount: 20 });

      // Only blocks with distance <= 3 from (10, 63, 10): x=10, x=11, x=12, x=13
      expect(discovered.length).toBe(4);
      expect(discovered.every((b) => b.position.x <= 13)).toBe(true);
    });
  });

  // =========================================================================
  // 5. Hazardous Target Rejection (Lava, Fire, Overhead Flooding)
  // =========================================================================
  describe('5. Hazardous Target Rejection', () => {
    it('rejects ore block adjacent to lava on any orthogonal face (HAZARD_OBSTRUCTION)', () => {
      const { mockBot, blockMap } = createMockBot({
        inventory: [{ name: 'iron_pickaxe', count: 1 }],
      });

      const oreBlock = { name: 'diamond_ore', position: new Vec3(10, 15, 10), boundingBox: 'block' };
      const lavaBlock = { name: 'lava', position: new Vec3(11, 15, 10), boundingBox: 'empty' }; // Adjacent East

      blockMap.set('10,15,10', oreBlock);
      blockMap.set('11,15,10', lavaBlock);

      const validation = validateBlockHarvestability(mockBot, oreBlock);

      expect(validation.valid).toBe(false);
      expect(validation.failureKind).toBe('HAZARD_OBSTRUCTION');
      expect(validation.reason).toContain('adjacent to deadly hazard (lava');
    });

    it('rejects ore block adjacent to fire (HAZARD_OBSTRUCTION)', () => {
      const { mockBot, blockMap } = createMockBot({
        inventory: [{ name: 'stone_pickaxe', count: 1 }],
      });

      const oreBlock = { name: 'coal_ore', position: new Vec3(10, 15, 10), boundingBox: 'block' };
      const fireBlock = { name: 'fire', position: new Vec3(10, 14, 10), boundingBox: 'empty' }; // Adjacent Below

      blockMap.set('10,15,10', oreBlock);
      blockMap.set('10,14,10', fireBlock);

      const validation = validateBlockHarvestability(mockBot, oreBlock);

      expect(validation.valid).toBe(false);
      expect(validation.failureKind).toBe('HAZARD_OBSTRUCTION');
      expect(validation.reason).toContain('adjacent to deadly hazard (fire');
    });

    it('rejects ore block with overhead water flooding hazard (HAZARD_OBSTRUCTION)', () => {
      const { mockBot, blockMap } = createMockBot({
        inventory: [{ name: 'iron_pickaxe', count: 1 }],
      });

      const oreBlock = { name: 'iron_ore', position: new Vec3(10, 30, 10), boundingBox: 'block' };
      const waterAbove = { name: 'water', position: new Vec3(10, 31, 10), boundingBox: 'empty' }; // Overhead

      blockMap.set('10,30,10', oreBlock);
      blockMap.set('10,31,10', waterAbove);

      const validation = validateBlockHarvestability(mockBot, oreBlock);

      expect(validation.valid).toBe(false);
      expect(validation.failureKind).toBe('HAZARD_OBSTRUCTION');
      expect(validation.reason).toContain('overhead water (would cause flooding / drowning hazard)');
    });
  });

  // =========================================================================
  // 6. Tool Breakage Detection & Recovery
  // =========================================================================
  describe('6. Tool Breakage Detection & Backup Tool Switching', () => {
    it('halts vein mining cleanly with TOOL_BROKEN when tool breaks and no backup exists', async () => {
      const { mockBot, blockMap, items } = createMockBot({
        botPos: new Vec3(10, 12, 8),
        inventory: [{ name: 'iron_pickaxe', count: 1 }],
      });

      const ore1 = { name: 'diamond_ore', position: new Vec3(10, 12, 10), boundingBox: 'block' };
      const ore2 = { name: 'diamond_ore', position: new Vec3(10, 12, 11), boundingBox: 'block' };
      blockMap.set('10,12,10', ore1);
      blockMap.set('10,12,11', ore2);

      // Simulate pickaxe breaking on first block dig: heldItem becomes null and inventory empty
      mockBot.dig.mockImplementationOnce(async () => {
        mockBot.heldItem = null;
        items.length = 0; // tool broke and removed from inventory
      });

      const ctx = createCtx(mockBot);
      const result = await techniqueMineOreVein(mockBot, ore1, { maxCount: 2 }, ctx);

      // Should complete first block, detect broken tool, and halt rather than punching ore2 with bare hands!
      expect(result.status).toBe('success');
      expect(result.details?.minedCount).toBe(1);
      // Crucial: bot.dig was called only ONCE, never on ore2!
      expect(mockBot.dig).toHaveBeenCalledTimes(1);
    });

    it('auto-equips backup pickaxe from inventory when active pickaxe breaks', async () => {
      const { mockBot, blockMap, items } = createMockBot({
        inventory: [
          { name: 'iron_pickaxe', count: 1 },
          { name: 'iron_pickaxe', count: 1 }, // Backup pickaxe
        ],
      });

      const ore1 = { name: 'iron_ore', position: new Vec3(10, 40, 10), boundingBox: 'block' };
      const ore2 = { name: 'iron_ore', position: new Vec3(10, 40, 11), boundingBox: 'block' };
      blockMap.set('10,40,10', ore1);
      blockMap.set('10,40,11', ore2);

      // First dig breaks tool 1; backup tool 2 remains in inventory
      mockBot.dig.mockImplementationOnce(async () => {
        mockBot.heldItem = null;
        items.shift(); // remove broken pickaxe
        // Add drop
        items.push({ type: 501, name: 'raw_iron', count: 1 });
      });

      mockBot.dig.mockImplementationOnce(async () => {
        // Add drop
        const existing = items.find((i) => i.name === 'raw_iron');
        if (existing) existing.count += 1;
      });

      const ctx = createCtx(mockBot);
      const result = await techniqueMineOreVein(mockBot, ore1, { maxCount: 2 }, ctx);

      expect(result.status).toBe('success');
      expect(result.details?.minedCount).toBe(2);
      expect(result.details?.netDropGain).toBe(2);
      // Auto-equipped backup pickaxe
      expect(mockBot.equip).toHaveBeenCalledTimes(2);
    });
  });

  // =========================================================================
  // 7. Closed-Loop Drop Collection & Inventory Delta Verification
  // =========================================================================
  describe('7. Closed-Loop Inventory Delta Accounting', () => {
    it('verifies actual net drop gain of raw_iron when mining iron_ore', async () => {
      const { mockBot, blockMap, items } = createMockBot({
        inventory: [{ name: 'stone_pickaxe', count: 1 }],
      });

      const ore = { name: 'iron_ore', position: new Vec3(10, 45, 10), boundingBox: 'block' };
      blockMap.set('10,45,10', ore);

      // Simulate dig dropping raw_iron into inventory via vacuum
      mockBot.dig.mockImplementation(async () => {
        items.push({ type: 501, name: 'raw_iron', count: 1 });
      });

      const ctx = createCtx(mockBot);
      const result = await techniqueMineOreVein(mockBot, ore, { maxCount: 1 }, ctx);

      expect(result.status).toBe('success');
      expect(result.details?.minedCount).toBe(1);
      expect(result.details?.expectedDrop).toBe('raw_iron');
      expect(result.details?.netDropGain).toBe(1);
    });

    it('correctly maps expected drops for all major ore blocks', () => {
      expect(getExpectedDropItemName('iron_ore')).toBe('raw_iron');
      expect(getExpectedDropItemName('deepslate_iron_ore')).toBe('raw_iron');
      expect(getExpectedDropItemName('copper_ore')).toBe('raw_copper');
      expect(getExpectedDropItemName('gold_ore')).toBe('raw_gold');
      expect(getExpectedDropItemName('coal_ore')).toBe('coal');
      expect(getExpectedDropItemName('diamond_ore')).toBe('diamond');
      expect(getExpectedDropItemName('lapis_ore')).toBe('lapis_lazuli');
      expect(getExpectedDropItemName('redstone_ore')).toBe('redstone');
      expect(getExpectedDropItemName('stone')).toBe('cobblestone');
      expect(getExpectedDropItemName('clay')).toBe('clay_ball');
    });
  });

  // =========================================================================
  // 8. Surface vs Cave Resource Gathering Separation
  // =========================================================================
  describe('8. Surface vs Cave Gathering Separation', () => {
    it('techniqueGatherSurfaceResource rejects underground/cave blocks below Y=50', async () => {
      const { mockBot, blockMap } = createMockBot({
        inventory: [{ name: 'iron_shovel', count: 1 }],
      });

      // Dirt block deep inside cave at Y=25
      const caveDirt = { name: 'dirt', position: new Vec3(10, 25, 10), boundingBox: 'block' };
      blockMap.set('10,25,10', caveDirt);

      const ctx = createCtx(mockBot);
      const result = await techniqueGatherSurfaceResource(mockBot, 'dirt', 1, ctx);

      // Must NOT mine cave block!
      expect(result.status).toBe('failed');
      expect(result.reason).toContain('No surface dirt found');
      expect(mockBot.dig).not.toHaveBeenCalled();
    });

    it('techniqueGatherSurfaceResource gathers surface dirt at Y=64 in daylight', async () => {
      const { mockBot, blockMap, items } = createMockBot({
        inventory: [{ name: 'iron_shovel', count: 1 }],
      });

      // Surface dirt block at Y=64
      const surfaceDirt = { name: 'dirt', position: new Vec3(10, 64, 10), boundingBox: 'block' };
      blockMap.set('10,64,10', surfaceDirt);

      mockBot.dig.mockImplementation(async () => {
        items.push({ type: 505, name: 'dirt', count: 1 });
      });

      const ctx = createCtx(mockBot);
      const result = await techniqueGatherSurfaceResource(mockBot, 'dirt', 1, ctx);

      expect(result.status).toBe('success');
      expect(result.details?.netCollected).toBe(1);
      expect(mockBot.dig).toHaveBeenCalledTimes(1);
    });
  });
});
