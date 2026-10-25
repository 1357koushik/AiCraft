import { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { ActionResult, ActionExecutionContext } from '../../types/index.js';
import { techniqueSmeltItem, techniqueVacuumDrops } from '../techniques.js';
import { isAlive } from '../../safety/index.js';

export const COOKED_FOODS = new Set([
  'cooked_beef',
  'cooked_porkchop',
  'cooked_mutton',
  'cooked_chicken',
  'cooked_salmon',
  'cooked_cod',
  'bread',
  'baked_potato',
]);

export const RAW_MEATS = new Set([
  'beef',
  'porkchop',
  'mutton',
  'chicken',
  'salmon',
  'cod',
]);

export const HUNTABLE_MOBS = new Set(['cow', 'pig', 'sheep', 'chicken']);

/**
 * Counts all high-saturation cooked food items in inventory.
 */
export function countCookedFood(bot: Bot): number {
  if (!bot || !bot.inventory) return 0;
  const items = bot.inventory.items();
  let total = 0;
  for (const it of items) {
    if (it && COOKED_FOODS.has(it.name)) {
      total += it.count || 0;
    }
  }
  return total;
}

/**
 * Counts all raw cookable meats in inventory.
 */
export function countRawMeat(bot: Bot): number {
  if (!bot || !bot.inventory) return 0;
  const items = bot.inventory.items();
  let total = 0;
  for (const it of items) {
    if (it && RAW_MEATS.has(it.name)) {
      total += it.count || 0;
    }
  }
  return total;
}

/**
 * Finds nearest passive food animal within search radius.
 */
export function findNearbyHuntableAnimal(bot: Bot, maxDistance: number = 32): any | null {
  if (!bot.entities || !bot.entity) return null;
  const botPos = bot.entity.position;
  let nearestAnimal: any = null;
  let minDist = maxDistance;

  for (const id of Object.keys(bot.entities)) {
    const ent = bot.entities[id];
    if (!ent || ent === bot.entity || !isAlive(ent)) continue;
    if (HUNTABLE_MOBS.has(ent.name || '')) {
      const dist = Math.hypot(ent.position.x - botPos.x, ent.position.y - botPos.y, ent.position.z - botPos.z);
      if (dist < minDist) {
        minDist = dist;
        nearestAnimal = ent;
      }
    }
  }

  return nearestAnimal;
}

/**
 * Food Pipeline Routine: Hunts passive animals for meat and cooks it in a furnace
 * to maintain a healthy food reserve (e.g. >= 16 cooked items).
 */
export async function techniqueHarvestAndCookFood(
  bot: Bot,
  targetCookedCount: number = 16,
  ctx?: Partial<ActionExecutionContext>
): Promise<ActionResult> {
  if (!bot.entity) {
    return { status: 'failed', reason: 'Bot entity unavailable.' };
  }

  let currentCooked = countCookedFood(bot);
  if (currentCooked >= targetCookedCount) {
    return {
      status: 'success',
      reason: `Cooked food reserve already satisfied (${currentCooked}/${targetCookedCount}).`,
    };
  }

  let currentRaw = countRawMeat(bot);

  // 1. If raw meat is insufficient to meet shortfall, hunt nearby animals
  if (currentCooked + currentRaw < targetCookedCount) {
    const shortfall = targetCookedCount - (currentCooked + currentRaw);
    let animalsHunted = 0;

    for (let i = 0; i < shortfall && i < 8; i++) {
      if (ctx?.abortSignal?.aborted) {
        return { status: 'interrupted', reason: 'Food harvesting cancelled.' };
      }

      const animal = findNearbyHuntableAnimal(bot, 32);
      if (!animal) break;

      ctx?.logger?.info?.(`[FOOD_PIPELINE] Hunting ${animal.name} at distance ${bot.entity.position.distanceTo(animal.position).toFixed(1)}m...`);

      // Equip best sword/axe
      if (bot.inventory) {
        const weapon =
          bot.inventory.items().find((it) => it.name.endsWith('_sword')) ||
          bot.inventory.items().find((it) => it.name.endsWith('_axe'));
        if (weapon && bot.heldItem?.name !== weapon.name && bot.equip) {
          try { await bot.equip(weapon, 'hand'); } catch {}
        }
      }

      if (bot.lookAt) {
        await bot.lookAt(animal.position.offset(0, animal.height ? animal.height / 2 : 0.8, 0), true);
      }

      if (bot.attack) {
        bot.attack(animal);
      }

      await new Promise((res) => setTimeout(res, 600));

      // Vacuum drops
      try {
        await techniqueVacuumDrops(bot, 4, ctx?.abortSignal, ctx?.isCurrent);
      } catch {}

      animalsHunted++;
    }
  }

  // 2. Cook available raw meat in furnace
  const rawItems = bot.inventory ? bot.inventory.items().filter((i) => RAW_MEATS.has(i.name)) : [];
  let totalSmelted = 0;

  for (const rawItem of rawItems) {
    if (ctx?.abortSignal?.aborted) break;

    const cookRes = await techniqueSmeltItem(
      bot,
      rawItem.name,
      rawItem.count,
      undefined,
      ctx?.abortSignal,
      ctx?.isCurrent
    );

    if (cookRes.status === 'success') {
      totalSmelted += cookRes.details?.count || rawItem.count;
    }
  }

  const finalCooked = countCookedFood(bot);

  return {
    status: 'success',
    reason: `Harvested and cooked food. Reserve increased to ${finalCooked} cooked food items.`,
    details: {
      finalCookedCount: finalCooked,
      totalSmelted,
    },
  };
}
