import { describe, it, expect, vi } from 'vitest';
import { Vec3 } from 'vec3';
import { loadConfig } from '../src/config/index.js';
import { AgentLogger } from '../src/utils/logger.js';
import { MemoryManager } from '../src/memory/index.js';
import { SafetyManager } from '../src/safety/index.js';
import { MockLLMProvider } from '../src/llm/mock.js';
import { AgentController } from '../src/agent/loop.js';
import { ActionPriority } from '../src/agent/arbiter.js';

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
      food: 6, // below threshold of 8.0!
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

  it('executes multi-action plan and re-validates each action with fresh observation', async () => {
    const config = loadConfig();
    config.agent.maxActionsPerStep = 3;
    const logger = new AgentLogger(config);
    const memory = new MemoryManager(`multi_${Date.now()}`, './data/test_memory');
    const safety = new SafetyManager(config);

    const mockBot: any = {
      username: 'AIAgentBot',
      health: 20,
      food: 20,
      isAlive: true,
      entity: { position: new Vec3(0, 64, 0), yaw: 0, onGround: true },
      entities: {},
      inventory: { items: () => [], slots: new Array(46).fill(null), emptySlotCount: () => 36 },
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
      chat: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      pathfinder: { stop: vi.fn() },
    };

    const scriptedMulti = [
      {
        decision_summary: 'Two sequential actions: wait then chat.',
        goal: 'Sequence test',
        actions: [
          { action: 'wait', params: { seconds: 0.05 } },
          { action: 'chat', params: { message: 'Action 2 reached!' } },
        ],
      },
    ];

    const mockProvider = new MockLLMProvider(scriptedMulti);
    const controller = new AgentController(mockBot, config, logger, memory, safety, mockProvider);

    await (controller as any).step();

    expect(mockBot.chat).toHaveBeenCalledWith('Action 2 reached!');
  });

  it('stops multi-action batch execution immediately when an earlier action fails', async () => {
    const config = loadConfig();
    config.agent.maxActionsPerStep = 3;
    const logger = new AgentLogger(config);
    const memory = new MemoryManager(`fail_${Date.now()}`, './data/test_memory');
    const safety = new SafetyManager(config);

    const mockBot: any = {
      username: 'AIAgentBot',
      health: 20,
      food: 20,
      isAlive: true,
      entity: { position: new Vec3(0, 64, 0), yaw: 0, onGround: true },
      entities: {},
      inventory: { items: () => [], slots: new Array(46).fill(null), emptySlotCount: () => 36 },
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
      chat: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      pathfinder: { stop: vi.fn() },
    };

    // Action 1: goto non-existent target (fails); Action 2: chat (should NOT be reached)
    const scriptedFail = [
      {
        decision_summary: 'Attempt invalid goto then chat.',
        goal: 'Halt on failure test',
        actions: [
          { action: 'goto', params: { targetId: 'e99_nonexistent' } },
          { action: 'chat', params: { message: 'SHOULD NEVER BE SENT' } },
        ],
      },
    ];

    const mockProvider = new MockLLMProvider(scriptedFail);
    const controller = new AgentController(mockBot, config, logger, memory, safety, mockProvider);

    await (controller as any).step();

    expect(mockBot.chat).not.toHaveBeenCalled();
  });

  it('preempts active actions and cleans controls on bot end/disconnect event', () => {
    const config = loadConfig();
    config.logging.level = 'error';
    const logger = new AgentLogger(config);
    const memory = new MemoryManager(`disconnect_test_${Date.now()}`, './data/test_memory');
    const safety = new SafetyManager(config);

    let endCallback: (() => void) | null = null;
    const mockBot: any = {
      username: 'AIAgentBot',
      health: 20,
      food: 20,
      isAlive: true,
      entity: { position: new Vec3(0, 64, 0), onGround: true },
      entities: {},
      inventory: { items: () => [], slots: new Array(46).fill(null), emptySlotCount: () => 36 },
      clearControlStates: vi.fn(),
      deactivateItem: vi.fn(),
      pathfinder: { stop: vi.fn(), setGoal: vi.fn() },
      on: vi.fn().mockImplementation((event: string, cb: any) => {
        if (event === 'end') endCallback = cb;
      }),
      once: vi.fn(),
    };

    const mockProvider = new MockLLMProvider([]);
    const controller = new AgentController(mockBot, config, logger, memory, safety, mockProvider);

    // Start a dummy normal action
    const arbiter = (controller as any).arbiter;
    const action = arbiter.startAction('goto', ActionPriority.NORMAL, mockBot);
    expect(arbiter.isBusy()).toBe(true);

    // Simulate server disconnect
    expect(endCallback).not.toBeNull();
    endCallback!();

    expect(action.signal.aborted).toBe(true);
    expect(arbiter.isBusy()).toBe(false);
    expect(mockBot.clearControlStates).toHaveBeenCalled();
  });

  it('records items picked up by bot into recentEvents.itemsPickedUp when playerCollect fires for bot', () => {
    const config = loadConfig();
    config.logging.level = 'error';
    const logger = new AgentLogger(config);
    const memory = new MemoryManager(`collect_test_${Date.now()}`, './data/test_memory');
    const safety = new SafetyManager(config);

    const eventCallbacks: Record<string, Function> = {};
    const botEntity = { id: 1, position: new Vec3(0, 64, 0) };
    const mockBot: any = {
      username: 'AIAgentBot',
      health: 20,
      food: 20,
      isAlive: true,
      entity: botEntity,
      entities: {},
      inventory: { items: () => [], slots: new Array(46).fill(null), emptySlotCount: () => 36 },
      clearControlStates: vi.fn(),
      pathfinder: { stop: vi.fn() },
      on: vi.fn().mockImplementation((event: string, cb: any) => {
        eventCallbacks[event] = cb;
      }),
      once: vi.fn(),
    };

    const mockProvider = new MockLLMProvider([]);
    const controller = new AgentController(mockBot, config, logger, memory, safety, mockProvider);

    expect(eventCallbacks['playerCollect']).toBeDefined();

    // 1. Bot collects 4 oak_logs
    const mockItemEntity = {
      id: 50,
      name: 'item',
      getDroppedItem: () => ({ name: 'oak_log', count: 4 }),
    };
    eventCallbacks['playerCollect'](botEntity, mockItemEntity);

    const recentEvents = (controller as any).recentEvents;
    expect(recentEvents.itemsPickedUp).toEqual([{ name: 'oak_log', count: 4 }]);

    // 2. Another player collects cobblestone -> bot must ignore it
    const otherPlayer = { id: 2, username: 'OtherPlayer' };
    const otherItem = {
      id: 51,
      name: 'item',
      getDroppedItem: () => ({ name: 'cobblestone', count: 8 }),
    };
    eventCallbacks['playerCollect'](otherPlayer, otherItem);

    // recentEvents must not contain the other player's cobblestone
    expect(recentEvents.itemsPickedUp).toEqual([{ name: 'oak_log', count: 4 }]);

    // 3. Dropped item entity with unavailable metadata (e.g. null metadata or no getDroppedItem)
    const corruptedDropEntity = { id: 52 }; // lacks getDroppedItem and name
    eventCallbacks['playerCollect'](botEntity, corruptedDropEntity);
    expect(recentEvents.itemsPickedUp).toContainEqual({ name: 'unknown_item', count: 1 });
  });

  it('strictly distinguishes verified bot kills from ambient/unrelated entity deaths and cleans listeners on disconnect', () => {
    const config = loadConfig();
    config.logging.level = 'error';
    const logger = new AgentLogger(config);
    const memory = new MemoryManager(`mob_dead_test_${Date.now()}`, './data/test_memory');
    const safety = new SafetyManager(config);

    const eventCallbacks: Record<string, Function> = {};
    const botEntity = { id: 1, position: new Vec3(0, 64, 0) };
    const mockBot: any = {
      username: 'AIAgentBot',
      health: 20,
      food: 20,
      isAlive: true,
      entity: botEntity,
      entities: {},
      inventory: { items: () => [], slots: new Array(46).fill(null), emptySlotCount: () => 36 },
      clearControlStates: vi.fn(),
      pathfinder: { stop: vi.fn() },
      attack: vi.fn(),
      removeListener: vi.fn(),
      removeAllListeners: vi.fn(),
      on: vi.fn().mockImplementation((event: string, cb: any) => {
        eventCallbacks[event] = cb;
      }),
      once: vi.fn(),
    };

    const mockProvider = new MockLLMProvider([]);
    const controller = new AgentController(mockBot, config, logger, memory, safety, mockProvider);

    expect(eventCallbacks['entityDead']).toBeDefined();

    // 1. Ambient sheep dies 3 blocks away without bot attack (e.g. fire/fall/other player)
    const ambientSheep = {
      id: 200,
      name: 'sheep',
      type: 'mob',
      position: new Vec3(3, 64, 0),
    };
    eventCallbacks['entityDead'](ambientSheep);

    const recentEvents = (controller as any).recentEvents;
    // Ambient death must NOT be recorded as a player kill
    expect(recentEvents.mobsKilled).toEqual([]);
    expect(recentEvents.nearbyEntityDeaths).toEqual(['sheep']);

    // 2. Bot directly attacks a zombie
    const targetZombie = {
      id: 100,
      name: 'zombie',
      type: 'mob',
      position: new Vec3(2, 64, 0),
    };
    mockBot.attack(targetZombie);

    // Zombie dies after being attacked by bot -> verified bot kill
    eventCallbacks['entityDead'](targetZombie);
    expect(recentEvents.mobsKilled).toEqual(['zombie']);

    // 3. Out-of-range death (40 blocks away) -> neither mobsKilled nor nearbyEntityDeaths
    const farCow = {
      id: 101,
      name: 'cow',
      type: 'mob',
      position: new Vec3(40, 64, 0),
    };
    eventCallbacks['entityDead'](farCow);
    expect(recentEvents.mobsKilled).toEqual(['zombie']);
    expect(recentEvents.nearbyEntityDeaths).toEqual(['sheep']);

    // 4. Verify listener cleanup on disconnect / instance update (removes only bound listeners, never calls removeAllListeners)
    controller.cleanupEventListeners();
    expect(mockBot.removeListener).toHaveBeenCalledWith('entityDead', expect.any(Function));
    expect(mockBot.removeListener).toHaveBeenCalledWith('playerCollect', expect.any(Function));
    expect(mockBot.removeListener).toHaveBeenCalledWith('end', expect.any(Function));
    expect(mockBot.removeAllListeners).not.toHaveBeenCalled();
  });
});
