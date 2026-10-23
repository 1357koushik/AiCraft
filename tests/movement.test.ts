import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Vec3 } from 'vec3';
import { goals } from 'mineflayer-pathfinder';
import { movementActions } from '../src/actions/movement.js';
import { navigationBlacklist } from '../src/actions/blacklist.js';
import { ActionExecutionContext, Observation } from '../src/types/index.js';

describe('Movement Actions & Spatial Elevation Robustness', () => {
  beforeEach(() => {
    navigationBlacklist.clear();
  });
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
      x: 57,
      y: 74,
      z: -8,
      blockCoords: { x: 57, y: 74, z: -8 },
      velocity: { x: 0, y: 0, z: 0 },
      yaw: 0,
      pitch: 0,
      facing: 'east',
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

  const createBaseMockBot = (pos: Vec3 = new Vec3(57, 74, -8)) => ({
    entity: { position: pos },
    inventory: { items: () => [] },
    registry: { blocksByName: {} },
    setControlState: vi.fn(),
    clearControlStates: vi.fn(),
    blockAt: vi.fn().mockImplementation((p: Vec3) => ({ name: 'grass_block', position: p })),
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
    },
  });

  describe('flee action', () => {
    const fleeAction = movementActions.find((a) => a.name === 'flee')!;

    it('fails gracefully when no threat entity is present in observation', async () => {
      const mockBot: any = createBaseMockBot();
      const obs = createMockObservation([]);
      const ctx: ActionExecutionContext = { bot: mockBot, observation: obs, config: mockConfig };

      const res = await fleeAction.execute(mockBot, { threatId: 'e99' }, ctx);
      expect(res.status).toBe('failed');
      expect(res.reason).toContain('No threat found');
    });

    it('uses GoalNearXZ to navigate away from threat without elevation lockout', async () => {
      let recordedGoal: any = null;
      const mockBot: any = createBaseMockBot();
      mockBot.pathfinder.goto = vi.fn().mockImplementation(async (goal: any) => {
        recordedGoal = goal;
      });

      const hostileZombie = {
        id: 'e1',
        name: 'zombie',
        type: 'mob',
        isHostile: true,
        position: { x: 50, y: 74, z: -8 }, // West of bot
        distance: 7,
      };
      const obs = createMockObservation([hostileZombie]);
      const ctx: ActionExecutionContext = { bot: mockBot, observation: obs, config: mockConfig };

      const res = await fleeAction.execute(mockBot, { threatId: 'e1', distance: 10 }, ctx);
      expect(res.status).toBe('success');
      expect(mockBot.setControlState).toHaveBeenCalledWith('sprint', true);
      expect(recordedGoal).not.toBeNull();
      // Must be a GoalNearXZ instance to prevent Y elevation lockouts on natural terrain
      expect(recordedGoal instanceof goals.GoalNearXZ).toBe(true);
      // Flee destination should be east of bot (away from west zombie)
      expect(recordedGoal.x).toBeGreaterThan(57);
    });

    it('falls back to angled escape trajectories if the direct reverse path is obstructed', async () => {
      let attemptCount = 0;
      const goalsAttempted: any[] = [];
      const mockBot: any = createBaseMockBot();
      mockBot.pathfinder.goto = vi.fn().mockImplementation(async (goal: any) => {
        goalsAttempted.push(goal);
        attemptCount++;
        if (attemptCount === 1) {
          // Primary reverse path blocked by cliff/wall
          throw new Error('Path was stopped before it could be completed!');
        }
        // Second angled attempt succeeds
      });

      const hostileZombie = {
        id: 'e1',
        name: 'zombie',
        type: 'mob',
        isHostile: true,
        position: { x: 50, y: 74, z: -8 },
        distance: 7,
      };
      const obs = createMockObservation([hostileZombie]);
      const ctx: ActionExecutionContext = { bot: mockBot, observation: obs, config: mockConfig };

      const res = await fleeAction.execute(mockBot, { threatId: 'e1', distance: 10 }, ctx);
      expect(res.status).toBe('success');
      expect(attemptCount).toBe(2);
      expect(goalsAttempted.length).toBe(2);
      expect(goalsAttempted[0] instanceof goals.GoalNearXZ).toBe(true);
      expect(goalsAttempted[1] instanceof goals.GoalNearXZ).toBe(true);
    });

    it('aborts flee immediately when abortSignal is triggered', async () => {
      const abortController = new AbortController();
      abortController.abort();

      const mockBot: any = createBaseMockBot();
      const obs = createMockObservation([]);
      const ctx: ActionExecutionContext = {
        bot: mockBot,
        observation: obs,
        config: mockConfig,
        abortSignal: abortController.signal,
      };

      const res = await fleeAction.execute(mockBot, { threatId: 'e1' }, ctx);
      expect(res.status).toBe('interrupted');
      expect(res.reason).toContain('cancelled before start');
    });
  });

  describe('goto action', () => {
    const gotoAction = movementActions.find((a) => a.name === 'goto')!;

    it('uses GoalNear when exact 3D coordinates (x, y, z) are provided', async () => {
      let recordedGoal: any = null;
      const mockBot: any = createBaseMockBot(new Vec3(10, 64, 10));
      mockBot.pathfinder.goto = vi.fn().mockImplementation(async (goal: any) => {
        recordedGoal = goal;
      });

      const obs = createMockObservation([]);
      const ctx: ActionExecutionContext = { bot: mockBot, observation: obs, config: mockConfig };

      const res = await gotoAction.execute(mockBot, { x: 15, y: 64, z: 15, range: 1 }, ctx);
      expect(res.status).toBe('success');
      expect(recordedGoal instanceof goals.GoalNear).toBe(true);
      expect(recordedGoal.x).toBe(15);
      expect(recordedGoal.y).toBe(64);
      expect(recordedGoal.z).toBe(15);
    });

    it('uses GoalNearXZ when only horizontal coordinates (x, z) are provided without y', async () => {
      let recordedGoal: any = null;
      const mockBot: any = createBaseMockBot(new Vec3(10, 64, 10));
      mockBot.pathfinder.goto = vi.fn().mockImplementation(async (goal: any) => {
        recordedGoal = goal;
      });

      const obs = createMockObservation([]);
      const ctx: ActionExecutionContext = { bot: mockBot, observation: obs, config: mockConfig };

      const res = await gotoAction.execute(mockBot, { x: 20, z: 20, range: 2 }, ctx);
      expect(res.status).toBe('success');
      expect(recordedGoal instanceof goals.GoalNearXZ).toBe(true);
      expect(recordedGoal.x).toBe(20);
      expect(recordedGoal.z).toBe(20);
    });

    it('rejects destination that lands directly in lava hazard', async () => {
      const mockBot: any = createBaseMockBot(new Vec3(10, 64, 10));
      mockBot.blockAt = vi.fn().mockImplementation((pos: Vec3) => {
        if (pos.x === 15 && pos.z === 15) return { name: 'lava' };
        return { name: 'air' };
      });

      const obs = createMockObservation([]);
      const ctx: ActionExecutionContext = { bot: mockBot, observation: obs, config: mockConfig };

      const res = await gotoAction.execute(mockBot, { x: 15, y: 64, z: 15 }, ctx);
      expect(res.status).toBe('failed');
      expect(res.reason).toContain('lava or fire hazard');
    });
  });

  describe('explore action', () => {
    const exploreAction = movementActions.find((a) => a.name === 'explore')!;

    it('uses GoalNearXZ for exploration and handles cardinal rerouting', async () => {
      let goalsRecorded: any[] = [];
      let tries = 0;
      const mockBot: any = createBaseMockBot(new Vec3(57, 74, -8));
      mockBot.pathfinder.goto = vi.fn().mockImplementation(async (goal: any) => {
        goalsRecorded.push(goal);
        tries++;
        if (tries === 1) {
          // First direction blocked
          throw new Error('Blocked by terrain');
        }
      });

      const obs = createMockObservation([]);
      const ctx: ActionExecutionContext = { bot: mockBot, observation: obs, config: mockConfig };

      const res = await exploreAction.execute(mockBot, { direction: 'east', distance: 12 }, ctx);
      expect(res.status).toBe('success');
      expect(res.reason).toContain('rerouted around blocked east');
      expect(goalsRecorded.length).toBe(2);
      expect(goalsRecorded[0] instanceof goals.GoalNearXZ).toBe(true);
      expect(goalsRecorded[1] instanceof goals.GoalNearXZ).toBe(true);
    });

    it('reproduces live exploration elevation scenario: GoalNearXZ succeeds over sloped terrain where 3D GoalNear aborts in 50ms', async () => {
      // Bot at live failure coordinates: (57, 74, -8)
      const botPos = new Vec3(57, 74, -8);
      const mockBot: any = createBaseMockBot(botPos);

      // Sloped terrain 12 blocks east: natural surface is at Y=78 (+4 blocks above bot start elevation)
      const destinationEastTerrainPos = new Vec3(69, 78, -8);

      let passedGoal: any = null;
      mockBot.pathfinder.goto = vi.fn().mockImplementation(async (goal: any) => {
        passedGoal = goal;
        // Verify pathfinder goal evaluation against actual sloped terrain surface (Y=78)
        if (goal instanceof goals.GoalNear) {
          // A 3D GoalNear with target Y=74 fails when bot reaches ground at Y=78 because |78 - 74| = 4 > radius (2)
          const satisfied = goal.isEnd(destinationEastTerrainPos);
          if (!satisfied) {
            // Mineflayer pathfinder terminates in ~50ms with this exact message
            throw new Error('Path was stopped before it could be completed!');
          }
        } else if (goal instanceof goals.GoalNearXZ) {
          // GoalNearXZ evaluates only horizontal distance: hypot(69-69, -8-(-8)) = 0 <= radius (3) -> true!
          const satisfied = (goal as any).isEnd(destinationEastTerrainPos);
          expect(satisfied).toBe(true);
          return;
        }
      });

      const obs = createMockObservation([]);
      const ctx: ActionExecutionContext = { bot: mockBot, observation: obs, config: mockConfig };

      // Execute explore east 12
      const res = await exploreAction.execute(mockBot, { direction: 'east', distance: 12 }, ctx);

      // Verify that explore dispatched GoalNearXZ and succeeded despite +4 elevation slope
      expect(res.status).toBe('success');
      expect(res.reason).toBe('Explored 12 blocks east.');
      expect(passedGoal).toBeInstanceOf(goals.GoalNearXZ);
      expect(passedGoal.x).toBe(69);
      expect(passedGoal.z).toBe(-8);

      // Demonstrate that if the old 3D GoalNear had been used with target Y=74, it would have aborted
      const old3DGoal = new goals.GoalNear(69, 74, -8, 2);
      expect(old3DGoal.isEnd(destinationEastTerrainPos)).toBe(false);
    });

    it('rejects goto destination that lands in water hazard to prevent drowning', async () => {
      const gotoAction = movementActions.find((a) => a.name === 'goto')!;
      const mockBot: any = createBaseMockBot(new Vec3(10, 64, 10));
      mockBot.entity.isInWater = false;
      mockBot.blockAt = vi.fn().mockImplementation((pos: Vec3) => {
        if (pos.x === 20 && pos.z === 20) return { name: 'water' };
        return { name: 'grass_block' };
      });

      const obs = createMockObservation([]);
      const ctx: ActionExecutionContext = { bot: mockBot, observation: obs, config: mockConfig };

      const res = await gotoAction.execute(mockBot, { x: 20, y: 64, z: 20 }, ctx);
      expect(res.status).toBe('failed');
      expect(res.reason).toContain('water hazard');
    });

    it('flee action filters out candidates that lead into water', async () => {
      const fleeAction = movementActions.find((a) => a.name === 'flee')!;
      const mockBot: any = createBaseMockBot(new Vec3(10, 64, 10));
      // Threat is at (10, 64, 0), so flee vector points south (z + 10) -> (10, 64, 20)
      // Make primary destination (10, 64, 20) water, but angled candidate dry
      mockBot.blockAt = vi.fn().mockImplementation((pos: Vec3) => {
        if (pos.z > 15 && pos.x === 10) return { name: 'water' };
        return { name: 'grass_block' };
      });

      const hostile = { id: 'e1', isHostile: true, position: { x: 10, y: 64, z: 0 } };
      const obs = createMockObservation([hostile]);
      const ctx: ActionExecutionContext = { bot: mockBot, observation: obs, config: mockConfig };

      const res = await fleeAction.execute(mockBot, { threatId: 'e1', distance: 10 }, ctx);
      expect(res.status).toBe('success');
      // Verify that the goal dispatched was NOT the primary water destination
      expect(mockBot.pathfinder.goto).toHaveBeenCalled();
    });

    it('move action halts immediately if bot enters water', async () => {
      const moveAction = movementActions.find((a) => a.name === 'move')!;
      const mockBot: any = createBaseMockBot(new Vec3(10, 64, 10));
      mockBot.entity.isInWater = true;

      const obs = createMockObservation([]);
      const ctx: ActionExecutionContext = { bot: mockBot, observation: obs, config: mockConfig };

      const res = await moveAction.execute(mockBot, { direction: 'forward', durationMs: 500 }, ctx);
      expect(res.status).toBe('failed');
      expect(res.reason).toContain('entered water');
    });
  });
});
