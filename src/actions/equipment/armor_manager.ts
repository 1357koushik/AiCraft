import { Bot } from 'mineflayer';
import { ActionResult, ActionExecutionContext } from '../../types/index.js';
import { inventoryCraftingActions } from '../inventory_crafting.js';

export type ArmorMaterial = 'iron' | 'diamond' | 'netherite' | 'golden' | 'chainmail' | 'leather';

export interface EquippedArmorSummary {
  helmet: string | null;
  chestplate: string | null;
  leggings: string | null;
  boots: string | null;
  shield: boolean;
}

const MATERIAL_TIERS: Record<ArmorMaterial, number> = {
  leather: 1,
  golden: 2,
  chainmail: 2.5,
  iron: 3,
  diamond: 4,
  netherite: 5,
};

export const ARMOR_COSTS: Record<string, number> = {
  helmet: 5,
  chestplate: 8,
  leggings: 7,
  boots: 4,
};

/**
 * Returns summary of currently equipped armor and off-hand shield.
 */
export function getEquippedArmor(bot: Bot): EquippedArmorSummary {
  if (!bot || !bot.inventory) {
    return { helmet: null, chestplate: null, leggings: null, boots: null, shield: false };
  }

  const helmetItem = bot.inventory.slots[5];
  const chestItem = bot.inventory.slots[6];
  const legsItem = bot.inventory.slots[7];
  const bootsItem = bot.inventory.slots[8];
  const offHandItem = (bot as any).supportFeature?.('offHand') ? bot.inventory.slots[45] : null;

  return {
    helmet: helmetItem ? helmetItem.name : null,
    chestplate: chestItem ? chestItem.name : null,
    leggings: legsItem ? legsItem.name : null,
    boots: bootsItem ? bootsItem.name : null,
    shield: Boolean(offHandItem && offHandItem.name === 'shield'),
  };
}

/**
 * Identifies which armor pieces of the desired material (e.g. iron) are currently missing
 * from the bot's equipment and inventory.
 */
export function getMissingArmorPieces(bot: Bot, desiredMaterial: ArmorMaterial = 'iron'): string[] {
  const equipped = getEquippedArmor(bot);
  const items = bot.inventory ? bot.inventory.items() : [];
  const targetTier = MATERIAL_TIERS[desiredMaterial] || 3;
  const missing: string[] = [];

  const slots: Array<{ name: string; equippedName: string | null; slotType: 'head' | 'torso' | 'legs' | 'feet' }> = [
    { name: `${desiredMaterial}_helmet`, equippedName: equipped.helmet, slotType: 'head' },
    { name: `${desiredMaterial}_chestplate`, equippedName: equipped.chestplate, slotType: 'torso' },
    { name: `${desiredMaterial}_leggings`, equippedName: equipped.leggings, slotType: 'legs' },
    { name: `${desiredMaterial}_boots`, equippedName: equipped.boots, slotType: 'feet' },
  ];

  for (const slot of slots) {
    // Check if equipped armor piece is at least the desired tier
    let isSatisfied = false;
    if (slot.equippedName) {
      for (const [mat, tier] of Object.entries(MATERIAL_TIERS)) {
        if (slot.equippedName.includes(mat) && tier >= targetTier) {
          isSatisfied = true;
          break;
        }
      }
    }

    if (!isSatisfied) {
      // Check if the piece is sitting in inventory ready to be equipped
      const inInventory = items.some((i) => i.name === slot.name);
      if (!inInventory) {
        missing.push(slot.name);
      }
    }
  }

  return missing;
}

/**
 * Automatically equips best available armor pieces and shield from inventory into player equipment slots.
 */
