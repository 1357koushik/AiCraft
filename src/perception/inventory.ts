import { Bot } from 'mineflayer';
import { InventoryState, InventoryItemInfo, ToolSummary, FoodItemInfo } from '../types/index.js';

const FOOD_VALUES: Record<string, { food: number; saturation: number }> = {
  cooked_beef: { food: 8, saturation: 12.8 },
  cooked_porkchop: { food: 8, saturation: 12.8 },
  golden_carrot: { food: 6, saturation: 14.4 },
  cooked_mutton: { food: 6, saturation: 9.6 },
  cooked_salmon: { food: 6, saturation: 9.6 },
  cooked_chicken: { food: 6, saturation: 7.2 },
  baked_potato: { food: 5, saturation: 6.0 },
  bread: { food: 5, saturation: 6.0 },
  cooked_cod: { food: 5, saturation: 6.0 },
  apple: { food: 4, saturation: 2.4 },
  carrot: { food: 3, saturation: 3.6 },
  melon_slice: { food: 2, saturation: 1.2 },
  sweet_berries: { food: 2, saturation: 0.4 },
  glow_berries: { food: 2, saturation: 0.4 },
  cookie: { food: 2, saturation: 0.4 },
  golden_apple: { food: 4, saturation: 9.6 },
  enchanted_golden_apple: { food: 4, saturation: 9.6 },
  mushroom_stew: { food: 6, saturation: 7.2 },
  beetroot_soup: { food: 6, saturation: 7.2 },
  rabbit_stew: { food: 10, saturation: 12.0 },
  dried_kelp: { food: 1, saturation: 0.6 },
  beef: { food: 3, saturation: 1.8 },
  porkchop: { food: 3, saturation: 1.8 },
  mutton: { food: 2, saturation: 1.2 },
  chicken: { food: 2, saturation: 1.2 },
  cod: { food: 2, saturation: 0.4 },
  salmon: { food: 2, saturation: 0.4 },
  rotten_flesh: { food: 4, saturation: 0.8 },
  spider_eye: { food: 2, saturation: 3.2 },
};

const TOOL_TIERS: Record<string, number> = {
  wooden: 1,
  golden: 1,
  stone: 2,
  iron: 3,
  diamond: 4,
  netherite: 5,
};

function formatItem(item: any): InventoryItemInfo | null {
  if (!item) return null;
  return {
    slot: item.slot,
    name: item.name,
    count: item.count,
    durabilityUsed: item.durabilityUsed,
    maxDurability: item.maxDurability,
    customName: item.customName || undefined,
  };
}

