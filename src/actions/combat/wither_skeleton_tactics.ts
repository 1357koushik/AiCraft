import { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { ActionResult, ActionExecutionContext } from '../../types/index.js';
import { isAlive } from '../../safety/index.js';
import { isActionContextActive } from '../../agent/arbiter.js';
import { equipBestWeapon, getAttackCooldownMs } from './mob_tactics.js';
import { ensureShieldInOffHand, raiseShieldAgainst } from './shield_manager.js';

/**
 * Checks if a 2-block ceiling barricade exists above the target ground coordinate,
 * preventing 2.4m tall wither skeletons from entering.
 */
export function hasTwoBlockCeiling(bot: Bot, floorPos: Vec3): boolean {
  if (!bot.blockAt) return false;
  // Block at y+2 must be solid
  const ceilingBlock = bot.blockAt(floorPos.offset(0, 2, 0));
  return Boolean(ceilingBlock && ceilingBlock.boundingBox === 'block');
}

/**
 * Places a barricade block at y+2 directly above the doorway, creating a 2-block high passage
 * that the bot (1.8m) can walk under, but Wither Skeletons (2.4m) cannot cross.
 */
export async function placeTwoBlockBarricade(bot: Bot, doorPos: Vec3): Promise<boolean> {
  if (!bot.inventory || !bot.equip || !bot.placeBlock || !bot.blockAt) return false;

  const ceilingPos = doorPos.offset(0, 2, 0);
  const existing = bot.blockAt(ceilingPos);
  if (existing && existing.boundingBox === 'block') return true;

  const items = bot.inventory.items();
  const buildItem = items.find(
    (i) =>
      i.name === 'cobblestone' ||
      i.name === 'cobbled_deepslate' ||
      i.name === 'nether_bricks' ||
      i.name === 'stone' ||
      i.name === 'dirt'
  );

  if (!buildItem) return false;

  // Find adjacent solid block to place against
  const refPos = ceilingPos.offset(0, 1, 0); // block above or next
  const refBlock = bot.blockAt(refPos) || bot.blockAt(ceilingPos.offset(1, 0, 0)) || bot.blockAt(ceilingPos.offset(-1, 0, 0));

  if (!refBlock) return false;

  try {
    await bot.equip(buildItem, 'hand');
    await bot.placeBlock(refBlock, new Vec3(0, -1, 0));
    return true;
  } catch {
    return false;
  }
}

/**
 * Wither Skeleton Tactical Engagement:
 * Uses 2-block high ceiling barricades for physical immunity, or uses shield + reach spacing
 * to avoid taking Wither effect damage.
 */
export async function techniqueEngageWitherSkeleton(
  bot: Bot,
  witherSkeleton: any,
  ctx: ActionExecutionContext
): Promise<ActionResult> {
  if (!isActionContextActive(ctx)) {
    return { status: 'interrupted', reason: 'Wither skeleton combat cancelled.' };
  }

  await equipBestWeapon(bot);
  await ensureShieldInOffHand(bot);
  const cooldown = getAttackCooldownMs(bot.heldItem?.name);

  // 1. Check if bot is safely positioned under a 2-high ceiling
  const botFloor = bot.entity ? bot.entity.position.floored() : new Vec3(0, 0, 0);
  const underSafeCeiling = hasTwoBlockCeiling(bot, botFloor);

  if (!underSafeCeiling) {
    // Attempt to place a 2-block barricade if near doorway
    try {
      await placeTwoBlockBarricade(bot, botFloor);
    } catch {}
  }

  let strikes = 0;
  while (isAlive(witherSkeleton) && strikes < 8) {
    if (!isActionContextActive(ctx)) {
      return { status: 'interrupted', reason: 'Wither skeleton combat interrupted.' };
    }

    const dist = bot.entity.position.distanceTo(witherSkeleton.position);

    // If out in the open and wither skeleton is within strike distance (<= 2.5m), raise shield first
    if (!underSafeCeiling && dist <= 2.8) {
      await raiseShieldAgainst(bot, witherSkeleton, 500, ctx.abortSignal, ctx.isCurrent);
    }

    if (!isActionContextActive(ctx)) break;

    // Aim at legs (y = 0.5) to hit safely from under 2-high ceiling
    if (bot.lookAt) {
      await bot.lookAt(witherSkeleton.position.offset(0, 0.6, 0), true);
    }
    if (bot.attack) {
      bot.attack(witherSkeleton);
      strikes++;
    }

    await new Promise((res) => setTimeout(res, cooldown));
  }

  return {
    status: 'success',
    reason: `Engaged Wither Skeleton safely with ${strikes} strike(s) (under 2-high barricade: ${underSafeCeiling}).`,
  };
}
