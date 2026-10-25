import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Vec3 } from 'vec3';
import {
  detectFreeFallHazard,
  detectSuffocationHazard,
  detectExplosionHazard,
  techniqueWaterBucketClutch,
  techniqueEscapeSuffocation,
  techniqueDefendExplosion,
} from '../src/actions/hazards.js';
import { ReflexLayer } from '../src/agent/reflex.js';
import { ActionArbiter, ActionPriority } from '../src/agent/arbiter.js';
import { SafetySupervisor } from '../src/agent/supervisor.js';
import { loadConfig } from '../src/config/index.js';

describe('Phase 2: Reactive Hazard and Survival Control Hardening', () => {
  const config = loadConfig();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  // =========================================================================
  // 1. Free-Fall Hazard Detection & Water Bucket Clutch Reflex
  // =========================================================================
  describe('1. Free-Fall Hazard Detection & Water Bucket Clutch', () => {
    it('does not trigger fall hazard when bot is grounded or in liquid', () => {
      const mockGroundedBot: any = {
        entity: { position: new Vec3(0, 64, 0), onGround: true, velocity: new Vec3(0, 0, 0) },
      };
      expect(detectFreeFallHazard(mockGroundedBot)).toBeNull();

      const mockWaterBot: any = {
        entity: { position: new Vec3(0, 64, 0), onGround: false, isInWater: true, velocity: new Vec3(0, -0.8, 0) },
      };
      expect(detectFreeFallHazard(mockWaterBot)).toBeNull();

      const mockLavaBot: any = {
        entity: { position: new Vec3(0, 64, 0), onGround: false, isInLava: true, velocity: new Vec3(0, -0.8, 0) },
      };
      expect(detectFreeFallHazard(mockLavaBot)).toBeNull();
    });

    it('does not trigger fall hazard during small normal hops or gentle descent', () => {
      const mockHopBot: any = {
        entity: { position: new Vec3(0, 64, 0), onGround: false, fallDistance: 1.0, velocity: new Vec3(0, -0.1, 0) },
      };
      expect(detectFreeFallHazard(mockHopBot)).toBeNull();
    });

    it('detects critical free-fall when dropping from > 4 blocks height', () => {
      const mockFallBot: any = {
        entity: {
          position: new Vec3(0, 80, 0),
          onGround: false,
          fallDistance: 5.0,
          velocity: new Vec3(0, -0.9, 0),
        },
        blockAt: (pos: Vec3) => {
          if (pos.y <= 70) return { position: pos, boundingBox: 'block', name: 'stone' };
          return { position: pos, boundingBox: 'empty', name: 'air' };
        },
      };

      const signal = detectFreeFallHazard(mockFallBot);
      expect(signal).not.toBeNull();
      expect(signal?.type).toBe('FREE_FALL');
      expect(signal?.severity).toBe('CRITICAL');
      expect(signal?.recommendedAction).toBe('CLUTCH_WATER');
    });

    it('classifies free-fall as FATAL when projected drop >= 15 blocks', () => {
      const mockFatalFallBot: any = {
        entity: {
          position: new Vec3(0, 100, 0),
          onGround: false,
          fallDistance: 16.0,
          velocity: new Vec3(0, -1.8, 0),
        },
        blockAt: (pos: Vec3) => {
          if (pos.y <= 64) return { position: pos, boundingBox: 'block', name: 'dirt' };
          return { position: pos, boundingBox: 'empty', name: 'air' };
        },
      };

      const signal = detectFreeFallHazard(mockFatalFallBot);
      expect(signal).not.toBeNull();
      expect(signal?.type).toBe('FREE_FALL');
      expect(signal?.severity).toBe('FATAL');
    });

    it('executes water bucket clutch successfully to cushion fall damage', async () => {
      const mockWaterBucket = { type: 326, name: 'water_bucket', count: 1 };
      const mockEmptyBucket = { type: 325, name: 'bucket', count: 1 };

      const mockBot: any = {
        entity: { position: new Vec3(10, 75, 10), velocity: new Vec3(0, -1.2, 0) },
        game: { dimension: 'overworld' },
        inventory: {
          items: () => [mockWaterBucket],
        },
        heldItem: null,
        equip: vi.fn().mockImplementation((item) => {
          mockBot.heldItem = item;
          return Promise.resolve();
        }),
        lookAt: vi.fn().mockResolvedValue(undefined),
        activateItem: vi.fn().mockImplementation(() => {
          // Placing water turns bucket into empty bucket
          mockBot.inventory.items = () => [mockEmptyBucket];
        }),
        clearControlStates: vi.fn(),
        blockAt: (pos: Vec3) => {
          if (pos.y <= 64) return { position: pos, boundingBox: 'block', name: 'stone' };
          return { position: pos, boundingBox: 'empty', name: 'air' };
        },
      };

      const result = await techniqueWaterBucketClutch(mockBot);

      expect(result.status).toBe('success');
      expect(mockBot.equip).toHaveBeenCalledWith(mockWaterBucket, 'hand');
      expect(mockBot.lookAt).toHaveBeenCalled();
      expect(mockBot.activateItem).toHaveBeenCalled();
    });

    it('prohibits water bucket clutch in the Nether due to evaporation physics', async () => {
      const mockNetherBot: any = {
        entity: { position: new Vec3(0, 60, 0), velocity: new Vec3(0, -1.0, 0) },
        game: { dimension: 'the_nether' },
        inventory: {
          items: () => [{ name: 'water_bucket', count: 1 }],
        },
      };

      const result = await techniqueWaterBucketClutch(mockNetherBot);
      expect(result.status).toBe('failed');
      expect(result.reason).toContain('prohibited');
    });

    it('steers toward nearby water or soft landing when no water bucket is available', async () => {
      const waterPos = new Vec3(2, 60, 2);
      const mockBot: any = {
        entity: { position: new Vec3(0, 70, 0), velocity: new Vec3(0, -1.0, 0) },
        game: { dimension: 'overworld' },
        inventory: { items: () => [] },
        heldItem: null,
        blockAt: (pos: Vec3) => {
          if (pos.x === waterPos.x && pos.y === waterPos.y && pos.z === waterPos.z) {
            return { position: pos, name: 'water' };
          }
          return { position: pos, name: 'air', boundingBox: 'empty' };
        },
        lookAt: vi.fn().mockResolvedValue(undefined),
        setControlState: vi.fn(),
      };

      const result = await techniqueWaterBucketClutch(mockBot);
      expect(result.status).toBe('failed');
      expect(result.reason).toContain('No water bucket available');
      expect(mockBot.lookAt).toHaveBeenCalled();
      expect(mockBot.setControlState).toHaveBeenCalledWith('forward', true);
    });
  });

  // =========================================================================
  // 2. Suffocation Hazard Detection & Escape Routines
  // =========================================================================
  describe('2. Suffocation Hazard Detection & Escape Routines', () => {
    it('does not trigger suffocation hazard when head is in air or normal open terrain', () => {
      const mockBot: any = {
        entity: { position: new Vec3(0, 64, 0) },
        blockAt: (pos: Vec3) => ({ position: pos, name: 'air', boundingBox: 'empty' }),
      };
      expect(detectSuffocationHazard(mockBot)).toBeNull();
    });

    it('detects suffocation hazard when head shares coordinates with falling gravel or sand', () => {
      const mockGravelBot: any = {
        entity: { position: new Vec3(5, 60, 5) },
        blockAt: (pos: Vec3) => {
          if (pos.y === 61) return { position: pos, name: 'gravel', boundingBox: 'block' };
          return { position: pos, name: 'stone', boundingBox: 'block' };
        },
      };

      const signal = detectSuffocationHazard(mockGravelBot);
      expect(signal).not.toBeNull();
      expect(signal?.type).toBe('SUFFOCATION');
      expect(signal?.severity).toBe('CRITICAL');
      expect(signal?.recommendedAction).toBe('DIG_OUT');
      expect(signal?.details).toContain('gravel');
    });

    it('equips shovel and mines suffocating gravel block immediately', async () => {
      const headGravelBlock = { position: new Vec3(5, 61, 5), name: 'gravel', boundingBox: 'block' };
      const mockShovel = { type: 256, name: 'iron_shovel', count: 1 };

      const mockBot: any = {
        entity: { position: new Vec3(5, 60, 5) },
        inventory: {
          items: () => [mockShovel],
        },
        heldItem: null,
        equip: vi.fn().mockResolvedValue(undefined),
        dig: vi.fn().mockResolvedValue(undefined),
        blockAt: (pos: Vec3) => {
          if (pos.x === 5 && pos.y === 61 && pos.z === 5) return headGravelBlock;
          return { position: pos, name: 'air', boundingBox: 'empty' };
        },
      };

      const result = await techniqueEscapeSuffocation(mockBot);

      expect(result.status).toBe('success');
      expect(mockBot.equip).toHaveBeenCalledWith(mockShovel, 'hand');
      expect(mockBot.dig).toHaveBeenCalledWith(headGravelBlock);
    });
  });

  // =========================================================================
  // 3. Imminent Explosive Threat Detection & Defense
  // =========================================================================
  describe('3. Imminent Explosive Threat Detection & Blast Defense', () => {
    it('detects imminent explosion when creeper is within 3.5m or swelling', () => {
      const mockBot: any = {
        entity: { position: new Vec3(0, 64, 0) },
        entities: {
          99: {
            id: 99,
            name: 'creeper',
            position: new Vec3(2, 64, 0),
            height: 1.7,
            metadata: { 16: 1 }, // swelling state
          },
        },
        inventory: {
          items: () => [{ name: 'shield', count: 1 }],
        },
      };

      const signal = detectExplosionHazard(mockBot);
      expect(signal).not.toBeNull();
      expect(signal?.type).toBe('EXPLOSION_IMMINENT');
      expect(signal?.recommendedAction).toBe('SHIELD_DEPLOY');
    });

    it('recommends sprint retreat when no shield is available against swelling creeper', () => {
      const mockBot: any = {
        entity: { position: new Vec3(0, 64, 0) },
        entities: {
          99: {
            id: 99,
            name: 'creeper',
            position: new Vec3(2.5, 64, 0),
            height: 1.7,
            metadata: { 16: 1 },
          },
        },
        inventory: {
          items: () => [],
        },
      };

      const signal = detectExplosionHazard(mockBot);
      expect(signal).not.toBeNull();
      expect(signal?.recommendedAction).toBe('SPRINT_RETREAT');
    });

    it('deploys shield facing creeper when shield is available', async () => {
      const mockShield = { name: 'shield', count: 1 };
      const mockCreeper = {
        name: 'creeper',
        position: new Vec3(2, 64, 0),
        height: 1.7,
      };

      const mockBot: any = {
        entity: { position: new Vec3(0, 64, 0) },
        inventory: {
          items: () => [mockShield],
        },
        heldItem: null,
        equip: vi.fn().mockResolvedValue(undefined),
        lookAt: vi.fn().mockResolvedValue(undefined),
        activateItem: vi.fn(),
        deactivateItem: vi.fn(),
        clearControlStates: vi.fn(),
      };

      const result = await techniqueDefendExplosion(mockBot, mockCreeper);

      expect(result.status).toBe('success');
      expect(mockBot.equip).toHaveBeenCalledWith(mockShield, 'off-hand');
      expect(mockBot.lookAt).toHaveBeenCalled();
      expect(mockBot.activateItem).toHaveBeenCalledWith(true);
      expect(mockBot.deactivateItem).toHaveBeenCalled();
    });

    it('executes sprint retreat away from creeper when shield is absent', async () => {
      const mockCreeper = {
        name: 'creeper',
        position: new Vec3(1, 64, 0),
        height: 1.7,
      };

      const mockBot: any = {
        entity: { position: new Vec3(0, 64, 0) },
        inventory: { items: () => [] },
        lookAt: vi.fn().mockResolvedValue(undefined),
        setControlState: vi.fn(),
        clearControlStates: vi.fn(),
      };

      const result = await techniqueDefendExplosion(mockBot, mockCreeper);

      expect(result.status).toBe('success');
      expect(mockBot.setControlState).toHaveBeenCalledWith('sprint', true);
      expect(mockBot.setControlState).toHaveBeenCalledWith('forward', true);
      expect(mockBot.setControlState).toHaveBeenCalledWith('jump', true);
      expect(mockBot.clearControlStates).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 4. Reflex Layer & Arbiter Preemption Integration
  // =========================================================================
  describe('4. Reflex Layer & Arbiter Preemption Integration', () => {
    it('preempts normal routine and triggers water bucket clutch on free fall', async () => {
      const arbiter = new ActionArbiter(logger);
      const reflex = new ReflexLayer(config, logger);

      const normalAction = arbiter.startAction('gather_wood', ActionPriority.NORMAL, {} as any, ['movement', 'hands']);
      expect(arbiter.activePriority).toBe(ActionPriority.NORMAL);

      const mockWaterBucket = { type: 326, name: 'water_bucket', count: 1 };
      const mockBot: any = {
        entity: { position: new Vec3(0, 80, 0), onGround: false, fallDistance: 6.0, velocity: new Vec3(0, -1.1, 0) },
        game: { dimension: 'overworld' },
        inventory: { items: () => [mockWaterBucket] },
        heldItem: null,
        equip: vi.fn().mockResolvedValue(undefined),
        lookAt: vi.fn().mockResolvedValue(undefined),
        activateItem: vi.fn(),
        clearControlStates: vi.fn(),
        blockAt: (pos: Vec3) => {
          if (pos.y <= 64) return { position: pos, boundingBox: 'block', name: 'stone' };
          return { position: pos, boundingBox: 'empty', name: 'air' };
        },
      };

      const mockObs: any = {
        vitals: { isAlive: true, underwater: false, oxygen: 20, health: 20, food: 20, movementState: { fallDistance: 6.0 } },
        inventory: { foodList: [], toolSummary: { hasShield: false } },
        entities: [],
      };

      const reflexResult = await reflex.evaluateReflexes(mockBot, mockObs, arbiter);

      expect(reflexResult.triggered).toBe(true);
      expect(reflexResult.name).toBe('water_bucket_clutch');
      expect(normalAction.signal.aborted).toBe(true);
      expect(arbiter.isBusy('hands')).toBe(false); // Released lock after clutch
    });

    it('preempts normal routine and clears suffocation when head is in gravel', async () => {
      const arbiter = new ActionArbiter(logger);
      const reflex = new ReflexLayer(config, logger);

      const normalAction = arbiter.startAction('mine_stone', ActionPriority.NORMAL, {} as any, ['hands', 'look']);

      const mockGravel = { position: new Vec3(0, 65, 0), name: 'gravel', boundingBox: 'block' };
      const mockShovel = { name: 'iron_shovel', count: 1 };

      const mockBot: any = {
        entity: { position: new Vec3(0, 64, 0), onGround: true, velocity: new Vec3(0, 0, 0) },
        inventory: { items: () => [mockShovel] },
        heldItem: null,
        equip: vi.fn().mockResolvedValue(undefined),
        dig: vi.fn().mockResolvedValue(undefined),
        blockAt: (pos: Vec3) => {
          if (pos.y === 65) return mockGravel;
          return { position: pos, name: 'air', boundingBox: 'empty' };
        },
      };

      const mockObs: any = {
        vitals: { isAlive: true, underwater: false, oxygen: 20, health: 20, food: 20, movementState: { onGround: true } },
        inventory: { foodList: [], toolSummary: { hasShield: false } },
        entities: [],
      };

      const reflexResult = await reflex.evaluateReflexes(mockBot, mockObs, arbiter);

      expect(reflexResult.triggered).toBe(true);
      expect(reflexResult.name).toBe('escape_suffocation');
      expect(normalAction.signal.aborted).toBe(true);
      expect(mockBot.dig).toHaveBeenCalledWith(mockGravel);
    });
  });

  // =========================================================================
  // 5. Safety Supervisor Real-Time Asynchronous Dispatch
  // =========================================================================
  describe('5. Safety Supervisor Real-Time Asynchronous Dispatch', () => {
    it('detects free-fall during physicsTick and triggers urgent evaluation', async () => {
      const arbiter = new ActionArbiter(logger);
      const reflex = new ReflexLayer(config, logger);

      let physicsTickHandler: (() => void) | null = null;
      const mockBot: any = {
        entity: { position: new Vec3(0, 80, 0), onGround: false, fallDistance: 5.0, velocity: new Vec3(0, -1.0, 0) },
        on: vi.fn().mockImplementation((event, handler) => {
          if (event === 'physicsTick') physicsTickHandler = handler;
        }),
        removeListener: vi.fn(),
      };

      const supervisor = new SafetySupervisor({
        bot: mockBot,
        arbiter,
        reflexLayer: reflex,
        logger,
        config,
        auditIntervalMs: 250,
      });

      const urgentSpy = vi.spyOn(supervisor, 'requestUrgentEvaluation');
      supervisor.start();

      expect(physicsTickHandler).not.toBeNull();
      physicsTickHandler!();

      expect(urgentSpy).toHaveBeenCalledWith('Free-fall hazard', ActionPriority.SURVIVAL_EMERGENCY);
      supervisor.stop();
    });

    it('detects suffocation during physicsTick and triggers urgent evaluation', async () => {
      const arbiter = new ActionArbiter(logger);
      const reflex = new ReflexLayer(config, logger);

      let physicsTickHandler: (() => void) | null = null;
      const mockBot: any = {
        entity: { position: new Vec3(0, 64, 0), onGround: true, velocity: new Vec3(0, 0, 0) },
        blockAt: (pos: Vec3) => {
          if (pos.y === 65) return { position: pos, name: 'sand', boundingBox: 'block' };
          return { position: pos, name: 'air', boundingBox: 'empty' };
        },
        on: vi.fn().mockImplementation((event, handler) => {
          if (event === 'physicsTick') physicsTickHandler = handler;
        }),
        removeListener: vi.fn(),
      };

      const supervisor = new SafetySupervisor({
        bot: mockBot,
        arbiter,
        reflexLayer: reflex,
        logger,
        config,
        auditIntervalMs: 250,
      });

      const urgentSpy = vi.spyOn(supervisor, 'requestUrgentEvaluation');
      supervisor.start();

      expect(physicsTickHandler).not.toBeNull();
      physicsTickHandler!();

      expect(urgentSpy).toHaveBeenCalledWith('Suffocation hazard', ActionPriority.SURVIVAL_EMERGENCY);
      supervisor.stop();
    });
  });
});
