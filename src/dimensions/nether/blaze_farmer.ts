import { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { goals } from 'mineflayer-pathfinder';
import { ActionResult, ActionExecutionContext } from '../../types/index.js';
import { isAlive } from '../../safety/index.js';
import { isActionContextActive } from '../../agent/arbiter.js';
import { equipBestWeapon, getAttackCooldownMs } from '../../actions/combat/mob_tactics.js';
import { ensureShieldInOffHand, raiseShieldAgainst } from '../../actions/combat/shield_manager.js';
import { techniqueVacuumDrops } from '../../actions/techniques.js';

/**
 * Finds a Blaze Spawner block within radius.
 */
export function findNearbyBlazeSpawner(bot: Bot, maxDistance: number = 32): any | null {
  if (!bot.findBlock) return null;
  return bot.findBlock({
    matching: (b: any) => b.name === 'spawner',
    maxDistance,
  });
}

/**
 * Counts total Blaze Rods currently in inventory.
 */
export function countBlazeRods(bot: Bot): number {
  if (!bot || !bot.inventory) return 0;
  return bot.inventory.items().filter((i) => i.name === 'blaze_rod').reduce((acc, i) => acc + (i.count || 0), 0);
}

/**
 * Finds the nearest living Blaze entity.
 */
export function findNearestBlaze(bot: Bot, maxDistance: number = 24): any | null {
  if (!bot.entities || !bot.entity) return null;

  let nearest: any = null;
  let minDist = maxDistance;

  for (const id of Object.keys(bot.entities)) {
    const ent = bot.entities[id];
    if (ent && ent !== bot.entity && isAlive(ent) && ent.name === 'blaze') {
      const dist = bot.entity.position.distanceTo(ent.position);
      if (dist < minDist) {
        minDist = dist;
        nearest = ent;
      }
    }
  }

  return nearest;
}

/**
 * Blaze Farming Pipeline:
 * Positions bot near a Blaze Spawner, raises off-hand shield to block fire charges,
 * strikes blazes with weapon during cooldowns, and vacuums dropped Blaze Rods until
 * target quota (default: 7 blaze rods) is achieved.
 */
export async function techniqueFarmBlazeRods(
  bot: Bot,
  targetRods: number = 7,
  ctx: ActionExecutionContext
): Promise<ActionResult> {
  if (!isActionContextActive(ctx)) {
    return { status: 'interrupted', reason: 'Blaze farming cancelled before start.' };
  }

  await equipBestWeapon(bot);
  await ensureShieldInOffHand(bot);

  const initialRods = countBlazeRods(bot);
  if (initialRods >= targetRods) {
    return {
      status: 'success',
      reason: `Blaze rod quota already satisfied (${initialRods}/${targetRods}).`,
      details: { harvested: 0, totalRods: initialRods },
    };
  }

  // 1. Locate spawner and approach to optimal farming distance (~4-6m)
  const spawner = findNearbyBlazeSpawner(bot, 32);
  if (spawner && bot.entity) {
    const dist = bot.entity.position.distanceTo(spawner.position);
    if (dist > 6 && (bot as any).pathfinder) {
      try {
        const goal = new goals.GoalNear(spawner.position.x, spawner.position.y, spawner.position.z, 4);
        await (bot as any).pathfinder.goto(goal);
      } catch {}
    }
  }

  let blazesKilled = 0;
  const maxCycles = 20;

  for (let cycle = 0; cycle < maxCycles; cycle++) {
    if (!isActionContextActive(ctx)) {
      return { status: 'interrupted', reason: 'Blaze farming cancelled.' };
    }

    if (countBlazeRods(bot) >= targetRods) break;

    const blaze = findNearestBlaze(bot, 24);
    if (!blaze) {
      // Await next spawn wave (~400ms)
      await new Promise((res) => setTimeout(res, 400));
      continue;
    }

    const dist = bot.entity.position.distanceTo(blaze.position);

    // If blaze is winding up fire charges, raise shield to block fireballs
    if (dist > 3.0) {
      await raiseShieldAgainst(bot, blaze, 800, ctx.abortSignal, ctx.isCurrent);
      if (!isActionContextActive(ctx)) break;

      // Close distance
      if ((bot as any).pathfinder) {
        try {
          const goal = new goals.GoalNear(blaze.position.x, blaze.position.y, blaze.position.z, 2.5);
          (bot as any).pathfinder.setGoal(goal);
          await new Promise((res) => setTimeout(res, 400));
          (bot as any).pathfinder.setGoal(null);
        } catch {}
      }
    }

    if (!isActionContextActive(ctx)) break;

    // Strike blaze
    const cooldown = getAttackCooldownMs(bot.heldItem?.name);
    if (bot.lookAt) {
      await bot.lookAt(blaze.position.offset(0, blaze.height ? blaze.height / 2 : 1.0, 0), true);
    }
    if (bot.attack) {
      bot.attack(blaze);
      blazesKilled++;
    }

    await new Promise((res) => setTimeout(res, cooldown));

    // Vacuum dropped blaze rods
    try {
      await techniqueVacuumDrops(bot, 3.5, ctx.abortSignal, ctx.isCurrent);
    } catch {}
  }

  const finalRods = countBlazeRods(bot);
  const netGained = finalRods - initialRods;

  return {
    status: finalRods >= targetRods || netGained > 0 ? 'success' : 'failed',
    reason: `Blaze farming completed (${blazesKilled} blazes engaged). Total blaze rods: ${finalRods}/${targetRods}.`,
    details: {
      netGained,
      totalRods: finalRods,
      blazesKilled,
    },
  };
}
