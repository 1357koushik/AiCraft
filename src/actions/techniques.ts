import { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { goals, Movements } from 'mineflayer-pathfinder';
import { ActionResult, ActionExecutionContext } from '../types/index.js';
import { distance3D } from '../utils/math.js';
import { navigationBlacklist } from './blacklist.js';
import { workstationRegistry } from './workstations.js';
import { ClosedLoopCraftingExecutor } from './crafting.js';
import { techniqueBuildVerifiedShelter } from './shelter.js';

export const SAFE_SCAFFOLD_ITEMS = new Set([
  'dirt',
  'coarse_dirt',
  'rooted_dirt',
  'cobblestone',
  'cobbled_deepslate',
  'mossy_cobblestone',
  'stone',
  'smooth_stone',
  'netherrack',
  'basalt',
  'blackstone',
  'oak_planks',
  'spruce_planks',
  'birch_planks',
  'jungle_planks',
  'acacia_planks',
  'dark_oak_planks',
  'mangrove_planks',
  'cherry_planks',
  'bamboo_planks',
  'pale_oak_planks',
  'sandstone',
  'red_sandstone',
  'andesite',
  'diorite',
  'granite',
  'deepslate',
  'tuff',
  'mud_bricks',
]);

/**
 * Validates whether an inventory item is a safe, solid, non-gravity, non-valuable building block.
 */
export function isSafeScaffoldingItem(item: any, bot?: Bot): boolean {
  if (!item || !item.name) return false;
  if (!SAFE_SCAFFOLD_ITEMS.has(item.name)) return false;
  const block = bot?.registry?.blocksByName?.[item.name];
  if (block && block.boundingBox !== 'block') return false;
  return true;
}

/**
 * Dynamically updates the pathfinder Movements instance with blocks currently in inventory,
 * enabling automatic 1x1 tower pillaring, bridging across gaps, and digging obstacles.
 */
export function updatePathfinderMovements(bot: Bot, options?: { allowPillaring?: boolean }): Movements | null {
  if (!bot || !(bot as any).pathfinder || !bot.registry) return null;
  let move: Movements = (bot as any).pathfinder?.movements;
  if (!move) {
    try {
      move = new Movements(bot);
      (bot as any).pathfinder.setMovements(move);
    } catch {
      return null;
    }
  }

  // 1. Configure safe movement parameters and avoid hazard blocks
  move.canDig = true;
  move.dontMineUnderFallingBlock = true;
  move.dontCreateFlow = true;
  move.maxDropDown = 3; // Never drop > 3 blocks (prevents intentional fall damage)
  move.allowParkour = false; // Strictly forbid parkour jumps over ravines/gaps
  move.allow1by1towers = Boolean(options?.allowPillaring);
  (move as any).liquidCost = 50; // Strongly penalize liquid travel

  const hazardNames = [
    'lava', 'flowing_lava', 'fire', 'soul_fire', 'campfire', 'soul_campfire',
    'magma_block', 'sweet_berry_bush', 'cactus', 'powder_snow', 'wither_rose'
  ];
  if (bot.registry?.blocksByName) {
    for (const h of hazardNames) {
      const b = bot.registry.blocksByName[h];
      if (b) {
        move.blocksToAvoid?.add(b.id);
        move.blocksCantBreak?.add(b.id);
      }
    }

    // Strictly avoid water when on dry land so Pathfinder never routes through water bodies
    const inWater = Boolean((bot.entity as any)?.isInWater);
    const water = bot.registry.blocksByName['water'];
    const flowingWater = bot.registry.blocksByName['flowing_water'];
    if (!inWater) {
      if (water) move.blocksToAvoid?.add(water.id);
      if (flowingWater) move.blocksToAvoid?.add(flowingWater.id);
    } else {
      if (water) move.blocksToAvoid?.delete(water.id);
      if (flowingWater) move.blocksToAvoid?.delete(flowingWater.id);
    }
  }

  // 2. Populate scaffolding blocks from bot inventory using Item IDs (as required by Pathfinder)
  const scaffoldIds: number[] = [];
  if (bot.inventory) {
    for (const item of bot.inventory.items()) {
      if (isSafeScaffoldingItem(item, bot)) {
        // Pathfinder matches item.type directly in inventory
        if (!scaffoldIds.includes(item.type)) {
          scaffoldIds.push(item.type);
        }
      }
    }
  }

  (move as any).scafoldingBlocks = scaffoldIds;
  return move;
}

/**
 * Finds any available placeable scaffolding block in inventory.
 */
export function getScaffoldingItem(bot: Bot): any {
  if (!bot.inventory) return null;
  return bot.inventory.items().find((it) => isSafeScaffoldingItem(it, bot));
}

/**
 * Technique: Pillar Jump
 * Jumps and places blocks directly beneath feet to gain height.
 * Accurately verifies placement and restores pitch/yaw and controls.
 */
export async function techniquePillarUp(
  bot: Bot,
  height: number = 3,
  abortSignal?: AbortSignal,
  isCurrent?: () => boolean
): Promise<ActionResult> {
  const targetHeight = Math.min(Math.max(height, 1), 12);
  let placed = 0;
  const originalPitch = bot.entity?.pitch ?? 0;
  const originalYaw = bot.entity?.yaw ?? 0;

  try {
    for (let i = 0; i < targetHeight; i++) {
      if (abortSignal?.aborted || (isCurrent && !isCurrent())) {
        return { status: 'interrupted', reason: 'Pillar up cancelled by preemption signal.' };
      }

      const blockItem = getScaffoldingItem(bot);
      if (!blockItem) {
        return {
          status: placed > 0 ? 'success' : 'failed',
          reason: `Ran out of scaffolding blocks after pillaring ${placed} blocks.`,
        };
      }

      await bot.equip(blockItem, 'hand');

      const startPos = bot.entity.position.clone();
      const groundPos = bot.entity.position.floored().offset(0, -1, 0);
      const groundBlock = bot.blockAt(groundPos);

      if (!groundBlock || groundBlock.boundingBox !== 'block') {
        return { status: 'failed', reason: 'No solid block beneath to jump from.' };
      }

      // Check headroom before jumping: 2 blocks above feet must not be obstructed
      const ceilingPos = startPos.floored().offset(0, 2, 0);
      const ceilingBlock = bot.blockAt(ceilingPos);
      if (ceilingBlock && ceilingBlock.boundingBox === 'block') {
        return {
          status: placed > 0 ? 'success' : 'failed',
          reason: `Pillaring halted: ceiling obstruction directly overhead at y=${ceilingPos.y}.`,
        };
      }

      // Target placement coordinate: directly on top of the ground block face
      const targetPlacedPos = groundPos.offset(0, 1, 0);
      const existingAtTarget = bot.blockAt(targetPlacedPos);
      if (existingAtTarget && existingAtTarget.boundingBox === 'block') {
        return {
          status: placed > 0 ? 'success' : 'failed',
          reason: `Pillaring halted: target placement position at ${targetPlacedPos.x}, ${targetPlacedPos.y}, ${targetPlacedPos.z} is already obstructed.`,
        };
      }

      // Look straight down at the ground block (-PI/2 looks DOWN in Mineflayer; +PI/2 looks up at sky)
      await bot.look(bot.entity.yaw, -Math.PI / 2, true);

      // Jump
      bot.setControlState('jump', true);

      // Wait until bot reaches jump apex (height > 1.12)
      let jumped = false;
      for (let t = 0; t < 15; t++) {
        if (abortSignal?.aborted || (isCurrent && !isCurrent())) {
          bot.setControlState('jump', false);
          return { status: 'interrupted', reason: 'Pillar up cancelled during jump apex wait.' };
        }
        await new Promise((res) => setTimeout(res, 30));
        if (bot.entity.position.y - startPos.y > 1.12) {
          jumped = true;
          break;
        }
      }

      bot.setControlState('jump', false);

      if (!jumped) {
        return {
          status: placed > 0 ? 'success' : 'failed',
          reason: `Pillaring halted: jump apex not reached at height ${placed + 1}.`,
        };
      }

      if (abortSignal?.aborted || (isCurrent && !isCurrent())) {
        return { status: 'interrupted', reason: 'Pillar up cancelled before placing block.' };
      }

      try {
        await bot.placeBlock(groundBlock, new Vec3(0, 1, 0));
      } catch {
        // Retry once if elevation is maintained and scaffolding item is active
        try {
          await new Promise((res) => setTimeout(res, 80));
          if (bot.entity.position.y - startPos.y >= 0.9) {
            const retryItem = getScaffoldingItem(bot);
            if (retryItem) {
              await bot.equip(retryItem, 'hand');
              await bot.placeBlock(groundBlock, new Vec3(0, 1, 0));
            }
          }
        } catch {}
      }

      // Post-placement verification: verify the block appeared at exact targetPlacedPos
      const placedBlock = bot.blockAt(targetPlacedPos);
      if (!placedBlock || placedBlock.boundingBox !== 'block' || placedBlock.name === 'air') {
        return {
          status: placed > 0 ? 'success' : 'failed',
          reason: `Pillaring halted: placement could not be verified at height ${placed + 1}.`,
        };
      }

      // Wait for physics settlement and verify elevation gain
      await new Promise((res) => setTimeout(res, 180));
      if (bot.entity.position.y - startPos.y < 0.85) {
        return {
          status: placed > 0 ? 'success' : 'failed',
          reason: `Pillaring halted: bot failed to gain elevation after placement at height ${placed + 1}.`,
        };
      }

      placed++;
    }
  } finally {
    const isCancelled = Boolean(abortSignal?.aborted || (isCurrent && !isCurrent()));
    if (!isCancelled) {
      try {
        bot.setControlState?.('jump', false);
        bot.clearControlStates?.();
        bot.deactivateItem?.();
      } catch {}
      try {
        // Restore original camera orientation
        await bot.look?.(originalYaw, originalPitch, true);
      } catch {}
    }
  }

  return { status: 'success', reason: `Successfully pillared up ${placed} blocks.` };
}

/**
 * Technique: Safe Sneak-Bridging
 * Crouches (sneak) to prevent falling off cliffs and extends a bridge across open air.
 * Strictly verifies block placement before moving forward and restores controls on completion.
 */
export async function techniqueBridge(
  bot: Bot,
  direction: 'north' | 'south' | 'east' | 'west' | 'forward',
  distance: number = 4,
  abortSignal?: AbortSignal,
  isCurrent?: () => boolean
): Promise<ActionResult> {
  const steps = Math.min(Math.max(distance, 1), 16);
  let resolvedDir = direction;
  const originalPitch = bot.entity?.pitch ?? 0;
  const originalYaw = bot.entity?.yaw ?? 0;

  if (direction === 'forward') {
    const yaw = bot.entity.yaw;
    let normYaw = yaw % (2 * Math.PI);
    if (normYaw < 0) normYaw += 2 * Math.PI;
    const deg = (normYaw * 180) / Math.PI;
    if (deg >= 45 && deg < 135) resolvedDir = 'west';
    else if (deg >= 135 && deg < 225) resolvedDir = 'south';
    else if (deg >= 225 && deg < 315) resolvedDir = 'east';
    else resolvedDir = 'north';
  }

  let dirVec = new Vec3(0, 0, -1);
  let faceVec = new Vec3(0, 0, -1);
  if (resolvedDir === 'north') {
    dirVec = new Vec3(0, 0, -1);
    faceVec = new Vec3(0, 0, -1);
  } else if (resolvedDir === 'south') {
    dirVec = new Vec3(0, 0, 1);
    faceVec = new Vec3(0, 0, 1);
  } else if (resolvedDir === 'east') {
    dirVec = new Vec3(1, 0, 0);
    faceVec = new Vec3(1, 0, 0);
  } else if (resolvedDir === 'west') {
    dirVec = new Vec3(-1, 0, 0);
    faceVec = new Vec3(-1, 0, 0);
  }

  // Verify inventory upfront
  const scaffoldInitial = getScaffoldingItem(bot);
  if (!scaffoldInitial) {
    return { status: 'failed', reason: 'No scaffolding blocks in inventory to bridge.' };
  }

  // Engage sneak so the bot CANNOT fall off the ledge!
  bot.setControlState('sneak', true);
  let placed = 0;

  try {
    for (let i = 0; i < steps; i++) {
      if (abortSignal?.aborted || (isCurrent && !isCurrent())) {
        return { status: 'interrupted', reason: 'Bridging cancelled by abort signal / preemption.' };
      }

      const scaffoldItem = getScaffoldingItem(bot);
      if (!scaffoldItem) {
        break;
      }
      await bot.equip(scaffoldItem, 'hand');

      const currentFeet = bot.entity.position.floored();
      const currentGround = bot.blockAt(currentFeet.offset(0, -1, 0));
      const targetGroundPos = currentFeet.offset(dirVec.x, -1, dirVec.z);
      const targetGroundBlock = bot.blockAt(targetGroundPos);

      if (!currentGround || currentGround.boundingBox !== 'block') {
        return { status: 'failed', reason: 'No solid block under feet to bridge from.' };
      }

      if (abortSignal?.aborted || (isCurrent && !isCurrent())) {
        return { status: 'interrupted', reason: 'Bridging cancelled before placement.' };
      }

      // If gap ahead is open air or non-solid, place block against current ground face
      if (!targetGroundBlock || targetGroundBlock.name === 'air' || targetGroundBlock.boundingBox !== 'block') {
        await bot.lookAt(currentGround.position.offset(0.5 + dirVec.x * 0.4, 0.5, 0.5 + dirVec.z * 0.4), true);

        try {
          await bot.placeBlock(currentGround, faceVec);
        } catch {
          // Placement failed against the ledge face; do not attempt invalid top-face placement inside bot hitbox
        }

        // Post-placement verification: Confirm block actually appeared and is solid before stepping!
        const verifyBlock = bot.blockAt(targetGroundPos);
        if (!verifyBlock || verifyBlock.name === 'air' || verifyBlock.boundingBox !== 'block') {
          return {
            status: placed > 0 ? 'success' : 'failed',
            reason: `Bridging halted: block placement could not be verified at ${targetGroundPos.x}, ${targetGroundPos.y}, ${targetGroundPos.z}.`,
          };
        }
        placed++;
      }

      if (abortSignal?.aborted || (isCurrent && !isCurrent())) {
        return { status: 'interrupted', reason: 'Bridging cancelled before step forward.' };
      }

      // Pre-movement clearance check: ensure destination foot and head spaces are clear and safe
      const targetFeetPos = currentFeet.offset(dirVec.x, 0, dirVec.z);
      const targetHeadPos = currentFeet.offset(dirVec.x, 1, dirVec.z);
      const bFeet = bot.blockAt(targetFeetPos);
      const bHead = bot.blockAt(targetHeadPos);

      if (bFeet?.boundingBox === 'block' || bHead?.boundingBox === 'block') {
        return {
          status: placed > 0 ? 'success' : 'failed',
          reason: `Bridging halted: destination space obstructed at ${targetFeetPos.x}, ${targetFeetPos.y}, ${targetFeetPos.z}.`,
        };
      }

      if (
        bFeet?.name === 'lava' ||
        bFeet?.name === 'flowing_lava' ||
        bFeet?.name === 'fire' ||
        bHead?.name === 'lava' ||
        bHead?.name === 'flowing_lava'
      ) {
        return {
          status: placed > 0 ? 'success' : 'failed',
          reason: `Bridging halted: hazard detected in destination space.`,
        };
      }

      // Re-verify support block beneath destination before stepping onto it
      const groundBeforeStep = bot.blockAt(targetGroundPos);
      if (!groundBeforeStep || groundBeforeStep.boundingBox !== 'block') {
        return {
          status: placed > 0 ? 'success' : 'failed',
          reason: `Bridging halted: support block missing at ${targetGroundPos.x}, ${targetGroundPos.y}, ${targetGroundPos.z}.`,
        };
      }

      // Step forward onto the verified new block while remaining crouched
      bot.setControlState('forward', true);
      await new Promise((res) => setTimeout(res, 400));
      bot.setControlState('forward', false);
      await new Promise((res) => setTimeout(res, 100));
    }
  } finally {
    const isCancelled = Boolean(abortSignal?.aborted || (isCurrent && !isCurrent()));
    if (!isCancelled) {
      try {
        bot.setControlState?.('sneak', false);
        bot.clearControlStates?.();
        bot.deactivateItem?.();
        await bot.look?.(originalYaw, originalPitch, true);
      } catch {}
    }
  }

  return {
    status: placed > 0 ? 'success' : 'failed',
    reason: `Bridged ${placed} blocks ${resolvedDir}.`,
  };
}

/**
 * Technique: Vacuum Nearby Drops
 * Walks to and collects all dropped items in a radius.
 */
export async function techniqueVacuumDrops(
  bot: Bot,
  radius: number = 10,
  abortSignal?: AbortSignal,
  isCurrent?: () => boolean
): Promise<ActionResult> {
  const botPos = bot.entity?.position;
  if (!botPos) return { status: 'failed', reason: 'Bot position unavailable for vacuum drops.' };

  // Check inventory capacity
  if (bot.inventory) {
    const emptySlots = typeof bot.inventory.emptySlotCount === 'function' ? bot.inventory.emptySlotCount() : 36;
    if (emptySlots === 0) {
      console.log('[VACUUM_DROPS] Inventory is full; skipping vacuum drops.');
      return { status: 'failed', reason: 'Cannot vacuum drops: inventory is completely full.' };
    }
  }

  const items = Object.values(bot.entities || {}).filter((e) => {
    if (!e || (e.name !== 'item' && (e.type as string) !== 'item')) return false;
    if (!e.position) return false;
    // Skip drops in blacklist
    if (navigationBlacklist.isBlacklisted(e.position, 1.0)) return false;
    // Only target drops within reasonable vertical range (not high in canopy or deep in ravine)
    if (Math.abs(e.position.y - botPos.y) > 3.0) return false;
    // Do not dive into deep water or hazardous lava/fire to retrieve drops
    if (bot.blockAt) {
      const b = bot.blockAt(e.position);
      const ab = bot.blockAt(e.position.offset(0, 1, 0));
      if (b?.name === 'lava' || b?.name === 'flowing_lava' || b?.name === 'fire') return false;
      if (ab?.name === 'lava' || ab?.name === 'flowing_lava' || ab?.name === 'fire') return false;
      if (b?.name === 'water' && ab?.name === 'water') return false;
    }
    return distance3D(botPos, e.position) <= radius;
  });

  if (items.length === 0) {
    return { status: 'success', reason: 'No dropped items nearby to collect.' };
  }

  // Sort items so closest are collected first
  items.sort((a, b) => distance3D(botPos, a.position) - distance3D(botPos, b.position));

  console.log(`[VACUUM_DROPS] Found ${items.length} dropped item(s) within ${radius}m. Collecting...`);
  updatePathfinderMovements(bot);
  let collected = 0;
  const vacuumDeadline = Date.now() + 6000; // Hard bounded window for drop collection

  try {
    for (const it of items.slice(0, 8)) {
      if (abortSignal?.aborted || (isCurrent && !isCurrent()) || Date.now() > vacuumDeadline) {
        break;
      }
      // If item entity was already picked up or despawned, skip
      if (!bot.entities[it.id]) {
        collected++;
        continue;
      }
      // If already within player pickup radius (1.5m), brief pause to let server pick it up
      const currDist = bot.entity?.position ? distance3D(bot.entity.position, it.position) : 999;
      if (currDist <= 1.5) {
        collected++;
        continue;
      }

      try {
        const goal = new goals.GoalNear(it.position.x, it.position.y, it.position.z, 1.2);
        await Promise.race([
          (bot as any).pathfinder.goto(goal),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Vacuum step timeout')), 1800)),
        ]);
        collected++;
      } catch {
        try {
          (bot as any).pathfinder?.stop();
        } catch {}
        if (abortSignal?.aborted || (isCurrent && !isCurrent())) {
          return { status: 'interrupted', reason: 'Vacuum drops cancelled during navigation.' };
        }
      }
    }
  } finally {
    const isCancelled = Boolean(abortSignal?.aborted || (isCurrent && !isCurrent()));
    if (!isCancelled) {
      try {
        (bot as any).pathfinder?.stop();
      } catch {}
      try {
        bot.clearControlStates?.();
      } catch {}
    }
  }

  console.log(`[VACUUM_DROPS] Successfully vacuumed ${collected} drop item(s).`);
  return { status: 'success', reason: `Vacuumed ${collected} dropped items.` };
}

export const failedTreeBlacklist = new Map<string, number>();

export function clearFailedTreeBlacklist(): void {
  failedTreeBlacklist.clear();
  navigationBlacklist.clear();
}

export function isLogBlockName(blockName: string, requestedLogType?: string): boolean {
  if (!blockName) return false;
  if (!blockName.endsWith('_log') && !blockName.endsWith('_wood')) return false;
  if (requestedLogType && requestedLogType !== 'log' && requestedLogType !== 'wood') {
    const cleanReq = requestedLogType.toLowerCase().replace(/[\s-]+/g, '_');
    return blockName === cleanReq || blockName.includes(cleanReq);
  }
  return true;
}

export function isLogItemName(itemName: string, requestedLogType?: string): boolean {
  if (!itemName) return false;
  if (!itemName.endsWith('_log') && !itemName.endsWith('_wood')) return false;
  if (requestedLogType && requestedLogType !== 'log' && requestedLogType !== 'wood') {
    const cleanReq = requestedLogType.toLowerCase().replace(/[\s-]+/g, '_');
    return itemName === cleanReq || itemName.includes(cleanReq);
  }
  return true;
}

export function countMatchingLogsInInventory(bot: Bot, requestedLogType?: string): number {
  if (!bot || !bot.inventory) return 0;
  const items = typeof bot.inventory.items === 'function' ? bot.inventory.items() : [];
  let total = 0;
  for (const it of items) {
    if (it && it.name && isLogItemName(it.name, requestedLogType)) {
      total += it.count || 0;
    }
  }
  return total;
}

export async function autoEquipBestAxe(bot: Bot): Promise<void> {
  if (!bot.inventory || !bot.equip) return;
  const items = typeof bot.inventory.items === 'function' ? bot.inventory.items() : [];
  const axes = items.filter((i) => i.name && i.name.endsWith('_axe'));
  if (axes.length === 0) return;

  const tierOrder = ['netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'golden_axe', 'wooden_axe'];
  axes.sort((a, b) => {
    const idxA = tierOrder.indexOf(a.name);
    const idxB = tierOrder.indexOf(b.name);
    return (idxA === -1 ? 99 : idxA) - (idxB === -1 ? 99 : idxB);
  });

  const bestAxe = axes[0];
  if (bestAxe && bot.heldItem?.type !== bestAxe.type) {
    try {
      await bot.equip(bestAxe, 'hand');
    } catch {}
  }
}

export function findConnectedTreeLogs(bot: Bot, startLog: any, maxLogs: number = 16): any[] {
  if (!startLog || !startLog.position) return [];
  const queue: any[] = [startLog];
  const visited = new Set<string>();
  const startKey = `${Math.floor(startLog.position.x)},${Math.floor(startLog.position.y)},${Math.floor(startLog.position.z)}`;
  visited.add(startKey);
  const discoveredLogs: any[] = [startLog];

  while (queue.length > 0 && discoveredLogs.length < maxLogs) {
    const current = queue.shift();
    const cPos = current.position;

    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dy = -2; dy <= 2; dy++) {
          if (dx === 0 && dy === 0 && dz === 0) continue;
          const nx = Math.floor(cPos.x + dx);
          const ny = Math.floor(cPos.y + dy);
          const nz = Math.floor(cPos.z + dz);
          const key = `${nx},${ny},${nz}`;
          if (visited.has(key)) continue;
          visited.add(key);

          const neighborBlock = typeof bot.blockAt === 'function' ? bot.blockAt(new Vec3(nx, ny, nz)) : null;
          if (neighborBlock && isLogBlockName(neighborBlock.name)) {
            discoveredLogs.push(neighborBlock);
            queue.push(neighborBlock);
            if (discoveredLogs.length >= maxLogs) break;
          }
        }
        if (discoveredLogs.length >= maxLogs) break;
      }
      if (discoveredLogs.length >= maxLogs) break;
    }
  }

  // Sort from base to top (lowest Y first)
  discoveredLogs.sort((a, b) => a.position.y - b.position.y);
  return discoveredLogs;
}

