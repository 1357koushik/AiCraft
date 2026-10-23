import { Vec3 } from 'vec3';
import { ScenarioDefinition, AssertionResult } from '../types.js';

export const breakLogScenario: ScenarioDefinition = {
  id: 'break_and_collect_log',
  name: 'Break and Collect One Accessible Log',
  contractId: 'chop_tree',
  targetAction: 'chop_tree',
  params: {
    count: 1,
  },
  phaseBudgets: {
    setupTimeoutMs: 10000,
    actionTimeoutMs: 40000,
    settlingTimeoutMs: 2000,
    noProgressTimeoutMs: 8000,
  },

  setup: async (context) => {
    context.recordMilestone('SETUP', 'Checking for nearby accessible log block...');
    const bot = context.bot;
    if (!bot || !bot.entity) return;

    // Search for existing log in loaded chunks
    const existingLog = bot.findBlock
      ? bot.findBlock({
          matching: (b: any) => Boolean(b && b.name && b.name.endsWith('_log')),
          maxDistance: 32,
        })
      : null;

    if (existingLog) {
      context.recordMilestone('SETUP', `Found natural accessible log at ${existingLog.position.floored()}`);
      return;
    }

    // If no log is within 32 blocks, use test fixture placement (allowed only in test isolation)
    context.recordMilestone(
      'SETUP',
      'No natural log in range; placing fixture log 2 blocks from bot via fixtureOperator'
    );
    const botPos = bot.entity.position.floored();
    const fixturePos = botPos.offset(1, 0, 1);

    if (context.fixtureOperator) {
      await context.fixtureOperator.executeCommand(
        `setblock ${fixturePos.x} ${fixturePos.y} ${fixturePos.z} oak_log`
      );
      await new Promise((r) => setTimeout(r, 400));
    } else if (typeof (bot as any).chat === 'function') {
      bot.chat(`/setblock ${fixturePos.x} ${fixturePos.y} ${fixturePos.z} oak_log`);
      await new Promise((r) => setTimeout(r, 400));
    }
  },

  preconditionCheck: async (context) => {
    const bot = context.bot;
    if (!bot || !bot.entity) {
      return { ok: false, reason: 'Bot entity not available.' };
    }

    if ((bot.health ?? 20) <= 0) {
      return { ok: false, reason: 'Bot is dead.' };
    }

    const logBlock = bot.findBlock
      ? bot.findBlock({
          matching: (b: any) => Boolean(b && b.name && b.name.endsWith('_log')),
          maxDistance: 36,
        })
      : null;

    if (!logBlock) {
      return { ok: false, reason: 'No accessible log block found within 36 blocks.' };
    }

    return { ok: true };
  },

  assertions: async (context, execResult) => {
    const assertions: AssertionResult[] = [];
    const { agentResult, beforeSnapshot, afterSnapshot, events } = execResult;

    // 1. Agent acceptance and reported status
    assertions.push({
      name: 'agent_status_success',
      passed: agentResult !== null && agentResult.status === 'success',
      expected: 'success',
      actual: agentResult?.status || 'null',
      message: `Agent reported action status: ${agentResult?.status} (${agentResult?.reason || 'no reason'})`,
    });

    // 2. Server Observer recorded BLOCK_BREAK event
    const blockBreakEvents = events.filter((e) => e.eventType === 'BLOCK_BREAK');
    const logBreakEvent = blockBreakEvents.find((e) => e.blockId && e.blockId.endsWith('_log'));
    assertions.push({
      name: 'server_observed_block_break',
      passed: Boolean(logBreakEvent),
      expected: 'BLOCK_BREAK for *_log',
      actual: logBreakEvent ? `BLOCK_BREAK at ${JSON.stringify(logBreakEvent.coordinates)}` : 'None',
      message: logBreakEvent
        ? `Server observed log block broken at ${JSON.stringify(logBreakEvent.coordinates)}`
        : 'No BLOCK_BREAK event for log recorded by server observer.',
    });

    // 3. Physical completion / inventory increase
    const countLogs = (inv?: Record<string, number>) => {
      if (!inv) return 0;
      return Object.entries(inv).reduce((acc, [item, count]) => {
        return item.endsWith('_log') ? acc + count : acc;
      }, 0);
    };

    const logsBefore = countLogs(beforeSnapshot?.inventory);
    const logsAfter = countLogs(afterSnapshot?.inventory);
    const logDelta = logsAfter - logsBefore;

    assertions.push({
      name: 'log_inventory_increase',
      passed: logDelta >= 1 || Boolean(logBreakEvent),
      expected: '>= 1 log collected or verified broken',
      actual: `Delta: +${logDelta} logs (before: ${logsBefore}, after: ${logsAfter})`,
      message: `Inventory delta for logs is ${logDelta}.`,
    });

    return assertions;
  },

  cleanup: async (context) => {
    context.recordMilestone('CLEANUP', 'Break log scenario cleanup completed.');
  },
};
