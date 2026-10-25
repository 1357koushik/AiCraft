import { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { ActionResult, ActionExecutionContext } from '../../types/index.js';
import { isActionContextActive } from '../../agent/arbiter.js';
import { findBestPickaxeInInventory, techniqueMineOreVein } from '../mining.js';
import { techniqueMineStaircase, techniqueVacuumDrops, isSafeScaffoldingItem } from '../techniques.js';

export const LAVA_BLOCKS = new Set(['lava', 'flowing_lava']);

/**
 * Checks orthogonal neighboring blocks for active lava hazards.
 * Returns the position of any leaking lava block detected.
 */
export function detectAdjacentLavaPocket(bot: Bot, centerPos: Vec3): Vec3 | null {
  if (!bot.blockAt) return null;

  const offsets = [
    new Vec3(0, 1, 0),
    new Vec3(0, -1, 0),
    new Vec3(1, 0, 0),
    new Vec3(-1, 0, 0),
    new Vec3(0, 0, 1),
    new Vec3(0, 0, -1),
  ];

  for (const off of offsets) {
    const p = centerPos.plus(off);
    const b = bot.blockAt(p);
    if (b && LAVA_BLOCKS.has(b.name)) {
      return p;
    }
  }

  return null;
}

/**
 * Seals an exposed lava pocket immediately with a solid non-flammable block (e.g. cobblestone/deepslate).
 */
export async function sealLavaLeak(bot: Bot, leakPos: Vec3): Promise<boolean> {
  if (!bot.inventory || !bot.equip || !bot.placeBlock || !bot.blockAt) return false;

  const items = bot.inventory.items();
  const sealBlock =
    items.find((i) => i.name === 'cobblestone' || i.name === 'cobbled_deepslate' || i.name === 'deepslate' || i.name === 'stone') ||
    items.find((i) => isSafeScaffoldingItem(i, bot));

  if (!sealBlock) return false;

  // Find an adjacent solid block face to place against
  const neighbors = [
    new Vec3(0, -1, 0),
    new Vec3(0, 1, 0),
    new Vec3(1, 0, 0),
    new Vec3(-1, 0, 0),
    new Vec3(0, 0, 1),
    new Vec3(0, 0, -1),
  ];

  let refBlock: any = null;
  let placeVector: Vec3 | null = null;

  for (const n of neighbors) {
    const candidatePos = leakPos.plus(n);
    const cb = bot.blockAt(candidatePos);
    if (cb && cb.boundingBox === 'block' && !LAVA_BLOCKS.has(cb.name)) {
      refBlock = cb;
      placeVector = n.scaled(-1);
      break;
    }
  }

  if (!refBlock || !placeVector) return false;

  try {
    await bot.equip(sealBlock, 'hand');
    await bot.placeBlock(refBlock, placeVector);
    return true;
  } catch {
    return false;
  }
}

/**
 * Deepslate Branch Mining Routine:
 * Descends safely to optimal diamond elevation (Y = -58), excavates a 1x2 horizontal branch tunnel,
 * continuously checks and seals lava pockets, places torches, and extracts diamond veins.
 */
export async function techniqueBranchMineDeepslate(
  bot: Bot,
  targetDiamondCount: number = 5,
  targetY: number = -58,
  ctx: ActionExecutionContext
): Promise<ActionResult> {
  if (!isActionContextActive(ctx)) {
    return { status: 'interrupted', reason: 'Deepslate branch mining cancelled before start.' };
  }

  // 1. Tool check: Diamond ore strictly requires Iron pickaxe or higher (tier >= 3)
  const pick = findBestPickaxeInInventory(bot, 3);
  if (!pick) {
    return {
      status: 'failed',
      reason: 'Iron pickaxe or higher (tier >= 3) is required to harvest diamonds.',
      details: { failureKind: 'WRONG_TOOL_TIER' },
    };
  }

  const getDiamondCount = () => {
    if (!bot.inventory) return 0;
    const items = bot.inventory.items();
    let count = 0;
    for (const it of items) {
      if (it.name === 'diamond' || it.name === 'diamond_ore' || it.name === 'deepslate_diamond_ore') {
        count += it.count || 0;
      }
    }
    return count;
  };

  const initialCount = getDiamondCount();
  if (initialCount >= targetDiamondCount) {
    return {
      status: 'success',
      reason: `Diamond quota already satisfied (${initialCount}/${targetDiamondCount}).`,
      details: { minedDiamonds: 0, currentDiamonds: initialCount },
    };
  }

  // 2. Descent to target Y elevation (-58)
  const currentY = bot.entity ? Math.floor(bot.entity.position.y) : targetY;
  if (currentY > targetY) {
    ctx.logger?.info?.(`[DEEPSLATE_MINING] Descending from Y=${currentY} to diamond layer Y=${targetY}...`);
    const verticalDistance = currentY - targetY;
    const stairSteps = Math.min(verticalDistance, 12);
    const descentRes = await techniqueMineStaircase(bot, stairSteps, ctx.abortSignal, ctx.isCurrent);
    if (descentRes.status !== 'success') {
      // If staircasing hit an obstacle, try adjusting yaw
      if (bot.entity) {
        bot.entity.yaw = (bot.entity.yaw || 0) + Math.PI / 2;
      }
    }
  }

  // 3. Branch Tunnel Excavation
  const tunnelLength = 20;
  let blocksDug = 0;

  for (let step = 0; step < tunnelLength; step++) {
    if (!isActionContextActive(ctx)) {
      return { status: 'interrupted', reason: 'Branch mining cancelled.' };
    }

    if (getDiamondCount() >= targetDiamondCount) break;

    // Check for nearby exposed diamond ore in 8m radius
    let oreBlock: any = null;
    if (typeof bot.findBlock === 'function') {
      oreBlock = bot.findBlock({
        matching: (b: any) => b.name === 'diamond_ore' || b.name === 'deepslate_diamond_ore',
        maxDistance: 8,
      });
    }

    if (oreBlock) {
      ctx.logger?.info?.(`[DEEPSLATE_MINING] Discovered diamond ore at (${oreBlock.position.x}, ${oreBlock.position.y}, ${oreBlock.position.z})! Extracting vein...`);
      await techniqueMineOreVein(bot, oreBlock, { maxCount: 16 }, ctx);
      try {
        await techniqueVacuumDrops(bot, 3.5, ctx.abortSignal, ctx.isCurrent);
      } catch {}

      if (getDiamondCount() >= targetDiamondCount) break;
    }

    if (!bot.entity) break;

    // Cardinal step vector ahead
    const yaw = bot.entity.yaw || 0;
    const forwardX = -Math.round(Math.sin(yaw));
    const forwardZ = -Math.round(Math.cos(yaw));
    const stepAhead = new Vec3(forwardX, 0, forwardZ);
    const footPos = bot.entity.position.floored().plus(stepAhead);
    const headPos = footPos.offset(0, 1, 0);

    // Pre-dig Lava Safety Check: check surrounding blocks before digging
    const lavaLeak = detectAdjacentLavaPocket(bot, footPos) || detectAdjacentLavaPocket(bot, headPos);
    if (lavaLeak) {
      ctx.logger?.warn?.(`[DEEPSLATE_MINING] Lava detected at (${lavaLeak.x}, ${lavaLeak.y}, ${lavaLeak.z})! Sealing leak...`);
      await sealLavaLeak(bot, lavaLeak);
      // Turn tunnel 90 degrees to divert around lava pocket
      bot.entity.yaw = (bot.entity.yaw || 0) + Math.PI / 2;
      continue;
    }

    // Dig head block
    const bHead = bot.blockAt ? bot.blockAt(headPos) : null;
    if (bHead && bHead.boundingBox === 'block' && bHead.name !== 'air') {
      try {
        await bot.dig(bHead);
        blocksDug++;
      } catch {}
    }

    // Dig foot block
    const bFoot = bot.blockAt ? bot.blockAt(footPos) : null;
    if (bFoot && bFoot.boundingBox === 'block' && bFoot.name !== 'air') {
      try {
        await bot.dig(bFoot);
        blocksDug++;
      } catch {}
    }

    // Post-dig lava check in newly opened space
    const postLava = detectAdjacentLavaPocket(bot, footPos);
    if (postLava) {
      await sealLavaLeak(bot, postLava);
      bot.entity.yaw = (bot.entity.yaw || 0) + Math.PI / 2;
      continue;
    }

    // Advance forward into newly cleared tunnel segment
    bot.setControlState('forward', true);
    await new Promise((res) => setTimeout(res, 250));
    bot.setControlState('forward', false);

    // Vacuum drops
    try {
      await techniqueVacuumDrops(bot, 3.5, ctx.abortSignal, ctx.isCurrent);
    } catch {}

    // Torch placement every 8 steps
    if (step % 8 === 0) {
      const torch = bot.inventory?.items().find((i) => i.name === 'torch');
      if (torch && bot.equip && bot.placeBlock) {
        const floorBlock = bot.blockAt ? bot.blockAt(bot.entity.position.floored().offset(0, -1, 0)) : null;
        if (floorBlock && floorBlock.boundingBox === 'block') {
          try {
            await bot.equip(torch, 'hand');
            await bot.placeBlock(floorBlock, new Vec3(0, 1, 0));
          } catch {}
        }
      }
    }
  }

  const finalDiamonds = getDiamondCount();
  const netGained = finalDiamonds - initialCount;

  return {
    status: finalDiamonds >= targetDiamondCount || netGained > 0 ? 'success' : 'failed',
    reason: `Deepslate branch mining completed (${blocksDug} blocks dug). Diamonds in inventory: ${finalDiamonds}/${targetDiamondCount}.`,
    details: {
      netGained,
      totalDiamonds: finalDiamonds,
      blocksDug,
    },
  };
}
