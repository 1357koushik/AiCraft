import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Vec3 } from 'vec3';
import { goals } from 'mineflayer-pathfinder';
import { movementActions } from '../src/actions/movement.js';
import {
  navigateWithBounds,
  evaluateCandidateTarget,
  navigationBlacklist,
  NavigationBlacklist,
} from '../src/actions/navigator.js';
import { ActionExecutionContext, Observation } from '../src/types/index.js';

describe('Navigation & Exploration Reliability Subsystem', () => {
  const mockConfig: any = {
    perception: { scanRadius: 16 },
    safety: { protectedEntities: [] },
  };

  const createMockObservation = (entities: any[] = []): Observation => ({
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
    entities,
    recentEvents: {} as any,
    container: { isOpen: false, type: null, slotsCount: 0, items: [] },
    agentState: { currentGoal: 'Explore', planSteps: [], stepNumber: 1, stuckCounter: 0, timeSinceLastProgressSeconds: 0 },
    memory: { namedLocations: {}, facts: [], dangerZones: [], completedGoals: [] },
    derived: { availableActions: [] },
  });

  const createBaseMockBot = (pos: Vec3 = new Vec3(10, 64, 10)) => {
    const listeners: Record<string, ((...args: any[]) => void)[]> = {};
    return {
      entity: { position: pos },
      inventory: { items: () => [] },
      registry: { blocksByName: {} },
      setControlState: vi.fn(),
      clearControlStates: vi.fn(),
      blockAt: vi.fn().mockImplementation((p: Vec3) => ({ name: 'grass_block', position: p })),
      on: vi.fn((event: string, fn: any) => {
        if (!listeners[event]) listeners[event] = [];
        listeners[event].push(fn);
      }),
      removeListener: vi.fn((event: string, fn: any) => {
        if (listeners[event]) {
          listeners[event] = listeners[event].filter((l) => l !== fn);
        }
      }),
      emit: (event: string, ...args: any[]) => {
        listeners[event]?.forEach((l) => l(...args));
      },
      pathfinder: {
        movements: {
          canDig: true,
          dontMineUnderFallingBlock: true,
          dontCreateFlow: true,
          maxDropDown: 3,
          allowParkour: false,
          allow1by1towers: true,
          blocksToAvoid: new Set(),
          blocksCantBreak: new Set(),
        },
        goto: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn(),
        setGoal: vi.fn(),
        getPathTo: vi.fn().mockReturnValue({ status: 'success', path: [] }),
      },
    };
  };

  beforeEach(() => {
    navigationBlacklist.clear();
  });

  // -------------------------------------------------------------------------
  // 1. Unreachable Target Handling & Blacklist
  // -------------------------------------------------------------------------
  describe('Unreachable Targets & Failed-Target Blacklist', () => {
    it('detects unreachable target via pathfinder preflight (noPath) and blacklists it', async () => {
      const mockBot: any = createBaseMockBot();
      mockBot.pathfinder.getPathTo = vi.fn().mockReturnValue({ status: 'noPath', path: [] });

      const target = new Vec3(20, 64, 20);
      const ctx: ActionExecutionContext = {
        bot: mockBot,
        observation: createMockObservation(),
        config: mockConfig,
      };

      const result = await navigateWithBounds(
        mockBot,
        { target, range: 1.5, preflightCheck: true },
        ctx
      );

      expect(result.status).toBe('unreachable');
      expect(result.failureKind).toBe('UNREACHABLE');
      expect(result.reason).toContain('preflight found no valid path');
      // Verify target coordinate was registered in blacklist
      expect(navigationBlacklist.isBlacklisted(target)).toBe(true);
      // Verify pathfinder.goto was NEVER called since preflight proved it impossible
      expect(mockBot.pathfinder.goto).not.toHaveBeenCalled();
    });

    it('rejects subsequent attempts to a blacklisted target immediately without calling pathfinder', async () => {
      const mockBot: any = createBaseMockBot();
      const target = new Vec3(25, 64, 25);
      navigationBlacklist.recordFailure(target, 'Known cliff obstruction', 'UNREACHABLE', 60_000);

      const ctx: ActionExecutionContext = {
        bot: mockBot,
        observation: createMockObservation(),
        config: mockConfig,
      };

      const gotoAction = movementActions.find((a) => a.name === 'goto')!;
      const result = await gotoAction.execute(mockBot, { x: 25, y: 64, z: 25 }, ctx);

      expect(result.status).toBe('failed');
      expect(result.reason).toContain('blacklisted');
      expect(result.reason).toContain('Known cliff obstruction');
      // No pathfinder goto was called
      expect(mockBot.pathfinder.goto).not.toHaveBeenCalled();
    });

    it('clears expired blacklist entries once TTL passes', async () => {
      const testBlacklist = new NavigationBlacklist(10, 50); // 50ms TTL
      const pos = { x: 12, y: 64, z: 12 };
      testBlacklist.recordFailure(pos, 'Temporary block obstruction');

      expect(testBlacklist.isBlacklisted(pos)).toBe(true);
      expect(testBlacklist.size()).toBe(1);

      // Wait 60ms for TTL to expire
      await new Promise((res) => setTimeout(res, 60));

      expect(testBlacklist.isBlacklisted(pos)).toBe(false);
      expect(testBlacklist.size()).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Progress / Stall Detection
  // -------------------------------------------------------------------------
  describe('No-Progress & Stall Detection', () => {
    it('detects physical stall when bot position fails to advance for stuckThresholdMs', async () => {
      const mockBot: any = createBaseMockBot(new Vec3(10, 64, 10));
      // Simulate goto that stays pending indefinitely without movement
      mockBot.pathfinder.goto = vi.fn().mockImplementation(() => new Promise(() => {}));

      const target = new Vec3(20, 64, 20);
      const ctx: ActionExecutionContext = {
        bot: mockBot,
        observation: createMockObservation(),
        config: mockConfig,
      };

      const navPromise = navigateWithBounds(
        mockBot,
        {
          target,
          range: 1.5,
          stuckThresholdMs: 300, // Short threshold for testing
          timeoutMs: 5000,
        },
        ctx
      );

      const result = await navPromise;
      expect(result.status).toBe('stalled');
      expect(result.failureKind).toBe('STALLED');
      expect(result.reason).toContain('no movement progress');
      expect(mockBot.pathfinder.stop).toHaveBeenCalled();
      expect(mockBot.clearControlStates).toHaveBeenCalled();
      // Target was blacklisted as stalled
      expect(navigationBlacklist.isBlacklisted(target)).toBe(true);
    });

    it('triggers immediate stall recovery when pathfinder emits repeated path_reset "stuck" events', async () => {
      const mockBot: any = createBaseMockBot(new Vec3(10, 64, 10));
      mockBot.pathfinder.goto = vi.fn().mockImplementation(() => new Promise(() => {}));

      const target = new Vec3(30, 64, 30);
      const ctx: ActionExecutionContext = {
        bot: mockBot,
        observation: createMockObservation(),
        config: mockConfig,
      };

      const navPromise = navigateWithBounds(
        mockBot,
        {
          target,
          range: 1.5,
          maxStuckResets: 2,
        },
        ctx
      );

      // Emit two stuck events
      setTimeout(() => {
        mockBot.emit('path_reset', 'stuck');
        mockBot.emit('path_reset', 'stuck');
      }, 50);

      const result = await navPromise;
      expect(result.status).toBe('stalled');
      expect(result.failureKind).toBe('STALLED');
      expect(result.reason).toContain('pathfinder reset with stuck 2 times');
      expect(mockBot.pathfinder.stop).toHaveBeenCalled();
      expect(navigationBlacklist.isBlacklisted(target)).toBe(true);
    });

    it('aborts with timed_out when navigation deadline is exceeded', async () => {
      const mockBot: any = createBaseMockBot(new Vec3(10, 64, 10));
      mockBot.pathfinder.goto = vi.fn().mockImplementation(() => new Promise(() => {}));

      const target = new Vec3(20, 64, 20);
      const ctx: ActionExecutionContext = {
        bot: mockBot,
        observation: createMockObservation(),
        config: mockConfig,
      };

      const result = await navigateWithBounds(
        mockBot,
        {
          target,
          range: 1.5,
          timeoutMs: 350, // 350ms deadline
          stuckThresholdMs: 5000, // Make stall threshold larger than deadline
        },
        ctx
      );

      expect(result.status).toBe('timed_out');
      expect(result.failureKind).toBe('TIMED_OUT');
      expect(result.reason).toContain('deadline exceeded');
      expect(mockBot.pathfinder.stop).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 3. Stale Target & Unloaded Chunk Rejection
  // -------------------------------------------------------------------------
  describe('Stale Target & Chunk Rejection', () => {
    it('rejects navigation target located in an unloaded chunk (blockAt returns null)', async () => {
      const mockBot: any = createBaseMockBot(new Vec3(10, 64, 10));
      mockBot.blockAt = vi.fn().mockReturnValue(null); // Unloaded chunk

      const target = new Vec3(20, 64, 20); // Within scan distance
      const ctx: ActionExecutionContext = {
        bot: mockBot,
        observation: createMockObservation(),
        config: mockConfig,
      };

      const result = await navigateWithBounds(mockBot, { target, range: 1.5 }, ctx);

      expect(result.status).toBe('stale_target');
      expect(result.failureKind).toBe('STALE_TARGET');
      expect(result.reason).toContain('unloaded chunk');
      expect(mockBot.pathfinder.goto).not.toHaveBeenCalled();
    });

    it('rejects stale entity target in goto when entity has despawned from observation', async () => {
      const mockBot: any = createBaseMockBot();
      const obs = createMockObservation([]); // No entities
      const ctx: ActionExecutionContext = { bot: mockBot, observation: obs, config: mockConfig };

      const gotoAction = movementActions.find((a) => a.name === 'goto')!;
      const result = await gotoAction.execute(mockBot, { targetId: 'e42' }, ctx);

      expect(result.status).toBe('failed');
      expect(result.reason).toContain('Target entity e42 not found (stale target)');
    });
  });

  // -------------------------------------------------------------------------
  // 4. Cancellation & Preemption during Navigation
  // -------------------------------------------------------------------------
  describe('Cancellation & Clean Preemption', () => {
    it('halts pathfinder, clears controls and unbinds listeners cleanly on abortSignal', async () => {
      const mockBot: any = createBaseMockBot();
      const abortController = new AbortController();

      mockBot.pathfinder.goto = vi.fn().mockImplementation(() => new Promise(() => {}));

      const target = new Vec3(20, 64, 20);
      const ctx: ActionExecutionContext = {
        bot: mockBot,
        observation: createMockObservation(),
        config: mockConfig,
        abortSignal: abortController.signal,
      };

      const navPromise = navigateWithBounds(mockBot, { target, range: 1.5 }, ctx);

      // Trigger preemption mid-navigation
      setTimeout(() => {
        abortController.abort();
      }, 50);

      const result = await navPromise;
      expect(result.status).toBe('cancelled');
      expect(result.failureKind).toBe('CANCELLED');
      expect(result.reason).toContain('cancelled by preemption signal');
      expect(mockBot.pathfinder.stop).toHaveBeenCalled();
      expect(mockBot.pathfinder.setGoal).toHaveBeenCalledWith(null);
      expect(mockBot.clearControlStates).toHaveBeenCalled();
    });

    it('subsequent navigation is not blocked or cancelled after earlier action was aborted', async () => {
      const mockBot: any = createBaseMockBot();
      const abortController1 = new AbortController();
      abortController1.abort(); // First action aborted

      const ctx1: ActionExecutionContext = {
        bot: mockBot,
        observation: createMockObservation(),
        config: mockConfig,
        abortSignal: abortController1.signal,
      };

      const res1 = await navigateWithBounds(mockBot, { target: new Vec3(15, 64, 15) }, ctx1);
      expect(res1.status).toBe('cancelled');

      // Second new action with its own fresh context
      const ctx2: ActionExecutionContext = {
        bot: mockBot,
        observation: createMockObservation(),
        config: mockConfig,
      };

      mockBot.pathfinder.goto = vi.fn().mockResolvedValue(undefined);
      const res2 = await navigateWithBounds(mockBot, { target: new Vec3(15, 64, 15) }, ctx2);
      expect(res2.status).toBe('arrived');
      expect(res2.success).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 5. Successful Recovery by Selecting a Different Route/Target
  // -------------------------------------------------------------------------
  describe('Recovery via Alternate Candidate Selection', () => {
    it('explore recovers from a stalled or blocked candidate by advancing to the next direction', async () => {
      const mockBot: any = createBaseMockBot(new Vec3(57, 74, -8));
      let attemptCount = 0;

      mockBot.pathfinder.goto = vi.fn().mockImplementation(async (goal: any) => {
        attemptCount++;
        if (attemptCount === 1) {
          // Primary direction (east) fails with NoPath
          const err: any = new Error('No path to the goal!');
          err.name = 'NoPath';
          throw err;
        }
        // Second direction (north) succeeds
      });

      const exploreAction = movementActions.find((a) => a.name === 'explore')!;
      const ctx: ActionExecutionContext = {
        bot: mockBot,
        observation: createMockObservation(),
        config: mockConfig,
      };

      const result = await exploreAction.execute(mockBot, { direction: 'east', distance: 12 }, ctx);

      expect(result.status).toBe('success');
      expect(result.reason).toContain('Explored 12 blocks north (rerouted around blocked east)');
      expect(attemptCount).toBe(2);
      // East coordinate (69, 74, -8) was blacklisted
      expect(navigationBlacklist.isBlacklisted({ x: 69, y: 74, z: -8 }, 1.2, true)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 6. Horizontal vs 3D Elevation Intent (Goal Types)
  // -------------------------------------------------------------------------
  describe('Horizontal vs 3D Elevation Constraint Integrity', () => {
    it('enforces GoalNear (3D) when Y elevation is explicitly specified', async () => {
      let passedGoal: any = null;
      const mockBot: any = createBaseMockBot(new Vec3(10, 64, 10));
      mockBot.pathfinder.goto = vi.fn().mockImplementation(async (goal: any) => {
        passedGoal = goal;
      });

      const gotoAction = movementActions.find((a) => a.name === 'goto')!;
      const ctx: ActionExecutionContext = {
        bot: mockBot,
        observation: createMockObservation(),
        config: mockConfig,
      };

      // Explicit target at depth Y=40 (e.g. underground mine branch within 48 blocks)
      await gotoAction.execute(mockBot, { x: 10, y: 40, z: 10, range: 1 }, ctx);

      expect(passedGoal).toBeInstanceOf(goals.GoalNear);
      expect(passedGoal.y).toBe(40);
      expect(passedGoal instanceof goals.GoalNearXZ).toBe(false);
    });

    it('uses GoalNearXZ only when Y is genuinely omitted (horizontal intent)', async () => {
      let passedGoal: any = null;
      const mockBot: any = createBaseMockBot(new Vec3(10, 64, 10));
      mockBot.pathfinder.goto = vi.fn().mockImplementation(async (goal: any) => {
        passedGoal = goal;
      });

      const gotoAction = movementActions.find((a) => a.name === 'goto')!;
      const ctx: ActionExecutionContext = {
        bot: mockBot,
        observation: createMockObservation(),
        config: mockConfig,
      };

      // Horizontal target without Y
      await gotoAction.execute(mockBot, { x: 25, z: 25, range: 2 }, ctx);

      expect(passedGoal).toBeInstanceOf(goals.GoalNearXZ);
      expect(passedGoal.x).toBe(25);
      expect(passedGoal.z).toBe(25);
    });
  });

  // -------------------------------------------------------------------------
  // 7. Route / Risk Cost Evaluation
  // -------------------------------------------------------------------------
  describe('Candidate Route & Risk Cost Evaluation', () => {
    it('penalizes candidate locations near hostile mobs (e.g. creepers)', () => {
      const mockBot: any = createBaseMockBot(new Vec3(10, 64, 10));
      const creeper = {
        id: 'e1',
        name: 'creeper',
        position: new Vec3(18, 64, 10),
      };
      mockBot.entities = { 1: creeper };

      // Candidate 1: close to creeper at (19, 64, 10)
      const candNearCreeper = new Vec3(19, 64, 10);
      const assess1 = evaluateCandidateTarget(mockBot, candNearCreeper);

      // Candidate 2: safe in opposite direction at (0, 64, 10)
      const candSafe = new Vec3(0, 64, 10);
      const assess2 = evaluateCandidateTarget(mockBot, candSafe);

      expect(assess1.riskFactors).toContain('near_creeper');
      // Score of candidate near creeper must be much higher (more dangerous/costly) than safe candidate
      expect(assess1.score).toBeGreaterThan(assess2.score);
    });
  });
});
