import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Vec3 } from 'vec3';
import {
  techniqueChopTreeFull,
  findConnectedTreeLogs,
  failedTreeBlacklist,
  clearFailedTreeBlacklist,
  countMatchingLogsInInventory,
  isLogBlockName,
  isLogItemName,
} from '../src/actions/techniques.js';
import { parseAndValidateGoalSpec } from '../src/agent/goals.js';
import { AgentController } from '../src/agent/loop.js';
import { loadConfig } from '../src/config/index.js';
import { MemoryManager } from '../src/memory/index.js';
import { SafetyManager } from '../src/safety/index.js';
import { AgentLogger } from '../src/utils/logger.js';

describe('Milestone 1 Acceptance: Autonomous "gather 32 logs" Pipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearFailedTreeBlacklist();
  });

  // =========================================================================
  // 1. Definition and Semantics: "gather 32 logs"
  // =========================================================================
  describe('1. Delta vs. Absolute Target Semantics', () => {
    it('defines "gather 32 logs" as a requested delta (+32 logs) above starting baseline', () => {
      const startingInventory = { oak_log: 4 };
      const spec = parseAndValidateGoalSpec('gather 32 logs', startingInventory, true);

      expect(spec).not.toBeNull();
      expect(spec?.kind).toBe('have');
      if (spec?.kind === 'have') {
        expect(spec.item).toBe('oak_log');
        expect(spec.count).toBe(32);
        expect(spec.mode).toBe('additional');
        expect(spec.baselineCount).toBe(4);
        // Target total is baseline (4) + delta (32) = 36 logs
        const targetTotal = spec.mode === 'additional' ? spec.baselineCount + spec.count : spec.count;
        expect(targetTotal).toBe(36);
      }
    });

    it('matches all 9 standard Minecraft Java 1.21.6 log item and block types', () => {
      const validLogs = [
        'oak_log',
        'birch_log',
        'spruce_log',
        'jungle_log',
        'acacia_log',
        'dark_oak_log',
        'mangrove_log',
        'cherry_log',
        'pale_oak_log',
      ];

      for (const logName of validLogs) {
        expect(isLogBlockName(logName)).toBe(true);
        expect(isLogItemName(logName)).toBe(true);
      }

      // Non-logs must be rejected
      expect(isLogBlockName('oak_planks')).toBe(false);
      expect(isLogBlockName('oak_leaves')).toBe(false);
      expect(isLogBlockName('stone')).toBe(false);
    });
  });

  // =========================================================================
  // 2. Tree Shape Traversal (Bounded Tree BFS)
  // =========================================================================
  describe('2. Bounded Tree Shape Traversal', () => {
    it('discovers connected trunk and canopy branch logs, bounded to 16 blocks, sorted Y ascending', () => {
      // Create a mock tree with trunk at (10, 64..67, 10) and branch at (11, 67, 10)
      const blocks: Record<string, any> = {
        '10,64,10': { name: 'oak_log', position: new Vec3(10, 64, 10) },
        '10,65,10': { name: 'oak_log', position: new Vec3(10, 65, 10) },
        '10,66,10': { name: 'oak_log', position: new Vec3(10, 66, 10) },
        '10,67,10': { name: 'oak_log', position: new Vec3(10, 67, 10) },
        '11,67,10': { name: 'oak_log', position: new Vec3(11, 67, 10) }, // canopy branch
        '10,68,10': { name: 'oak_leaves', position: new Vec3(10, 68, 10) }, // leaves (not log)
      };

      const mockBot: any = {
        blockAt: (pos: Vec3) => blocks[`${pos.x},${pos.y},${pos.z}`] || null,
      };

      const baseLog = blocks['10,64,10'];
      const treeLogs = findConnectedTreeLogs(mockBot, baseLog, 16);

      // Discovered all 5 connected logs (4 trunk + 1 branch), ignoring leaves
      expect(treeLogs.length).toBe(5);
      expect(treeLogs[0].position.y).toBe(64); // lowest base first
      expect(treeLogs[4].position.y).toBe(67); // canopy last
    });

    it('regression: resolves true base trunk and discovers all lower logs even when traversal starts from canopy branch', () => {
      const blocks: Record<string, any> = {
        '10,64,10': { name: 'oak_log', position: new Vec3(10, 64, 10) },
        '10,65,10': { name: 'oak_log', position: new Vec3(10, 65, 10) },
        '10,66,10': { name: 'oak_log', position: new Vec3(10, 66, 10) },
        '10,67,10': { name: 'oak_log', position: new Vec3(10, 67, 10) },
        '11,67,10': { name: 'oak_log', position: new Vec3(11, 67, 10) }, // canopy branch
      };

      const mockBot: any = {
        blockAt: (pos: Vec3) => blocks[`${pos.x},${pos.y},${pos.z}`] || null,
      };

      // Start traversal from canopy branch log at Y=67
      const canopyLog = blocks['11,67,10'];
      const treeLogs = findConnectedTreeLogs(mockBot, canopyLog, 16);

      // Must traverse downward and include lower trunk logs down to Y=64
      expect(treeLogs.length).toBe(5);
      expect(treeLogs[0].position.y).toBe(64);
      expect(treeLogs[0].position.x).toBe(10);
      expect(treeLogs[0].position.z).toBe(10);
    });
  });

  // =========================================================================
  // 3. Candidate Selection, Reachability & Anti-Blacklisting
  // =========================================================================
  describe('3. Reachability & Target Blacklisting', () => {
    it('blacklists unreachable tree and advances to next reachable candidate without repeating failure', async () => {
      const unreachableTreePos = new Vec3(5, 64, 5);
      const reachableTreePos = new Vec3(12, 64, 12);

      let approachAttempts: string[] = [];

      const mockBot: any = {
        entity: { position: new Vec3(0, 64, 0) },
        entities: {},
        inventory: {
          items: () => [],
          emptySlotCount: () => 35,
        },
        findBlocks: vi.fn().mockReturnValue([unreachableTreePos, reachableTreePos]),
        blockAt: (pos: Vec3) => {
          if (pos.equals(unreachableTreePos)) return { name: 'oak_log', position: unreachableTreePos };
          if (pos.equals(reachableTreePos)) return { name: 'oak_log', position: reachableTreePos };
          return null;
        },
        pathfinder: {
          goto: vi.fn().mockImplementation(async (goal: any) => {
            // Unreachable tree fails pathfinding
            if (goal.x === 5 && goal.z === 5) {
              if (!approachAttempts.includes('5,64,5')) approachAttempts.push('5,64,5');
              throw new Error('Path unreachable: obstacle canyon');
            }
            if (goal.x === 12 && goal.z === 12) {
              if (!approachAttempts.includes('12,64,12')) approachAttempts.push('12,64,12');
              return; // Success
            }
          }),
          stop: vi.fn(),
        },
        dig: vi.fn().mockImplementation(async (block: any) => {
          // Add 1 log to inventory upon dig
          mockBot.inventory.items = () => [{ name: 'oak_log', count: 1 }];
        }),
        clearControlStates: vi.fn(),
        setControlState: vi.fn(),
      };

      const res = await techniqueChopTreeFull(mockBot, 48, undefined, undefined, { count: 1 });

      // Unreachable tree (5,64,5) was attempted, blacklisted, and bot advanced to (12,64,12)
      expect(approachAttempts).toEqual(['5,64,5', '12,64,12']);
      expect(failedTreeBlacklist.has('5,64,5')).toBe(true);
      expect(res.status).toBe('success');
    });
  });

  // =========================================================================
  // 4. Inventory Capacity & Full Inventory Handling
  // =========================================================================
  describe('4. Inventory Capacity & Full Inventory Guard', () => {
    it('returns structured failure when inventory is completely full with no room for logs', async () => {
      const mockBot: any = {
        entity: { position: new Vec3(0, 64, 0) },
        entities: {},
        inventory: {
          emptySlotCount: () => 0, // 0 free slots
          items: () => [{ name: 'cobblestone', count: 64 }], // No partial log stack
        },
        blockAt: () => ({ name: 'oak_log', position: new Vec3(10, 64, 10) }),
        findBlock: () => ({ name: 'oak_log', position: new Vec3(10, 64, 10) }),
        findBlocks: () => [new Vec3(10, 64, 10)],
      };

      const res = await techniqueChopTreeFull(mockBot, 48, undefined, undefined, { count: 32 });

      expect(res.status).toBe('failed');
      expect(res.reason).toContain('Inventory is full');
      expect(res.details?.failureKind).toBe('INVENTORY_FULL');
    });
  });

  // =========================================================================
  // 5. Yielding to Safety & Cancellation
  // =========================================================================
  describe('5. Yielding to Cancellation & Preemption', () => {
    it('halts immediately when abortSignal is triggered during tree chopping', async () => {
      const abortController = new AbortController();

      const mockBot: any = {
        entity: { position: new Vec3(0, 64, 0) },
        entities: {},
        inventory: {
          emptySlotCount: () => 36,
          items: () => [],
        },
        findBlocks: () => [new Vec3(5, 64, 5)],
        blockAt: () => ({ name: 'oak_log', position: new Vec3(5, 64, 5) }),
        pathfinder: {
          goto: vi.fn().mockImplementation(async () => {
            // Signal preemption / cancellation mid-path
            abortController.abort();
          }),
          stop: vi.fn(),
        },
        clearControlStates: vi.fn(),
      };

      const res = await techniqueChopTreeFull(
        mockBot,
        48,
        abortController.signal,
        undefined,
        { count: 32 }
      );

      expect(res.status).toBe('interrupted');
      expect(res.reason).toContain('cancelled');
    });
  });

  // =========================================================================
  // 6. Milestone Acceptance Scenario: Gather 32 Logs End-to-End
  // =========================================================================
  describe('6. Milestone Acceptance: Gather 32 Logs End-to-End Execution', () => {
    it('gathers 32 logs across multiple trees without LLM micromanagement and verifies postcondition', async () => {
      let currentLogCount = 0;
      let treeIdx = 0;

      // Define 7 distinct trees scattered in the forest, each giving 5 logs
      const treePositions = [
        new Vec3(10, 64, 10),
        new Vec3(20, 64, 15),
        new Vec3(30, 64, 25),
        new Vec3(15, 64, 35),
        new Vec3(25, 64, 45),
        new Vec3(35, 64, 55),
        new Vec3(45, 64, 60),
      ];

      const mockBot: any = {
        entity: { position: new Vec3(0, 64, 0) },
        entities: {},
        inventory: {
          emptySlotCount: () => 30,
          items: () => (currentLogCount > 0 ? [{ name: 'oak_log', count: currentLogCount }] : []),
        },
        findBlocks: vi.fn().mockImplementation(() => {
          // Return remaining unharvested tree positions
          return treePositions.slice(treeIdx);
        }),
        blockAt: vi.fn().mockImplementation((pos: Vec3) => {
          // Return log block for active tree
          return { name: 'oak_log', position: pos };
        }),
        pathfinder: {
          goto: vi.fn().mockResolvedValue(undefined),
          stop: vi.fn(),
        },
        dig: vi.fn().mockImplementation(async () => {
          // Each cut increments inventory
          currentLogCount++;
          if (currentLogCount % 5 === 0) {
            treeIdx++; // Finished this tree, advance to next
          }
        }),
        clearControlStates: vi.fn(),
        setControlState: vi.fn(),
      };

      // Execute gathering 32 logs
      const result = await techniqueChopTreeFull(mockBot, 48, undefined, undefined, { count: 32 });

      expect(result.status).toBe('success');
      expect(currentLogCount).toBeGreaterThanOrEqual(32);
      expect(result.reason).toContain('Harvested');
      expect(result.details?.collected).toBeGreaterThanOrEqual(32);
    }, 15000);

    it('end-to-end: owner issues "gather 32 logs" once, agent controller resolves deterministically, bypasses LLM, and succeeds', async () => {
      let chatCb: Function | null = null;
      let botLogCount = 0;

      const mockBot: any = {
        username: 'BotPlayer',
        on: vi.fn().mockImplementation((event: string, cb: Function) => {
          if (event === 'chat') chatCb = cb;
        }),
        chat: vi.fn(),
        health: 20,
        food: 20,
        oxygenLevel: 20,
        isAlive: true,
        game: { gameMode: 'survival' },
        entity: { position: new Vec3(0, 64, 0), onGround: true },
        entities: {},
        inventory: {
          slots: [],
          items: () => (botLogCount > 0 ? [{ name: 'oak_log', count: botLogCount }] : []),
          emptySlotCount: () => 34,
        },
        registry: { blocksByName: {}, items: {}, itemsByName: {}, effects: {} },
        time: { timeOfDay: 1000, age: 24000 },
        findBlocks: vi.fn().mockReturnValue([new Vec3(8, 64, 8)]),
        findBlock: vi.fn().mockReturnValue({ name: 'oak_log', position: new Vec3(8, 64, 8) }),
        blockAt: vi.fn().mockReturnValue({ name: 'oak_log', position: new Vec3(8, 64, 8), boundingBox: 'block' }),
        blockAtCursor: vi.fn().mockReturnValue(null),
        entityAtCursor: vi.fn().mockReturnValue(null),
        recipesAll: vi.fn().mockReturnValue([]),
        recipesFor: vi.fn().mockReturnValue([]),
        setControlState: vi.fn(),
        clearControlStates: vi.fn(),
        pathfinder: { stop: vi.fn(), setGoal: vi.fn(), goto: vi.fn().mockResolvedValue(undefined) },
        dig: vi.fn().mockImplementation(async () => {
          botLogCount = 32; // Simulates successfully chopping and vacuuming logs up to 32
        }),
      };

      const config = loadConfig();
      config.agent.owners = ['LegitOwner'];
      const memory = new MemoryManager('test_world_gather_32', './data_test_gather_32');
      const mockLLM = {
        name: 'MockLLM',
        generateDecision: vi.fn(), // Must NOT be called!
      };

      const controller = new AgentController(
        mockBot,
        config,
        new AgentLogger(config),
        memory,
        new SafetyManager(config),
        mockLLM as any
      );

      // 1. Owner issues "gather 32 logs" once
      chatCb!('LegitOwner', 'gather 32 logs');

      expect(controller.goalExecutor.hasActiveGoal()).toBe(true);
      expect(controller.goalExecutor.activeGoal?.kind).toBe('have');

      // 2. Controller executes step: Deterministic goal resolution runs chop_tree(count: 32)
      await (controller as any).step();

      // Zero LLM calls were made!
      expect(mockLLM.generateDecision).not.toHaveBeenCalled();

      // Inventory verified: 32 logs in inventory
      expect(countMatchingLogsInInventory(mockBot)).toBe(32);

      // Bot announces goal completed
      expect(mockBot.chat).toHaveBeenCalledWith(expect.stringContaining('Goal completed'));
    });

    it('regression: asserts additional-count semantics and verifies inventory delta (+32 logs) when starting with non-zero inventory', async () => {
      let chatCb: Function | null = null;
      const initialLogs = 5; // Starting with 5 logs in inventory
      let botLogCount = initialLogs;

      const mockBot: any = {
        username: 'BotPlayer',
        on: vi.fn().mockImplementation((event: string, cb: Function) => {
          if (event === 'chat') chatCb = cb;
        }),
        chat: vi.fn(),
        health: 20,
        food: 20,
        oxygenLevel: 20,
        isAlive: true,
        game: { gameMode: 'survival' },
        entity: { position: new Vec3(0, 64, 0), onGround: true },
        entities: {},
        inventory: {
          slots: [],
          items: () => [{ name: 'oak_log', count: botLogCount }],
          emptySlotCount: () => 33,
        },
        registry: { blocksByName: {}, items: {}, itemsByName: {}, effects: {} },
        time: { timeOfDay: 1000, age: 24000 },
        findBlocks: vi.fn().mockReturnValue([new Vec3(8, 64, 8)]),
        findBlock: vi.fn().mockReturnValue({ name: 'oak_log', position: new Vec3(8, 64, 8) }),
        blockAt: vi.fn().mockReturnValue({ name: 'oak_log', position: new Vec3(8, 64, 8), boundingBox: 'block' }),
        blockAtCursor: vi.fn().mockReturnValue(null),
        entityAtCursor: vi.fn().mockReturnValue(null),
        recipesAll: vi.fn().mockReturnValue([]),
        recipesFor: vi.fn().mockReturnValue([]),
        setControlState: vi.fn(),
        clearControlStates: vi.fn(),
        pathfinder: { stop: vi.fn(), setGoal: vi.fn(), goto: vi.fn().mockResolvedValue(undefined) },
        dig: vi.fn().mockImplementation(async () => {
          botLogCount = 37; // Simulates successfully harvesting the required +32 logs to reach 37 total
        }),
      };

      const config = loadConfig();
      config.agent.owners = ['LegitOwner'];
      const memory = new MemoryManager('test_world_gather_delta', './data_test_gather_delta');
      const mockLLM = {
        name: 'MockLLM',
        generateDecision: vi.fn(),
      };

      const controller = new AgentController(
        mockBot,
        config,
        new AgentLogger(config),
        memory,
        new SafetyManager(config),
        mockLLM as any
      );

      // 1. Owner issues "gather 32 logs"
      chatCb!('LegitOwner', 'gather 32 logs');

      // Verify additional-count semantics: Target is initial (5) + requested (32) = 37 logs
      expect(controller.goalExecutor.hasActiveGoal()).toBe(true);
      const activeGoal = controller.goalExecutor.activeGoal as any;
      expect(activeGoal.kind).toBe('have');
      expect(activeGoal.mode).toBe('additional');
      expect(activeGoal.baselineCount).toBe(5);
      expect(activeGoal.count).toBe(32);
      const expectedTargetTotal = activeGoal.baselineCount + activeGoal.count;
      expect(expectedTargetTotal).toBe(37);

      // 2. Verify postcondition discriminates additional vs absolute count:
      // A bot holding 32 logs would satisfy an absolute requirement of 32, but FAILS under additional-count
      // semantics because 32 < (5 + 32 = 37).
      const task = controller.goalExecutor.activePlan?.tasks.find((t) => t.id === 'task_gather_oak_log');
      expect(task).toBeDefined();
      const mockBotWith32Logs: any = {
        inventory: { items: () => [{ name: 'oak_log', count: 32 }] },
      };
      expect(task!.postcondition!(mockBotWith32Logs, {} as any)).toBe(false);

      const mockBotWith37Logs: any = {
        inventory: { items: () => [{ name: 'oak_log', count: 37 }] },
      };
      expect(task!.postcondition!(mockBotWith37Logs, {} as any)).toBe(true);

      // 3. Controller executes step: Deterministic goal resolution runs chop_tree(count: 32)
      await (controller as any).step();

      // Zero LLM calls were made!
      expect(mockLLM.generateDecision).not.toHaveBeenCalled();

      // Verify inventory delta postcondition: net delta is exactly +32 logs
      const finalCount = countMatchingLogsInInventory(mockBot);
      expect(finalCount).toBe(37);
      const netDelta = finalCount - initialLogs;
      expect(netDelta).toBe(32);

      // Goal is now verified completed
      expect(mockBot.chat).toHaveBeenCalledWith(expect.stringContaining('Goal completed'));
    });
  });
});