/**
 * Resolves any log block belonging to a tree downward to its true base trunk log.
 * Ensures pathfinding and harvesting approach the ground trunk rather than airborne canopy.
 */
export function resolveTreeBaseLog(bot: Bot, candidateLog: any): any {
  if (!candidateLog || !candidateLog.position) return candidateLog;
  const connected = findConnectedTreeLogs(bot, candidateLog, 16);
  if (connected && connected.length > 0) {
    return connected[0];
  }
  return candidateLog;
}

/**
 * Technique: Autonomous Full Tree Harvester
 * Automatically navigates to nearest tree, clears leaves in the way, chops logs
 * from base to top, towers up with pillar jumps if logs are out of reach,
 * cleans up scaffolding, and vacuums dropped saplings/wood.
 * Supports multi-tree harvesting when options.count is provided.
 */
export async function techniqueChopTreeFull(
  bot: Bot,
  scanRadius: number = 16,
  abortSignal?: AbortSignal,
  isCurrent?: () => boolean,
  options?: { count?: number; logType?: string }
): Promise<ActionResult> {
  updatePathfinderMovements(bot);

  const isMultiTree = typeof options?.count === 'number' && options.count > 1;
  const requestedCount = typeof options?.count === 'number' && options.count > 0 ? options.count : 1;
  const initialLogs = countMatchingLogsInInventory(bot, options?.logType);
  const targetTotal = initialLogs + requestedCount;
  const effectiveRadius = Math.max(scanRadius, 48);

  const isPositionBlacklisted = (pos: { x: number; y: number; z: number }) => {
    if (!pos) return false;
    const key = `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
    const exp = failedTreeBlacklist.get(key);
    if (exp && exp > Date.now()) return true;
    return navigationBlacklist.isBlacklisted(pos, 1.2);
  };

  const findNextTreeCandidate = (): any | null => {
    if (typeof bot.findBlocks === 'function') {
      const positions = bot.findBlocks({
        matching: (b: any) => isLogBlockName(b?.name, options?.logType) && !isPositionBlacklisted(b.position || b),
        maxDistance: effectiveRadius,
        count: 20,
      });

      if (positions && positions.length > 0) {
        const botPos = bot.entity?.position || new Vec3(0, 64, 0);
        positions.sort((a: any, b: any) => {
          const horizA = Math.hypot(botPos.x - a.x, botPos.z - a.z);
          const horizB = Math.hypot(botPos.x - b.x, botPos.z - b.z);
          const elevPenA = Math.max(0, a.y - botPos.y) * 2.5;
          const elevPenB = Math.max(0, b.y - botPos.y) * 2.5;
          return (horizA + elevPenA) - (horizB + elevPenB);
        });

        for (const pos of positions) {
          if (!isPositionBlacklisted(pos)) {
            const blk = typeof bot.blockAt === 'function' ? bot.blockAt(pos) : null;
            if (blk && isLogBlockName(blk.name, options?.logType)) {
              const baseLog = resolveTreeBaseLog(bot, blk);
              if (baseLog && !isPositionBlacklisted(baseLog.position)) {
                return baseLog;
              }
              return blk;
            }
          }
        }
      }
    }

    // Fallback: bot.findBlock
    const fallbackBlock = bot.findBlock ? bot.findBlock({
      matching: (b: any) => isLogBlockName(b?.name, options?.logType) && !isPositionBlacklisted(b?.position || b),
      maxDistance: effectiveRadius,
    }) : null;

    if (fallbackBlock) {
      const baseLog = resolveTreeBaseLog(bot, fallbackBlock);
      if (baseLog && !isPositionBlacklisted(baseLog.position)) {
        return baseLog;
      }
    }

    return fallbackBlock;
  };

  // Check initial candidate availability
  let candidateTree = findNextTreeCandidate();
  if (!candidateTree) {
    console.log(`[CHOP_TREE] No tree logs found within 48 blocks. Explore to find trees.`);
    return {
      status: 'failed',
      reason: 'No tree logs found within 48 blocks. Explore to find trees.',
      details: { failureKind: 'TARGET_NOT_OBSERVED' },
    };
  }

  let totalLogsCut = 0;
  let treesHarvested = 0;
  const maxTrees = isMultiTree ? Math.min(25, Math.ceil(requestedCount / 3) + 8) : 1;

  try {
    while (countMatchingLogsInInventory(bot, options?.logType) < targetTotal && treesHarvested < maxTrees) {
      if (abortSignal?.aborted || (isCurrent && !isCurrent())) {
        return { status: 'interrupted', reason: 'Tree chopping cancelled.' };
      }

      // Check inventory capacity before cutting next tree
      const emptySlots = typeof bot.inventory.emptySlotCount === 'function' ? bot.inventory.emptySlotCount() : 36;
      if (emptySlots === 0) {
        const hasPartialStack = bot.inventory.items().some(
          (it) => isLogItemName(it.name, options?.logType) && it.count < 64
        );
        if (!hasPartialStack) {
          return {
            status: 'failed',
            reason: 'Inventory is full; cannot gather more logs without free slots.',
            details: {
              failureKind: 'INVENTORY_FULL',
              collected: countMatchingLogsInInventory(bot, options?.logType) - initialLogs,
            },
          };
        }
      }

      // If candidateTree was already cut or invalidated, find next candidate
      if (!candidateTree || !candidateTree.position || isPositionBlacklisted(candidateTree.position)) {
        candidateTree = findNextTreeCandidate();
        if (!candidateTree) break; // No more reachable candidate trees in radius
      }

      const logBlock = resolveTreeBaseLog(bot, candidateTree);
      const treeBaseKey = `${Math.floor(logBlock.position.x)},${Math.floor(logBlock.position.y)},${Math.floor(logBlock.position.z)}`;
      console.log(`[CHOP_TREE] Located tree base log ${logBlock.name} at (${logBlock.position.x}, ${logBlock.position.y}, ${logBlock.position.z}). Approaching base...`);

      // 1. Approach tree base
      let approachSucceeded = false;
      try {
        const goal = new goals.GoalGetToBlock(logBlock.position.x, logBlock.position.y, logBlock.position.z);
        await (bot as any).pathfinder.goto(goal);
        approachSucceeded = true;
      } catch {
        try {
          const nearGoal = new goals.GoalNearXZ(logBlock.position.x, logBlock.position.z, 2.5);
          await (bot as any).pathfinder.goto(nearGoal);
          approachSucceeded = true;
        } catch {}
      }

      if (!approachSucceeded) {
        console.log(`[CHOP_TREE] Unreachable tree at (${logBlock.position.x}, ${logBlock.position.y}, ${logBlock.position.z}); blacklisting.`);
        failedTreeBlacklist.set(treeBaseKey, Date.now() + 60000);
        navigationBlacklist.recordFailure(logBlock.position, 'Unreachable tree log', 'UNREACHABLE', 60000);
        candidateTree = null;
        continue;
      }

      if (abortSignal?.aborted || (isCurrent && !isCurrent())) {
        return { status: 'interrupted', reason: 'Tree chopping cancelled after pathfinding.' };
      }

      // 2. Discover connected logs of this tree (bounded BFS)
      const treeLogs = findConnectedTreeLogs(bot, logBlock, 16);
      let pillaredBlocks = 0;
      const initialBotY = bot.entity.position.y;
      let treeLogsCut = 0;

      for (const targetBlock of treeLogs) {
        if (abortSignal?.aborted || (isCurrent && !isCurrent())) break;
        if (!targetBlock?.position) continue;
        if (countMatchingLogsInInventory(bot, options?.logType) >= targetTotal) {
          break;
        }

        // Verify the block is still a log
        const freshBlock = typeof bot.blockAt === 'function' ? bot.blockAt(targetBlock.position) : targetBlock;
        if (!freshBlock || !isLogBlockName(freshBlock.name)) continue;

        // Distance check from bot eye
        const eyePos = bot.entity.position.offset(0, 1.6, 0);
        const dist = distance3D(eyePos, freshBlock.position);
        if (dist > 4.2) {
          // Bounded vertical scaffolding: only pillar if log is directly overhead (horizontal offset <= 1.5)
          // and bot has not exceeded maximum safe pillar cap of 4 blocks
          const horizDist = Math.hypot(bot.entity.position.x - freshBlock.position.x, bot.entity.position.z - freshBlock.position.z);
          if (horizDist <= 1.5 && freshBlock.position.y > bot.entity.position.y && pillaredBlocks < 4) {
            const pillarItem = getScaffoldingItem(bot);
            if (pillarItem) {
              const pRes = await techniquePillarUp(bot, 1, abortSignal, isCurrent);
              if (pRes.status === 'success') pillaredBlocks++;
            }
          }
        }

        if (abortSignal?.aborted || (isCurrent && !isCurrent())) break;

        // Auto equip best axe
        await autoEquipBestAxe(bot);

        if (abortSignal?.aborted || (isCurrent && !isCurrent())) break;

        try {
          await bot.dig(freshBlock);
          treeLogsCut++;
          totalLogsCut++;
          await new Promise((res) => setTimeout(res, 150));
          if (countMatchingLogsInInventory(bot, options?.logType) >= targetTotal) {
            break;
          }
        } catch {
          break;
        }
      }

      // 3. If bot pillared up, dig pillar blocks back down
      while (pillaredBlocks > 0 && bot.entity.position.y > initialBotY + 0.5) {
        if (abortSignal?.aborted || (isCurrent && !isCurrent())) break;
        const blockUnderFeet = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0));
        if (blockUnderFeet && blockUnderFeet.boundingBox === 'block') {
          try {
            await bot.dig(blockUnderFeet);
            pillaredBlocks--;
            await new Promise((res) => setTimeout(res, 200));
          } catch {
            break;
          }
        } else {
          break;
        }
      }

      // 4. Vacuum drops around the harvested tree
      await new Promise((res) => setTimeout(res, 300));
      await techniqueVacuumDrops(bot, 6, abortSignal, isCurrent);

      treesHarvested++;
      candidateTree = null; // Reset for next iteration

      // If single-tree mode, exit after 1 tree
      if (!isMultiTree) {
        break;
      }
    }

    const finalLogs = countMatchingLogsInInventory(bot, options?.logType);
    const collected = finalLogs - initialLogs;

    if (collected >= requestedCount || (!isMultiTree && totalLogsCut > 0)) {
      return {
        status: 'success',
        reason: `Harvested ${collected} logs across ${treesHarvested} tree(s) (total in inventory: ${finalLogs}).`,
        details: {
          initialLogs,
          finalLogs,
          collected,
          requestedCount,
          treesHarvested,
        },
      };
    }

    if (collected > 0) {
      return {
        status: 'success',
        reason: `Harvested ${collected}/${requestedCount} logs (no more reachable trees found).`,
        details: {
          initialLogs,
          finalLogs,
          collected,
          requestedCount,
          treesHarvested,
        },
      };
    }

    return {
      status: totalLogsCut > 0 ? 'success' : 'failed',
      reason: totalLogsCut > 0 ? `Harvested ${totalLogsCut} logs.` : 'Failed to harvest logs from reachable trees.',
      details: { failureKind: 'NO_PROGRESS' },
    };
  } finally {
    const isCancelled = Boolean(abortSignal?.aborted || (isCurrent && !isCurrent()));
    if (!isCancelled) {
      try {
        (bot as any).pathfinder?.stop();
      } catch {}
      try {
        bot.clearControlStates?.();
      } catch {}
    }
  }
}

/**
 * Checks whether a block name matches the requested resource.
 */
export function isMatchingResourceBlock(blockName: string, resource: string): boolean {
  if (!blockName) return false;
  const norm = resource.toLowerCase();
  if (norm === 'wood' || norm === 'log') {
    return blockName.endsWith('_log') || blockName.endsWith('_wood');
  }
  if (norm === 'stone' || norm === 'cobblestone') {
    return [
      'stone',
      'cobblestone',
      'deepslate',
      'cobbled_deepslate',
      'andesite',
      'diorite',
      'granite',
    ].includes(blockName);
  }
  if (norm === 'coal') {
    return blockName === 'coal_ore' || blockName === 'deepslate_coal_ore';
  }
  if (norm === 'iron') {
    return blockName === 'iron_ore' || blockName === 'deepslate_iron_ore';
  }
  if (norm === 'dirt') {
    return blockName === 'dirt' || blockName === 'grass_block';
  }
  if (norm === 'sand') {
    return blockName === 'sand' || blockName === 'red_sand';
  }
  return blockName === norm || blockName.includes(norm);
}

/**
 * Maps a resource name to expected inventory drop names.
 */
export function getExpectedResourceItemNames(resource: string): string[] {
  const norm = resource.toLowerCase();
  if (norm === 'wood' || norm === 'log') {
    return [
      'oak_log',
      'birch_log',
      'spruce_log',
      'jungle_log',
      'acacia_log',
      'dark_oak_log',
      'mangrove_log',
      'cherry_log',
      'pale_oak_log',
    ];
  }
  if (norm === 'stone' || norm === 'cobblestone') {
    return ['cobblestone', 'cobbled_deepslate', 'stone', 'deepslate', 'andesite', 'diorite', 'granite'];
  }
  if (norm === 'coal') {
    return ['coal'];
  }
  if (norm === 'iron') {
    return ['raw_iron', 'iron_ore'];
  }
  if (norm === 'dirt') {
    return ['dirt'];
  }
  if (norm === 'sand') {
    return ['sand', 'red_sand'];
  }
  return [norm];
}

/**
 * Counts total items in bot inventory matching the specified resource.
 */
export function countResourceInInventory(bot: Bot, resource: string): number {
  if (!bot.inventory) return 0;
  const expected = getExpectedResourceItemNames(resource);
  let total = 0;
  for (const item of bot.inventory.items()) {
    if (expected.includes(item.name) || (resource.toLowerCase().includes('wood') && item.name.includes('_log'))) {
      total += item.count;
    }
  }
  return total;
}

/**
 * Automatically equips the best tool in inventory for breaking the specified block.
 */
export async function autoEquipBestToolForBlock(bot: Bot, block: any): Promise<void> {
  if (!bot.inventory || !bot.equip) return;
  const items = bot.inventory.items();
  let bestItem: any = null;
  let fastestTime = Infinity;

  for (const it of items) {
    if (it.name.includes('pickaxe') || (it.name.includes('axe') && !it.name.includes('pickaxe')) || it.name.includes('shovel') || it.name.includes('hoe')) {
      if (block.digTime) {
        try {
          const time = block.digTime(it.type, false, false, false);
          if (time < fastestTime) {
            fastestTime = time;
            bestItem = it;
          }
        } catch {}
      }
    }
  }

  if (!bestItem) {
    if (block.name.includes('stone') || block.name.includes('ore') || block.name.includes('cobble') || block.name.includes('deepslate')) {
      bestItem = items.find((i) => i.name.includes('pickaxe'));
    } else if (block.name.includes('log') || block.name.includes('wood') || block.name.includes('plank')) {
      bestItem = items.find((i) => i.name.includes('axe') && !i.name.includes('pickaxe'));
    } else if (block.name.includes('dirt') || block.name.includes('sand') || block.name.includes('gravel')) {
      bestItem = items.find((i) => i.name.includes('shovel'));
    }
  }

  if (bestItem && bot.heldItem?.type !== bestItem.type) {
    try {
      await bot.equip(bestItem, 'hand');
    } catch {}
  }
}

/**
 * Technique: Autonomous Resource Collector
 * Scans up to 48 blocks for specified resource (wood, stone, coal, iron, dirt),
 * navigates safely, equips the best tool, mines the required quantity, and vacuums drops.
 */
export async function techniqueCollectResource(
  bot: Bot,
  resourceType: string,
  count: number = 1,
  abortSignal?: AbortSignal,
  isCurrent?: () => boolean
): Promise<ActionResult> {
  if (abortSignal?.aborted || (isCurrent && !isCurrent())) {
    return { status: 'interrupted', reason: 'Resource collection cancelled before start.' };
  }

  if (count <= 0) {
    return { status: 'success', reason: `Resource collection requirement already satisfied (count <= 0).` };
  }

  const initialCount = countResourceInInventory(bot, resourceType);
  const targetTotal = initialCount + count;

  // If resource is wood/log, use techniqueChopTreeFull with count option
  if (resourceType === 'wood' || resourceType === 'log' || resourceType.includes('log')) {
    return techniqueChopTreeFull(bot, 48, abortSignal, isCurrent, { count, logType: resourceType });
  }

  updatePathfinderMovements(bot);
  let mined = 0;
  const maxAttempts = count * 5 + 10;
  let attempts = 0;

  console.log(`[COLLECT_RESOURCE] Target: ${resourceType} x${count} | Current inventory: ${initialCount} | Target total: ${targetTotal}`);

  try {
    while (countResourceInInventory(bot, resourceType) < targetTotal && attempts < maxAttempts) {
      if (abortSignal?.aborted || (isCurrent && !isCurrent())) {
        return { status: 'interrupted', reason: `Resource collection cancelled (${mined} mined).` };
      }
      attempts++;

      // Scan up to 48 blocks for matching resource (excluding submerged blocks)
      const targetBlock = bot.findBlock ? bot.findBlock({
        matching: (b: any) => {
          if (!isMatchingResourceBlock(b?.name, resourceType)) return false;
          if (b.name === 'water' || b.name === 'flowing_water') return false;
          if (b.position) {
            const ab = bot.blockAt ? bot.blockAt(b.position.offset(0, 1, 0)) : null;
            if (ab?.name === 'water' || ab?.name === 'flowing_water') return false;
          }
          return true;
        },
        maxDistance: 48,
      }) : null;

      if (!targetBlock || !targetBlock.position) {
        const collectedSoFar = countResourceInInventory(bot, resourceType) - initialCount;
        if (collectedSoFar > 0) {
          console.log(`[COLLECT_RESOURCE] Finished batch: collected ${collectedSoFar} ${resourceType} (no more matching blocks in 48m).`);
          return { status: 'success', reason: `Collected ${collectedSoFar} ${resourceType} (no more matching blocks within 48m).` };
        }
        console.log(`[COLLECT_RESOURCE] No ${resourceType} found within 48 blocks.`);
        return { status: 'failed', reason: `No ${resourceType} found within 48 blocks.` };
      }

      // Check if target block itself is submerged under water
      if (bot.blockAt) {
        const above = bot.blockAt(targetBlock.position.offset(0, 1, 0));
        if (above?.name === 'water' || above?.name === 'flowing_water') {
          continue;
        }
      }

      console.log(`[COLLECT_RESOURCE] Candidate ${targetBlock.name} found at (${targetBlock.position.x}, ${targetBlock.position.y}, ${targetBlock.position.z}). Current inventory: ${countResourceInInventory(bot, resourceType)}/${targetTotal}`);

      // Safety check: Avoid digging the ground block directly beneath feet if dangerous
      const feetPos = bot.entity?.position ? bot.entity.position.floored() : null;
      if (feetPos && targetBlock.position.equals(feetPos.offset(0, -1, 0))) {
        const below = bot.blockAt ? bot.blockAt(targetBlock.position.offset(0, -1, 0)) : null;
        if (!below || below.name === 'lava' || below.name === 'flowing_lava' || below.name === 'air') {
          console.log(`[COLLECT_RESOURCE] Skipping block directly beneath feet to avoid falling.`);
          continue;
        }
      }

      // Check overhead hazards (lava / sand / gravel)
      const overhead = bot.blockAt ? bot.blockAt(targetBlock.position.offset(0, 1, 0)) : null;
      if (overhead && (overhead.name === 'lava' || overhead.name === 'flowing_lava')) {
        console.log(`[COLLECT_RESOURCE] Skipping block under overhead lava.`);
        continue;
      }

      // Navigate to block if > 4m away
      const botEye = bot.entity?.position ? bot.entity.position.offset(0, 1.6, 0) : null;
      const dist = botEye ? distance3D(botEye, targetBlock.position) : 0;
      if (dist > 4.2 && (bot as any).pathfinder) {
        console.log(`[COLLECT_RESOURCE] Walking to block at (${targetBlock.position.x}, ${targetBlock.position.y}, ${targetBlock.position.z}) [dist: ${dist.toFixed(1)}m]...`);
        try {
          const goal = new goals.GoalGetToBlock(targetBlock.position.x, targetBlock.position.y, targetBlock.position.z);
          await (bot as any).pathfinder.goto(goal);
        } catch {
          try {
            const nearGoal = new goals.GoalNear(targetBlock.position.x, targetBlock.position.y, targetBlock.position.z, 2.5);
            await (bot as any).pathfinder.goto(nearGoal);
          } catch {
            continue;
          }
        }
      }

      if (abortSignal?.aborted || (isCurrent && !isCurrent())) {
        return { status: 'interrupted', reason: `Resource collection cancelled after reaching block.` };
      }

      // Auto-equip best tool
      console.log(`[COLLECT_RESOURCE] Equipping best tool to mine ${targetBlock.name}...`);
      await autoEquipBestToolForBlock(bot, targetBlock);

      if (abortSignal?.aborted || (isCurrent && !isCurrent())) {
        return { status: 'interrupted', reason: `Resource collection cancelled before dig.` };
      }

      // Dig the block
      if (bot.dig) {
        try {
          console.log(`[COLLECT_RESOURCE] Digging ${targetBlock.name}...`);
          await bot.dig(targetBlock);
          mined++;
          console.log(`[COLLECT_RESOURCE] Successfully dug ${targetBlock.name}! Mined count: ${mined}`);
        } catch (err: any) {
          console.log(`[COLLECT_RESOURCE] Dig failed: ${err.message}`);
          continue;
        }
      }

      // Short delay for item entity to spawn, then vacuum drops
      await new Promise((res) => setTimeout(res, 250));
      await techniqueVacuumDrops(bot, 6, abortSignal, isCurrent);
    }
  } finally {
    const isCancelled = Boolean(abortSignal?.aborted || (isCurrent && !isCurrent()));
    if (!isCancelled) {
      try {
        (bot as any).pathfinder?.stop();
      } catch {}
      try {
        bot.clearControlStates?.();
        bot.deactivateItem?.();
      } catch {}
    }
  }

  const finalCount = countResourceInInventory(bot, resourceType);
  const collected = finalCount - initialCount;
  if (collected >= count || finalCount >= targetTotal) {
    return { status: 'success', reason: `Collected ${collected} ${resourceType} (inventory has ${finalCount}).` };
  }
  return {
    status: collected > 0 ? 'success' : 'failed',
    reason: collected > 0 ? `Partially collected ${collected}/${count} ${resourceType}.` : `Failed to collect ${resourceType}.`,
  };
}

/**
 * Technique: Staircase Mining
 * Mines a safe forward-descending 1x2 staircase without digging straight down.
 * Performs rigorous multi-point hazard inspection and floor verification before every step.
 */
export async function techniqueMineStaircase(
  bot: Bot,
  steps: number = 6,
  abortSignal?: AbortSignal,
  isCurrent?: () => boolean
): Promise<ActionResult> {
  const count = Math.min(Math.max(steps, 1), 16);
  let dug = 0;

  // Determine cardinal direction from bot's current yaw
  const yaw = bot.entity.yaw;
  let normYaw = yaw % (2 * Math.PI);
  if (normYaw < 0) normYaw += 2 * Math.PI;
  const deg = (normYaw * 180) / Math.PI;
  let dirVec = new Vec3(0, 0, -1);
  if (deg >= 45 && deg < 135) dirVec = new Vec3(-1, 0, 0);
  else if (deg >= 135 && deg < 225) dirVec = new Vec3(0, 0, 1);
  else if (deg >= 225 && deg < 315) dirVec = new Vec3(1, 0, 0);

  try {
    for (let s = 1; s <= count; s++) {
      if (abortSignal?.aborted || (isCurrent && !isCurrent())) {
        return { status: 'interrupted', reason: 'Staircase mining cancelled by abort signal.' };
      }

      const currentFeet = bot.entity.position.floored();
      const stepAhead = currentFeet.offset(dirVec.x, 0, dirVec.z);
      const targetFloorPos = stepAhead.offset(0, -2, 0);

      // 1. Precondition Check: Target floor must exist, be solid, and free of hazards
      const targetFloor = bot.blockAt(targetFloorPos);
      if (targetFloor === null) {
        return {
          status: 'failed',
          reason: `Staircase mining halted: unloaded block data at destination floor (${targetFloorPos.x}, ${targetFloorPos.y}, ${targetFloorPos.z}).`,
        };
      }
      if (targetFloor.name === 'lava' || targetFloor.name === 'flowing_lava') {
        return { status: 'failed', reason: 'Staircase mining halted: lava hazard detected at step floor.' };
      }
      if (targetFloor.name === 'water' || targetFloor.name === 'flowing_water') {
        return { status: 'failed', reason: 'Staircase mining halted: water hazard detected at step floor.' };
      }
      if (targetFloor.name === 'fire' || targetFloor.name === 'magma_block') {
        return { status: 'failed', reason: `Staircase mining halted: hazardous floor block (${targetFloor.name}).` };
      }
      if (targetFloor.boundingBox !== 'block') {
        return {
          status: 'failed',
          reason: `Staircase mining halted: unsupported drop, cave, or void detected beneath step (${targetFloor.name || 'air'}).`,
        };
      }

      // 2. Hazard Check: Overhead falling gravel/sand
      const overhead = bot.blockAt(stepAhead.offset(0, 2, 0));
      if (overhead === null) {
        return { status: 'failed', reason: 'Staircase mining halted: uninspected/unknown overhead block data.' };
      }
      if (overhead.name === 'sand' || overhead.name === 'gravel') {
        return { status: 'failed', reason: 'Staircase mining halted: unstable falling gravel/sand detected overhead.' };
      }

      // 3. Hazard Check: Surrounding liquid/fire hazards
      const surroundingOffsets = [
        stepAhead.offset(0, 1, 0),
        stepAhead,
        stepAhead.offset(0, -1, 0),
        stepAhead.offset(dirVec.x, 0, dirVec.z),
        stepAhead.offset(0, 0, dirVec.x !== 0 ? 1 : 0),
        stepAhead.offset(0, 0, dirVec.x !== 0 ? -1 : 0),
        stepAhead.offset(dirVec.z !== 0 ? 1 : 0, 0, 0),
        stepAhead.offset(dirVec.z !== 0 ? -1 : 0, 0, 0),
      ];

      for (const checkPos of surroundingOffsets) {
        const b = bot.blockAt(checkPos);
        if (b && (b.name === 'lava' || b.name === 'flowing_lava')) {
          return { status: 'failed', reason: 'Staircase mining halted: lava hazard detected ahead.' };
        }
        if (b && (b.name === 'water' || b.name === 'flowing_water')) {
          return { status: 'failed', reason: 'Staircase mining halted: water hazard detected ahead.' };
        }
      }

      // 4. Auto-equip best pickaxe or shovel
      const pickaxe = bot.inventory?.items().find((i) => i.name.includes('pickaxe'));
      if (pickaxe && bot.heldItem?.type !== pickaxe.type) {
        try {
          await bot.equip(pickaxe, 'hand');
        } catch {}
      }

      if (abortSignal?.aborted || (isCurrent && !isCurrent())) {
        return { status: 'interrupted', reason: 'Staircase mining cancelled before digging.' };
      }

      // 5. Dig top block ahead (eye level)
      const blockHead = bot.blockAt(stepAhead.offset(0, 1, 0));
      if (blockHead === null) {
        return { status: 'failed', reason: 'Staircase mining halted: block at eye level is unloaded.' };
      }
      if (blockHead.name === 'bedrock' || blockHead.name === 'barrier') {
        return { status: 'failed', reason: 'Staircase mining halted: unbreakable block encountered.' };
      }
      if (blockHead.name !== 'air') {
        try {
          await bot.dig(blockHead);
          dug++;
        } catch (err: any) {
          return { status: 'failed', reason: `Failed digging block at eye level: ${err.message}` };
        }
      }

      if (abortSignal?.aborted || (isCurrent && !isCurrent())) {
        return { status: 'interrupted', reason: 'Staircase mining cancelled after head block.' };
      }

      // 6. Dig middle block ahead (foot level)
      const blockFeet = bot.blockAt(stepAhead);
      if (blockFeet === null) {
        return { status: 'failed', reason: 'Staircase mining halted: block at foot level is unloaded.' };
      }
      if (blockFeet.name === 'bedrock' || blockFeet.name === 'barrier') {
        return { status: 'failed', reason: 'Staircase mining halted: unbreakable block encountered.' };
      }
      if (blockFeet.name !== 'air') {
        try {
          await bot.dig(blockFeet);
          dug++;
        } catch (err: any) {
          return { status: 'failed', reason: `Failed digging block at foot level: ${err.message}` };
        }
      }

      if (abortSignal?.aborted || (isCurrent && !isCurrent())) {
        return { status: 'interrupted', reason: 'Staircase mining cancelled after foot block.' };
      }

      // 7. Dig ground block ahead (descending step)
      const blockGround = bot.blockAt(stepAhead.offset(0, -1, 0));
      if (blockGround === null) {
        return { status: 'failed', reason: 'Staircase mining halted: ground block is unloaded.' };
      }
      if (blockGround.name === 'bedrock' || blockGround.name === 'barrier') {
        return { status: 'failed', reason: 'Staircase mining halted: unbreakable block encountered.' };
      }
      if (blockGround.name !== 'air') {
        try {
          await bot.dig(blockGround);
          dug++;
        } catch (err: any) {
          return { status: 'failed', reason: `Failed digging ground step: ${err.message}` };
        }
      }

      // 8. Post-dig environment re-check before movement!
      const postHead = bot.blockAt(stepAhead.offset(0, 1, 0));
      const postFeet = bot.blockAt(stepAhead);
      const postFloor = bot.blockAt(targetFloorPos);

      if (
        postHead?.name === 'lava' ||
        postHead?.name === 'flowing_lava' ||
        postFeet?.name === 'lava' ||
        postFeet?.name === 'flowing_lava'
      ) {
        return { status: 'failed', reason: 'Staircase mining halted: lava rushed into newly dug space.' };
      }
      if (
        postHead?.name === 'water' ||
        postHead?.name === 'flowing_water' ||
        postFeet?.name === 'water' ||
        postFeet?.name === 'flowing_water'
      ) {
        return { status: 'failed', reason: 'Staircase mining halted: water rushed into newly dug space.' };
      }
      if (!postFloor || postFloor.boundingBox !== 'block') {
        return { status: 'failed', reason: 'Staircase mining halted: destination floor compromised after mining.' };
      }

      if (abortSignal?.aborted || (isCurrent && !isCurrent())) {
        return { status: 'interrupted', reason: 'Staircase mining cancelled before step down.' };
      }

      // 9. Step down safely onto the new step
      bot.setControlState('forward', true);
      await new Promise((res) => setTimeout(res, 400));
      bot.setControlState('forward', false);
      await new Promise((res) => setTimeout(res, 100));

      // 10. Place torch if dark (every 5 steps)
      if (s % 5 === 0) {
        const torch = bot.inventory?.items().find((i) => i.name === 'torch');
        if (torch) {
          const wallBlock = bot.blockAt(bot.entity.position.floored().offset(0, 1, 0));
          if (wallBlock) {
            try {
              await bot.equip(torch, 'hand');
              await bot.placeBlock(wallBlock, new Vec3(0, 1, 0));
            } catch {}
          }
        }
      }
    }
  } finally {
    const isCancelled = Boolean(abortSignal?.aborted || (isCurrent && !isCurrent()));
    if (!isCancelled) {
      try {
        bot.clearControlStates?.();
        bot.deactivateItem?.();
      } catch {}
    }
  }

  return { status: 'success', reason: `Mined staircase ${count} steps down (${dug} blocks cleared).` };
}

/**
 * Technique: Build Simple Survival Shelter
 * Places a verified 3x3x3 dirt/cobblestone shelter with roof, doorway, and closed-loop enclosure verification.
 */
export async function techniqueBuildShelter(
  bot: Bot,
  abortSignal?: AbortSignal,
  isCurrent?: () => boolean
): Promise<ActionResult> {
  const ctx: Partial<ActionExecutionContext> = {
    bot,
    abortSignal,
    isCurrent: isCurrent || (() => !abortSignal?.aborted),
  };
  return techniqueBuildVerifiedShelter(bot, {}, ctx);
}

/**
 * Finds a safe block position to place a workstation (crafting table, furnace).
 * Scans horizontal and vertical offsets around bot feet; verifies target space is air/passable
 * and block below is solid non-hazard, sorting by proximity.
 */
export function findSafePlacementSpot(bot: Bot): { placePos: Vec3; refBlock: any; placeVector: Vec3 } | null {
  if (!bot.entity || !bot.blockAt) return null;
  const feetPos = bot.entity.position.floored();

  // Tiered offsets:
  // 1. Immediate horizontal adjacent at feet level (dy = 0)
  // 2. Immediate horizontal adjacent 1 block up (dy = 1, e.g. on trench walls / elevated steps)
  // 3. Immediate horizontal adjacent 1 block down (dy = -1, e.g. descending slope)
  // 4. Extended reach at radius 2
  const candidateOffsets: Vec3[] = [
    // dy = 0 cardinals & diagonals
    new Vec3(1, 0, 0),
    new Vec3(0, 0, 1),
    new Vec3(-1, 0, 0),
    new Vec3(0, 0, -1),
    new Vec3(1, 0, 1),
    new Vec3(-1, 0, 1),
    new Vec3(1, 0, -1),
    new Vec3(-1, 0, -1),

    // dy = 1 cardinals & diagonals (elevated ground)
    new Vec3(1, 1, 0),
    new Vec3(0, 1, 1),
    new Vec3(-1, 1, 0),
    new Vec3(0, 1, -1),
    new Vec3(1, 1, 1),
    new Vec3(-1, 1, 1),
    new Vec3(1, 1, -1),
    new Vec3(-1, 1, -1),

    // dy = -1 cardinals & diagonals (sloping ground)
    new Vec3(1, -1, 0),
    new Vec3(0, -1, 1),
    new Vec3(-1, -1, 0),
    new Vec3(0, -1, -1),
    new Vec3(1, -1, 1),
    new Vec3(-1, -1, 1),
    new Vec3(1, -1, -1),
    new Vec3(-1, -1, -1),

    // radius 2 candidates
    new Vec3(2, 0, 0),
    new Vec3(-2, 0, 0),
    new Vec3(0, 0, 2),
    new Vec3(0, 0, -2),
    new Vec3(2, 1, 0),
    new Vec3(-2, 1, 0),
    new Vec3(0, 1, 2),
    new Vec3(0, 1, -2),
  ];

  for (const off of candidateOffsets) {
    const targetPos = feetPos.plus(off);

    // Target position cannot be inside the bot's own column at feet or head level
    if (targetPos.x === feetPos.x && targetPos.z === feetPos.z && (targetPos.y === feetPos.y || targetPos.y === feetPos.y + 1)) {
      continue;
    }

    // Distance check: ensure reachable and not colliding with player body
    const centerTarget = targetPos.offset(0.5, 0.5, 0.5);
    const reachDist = bot.entity.position.distanceTo(centerTarget);
    if (reachDist > 4.2 || reachDist < 0.8) {
      continue;
    }

    const targetBlock = bot.blockAt(targetPos);
    // Target position must be air, cave_air, or passable replaceable non-hazard non-liquid
    if (!targetBlock) continue;
    const isTargetClear =
      targetBlock.name === 'air' ||
      targetBlock.name === 'cave_air' ||
      targetBlock.name === 'void_air' ||
      (targetBlock.boundingBox === 'empty' &&
        targetBlock.name !== 'lava' &&
        targetBlock.name !== 'flowing_lava' &&
        targetBlock.name !== 'water' &&
        targetBlock.name !== 'flowing_water' &&
        targetBlock.name !== 'fire');

    if (!isTargetClear) {
      continue;
    }

    // Reference block below must be solid non-hazard
    const belowPos = targetPos.offset(0, -1, 0);
    const belowBlock = bot.blockAt(belowPos);
    if (!belowBlock || belowBlock.boundingBox !== 'block') {
      continue;
    }
    if (
      belowBlock.name === 'lava' ||
      belowBlock.name === 'flowing_lava' ||
      belowBlock.name === 'fire' ||
      belowBlock.name === 'magma_block' ||
      belowBlock.name === 'cactus' ||
      belowBlock.name === 'sweet_berry_bush'
    ) {
      continue;
    }

    return {
      placePos: targetPos,
      refBlock: belowBlock,
      placeVector: new Vec3(0, 1, 0),
    };
  }

  return null;
}

/**
 * Manages the atomic lifecycle of a workstation (place -> use -> dig teardown -> drop vacuum).
 * Guarantees that placed workstations are never abandoned in the world, preserving survival resources.
 */
export async function withWorkstation<T>(
  bot: Bot,
  workstationType: 'crafting_table' | 'furnace',
  operation: (stationBlock: any) => Promise<T>,
  abortSignal?: AbortSignal,
  isCurrent?: () => boolean
): Promise<T> {
  if (abortSignal?.aborted || (isCurrent && !isCurrent())) {
    throw new Error(`Workstation '${workstationType}' operation cancelled before start.`);
  }

  // 1. Check if station already exists within reach (4.5m)
  let station: any = bot.findBlock ? bot.findBlock({
    matching: (b: any) => b.name === workstationType,
    maxDistance: 4.5,
  }) : null;
  let placedByUs = false;

  if (!station) {
    // 2. Locate or craft the workstation item in inventory
    let stationItem = bot.inventory?.items().find((i) => i.name === workstationType);
    if (!stationItem && workstationType === 'crafting_table') {
      const mcData = (bot as any).registry;
      const tableDef = mcData?.itemsByName?.['crafting_table'];
      if (tableDef && bot.recipesFor && bot.craft) {
        const tableRecipes = bot.recipesFor(tableDef.id, null, 1, null as any);
        if (tableRecipes.length > 0) {
          try {
            await bot.craft(tableRecipes[0], 1);
            stationItem = bot.inventory?.items().find((i) => i.name === workstationType);
          } catch {}
        }
      }
    }

    if (!stationItem) {
      throw new Error(`No ${workstationType} nearby and none available in inventory to place.`);
    }

    // 3. Find a safe placement spot adjacent to bot
    const spot = findSafePlacementSpot(bot);
    if (!spot) {
      throw new Error(`No safe ground position found adjacent to bot to place ${workstationType}.`);
    }

    if (abortSignal?.aborted || (isCurrent && !isCurrent())) {
      throw new Error(`Placement of ${workstationType} cancelled by preemption signal.`);
    }

    if (bot.equip) {
      await bot.equip(stationItem, 'hand');
    }
    if (bot.placeBlock) {
      console.log(`[WORKSTATION] Placing ${workstationType} at (${spot.placePos.x}, ${spot.placePos.y}, ${spot.placePos.z})...`);
      await bot.placeBlock(spot.refBlock, spot.placeVector);
    }
    station = bot.blockAt ? bot.blockAt(spot.placePos) : { name: workstationType, position: spot.placePos };
    placedByUs = true;
    workstationRegistry.recordPlacement(spot.placePos, workstationType);
    console.log(`[WORKSTATION] Workstation ${workstationType} placed successfully!`);
  }

  let opError: any = null;
  try {
    return await operation(station);
  } catch (err: any) {
    opError = err;
    throw err;
  } finally {
    // 4. Teardown: If placed by us, dig down and vacuum the drop
    if (placedByUs && station && workstationRegistry.isOwnedByBot(station.position)) {
      const isCancelled = Boolean(abortSignal?.aborted || (isCurrent && !isCurrent()));
      // If preempted by survival emergency or cancelled, strictly bypass teardown to not stall emergency reflexes
      if (!isCancelled) {
        console.log(`[WORKSTATION] Teardown: recovering ${workstationType} back into inventory...`);
        try {
          const currentBlock = bot.blockAt ? bot.blockAt(station.position) : station;
          // Verify workstation block still exists at expected position
          if (currentBlock && currentBlock.name === workstationType) {
            // Auto-equip best tool (axe for crafting table, pickaxe for furnace)
            const bestTool = bot.inventory?.items().find((i) =>
              workstationType === 'crafting_table'
                ? i.name.includes('_axe') && !i.name.includes('pickaxe')
                : i.name.includes('_pickaxe')
            );
            if (bestTool && bot.equip) {
              try { await bot.equip(bestTool, 'hand'); } catch {}
            }

            // Re-verify cancellation after tool equip before issuing world mutation
            if (!abortSignal?.aborted && (!isCurrent || isCurrent())) {
              if (bot.dig) {
                await bot.dig(currentBlock);
              }
            }
          }

          workstationRegistry.forgetPlacement(station.position);

          // Vacuum dropped table/furnace item only if still active and uncancelled
          if (!abortSignal?.aborted && (!isCurrent || isCurrent())) {
            try {
              await techniqueVacuumDrops(bot, 3.5, abortSignal, isCurrent);
            } catch (vacErr) {
              // Vacuum drop collection failure must not conceal or fail a successful craft
            }
          }
        } catch (teardownErr: any) {
          if (opError) {
            // Preserve the original crafting error as primary; attach teardown error for observability
            (opError as any).teardownError = teardownErr;
          } else {
            // Crafting succeeded, but physical recovery failed: throw teardown error
            throw teardownErr;
          }
        }
      }
    }
  }
}

/**
 * Technique: Multi-Step Recursive Craft Pipeline
 * Resolves recursive dependencies for crafting chains (e.g. wood -> planks -> sticks -> crafting table -> pickaxe).
 * Uses ClosedLoopCraftingExecutor with workstation lifecycle management and postcondition verification.
 */
export async function techniqueCraftPipeline(
  bot: Bot,
  targetItemName: string,
  countOrSignal?: number | AbortSignal,
  abortSignalOrCurrent?: AbortSignal | (() => boolean),
  maybeIsCurrent?: () => boolean
): Promise<ActionResult> {
  let count = 1;
  let abortSignal: AbortSignal | undefined;
  let isCurrent: (() => boolean) | undefined;

  if (typeof countOrSignal === 'number') {
    count = countOrSignal;
    abortSignal = abortSignalOrCurrent as AbortSignal | undefined;
    isCurrent = maybeIsCurrent;
  } else if (countOrSignal && typeof countOrSignal === 'object' && 'aborted' in countOrSignal) {
    abortSignal = countOrSignal as AbortSignal;
    isCurrent = typeof abortSignalOrCurrent === 'function' ? abortSignalOrCurrent : undefined;
  } else if (typeof abortSignalOrCurrent === 'function') {
    isCurrent = abortSignalOrCurrent;
  }

  if (abortSignal?.aborted || (isCurrent && !isCurrent())) {
    return { status: 'interrupted', reason: 'Craft pipeline cancelled before start.' };
  }

  const executor = new ClosedLoopCraftingExecutor(bot);
  const ctx = {
    bot,
    abortSignal,
    isCurrent,
  };

  return executor.craftItem(targetItemName, count, ctx as any);
}

export const SMELTING_RECIPES: Record<string, { output: string; cookTimeTicks: number }> = {
  raw_iron: { output: 'iron_ingot', cookTimeTicks: 200 },
  raw_copper: { output: 'copper_ingot', cookTimeTicks: 200 },
  raw_gold: { output: 'gold_ingot', cookTimeTicks: 200 },
  iron_ore: { output: 'iron_ingot', cookTimeTicks: 200 },
  deepslate_iron_ore: { output: 'iron_ingot', cookTimeTicks: 200 },
  copper_ore: { output: 'copper_ingot', cookTimeTicks: 200 },
  gold_ore: { output: 'gold_ingot', cookTimeTicks: 200 },
  beef: { output: 'cooked_beef', cookTimeTicks: 200 },
  raw_beef: { output: 'cooked_beef', cookTimeTicks: 200 },
  porkchop: { output: 'cooked_porkchop', cookTimeTicks: 200 },
  raw_porkchop: { output: 'cooked_porkchop', cookTimeTicks: 200 },
  mutton: { output: 'cooked_mutton', cookTimeTicks: 200 },
  raw_mutton: { output: 'cooked_mutton', cookTimeTicks: 200 },
  chicken: { output: 'cooked_chicken', cookTimeTicks: 200 },
  raw_chicken: { output: 'cooked_chicken', cookTimeTicks: 200 },
  potato: { output: 'baked_potato', cookTimeTicks: 200 },
  cobblestone: { output: 'stone', cookTimeTicks: 200 },
  sand: { output: 'glass', cookTimeTicks: 200 },
  clay_ball: { output: 'brick', cookTimeTicks: 200 },
  oak_log: { output: 'charcoal', cookTimeTicks: 200 },
  birch_log: { output: 'charcoal', cookTimeTicks: 200 },
  spruce_log: { output: 'charcoal', cookTimeTicks: 200 },
  jungle_log: { output: 'charcoal', cookTimeTicks: 200 },
  acacia_log: { output: 'charcoal', cookTimeTicks: 200 },
  dark_oak_log: { output: 'charcoal', cookTimeTicks: 200 },
  mangrove_log: { output: 'charcoal', cookTimeTicks: 200 },
  cherry_log: { output: 'charcoal', cookTimeTicks: 200 },
};

export const FUEL_BURN_TIMES: Record<string, number> = {
  lava_bucket: 100,
  blaze_rod: 12,
  coal: 8,
  charcoal: 8,
  oak_log: 1.5,
  birch_log: 1.5,
  spruce_log: 1.5,
  jungle_log: 1.5,
  acacia_log: 1.5,
  dark_oak_log: 1.5,
  oak_planks: 1.5,
  birch_planks: 1.5,
  spruce_planks: 1.5,
  jungle_planks: 1.5,
  acacia_planks: 1.5,
  dark_oak_planks: 1.5,
  stick: 0.5,
};

/**
 * Technique: Smelt Item in Furnace
 * Autonomous smelting macro using the withWorkstation lifecycle.
 * Validates input and fuel, locates/places furnace, deposits fuel and ore,
 * awaits cook completion, extracts output, and recovers furnace.
 */
export async function techniqueSmeltItem(
  bot: Bot,
  itemToSmelt: string,
  count: number = 1,
  fuelItemName?: string,
  abortSignal?: AbortSignal,
  isCurrent?: () => boolean
): Promise<ActionResult> {
  if (abortSignal?.aborted || (isCurrent && !isCurrent())) {
    return { status: 'interrupted', reason: 'Smelting cancelled before start.' };
  }

  if (!itemToSmelt || typeof itemToSmelt !== 'string') {
    return { status: 'failed', reason: 'Invalid or missing itemToSmelt parameter.' };
  }

  const recipe = SMELTING_RECIPES[itemToSmelt.toLowerCase().trim()];
  if (!recipe) {
    return { status: 'failed', reason: `Item '${itemToSmelt}' is not recognized as a smeltable item.` };
  }

  const requestedCount = Math.max(1, count || 1);

  // 1. Check input item in inventory
  const inputItem = bot.inventory?.items().find((i) => i.name === itemToSmelt);
  if (!inputItem || inputItem.count < requestedCount) {
    const available = inputItem ? inputItem.count : 0;
    return {
      status: 'failed',
      reason: `Insufficient '${itemToSmelt}' in inventory (needed: ${requestedCount}, available: ${available}).`,
    };
  }

  // 2. Select fuel item
  let fuelItem: any = null;
  if (fuelItemName) {
    fuelItem = bot.inventory?.items().find((i) => i.name === fuelItemName);
    if (!fuelItem) {
      return { status: 'failed', reason: `Specified fuel '${fuelItemName}' is not in inventory.` };
    }
  } else {
    fuelItem =
      bot.inventory?.items().find((i) => i.name === 'coal' || i.name === 'charcoal') ||
      bot.inventory?.items().find((i) => i.name.endsWith('_planks')) ||
      bot.inventory?.items().find((i) => i.name.endsWith('_log') && i.name !== itemToSmelt) ||
      bot.inventory?.items().find((i) => i.name === 'stick');
  }

  if (!fuelItem) {
    return { status: 'failed', reason: 'No suitable fuel (coal, charcoal, planks, logs, sticks) found in inventory.' };
  }

  const itemsPerFuel = FUEL_BURN_TIMES[fuelItem.name] || 1;
  const fuelCountNeeded = Math.max(1, Math.ceil(requestedCount / itemsPerFuel));
  if (fuelItem.count < fuelCountNeeded) {
    return {
      status: 'failed',
      reason: `Insufficient fuel '${fuelItem.name}' (needed: ${fuelCountNeeded}, available: ${fuelItem.count}).`,
    };
  }

  // 3. Check furnace presence (nearby <= 4.5m or in inventory)
  const nearbyFurnace = typeof bot.findBlock === 'function'
    ? bot.findBlock({ matching: (b: any) => b.name === 'furnace', maxDistance: 4.5 })
    : null;
  const hasFurnaceItem = bot.inventory?.items().some((i) => i.name === 'furnace');
  if (!nearbyFurnace && !hasFurnaceItem) {
    return { status: 'failed', reason: 'No furnace nearby and no furnace in inventory to place.' };
  }

  const initialOutputCount = bot.inventory?.items().find((i) => i.name === recipe.output)?.count || 0;

  // 4. Use withWorkstation lifecycle to place, open, and recover furnace
  try {
    return await withWorkstation(
      bot,
      'furnace',
      async (furnaceBlock: any) => {
        if (abortSignal?.aborted || (isCurrent && !isCurrent())) {
          return { status: 'interrupted', reason: 'Smelting cancelled before opening furnace.' };
        }

        if (typeof (bot as any).openFurnace !== 'function') {
          return { status: 'failed', reason: 'Mineflayer openFurnace plugin unavailable.' };
        }

        console.log(`[FURNACE] Opening furnace at (${furnaceBlock.position.x}, ${furnaceBlock.position.y}, ${furnaceBlock.position.z})...`);
        const furnace = await (bot as any).openFurnace(furnaceBlock);

        try {
          if (abortSignal?.aborted || (isCurrent && !isCurrent())) {
            try { furnace.close(); } catch {}
            return { status: 'interrupted', reason: 'Smelting cancelled after opening furnace.' };
          }

          // Deposit fuel
          console.log(`[FURNACE] Depositing ${fuelCountNeeded}x ${fuelItem.name} into fuel slot...`);
          await furnace.putFuel(fuelItem.type, null, fuelCountNeeded);

          if (abortSignal?.aborted || (isCurrent && !isCurrent())) {
            try { furnace.close(); } catch {}
            return { status: 'interrupted', reason: 'Smelting cancelled after depositing fuel.' };
          }

          const initialOutputSlotCount = furnace.outputItem ? (furnace.outputItem()?.count || 0) : 0;
          const targetOutputSlotCount = initialOutputSlotCount + requestedCount;

          // Deposit input item
          console.log(`[FURNACE] Depositing ${requestedCount}x ${itemToSmelt} into input slot...`);
          await furnace.putInput(inputItem.type, null, requestedCount);

          // Await cook completion (approx 10s per item in vanilla Minecraft)
          console.log(`[FURNACE] Smelting ${requestedCount}x ${itemToSmelt} into ${recipe.output}...`);
          const timeoutMs = requestedCount * 12000 + 5000;
          const startWait = Date.now();
          let produced = 0;

          while (Date.now() - startWait < timeoutMs) {
            if (abortSignal?.aborted || (isCurrent && !isCurrent())) {
              try { furnace.close(); } catch {}
              return { status: 'interrupted', reason: 'Smelting interrupted during cook cycle.' };
            }

            const outItem = furnace.outputItem ? furnace.outputItem() : null;
            if (outItem && outItem.count >= targetOutputSlotCount) {
              produced = outItem.count - initialOutputSlotCount;
              break;
            }

            const inItem = furnace.inputItem ? furnace.inputItem() : null;
            if ((!inItem || inItem.count === 0) && outItem && outItem.count > initialOutputSlotCount) {
              produced = outItem.count - initialOutputSlotCount;
              break;
            }

            await new Promise((res) => setTimeout(res, 250));
          }

          // Take output
          const finalOut = furnace.outputItem ? furnace.outputItem() : null;
          if (finalOut && finalOut.count > 0) {
            console.log(`[FURNACE] Taking ${finalOut.count}x ${recipe.output} from output slot...`);
            await furnace.takeOutput();
          }

          try { furnace.close(); } catch {}

          const finalOutputCount = bot.inventory?.items().find((i) => i.name === recipe.output)?.count || 0;
          const netGain = finalOutputCount - initialOutputCount;

          if (netGain > 0 || produced > 0) {
            return {
              status: 'success',
              reason: `Smelted ${produced || netGain}x ${recipe.output} in furnace.`,
              details: {
                itemSmelted: itemToSmelt,
                outputItem: recipe.output,
                count: produced || netGain,
              },
            };
          }

          return {
            status: 'failed',
            reason: `Smelting timed out without producing ${recipe.output}.`,
          };
        } catch (innerErr: any) {
          try { furnace.close(); } catch {}
          throw innerErr;
        }
      },
      abortSignal,
      isCurrent
    );
  } catch (err: any) {
    if (abortSignal?.aborted || (isCurrent && !isCurrent())) {
      return { status: 'interrupted', reason: 'Smelting cancelled.' };
    }
    return { status: 'failed', reason: `Smelting failed: ${err.message}` };
  }
}

export async function techniqueSmeltPipeline(
  bot: Bot,
  itemToSmelt: string,
  count: number = 1,
  fuelItemName?: string,
  abortSignal?: AbortSignal,
  isCurrent?: () => boolean
): Promise<ActionResult> {
  return techniqueSmeltItem(bot, itemToSmelt, count, fuelItemName, abortSignal, isCurrent);
}

/**
 * Technique: Automate Iron Smelting Cycle
 * Closed-loop iron processing: checks raw_iron or iron_ore in inventory, determines fuel,
 * executes furnace smelting via withWorkstation, and collects iron_ingots.
 */
export async function techniqueAutomateIronSmeltCycle(
  bot: Bot,
  targetIngotCount?: number,
  fuelPreference?: string,
  abortSignal?: AbortSignal,
  isCurrent?: () => boolean
): Promise<ActionResult> {
  if (abortSignal?.aborted || (isCurrent && !isCurrent())) {
    return { status: 'interrupted', reason: 'Iron smelting cycle cancelled before start.' };
  }

  const items = bot.inventory ? bot.inventory.items() : [];
  const rawIronItem = items.find((i) => i.name === 'raw_iron' || i.name === 'iron_ore');
  if (!rawIronItem || rawIronItem.count <= 0) {
    return { status: 'failed', reason: 'No raw iron or iron ore available in inventory to smelt.' };
  }

  const countToSmelt = targetIngotCount && targetIngotCount > 0
    ? Math.min(targetIngotCount, rawIronItem.count)
    : rawIronItem.count;

  return techniqueSmeltItem(bot, rawIronItem.name, countToSmelt, fuelPreference, abortSignal, isCurrent);
}

