import { describe, it, expect, vi } from 'vitest';
import { ActionArbiter, ActionPriority } from '../src/agent/arbiter.js';

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
});
