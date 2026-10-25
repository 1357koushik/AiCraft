import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { PlanCache, IPlanCacheEntry } from '../src/memory/plan_cache.js';
import { MemoryManager } from '../src/memory/index.js';
import { TaskPlan } from '../src/types/index.js';
import { DeterministicGoalResolver } from '../src/agent/goals.js';

describe('Phase 4: Persistent Memory and Validated Plan Reuse', () => {
  const testDir = './data/test_memory_plan_cache';

  beforeEach(() => {
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
  });

  const samplePlan: TaskPlan = {
    goalId: 'goal_stone_pickaxe_1',
    createdAt: Date.now(),
    status: 'active',
    tasks: [
      {
        id: 'task_chop_1',
        type: 'gather',
        actionName: 'chop_tree',
        params: { logType: 'oak_log', count: 3 },
        prerequisites: [],
        status: 'ready',
        retryCount: 0,
        maxRetries: 3,
        evidence: [],
      },
      {
        id: 'task_craft_planks_1',
        type: 'craft',
        actionName: 'craft_item',
        params: { item: 'oak_planks', count: 4 },
        prerequisites: ['task_chop_1'],
        status: 'pending',
        retryCount: 0,
        maxRetries: 3,
        evidence: [],
      },
      {
        id: 'task_craft_table_1',
        type: 'craft',
        actionName: 'craft_item',
        params: { item: 'crafting_table', count: 1 },
        prerequisites: ['task_craft_planks_1'],
        status: 'pending',
        retryCount: 0,
        maxRetries: 3,
        evidence: [],
      },
    ],
  };

  // =========================================================================
  // 1. Plan Cache Storage, Invalidation, and Retrieval
  // =========================================================================
  describe('1. Plan Cache Storage, Invalidation, and Retrieval', () => {
    it('computes canonical normalized goal hash keys', () => {
      expect(PlanCache.computeGoalHash('Craft Stone Pickaxe', 1)).toBe('craft_stone_pickaxe:1');
      expect(PlanCache.computeGoalHash('obtain-iron-sword', 2)).toBe('obtain_iron_sword:2');
      expect(PlanCache.computeGoalHash('have_furnace', 1)).toBe('have_furnace:1');
    });

    it('stores successfully executed plan and retrieves with fresh runtime task IDs', () => {
      const cache = new PlanCache();
      const goalHash = 'have_stone_pickaxe:1';

      cache.recordSuccess(goalHash, samplePlan, 1200, 1.0);

      expect(cache.has(goalHash)).toBe(true);

      const cachedPlan = cache.get(goalHash);
      expect(cachedPlan).not.toBeNull();
      expect(cachedPlan?.goalId).toBe(samplePlan.goalId);
      expect(cachedPlan?.tasks.length).toBe(3);
      // Fresh IDs and reset status
      expect(cachedPlan?.tasks[0].id).toContain('cached_chop_tree');
      expect(cachedPlan?.tasks[0].status).toBe('ready');
      expect(cachedPlan?.tasks[1].status).toBe('pending');
    });

    it('tracks rolling execution duration metrics across repeated successes', () => {
      const cache = new PlanCache();
      const goalHash = 'have_furnace:1';

      cache.recordSuccess(goalHash, samplePlan, 1000);
      let entry = cache.serialize()[goalHash];
      expect(entry.averageExecutionDurationMs).toBe(1000);

      cache.recordSuccess(goalHash, samplePlan, 2000);
      entry = cache.serialize()[goalHash];
      expect(entry.averageExecutionDurationMs).toBe(1500); // (1000 + 2000) / 2
    });

    it('invalidates cache entry after 3 consecutive execution failures', () => {
      const cache = new PlanCache();
      const goalHash = 'have_iron_pickaxe:1';

      cache.recordSuccess(goalHash, samplePlan, 1500);
      expect(cache.has(goalHash)).toBe(true);

      cache.recordFailure(goalHash);
      expect(cache.has(goalHash)).toBe(true); // 1 failure, still active

      cache.recordFailure(goalHash);
      expect(cache.has(goalHash)).toBe(true); // 2 failures, still active

      cache.recordFailure(goalHash);
      expect(cache.has(goalHash)).toBe(false); // 3 failures, invalidated!
      expect(cache.get(goalHash)).toBeNull();
    });

    it('invalidates retrieval when required workstation is unavailable in environment', () => {
      const cache = new PlanCache();
      const goalHash = 'have_iron_sword:1';

      // Record plan that requires a crafting_table in the environment
      cache.recordSuccess(goalHash, samplePlan, 1000, 1.0, {
        requiredWorkstations: ['crafting_table'],
      });

      // Scenario A: crafting table is absent from both inventory and world -> returns null
      const planNoWorkstation = cache.get(goalHash, {}, []);
      expect(planNoWorkstation).toBeNull();

      // Scenario B: crafting table is in inventory -> valid!
      const planInInv = cache.get(goalHash, { crafting_table: 1 }, []);
      expect(planInInv).not.toBeNull();

      // Scenario C: crafting table is known placed in world -> valid!
      const planInWorld = cache.get(goalHash, {}, ['crafting_table']);
      expect(planInWorld).not.toBeNull();
    });
  });

  // =========================================================================
  // 2. Persistent Memory Integration & Process Restart Resiliency
  // =========================================================================
  describe('2. Persistent Memory Integration & Process Restart Resiliency', () => {
    it('persists plan cache across memory save and reload', () => {
      const worldId = `cache_persist_${Date.now()}`;
      const memory1 = new MemoryManager(worldId, testDir);

      const goalHash = 'have_stone_pickaxe:1';
      memory1.planCache.recordSuccess(goalHash, samplePlan, 850);
      memory1.saveToDisk();

      // Simulate process restart: instantiate new MemoryManager pointing to same world
      const memory2 = new MemoryManager(worldId, testDir);

      expect(memory2.planCache.has(goalHash)).toBe(true);
      const reloadedPlan = memory2.planCache.get(goalHash);
      expect(reloadedPlan).not.toBeNull();
      expect(reloadedPlan?.tasks.length).toBe(3);
    });

    it('identifies previously placed crafting table across process restart avoiding duplicate crafting', () => {
      const worldId = `restart_table_${Date.now()}`;
      const memory1 = new MemoryManager(worldId, testDir);

      // Bot places crafting table in world and records location
      memory1.recordKnownLocation({
        name: 'crafting_table',
        type: 'crafting_table',
        position: { x: 12, y: 64, z: 15 },
        dimension: 'overworld',
      });
      memory1.saveToDisk();

      // Simulate process death / restart
      const memory2 = new MemoryManager(worldId, testDir);

      const knownTables = memory2.getKnownLocations('crafting_table');
      expect(knownTables.length).toBe(1);
      expect(knownTables[0].position.x).toBe(12);
      expect(knownTables[0].position.y).toBe(64);
      expect(knownTables[0].position.z).toBe(15);

      // When resolving goal for stone pickaxe with cobblestone & sticks in inventory,
      // plan resolution recognizes known workstation without generating redundant craft_item(crafting_table)
      const inv = { cobblestone: 3, stick: 2 };
      const knownWorkstations = memory2.getKnownLocations().map((l) => l.type);
      const plan = DeterministicGoalResolver.resolve(
        { id: 'g_pick', kind: 'have', item: 'stone_pickaxe', count: 1, mode: 'absolute' },
        inv,
        { knownWorkstations }
      );

      expect(plan).not.toBeNull();
      // Should craft stone pickaxe directly since sticks and cobblestone exist!
      const craftTableTask = plan?.tasks.find((t) => t.params.item === 'crafting_table');
      expect(craftTableTask).toBeUndefined();
    });
  });
});
