import { Vec3 } from 'vec3';
import { ScenarioDefinition, AssertionResult } from '../types.js';

export const unreachableTargetScenario: ScenarioDefinition = {
  id: 'reject_unreachable_target',
  name: 'Reject Unreachable Floating Target Without Stalling',
  contractId: 'goto',
  targetAction: 'goto',
  params: {
    // Will be dynamically populated or defaulted
    x: 0,
    y: 120,
    z: 0,
    range: 1.5,
  },
  phaseBudgets: {
    setupTimeoutMs: 5000,
    actionTimeoutMs: 15000,
    settlingTimeoutMs: 1000,
    noProgressTimeoutMs: 5000,
  },

  setup: async (context) => {
    const bot = context.bot;
    if (bot && bot.entity) {
      // Set target coordinates 35 blocks above current bot position (floating in the sky)
      const p = bot.entity.position;
      unreachableTargetScenario.params.x = Math.round(p.x);
      unreachableTargetScenario.params.y = Math.min(250, Math.round(p.y + 35));
      unreachableTargetScenario.params.z = Math.round(p.z);
      context.recordMilestone(
        'SETUP',
        `Configured unreachable floating target at (${unreachableTargetScenario.params.x}, ${unreachableTargetScenario.params.y}, ${unreachableTargetScenario.params.z})`
      );
    }
  },

  preconditionCheck: async (context) => {
    const bot = context.bot;
    if (!bot || !bot.entity) {
      return { ok: false, reason: 'Bot entity not available.' };
    }

    const p = bot.entity.position;
    const targetY = unreachableTargetScenario.params.y;
    if (targetY - p.y < 5) {
      return { ok: false, reason: `Target elevation (${targetY}) is too close to bot elevation (${p.y.toFixed(1)}).` };
    }

    return { ok: true };
  },

  assertions: async (context, execResult) => {
    const assertions: AssertionResult[] = [];
    const { agentResult, events } = execResult;

    // 1. Action was rejected cleanly with failed status
    assertions.push({
      name: 'action_rejected_safely',
      passed: agentResult !== null && agentResult.status === 'failed',
      expected: 'failed',
      actual: agentResult?.status || 'null',
      message: `Agent returned status '${agentResult?.status}' with reason: '${agentResult?.reason || ''}'.`,
    });

    // 2. Failure reason explains why (unreachable, chasm, height, hazard, bounds, or floating)
    const reasonText = (agentResult?.reason || '').toLowerCase();
    const hasInformativeReason =
      reasonText.includes('unreachable') ||
      reasonText.includes('path') ||
      reasonText.includes('chasm') ||
      reasonText.includes('drop') ||
      reasonText.includes('hazard') ||
      reasonText.includes('distance') ||
      reasonText.includes('validation') ||
      reasonText.includes('floating') ||
      reasonText.includes('mid-air') ||
      reasonText.includes('footing');

    assertions.push({
      name: 'informative_failure_reason',
      passed: hasInformativeReason,
      expected: 'informative rejection reason (unreachable / hazard / path)',
      actual: agentResult?.reason || 'none',
      message: hasInformativeReason
        ? `Informative rejection reason provided: "${agentResult?.reason}"`
        : `Rejection reason "${agentResult?.reason}" lacks reachability context.`,
    });

    // 3. No repeated retry loops (attempt count <= 1)
    const rawAttempt = agentResult?.details?.attempt;
    const attemptCount = typeof rawAttempt === 'number' ? rawAttempt : rawAttempt ? 1 : 0;
    assertions.push({
      name: 'no_repeated_retry_loop',
      passed: attemptCount <= 1,
      expected: '<= 1 attempt',
      actual: `${attemptCount} attempts`,
      message: attemptCount <= 1
        ? 'Target rejected without repeated retries or cycling.'
        : `Action engaged in ${attemptCount} repeated attempts.`,
    });

    // 4. Server observer confirms no destructive side effects occurred
    // (excluding ambient environmental events like natural leaf decay, or distant ambient world ticks > 8 blocks away)
    const botPos = context.bot?.entity?.position;
    const destructiveEvents = events.filter((e) => {
      if (e.eventType !== 'BLOCK_BREAK' && e.eventType !== 'BLOCK_PLACE') return false;
      if (e.blockId?.endsWith('_leaves')) return false;
      if (botPos && e.coordinates) {
        const dx = e.coordinates.x - botPos.x;
        const dy = e.coordinates.y - botPos.y;
        const dz = e.coordinates.z - botPos.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist > 8) return false;
      }
      return true;
    });
    assertions.push({
      name: 'no_destructive_server_events',
      passed: destructiveEvents.length === 0,
      expected: '0 destructive events',
      actual: `${destructiveEvents.length} events`,
      message: destructiveEvents.length === 0
        ? 'No block break or place events were generated on the server.'
        : `Unexpected server events occurred: ${JSON.stringify(destructiveEvents)}`,
    });

    return assertions;
  },

  cleanup: async (context) => {
    context.recordMilestone('CLEANUP', 'Unreachable target scenario cleanup complete.');
  },
};
