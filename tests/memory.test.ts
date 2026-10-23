import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { MemoryManager } from '../src/memory/index.js';

describe('Memory and Goal Management', () => {
  it('records and retrieves named locations and facts', () => {
    const memory = new MemoryManager('test_world', './data/test_memory');
    memory.rememberLocation('base', { x: 100, y: 70, z: -50 });
    memory.rememberFact('Creeper spotted near river');
    memory.setGoal('Build stone shelter', ['Collect cobblestone', 'Place foundation']);

    expect(memory.notes.namedLocations['base']).toEqual({ x: 100, y: 70, z: -50 });
    expect(memory.notes.facts).toContain('Creeper spotted near river');
    expect(memory.state.currentGoal).toBe('Build stone shelter');
    expect(memory.state.planSteps.length).toBe(2);
  });

  it('maintains rolling history within length limit', () => {
    const memory = new MemoryManager('test_world', './data/test_memory');
    for (let i = 1; i <= 15; i++) {
      memory.addHistoryRecord({
        step: i,
        summary: `Step ${i}`,
        action: 'wait',
        result: 'success',
        timestamp: Date.now(),
      }, 5);
    }

    expect(memory.rollingHistory.length).toBe(5);
    expect(memory.rollingHistory[memory.rollingHistory.length - 1].step).toBe(15);
  });

  it('sanitizes worldId to strictly prevent path traversal', () => {
    const memory = new MemoryManager('../../etc/shadow', './data/test_memory');
    // Path traversal characters are replaced with underscores and suffixed with unique hash
    expect((memory as any).worldId).not.toContain('..');
    expect((memory as any).worldId).not.toContain('/');
    expect((memory as any).filePath).toContain('memory-______etc_shadow_');
  });

  it('generates distinct storage file paths for different worlds with punctuation', () => {
    const mem1 = new MemoryManager('world:1', './data/test_memory');
    const mem2 = new MemoryManager('world?1', './data/test_memory');
    const mem3 = new MemoryManager('world/1', './data/test_memory');

    expect((mem1 as any).filePath).not.toBe((mem2 as any).filePath);
    expect((mem1 as any).filePath).not.toBe((mem3 as any).filePath);
    expect((mem2 as any).filePath).not.toBe((mem3 as any).filePath);
  });

  it('bounds collections to prevent unbounded memory growth', () => {
    const memory = new MemoryManager('bounds_world', './data/test_memory');
    for (let i = 0; i < 60; i++) {
      memory.rememberFact(`Observed detail ${i}`);
      memory.rememberLocation(`loc_${i}`, { x: i, y: 64, z: i });
      memory.addDangerZone(`zone_${i}`, { x: i, y: 64, z: i }, 10);
      memory.markGoalComplete(`goal_${i}`);
    }

    expect(memory.notes.facts.length).toBeLessThanOrEqual(50);
    expect(Object.keys(memory.notes.namedLocations).length).toBeLessThanOrEqual(50);
    expect(memory.notes.dangerZones.length).toBeLessThanOrEqual(50);
    expect(memory.notes.completedGoals.length).toBeLessThanOrEqual(50);
  });

  it('safely defaults empty or whitespace-only world identifier and verifies path containment', () => {
    const memWhitespace = new MemoryManager('    ', './data/test_memory');
    expect((memWhitespace as any).worldId).toContain('local_world_');
    const dataDir = path.resolve(process.cwd(), './data/test_memory');
    expect((memWhitespace as any).filePath.startsWith(dataDir)).toBe(true);

    const memEmpty = new MemoryManager('', './data/test_memory');
    expect((memEmpty as any).worldId).toContain('local_world_');
    expect((memEmpty as any).filePath.startsWith(dataDir)).toBe(true);
  });

  it('safely migrates unhashed legacy memory files into hashed format without data loss', () => {
    const dataDir = path.resolve(process.cwd(), './data/test_memory');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    const legacyFile = path.join(dataDir, 'memory-legacy_world.json');
    const legacyData = {
      schemaVersion: 1,
      worldId: 'legacy_world',
      memory: {
        namedLocations: { spawn: { x: 0, y: 64, z: 0 } },
        facts: ['Migrated from old format'],
        dangerZones: [],
        completedGoals: [],
      },
      agentState: {
        currentGoal: 'Legacy goal',
        planSteps: [],
        stepNumber: 5,
        stuckCounter: 0,
        timeSinceLastProgressSeconds: 0,
      },
    };
    fs.writeFileSync(legacyFile, JSON.stringify(legacyData), 'utf-8');

    // Create memory manager with same world name
    const mem = new MemoryManager('legacy_world', './data/test_memory');
    expect(mem.notes.namedLocations['spawn']).toEqual({ x: 0, y: 64, z: 0 });
    expect(mem.notes.facts).toContain('Migrated from old format');
    expect(mem.state.currentGoal).toBe('Legacy goal');

    // Clean up
    try {
      if (fs.existsSync(legacyFile)) fs.unlinkSync(legacyFile);
      if (fs.existsSync((mem as any).filePath)) fs.unlinkSync((mem as any).filePath);
    } catch {}
  });

  it('updates plan step progress deterministically based on inventory contents', () => {
    const worldId = `plan_test_world_${Date.now()}`;
    const memory = new MemoryManager(worldId, './data/test_memory');
    expect(memory.state.planSteps[0].completed).toBe(false);
    expect(memory.state.planSteps[1].completed).toBe(false);

    // 1. Bot gathers 4 oak logs
    memory.updatePlanProgress({ oak_log: 4 });
    expect(memory.state.planSteps[0].completed).toBe(true);
    expect(memory.state.planSteps[1].completed).toBe(false);

    // 2. Bot crafts crafting table and wooden pickaxe
    memory.updatePlanProgress({ oak_log: 2, crafting_table: 1, wooden_pickaxe: 1 });
    expect(memory.state.planSteps[0].completed).toBe(true);
    expect(memory.state.planSteps[1].completed).toBe(true);

    // 3. Bot mines 8 cobblestone
    memory.updatePlanProgress({ cobblestone: 8, wooden_pickaxe: 1 });
    expect(memory.state.planSteps[2].completed).toBe(true);

    // 4. Bot crafts stone pickaxe and has bread
    memory.updatePlanProgress({ stone_pickaxe: 1, bread: 3 });
    expect(memory.state.planSteps[3].completed).toBe(true);

    // Clean up
    try {
      if (fs.existsSync((memory as any).filePath)) fs.unlinkSync((memory as any).filePath);
    } catch {}
  });

  it('strictly enforces quantity thresholds and distinguishes prerequisites from task completion', () => {
    const worldId = `quantity_test_world_${Date.now()}`;
    const memory = new MemoryManager(worldId, './data/test_memory');

    // Set an explicit plan: Step 1: Gather 8 cobblestone, Step 2: Craft 1 furnace
    memory.setGoal('Furnace construction', [
      'Gather 8 cobblestone',
      'Craft 1 furnace',
    ]);

    expect(memory.state.planSteps[0].targetCount).toBe(8);
    expect(memory.state.planSteps[0].targetItem).toBe('cobblestone');

    // 1. Partial quantity: 1 cobblestone must NOT complete the task
    memory.updatePlanProgress({ cobblestone: 1 });
    expect(memory.state.planSteps[0].completed).toBe(false);
    expect(memory.state.planSteps[0].status).toBe('in_progress');
    expect(memory.state.planSteps[0].currentCount).toBe(1);

    // 2. Partial quantity: 7 cobblestone must still NOT complete the task
    memory.updatePlanProgress({ cobblestone: 7 });
    expect(memory.state.planSteps[0].completed).toBe(false);
    expect(memory.state.planSteps[0].status).toBe('in_progress');
    expect(memory.state.planSteps[0].currentCount).toBe(7);

    // 3. Possession of derivative tools (e.g. stone_pickaxe) must NOT falsely complete cobblestone gathering
    memory.updatePlanProgress({ cobblestone: 2, stone_pickaxe: 1 });
    expect(memory.state.planSteps[0].completed).toBe(false);
    expect(memory.state.planSteps[0].status).toBe('in_progress');
    expect(memory.state.planSteps[0].currentCount).toBe(2);

    // 4. Exact quantity: 8 cobblestone completes the task
    memory.updatePlanProgress({ cobblestone: 8 });
    expect(memory.state.planSteps[0].completed).toBe(true);
    expect(memory.state.planSteps[0].status).toBe('completed');
    expect(memory.state.planSteps[0].currentCount).toBe(8);
    expect(memory.state.planSteps[1].completed).toBe(false);

    // 5. Surplus quantity: 14 cobblestone keeps task completed with correct count
    memory.updatePlanProgress({ cobblestone: 14 });
    expect(memory.state.planSteps[0].completed).toBe(true);
    expect(memory.state.planSteps[0].currentCount).toBe(14);

    // Clean up
    try {
      if (fs.existsSync((memory as any).filePath)) fs.unlinkSync((memory as any).filePath);
    } catch {}
  });

  it('evaluates multi-item goals and tracks inventory consumption during crafting chains', () => {
    const worldId = `multi_item_craft_${Date.now()}`;
    const memory = new MemoryManager(worldId, './data/test_memory');

    // Multi-item requirement: Craft stone pickaxe requiring 3 cobblestone and 2 sticks
    memory.setGoal('Gear progression', [
      {
        step: 'Gather ingredients for stone pickaxe',
        completed: false,
        requirements: [
          { item: 'cobblestone', count: 3 },
          { item: 'stick', count: 2 },
        ],
      },
      {
        step: 'Craft stone pickaxe',
        completed: false,
        targetItem: 'stone_pickaxe',
        targetCount: 1,
      },
      {
        step: 'Mine 8 cobblestone for furnace',
        completed: false,
        targetItem: 'cobblestone',
        targetCount: 8,
      },
    ]);

    // Partial ingredients: 3 cobblestone but 0 sticks -> incomplete
    memory.updatePlanProgress({ cobblestone: 3, stick: 0 });
    expect(memory.state.planSteps[0].completed).toBe(false);
    expect(memory.state.planSteps[0].status).toBe('in_progress');

    // Full ingredients satisfied
    memory.updatePlanProgress({ cobblestone: 3, stick: 2 });
    expect(memory.state.planSteps[0].completed).toBe(true);
    expect(memory.state.planSteps[0].status).toBe('completed');
    expect(memory.state.planSteps[1].completed).toBe(false);

    // Crafting executes: cobblestone and sticks are consumed to craft stone_pickaxe
    // Inventory changes: cobblestone: 0, stick: 0, stone_pickaxe: 1
    memory.updatePlanProgress({ cobblestone: 0, stick: 0, stone_pickaxe: 1 });

    // Step 0 remains completed milestone
    expect(memory.state.planSteps[0].completed).toBe(true);
    // Step 1 is now completed
    expect(memory.state.planSteps[1].completed).toBe(true);
    // Step 2 (Mine 8 cobblestone) has 0 cobblestone and must remain incomplete
    expect(memory.state.planSteps[2].completed).toBe(false);
    expect(memory.state.planSteps[2].status).toBe('pending');

    // Surplus multi-item satisfaction
    memory.setGoal('Surplus test', [
      {
        step: 'Gather wood and stone',
        completed: false,
        requirements: [
          { item: 'log', count: 2 },
          { item: 'cobblestone', count: 4 },
        ],
      },
    ]);
    memory.updatePlanProgress({ oak_log: 5, cobblestone: 10 });
    expect(memory.state.planSteps[0].completed).toBe(true);
    expect(memory.state.planSteps[0].status).toBe('completed');

    // Clean up
    try {
      if (fs.existsSync((memory as any).filePath)) fs.unlinkSync((memory as any).filePath);
    } catch {}
  });
});
