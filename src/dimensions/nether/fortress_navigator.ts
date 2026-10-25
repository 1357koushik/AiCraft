import { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { goals } from 'mineflayer-pathfinder';
import { ActionResult, ActionExecutionContext } from '../../types/index.js';
import { isActionContextActive } from '../../agent/arbiter.js';
import { updatePathfinderMovements } from '../../actions/techniques.js';

export const NETHER_FORTRESS_BLOCKS = new Set([
  'nether_bricks',
  'nether_brick_fence',
  'nether_brick_stairs',
  'nether_brick_slab',
  'nether_brick_wall',
]);

/**
 * Checks whether a block name belongs to a Nether Fortress structure.
 */
export function isFortressBlock(blockName?: string | null): boolean {
  if (!blockName) return false;
  return NETHER_FORTRESS_BLOCKS.has(blockName.toLowerCase());
}

/**
 * Scans surrounding blocks to locate the nearest Nether Fortress structure.
 */
export function detectNearbyFortress(bot: Bot, maxDistance: number = 48): Vec3 | null {
  if (!bot.findBlock) return null;

  const blk = bot.findBlock({
    matching: (b: any) => isFortressBlock(b?.name),
    maxDistance,
  });

  return blk ? blk.position : null;
}

/**
 * Validates that a walkway position has solid footing and does not overhang a deadly lava lake (Y < 32).
 */
export function isFortressWalkwaySafe(bot: Bot, floorPos: Vec3): boolean {
  if (!bot.blockAt) return true;

  // In Nether, lava sea generates at Y = 31. Any drop below Y = 32 is deadly lava.
  if (floorPos.y < 32) return false;

  const floor = bot.blockAt(floorPos);
  if (!floor || floor.boundingBox !== 'block') return false;

  // Check blocks beneath for lava
  for (let dy = 1; dy <= 4; dy++) {
    const below = bot.blockAt(floorPos.offset(0, -dy, 0));
    if (below && (below.name === 'lava' || below.name === 'flowing_lava')) {
      return false;
    }
  }

  return true;
}

/**
 * Navigates safely along Nether Fortress corridors and bridges to a destination.
 */
export async function techniqueTraverseFortressCorridor(
  bot: Bot,
  targetPos: Vec3,
  ctx: ActionExecutionContext
): Promise<ActionResult> {
  if (!isActionContextActive(ctx)) {
    return { status: 'interrupted', reason: 'Fortress navigation cancelled before start.' };
  }

  if (!isFortressWalkwaySafe(bot, targetPos.offset(0, -1, 0))) {
    return {
      status: 'failed',
      reason: 'Destination walkway is unsafe or overhangs lava sea.',
    };
  }

  if ((bot as any).pathfinder) {
    try {
      updatePathfinderMovements(bot);
      const goal = new goals.GoalNear(targetPos.x, targetPos.y, targetPos.z, 1.5);
      await (bot as any).pathfinder.goto(goal);
      return {
        status: 'success',
        reason: `Successfully traversed fortress corridor to (${targetPos.x}, ${targetPos.y}, ${targetPos.z}).`,
      };
    } catch (err: any) {
      return {
        status: 'failed',
        reason: `Fortress navigation failed: ${err.message}`,
      };
    }
  }

  return { status: 'failed', reason: 'Pathfinder unavailable.' };
}
