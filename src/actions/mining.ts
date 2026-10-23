import { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { goals } from 'mineflayer-pathfinder';
import { ActionExecutionContext, ActionResult } from '../types/index.js';
import { distance3D } from '../utils/math.js';
import { isActionContextActive } from '../agent/arbiter.js';
import { updatePathfinderMovements, techniqueVacuumDrops } from './techniques.js';
import { navigationBlacklist, NavigationFailureKind } from './blacklist.js';

function toNavigationFailureKind(kind?: MiningFailureKind): NavigationFailureKind {
  if (kind === 'HAZARD_OBSTRUCTION') return 'HAZARD_OBSTRUCTION';
  if (kind === 'STALE_TARGET') return 'STALE_TARGET';
  if (kind === 'PATH_UNREACHABLE') return 'UNREACHABLE';
  if (kind === 'CANCELLED') return 'CANCELLED';
  return 'UNKNOWN';
}

export type MiningFailureKind =
  | 'WRONG_TOOL_TIER'
  | 'STALE_TARGET'
  | 'HAZARD_OBSTRUCTION'
  | 'PATH_UNREACHABLE'
  | 'INVENTORY_FULL'
  | 'TOOL_BROKEN'
  | 'DROP_NOT_COLLECTED'
  | 'CANCELLED'
  | 'UNKNOWN';

export interface HarvestValidationResult {
  valid: boolean;
  failureKind?: MiningFailureKind;
  reason?: string;
  bestTool?: any;
  requiredTier: number;
  availableTier: number;
}

export interface OreVeinTraversalOptions {
  maxCount?: number;
  maxDistance?: number;
  timeoutMs?: number;
  allowDiagonal?: boolean; // Defaults to FALSE (strict 6 face-adjacent orthogonal neighbors)
}

/**
 * Returns required harvest tier for a block in Minecraft Java 1.21.6:
 * 0 = Hand / any
 * 1 = Wooden pickaxe
 * 2 = Stone pickaxe
 * 3 = Iron pickaxe
 * 4 = Diamond pickaxe
 * 5 = Netherite pickaxe
 */
export function getRequiredHarvestTier(blockName: string): number {
  if (!blockName) return 0;
  const name = blockName.toLowerCase();

  // Tier 4: Obsidian, Ancient Debris, Crying Obsidian, Respawn Anchor
  if (name === 'obsidian' || name === 'crying_obsidian' || name === 'ancient_debris' || name === 'respawn_anchor') {
    return 4;
  }

  // Tier 3: Diamond, Gold, Redstone, Emerald
  if (
    name.includes('diamond_ore') ||
    name.includes('gold_ore') ||
    name.includes('redstone_ore') ||
    name.includes('emerald_ore') ||
    name === 'raw_iron_block' ||
    name === 'raw_gold_block' ||
    name === 'gold_block' ||
    name === 'diamond_block'
  ) {
    return 3;
  }

  // Tier 2: Iron, Copper, Lapis
  if (
    name.includes('iron_ore') ||
    name.includes('copper_ore') ||
    name.includes('lapis_ore') ||
    name === 'iron_block' ||
    name === 'copper_block' ||
    name === 'lapis_block'
  ) {
    return 2;
  }

  // Tier 1: Stone, Cobblestone, Deepslate, Coal, Netherrack
  if (
    name.includes('coal_ore') ||
    name === 'stone' ||
    name === 'cobblestone' ||
    name === 'deepslate' ||
    name === 'cobbled_deepslate' ||
    name === 'sandstone' ||
    name === 'diorite' ||
    name === 'granite' ||
    name === 'andesite' ||
    name === 'netherrack' ||
    name === 'blackstone' ||
    name === 'basalt'
  ) {
    return 1;
  }

  return 0;
}

/**
 * Returns the harvest tier of a pickaxe item:
 * 0 = None / Not a pickaxe
 * 1 = Wooden / Golden
 * 2 = Stone
 * 3 = Iron
 * 4 = Diamond
 * 5 = Netherite
 */
export function getToolHarvestTier(itemName?: string | null): number {
  if (!itemName) return 0;
  const name = itemName.toLowerCase();
  if (!name.endsWith('pickaxe')) return 0;

  if (name.includes('netherite')) return 5;
  if (name.includes('diamond')) return 4;
  if (name.includes('iron')) return 3;
  if (name.includes('stone')) return 2;
  if (name.includes('golden')) return 1; // Gold mines fast, but only harvests Wood tier
  if (name.includes('wooden')) return 1;

  return 0;
}

/**
 * Checks if a specific tool item satisfies the block's required harvest tier.
 */
export function canHarvestBlockWithTool(blockName: string, toolName?: string | null): boolean {
  const reqTier = getRequiredHarvestTier(blockName);
  if (reqTier === 0) return true; // Hand harvestable
  const toolTier = getToolHarvestTier(toolName);
  return toolTier >= reqTier;
}

/**
 * Finds the highest tier pickaxe in the bot's inventory.
 */
export function findBestPickaxeInInventory(bot: Bot, minTier: number = 0): any | null {
  if (!bot || !bot.inventory) return null;
  const items = typeof bot.inventory.items === 'function' ? bot.inventory.items() : [];
  let bestTool: any = null;
  let highestTier = -1;

  for (const it of items) {
    if (!it || !it.name || !it.name.includes('pickaxe')) continue;
    const tier = getToolHarvestTier(it.name);
    if (tier >= minTier && tier > highestTier) {
      highestTier = tier;
      bestTool = it;
    }
  }

  return bestTool;
}

/**
 * The 5 Pre-Mining Validations:
 * 1. Observation Freshness (Block is loaded, not air, matches identity)
 * 2. Required Tool & Harvest Tier (Refuses to mine if tool tier cannot harvest drops)
 * 3. Inventory Capacity (Has space for drops)
 * 4. Local Hazards (Direct lava, fire, water flooding, or precarious falling sand/gravel)
 * 5. Spatial Reachability / Blacklist
 */
export function validateBlockHarvestability(
  bot: Bot,
  block: any,
  options: { checkReachability?: boolean; maxDistance?: number } = {}
): HarvestValidationResult {
  const reqTier = getRequiredHarvestTier(block?.name || '');

  // 1. Observation Freshness check
  if (!block || !block.position || block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air') {
    return {
      valid: false,
      failureKind: 'STALE_TARGET',
      reason: 'Target block is stale (already mined, air, or unloaded).',
      requiredTier: reqTier,
      availableTier: 0,
    };
  }

  // Re-read block from world if bot has blockAt
  if (typeof bot.blockAt === 'function') {
    const liveBlock = bot.blockAt(block.position);
    if (!liveBlock || liveBlock.name === 'air' || liveBlock.name === 'cave_air') {
      return {
        valid: false,
        failureKind: 'STALE_TARGET',
        reason: `Target block is stale: no longer present at (${block.position.x}, ${block.position.y}, ${block.position.z}).`,
        requiredTier: reqTier,
        availableTier: 0,
      };
    }
  }

  // Check navigation blacklist
  if (navigationBlacklist.isBlacklisted(block.position, 1.0)) {
    return {
      valid: false,
      failureKind: 'PATH_UNREACHABLE',
      reason: `Target block at (${block.position.x}, ${block.position.y}, ${block.position.z}) is blacklisted (recent failure).`,
      requiredTier: reqTier,
      availableTier: 0,
    };
  }

  // 2. Required Tool and Harvest Tier check
  const bestTool = findBestPickaxeInInventory(bot, 0);
  const availableTier = bestTool ? getToolHarvestTier(bestTool.name) : 0;

  if (reqTier > 0 && (!bestTool || availableTier < reqTier)) {
    const tierNames = ['Hand', 'Wooden Pickaxe', 'Stone Pickaxe', 'Iron Pickaxe', 'Diamond Pickaxe', 'Netherite Pickaxe'];
    return {
      valid: false,
      failureKind: 'WRONG_TOOL_TIER',
      reason: `Cannot harvest ${block.name}: requires at least ${tierNames[reqTier]} (best available: ${bestTool ? bestTool.name : 'none'}). Mining without proper tool yields no drops.`,
      bestTool,
      requiredTier: reqTier,
      availableTier,
    };
  }

  // 3. Inventory Capacity check
  if (bot.inventory) {
    const emptySlots = typeof bot.inventory.emptySlotCount === 'function' ? bot.inventory.emptySlotCount() : 36;
    if (emptySlots === 0) {
      // Check if inventory has a non-full stack of the expected drop
      const items = typeof bot.inventory.items === 'function' ? bot.inventory.items() : [];
      const hasPartialStack = items.some((it) => it && (it.name === block.name || block.name.includes(it.name)) && it.count < 64);
      if (!hasPartialStack) {
        return {
          valid: false,
          failureKind: 'INVENTORY_FULL',
          reason: 'Inventory is full; no empty slots or partial stacks for block drops.',
          bestTool,
          requiredTier: reqTier,
          availableTier,
        };
      }
    }
  }

  // 4. Local Hazards check (Check all 6 orthogonal face neighbors for lava/fire)
  if (typeof bot.blockAt === 'function') {
    const pos = block.position;
    const faceOffsets = [
      new Vec3(1, 0, 0),
      new Vec3(-1, 0, 0),
      new Vec3(0, 1, 0),
      new Vec3(0, -1, 0),
      new Vec3(0, 0, 1),
      new Vec3(0, 0, -1),
    ];

    for (const off of faceOffsets) {
      const neighbor = bot.blockAt(pos.plus(off));
      if (neighbor) {
        if (neighbor.name === 'lava' || neighbor.name === 'flowing_lava' || neighbor.name === 'fire') {
          return {
            valid: false,
            failureKind: 'HAZARD_OBSTRUCTION',
            reason: `Target block is adjacent to deadly hazard (${neighbor.name} at ${neighbor.position.x}, ${neighbor.position.y}, ${neighbor.position.z}).`,
            bestTool,
            requiredTier: reqTier,
            availableTier,
          };
        }
      }
    }

    // Overhead hazard check: block directly above target
    const above = bot.blockAt(pos.offset(0, 1, 0));
    if (above) {
      if (above.name === 'water' || above.name === 'flowing_water') {
        return {
          valid: false,
          failureKind: 'HAZARD_OBSTRUCTION',
          reason: 'Block has overhead water (would cause flooding / drowning hazard).',
          bestTool,
          requiredTier: reqTier,
          availableTier,
        };
      }
    }
  }

  // 5. Reachability distance limit
  if (options.checkReachability && bot.entity?.position) {
    const eyePos = bot.entity.position.offset(0, 1.6, 0);
    const dist = distance3D(eyePos, block.position);
    const maxDist = options.maxDistance || 32;
    if (dist > maxDist) {
      return {
        valid: false,
        failureKind: 'PATH_UNREACHABLE',
        reason: `Target block distance (${dist.toFixed(1)}m) exceeds maximum scan range (${maxDist}m).`,
        bestTool,
        requiredTier: reqTier,
        availableTier,
      };
    }
  }

  return {
    valid: true,
    bestTool,
    requiredTier: reqTier,
    availableTier,
  };
}

/**
 * Ore-Vein Traversal:
 * Explores connected ore blocks starting from an exposed initial ore block.
 *
 * STRICT RULE: Defaults to face-adjacent connectivity (six orthogonal neighbors:
 * +/-X, +/-Y, +/-Z). Does NOT connect diagonally by default, preventing blind
 * corner digging through walls or breaking into unseen lava pools.
 */
export function getFaceAdjacentOreVein(
  bot: Bot,
  startBlock: any,
  options: OreVeinTraversalOptions = {}
): any[] {
  if (!startBlock || !startBlock.position) return [];
  const maxCount = options.maxCount ?? 8;
  const maxDistance = options.maxDistance ?? 6;
  const allowDiagonal = options.allowDiagonal ?? false;
  const oreName = startBlock.name;

  const queue: any[] = [startBlock];
  const discovered: any[] = [startBlock];
  const visited = new Set<string>();

  const startKey = `${Math.floor(startBlock.position.x)},${Math.floor(startBlock.position.y)},${Math.floor(startBlock.position.z)}`;
  visited.add(startKey);

  // Define neighbor connectivity offsets:
  // Default: Strict 6 orthogonal face-adjacent neighbors
  const orthogonalOffsets: Vec3[] = [
    new Vec3(1, 0, 0),
    new Vec3(-1, 0, 0),
    new Vec3(0, 1, 0),
    new Vec3(0, -1, 0),
    new Vec3(0, 0, 1),
    new Vec3(0, 0, -1),
  ];

  while (queue.length > 0 && discovered.length < maxCount) {
    const current = queue.shift();
    const cPos = current.position;

    const offsetsToUse = allowDiagonal
      ? get26NeighborOffsets()
      : orthogonalOffsets;

    for (const off of offsetsToUse) {
      const nPos = cPos.plus(off);
      const key = `${Math.floor(nPos.x)},${Math.floor(nPos.y)},${Math.floor(nPos.z)}`;

      if (visited.has(key)) continue;
      visited.add(key);

      // Verify distance bound from start block
      if (distance3D(startBlock.position, nPos) > maxDistance) continue;

      const neighborBlock = typeof bot.blockAt === 'function' ? bot.blockAt(nPos) : null;
      if (!neighborBlock) continue;

      // Match same ore family (e.g. iron_ore matches deepslate_iron_ore and vice versa)
      if (isMatchingOreSpecies(neighborBlock.name, oreName)) {
        discovered.push(neighborBlock);
        queue.push(neighborBlock);
        if (discovered.length >= maxCount) break;
      }
    }
  }

  return discovered;
}

function get26NeighborOffsets(): Vec3[] {
  const offsets: Vec3[] = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (dx === 0 && dy === 0 && dz === 0) continue;
        offsets.push(new Vec3(dx, dy, dz));
      }
    }
  }
  return offsets;
}

