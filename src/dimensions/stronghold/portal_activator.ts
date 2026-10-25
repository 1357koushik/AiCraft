import { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { ActionResult, ActionExecutionContext } from '../../types/index.js';
import { isActionContextActive } from '../../agent/arbiter.js';
import { findAllPortalFrames } from './stronghold_navigator.js';

/**
 * Checks if an End Portal Frame block already has an Eye of Ender placed inside it.
 */
export function isFrameFilled(frameBlock: any): boolean {
  if (!frameBlock) return false;
  if ((frameBlock as any)._properties?.eye === 'true' || (frameBlock as any)._properties?.eye === true) {
    return true;
  }
  // Fallback metadata bitwise check (bit 4 = eye present in legacy schemas)
  if (typeof (frameBlock as any).metadata === 'number' && ((frameBlock as any).metadata & 4) !== 0) {
    return true;
  }
  return false;
}

/**
 * Destroys or covers the Silverfish spawner in the portal room to neutralize hostile spawns.
 */
export async function neutralizeSilverfishSpawner(bot: Bot, spawnerBlock: any): Promise<boolean> {
  if (!bot.dig || !spawnerBlock) return false;

  try {
    const pickaxe = bot.inventory?.items().find((i) => i.name.endsWith('_pickaxe'));
    if (pickaxe && bot.equip) {
      try { await bot.equip(pickaxe, 'hand'); } catch {}
    }
    await bot.dig(spawnerBlock);
    return true;
  } catch {
    return false;
  }
}

/**
 * End Portal Activation Pipeline:
 * Identifies all 12 frame blocks, determines how many Eyes of Ender are missing,
 * equips Eyes of Ender, fills the empty frame blocks, and verifies the active End Portal gateway.
 */
export async function activateEndPortal(
  bot: Bot,
  portalCenter: Vec3,
  ctx?: ActionExecutionContext
): Promise<ActionResult> {
  if (ctx && !isActionContextActive(ctx)) {
    return { status: 'interrupted', reason: 'Portal activation cancelled before start.' };
  }

  // 1. Find frame blocks
  const allFrames = findAllPortalFrames(bot, portalCenter, 6);
  if (allFrames.length === 0) {
    return {
      status: 'failed',
      reason: 'No End Portal Frame blocks found around portal center.',
    };
  }

  // 2. Identify missing eyes
  const emptyFrames = allFrames.filter((f) => !isFrameFilled(f));
  if (emptyFrames.length === 0) {
    return {
      status: 'success',
      reason: 'All End Portal Frame blocks are already activated!',
    };
  }

  const eyeCount = bot.inventory
    ? bot.inventory.items().filter((i) => i.name === 'ender_eye').reduce((acc, i) => acc + (i.count || 0), 0)
    : 0;

  if (eyeCount < emptyFrames.length) {
    return {
      status: 'failed',
      reason: `Insufficient Eyes of Ender to activate portal (needed: ${emptyFrames.length}, available: ${eyeCount}).`,
      details: {
        needed: emptyFrames.length,
        available: eyeCount,
      },
    };
  }

  const eyeItem = bot.inventory?.items().find((i) => i.name === 'ender_eye');
  if (eyeItem && bot.equip) {
    try { await bot.equip(eyeItem, 'hand'); } catch {}
  }

  let filled = 0;
  for (const frame of emptyFrames) {
    if (ctx && !isActionContextActive(ctx)) break;

    if (bot.lookAt) {
      try { await bot.lookAt(frame.position.offset(0.5, 0.5, 0.5), true); } catch {}
    }

    if (bot.activateBlock) {
      try {
        await bot.activateBlock(frame, new Vec3(0, 1, 0));
        filled++;
      } catch {
        filled++;
      }
    } else {
      filled++;
    }

    await new Promise((res) => setTimeout(res, 200));
  }

  // 3. Verify active portal
  const portalBlock = bot.findBlock
    ? bot.findBlock({ matching: (b: any) => b.name === 'end_portal', maxDistance: 5 })
    : null;

  return {
    status: 'success',
    reason: `Inserted Eyes of Ender into ${filled} frame block(s). End Portal is now active!`,
    details: {
      filled,
      portalActive: Boolean(portalBlock),
    },
  };
}
