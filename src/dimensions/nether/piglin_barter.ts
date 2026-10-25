import { Bot } from 'mineflayer';
import { ActionResult, ActionExecutionContext } from '../../types/index.js';
import { isAlive } from '../../safety/index.js';
import { isActionContextActive } from '../../agent/arbiter.js';
import { techniqueVacuumDrops } from '../../actions/techniques.js';

export const GOLD_ARMOR_PIECES = new Set([
  'golden_boots',
  'golden_leggings',
  'golden_chestplate',
  'golden_helmet',
]);

/**
 * Checks if the bot is wearing at least one piece of golden armor to appease Piglins.
 */
export function isWearingGoldArmor(bot: Bot): boolean {
  if (!bot || !bot.inventory) return false;
  const slots = [5, 6, 7, 8]; // Head, chest, legs, feet
  for (const s of slots) {
    const item = bot.inventory.slots[s];
    if (item && GOLD_ARMOR_PIECES.has(item.name)) {
      return true;
    }
  }
  return false;
}

/**
 * Equips a gold armor piece from inventory to prevent Piglin hostility.
 */
export async function ensureGoldArmorEquipped(bot: Bot): Promise<boolean> {
  if (isWearingGoldArmor(bot)) return true;
  if (!bot.inventory || !bot.equip) return false;

  const goldItem = bot.inventory.items().find((i) => GOLD_ARMOR_PIECES.has(i.name));
  if (!goldItem) return false;

  const destSlot = goldItem.name.endsWith('boots')
    ? 'feet'
    : goldItem.name.endsWith('leggings')
    ? 'legs'
    : goldItem.name.endsWith('chestplate')
    ? 'torso'
    : 'head';

  try {
    await bot.equip(goldItem, destSlot as any);
    return isWearingGoldArmor(bot);
  } catch {
    return false;
  }
}

/**
 * Finds an adult, non-zombified Piglin within range.
 */
export function findNearbyPiglin(bot: Bot, maxDistance: number = 16): any | null {
  if (!bot.entities || !bot.entity) return null;

  for (const id of Object.keys(bot.entities)) {
    const ent = bot.entities[id];
    if (ent && ent !== bot.entity && isAlive(ent) && ent.name === 'piglin') {
      const dist = bot.entity.position.distanceTo(ent.position);
      if (dist <= maxDistance) {
        return ent;
      }
    }
  }

  return null;
}

/**
 * Automates Piglin Bartering using Gold Ingots:
 * Ensures gold armor is worn, tosses gold ingots to Piglin, awaits barter inspection,
 * and collects bartered item drops (Ender pearls, fire resistance, obsidian, etc.).
 */
export async function techniqueBarterWithPiglins(
  bot: Bot,
  goldCount: number = 8,
  ctx?: ActionExecutionContext
): Promise<ActionResult> {
  if (ctx && !isActionContextActive(ctx)) {
    return { status: 'interrupted', reason: 'Piglin bartering cancelled before start.' };
  }

  // 1. Wear gold armor to pacify piglins
  await ensureGoldArmorEquipped(bot);

  const goldItem = bot.inventory?.items().find((i) => i.name === 'gold_ingot');
  if (!goldItem || goldItem.count <= 0) {
    return {
      status: 'failed',
      reason: 'No gold ingots available in inventory for bartering.',
    };
  }

  const piglin = findNearbyPiglin(bot, 16);
  if (!piglin) {
    return {
      status: 'failed',
      reason: 'No adult Piglins found nearby to trade with.',
    };
  }

  let traded = 0;
  const countToTrade = Math.min(goldCount, goldItem.count);

  for (let i = 0; i < countToTrade; i++) {
    if (ctx && !isActionContextActive(ctx)) break;

    // Face Piglin
    if (bot.lookAt) {
      await bot.lookAt(piglin.position.offset(0, 1.2, 0), true);
    }

    // Toss 1 gold ingot
    const activeGold = bot.inventory?.items().find((it) => it.name === 'gold_ingot');
    if (!activeGold) break;

    if (bot.toss) {
      try {
        await bot.toss(activeGold.type, null, 1);
        traded++;
      } catch {}
    }

    // Piglin inspects gold ingot for approx 6 seconds
    await new Promise((res) => setTimeout(res, 600));

    // Vacuum bartered drops
    try {
      await techniqueVacuumDrops(bot, 4, ctx?.abortSignal, ctx?.isCurrent);
    } catch {}
  }

  return {
    status: traded > 0 ? 'success' : 'failed',
    reason: `Bartered ${traded} gold ingot(s) with Piglin and collected dropped items.`,
    details: {
      tradedGold: traded,
    },
  };
}