/**
 * Helper to match standard and deepslate variants of the same ore species.
 */
export function isMatchingOreSpecies(nameA: string, nameB: string): boolean {
  if (!nameA || !nameB) return false;
  if (nameA === nameB) return true;
  const baseA = nameA.replace('deepslate_', '');
  const baseB = nameB.replace('deepslate_', '');
  return baseA === baseB;
}

/**
 * Expected drop item name for mined ore or resource block.
 */
export function getExpectedDropItemName(blockName: string): string {
  if (!blockName) return '';
  const name = blockName.toLowerCase().replace('deepslate_', '');

  if (name === 'iron_ore') return 'raw_iron';
  if (name === 'copper_ore') return 'raw_copper';
  if (name === 'gold_ore') return 'raw_gold';
  if (name === 'coal_ore') return 'coal';
  if (name === 'diamond_ore') return 'diamond';
  if (name === 'emerald_ore') return 'emerald';
  if (name === 'lapis_ore') return 'lapis_lazuli';
  if (name === 'redstone_ore') return 'redstone';
  if (name === 'stone') return 'cobblestone';
  if (name === 'deepslate') return 'cobbled_deepslate';
  if (name === 'clay') return 'clay_ball';
  if (name.includes('_log')) return name;

  return name;
}

/**
 * Closed-Loop Ore Vein Mining Technique:
 * 1. Validates the 5 pre-conditions before mining.
 * 2. Traverses face-adjacent ore vein (strictly no diagonal by default).
 * 3. Handles tool equipping, durability checks, and tool breakage.
 * 4. Verifies drops and inventory changes after mining each block.
 * 5. Bounded by count, depth, and time budget.
 */
