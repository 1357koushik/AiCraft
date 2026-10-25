import { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { ActionResult, ActionExecutionContext } from '../../types/index.js';
import { isAlive } from '../../safety/index.js';
import { isActionContextActive } from '../../agent/arbiter.js';
import { equipBestWeapon, getAttackCooldownMs } from '../../actions/combat/mob_tactics.js';

export const FOUNTAIN_CENTER = new Vec3(0, 65, 0);

/**
 * Finds the active Ender Dragon entity in the End dimension.
 */
export function findEnderDragon(bot: Bot): any | null {
  if (!bot.entities) return null;
  for (const id of Object.keys(bot.entities)) {
    const ent = bot.entities[id];
    if (ent && isAlive(ent) && (ent.name === 'ender_dragon' || (ent as any).type === 'ender_dragon')) {
      return ent;
    }
  }
  return null;
}

/**
 * Scans for active purple Dragon Breath area effect clouds within radius.
 */
export function detectDragonBreathHazard(bot: Bot, searchRadius: number = 8): Vec3 | null {
  if (!bot.entities || !bot.entity) return null;

  for (const id of Object.keys(bot.entities)) {
    const ent = bot.entities[id];
    if (ent && (ent.name === 'area_effect_cloud' || (ent as any).type === 'area_effect_cloud')) {
      const dist = bot.entity.position.distanceTo(ent.position);
      if (dist <= searchRadius) {
        return ent.position;
      }
    }
  }

  return null;
}

/**
 * Checks if the Ender Dragon is currently in its grounded perch phase at the bedrock fountain.
 */
export function isDragonPerched(dragon: any): boolean {
  if (!dragon || !dragon.position) return false;
  const distFromCenter = Math.hypot(dragon.position.x, dragon.position.z);
  return distFromCenter <= 8.0 && dragon.position.y <= 75.0;
}

/**
 * Evades deadly dragon breath cloud by sprinting away from cloud center.
 */
export async function evadeDragonBreath(bot: Bot, breathPos: Vec3): Promise<void> {
  if (!bot.entity) return;

  const fleeVec = bot.entity.position.minus(breathPos).normalize();
  bot.entity.yaw = Math.atan2(-fleeVec.x, -fleeVec.z);
  bot.setControlState('forward', true);
  bot.setControlState('sprint', true);
  await new Promise((res) => setTimeout(res, 500));
  bot.setControlState('forward', false);
  bot.setControlState('sprint', false);
}

/**
 * Dragon Perch Melee Execution Pipeline:
 * Rushes the bedrock fountain when dragon perches, evades breath clouds,
 * and strikes the dragon with synchronized sword cooldowns for maximum DPS.
 */
export async function techniqueExecuteDragonPerchMelee(
  bot: Bot,
  dragon: any,
  ctx: ActionExecutionContext
): Promise<ActionResult> {
  if (!isActionContextActive(ctx)) {
    return { status: 'interrupted', reason: 'Dragon perch combat cancelled before start.' };
  }

  await equipBestWeapon(bot);
  const cooldown = getAttackCooldownMs(bot.heldItem?.name);

  // 1. Evade any breath clouds near fountain
  const breath = detectDragonBreathHazard(bot, 6);
  if (breath) {
    ctx.logger?.warn?.('[DRAGON_COMBAT] Dragon breath detected near fountain! Evading cloud...');
    await evadeDragonBreath(bot, breath);
    if (!isActionContextActive(ctx)) return { status: 'interrupted', reason: 'Combat cancelled.' };
  }

  let strikes = 0;
  while (isAlive(dragon) && isDragonPerched(dragon) && strikes < 12) {
    if (!isActionContextActive(ctx)) {
      return { status: 'interrupted', reason: 'Dragon perch combat interrupted.' };
    }

    // Aim at dragon head / neck
    if (bot.lookAt) {
      await bot.lookAt(dragon.position.offset(0, 1.5, 0), true);
    }

    if (bot.attack) {
      bot.attack(dragon);
      strikes++;
    }

    await new Promise((res) => setTimeout(res, cooldown));
  }

  return {
    status: 'success',
    reason: `Delivered ${strikes} melee strike(s) during dragon perch phase.`,
    details: {
      strikes,
    },
  };
}
