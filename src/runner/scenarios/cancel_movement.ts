import { Vec3 } from 'vec3';
import { ScenarioDefinition, AssertionResult } from '../types.js';

export const cancelMovementScenario: ScenarioDefinition = {
  id: 'cancel_movement_no_side_effects',
  name: 'Cancel Movement and Verify No Superseded Side Effects',
  contractId: 'goto',
  targetAction: 'goto',
  params: {
    x: 0,
    y: 64,
    z: 0,
    range: 1.0,
  },
  phaseBudgets: {
    setupTimeoutMs: 5000,
    actionTimeoutMs: 15000,
    settlingTimeoutMs: 2500,
    noProgressTimeoutMs: 6000,
  },

  setup: async (context) => {
    const bot = context.bot;
    if (bot && bot.entity) {
      const p = bot.entity.position;
      // Target a distant point 20 blocks away
      cancelMovementScenario.params.x = Math.round(p.x + 20);
      cancelMovementScenario.params.y = Math.round(p.y);
      cancelMovementScenario.params.z = Math.round(p.z);

      context.recordMilestone(
        'SETUP',
        `Configured long-distance movement target at (${cancelMovementScenario.params.x}, ${cancelMovementScenario.params.y}, ${cancelMovementScenario.params.z})`
      );

      // Schedule cancellation after 350ms of action dispatch
      setTimeout(() => {
        context.recordMilestone('ACTION', 'Triggering intentional abort cancellation during movement...');
        context.abortController.abort(new Error('Scenario test cancellation: superseding action.'));
      }, 350);
    }
  },

  preconditionCheck: async (context) => {
    const bot = context.bot;
    if (!bot || !bot.entity) {
      return { ok: false, reason: 'Bot entity not available.' };
    }
    return { ok: true };
  },

  assertions: async (context, execResult) => {
    const assertions: AssertionResult[] = [];
    const { agentResult, beforeSnapshot, afterSnapshot, events } = execResult;

    // 1. Agent returns interrupted or cancelled status
    const isInterrupted =
      agentResult !== null &&
      (agentResult.status === 'interrupted' ||
        agentResult.status === 'failed' ||
        (agentResult.reason && agentResult.reason.toLowerCase().includes('cancel')));

    assertions.push({
      name: 'action_cancellation_honored',
      passed: Boolean(isInterrupted),
      expected: 'interrupted (cancelled)',
      actual: agentResult?.status || 'null',
      message: `Agent execution responded to abort signal with: '${agentResult?.status}' (${agentResult?.reason || 'no reason'})`,
    });

    // 2. Bot did not reach the distant destination (distance to destination remains significant)
    const currentPos = context.bot.entity?.position;
    const dest = new Vec3(
      cancelMovementScenario.params.x,
      cancelMovementScenario.params.y,
      cancelMovementScenario.params.z
    );
    const distToDest = currentPos ? currentPos.distanceTo(dest) : 20;

    assertions.push({
      name: 'movement_halted_before_destination',
      passed: distToDest > 5,
      expected: '> 5 blocks from destination (stopped early)',
      actual: `${distToDest.toFixed(2)} blocks away`,
      message: distToDest > 5
        ? `Movement successfully halted ${distToDest.toFixed(2)}m away from destination.`
        : `Bot traveled too close to destination despite cancellation (${distToDest.toFixed(2)}m away).`,
    });

    // 3. No destructive server events occurred (no accidental block digging or placing)
    // (excluding ambient environmental events like natural leaf decay from previously harvested trees)
    const blockEvents = events.filter(
      (e) =>
        (e.eventType === 'BLOCK_BREAK' && !e.blockId?.endsWith('_leaves')) ||
        e.eventType === 'BLOCK_PLACE'
    );
    assertions.push({
      name: 'zero_superseded_block_events',
      passed: blockEvents.length === 0,
      expected: '0 block modification events',
      actual: `${blockEvents.length} events`,
      message: blockEvents.length === 0
        ? 'Confirmed: Zero block modification side effects occurred from superseded movement.'
        : `Unexpected block events after cancellation: ${JSON.stringify(blockEvents)}`,
    });

    return assertions;
  },

  cleanup: async (context) => {
    const bot = context.bot;
    if (bot && (bot as any).pathfinder) {
      try {
        (bot as any).pathfinder.stop();
      } catch {}
    }
    context.recordMilestone('CLEANUP', 'Movement stopped and cleanup completed.');
  },
};
