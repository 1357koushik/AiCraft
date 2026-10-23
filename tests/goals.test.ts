import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Vec3 } from 'vec3';
import {
  parseAndValidateGoalSpec,
  DeterministicGoalResolver,
  TaskExecutor,
  getBotInventoryCounts,
} from '../src/agent/goals.js';
import { ActionArbiter, ActionPriority } from '../src/agent/arbiter.js';
import { AgentController } from '../src/agent/loop.js';
import { loadConfig } from '../src/config/index.js';
import { MemoryManager } from '../src/memory/index.js';
import { SafetyManager } from '../src/safety/index.js';
import { AgentLogger } from '../src/utils/logger.js';
import { validateActionParams } from '../src/prompt/schema.js';
import { AvailabilityEngine } from '../src/actions/availability.js';

describe('Goal/Task Execution Foundation (Phase 2, Layer 4)', () => {
  let arbiter: ActionArbiter;
  let executor: TaskExecutor;
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    arbiter = new ActionArbiter(mockLogger);
    executor = new TaskExecutor(mockLogger);
  });

  // =========================================================================
  // 1. GoalSpec Parsing, Validation & Quantity Thresholds
  // =========================================================================
  describe('1. GoalSpec Parsing & Delta-Aware Validation', () => {
    it('parses natural language gathering instructions with delta awareness', () => {
      const inv = { oak_log: 5 };
      const spec = parseAndValidateGoalSpec('gather 16 oak logs', inv, true);
      expect(spec).not.toBeNull();
      expect(spec?.kind).toBe('have');
      if (spec?.kind === 'have') {
        expect(spec.item).toBe('oak_log');
        expect(spec.count).toBe(16);
        expect(spec.mode).toBe('additional');
        expect(spec.baselineCount).toBe(5); // Delta awareness: baseline captured
      }
    });

    it('parses absolute threshold goals correctly', () => {
      const inv = { oak_planks: 8 };
      const spec = parseAndValidateGoalSpec('have 32 planks', inv, true);
      expect(spec).not.toBeNull();
      expect(spec?.kind).toBe('have');
      if (spec?.kind === 'have') {
        expect(spec.item).toBe('oak_planks');
        expect(spec.count).toBe(32);
        expect(spec.mode).toBe('absolute');
      }
    });

    it('parses tool crafting goals into have_tool specs', () => {
      const spec = parseAndValidateGoalSpec('craft wooden_pickaxe', {}, true);
      expect(spec).not.toBeNull();
      expect(spec?.kind).toBe('have_tool');
      if (spec?.kind === 'have_tool') {
        expect(spec.tool).toBe('wooden_pickaxe');
      }
    });

    it('parses spatial reach goals with coordinates', () => {
      const spec = parseAndValidateGoalSpec('goto 150 64 -200', {}, true);
      expect(spec).not.toBeNull();
      expect(spec?.kind).toBe('reach');
      if (spec?.kind === 'reach') {
        expect(spec.target).toEqual({ x: 150, y: 64, z: -200 });
        expect(spec.tolerance).toBe(2);
      }
    });

    it('bounds quantities and rejects negative counts', () => {
      const spec = parseAndValidateGoalSpec({ kind: 'have', item: 'dirt', count: 9999 }, {}, true);
      expect(spec?.kind).toBe('have');
      if (spec?.kind === 'have') {
        expect(spec.count).toBe(256); // Capped at 256
      }
    });
  });

  // =========================================================================
  // 2. Deterministic Resolver: Known Goals & Already-Satisfied Prerequisites
  // =========================================================================
  describe('2. Deterministic Goal Resolver', () => {
    it('resolves gather goal and marks already-satisfied goals without redundant steps', () => {
      const spec = parseAndValidateGoalSpec('have 8 cobblestone', { cobblestone: 8 }, true)!;
      const plan = DeterministicGoalResolver.resolve(spec, { cobblestone: 8 });
      expect(plan).not.toBeNull();
      expect(plan?.tasks.length).toBe(1);
      expect(plan?.tasks[0].status).toBe('satisfied');
      expect(plan?.status).toBe('completed');
    });

    it('builds DAG for tool progression and marks components satisfied from inventory', () => {
      // Bot already has crafting_table and 4 planks, but no sticks or wooden_pickaxe
      const inventory = {
        crafting_table: 1,
        oak_planks: 4,
      };
      const spec = parseAndValidateGoalSpec('craft wooden_pickaxe', inventory, true)!;
      const plan = DeterministicGoalResolver.resolve(spec, inventory);
      expect(plan).not.toBeNull();

      const taskLogs = plan?.tasks.find((t) => t.id === 'task_gather_logs');
      const taskPlanks = plan?.tasks.find((t) => t.id === 'task_craft_planks');
      const taskTable = plan?.tasks.find((t) => t.id === 'task_craft_table');
      const taskSticks = plan?.tasks.find((t) => t.id === 'task_craft_sticks');
      const taskPick = plan?.tasks.find((t) => t.id === 'task_craft_pickaxe');

      // Logs, planks, and table are already satisfied!
      expect(taskLogs?.status).toBe('satisfied');
      expect(taskPlanks?.status).toBe('satisfied');
      expect(taskTable?.status).toBe('satisfied');

      // Sticks task has prerequisites met (planks satisfied) -> ready to craft
      expect(taskSticks?.status).toBe('ready');

      // Wooden pickaxe is pending sticks
      expect(taskPick?.status).toBe('pending');
    });
  });

  // =========================================================================
  // 3. Anti-Duplication & Explicit Cancel/Replacement
  // =========================================================================
  describe('3. Goal Lifecycle: Anti-Duplication, Cancel & Replacement', () => {
    it('prevents duplicate simultaneous goals from restarting active work', () => {
      const spec1 = parseAndValidateGoalSpec('gather 16 oak logs', {}, true)!;
      const res1 = executor.setGoal(spec1, {});
      expect(res1.accepted).toBe(true);

      // Attempting to set identical active goal
      const specDuplicate = parseAndValidateGoalSpec('gather 16 oak logs', {}, true)!;
      const res2 = executor.setGoal(specDuplicate, {});
      expect(res2.accepted).toBe(false);
      expect(res2.reason).toContain('Duplicate goal already active');
    });

    it('explicitly cancels active goal and marks pending/running tasks cancelled', () => {
      const spec = parseAndValidateGoalSpec('craft wooden_pickaxe', {}, true)!;
      executor.setGoal(spec, {});
      expect(executor.hasActiveGoal()).toBe(true);

      executor.cancelGoal('Owner cancel command');
      expect(executor.hasActiveGoal()).toBe(false);
      expect(executor.activePlan?.status).toBe('cancelled');
      const unfinishedTasks = executor.activePlan?.tasks.filter(
        (t) => t.status === 'pending' || t.status === 'ready' || t.status === 'running'
      );
      expect(unfinishedTasks?.length).toBe(0);
    });

    it('cancels existing goal and replaces it cleanly when owner provides new goal', () => {
      const spec1 = parseAndValidateGoalSpec('gather 16 oak logs', {}, true)!;
      executor.setGoal(spec1, {});
      expect(executor.activeGoal?.kind).toBe('have');

      // Replace with reach goal
      const spec2 = parseAndValidateGoalSpec('goto 50 64 50', {}, true)!;
      const res = executor.setGoal(spec2, {});
      expect(res.accepted).toBe(true);
      expect(executor.activeGoal?.kind).toBe('reach');
      expect(executor.activePlan?.tasks[0].actionName).toBe('goto');
    });
  });

  // =========================================================================
  // 4. Postcondition Verification: Skill Returning is Not Proof of Success
  // =========================================================================
  describe('4. Postcondition Verification', () => {
    it('marks task failed when postcondition is false even though skill returned success', async () => {
      const spec = parseAndValidateGoalSpec('gather 8 oak logs', { oak_log: 0 }, true)!;
      executor.setGoal(spec, { oak_log: 0 });
      const task = executor.getNextReadyTask()!;
      expect(task).toBeDefined();

      // Mock bot whose inventory never updates (e.g. block was broken by another player or drop despawned)
      const mockBot: any = {
        inventory: { items: () => [] }, // Empty inventory
      };

      // Mock executeWithTimeout returning 'success' without actually delivering the items
      const mockObs: any = { vitals: {}, position: {} };
      vi.spyOn(AvailabilityEngine, 'executeWithTimeout').mockResolvedValueOnce({
        status: 'success',
        reason: 'chop_tree simulated completion',
      });

      const result = await executor.executeTask(
        task,
        mockBot,
        arbiter,
        loadConfig(),
        mockLogger,
        mockObs
      );

      // Task must FAIL with typed failure kind POSTCONDITION_FAILED!
      expect(result.status).toBe('ready'); // Retry count = 1 (< maxRetries 3)
      expect(result.failureKind).toBe('POSTCONDITION_FAILED');
      expect(result.failureReason).toContain('Postcondition verification failed');
      expect(task.evidence.some((e) => e.includes('Postcondition check failed'))).toBe(true);
    });

    it('marks task succeeded when postcondition is verified with actual state delta', async () => {
      const spec = parseAndValidateGoalSpec('gather 2 oak logs', { oak_log: 0 }, true)!;
      executor.setGoal(spec, { oak_log: 0 });
      const task = executor.getNextReadyTask()!;

      // Mock bot whose inventory updates with 2 oak logs
      const mockBot: any = {
        inventory: {
          items: () => [{ name: 'oak_log', count: 2 }],
        },
      };

      vi.spyOn(AvailabilityEngine, 'executeWithTimeout').mockResolvedValueOnce({
        status: 'success',
        reason: 'chop_tree completed',
      });

      const result = await executor.executeTask(
        task,
        mockBot,
        arbiter,
        loadConfig(),
        mockLogger,
        {} as any
      );

      expect(result.status).toBe('succeeded');
      expect(task.status).toBe('succeeded');
      expect(task.evidence.some((e) => e.includes('postcondition verified'))).toBe(true);
    });
  });

  // =========================================================================
  // 5. Dependent Task Failure & Exhausted Retry Budget
  // =========================================================================
  describe('5. Dependent Task Failure & Retry Exhaustion', () => {
    it('exhausts retry budget and stops retrying, preventing infinite loops', async () => {
      const spec = parseAndValidateGoalSpec('gather 4 oak logs', {}, true)!;
      executor.setGoal(spec, {});
      const task = executor.getNextReadyTask()!;
      task.maxRetries = 2; // Test with 2 retries

      const mockBot: any = { inventory: { items: () => [] } };
      vi.spyOn(AvailabilityEngine, 'executeWithTimeout').mockResolvedValue({
        status: 'failed',
        reason: 'Tree unreachable',
      });

      // Attempt 1: retryCount becomes 1, status remains 'ready'
      const res1 = await executor.executeTask(task, mockBot, arbiter, loadConfig(), mockLogger, {} as any);
      expect(res1.status).toBe('ready');
      expect(task.retryCount).toBe(1);

      // Attempt 2: retryCount reaches maxRetries (2) -> transitions to 'failed'
      const res2 = await executor.executeTask(task, mockBot, arbiter, loadConfig(), mockLogger, {} as any);
      expect(res2.status).toBe('failed');
      expect(res2.failureKind).toBe('RETRY_BUDGET_EXHAUSTED');
      expect(task.status).toBe('failed');
    });

    it('cascades failure to all dependent downstream tasks in the DAG', async () => {
      // Craft wooden pickaxe: logs -> planks -> table & sticks -> pickaxe
      const spec = parseAndValidateGoalSpec('craft wooden_pickaxe', {}, true)!;
      executor.setGoal(spec, {});

      const taskLogs = executor.activePlan?.tasks.find((t) => t.id === 'task_gather_logs')!;
      const taskPlanks = executor.activePlan?.tasks.find((t) => t.id === 'task_craft_planks')!;
      const taskPick = executor.activePlan?.tasks.find((t) => t.id === 'task_craft_pickaxe')!;
      taskLogs.maxRetries = 1;

      const mockBot: any = { inventory: { items: () => [] } };
      vi.spyOn(AvailabilityEngine, 'executeWithTimeout').mockResolvedValueOnce({
        status: 'failed',
        reason: 'No trees in biome',
      });

      await executor.executeTask(taskLogs, mockBot, arbiter, loadConfig(), mockLogger, {} as any);

      // Gather logs failed after exhausting retries
      expect(taskLogs.status).toBe('failed');

      // Downstream dependent tasks (planks and pickaxe) must cascade fail with PREREQUISITE_FAILED!
      expect(taskPlanks.status).toBe('failed');
      expect(taskPlanks.failureKind).toBe('PREREQUISITE_FAILED');

      expect(taskPick.status).toBe('failed');
      expect(taskPick.failureKind).toBe('PREREQUISITE_FAILED');
    });
  });

  // =========================================================================
  // 6. Validation of Model-Proposed Goals & Action Parameters
  // =========================================================================
  describe('6. Validation of Model Output & Action Parameters', () => {
    it('validates model action parameters and rejects illegal keys or invalid types', () => {
      // Valid action
      expect(validateActionParams('goto', { x: 10, y: 64, z: 10, range: 2 }).valid).toBe(true);

      // Invalid: unexpected parameter
      const badParam = validateActionParams('goto', { x: 10, y: 64, z: 10, hallucinatedKey: true });
      expect(badParam.valid).toBe(false);
      expect(badParam.reason).toContain("Unexpected parameter 'hallucinatedKey'");

      // Invalid: negative count
      const negCount = validateActionParams('collect_resource', { resource: 'stone', count: -5 });
      expect(negCount.valid).toBe(false);
      expect(negCount.reason).toContain('must be a positive number');

      // Invalid: unknown action
      const unknownAction = validateActionParams('teleport_bot', {});
      expect(unknownAction.valid).toBe(false);
      expect(unknownAction.reason).toContain("Unknown action name 'teleport_bot'");
    });

    it('rejects invalid model-proposed goals', () => {
      const invalid = parseAndValidateGoalSpec({ kind: 'have', item: '', count: -1 }, {}, false);
      expect(invalid).toBeNull();
    });
  });

  // =========================================================================
  // 7. End-to-End AgentController Integration Tests
  // =========================================================================
  describe('7. End-to-End AgentController Integration', () => {
    it('owner instruction reaches goal executor and preserves owner goal against LLM decision', async () => {
      let chatCb: Function | null = null;
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
        inventory: { slots: [], items: () => [], emptySlotCount: () => 36 },
        registry: { blocksByName: {}, items: {}, itemsByName: {}, effects: {} },
        time: { timeOfDay: 1000, age: 24000 },
        blockAt: vi.fn().mockReturnValue({ name: 'grass_block', boundingBox: 'block' }),
        blockAtCursor: vi.fn().mockReturnValue(null),
        entityAtCursor: vi.fn().mockReturnValue(null),
        findBlock: vi.fn().mockReturnValue(null),
        recipesAll: vi.fn().mockReturnValue([]),
        recipesFor: vi.fn().mockReturnValue([]),
        setControlState: vi.fn(),
        clearControlStates: vi.fn(),
        pathfinder: { stop: vi.fn(), setGoal: vi.fn(), goto: vi.fn().mockResolvedValue(undefined) },
      };

      const config = loadConfig();
      config.agent.owners = ['LegitOwner'];
      const memory = new MemoryManager('test_world_goals', './data_test_goals');

      // Mock LLM that attempts to overwrite the goal
      const mockLLM = {
        name: 'MockLLM',
        generateDecision: vi.fn().mockResolvedValue({
          decision: {
            decision_summary: 'Overriding goal',
            goal: 'Overwritten Rogue Goal',
            actions: [{ action: 'wait', params: { seconds: 0.05 } }],
          },
          latencyMs: 10,
        }),
      };

      const controller = new AgentController(
        mockBot,
        config,
        new AgentLogger(config),
        memory,
        new SafetyManager(config),
        mockLLM as any
      );

      // 1. Owner sends natural language instruction
      chatCb!('LegitOwner', 'gather 16 oak logs');

      // Intended component (TaskExecutor & Memory) receives owner goal
      expect(controller.goalExecutor.hasActiveGoal()).toBe(true);
      expect(controller.goalExecutor.activeGoal?.kind).toBe('have');
      expect(memory.state.currentGoal).toBe('gather 16 oak logs');

      // 2. Step executes: Deterministic task executes directly without LLM call!
      await (controller as any).step();

      // Owner goal is preserved! Model was NOT even queried for this deterministic task!
      expect(mockLLM.generateDecision).not.toHaveBeenCalled();
      expect(memory.state.currentGoal).toBe('gather 16 oak logs');

      // 3. Owner issues !cancel command
      chatCb!('LegitOwner', '!cancel');
      expect(controller.goalExecutor.hasActiveGoal()).toBe(false);
      expect(mockBot.chat).toHaveBeenCalledWith('Active goal and tasks cancelled.');
    });
  });
});