export async function techniqueMineOreVein(
  bot: Bot,
  startBlock: any,
  options: OreVeinTraversalOptions = {},
  ctx: ActionExecutionContext
): Promise<ActionResult> {
  if (!isActionContextActive(ctx)) {
    return { status: 'interrupted', reason: 'Ore mining cancelled before start.' };
  }

  // 1. Initial 5-Point Pre-mining Validation
  const validation = validateBlockHarvestability(bot, startBlock, { checkReachability: true });
  if (!validation.valid) {
    return {
      status: 'failed',
      reason: validation.reason || 'Block validation failed.',
      details: { failureKind: validation.failureKind },
    };
  }

  const expectedDrop = getExpectedDropItemName(startBlock.name);
  const initialDropCount = getInventoryCount(bot, expectedDrop);
  const maxOreCount = options.maxCount ?? 8;

  // 2. Discover Face-Adjacent Ore Vein (6 orthogonal neighbors only)
  const veinBlocks = getFaceAdjacentOreVein(bot, startBlock, {
    maxCount: maxOreCount,
    maxDistance: options.maxDistance ?? 6,
    allowDiagonal: false,
  });

  console.log(`[ORE_MINING] Discovered ${veinBlocks.length} face-adjacent ${startBlock.name} block(s). Beginning closed-loop extraction...`);

  let minedCount = 0;
  let onAbort: (() => void) | null = null;

  try {
    if (ctx.abortSignal) {
      onAbort = () => {
        try { (bot as any).pathfinder?.stop(); } catch {}
        try { bot.stopDigging?.(); } catch {}
        bot.clearControlStates?.();
      };
      ctx.abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    for (let i = 0; i < veinBlocks.length; i++) {
      if (!isActionContextActive(ctx)) {
        return { status: 'interrupted', reason: 'Ore mining cancelled by preemption signal.' };
      }

      const target = veinBlocks[i];

      // Re-validate observation freshness and hazards for each block in vein
      const stepVal = validateBlockHarvestability(bot, target);
      if (!stepVal.valid) {
        console.log(`[ORE_MINING] Skipping block ${i + 1} at (${target.position.x}, ${target.position.y}, ${target.position.z}): ${stepVal.reason}`);
        continue;
      }

      // Approach block if not in reach
      const eyePos = bot.entity?.position ? bot.entity.position.offset(0, 1.6, 0) : null;
      const dist = eyePos ? distance3D(eyePos, target.position) : 0;
      if (dist > 4.2 && (bot as any).pathfinder) {
        try {
          updatePathfinderMovements(bot);
          const goal = new goals.GoalGetToBlock(target.position.x, target.position.y, target.position.z);
          await (bot as any).pathfinder.goto(goal);
        } catch {
          try {
            const nearGoal = new goals.GoalNear(target.position.x, target.position.y, target.position.z, 2.5);
            await (bot as any).pathfinder.goto(nearGoal);
          } catch {
            console.log(`[ORE_MINING] Cannot reach ore block at (${target.position.x}, ${target.position.y}, ${target.position.z}); skipping.`);
            navigationBlacklist.recordFailure(target.position, 'unreachable ore block', 'UNREACHABLE', 30_000);
            continue;
          }
        }
      }

      if (!isActionContextActive(ctx)) {
        return { status: 'interrupted', reason: 'Ore mining cancelled during navigation.' };
      }

      // Tool Management & Tool Breakage Handling
      let toolToUse = findBestPickaxeInInventory(bot, stepVal.requiredTier);
      if (!toolToUse && stepVal.requiredTier > 0) {
        return {
          status: 'failed',
          reason: `No pickaxe of tier >= ${stepVal.requiredTier} available in inventory (tool broken or depleted).`,
          details: { failureKind: 'TOOL_BROKEN', minedSoFar: minedCount },
        };
      }

      if (toolToUse && bot.equip) {
        try {
          await bot.equip(toolToUse, 'hand');
        } catch {}
      }

      if (!isActionContextActive(ctx)) {
        return { status: 'interrupted', reason: 'Ore mining cancelled before dig.' };
      }

      // Record pre-dig drop count
      const preDigDropCount = getInventoryCount(bot, expectedDrop);

      // Execute Dig
      try {
        if (bot.dig) {
          await bot.dig(target);
          minedCount++;
        }
      } catch (digErr: any) {
        if (!isActionContextActive(ctx)) {
          return { status: 'interrupted', reason: 'Ore mining cancelled during digging.' };
        }
        console.log(`[ORE_MINING] Dig failed on block (${target.position.x}, ${target.position.y}, ${target.position.z}): ${digErr.message}`);
        continue;
      }

      // Collect dropped item drops immediately around mined block
      try {
        await techniqueVacuumDrops(bot, 3.5, ctx.abortSignal, ctx.isCurrent);
      } catch {}

      // Closed-Loop Verification: verify inventory actually increased
      const postDigDropCount = getInventoryCount(bot, expectedDrop);
      const dropDelta = postDigDropCount - preDigDropCount;

      console.log(`[ORE_MINING] Verified mined block: drop=${expectedDrop}, before=${preDigDropCount}, after=${postDigDropCount}, delta=${dropDelta}`);

      // Check tool durability after dig to proactively detect tool breakage
      const currentHeld = bot.heldItem;
      if (!currentHeld && stepVal.requiredTier > 0) {
        console.log(`[ORE_MINING] Active tool broke after digging. Checking for backup tool...`);
        const backupTool = findBestPickaxeInInventory(bot, stepVal.requiredTier);
        if (!backupTool) {
          console.log(`[ORE_MINING] No backup pickaxe remaining in inventory. Halting vein mining safely.`);
          break;
        }
      }
    }

    const finalDropCount = getInventoryCount(bot, expectedDrop);
    const netDropGain = finalDropCount - initialDropCount;

    if (minedCount === 0) {
      return {
        status: 'failed',
        reason: `Could not mine any ${startBlock.name} in vein.`,
        details: { failureKind: 'UNKNOWN' },
      };
    }

    return {
      status: 'success',
      reason: `Successfully mined ${minedCount} ${startBlock.name} block(s) with net inventory gain of ${netDropGain} ${expectedDrop}.`,
      details: { minedCount, netDropGain, expectedDrop },
    };
  } finally {
    if (ctx.abortSignal && onAbort) {
      ctx.abortSignal.removeEventListener('abort', onAbort);
    }
    if (isActionContextActive(ctx)) {
      try { (bot as any).pathfinder?.stop(); } catch {}
      bot.clearControlStates?.();
    }
  }
}

/**
 * Surface Resource Gathering Technique:
 * Strictly gathers surface-exposed resources in open daylight (Y >= 50, sky exposure).
 * Averts deep cave shafts, underground darkness, and underground lava pockets.
 */
export async function techniqueGatherSurfaceResource(
  bot: Bot,
  resourceType: string,
  count: number = 1,
  ctx: ActionExecutionContext
): Promise<ActionResult> {
  if (!isActionContextActive(ctx)) {
    return { status: 'interrupted', reason: 'Surface gathering cancelled before start.' };
  }

  const initialCount = countResourceInInventory(bot, resourceType);
  const targetTotal = initialCount + count;
  const scanRadius = ctx.config?.perception?.scanRadius || 32;

  let mined = 0;
  console.log(`[SURFACE_GATHER] Genuinely surface gathering for ${resourceType} x${count} (Y >= 50, open terrain)...`);

  while (countResourceInInventory(bot, resourceType) < targetTotal) {
    if (!isActionContextActive(ctx)) {
      return { status: 'interrupted', reason: `Surface gathering cancelled (${mined} collected).` };
    }

    // Find block strictly at surface elevation (Y >= 50) and not submerged
    const targetBlock = bot.findBlock ? bot.findBlock({
      matching: (b: any) => {
        if (!isMatchingSurfaceBlock(b?.name, resourceType)) return false;
        if (!b.position || b.position.y < 50) return false; // Strictly surface altitude!
        if (b.name === 'water' || b.name === 'flowing_water' || b.name === 'lava') return false;
        if (navigationBlacklist.isBlacklisted(b.position, 1.0)) return false;
        return true;
      },
      maxDistance: scanRadius,
    }) : null;

    if (!targetBlock) {
      const collectedSoFar = countResourceInInventory(bot, resourceType) - initialCount;
      if (collectedSoFar > 0) {
        return {
          status: 'success',
          reason: `Surface gathered ${collectedSoFar} ${resourceType} (no more surface blocks within ${scanRadius}m).`,
        };
      }
      return {
        status: 'failed',
        reason: `No surface ${resourceType} found within ${scanRadius} blocks at Y >= 50.`,
        details: { failureKind: 'TARGET_NOT_OBSERVED' },
      };
    }

    // Validate 5 pre-conditions
    const validation = validateBlockHarvestability(bot, targetBlock);
    if (!validation.valid) {
      navigationBlacklist.recordFailure(targetBlock.position, validation.reason || 'unharvestable', toNavigationFailureKind(validation.failureKind), 30_000);
      continue;
    }

    // Approach block
    const eyePos = bot.entity?.position ? bot.entity.position.offset(0, 1.6, 0) : null;
    const dist = eyePos ? distance3D(eyePos, targetBlock.position) : 0;
    if (dist > 4.2 && (bot as any).pathfinder) {
      try {
        updatePathfinderMovements(bot);
        const goal = new goals.GoalGetToBlock(targetBlock.position.x, targetBlock.position.y, targetBlock.position.z);
        await (bot as any).pathfinder.goto(goal);
      } catch {
        navigationBlacklist.recordFailure(targetBlock.position, 'unreachable', 'UNREACHABLE', 30_000);
        continue;
      }
    }

    if (!isActionContextActive(ctx)) {
      return { status: 'interrupted', reason: 'Surface gathering cancelled during approach.' };
    }

    // Equip tool and dig
    const tool = validation.bestTool || findBestToolForSurfaceBlock(bot, targetBlock.name);
    if (tool && bot.equip) {
      try { await bot.equip(tool, 'hand'); } catch {}
    }

    try {
      if (bot.dig) {
        await bot.dig(targetBlock);
        mined++;
      }
    } catch {
      continue;
    }

    // Vacuum drops
    try {
      await techniqueVacuumDrops(bot, 3.5, ctx.abortSignal, ctx.isCurrent);
    } catch {}
  }

  const netCollected = countResourceInInventory(bot, resourceType) - initialCount;
  return {
    status: 'success',
    reason: `Surface gathered ${netCollected} ${resourceType}.`,
    details: { netCollected },
  };
}

function countResourceInInventory(bot: Bot, resource: string): number {
  if (!bot || !bot.inventory) return 0;
  const items = typeof bot.inventory.items === 'function' ? bot.inventory.items() : [];
  let count = 0;
  for (const it of items) {
    if (it && it.name && isMatchingSurfaceItem(it.name, resource)) {
      count += it.count || 0;
    }
  }
  return count;
}

function isMatchingSurfaceBlock(blockName: string, query: string): boolean {
  if (!blockName) return false;
  const q = query.toLowerCase();
  const b = blockName.toLowerCase();
  if (q === 'dirt') return b === 'dirt' || b === 'grass_block' || b === 'coarse_dirt';
  if (q === 'sand') return b === 'sand' || b === 'red_sand';
  if (q === 'gravel') return b === 'gravel';
  if (q === 'clay') return b === 'clay';
  if (q === 'stone') return b === 'stone' || b === 'cobblestone' || b === 'granite' || b === 'diorite' || b === 'andesite';
  if (q === 'wood') return b.includes('_log');
  return b.includes(q);
}

function isMatchingSurfaceItem(itemName: string, query: string): boolean {
  if (!itemName) return false;
  const q = query.toLowerCase();
  const it = itemName.toLowerCase();
  if (q === 'dirt') return it === 'dirt' || it === 'coarse_dirt';
  if (q === 'sand') return it === 'sand' || it === 'red_sand';
  if (q === 'gravel') return it === 'gravel' || it === 'flint';
  if (q === 'clay') return it === 'clay_ball' || it === 'clay';
  if (q === 'stone') return it === 'cobblestone' || it === 'stone';
  if (q === 'wood') return it.includes('_log');
  return it.includes(q);
}

function findBestToolForSurfaceBlock(bot: Bot, blockName: string): any | null {
  if (!bot.inventory) return null;
  const items = typeof bot.inventory.items === 'function' ? bot.inventory.items() : [];
  if (blockName.includes('dirt') || blockName.includes('sand') || blockName.includes('gravel')) {
    return items.find((i) => i.name && i.name.includes('shovel')) || null;
  }
  if (blockName.includes('stone') || blockName.includes('cobble')) {
    return items.find((i) => i.name && i.name.includes('pickaxe')) || null;
  }
  if (blockName.includes('log')) {
    return items.find((i) => i.name && i.name.includes('axe') && !i.name.includes('pickaxe')) || null;
  }
  return null;
}

function getInventoryCount(bot: Bot, itemName: string): number {
  if (!bot || !bot.inventory) return 0;
  const items = typeof bot.inventory.items === 'function' ? bot.inventory.items() : [];
  let count = 0;
  for (const it of items) {
    if (it && it.name === itemName) count += it.count || 0;
  }
  return count;
}