export function extractInventory(bot: Bot, handedness: 'right' | 'left' = 'right'): InventoryState {
  const inv = bot.inventory;
  const items = inv ? inv.items() : [];

  const mainHandItem = bot.heldItem ? formatItem(bot.heldItem) : null;
  // Off-hand slot in 1.9+ is slot 45
  const offHandRaw = inv?.slots?.[45];
  const offHandItem = offHandRaw ? formatItem(offHandRaw) : null;

  // Selected hotbar slot (0-8)
  const selectedSlot = bot.quickBarSlot ?? 0;

  // Hotbar slots (36-44)
  const hotbar: (InventoryItemInfo | null)[] = [];
  for (let i = 36; i <= 44; i++) {
    hotbar.push(formatItem(inv?.slots?.[i]));
  }

  // Main inventory slots (9-35)
  const mainInventory: (InventoryItemInfo | null)[] = [];
  for (let i = 9; i <= 35; i++) {
    mainInventory.push(formatItem(inv?.slots?.[i]));
  }

  // Armor slots: 5 (head), 6 (chest), 7 (legs), 8 (feet)
  const armor = {
    head: formatItem(inv?.slots?.[5]),
    chest: formatItem(inv?.slots?.[6]),
    legs: formatItem(inv?.slots?.[7]),
    feet: formatItem(inv?.slots?.[8]),
  };

  // Aggregates
  const totalItemCounts: Record<string, number> = {};
  for (const it of items) {
    totalItemCounts[it.name] = (totalItemCounts[it.name] || 0) + it.count;
  }
  const freeSlots = inv ? inv.emptySlotCount() : 0;

  // Tool summary
  const toolSummary: ToolSummary = {
    bestPickaxe: null,
    bestAxe: null,
    bestShovel: null,
    bestSword: null,
    bestHoe: null,
    hasShield: Boolean(offHandItem?.name === 'shield' || mainHandItem?.name === 'shield'),
    lowDurabilityWarnings: [],
  };

  let maxPickTier = 0;
  let maxAxeTier = 0;
  let maxShovelTier = 0;
  let maxSwordTier = 0;
  let maxHoeTier = 0;

  for (const it of items) {
    const name = it.name;
    const tierName = name.split('_')[0];
    const tier = TOOL_TIERS[tierName] || 0;

    if (name.endsWith('_pickaxe') && tier >= maxPickTier) {
      maxPickTier = tier;
      toolSummary.bestPickaxe = name;
    } else if (name.endsWith('_axe') && tier >= maxAxeTier) {
      maxAxeTier = tier;
      toolSummary.bestAxe = name;
    } else if (name.endsWith('_shovel') && tier >= maxShovelTier) {
      maxShovelTier = tier;
      toolSummary.bestShovel = name;
    } else if (name.endsWith('_sword') && tier >= maxSwordTier) {
      maxSwordTier = tier;
      toolSummary.bestSword = name;
    } else if (name.endsWith('_hoe') && tier >= maxHoeTier) {
      maxHoeTier = tier;
      toolSummary.bestHoe = name;
    }

    if (it.maxDurability && it.durabilityUsed !== undefined) {
      const remaining = it.maxDurability - it.durabilityUsed;
      if (remaining < 15) {
        toolSummary.lowDurabilityWarnings.push(`${it.name} has only ${remaining} uses left`);
      }
    }
  }

  // Food list
  const foodList: FoodItemInfo[] = [];
  for (const it of items) {
    if (FOOD_VALUES[it.name]) {
      foodList.push({
        name: it.name,
        count: it.count,
        foodPoints: FOOD_VALUES[it.name].food,
        saturation: FOOD_VALUES[it.name].saturation,
      });
    }
  }

  // Placeable blocks
  const placeableBlocks: Record<string, number> = {};
  for (const it of items) {
    // Check if item corresponds to a block in registry
    const blockData = bot.registry.blocksByName[it.name];
    if (blockData) {
      placeableBlocks[it.name] = (placeableBlocks[it.name] || 0) + it.count;
    }
  }

  // Craftable now
  const craftableNow: string[] = [];
  try {
    // Find crafting table block nearby within reach (3 blocks)
    const craftingTableBlock = bot.findBlock({
      matching: (b) => b.name === 'crafting_table',
      maxDistance: 4,
    });

    // Check craftable recipes for all known items
    const allRecipes = (bot as any).recipesAll(null, craftingTableBlock, true);
    const seen = new Set<string>();
    for (const r of allRecipes) {
      const resItem = bot.registry.items[r.result.id];
      if (resItem && !seen.has(resItem.name)) {
        seen.add(resItem.name);
        craftableNow.push(resItem.name);
      }
    }
  } catch {
    // Recipes query fallback
  }

  // Held item hint
  let heldItemHint = 'Empty hand: can break soft blocks, interact, or punch.';
  if (mainHandItem) {
    const n = mainHandItem.name;
    if (n.endsWith('_pickaxe')) heldItemHint = `Holding ${n}: mines stone, ores, and hard blocks efficiently.`;
    else if (n.endsWith('_axe')) heldItemHint = `Holding ${n}: chops wood and deals heavy single-hit damage.`;
    else if (n.endsWith('_shovel')) heldItemHint = `Holding ${n}: digs dirt, sand, and gravel.`;
    else if (n.endsWith('_sword')) heldItemHint = `Holding ${n}: best melee weapon against mobs.`;
    else if (FOOD_VALUES[n]) heldItemHint = `Holding food ${n}: can eat to restore hunger/health.`;
    else if (placeableBlocks[n]) heldItemHint = `Holding block ${n}: can place in the world.`;
    else heldItemHint = `Holding ${n}.`;
  }

  return {
    mainHand: handedness === 'right' ? mainHandItem : offHandItem,
    offHand: handedness === 'right' ? offHandItem : mainHandItem,
    selectedSlot,
    hotbar,
    mainInventory,
    armor,
    aggregates: {
      totalItemCounts,
      freeSlots,
    },
    toolSummary,
    foodList,
    placeableBlocks,
    craftableNow: craftableNow.slice(0, 15), // top 15 craftable
    heldItemHint,
  };
}
