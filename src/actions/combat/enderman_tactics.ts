import { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { ActionResult, ActionExecutionContext } from '../../types/index.js';
import { isAlive } from '../../safety/index.js';
import { isActionContextActive } from '../../agent/arbiter.js';
import { equipBestWeapon, getAttackCooldownMs } from './mob_tactics.js';
import { techniqueVacuumDrops } from '../techniques.js';

export interface EndermanCanopy {
  center: Vec3;
  canopyBlocks: Vec3[];
  interiorClearance: number; // exactly 2.0 blocks
}

/**
 * Computes coordinates for a 3x3 horizontal canopy at y = groundY + 2.
 * Leaves an interior standing clearance of exactly 2.0 blocks (y to y+1),
 * preventing 2.9m tall Endermen from entering while permitting the 1.8m player.
 */
export function computeEndermanCanopy(groundPos: Vec3): EndermanCanopy {
  const canopyBlocks: Vec3[] = [];
  const canopyY = groundPos.y + 2;

  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      canopyBlocks.push(new Vec3(groundPos.x + dx, canopyY, groundPos.z + dz));
    }
  }

  return {
    center: groundPos,
    canopyBlocks,
    interiorClearance: 2.0,
  };
}

/**
 * Builds a 3x3 solid block canopy at y+2 to create an Enderman combat umbrella.
 */
export async function buildEndermanCanopy(
  bot: Bot,
  groundPos: Vec3,
  ctx?: ActionExecutionContext
): Promise<boolean> {
  if (!bot.inventory || !bot.equip || !bot.placeBlock || !bot.blockAt) return false;

  const { canopyBlocks } = computeEndermanCanopy(groundPos);
  const items = bot.inventory.items();
  const buildItem = items.find(
    (i) =>
      i.name === 'cobblestone' ||
      i.name === 'cobbled_deepslate' ||
      i.name === 'netherrack' ||
      i.name === 'dirt' ||
      i.name === 'nether_bricks'
  );

  if (!buildItem) return false;

  try {
    await bot.equip(buildItem, 'hand');
  } catch {
    return false;
  }

  // Place support pillar at corner if needed, then place 3x3 slab/block roof
  for (const pos of canopyBlocks) {
    if (ctx && !isActionContextActive(ctx)) return false;

    const existing = bot.blockAt(pos);
    if (existing && existing.boundingBox === 'block') continue;

    // Use adjacent neighbor or ground support
    const refPos = pos.offset(0, -1, 0);
    const refBlock = bot.blockAt(refPos) || { position: refPos };

    try {
      await bot.placeBlock(refBlock as any, new Vec3(0, 1, 0));
    } catch {}
  }

  return true;
}

/**
 * Stares directly into the Enderman's eyes (y = eye height ~2.7) to provoke agro.
 */
export async function provokeEndermanEyeContact(bot: Bot, enderman: any): Promise<boolean> {
  if (!bot.lookAt || !enderman || !enderman.position) return false;

  const eyePos = enderman.position.offset(0, enderman.height ? enderman.height * 0.9 : 2.7, 0);
  try {
    await bot.lookAt(eyePos, true);
    await new Promise((res) => setTimeout(res, 200));
    return true;
  } catch {
    return false;
  }
}

/**
 * Counts Ender Pearls in inventory.
 */
export function countEnderPearls(bot: Bot): number {
  if (!bot || !bot.inventory) return 0;
  return bot.inventory.items().filter((i) => i.name === 'ender_pearl').reduce((acc, i) => acc + (i.count || 0), 0);
}

/**
 * Enderman Hunting Pipeline:
 * Constructs a 2-high 3x3 combat shelter, looks into Enderman eyes to aggro,
 * retreats under the shelter, strikes Enderman legs from safety, and collects pearls.
 */
export async function techniqueHuntEnderman(
  bot: Bot,
  targetPearls: number = 14,
  ctx: ActionExecutionContext
): Promise<ActionResult> {
  if (!isActionContextActive(ctx)) {
    return { status: 'interrupted', reason: 'Enderman hunting cancelled before start.' };
  }

  await equipBestWeapon(bot);

  const initialPearls = countEnderPearls(bot);
  if (initialPearls >= targetPearls) {
    return {
      status: 'success',
      reason: `Ender pearl quota already satisfied (${initialPearls}/${targetPearls}).`,
      details: { harvested: 0, totalPearls: initialPearls },
    };
  }

  // 1. Build 2-high canopy shelter at current position
  const shelterPos = bot.entity ? bot.entity.position.floored() : new Vec3(0, 60, 0);
  await buildEndermanCanopy(bot, shelterPos, ctx);

  let pearlsHarvested = 0;
  const maxAttempts = 15;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (!isActionContextActive(ctx)) {
      return { status: 'interrupted', reason: 'Enderman hunting cancelled.' };
    }

    if (countEnderPearls(bot) >= targetPearls) break;

    // Find nearest Enderman within 32m
    const enderman = Object.values(bot.entities || {}).find(
      (e: any) => e && e !== bot.entity && isAlive(e) && e.name === 'enderman'
    );

    if (enderman) {
      // Provoke by staring into eyes
      await provokeEndermanEyeContact(bot, enderman);
      await new Promise((res) => setTimeout(res, 400));

      // Strike legs from under 2-high shelter
      const cooldown = getAttackCooldownMs(bot.heldItem?.name);
      if (bot.lookAt) {
        await bot.lookAt(enderman.position.offset(0, 0.5, 0), true);
      }
      if (bot.attack) {
        bot.attack(enderman);
      }

      await new Promise((res) => setTimeout(res, cooldown));

      // Vacuum dropped pearl
      try {
        await techniqueVacuumDrops(bot, 4, ctx.abortSignal, ctx.isCurrent);
      } catch {}
    } else {
      await new Promise((res) => setTimeout(res, 500));
    }
  }

  const finalPearls = countEnderPearls(bot);
  const netGained = finalPearls - initialPearls;

  return {
    status: finalPearls >= targetPearls || netGained > 0 ? 'success' : 'failed',
    reason: `Enderman hunting completed. Total pearls: ${finalPearls}/${targetPearls}.`,
    details: {
      netGained,
      totalPearls: finalPearls,
    },
  };
}
