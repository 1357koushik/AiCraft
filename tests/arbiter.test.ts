import { describe, it, expect, vi } from 'vitest';
import { Vec3 } from 'vec3';
import { ActionArbiter, ActionPriority, isActionContextActive, Actuator } from '../src/agent/arbiter.js';
import { miningBuildingActions } from '../src/actions/mining_building.js';
import { combatActions } from '../src/actions/combat.js';
import { metaActions } from '../src/actions/meta.js';
import { techniqueMineStaircase } from '../src/actions/techniques.js';

describe('ActionArbiter & Cancellation Propagation', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  it('manages single action lifecycle and returns an active AbortSignal', () => {
    const arbiter = new ActionArbiter(logger);
    expect(arbiter.isBusy()).toBe(false);

    const { actionId, signal } = arbiter.startAction('goto', ActionPriority.NORMAL);
    expect(arbiter.isBusy()).toBe(true);
    expect(arbiter.activeActionName).toBe('goto');
    expect(signal.aborted).toBe(false);

    arbiter.finishAction(actionId);
    expect(arbiter.isBusy()).toBe(false);
  });

  it('preempts a running normal action when an emergency reflex fires', () => {
    const arbiter = new ActionArbiter(logger);
    const mockBot: any = {
      pathfinder: { stop: vi.fn(), setGoal: vi.fn() },
      clearControlStates: vi.fn(),
      deactivateItem: vi.fn(),
    };

    const { signal } = arbiter.startAction('mine_staircase', ActionPriority.NORMAL, mockBot);
    expect(signal.aborted).toBe(false);

    let signalAborted = false;
    signal.addEventListener('abort', () => {
      signalAborted = true;
    });

    const preempted = arbiter.preempt(mockBot, 'Lava hazard', ActionPriority.SURVIVAL_EMERGENCY);
    expect(preempted).toBe(true);
    expect(signal.aborted).toBe(true);
    expect(signalAborted).toBe(true);
    expect(mockBot.pathfinder.stop).toHaveBeenCalled();
    expect(mockBot.clearControlStates).toHaveBeenCalled();
    expect(mockBot.deactivateItem).toHaveBeenCalled();
    expect(arbiter.isBusy()).toBe(false);
  });

  it('prevents a lower-priority action from preempting a higher-priority action', () => {
    const arbiter = new ActionArbiter(logger);
    arbiter.startAction('lava_escape', ActionPriority.SURVIVAL_EMERGENCY);

    // Normal action tries to start while survival emergency is active
    expect(() => {
      arbiter.startAction('chop_tree', ActionPriority.NORMAL);
    }).toThrow(/higher priority action 'lava_escape'/);

    expect(arbiter.activeActionName).toBe('lava_escape');
  });

  it('ensures cleanup from an old preempted action cannot cancel or clear a newer action', () => {
    const arbiter = new ActionArbiter(logger);
    const mockBot: any = {
      clearControlStates: vi.fn(),
      deactivateItem: vi.fn(),
    };

    // Action 1 starts
    const action1 = arbiter.startAction('goto', ActionPriority.NORMAL, mockBot);

    // Action 2 starts and preempts action 1
    const action2 = arbiter.startAction('attack', ActionPriority.COMBAT_REFLEX, mockBot);
    expect(action1.signal.aborted).toBe(true);
    expect(action2.signal.aborted).toBe(false);
    expect(arbiter.activeActionId).toBe(action2.actionId);

    // Action 1's delayed finally block runs and attempts to finish action 1
    arbiter.finishAction(action1.actionId, mockBot);

    // Arbiter must STILL have action 2 active!
    expect(arbiter.isBusy()).toBe(true);
    expect(arbiter.activeActionId).toBe(action2.actionId);

    // Action 2 finishes cleanly
    arbiter.finishAction(action2.actionId, mockBot);
    expect(arbiter.isBusy()).toBe(false);
  });

  it('handles repeated cancellation safely without throwing', () => {
    const arbiter = new ActionArbiter(logger);
    const mockBot: any = {
      clearControlStates: vi.fn(),
      deactivateItem: vi.fn(),
    };

    expect(arbiter.preempt(mockBot, 'First preempt')).toBe(false);
    expect(arbiter.preempt(mockBot, 'Second preempt')).toBe(false);
  });

  it('unconditionally cancels all running actions and releases controls on cancelAll', () => {
    const arbiter = new ActionArbiter(logger);
    const mockBot: any = {
      pathfinder: { stop: vi.fn(), setGoal: vi.fn() },
      clearControlStates: vi.fn(),
      deactivateItem: vi.fn(),
    };

    const action = arbiter.startAction('bridge', ActionPriority.NORMAL, mockBot);
    expect(arbiter.isBusy()).toBe(true);

    arbiter.cancelAll(mockBot);
    expect(action.signal.aborted).toBe(true);
    expect(arbiter.isBusy()).toBe(false);
    expect(mockBot.clearControlStates).toHaveBeenCalled();
  });

  it('prevents a cancelled action with late promise resolution from clearing controls or stopping newer Action B', async () => {
    const arbiter = new ActionArbiter(logger);
    let lateResolve: () => void = () => {};
    const longRunningPromise = new Promise<void>((res) => {
      lateResolve = res;
    });

    const controlStates: Record<string, boolean> = {};
    const mockBot: any = {
      pathfinder: {
        goto: vi.fn().mockImplementation(() => longRunningPromise),
        stop: vi.fn(),
        setGoal: vi.fn(),
      },
      clearControlStates: vi.fn().mockImplementation(() => {
        for (const k of Object.keys(controlStates)) controlStates[k] = false;
      }),
      setControlState: vi.fn().mockImplementation((state: string, val: boolean) => {
        controlStates[state] = val;
      }),
      deactivateItem: vi.fn(),
      entity: { position: { x: 0, y: 64, z: 0 } },
      blockAt: vi.fn().mockReturnValue({ name: 'dirt', boundingBox: 'block' }),
    };

    // 1. Action A starts
    const actionA = arbiter.startAction('goto', ActionPriority.NORMAL, mockBot);
    const ctxA = {
      bot: mockBot,
      observation: { entities: [], blocks: { notableBlocks: [] }, vitals: { isAlive: true } } as any,
      config: { perception: { scanRadius: 16 } },
      logger,
      abortSignal: actionA.signal,
      actionId: actionA.actionId,
      isCurrent: () => arbiter.isActionActive(actionA.actionId),
    };

    // Run action A in background (simulating pathfinding goto)
    let actionAFinished = false;
    const actionAPromise = (async () => {
      try {
        await mockBot.pathfinder.goto();
      } finally {
        if (isActionContextActive(ctxA)) {
          mockBot.pathfinder.stop();
          mockBot.clearControlStates();
        }
      }
      actionAFinished = true;
    })();

    // 2. Emergency cancels Action A
    arbiter.preempt(mockBot, 'Lava hazard', ActionPriority.SURVIVAL_EMERGENCY);
    expect(actionA.signal.aborted).toBe(true);

    // 3. Action B starts immediately and sets movement controls
    const actionB = arbiter.startAction('lava_escape', ActionPriority.SURVIVAL_EMERGENCY, mockBot);
    mockBot.setControlState('forward', true);
    mockBot.setControlState('jump', true);
    expect(controlStates['forward']).toBe(true);
    expect(controlStates['jump']).toBe(true);

    // Reset mocks to inspect whether late Action A cleanup touches them
    mockBot.pathfinder.stop.mockClear();
    mockBot.clearControlStates.mockClear();

    // 4. Action A's awaited operation resolves late and enters its finally block
    lateResolve();
    await actionAPromise;
    expect(actionAFinished).toBe(true);

    // 5. Verification: Action A's cleanup did NOT clear Action B's controls or stop pathfinder!
    expect(mockBot.pathfinder.stop).not.toHaveBeenCalled();
    expect(mockBot.clearControlStates).not.toHaveBeenCalled();
    expect(controlStates['forward']).toBe(true);
    expect(controlStates['jump']).toBe(true);
    expect(arbiter.activeActionId).toBe(actionB.actionId);
  });

  it('cancels immediately before block placement without calling placeBlock', async () => {
    const placeAction = miningBuildingActions.find((a) => a.name === 'place_block');
    expect(placeAction).toBeDefined();

    const mockBot: any = {
      entity: { position: new Vec3(0, 64, 0) },
      inventory: {
        items: vi.fn().mockReturnValue([{ name: 'cobblestone', type: 10 }]),
      },
      heldItem: { name: 'cobblestone', type: 10 },
      equip: vi.fn().mockResolvedValue(undefined),
      placeBlock: vi.fn().mockResolvedValue(undefined),
      blockAt: vi.fn().mockReturnValue({ name: 'stone', boundingBox: 'block', position: new Vec3(0, 63, 0) }),
    };

    const abortController = new AbortController();
    const ctx: any = {
      bot: mockBot,
      observation: { inventory: { aggregates: { totalItemCounts: { cobblestone: 10 } } } },
      abortSignal: abortController.signal,
      isCurrent: () => !abortController.signal.aborted,
    };

    // Pre-empt / abort before execution
    abortController.abort();

    const res = await placeAction!.execute(mockBot, { blockName: 'cobblestone', x: 0, y: 64, z: 0 }, ctx);
    expect(res.status).toBe('interrupted');
    expect(mockBot.placeBlock).not.toHaveBeenCalled();
  });

  it('cancels during bow draw without shooting arrow or throwing unhandled error', async () => {
    const shootAction = combatActions.find((a) => a.name === 'shoot');
    expect(shootAction).toBeDefined();

    const mockBot: any = {
      entity: { position: new Vec3(0, 64, 0) },
      inventory: {
        items: vi.fn().mockReturnValue([{ name: 'bow', type: 20 }]),
      },
      equip: vi.fn().mockResolvedValue(undefined),
      lookAt: vi.fn().mockResolvedValue(undefined),
      activateItem: vi.fn(),
      deactivateItem: vi.fn(),
      entities: {
        10: { id: 10, name: 'skeleton', type: 'skeleton', position: new Vec3(5, 64, 0), isValid: true, health: 20 },
      },
    };

    const abortController = new AbortController();
    const ctx: any = {
      bot: mockBot,
      observation: {
        vitals: { isAlive: true },
        inventory: { aggregates: { totalItemCounts: { bow: 1, arrow: 10 } } },
        entities: [{ id: 'e1', rawId: 10, name: 'skeleton', type: 'skeleton', isHostile: true, isOwner: false, isItem: false }],
      },
      config: {
        agent: { owners: [], friends: [] },
        safety: { safeYRange: [0, 256], maxCombatReach: 16, protectedEntities: [] },
      },
      abortSignal: abortController.signal,
      isCurrent: () => !abortController.signal.aborted,
    };

    // Trigger abort 100ms into the draw
    setTimeout(() => {
      abortController.abort();
    }, 100);

    const res = await shootAction!.execute(mockBot, { targetId: 'e1' }, ctx);
    expect(res.status).toBe('interrupted');
    expect(mockBot.deactivateItem).toHaveBeenCalled();
  });

  it('aborts staircase mining immediately when cancelled mid-run and avoids subsequent digs', async () => {
    let digsCount = 0;
    const mockBot: any = {
      entity: { position: new Vec3(0, 64, 0), yaw: 0 },
      blockAt: vi.fn().mockReturnValue({ name: 'stone', boundingBox: 'block' }),
      dig: vi.fn().mockImplementation(async () => {
        digsCount++;
        await new Promise((res) => setTimeout(res, 50));
      }),
      clearControlStates: vi.fn(),
      pathfinder: { stop: vi.fn() },
    };

    const abortController = new AbortController();
    const isCurrent = () => !abortController.signal.aborted;

    // Abort after 80ms (during step 1)
    setTimeout(() => {
      abortController.abort();
    }, 80);

    const res = await techniqueMineStaircase(mockBot, 6, abortController.signal, isCurrent);
    expect(res.status).toBe('interrupted');
    // Did not complete all 6 steps
    expect(digsCount).toBeLessThan(4);
  });

  it('cancels shield block cleanly when preempted', async () => {
    const shieldAction = combatActions.find((a) => a.name === 'block_with_shield');
    expect(shieldAction).toBeDefined();

    const mockBot: any = {
      inventory: {
        items: vi.fn().mockReturnValue([{ name: 'shield', type: 30 }]),
      },
      equip: vi.fn().mockResolvedValue(undefined),
      activateItem: vi.fn(),
      deactivateItem: vi.fn(),
    };

    const abortController = new AbortController();
    const ctx: any = {
      bot: mockBot,
      observation: { vitals: { isAlive: true }, inventory: { toolSummary: { hasShield: true } } },
      abortSignal: abortController.signal,
      isCurrent: () => !abortController.signal.aborted,
    };

    setTimeout(() => {
      abortController.abort();
    }, 100);

    const res = await shieldAction!.execute(mockBot, { durationMs: 2000 }, ctx);
    expect(res.status).toBe('interrupted');
    expect(mockBot.deactivateItem).toHaveBeenCalled();
  });

  it('cancels immediately during a wait action without waiting for full duration', async () => {
    const { metaActions } = await import('../src/actions/meta.js');
    const waitAction = metaActions.find((a) => a.name === 'wait');
    expect(waitAction).toBeDefined();

    const mockBot: any = {};
    const abortController = new AbortController();
    const ctx: any = {
      bot: mockBot,
      abortSignal: abortController.signal,
      isCurrent: () => !abortController.signal.aborted,
    };

    const startTime = Date.now();
    // Schedule abort after 60ms for a 5-second wait
    setTimeout(() => {
      abortController.abort();
    }, 60);

    const res = await waitAction!.execute(mockBot, { seconds: 5 }, ctx);
    const elapsed = Date.now() - startTime;

    expect(res.status).toBe('interrupted');
    expect(res.reason).toContain('interrupted');
    // Elapsed time should be well under 1 second (around 60-150ms), proving early cancellation
    expect(elapsed).toBeLessThan(1000);
  });

  it('epoch guard prevents late promise completion after timeout from clearing newer action', async () => {
    const { AvailabilityEngine } = await import('../src/actions/availability.js');
    const arbiter = new ActionArbiter(logger);
    const mockBot: any = {
      clearControlStates: vi.fn(),
      deactivateItem: vi.fn(),
      pathfinder: { stop: vi.fn(), setGoal: vi.fn() },
    };

    // Action 1 starts with epoch 1
    const action1 = arbiter.startAction('wait', ActionPriority.NORMAL, mockBot);
    expect(action1.epoch).toBe(1);

    let lateResolve: () => void = () => {};
    const slowOperation = new Promise<void>((resolve) => {
      lateResolve = resolve;
    });

    // Mock execute that waits on slowOperation
    const dummyObs: any = { vitals: { isAlive: true }, container: { isOpen: false } };
    const config: any = { perception: { scanRadius: 16 } };

    // Register a temporary test action in actionMap via techniques or wait
    let lateExecutedMutation = false;
    const testActionPromise = (async () => {
      const res = await AvailabilityEngine.executeWithTimeout(
        'wait',
        { seconds: 10 },
        mockBot,
        dummyObs,
        config,
        logger,
        action1.signal,
        50, // 50ms timeout
        action1.actionId,
        arbiter,
        action1.epoch
      );
      return res;
    })();

    // Wait for timeout to resolve Action 1
    const timeoutResult = await testActionPromise;
    expect(timeoutResult.status).toBe('interrupted');
    expect(timeoutResult.reason).toContain('timed out');

    // Action 2 starts with higher epoch (epoch 2)
    const action2 = arbiter.startAction('chop_tree', ActionPriority.NORMAL, mockBot);
    expect(action2.epoch).toBe(2);
    expect(arbiter.activeActionId).toBe(action2.actionId);
    expect(arbiter.isActionActive(action2.actionId)).toBe(true);

    mockBot.clearControlStates.mockClear();

    // Now Action 1's late background promise finishes and tries to run finishAction
    arbiter.finishAction(action1.actionId, action1.epoch, mockBot);

    // Epoch guard MUST protect Action 2: Action 2 remains active and controls are NOT cleared!
    expect(arbiter.activeActionId).toBe(action2.actionId);
    expect(mockBot.clearControlStates).not.toHaveBeenCalled();

    // Verification of isCurrent for Action 1 vs Action 2
    expect(arbiter.isCurrent(action1.actionId, action1.epoch)).toBe(false);
    expect(arbiter.isCurrent(action2.actionId, action2.epoch)).toBe(true);
  });

  it('preempts normal action when owner issues urgent pause or stop', () => {
    const arbiter = new ActionArbiter(logger);
    const mockBot: any = {
      pathfinder: { stop: vi.fn(), setGoal: vi.fn() },
      clearControlStates: vi.fn(),
      deactivateItem: vi.fn(),
    };

    const action = arbiter.startAction('explore', ActionPriority.NORMAL, mockBot);
    expect(action.signal.aborted).toBe(false);
    expect(arbiter.activePriority).toBe(ActionPriority.NORMAL);

    // Owner urgency preemption (priority 60 > 50)
    const preempted = arbiter.preempt(mockBot, 'Owner pause command', ActionPriority.OWNER_URGENT);
    expect(preempted).toBe(true);
    expect(action.signal.aborted).toBe(true);
    expect(mockBot.pathfinder.setGoal).toHaveBeenCalledWith(null);
    expect(mockBot.pathfinder.stop).toHaveBeenCalled();
    expect(arbiter.isBusy()).toBe(false);
  });

  it('listener cleanup is idempotent and does not call removeAllListeners on shared bot', async () => {
    const { AgentController } = await import('../src/agent/loop.js');
    const { MemoryManager } = await import('../src/memory/index.js');
    const { SafetyManager } = await import('../src/safety/index.js');
    const { loadConfig } = await import('../src/config/index.js');

    const listeners: Record<string, Function[]> = {};
    const mockBot: any = {
      username: 'CleanupTestBot',
      on: vi.fn().mockImplementation((event: string, fn: Function) => {
        if (!listeners[event]) listeners[event] = [];
        listeners[event].push(fn);
      }),
      removeListener: vi.fn().mockImplementation((event: string, fn: Function) => {
        if (listeners[event]) {
          listeners[event] = listeners[event].filter((f) => f !== fn);
        }
      }),
      removeAllListeners: vi.fn(),
      entity: { position: new Vec3(0, 64, 0) },
      chat: vi.fn(),
    };

    const testConfig = loadConfig();
    const controller = new AgentController(
      mockBot,
      testConfig,
      logger,
      new MemoryManager('cleanup_test', './data_test_cleanup'),
      new SafetyManager(testConfig),
      { generateDecision: vi.fn() } as any
    );

    // Verify listeners were attached
    expect(mockBot.on).toHaveBeenCalled();
    const initialListenerCount = mockBot.on.mock.calls.length;
    expect(initialListenerCount).toBeGreaterThan(0);

    // First cleanup
    controller.cleanupEventListeners();
    expect(mockBot.removeAllListeners).not.toHaveBeenCalled();
    expect(mockBot.removeListener).toHaveBeenCalledTimes(initialListenerCount);

    // Second cleanup (must be idempotent: no further removeListener calls)
    mockBot.removeListener.mockClear();
    controller.cleanupEventListeners();
    expect(mockBot.removeListener).not.toHaveBeenCalled();
    expect(mockBot.removeAllListeners).not.toHaveBeenCalled();
  });

  describe('Actuator Ownership & Multi-Actuator Arbitration', () => {
    it('arbitrates conflicting movement requests and rejects unauthorized lower-priority or conflicting equal-priority requests', () => {
      const arbiter = new ActionArbiter(logger);
      const mockBot: any = {
        pathfinder: { stop: vi.fn(), setGoal: vi.fn() },
        clearControlStates: vi.fn(),
        deactivateItem: vi.fn(),
      };

      // 1. Action 1 starts, requesting exclusive 'movement' and 'look' actuators
      const action1 = arbiter.startAction('goto', ActionPriority.NORMAL, mockBot, ['movement', 'look']);
      expect(arbiter.hasActuatorAccess('movement', action1.actionId, action1.epoch)).toBe(true);
      expect(arbiter.hasActuatorAccess('look', action1.actionId, action1.epoch)).toBe(true);
      expect(arbiter.hasActuatorAccess('window', action1.actionId, action1.epoch)).toBe(false);

      // 2. Conflicting request with LOWER priority (e.g. LOW background roaming) -> REJECTED
      expect(() => {
        arbiter.startAction('background_roam', ActionPriority.LOW, mockBot, ['movement']);
      }).toThrow(/actuator 'movement' is currently held by higher priority action 'goto'/);

      // 3. Conflicting request with EQUAL priority and preemptEqual: false -> REJECTED
      expect(() => {
        arbiter.startAction('mine_walk', ActionPriority.NORMAL, mockBot, {
          actuators: ['movement'],
          preemptEqual: false,
        });
      }).toThrow(/actuator 'movement' is currently held by conflicting action 'goto' at equal priority/);

      // 4. Non-conflicting request requesting 'window' actuator (e.g. GUI crafting) -> GRANTED!
      const actionWindow = arbiter.startAction('craft_item', ActionPriority.NORMAL, mockBot, ['window']);
      expect(arbiter.hasActuatorAccess('window', actionWindow.actionId, actionWindow.epoch)).toBe(true);
      // Action 1 still owns movement!
      expect(arbiter.hasActuatorAccess('movement', action1.actionId, action1.epoch)).toBe(true);

      // 5. Higher priority request (SURVIVAL_EMERGENCY) -> PREEMPTS Action 1 on movement
      const emergency = arbiter.startAction('flee_lava', ActionPriority.SURVIVAL_EMERGENCY, mockBot, ['movement', 'look']);
      expect(action1.signal.aborted).toBe(true);
      expect(arbiter.hasActuatorAccess('movement', emergency.actionId, emergency.epoch)).toBe(true);
      expect(arbiter.hasActuatorAccess('movement', action1.actionId, action1.epoch)).toBe(false);

      // Window action was NOT requesting movement, so its window ownership remains intact!
      expect(actionWindow.signal.aborted).toBe(false);
      expect(arbiter.hasActuatorAccess('window', actionWindow.actionId, actionWindow.epoch)).toBe(true);

      // Cleanup
      arbiter.finishAction(emergency.actionId, emergency.epoch, mockBot);
      arbiter.finishAction(actionWindow.actionId, actionWindow.epoch, mockBot);
      expect(arbiter.isBusy()).toBe(false);
    });

    it('performs emergency preemption during active pathfinding', () => {
      const arbiter = new ActionArbiter(logger);
      const mockBot: any = {
        pathfinder: { stop: vi.fn(), setGoal: vi.fn() },
        clearControlStates: vi.fn(),
        deactivateItem: vi.fn(),
      };

      const pathAction = arbiter.startAction('goto', ActionPriority.NORMAL, mockBot, ['movement', 'look']);
      expect(pathAction.signal.aborted).toBe(false);

      // Emergency reflex fires while pathfinding
      const preempted = arbiter.preempt(mockBot, 'Drowning hazard', ActionPriority.SURVIVAL_EMERGENCY);
      expect(preempted).toBe(true);
      expect(pathAction.signal.aborted).toBe(true);

      // Pathfinder must be cleared immediately with setGoal(null) and stop()
      expect(mockBot.pathfinder.setGoal).toHaveBeenCalledWith(null);
      expect(mockBot.pathfinder.stop).toHaveBeenCalled();
      expect(mockBot.clearControlStates).toHaveBeenCalled();
    });

    it('performs emergency preemption during active mining/digging', () => {
      const arbiter = new ActionArbiter(logger);
      const mockBot: any = {
        pathfinder: { stop: vi.fn(), setGoal: vi.fn() },
        clearControlStates: vi.fn(),
        deactivateItem: vi.fn(),
        stopDigging: vi.fn(),
      };

      const mineAction = arbiter.startAction('mine_block', ActionPriority.NORMAL, mockBot, ['hands', 'look']);
      expect(mineAction.signal.aborted).toBe(false);

      // Preempted by hostile reflex
      const preempted = arbiter.preempt(mockBot, 'Hostile attack', ActionPriority.COMBAT_REFLEX);
      expect(preempted).toBe(true);
      expect(mineAction.signal.aborted).toBe(true);

      // stopDigging and deactivateItem must be called
      expect(mockBot.stopDigging).toHaveBeenCalled();
      expect(mockBot.deactivateItem).toHaveBeenCalled();
      expect(mockBot.clearControlStates).toHaveBeenCalled();
    });

    it('performs emergency preemption during waiting', async () => {
      const arbiter = new ActionArbiter(logger);
      const mockBot: any = {
        pathfinder: { stop: vi.fn(), setGoal: vi.fn() },
        clearControlStates: vi.fn(),
        deactivateItem: vi.fn(),
      };

      const waitAction = arbiter.startAction('wait', ActionPriority.NORMAL, mockBot);
      let waitAborted = false;
      waitAction.signal.addEventListener('abort', () => {
        waitAborted = true;
      });

      // Fire emergency
      const preempted = arbiter.preempt(mockBot, 'Lava breach', ActionPriority.SURVIVAL_EMERGENCY);
      expect(preempted).toBe(true);
      expect(waitAborted).toBe(true);
      expect(waitAction.signal.aborted).toBe(true);
    });

    it('releases actuator ownership cleanly after success, failure, and cancellation', () => {
      const arbiter = new ActionArbiter(logger);
      const mockBot: any = {
        pathfinder: { stop: vi.fn(), setGoal: vi.fn() },
        clearControlStates: vi.fn(),
        deactivateItem: vi.fn(),
      };

      // Scenario A: Success releases actuators
      const actionA = arbiter.startAction('task_a', ActionPriority.NORMAL, mockBot, ['movement']);
      expect(arbiter.hasActuatorAccess('movement', actionA.actionId, actionA.epoch)).toBe(true);
      arbiter.finishAction(actionA.actionId, actionA.epoch, mockBot);
      expect(arbiter.hasActuatorAccess('movement', actionA.actionId, actionA.epoch)).toBe(false);
      expect(arbiter.isBusy('movement')).toBe(false);

      // Subsequent action can acquire movement without conflict
      const actionB = arbiter.startAction('task_b', ActionPriority.NORMAL, mockBot, ['movement']);
      expect(arbiter.hasActuatorAccess('movement', actionB.actionId, actionB.epoch)).toBe(true);

      // Scenario B: Failure in finally block releases actuators
      try {
        throw new Error('Task B failed');
      } catch {
        arbiter.finishAction(actionB.actionId, actionB.epoch, mockBot);
      }
      expect(arbiter.isBusy('movement')).toBe(false);

      // Scenario C: Cancellation/preemption reassigns actuator ownership
      const actionC = arbiter.startAction('task_c', ActionPriority.NORMAL, mockBot, ['movement']);
      const emergency = arbiter.startAction('emergency_jump', ActionPriority.SURVIVAL_EMERGENCY, mockBot, ['movement']);
      expect(actionC.signal.aborted).toBe(true);
      expect(arbiter.hasActuatorAccess('movement', emergency.actionId, emergency.epoch)).toBe(true);

      // Action C's late finally block runs
      arbiter.finishAction(actionC.actionId, actionC.epoch, mockBot);

      // Must NOT steal or clear emergency's actuator ownership!
      expect(arbiter.hasActuatorAccess('movement', emergency.actionId, emergency.epoch)).toBe(true);
      arbiter.finishAction(emergency.actionId, emergency.epoch, mockBot);
      expect(arbiter.isBusy('movement')).toBe(false);
    });

    it('ensures an old task cannot resume control or actuate after being superseded', () => {
      const arbiter = new ActionArbiter(logger);
      const mockBot: any = {
        pathfinder: { stop: vi.fn(), setGoal: vi.fn() },
        clearControlStates: vi.fn(),
        deactivateItem: vi.fn(),
      };

      const task1 = arbiter.startAction('old_task', ActionPriority.NORMAL, mockBot, ['movement']);
      const task2 = arbiter.startAction('new_task', ActionPriority.COMBAT_REFLEX, mockBot, ['movement']);

      // Task 1 attempts to check ownership and actuate
      expect(arbiter.hasActuatorAccess('movement', task1.actionId, task1.epoch)).toBe(false);
      expect(arbiter.isCurrent(task1.actionId, task1.epoch)).toBe(false);
      expect(isActionContextActive({ abortSignal: task1.signal, actionId: task1.actionId, epoch: task1.epoch })).toBe(false);

      // Task 2 holds valid ownership
      expect(arbiter.hasActuatorAccess('movement', task2.actionId, task2.epoch)).toBe(true);
      expect(arbiter.isCurrent(task2.actionId, task2.epoch)).toBe(true);
      expect(isActionContextActive({ abortSignal: task2.signal, actionId: task2.actionId, epoch: task2.epoch })).toBe(true);
    });
  });
});
