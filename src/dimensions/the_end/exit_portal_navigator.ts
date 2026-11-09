import { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { goals } from 'mineflayer-pathfinder';
import { ActionResult, ActionExecutionContext } from '../../types/index.js';
import { isActionContextActive } from '../../agent/arbiter.js';
import { updatePathfinderMovements } from '../../actions/techniques.js';

export const CENTRAL_EXIT_PORTAL = new Vec3(0, 65, 0);

/**
 * Finds the activated Exit Portal gateway block at the center of the End island.
 */
export function findExitPortal(bot: Bot): Vec3 | null {
  if (!bot.findBlock) return null;
  const portalBlock = bot.findBlock({
    matching: (b: any) => b.name === 'end_portal',
    maxDistance: 48,
  });
  return portalBlock ? portalBlock.position : null;
}

/**
 * Navigates the bot into the Exit Portal to complete the survival campaign and return home.
 */
export async function techniqueEnterExitPortal(
  bot: Bot,
  ctx: ActionExecutionContext,
  options: { timeoutMs?: number } = {}
): Promise<ActionResult> {
  if (!isActionContextActive(ctx)) {
    return { status: 'interrupted', reason: 'Exit portal navigation cancelled before start.' };
  }

  const portalPos = findExitPortal(bot) || CENTRAL_EXIT_PORTAL;

  if ((bot as any).pathfinder) {
    try {
      updatePathfinderMovements(bot);
      const goal = new goals.GoalNear(portalPos.x, portalPos.y, portalPos.z, 0.8);
      await (bot as any).pathfinder.goto(goal);
    } catch {}
  }

  // Walk into the portal and wait for the server to move the bot to another dimension.
  const startDimension = (bot as any).game?.dimension;
  if (bot.lookAt) {
    await bot.lookAt(portalPos, true);
  }
  bot.setControlState('forward', true);
  const deadline = Date.now() + (options.timeoutMs ?? 10000);
  let changed = false;
  while (Date.now() < deadline) {
    if ((bot as any).game?.dimension !== startDimension) {
      changed = true;
      break;
    }
    await new Promise((res) => setTimeout(res, 100));
  }
  bot.setControlState('forward', false);

  if (!changed) {
    return {
      status: 'failed',
      reason: `Walked toward the exit portal, but the bot is still in ${startDimension ?? 'the same dimension'}.`,
      details: { portalCoordinates: portalPos, failureKind: 'POSTCONDITION_FAILED' },
    };
  }

  return {
    status: 'success',
    reason: `Entered the exit portal; the bot is now in ${(bot as any).game?.dimension}.`,
    details: {
      portalCoordinates: portalPos,
      dimension: (bot as any).game?.dimension,
    },
  };
}
