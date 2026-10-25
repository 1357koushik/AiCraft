import { describe, it, expect, beforeEach } from 'vitest';
import { DynamicDAGCompiler, defaultDAGCompiler } from '../src/agent/planner/dag.js';
import { defaultOperatorRegistry, OperatorRegistry, IOperatorDefinition } from '../src/agent/planner/operator.js';
import { parseAndValidateGoalSpec, DeterministicGoalResolver } from '../src/agent/goals.js';

describe('Phase 1: Dynamic Backward-Chaining DAG Planner', () => {
  let compiler: DynamicDAGCompiler;

  beforeEach(() => {
    compiler = new DynamicDAGCompiler(defaultOperatorRegistry);
  });

  // =========================================================================
  // 1. Basic Tool & Workstation Plans (Empty Inventory)
  // =========================================================================
  describe('1. Basic Tool & Workstation Plan Compilation', () => {
    it('compiles backward-chaining plan for wooden_pickaxe from empty inventory', () => {
      const plan = compiler.compilePlan('goal_wood_pick', 'wooden_pickaxe', 1, {});
      expect(plan).not.toBeNull();
      expect(plan?.status).toBe('active');

      const actions = plan!.tasks.map((t) => t.actionName);
      expect(actions).toContain('chop_tree');
      expect(actions).toContain('craft_item');

      // Check task chain: chop_tree -> craft planks -> craft table & sticks -> craft pickaxe
      const pickaxeTask = plan!.tasks[plan!.tasks.length - 1];
      expect(pickaxeTask.actionName).toBe('craft_item');
      expect(pickaxeTask.params.item).toBe('wooden_pickaxe');
      expect(pickaxeTask.prerequisites.length).toBeGreaterThan(0);

      // Root gathering task should be ready immediately
      const firstTask = plan!.tasks[0];
      expect(firstTask.status).toBe('ready');
      expect(firstTask.actionName).toBe('chop_tree');
    });

    it('compiles backward-chaining plan for furnace from empty inventory', () => {
      const plan = compiler.compilePlan('goal_furnace', 'furnace', 1, {});
      expect(plan).not.toBeNull();

      // Furnace requires 8 cobblestone + crafting_table
      // Mining cobblestone requires a pickaxe (wooden_pickaxe or better)
      const actions = plan!.tasks.map((t) => t.actionName);
      expect(actions).toContain('chop_tree');
      expect(actions).toContain('collect_resource'); // mine cobble
      expect(actions).toContain('craft_item');

      const furnaceTask = plan!.tasks.find((t) => t.params.item === 'furnace');
      expect(furnaceTask).toBeDefined();
      expect(furnaceTask!.actionName).toBe('craft_item');
      expect(furnaceTask!.params.count).toBe(1);

      // Cobblestone mining task must precede furnace crafting
      const cobbleIndex = plan!.tasks.findIndex((t) => t.params.resource === 'stone');
      const furnaceIndex = plan!.tasks.findIndex((t) => t.params.item === 'furnace');
      expect(cobbleIndex).toBeLessThan(furnaceIndex);
    });

    it('compiles backward-chaining plan for stone_pickaxe from empty inventory', () => {
      const plan = compiler.compilePlan('goal_stone_pick', 'stone_pickaxe', 1, {});
      expect(plan).not.toBeNull();

      // Stone pickaxe requires stone pickaxe craft, cobble mining (tier 1 pick), wooden pickaxe craft, planks, logs
      const stonePickTask = plan!.tasks.find((t) => t.params.item === 'stone_pickaxe');
      expect(stonePickTask).toBeDefined();

      const woodPickTask = plan!.tasks.find((t) => t.params.item === 'wooden_pickaxe');
      expect(woodPickTask).toBeDefined();

      const cobbleTask = plan!.tasks.find((t) => t.params.resource === 'stone');
      expect(cobbleTask).toBeDefined();

      const woodPickIndex = plan!.tasks.indexOf(woodPickTask!);
      const cobbleIndex = plan!.tasks.indexOf(cobbleTask!);
      const stonePickIndex = plan!.tasks.indexOf(stonePickTask!);

      expect(woodPickIndex).toBeLessThan(cobbleIndex);
      expect(cobbleIndex).toBeLessThan(stonePickIndex);
    });
  });

  // =========================================================================
  // 2. Pre-Existing Inventory & Dependency Pruning
  // =========================================================================
  describe('2. Pre-Existing Inventory & Pruning', () => {
    it('skips wooden tool pipeline when stone pickaxe already exists in inventory', () => {
      const inv = {
        stone_pickaxe: 1,
        crafting_table: 1,
      };

      const plan = compiler.compilePlan('goal_furnace', 'furnace', 1, inv);
      expect(plan).not.toBeNull();

      // No need to craft wooden pickaxe!
      const woodPickTask = plan!.tasks.find((t) => t.params.item === 'wooden_pickaxe');
      expect(woodPickTask).toBeUndefined();

      // Can mine cobblestone directly
      const cobbleTask = plan!.tasks.find((t) => t.params.resource === 'stone');
      expect(cobbleTask).toBeDefined();
      expect(cobbleTask!.status).toBe('ready'); // Ready immediately since pickaxe exists
    });

    it('returns completed plan when target is already satisfied in inventory', () => {
      const inv = {
        iron_pickaxe: 1,
      };

      const plan = compiler.compilePlan('goal_iron_pick', 'iron_pickaxe', 1, inv);
      expect(plan).not.toBeNull();
      expect(plan!.tasks.length).toBe(0);
      expect(plan!.status).toBe('completed');
    });
  });

  // =========================================================================
  // 3. Advanced Progression: Iron Age Tool & Armor Compilation
  // =========================================================================
  describe('3. Advanced Progression: Iron Age Compilation', () => {
    it('compiles complete end-to-end DAG for iron_pickaxe from empty inventory', () => {
      const plan = compiler.compilePlan('goal_iron_pick', 'iron_pickaxe', 1, {});
      expect(plan).not.toBeNull();

      // Progression chain:
      // wood -> wooden_pickaxe -> cobblestone -> stone_pickaxe -> furnace -> iron ore & coal -> iron ingot -> iron_pickaxe
      const taskItems = plan!.tasks.map((t) => t.params.item || t.params.resource || t.params.logType);

      expect(taskItems).toContain('oak_log');
      expect(taskItems).toContain('wooden_pickaxe');
      expect(taskItems).toContain('stone'); // cobblestone
      expect(taskItems).toContain('stone_pickaxe');
      expect(taskItems).toContain('furnace');
      expect(taskItems).toContain('iron'); // raw_iron
      expect(taskItems).toContain('raw_iron'); // smelt iron
      expect(taskItems).toContain('iron_pickaxe');

      const ironPickTask = plan!.tasks.find((t) => t.params.item === 'iron_pickaxe');
      expect(ironPickTask).toBeDefined();
      expect(ironPickTask!.actionName).toBe('craft_item');
    });

    it('compiles DAG for iron_sword and defensive gear (shield, bucket)', () => {
      const swordPlan = compiler.compilePlan('goal_sword', 'iron_sword', 1, { iron_ingot: 2, stick: 1, crafting_table: 1 });
      expect(swordPlan).not.toBeNull();
      expect(swordPlan!.tasks.length).toBe(1);
      expect(swordPlan!.tasks[0].params.item).toBe('iron_sword');
      expect(swordPlan!.tasks[0].status).toBe('ready');

      const shieldPlan = compiler.compilePlan('goal_shield', 'shield', 1, { oak_planks: 6, iron_ingot: 1, crafting_table: 1 });
      expect(shieldPlan).not.toBeNull();
      expect(shieldPlan!.tasks.length).toBe(1);
      expect(shieldPlan!.tasks[0].params.item).toBe('shield');

      const bucketPlan = compiler.compilePlan('goal_bucket', 'bucket', 1, { iron_ingot: 3, crafting_table: 1 });
      expect(bucketPlan).not.toBeNull();
      expect(bucketPlan!.tasks.length).toBe(1);
      expect(bucketPlan!.tasks[0].params.item).toBe('bucket');
    });
  });

  // =========================================================================
  // 4. DeterministicGoalResolver Integration & Natural Language Goals
  // =========================================================================
  describe('4. DeterministicGoalResolver Integration', () => {
    it('resolves natural language "craft an iron pickaxe" goal into a dynamic DAG plan', () => {
      const spec = parseAndValidateGoalSpec('craft an iron pickaxe', {}, true);
      expect(spec).not.toBeNull();
      expect(spec?.kind).toBe('have_tool');
      expect((spec as any).tool).toBe('iron_pickaxe');

      const plan = DeterministicGoalResolver.resolve(spec!, {});
      expect(plan).not.toBeNull();
      expect(plan!.tasks.length).toBeGreaterThan(4);
      expect(plan!.tasks.some((t) => t.params.item === 'iron_pickaxe')).toBe(true);
    });

    it('resolves natural language "craft a furnace" goal into a dynamic DAG plan', () => {
      const spec = parseAndValidateGoalSpec('craft a furnace', {}, true);
      expect(spec).not.toBeNull();
      expect(spec?.kind).toBe('have_tool');
      expect((spec as any).tool).toBe('furnace');

      const plan = DeterministicGoalResolver.resolve(spec!, {});
      expect(plan).not.toBeNull();
      expect(plan!.tasks.some((t) => t.params.item === 'furnace')).toBe(true);
    });

    it('resolves natural language "have 1 furnace" goal via dynamic DAG compiler', () => {
      const spec = parseAndValidateGoalSpec('have 1 furnace', {}, true);
      expect(spec).not.toBeNull();
      expect(spec?.kind).toBe('have');

      const plan = DeterministicGoalResolver.resolve(spec!, {});
      expect(plan).not.toBeNull();
      expect(plan!.tasks.some((t) => t.params.item === 'furnace')).toBe(true);
    });

    it('preserves backwards compatibility for existing wooden_pickaxe and stone_pickaxe task IDs', () => {
      const woodSpec = parseAndValidateGoalSpec('craft wooden_pickaxe', {}, true)!;
      const woodPlan = DeterministicGoalResolver.resolve(woodSpec, {});
      expect(woodPlan?.tasks.some((t) => t.id === 'task_gather_logs')).toBe(true);
      expect(woodPlan?.tasks.some((t) => t.id === 'task_craft_pickaxe')).toBe(true);

      const stoneSpec = parseAndValidateGoalSpec('craft a stone pickaxe', { wooden_pickaxe: 1 }, true)!;
      const stonePlan = DeterministicGoalResolver.resolve(stoneSpec, { wooden_pickaxe: 1 });
      expect(stonePlan?.tasks.some((t) => t.id === 'task_have_wooden_pickaxe')).toBe(true);
      expect(stonePlan?.tasks.some((t) => t.id === 'task_mine_cobblestone')).toBe(true);
    });
  });

  // =========================================================================
  // 5. Robustness & Error Handling: Cycles & Unresolvable Targets
  // =========================================================================
  describe('5. Robustness & Cycle Detection', () => {
    it('detects cycles and returns null gracefully when circular operators exist', () => {
      const customRegistry = new OperatorRegistry([]);
      // Register circular operator: item_a requires item_b, item_b requires item_a
      customRegistry.register({
        id: 'op_a',
        name: 'Op A',
        actionName: 'craft_item',
        category: 'craft',
        producedItems: [{ item: 'item_a', count: 1 }],
        consumedItems: [{ item: 'item_b', count: 1 }],
        buildParams: () => ({}),
      });
      customRegistry.register({
        id: 'op_b',
        name: 'Op B',
        actionName: 'craft_item',
        category: 'craft',
        producedItems: [{ item: 'item_b', count: 1 }],
        consumedItems: [{ item: 'item_a', count: 1 }],
        buildParams: () => ({}),
      });

      const cyclicCompiler = new DynamicDAGCompiler(customRegistry);
      const plan = cyclicCompiler.compilePlan('goal_cycle', 'item_a', 1, {});

      // Must handle cycle without infinite recursion or stack overflow
      expect(plan).toBeNull();
    });

    it('returns null when an item has no known operator or recipe', () => {
      const plan = compiler.compilePlan('goal_unknown', 'unobtanium_ingot', 1, {});
      expect(plan).toBeNull();
    });
  });
});
