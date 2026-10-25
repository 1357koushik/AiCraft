import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Vec3 } from 'vec3';
import {
  SURVIVAL_SHELTER_BLUEPRINT,
  calculateShelterBOM,
  resolvePlacementSupport,
  verifyShelterEnclosure,
  techniqueBuildVerifiedShelter,
} from '../src/actions/shelter.js';
import { techniqueBuildShelter } from '../src/actions/techniques.js';
import { ActionArbiter, ActionPriority } from '../src/agent/arbiter.js';
import { ActionExecutionContext, Observation } from '../src/types/index.js';
import { loadConfig } from '../src/config/index.js';

describe('Phase 4: Verified Shelter Blueprint & Closed-Loop Enclosure', () => {
  let config: any;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    config = loadConfig();
    config.logging.level = 'error';
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
      movementState: { onGround: true, inWater: false, isSleeping: false, isRiding: false, inLava: false },
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
      mainInventory: [],
    } as any,
    crosshair: {},
    blocks: { notableBlocks: [], hazards: [], walkability: { forward: true, back: true, left: true, right: true }, localMap: { ascii: '', legend: {} } } as any,
    entities: [],
    recentEvents: {} as any,
    container: { isOpen: false, type: null, slotsCount: 0, items: [] },
    agentState: { currentGoal: 'Build Shelter', planSteps: [], stepNumber: 1, stuckCounter: 0, timeSinceLastProgressSeconds: 0 },
    memory: { namedLocations: {}, facts: [], dangerZones: [], completedGoals: [] },
    derived: { availableActions: [] },
  });

  const createMockBot = (options: {
    inventory?: Array<{ name: string; count: number }>;
    botPos?: Vec3;
    blocks?: Map<string, any>;
    entities?: Record<string, any>;
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
      entities: options.entities || {},
      inventory: {
        items: vi.fn(() => items),
      },
      heldItem: items[0] || null,
      blockAt: vi.fn((p: Vec3) => {
        const key = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
        if (blockMap.has(key)) return blockMap.get(key);
        // Default solid ground at Y=63 (below feet) and air at Y>=64
        if (p.y <= 63) {
          return { name: 'dirt', position: p.clone(), boundingBox: 'block' };
        }
        return { name: 'air', position: p.clone(), boundingBox: 'empty' };
      }),
      equip: vi.fn(async (item: any) => {
        mockBot.heldItem = item;
      }),
      canDigBlock: vi.fn(() => true),
      dig: vi.fn(async (block: any) => {
        const key = `${Math.floor(block.position.x)},${Math.floor(block.position.y)},${Math.floor(block.position.z)}`;
        blockMap.set(key, { name: 'air', position: block.position, boundingBox: 'empty' });
      }),
      placeBlock: vi.fn(async (refBlock: any, faceVector: Vec3) => {
        const placedPos = refBlock.position.plus(faceVector);
        const key = `${Math.floor(placedPos.x)},${Math.floor(placedPos.y)},${Math.floor(placedPos.z)}`;
        const placedBlock = { name: mockBot.heldItem?.name || 'cobblestone', position: placedPos, boundingBox: 'block' };
        blockMap.set(key, placedBlock);

        // Deduct item count
        if (mockBot.heldItem) {
          mockBot.heldItem.count = Math.max(0, mockBot.heldItem.count - 1);
        }
      }),
      clearControlStates: vi.fn(),
    };

    return { mockBot, items, blockMap };
  };

  const createCtx = (mockBot: any, abortSignal?: AbortSignal): ActionExecutionContext => ({
    bot: mockBot,
    observation: createMockObservation(),
    config,
    abortSignal,
    isCurrent: () => !abortSignal?.aborted,
  });

  // =========================================================================
  // 1. Shelter Blueprint & Bill of Materials (BOM)
  // =========================================================================
  describe('1. Blueprint Specification & Bill of Materials (BOM)', () => {
    it('defines explicit 3x3x3 shelter requiring exactly 23 solid blocks (14 walls, 9 roof)', () => {
      const blueprint = SURVIVAL_SHELTER_BLUEPRINT;

      const walls = blueprint.blocks.filter((b) => b.role === 'wall');
      const roof = blueprint.blocks.filter((b) => b.role === 'roof');
      const interior = blueprint.blocks.filter((b) => b.role === 'interior');
      const doorway = blueprint.blocks.filter((b) => b.role === 'doorway');

      expect(walls.length).toBe(14); // 7 lower + 7 upper
      expect(roof.length).toBe(9);   // 3x3 ceiling slab
      expect(interior.length).toBe(2); // 1x2 standing space
      expect(doorway.length).toBe(2);  // 1x2 doorway opening
      expect(walls.length + roof.length).toBe(23);
    });

    it('calculates BOM feasibility and rejects construction when inventory lacks sufficient blocks', async () => {
      const { mockBot } = createMockBot({
        inventory: [{ name: 'cobblestone', count: 10 }], // Only 10 available, need 23
      });

      const bom = calculateShelterBOM(mockBot);

      expect(bom.feasible).toBe(false);
      expect(bom.requiredTotal).toBe(23);
      expect(bom.availableTotal).toBe(10);

      const ctx = createCtx(mockBot);
      const result = await techniqueBuildVerifiedShelter(mockBot, {}, ctx);

      expect(result.status).toBe('failed');
      expect(result.reason).toContain('Insufficient building materials');
      expect(result.reason).toContain('need 23 solid blocks, but only 10 available');
      expect(mockBot.placeBlock).not.toHaveBeenCalled();
    });

    it('accounts for reserved materials when computing BOM availability', () => {
      const { mockBot } = createMockBot({
        inventory: [
          { name: 'cobblestone', count: 30 }, // 30 in inventory, but 15 reserved for furnace!
        ],
      });

      const reservedMaterials = { cobblestone: 15 };
      const bom = calculateShelterBOM(mockBot, SURVIVAL_SHELTER_BLUEPRINT, reservedMaterials);

      // Available is 30 - 15 = 15 < 23 -> Not feasible!
      expect(bom.availableTotal).toBe(15);
      expect(bom.feasible).toBe(false);
    });
  });

  // =========================================================================
  // 2. Placement Support & Dynamic Reference Face Resolution
  // =========================================================================
  describe('2. Placement Support & Face Reference Resolution', () => {
    it('resolves support from solid block below with upward face vector (0, 1, 0)', () => {
      const { mockBot, blockMap } = createMockBot();
      const targetPos = new Vec3(10, 64, 10);
      // Floor block at (10, 63, 10)
      blockMap.set('10,63,10', { name: 'stone', position: new Vec3(10, 63, 10), boundingBox: 'block' });

      const support = resolvePlacementSupport(mockBot, targetPos);

      expect(support.valid).toBe(true);
      expect(support.refBlock?.position.equals(new Vec3(10, 63, 10))).toBe(true);
      expect(support.placeVector?.equals(new Vec3(0, 1, 0))).toBe(true);
    });

    it('resolves side neighbor support with correct opposite face vector when placing cantilevered roof', () => {
      const { mockBot, blockMap } = createMockBot();
      // Placing roof block at (10, 66, 11); support comes from already placed wall at (10, 66, 10) [South]
      const targetPos = new Vec3(10, 66, 11);
      const neighborWall = { name: 'cobblestone', position: new Vec3(10, 66, 10), boundingBox: 'block' };
      blockMap.set('10,66,10', neighborWall);

      const support = resolvePlacementSupport(mockBot, targetPos);

      expect(support.valid).toBe(true);
      expect(support.refBlock?.position.equals(neighborWall.position)).toBe(true);
      // Face vector pointing from (10, 66, 10) to (10, 66, 11) is (0, 0, 1)
      expect(support.placeVector?.equals(new Vec3(0, 0, 1))).toBe(true);
    });

    it('rejects placement when neighbor is air or hazardous lava', () => {
      const { mockBot, blockMap } = createMockBot();
      const targetPos = new Vec3(15, 64, 15);
      // Air below
      blockMap.set('15,63,15', { name: 'air', boundingBox: 'empty' });
      // Lava to the side
      blockMap.set('15,64,14', { name: 'lava', boundingBox: 'empty' });

      const support = resolvePlacementSupport(mockBot, targetPos);

      expect(support.valid).toBe(false);
      expect(support.reason).toContain('No solid support neighbor found');
    });
  });

  // =========================================================================
  // 3. Safe Resumption After Interruption
  // =========================================================================
  describe('3. Safe Resumption After Interruption', () => {
    it('resumes safely from absolute world anchor and skips already placed blocks', async () => {
      const anchorPos = new Vec3(10, 64, 10);
      const { mockBot, blockMap } = createMockBot({
        inventory: [{ name: 'cobblestone', count: 32 }],
        botPos: anchorPos,
      });

      // Session 1: Pre-place 10 blocks (lower walls) as if interrupted mid-build
      let count = 0;
      for (const b of SURVIVAL_SHELTER_BLUEPRINT.blocks) {
        if (b.role === 'wall' && count < 10) {
          const wPos = anchorPos.offset(b.relX, b.relY, b.relZ);
          blockMap.set(`${wPos.x},${wPos.y},${wPos.z}`, { name: 'cobblestone', position: wPos, boundingBox: 'block' });
          count++;
        }
      }

      // Verify initial inspection reports incomplete
      const inspectionBefore = verifyShelterEnclosure(mockBot, anchorPos);
      expect(inspectionBefore.isFullyEnclosed).toBe(false);
      expect(inspectionBefore.placedCount).toBe(10);
      expect(inspectionBefore.missingBlocks.length).toBe(13); // 23 - 10 = 13 missing

      // Session 2: Resume building
      const ctx = createCtx(mockBot);
      const result = await techniqueBuildVerifiedShelter(mockBot, { anchorPos }, ctx);

      expect(result.status).toBe('success');
      // Placed only the remaining 13 blocks in this session!
      expect(result.details?.placedInSession).toBe(13);

      // Verify final inspection confirms 100% complete
      const inspectionAfter = verifyShelterEnclosure(mockBot, anchorPos);
      expect(inspectionAfter.isFullyEnclosed).toBe(true);
      expect(inspectionAfter.missingBlocks.length).toBe(0);
      expect(inspectionAfter.placedCount).toBe(23);
    });

    it('handles abort signal cancellation during construction without corrupting anchor state', async () => {
      const anchorPos = new Vec3(20, 64, 20);
      const { mockBot } = createMockBot({
        inventory: [{ name: 'dirt', count: 30 }],
        botPos: anchorPos,
      });

      const abortController = new AbortController();
      const ctx = createCtx(mockBot, abortController.signal);

      // Abort after placing 3 blocks
      let placeCount = 0;
      mockBot.placeBlock.mockImplementation(async (ref: any, vec: Vec3) => {
        placeCount++;
        if (placeCount >= 3) {
          abortController.abort();
        }
      });

      const result = await techniqueBuildVerifiedShelter(mockBot, { anchorPos }, ctx);

      expect(result.status).toBe('interrupted');
      expect(result.reason).toContain('interrupted by higher-priority signal');
    });
  });

  // =========================================================================
  // 4. Closed-Loop Physical Enclosure Verification
  // =========================================================================
  describe('4. Closed-Loop Physical Enclosure Verification', () => {
    it('detects missing wall block and rejects enclosure even if placement function succeeded', () => {
      const anchorPos = new Vec3(10, 64, 10);
      const { mockBot, blockMap } = createMockBot({ botPos: anchorPos });

      // Place 22 of 23 blocks (missing 1 roof block at corner)
      for (const b of SURVIVAL_SHELTER_BLUEPRINT.blocks) {
        if (b.role === 'wall' || b.role === 'roof') {
          // Intentionally omit roof block at (1, 2, 1)
          if (b.relX === 1 && b.relY === 2 && b.relZ === 1) continue;

          const wPos = anchorPos.offset(b.relX, b.relY, b.relZ);
          blockMap.set(`${wPos.x},${wPos.y},${wPos.z}`, { name: 'cobblestone', position: wPos, boundingBox: 'block' });
        }
      }

      const report = verifyShelterEnclosure(mockBot, anchorPos);

      expect(report.isFullyEnclosed).toBe(false);
      expect(report.roofComplete).toBe(false);
      expect(report.wallsComplete).toBe(true);
      expect(report.missingBlocks.length).toBe(1);
      expect(report.missingBlocks[0].equals(anchorPos.offset(1, 2, 1))).toBe(true);
      expect(report.reason).toContain('Roof incomplete (8/9)');
    });

    it('verifies complete 3x3x3 shelter enclosure when all 23 blocks are placed correctly', () => {
      const anchorPos = new Vec3(10, 64, 10);
      const { mockBot, blockMap } = createMockBot({ botPos: anchorPos });

      // Place all 23 blocks
      for (const b of SURVIVAL_SHELTER_BLUEPRINT.blocks) {
        if (b.role === 'wall' || b.role === 'roof') {
          const wPos = anchorPos.offset(b.relX, b.relY, b.relZ);
          blockMap.set(`${wPos.x},${wPos.y},${wPos.z}`, { name: 'stone', position: wPos, boundingBox: 'block' });
        }
      }

      const report = verifyShelterEnclosure(mockBot, anchorPos);

      expect(report.isFullyEnclosed).toBe(true);
      expect(report.wallsComplete).toBe(true);
      expect(report.roofComplete).toBe(true);
      expect(report.interiorClear).toBe(true);
      expect(report.doorwayValid).toBe(true);
      expect(report.missingBlocks.length).toBe(0);
      expect(report.reason).toContain('Verified complete survival shelter enclosure');
    });
  });

  // =========================================================================
  // 5. Immediate Nearby Threat Detection & Shelter Safety
  // =========================================================================
  describe('5. Threat Detection & Safe Shelter Certification', () => {
    it('flags shelter as not safe when hostile mob is detected immediately outside (within 6m)', () => {
      const anchorPos = new Vec3(10, 64, 10);
      const { mockBot, blockMap } = createMockBot({
        botPos: anchorPos,
        entities: {
          creeper1: {
            name: 'creeper',
            type: 'mob',
            position: new Vec3(10, 64, 13), // 3m from shelter entrance!
            isValid: true,
          },
        },
      });

      // Complete all 23 blocks
      for (const b of SURVIVAL_SHELTER_BLUEPRINT.blocks) {
        if (b.role === 'wall' || b.role === 'roof') {
          const wPos = anchorPos.offset(b.relX, b.relY, b.relZ);
          blockMap.set(`${wPos.x},${wPos.y},${wPos.z}`, { name: 'cobblestone', position: wPos, boundingBox: 'block' });
        }
      }

      const report = verifyShelterEnclosure(mockBot, anchorPos);

      // Physically enclosed, but NOT exterior safe
      expect(report.isFullyEnclosed).toBe(true);
      expect(report.exteriorSafe).toBe(false);
      expect(report.nearbyThreats.length).toBe(1);
      expect(report.nearbyThreats[0]).toContain('creeper');
      expect(report.reason).toContain('immediate exterior threats detected');
    });

    it('certifies shelter as secure when enclosed and zero hostiles nearby', () => {
      const anchorPos = new Vec3(10, 64, 10);
      const { mockBot, blockMap } = createMockBot({
        botPos: anchorPos,
        entities: {
          cow1: { name: 'cow', type: 'animal', position: new Vec3(11, 64, 11), isValid: true }, // Passive mob
        },
      });

      for (const b of SURVIVAL_SHELTER_BLUEPRINT.blocks) {
        if (b.role === 'wall' || b.role === 'roof') {
          const wPos = anchorPos.offset(b.relX, b.relY, b.relZ);
          blockMap.set(`${wPos.x},${wPos.y},${wPos.z}`, { name: 'cobblestone', position: wPos, boundingBox: 'block' });
        }
      }

      const report = verifyShelterEnclosure(mockBot, anchorPos);

      expect(report.isFullyEnclosed).toBe(true);
      expect(report.exteriorSafe).toBe(true);
      expect(report.nearbyThreats.length).toBe(0);
      expect(report.reason).toContain('no immediate exterior threats');
    });
  });

  // =========================================================================
  // 6. Local-Server Simulated Scenario: Autonomous Shelter Build
  // =========================================================================
  describe('6. Local-Server Scenario: End-to-End Verified Shelter Build', () => {
    it('executes full autonomous shelter build under ActionArbiter and confirms physical enclosure', async () => {
      const startPos = new Vec3(30, 64, 30);
      const { mockBot } = createMockBot({
        inventory: [{ name: 'cobblestone', count: 32 }],
        botPos: startPos,
      });

      const arbiter = new ActionArbiter(logger);
      const action = arbiter.startAction('build_shelter', ActionPriority.NORMAL, mockBot, ['movement', 'hands']);

      const ctx: ActionExecutionContext = {
        bot: mockBot,
        observation: createMockObservation(),
        config,
        abortSignal: action.signal,
        isCurrent: () => !action.signal.aborted,
      };

      const result = await techniqueBuildVerifiedShelter(mockBot, { anchorPos: startPos }, ctx);

      expect(result.status).toBe('success');
      expect(result.details?.placedInSession).toBe(23);
      expect(result.details?.inspection.isFullyEnclosed).toBe(true);
      expect(result.details?.inspection.roofComplete).toBe(true);
      expect(result.details?.inspection.wallsComplete).toBe(true);

      arbiter.finishAction(action.actionId, action.epoch, mockBot);
      expect(mockBot.clearControlStates).toHaveBeenCalled();
    });

    it('techniqueBuildShelter delegates to verified enclosure builder and places all 23 blocks', async () => {
      const startPos = new Vec3(40, 64, 40);
      const { mockBot } = createMockBot({
        inventory: [{ name: 'dirt', count: 32 }],
        botPos: startPos,
      });

      const result = await techniqueBuildShelter(mockBot);

      expect(result.status).toBe('success');
      expect(result.reason).toContain('23 blocks placed');
      expect(result.details?.inspection.isFullyEnclosed).toBe(true);
      expect(result.details?.buildResult.blocksPlaced).toBe(23);
      expect(result.details?.buildResult.expectedBlocks).toBe(23);
    });

    it('pre-clears foliage and soft vegetation in shelter footprint before block placement', async () => {
      const startPos = new Vec3(50, 64, 50);
      const { mockBot, blockMap } = createMockBot({
        inventory: [{ name: 'cobblestone', count: 32 }],
        botPos: startPos,
      });

      // Place tall grass at interior position (50, 64, 50) and doorway (50, 64, 51)
      blockMap.set('50,64,50', { name: 'short_grass', position: new Vec3(50, 64, 50), boundingBox: 'empty' });
      blockMap.set('50,64,51', { name: 'tall_grass', position: new Vec3(50, 64, 51), boundingBox: 'empty' });

      const result = await techniqueBuildShelter(mockBot);

      expect(result.status).toBe('success');
      expect(mockBot.dig).toHaveBeenCalled();
      expect(result.details?.buildResult.unobstructedInterior).toBe(true);
      expect(result.details?.inspection.isFullyEnclosed).toBe(true);
    });

    it('includes entryOffset and torchOffset metadata on SURVIVAL_SHELTER_BLUEPRINT', () => {
      expect(SURVIVAL_SHELTER_BLUEPRINT.dimensions).toEqual({ width: 3, height: 3, depth: 3 });
      expect(SURVIVAL_SHELTER_BLUEPRINT.interiorOffset).toBeDefined();
      expect(SURVIVAL_SHELTER_BLUEPRINT.entryOffset).toBeDefined();
      expect(SURVIVAL_SHELTER_BLUEPRINT.torchOffset).toBeDefined();
    });
  });
});
