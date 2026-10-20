import { describe, it, expect, vi } from 'vitest';
import { Vec3 } from 'vec3';
import { loadConfig } from '../src/config/index.js';
import { AgentLogger } from '../src/utils/logger.js';
import { MemoryManager } from '../src/memory/index.js';
import { SafetyManager } from '../src/safety/index.js';
import { MockLLMProvider } from '../src/llm/mock.js';
import { AgentController } from '../src/agent/loop.js';

describe('Agent Controller & Scenario Execution', () => {
  it('executes a scenario with MockLLMProvider and updates memory', async () => {
    const config = loadConfig();
    config.logging.level = 'error'; // keep test output clean
    const logger = new AgentLogger(config);
    const worldId = `scenario_test_${Date.now()}_${Math.random()}`;
    const memory = new MemoryManager(worldId, './data/test_memory');
    const safety = new SafetyManager(config);

    // Create a mock bot with essential mineflayer properties
    const mockBot: any = {
      username: 'AIAgentBot',
      health: 20,
      food: 20,
      foodSaturation: 5,
      oxygenLevel: 20,
      isAlive: true,
      game: { gameMode: 'survival', dimension: 'overworld', difficulty: 'normal' },
      entity: {
        position: new Vec3(0, 64, 0),
        velocity: new Vec3(0, 0, 0),
        yaw: 0,
        pitch: 0,
        onGround: true,
      },
      entities: {
        100: {
          id: 100,
          name: 'cow',
          type: 'mob',
          position: new Vec3(2, 64, 2),
        },
      },
      inventory: {
        slots: new Array(46).fill(null),
        items: () => [],
        emptySlotCount: () => 36,
      },
      registry: {
        blocksByName: {},
        items: {},
        itemsByName: {},
        effects: {},
      },
      time: { timeOfDay: 1000, age: 24000, moonPhase: 0 },
      blockAt: vi.fn().mockImplementation((pos: Vec3) => {
        if (pos.y < 64) return { name: 'grass_block', boundingBox: 'block' };
        return { name: 'air', boundingBox: 'empty' };
      }),
      blockAtCursor: vi.fn().mockReturnValue(null),
      entityAtCursor: vi.fn().mockReturnValue(null),
      findBlock: vi.fn().mockReturnValue(null),
      recipesAll: vi.fn().mockReturnValue([]),
      recipesFor: vi.fn().mockReturnValue([]),
      setControlState: vi.fn(),
      clearControlStates: vi.fn(),
      chat: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      pathfinder: {
        goto: vi.fn().mockResolvedValue(undefined),
        setGoal: vi.fn(),
        stop: vi.fn(),
      },
    };

    // Scripted LLM decisions: Step 1 wait, Step 2 chat
    const scriptedResponses = [
      {
        decision_summary: 'Waiting to assess environment.',
        goal: 'Survive and explore',
        actions: [{ action: 'wait', params: { seconds: 0.1 } }],
        memory: { note: 'Spawn area is clear' },
        say: 'Hello world!',
      },
      {
        decision_summary: 'Sending greeting message.',
        goal: 'Establish communication',
        actions: [{ action: 'chat', params: { message: 'Ready to work.' } }],
      },
    ];

    const mockProvider = new MockLLMProvider(scriptedResponses);

    const controller = new AgentController(
      mockBot,
      config,
      logger,
      memory,
      safety,
      mockProvider
    );

    // Run one step directly by calling private step through any cast
    await (controller as any).step();

    // Verify step 1 results
    expect(memory.state.stepNumber).toBe(1);
    expect(memory.notes.facts).toContain('Spawn area is clear');
    expect(mockBot.chat).toHaveBeenCalledWith('Hello world!');
    expect(memory.rollingHistory.length).toBe(1);
    expect(memory.rollingHistory[0].action).toBe('wait');
    expect(memory.rollingHistory[0].result).toBe('success');
  });

  it('triggers emergency auto-eat reflex when food drops below threshold', async () => {
    const config = loadConfig();
    config.logging.level = 'error';
    const logger = new AgentLogger(config);
    const worldId2 = `scenario_test2_${Date.now()}_${Math.random()}`;
    const memory = new MemoryManager(worldId2, './data/test_memory');
    const safety = new SafetyManager(config);

    const mockApple = { type: 260, name: 'apple', count: 3 };
    const mockBot: any = {
      username: 'AIAgentBot',
      health: 18,
      food: 8, // below threshold of 14!
      foodSaturation: 0,
      oxygenLevel: 20,
      isAlive: true,
      game: { gameMode: 'survival' },
      entity: { position: new Vec3(0, 64, 0), onGround: true },
      entities: {},
      inventory: {
        slots: new Array(46).fill(null),
        items: () => [mockApple],
        emptySlotCount: () => 35,
      },
      registry: { blocksByName: {}, items: {}, itemsByName: {}, effects: {} },
      time: { timeOfDay: 1000, age: 24000 },
      blockAt: vi.fn().mockReturnValue({ name: 'dirt', boundingBox: 'block' }),
      blockAtCursor: vi.fn().mockReturnValue(null),
      entityAtCursor: vi.fn().mockReturnValue(null),
      findBlock: vi.fn().mockReturnValue(null),
      recipesAll: vi.fn().mockReturnValue([]),
      recipesFor: vi.fn().mockReturnValue([]),
      setControlState: vi.fn(),
      clearControlStates: vi.fn(),
      equip: vi.fn().mockResolvedValue(undefined),
      consume: vi.fn().mockImplementation(() => {
        mockBot.food = 12;
        return Promise.resolve();
      }),
      on: vi.fn(),
      once: vi.fn(),
      pathfinder: { stop: vi.fn() },
    };

    const mockProvider = new MockLLMProvider([]);
    const controller = new AgentController(mockBot, config, logger, memory, safety, mockProvider);

    await (controller as any).step();

    // Verify reflex was fired and consume was called
    expect(mockBot.equip).toHaveBeenCalled();
    expect(mockBot.consume).toHaveBeenCalled();
  });
});