export async function techniqueAutoEquipBestGear(bot: Bot): Promise<void> {
  if (!bot || !bot.inventory || !bot.equip) return;

  const items = bot.inventory.items();

  const findBestPiece = (suffix: string) => {
    let bestItem: any = null;
    let bestTier = -1;
    for (const it of items) {
      if (it.name.endsWith(suffix)) {
        for (const [mat, tier] of Object.entries(MATERIAL_TIERS)) {
          if (it.name.startsWith(mat) && tier > bestTier) {
            bestTier = tier;
            bestItem = it;
          }
        }
      }
    }
    return bestItem;
  };

  const bestHelmet = findBestPiece('_helmet');
  const bestChest = findBestPiece('_chestplate');
  const bestLegs = findBestPiece('_leggings');
  const bestBoots = findBestPiece('_boots');
  const shield = items.find((i) => i.name === 'shield');

  try {
    if (bestHelmet && bot.inventory.slots[5]?.name !== bestHelmet.name) {
      await bot.equip(bestHelmet, 'head');
    }
    if (bestChest && bot.inventory.slots[6]?.name !== bestChest.name) {
      await bot.equip(bestChest, 'torso');
    }
    if (bestLegs && bot.inventory.slots[7]?.name !== bestLegs.name) {
      await bot.equip(bestLegs, 'legs');
    }
    if (bestBoots && bot.inventory.slots[8]?.name !== bestBoots.name) {
      await bot.equip(bestBoots, 'feet');
    }
    if (shield && bot.inventory.slots[45]?.name !== 'shield') {
      try {
        await bot.equip(shield, 'off-hand');
      } catch {}
    }
  } catch {}
}

/**
 * Closed-Loop Armor Pipeline: Crafts missing armor pieces using a crafting table,
 * and equips the complete set + shield onto the bot.
 */
export async function techniqueCraftAndEquipArmorSet(
  bot: Bot,
  material: ArmorMaterial = 'iron',
  ctx?: Partial<ActionExecutionContext>
): Promise<ActionResult> {
  if (!bot.entity) {
    return { status: 'failed', reason: 'Bot entity unavailable.' };
  }

  // 1. First equip any existing pieces already in inventory
  await techniqueAutoEquipBestGear(bot);

  const missing = getMissingArmorPieces(bot, material);
  if (missing.length === 0) {
    return {
      status: 'success',
      reason: `Full ${material} armor set is already equipped.`,
    };
  }

  const craftItemDef = inventoryCraftingActions.find((a) => a.name === 'craft_item');
  if (!craftItemDef) {
    return { status: 'failed', reason: 'Crafting action definition unavailable.' };
  }

  const craftedPieces: string[] = [];

  for (const piece of missing) {
    if (ctx?.abortSignal?.aborted) {
      return { status: 'interrupted', reason: 'Armor crafting interrupted.' };
    }

    ctx?.logger?.info?.(`[ARMOR_MANAGER] Crafting missing armor piece: ${piece}...`);
    const craftRes = await craftItemDef.execute(
      bot,
      { item: piece, count: 1 },
      ctx as ActionExecutionContext
    );

    if (craftRes.status !== 'success') {
      return {
        status: 'failed',
        reason: `Failed to craft ${piece}: ${craftRes.reason}`,
      };
    }

    craftedPieces.push(piece);

    // Equip newly crafted piece immediately
    const itemInInv = bot.inventory?.items().find((i) => i.name === piece);
    if (itemInInv && bot.equip) {
      const destinationSlot = piece.endsWith('_helmet')
        ? 'head'
        : piece.endsWith('_chestplate')
        ? 'torso'
        : piece.endsWith('_leggings')
        ? 'legs'
        : 'feet';
      try {
        await bot.equip(itemInInv, destinationSlot as any);
      } catch {}
    }
  }

  // Also verify / equip shield
  const shield = bot.inventory?.items().find((i) => i.name === 'shield');
  if (shield && bot.inventory?.slots[45]?.name !== 'shield') {
    try {
      await bot.equip(shield, 'off-hand');
    } catch {}
  }

  return {
    status: 'success',
    reason: `Crafted and equipped ${craftedPieces.join(', ')} to complete ${material} armor set.`,
  };
}
