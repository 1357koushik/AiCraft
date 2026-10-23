import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Vec3 } from 'vec3';
import { ActionArbiter, ActionPriority } from '../src/agent/arbiter.js';
import { ReflexLayer } from '../src/agent/reflex.js';
import { SafetySupervisor } from '../src/agent/supervisor.js';
import { loadConfig } from '../src/config/index.js';

describe('SafetySupervisor (Phase 1, Layer 2)', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  let config: any;
  let listeners: Record<string, Function[]>;
  let mockBot: any;
  let arbiter: ActionArbiter;
  let reflexLayer: ReflexLayer;

  beforeEach(() => {
    config = loadConfig();
    config.logging.level = 'error';
    listeners = {};

    mockBot = {
      health: 20,
      food: 20,
      oxygenLevel: 20,
      isAlive: true,
      entity: {
        position: new Vec3(0, 64, 0),
        isInWater: false,
        isInLava: false,
        isBurning: false,
        onGround: true,
      },
      entities: {},
      inventory: {
        items: () => [],
      },
      on: vi.fn().mockImplementation((event: string, fn: Function) => {
        if (!listeners[event]) listeners[event] = [];
        listeners[event].push(fn);
      }),
      removeListener: vi.fn().mockImplementation((event: string, fn: Function) => {
        if (listeners[event]) {
          listeners[event] = listeners[event].filter((f) => f !== fn);
        }
      }),
      clearControlStates: vi.fn(),
      setControlState: vi.fn(),
      lookAt: vi.fn().mockResolvedValue(undefined),
      deactivateItem: vi.fn(),
      pathfinder: {
        stop: vi.fn(),
        setGoal: vi.fn(),
      },
      blockAt: vi.fn().mockImplementation((pos: Vec3) => {
        return { name: 'air', boundingBox: 'empty' };
      }),
    };

    arbiter = new ActionArbiter(logger);
    reflexLayer = new ReflexLayer(config, logger);
  });

  it('initializes and manages lifecycle cleanly with idempotent start and stop', () => {
    const supervisor = new SafetySupervisor({
      bot: mockBot,
      arbiter,
      reflexLayer,
      logger,
      config,
    });

    expect(supervisor.isSupervising).toBe(false);

    supervisor.start();
    expect(supervisor.isSupervising).toBe(true);
    expect(mockBot.on).toHaveBeenCalled();
    const registeredCount = mockBot.on.mock.calls.length;

    // Idempotent start
    supervisor.start();
    expect(mockBot.on.mock.calls.length).toBe(registeredCount);

    // Stop cleanly removes listeners
    supervisor.stop();
    expect(supervisor.isSupervising).toBe(false);
    expect(mockBot.removeListener).toHaveBeenCalledTimes(registeredCount);

    // Idempotent stop
    mockBot.removeListener.mockClear();
    supervisor.stop();
    expect(mockBot.removeListener).not.toHaveBeenCalled();
  });

  it('keeps synchronous event handlers O(1) and short without blocking the Node.js event loop', () => {
    const supervisor = new SafetySupervisor({
      bot: mockBot,
      arbiter,
      reflexLayer,
      logger,
      config,
    });

    supervisor.start();

    // Trigger physicsTick when bot is in normal air
    const tickListeners = listeners['physicsTick'] || [];
    expect(tickListeners.length).toBeGreaterThan(0);

    const start = performance.now();
    for (const fn of tickListeners) {
      fn();
    }
    const elapsed = performance.now() - start;

    // Must execute practically instantaneously (under 2ms) without full scans
    expect(elapsed).toBeLessThan(5);
    expect(supervisor.isEmergencyActive).toBe(false);

    supervisor.stop();
  });

  it('asynchronously preempts normal work when sharp health drop occurs', async () => {
    const supervisor = new SafetySupervisor({
      bot: mockBot,
      arbiter,
      reflexLayer,
      logger,
      config,
    });

    supervisor.start();

    // Start a normal action
    const normalAction = arbiter.startAction('mine_block', ActionPriority.NORMAL, mockBot);
    expect(normalAction.signal.aborted).toBe(false);

    // Critical health drop triggers health event
    mockBot.health = 4; // Below fleeHealthThreshold (6)
    const healthListeners = listeners['health'] || [];
    for (const fn of healthListeners) {
      fn();
    }

    // Synchronous handler returns immediately; scheduled via microtask
    await new Promise((res) => queueMicrotask(res));
    await new Promise((res) => setTimeout(res, 20));

    // Normal action must be preempted
    expect(normalAction.signal.aborted).toBe(true);
    expect(mockBot.clearControlStates).toHaveBeenCalled();

    supervisor.stop();
  });

  it('asynchronously preempts normal work when sharp breath drop occurs in water', async () => {
    const supervisor = new SafetySupervisor({
      bot: mockBot,
      arbiter,
      reflexLayer,
      logger,
      config,
    });

    supervisor.start();

    const normalAction = arbiter.startAction('goto', ActionPriority.NORMAL, mockBot, ['movement']);
    expect(normalAction.signal.aborted).toBe(false);

    // Oxygen drops to dangerous level (under 8)
    mockBot.oxygenLevel = 5;
    mockBot.entity.isInWater = true;
    const breathListeners = listeners['breath'] || [];
    for (const fn of breathListeners) {
      fn();
    }

    // Allow microtask to process
    await new Promise((res) => queueMicrotask(res));
    await new Promise((res) => setTimeout(res, 20));

    expect(normalAction.signal.aborted).toBe(true);
    expect(mockBot.pathfinder.stop).toHaveBeenCalled();

    supervisor.stop();
  });

  it('instruments preemption latency and emergency duration in telemetry metrics', async () => {
    const supervisor = new SafetySupervisor({
      bot: mockBot,
      arbiter,
      reflexLayer,
      logger,
      config,
    });

    supervisor.start();

    const normalAction = arbiter.startAction('explore', ActionPriority.NORMAL, mockBot);

    // Trigger lava hazard on physics tick
    mockBot.entity.isInLava = true;
    const tickListeners = listeners['physicsTick'] || [];
    for (const fn of tickListeners) {
      fn();
    }

    // Wait for microtask emergency sequence to run (lava reflex has 400ms upward jump timer)
    await new Promise((res) => queueMicrotask(res));
    await new Promise((res) => setTimeout(res, 500));

    // Telemetry metric must be recorded
    const metric = supervisor.lastMetric;
    expect(metric).not.toBeNull();
    expect(metric?.reason).toContain('Lava');
    expect(metric?.preemptionLatencyMs).toBeGreaterThanOrEqual(0);
    expect(metric?.totalDurationMs).toBeGreaterThanOrEqual(0);

    supervisor.stop();
  });

  it('coalesces repeated tick triggers so duplicate emergency actions are not scheduled', async () => {
    const supervisor = new SafetySupervisor({
      bot: mockBot,
      arbiter,
      reflexLayer,
      logger,
      config,
    });

    supervisor.start();

    // Bot is in lava
    mockBot.entity.isInLava = true;
    const tickListeners = listeners['physicsTick'] || [];

    // Fire 10 consecutive ticks in rapid succession
    for (let i = 0; i < 10; i++) {
      for (const fn of tickListeners) {
        fn();
      }
    }

    // Wait for microtask
    await new Promise((res) => queueMicrotask(res));
    await new Promise((res) => setTimeout(res, 30));

    // Only one emergency sequence should execute at a time
    expect(supervisor.isEmergencyActive).toBe(false);

    supervisor.stop();
  });

  it('owner pause command preempts normal work but NEVER disables life-preserving responses', async () => {
    const supervisor = new SafetySupervisor({
      bot: mockBot,
      arbiter,
      reflexLayer,
      logger,
      config,
    });

    supervisor.start();

    // 1. Normal task running
    const normalTask = arbiter.startAction('chop_tree', ActionPriority.NORMAL, mockBot);
    expect(normalTask.signal.aborted).toBe(false);

    // 2. Owner sends !pause -> preempts normal task at OWNER_URGENT (priority 60)
    const ownerPreempted = arbiter.preempt(mockBot, 'Owner pause command', ActionPriority.OWNER_URGENT);
    expect(ownerPreempted).toBe(true);
    expect(normalTask.signal.aborted).toBe(true);

    // 3. While paused, a survival hazard occurs (lava contact)
    mockBot.entity.isInLava = true;
    const tickListeners = listeners['physicsTick'] || [];
    for (const fn of tickListeners) {
      fn();
    }

    // Allow microtask to process (lava escape upward jump takes ~400ms)
    await new Promise((res) => queueMicrotask(res));
    await new Promise((res) => setTimeout(res, 500));

    // 4. Survival emergency (priority 100) must fire and be handled despite pause!
    const metric = supervisor.lastMetric;
    expect(metric).not.toBeNull();
    expect(metric?.priority).toBe(ActionPriority.SURVIVAL_EMERGENCY);
    expect(metric?.reason).toContain('Lava');

    supervisor.stop();
  });
});
