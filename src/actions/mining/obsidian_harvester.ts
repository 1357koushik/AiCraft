import { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { goals } from 'mineflayer-pathfinder';
import { ActionResult, ActionExecutionContext } from '../../types/index.js';
import { isActionContextActive } from '../../agent/arbiter.js';
import { findBestPickaxeInInventory, validateBlockHarvestability } from '../mining.js';
import { techniqueVacuumDrops, updatePathfinderMovements } from '../techniques.js';

export interface PreNetherChecklist {
  diamondPickaxe: boolean;
  diamondSword: boolean;
  obsidianCount: number; // minimum 10
  flintAndSteel: boolean;
  waterBuckets: number; // minimum 1 or 2
  readyForNether: boolean;
}

/**
 * Evaluates the bot's inventory and equipment against essential Pre-Nether survival requirements.
 */
export function evaluatePreNetherChecklist(bot: Bot): PreNetherChecklist {
  if (!bot || !bot.inventory) {
    return {
      diamondPickaxe: false,
      diamondSword: false,
      obsidianCount: 0,
      flintAndSteel: false,
      waterBuckets: 0,
      readyForNether: false,
    };
  }

  const items = bot.inventory.items();
  const diamondPickaxe = items.some((i) => i.name === 'diamond_pickaxe' || i.name === 'netherite_pickaxe');
  const diamondSword = items.some((i) => i.name === 'diamond_sword' || i.name === 'netherite_sword');
  const flintAndSteel = items.some((i) => i.name === 'flint_and_steel');

  let obsidianCount = 0;
  let waterBuckets = 0;

  for (const it of items) {
    if (it.name === 'obsidian') obsidianCount += it.count || 0;
    if (it.name === 'water_bucket') waterBuckets += it.count || 0;
  }

  const readyForNether = diamondPickaxe && obsidianCount >= 10 && flintAndSteel && waterBuckets >= 1;

  return {
    diamondPickaxe,
    diamondSword,
    obsidianCount,
    flintAndSteel,
    waterBuckets,
    readyForNether,
  };
}

/**
 * Finds stationary source lava blocks (metadata/level = 0).
 */
export function findLavaSourcePool(bot: Bot, maxDistance: number = 24): any | null {
  if (!bot.findBlock) return null;
  return bot.findBlock({
    matching: (b: any) => b.name === 'lava' && ((b as any).metadata === 0 || (b as any).level === 0 || (b as any)._properties?.level === 0),
    maxDistance,
  });
}

/**
 * Casts water over a lava source pool to solidify source lava into obsidian,
 * then retrieves the water source block back into the bucket.
 */
export async function techniqueCastObsidian(
  bot: Bot,
  lavaBlock: any,
  ctx?: ActionExecutionContext
): Promise<boolean> {
  if (!bot.inventory || !bot.equip || !bot.activateItem || !bot.blockAt) return false;

  const waterBucket = bot.inventory.items().find((i) => i.name === 'water_bucket');
  if (!waterBucket) return false;

  // Find a solid non-lava block directly adjacent or above the lava block
  const placementSpots = [
    lavaBlock.position.offset(0, 1, 0),
    lavaBlock.position.offset(1, 0, 0),
    lavaBlock.position.offset(-1, 0, 0),
    lavaBlock.position.offset(0, 0, 1),
    lavaBlock.position.offset(0, 0, -1),
  ];

  let targetSpot: Vec3 | null = null;
  for (const p of placementSpots) {
    const b = bot.blockAt(p);
    if (b && (b.name === 'air' || b.name === 'cave_air')) {
      targetSpot = p;
      break;
    }
  }

  if (!targetSpot) return false;

  try {
    // 1. Equip water bucket and place water
    await bot.equip(waterBucket, 'hand');
    if (bot.lookAt) await bot.lookAt(targetSpot, true);
    bot.activateItem();

    // 2. Allow liquid flow to convert lava into obsidian (~500ms)
    await new Promise((res) => setTimeout(res, 500));

    // 3. Retrieve water source back into empty bucket
    const emptyBucket = bot.inventory.items().find((i) => i.name === 'bucket');
    if (emptyBucket) {
      await bot.equip(emptyBucket, 'hand');
      if (bot.lookAt) await bot.lookAt(targetSpot, true);
      bot.activateItem();
      await new Promise((res) => setTimeout(res, 200));
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Obsidian Harvesting Routine:
 * Safely casts obsidian from lava pools and mines at least 10 obsidian blocks using a diamond pickaxe.
 */
export async function techniqueHarvestObsidian(
  bot: Bot,
  targetCount: number = 10,
  ctx: ActionExecutionContext
): Promise<ActionResult> {
  if (!isActionContextActive(ctx)) {
    return { status: 'interrupted', reason: 'Obsidian harvesting cancelled before start.' };
  }

  // 1. Tool check: Obsidian strictly requires Diamond Pickaxe or higher (tier >= 4)
  const pick = findBestPickaxeInInventory(bot, 4);
  if (!pick) {
    return {
      status: 'failed',
      reason: 'A Diamond Pickaxe or higher (tier >= 4) is required to harvest obsidian.',
      details: { failureKind: 'WRONG_TOOL_TIER' },
    };
  }

  const countObsidian = () => {
    if (!bot.inventory) return 0;
    return bot.inventory.items().filter((i) => i.name === 'obsidian').reduce((acc, i) => acc + (i.count || 0), 0);
  };

  const initialCount = countObsidian();
  if (initialCount >= targetCount) {
    return {
      status: 'success',
      reason: `Obsidian quota already satisfied (${initialCount}/${targetCount}).`,
      details: { harvestedCount: 0, totalObsidian: initialCount },
    };
  }

  let mined = 0;
  const maxAttempts = 15;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (!isActionContextActive(ctx)) {
      return { status: 'interrupted', reason: 'Obsidian harvesting cancelled.' };
    }

    if (countObsidian() >= targetCount) break;

    // A. Check for existing obsidian blocks nearby
    let obsBlock: any = null;
    if (typeof bot.findBlock === 'function') {
      obsBlock = bot.findBlock({
        matching: (b: any) => b.name === 'obsidian',
        maxDistance: 16,
      });
    }

    // B. If no obsidian exists, cast water over adjacent lava pool
    if (!obsBlock) {
      const lavaPool = findLavaSourcePool(bot, 16);
      if (lavaPool) {
        ctx.logger?.info?.(`[OBSIDIAN] Solidifying lava source at (${lavaPool.position.x}, ${lavaPool.position.y}, ${lavaPool.position.z}) into obsidian...`);
        await techniqueCastObsidian(bot, lavaPool, ctx);
        await new Promise((res) => setTimeout(res, 300));
        if (typeof bot.findBlock === 'function') {
          obsBlock = bot.findBlock({
            matching: (b: any) => b.name === 'obsidian',
            maxDistance: 16,
          });
        }
      }
    }

    if (!obsBlock) {
      break;
    }

    // Approach obsidian block safely (within 3.5m)
    const eyePos = bot.entity?.position ? bot.entity.position.offset(0, 1.6, 0) : null;
    const dist = eyePos ? eyePos.distanceTo(obsBlock.position) : 0;
    if (dist > 3.5 && (bot as any).pathfinder) {
      try {
        updatePathfinderMovements(bot);
        const goal = new goals.GoalNear(obsBlock.position.x, obsBlock.position.y, obsBlock.position.z, 2.5);
        await (bot as any).pathfinder.goto(goal);
      } catch {}
    }

    if (!isActionContextActive(ctx)) break;

    // Equip diamond pickaxe
    const bestPick = findBestPickaxeInInventory(bot, 4);
    if (bestPick && bot.equip) {
      try { await bot.equip(bestPick, 'hand'); } catch {}
    }

    // Dig obsidian
    try {
      if (bot.dig) {
        ctx.logger?.info?.(`[OBSIDIAN] Mining obsidian at (${obsBlock.position.x}, ${obsBlock.position.y}, ${obsBlock.position.z})...`);
        await bot.dig(obsBlock);
        mined++;
      }
    } catch {}

    // Vacuum drop
    try {
      await techniqueVacuumDrops(bot, 3.5, ctx.abortSignal, ctx.isCurrent);
    } catch {}
  }

  const finalCount = countObsidian();
  const netGained = finalCount - initialCount;

  return {
    status: finalCount >= targetCount || netGained > 0 ? 'success' : 'failed',
    reason: `Obsidian harvesting completed. Net gained: ${netGained} (inventory: ${finalCount}/${targetCount}).`,
    details: {
      netGained,
      totalObsidian: finalCount,
    },
  };
}
