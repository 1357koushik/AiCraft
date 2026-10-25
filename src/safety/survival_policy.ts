import { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { ActionExecutionContext, ActionResult } from '../types/index.js';
import { isActionContextActive, ActionArbiter, ActionPriority } from '../agent/arbiter.js';
import { distance3D } from '../utils/math.js';

// ============================================================================
// 1. Version-Supported Food Classification & Safety Policy (Java 1.21.6)
// ============================================================================

export type FoodSafetyTier = 'SAFE' | 'RAW' | 'POOR_EMERGENCY' | 'HARMFUL';

export interface FoodDefinition {
  name: string;
  foodPoints: number;
  saturation: number;
  tier: FoodSafetyTier;
  effects?: string[];
  description?: string;
}

/**
 * Authoritative Minecraft Java 1.21.6 Food Data & Safety Tiers.
 *
 * Tier SAFE: High nutrition, zero negative debuffs. Preferred for all normal and emergency eating.
 * Tier RAW: Safe to consume, but lower nutrition/saturation. Cooked variants preferred.
 * Tier POOR_EMERGENCY: Negative side-effects (e.g. Hunger debuff). ONLY permitted when starving to death.
 * Tier HARMFUL: Toxic debuffs (Poison, Fatal nausea/hunger, random teleportation). EXCLUDED from eating.
 */
export const FOOD_REGISTRY: Record<string, FoodDefinition> = {
  // Tier 1: Optimal / High-Saturation Safe Foods
  golden_carrot: { name: 'golden_carrot', foodPoints: 6, saturation: 14.4, tier: 'SAFE' },
  cooked_beef: { name: 'cooked_beef', foodPoints: 8, saturation: 12.8, tier: 'SAFE' },
  cooked_porkchop: { name: 'cooked_porkchop', foodPoints: 8, saturation: 12.8, tier: 'SAFE' },
  cooked_mutton: { name: 'cooked_mutton', foodPoints: 6, saturation: 9.6, tier: 'SAFE' },
  cooked_salmon: { name: 'cooked_salmon', foodPoints: 6, saturation: 9.6, tier: 'SAFE' },
  cooked_chicken: { name: 'cooked_chicken', foodPoints: 6, saturation: 7.2, tier: 'SAFE' },
  baked_potato: { name: 'baked_potato', foodPoints: 5, saturation: 6.0, tier: 'SAFE' },
  bread: { name: 'bread', foodPoints: 5, saturation: 6.0, tier: 'SAFE' },
  cooked_cod: { name: 'cooked_cod', foodPoints: 5, saturation: 6.0, tier: 'SAFE' },
  golden_apple: { name: 'golden_apple', foodPoints: 4, saturation: 9.6, tier: 'SAFE', effects: ['regeneration', 'absorption'] },
  enchanted_golden_apple: { name: 'enchanted_golden_apple', foodPoints: 4, saturation: 9.6, tier: 'SAFE', effects: ['regeneration', 'resistance', 'fire_resistance', 'absorption'] },
  rabbit_stew: { name: 'rabbit_stew', foodPoints: 10, saturation: 12.0, tier: 'SAFE' },
  mushroom_stew: { name: 'mushroom_stew', foodPoints: 6, saturation: 7.2, tier: 'SAFE' },
  beetroot_soup: { name: 'beetroot_soup', foodPoints: 6, saturation: 7.2, tier: 'SAFE' },
  pumpkin_pie: { name: 'pumpkin_pie', foodPoints: 8, saturation: 4.8, tier: 'SAFE' },

  // Tier 2: Standard Safe Snacks / Supplements
  apple: { name: 'apple', foodPoints: 4, saturation: 2.4, tier: 'SAFE' },
  carrot: { name: 'carrot', foodPoints: 3, saturation: 3.6, tier: 'SAFE' },
  melon_slice: { name: 'melon_slice', foodPoints: 2, saturation: 1.2, tier: 'SAFE' },
  sweet_berries: { name: 'sweet_berries', foodPoints: 2, saturation: 0.4, tier: 'SAFE' },
  glow_berries: { name: 'glow_berries', foodPoints: 2, saturation: 0.4, tier: 'SAFE' },
  cookie: { name: 'cookie', foodPoints: 2, saturation: 0.4, tier: 'SAFE' },
  dried_kelp: { name: 'dried_kelp', foodPoints: 1, saturation: 0.6, tier: 'SAFE' },

  // Tier RAW: Safe raw ingredients (usable, but cooked variants preferred)
  beef: { name: 'beef', foodPoints: 3, saturation: 1.8, tier: 'RAW' },
  porkchop: { name: 'porkchop', foodPoints: 3, saturation: 1.8, tier: 'RAW' },
  mutton: { name: 'mutton', foodPoints: 2, saturation: 1.2, tier: 'RAW' },
  rabbit: { name: 'rabbit', foodPoints: 3, saturation: 1.8, tier: 'RAW' },
  cod: { name: 'cod', foodPoints: 2, saturation: 0.4, tier: 'RAW' },
  salmon: { name: 'salmon', foodPoints: 2, saturation: 0.4, tier: 'RAW' },

  // Tier POOR_EMERGENCY: Negative side-effects (Hunger 30s). ONLY permitted when starving to death!
  rotten_flesh: { name: 'rotten_flesh', foodPoints: 4, saturation: 0.8, tier: 'POOR_EMERGENCY', effects: ['hunger_80_percent'] },
  raw_chicken: { name: 'raw_chicken', foodPoints: 2, saturation: 1.2, tier: 'POOR_EMERGENCY', effects: ['hunger_30_percent'] },

  // Tier HARMFUL: Toxic or dangerous debuffs. FORBIDDEN from regular eating!
  spider_eye: { name: 'spider_eye', foodPoints: 2, saturation: 3.2, tier: 'HARMFUL', effects: ['poison_4s'] },
  poisonous_potato: { name: 'poisonous_potato', foodPoints: 2, saturation: 1.2, tier: 'HARMFUL', effects: ['poison_60_percent'] },
  pufferfish: { name: 'pufferfish', foodPoints: 1, saturation: 0.2, tier: 'HARMFUL', effects: ['poison_IV', 'hunger_III', 'nausea_II'] },
  chorus_fruit: { name: 'chorus_fruit', foodPoints: 4, saturation: 2.4, tier: 'HARMFUL', effects: ['random_teleport'] },
};

export interface FoodSelectionOptions {
  reservedItems?: Record<string, number>;
  allowEmergencyOnly?: boolean;
  healthPriority?: boolean; // When health is critically low, prioritize golden apples or highest saturation
}

export interface FoodSelectionResult {
  selectedItem: any | null;
  foodDef: FoodDefinition | null;
  reason: string;
  isEmergencyFallback: boolean;
}

/**
 * Evaluates whether an item is edible according to version-supported data.
 */
export function isFoodItem(itemName: string): boolean {
  if (!itemName) return false;
  return Boolean(FOOD_REGISTRY[itemName.toLowerCase()]);
}

/**
 * Checks whether an item is classified as toxic/harmful.
 */
export function isHarmfulFood(itemName: string): boolean {
  if (!itemName) return false;
  const def = FOOD_REGISTRY[itemName.toLowerCase()];
  return def ? def.tier === 'HARMFUL' : false;
}

/**
 * Checks whether an item is a poor emergency food (e.g. rotten flesh, raw chicken).
 */
export function isPoorEmergencyFood(itemName: string): boolean {
  if (!itemName) return false;
  const def = FOOD_REGISTRY[itemName.toLowerCase()];
  return def ? def.tier === 'POOR_EMERGENCY' : false;
}

/**
 * Selects the optimal food item from inventory based on explicit safety tiers,
 * nutritional ranking, active health requirements, and reservation protection.
 */
export function selectBestFood(bot: Bot, options: FoodSelectionOptions = {}): FoodSelectionResult {
  if (!bot || !bot.inventory) {
    return { selectedItem: null, foodDef: null, reason: 'Inventory unavailable.', isEmergencyFallback: false };
  }

  const items = typeof bot.inventory.items === 'function' ? bot.inventory.items() : [];
  const reserved = options.reservedItems || {};
  const allowEmergencyOnly = options.allowEmergencyOnly ?? false;

  // Filter items that exist in our food registry
  const availableFoods: Array<{ item: any; def: FoodDefinition; availableCount: number }> = [];

  for (const it of items) {
    if (!it || !it.name) continue;
    const def = FOOD_REGISTRY[it.name.toLowerCase()];
    if (!def) continue;

    // Check reservation limit
    const reservedCount = reserved[it.name] || 0;
    const availableCount = it.count - reservedCount;

    if (availableCount > 0) {
      availableFoods.push({ item: it, def, availableCount });
    }
  }

  // 1. Exclude all HARMFUL foods unconditionally (spider eye, poisonous potato, pufferfish)
  const nonHarmfulFoods = availableFoods.filter((f) => f.def.tier !== 'HARMFUL');

  // 2. Separate Safe/Raw foods from Poor Emergency foods
  const safeFoods = nonHarmfulFoods.filter((f) => f.def.tier === 'SAFE');
  const rawFoods = nonHarmfulFoods.filter((f) => f.def.tier === 'RAW');
  const emergencyFoods = nonHarmfulFoods.filter((f) => f.def.tier === 'POOR_EMERGENCY');

  // If health is critically low (< 10) and golden apple exists, prioritize it for absorption/regen
  if (options.healthPriority) {
    const gApple = safeFoods.find((f) => f.def.name === 'enchanted_golden_apple' || f.def.name === 'golden_apple');
    if (gApple) {
      return {
        selectedItem: gApple.item,
        foodDef: gApple.def,
        reason: `Selected emergency healing food (${gApple.def.name}) for low health.`,
        isEmergencyFallback: false,
      };
    }
  }

  // 3. Rank SAFE foods by nutritional score (food points + saturation)
  if (safeFoods.length > 0) {
    safeFoods.sort((a, b) => {
      const scoreA = a.def.foodPoints + a.def.saturation;
      const scoreB = b.def.foodPoints + b.def.saturation;
      return scoreB - scoreA;
    });

    const chosen = safeFoods[0];
    return {
      selectedItem: chosen.item,
      foodDef: chosen.def,
      reason: `Selected optimal safe food (${chosen.def.name}, +${chosen.def.foodPoints} food, +${chosen.def.saturation} sat).`,
      isEmergencyFallback: false,
    };
  }

  // 4. Fallback to RAW safe foods if no cooked safe foods exist
  if (rawFoods.length > 0) {
    rawFoods.sort((a, b) => b.def.foodPoints - a.def.foodPoints);
    const chosen = rawFoods[0];
    return {
      selectedItem: chosen.item,
      foodDef: chosen.def,
      reason: `Selected raw food fallback (${chosen.def.name}, no cooked food available).`,
      isEmergencyFallback: false,
    };
  }

  // 5. Fallback to POOR_EMERGENCY foods (rotten flesh / raw chicken) ONLY if explicitly permitted (starving)
  if (allowEmergencyOnly && emergencyFoods.length > 0) {
    const chosen = emergencyFoods[0];
    return {
      selectedItem: chosen.item,
      foodDef: chosen.def,
      reason: `Selected poor emergency food (${chosen.def.name}) strictly due to starvation; no safe foods exist.`,
      isEmergencyFallback: true,
    };
  }

  // Check if harmful foods were present in inventory but rejected
  const hadHarmfulOnly = availableFoods.some((f) => f.def.tier === 'HARMFUL');
  const hadEmergencyOnly = emergencyFoods.length > 0;

  if (hadHarmfulOnly && !hadEmergencyOnly) {
    return {
      selectedItem: null,
      foodDef: null,
      reason: 'Only toxic/harmful items (e.g. spider_eye / poisonous_potato / pufferfish) in inventory; refused to consume.',
      isEmergencyFallback: false,
    };
  }

  if (hadEmergencyOnly && !allowEmergencyOnly) {
    return {
      selectedItem: null,
      foodDef: null,
      reason: 'Only poor emergency food (e.g. rotten_flesh) available, but starvation threshold not reached.',
      isEmergencyFallback: false,
    };
  }

  return {
    selectedItem: null,
    foodDef: null,
    reason: 'No edible food items in inventory.',
    isEmergencyFallback: false,
  };
}

// ============================================================================
// 2. Inventory Reliability: Storage Plans, Reservations & Safe Disposal
// ============================================================================

/**
 * Disposable Surplus Allowlist:
 * High-frequency bulk blocks that may be discarded if and only if inventory is full
 * AND no storage container is reachable, preserving tools, ores, food, and workstations.
 */
export const DISPOSABLE_SURPLUS_ALLOWLIST = new Set<string>([
  'dirt',
  'cobblestone',
  'gravel',
  'sand',
  'diorite',
  'andesite',
  'granite',
  'tuff',
  'deepslate',
  'cobbled_deepslate',
  'netherrack',
]);

/**
 * Protected Item Categories:
 * Items that must NEVER be discarded or dropped under full-inventory conditions.
 */
export function isProtectedItem(itemName: string): boolean {
  if (!itemName) return false;
  const name = itemName.toLowerCase();

  // 1. All Tools, Weapons, and Armor
  if (
    name.includes('pickaxe') ||
    name.includes('axe') ||
    name.includes('shovel') ||
    name.includes('hoe') ||
    name.includes('sword') ||
    name.includes('bow') ||
    name.includes('crossbow') ||
    name.includes('shield') ||
    name.includes('helmet') ||
    name.includes('chestplate') ||
    name.includes('leggings') ||
    name.includes('boots') ||
    name.includes('shears') ||
    name.includes('flint_and_steel')
  ) {
    return true;
  }

  // 2. All Food Items
  if (isFoodItem(name)) {
    return true;
  }

  // 3. All Ores, Raw Ores, Ingots, and Valuables
  if (
    name.includes('ore') ||
    name.includes('raw_') ||
    name.includes('ingot') ||
    name === 'diamond' ||
    name === 'emerald' ||
    name === 'lapis_lazuli' ||
    name === 'redstone' ||
    name === 'amethyst_shard' ||
    name === 'netherite_scrap' ||
    name === 'coal' ||
    name === 'charcoal'
  ) {
    return true;
  }

  // 4. Workstations, Utilities, and Torches
  if (
    name === 'crafting_table' ||
    name === 'furnace' ||
    name === 'blast_furnace' ||
    name === 'smoker' ||
    name === 'chest' ||
    name === 'barrel' ||
    name === 'anvil' ||
    name === 'torch' ||
    name === 'soul_torch' ||
    name === 'bucket' ||
    name === 'water_bucket' ||
    name === 'lava_bucket' ||
    name.includes('bed')
  ) {
    return true;
  }

  return false;
}

export interface InventoryManagementOptions {
  reservedMaterials?: Record<string, number>;
  minimumPreservedSurplus?: number; // Minimum number of blocks to preserve for bridging (default: 64)
  allowDropping?: boolean; // Whether dropping surplus is permitted if no container exists
}

export interface InventoryManagementResult {
  status: 'clean' | 'deposited' | 'dropped' | 'failed';
  actionTaken: string;
  itemProcessed?: string;
  countProcessed?: number;
}

/**
 * Handles full-inventory situations reliably:
 * 1. Strictly refuses automatic crafting/compaction (logs -> planks or ingots -> blocks)
 *    merely because slots are low, preserving material optionality.
 * 2. Checks for known reachable storage containers (chest / barrel within 4.5m) to deposit surplus.
 * 3. If no container exists, drops ONLY items explicitly permitted by the disposable allowlist,
 *    strictly respecting reserved ingredients, tools, food, ores, and utilities.
 */
export async function handleFullInventoryReliability(
  bot: Bot,
  options: InventoryManagementOptions = {},
  ctx?: ActionExecutionContext
): Promise<InventoryManagementResult> {
  if (!bot || !bot.inventory) {
    return { status: 'failed', actionTaken: 'Inventory unavailable.' };
  }

  const emptySlots = typeof bot.inventory.emptySlotCount === 'function' ? bot.inventory.emptySlotCount() : 36;
  if (emptySlots > 0) {
    return { status: 'clean', actionTaken: `Inventory has ${emptySlots} free slots; no disposal needed.` };
  }

  const reserved = options.reservedMaterials || {};
  const minPreserved = options.minimumPreservedSurplus ?? 64;
  const items = typeof bot.inventory.items === 'function' ? bot.inventory.items() : [];

  // 1. Storage Container First: Check if a chest or barrel is reachable nearby
  const containerBlock = bot.findBlock ? bot.findBlock({
    matching: (b: any) => b.name === 'chest' || b.name === 'barrel',
    maxDistance: 4.5,
  }) : null;

  if (containerBlock && bot.openContainer) {
    console.log(`[INVENTORY_POLICY] Full inventory detected. Depositing surplus to nearby ${containerBlock.name}...`);
    try {
      const window = await bot.openContainer(containerBlock);
      let depositedAny = false;

      // Find surplus disposable or common items to deposit
      for (const it of items) {
        if (!it || !it.name) continue;
        const resCount = reserved[it.name] || 0;
        const available = it.count - resCount;

        // Never deposit active tools/armor or reserved items
        if (isProtectedItem(it.name) && !DISPOSABLE_SURPLUS_ALLOWLIST.has(it.name)) continue;
        if (available <= 0) continue;

        const countToDeposit = Math.min(available, 64);
        try {
          await (window as any).deposit(it.type, null, countToDeposit);
          depositedAny = true;
          console.log(`[INVENTORY_POLICY] Deposited ${countToDeposit}x ${it.name} into ${containerBlock.name}.`);
        } catch {}
      }

      try { bot.closeWindow(window); } catch {}

      if (depositedAny) {
        return {
          status: 'deposited',
          actionTaken: `Deposited surplus materials into ${containerBlock.name}.`,
        };
      }
    } catch (err: any) {
      console.log(`[INVENTORY_POLICY] Container deposit attempt failed: ${err.message}`);
    }
  }

  // 2. Controlled Safe Disposal: If no container and dropping is allowed
  if (options.allowDropping) {
    console.log(`[INVENTORY_POLICY] No storage container available. Inspecting inventory for disposable surplus...`);

    // Aggregate counts of disposable items
    const totals: Record<string, number> = {};
    for (const it of items) {
      if (it && it.name) {
        totals[it.name] = (totals[it.name] || 0) + it.count;
      }
    }

    for (const it of items) {
      if (!it || !it.name) continue;
      const name = it.name.toLowerCase();

      // Check allowlist: must be strictly disposable
      if (!DISPOSABLE_SURPLUS_ALLOWLIST.has(name)) continue;

      // Check reservation: must not discard reserved ingredients
      const resCount = reserved[name] || 0;
      const totalCount = totals[name] || it.count;
      const disposableExcess = totalCount - (resCount + minPreserved);

      if (disposableExcess > 0 && bot.toss) {
        const dropCount = Math.min(it.count, disposableExcess, 16);
        console.log(`[INVENTORY_POLICY] Dropping ${dropCount}x surplus ${name} (preserved ${minPreserved} + ${resCount} reserved).`);
        try {
          await bot.toss(it.type, null, dropCount);
          return {
            status: 'dropped',
            actionTaken: `Dropped ${dropCount} surplus ${name} to free inventory space.`,
            itemProcessed: name,
            countProcessed: dropCount,
          };
        } catch (tossErr: any) {
          console.log(`[INVENTORY_POLICY] Drop failed: ${tossErr.message}`);
        }
      }
    }
  }

  return {
    status: 'failed',
    actionTaken: 'Inventory is completely full, but all items are protected or reserved; none can be discarded.',
  };
}

// ============================================================================
// 3. Tool Durability Protection & Safe Tool Selection
// ============================================================================

export interface ToolDurabilityInfo {
  name: string;
  durabilityUsed: number;
  maxDurability: number;
  remainingUses: number;
  isCriticallyDamaged: boolean;
}

/**
 * Computes remaining tool durability from Mineflayer item metadata.
 */
export function getToolDurabilityInfo(item: any, criticalThreshold: number = 5): ToolDurabilityInfo | null {
  if (!item || !item.name) return null;
  const max = item.maxDurability || 0;
  if (max <= 0) return null; // Not a damageable tool

  const used = item.durabilityUsed !== undefined ? item.durabilityUsed : 0;
  const remaining = Math.max(0, max - used);

  return {
    name: item.name,
    durabilityUsed: used,
    maxDurability: max,
    remainingUses: remaining,
    isCriticallyDamaged: remaining <= criticalThreshold,
  };
}

/**
 * Finds the best healthy tool in inventory, avoiding critically damaged tools
 * when alternative tools of sufficient tier are available.
 */
export function findBestHealthyTool(
  bot: Bot,
  toolTypeKeyword: 'pickaxe' | 'axe' | 'shovel' | 'sword' | 'hoe',
  minTier: number = 0,
  criticalThreshold: number = 3
): any | null {
  if (!bot || !bot.inventory) return null;
  const items = typeof bot.inventory.items === 'function' ? bot.inventory.items() : [];

  const candidates: Array<{ item: any; tier: number; durability: ToolDurabilityInfo | null }> = [];

  for (const it of items) {
    if (!it || !it.name || !it.name.includes(toolTypeKeyword)) continue;
    const tier = getGenericToolTier(it.name);
    if (tier < minTier) continue;

    const durability = getToolDurabilityInfo(it, criticalThreshold);
    candidates.push({ item: it, tier, durability });
  }

  if (candidates.length === 0) return null;

  // Separate non-critical tools from critically damaged tools
  const healthyTools = candidates.filter((c) => !c.durability?.isCriticallyDamaged);

  if (healthyTools.length > 0) {
    // Choose highest tier among healthy tools
    healthyTools.sort((a, b) => b.tier - a.tier);
    return healthyTools[0].item;
  }

  // If ONLY critically damaged tools exist, return highest tier as last resort
  candidates.sort((a, b) => b.tier - a.tier);
  return candidates[0].item;
}

function getGenericToolTier(toolName: string): number {
  if (!toolName) return 0;
  const name = toolName.toLowerCase();
  if (name.includes('netherite')) return 5;
  if (name.includes('diamond')) return 4;
  if (name.includes('iron')) return 3;
  if (name.includes('stone')) return 2;
  if (name.includes('golden') || name.includes('wood')) return 1;
  return 0;
}

// ============================================================================
// 4. Hazard Avoidance & Water-Bucket Clutch Policy
// ============================================================================

/**
 * Policy Statement on Fall Mitigation & Water-Bucket Clutch Maneuvers:
 *
 * In accordance with MINECRAFT_AI_MASTER_BLUEPRINT_v2.md:
 * - Water-bucket clutch maneuvers are DEFERRED and DISABLED by default.
 * - Primary safety relies on route-aware pathfinding (avoiding fatal cliff edges > 3 blocks),
 *   unsupported floor detection, and physical retreat.
 * - Water placement is dimension- and context-dependent (fails entirely in the Nether,
 *   and causes unpredictable flooding in enclosed underground spaces).
 */
export function isWaterBucketClutchPermitted(
  bot?: Bot,
  context?: { isEmergencyFall?: boolean }
): boolean {
  // If not an active emergency fall, disabled by default to prevent reckless acrobatic usage
  if (!context?.isEmergencyFall) {
    return false;
  }
  // Strictly prohibited in the Nether as water evaporates immediately
  const dim = (bot?.game as any)?.dimension;
  if (dim === 'the_nether' || dim === 'minecraft:the_nether') {
    return false;
  }
  return true;
}
