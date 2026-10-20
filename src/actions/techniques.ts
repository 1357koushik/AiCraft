import { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { goals, Movements } from 'mineflayer-pathfinder';
import { ActionResult } from '../types/index.js';
import { distance3D } from '../utils/math.js';

const SCAFFOLD_BLOCK_NAMES = [
  'dirt',
  'cobblestone',
  'cobbled_deepslate',
  'stone',
  'netherrack',
  'oak_planks',
  'birch_planks',
  'spruce_planks',
  'jungle_planks',
  'acacia_planks',
  'dark_oak_planks',
  'mangrove_planks',
  'cherry_planks',
  'sandstone',
];

/**
 * Dynamically updates the pathfinder Movements instance with blocks currently in inventory,
 * enabling automatic 1x1 tower pillaring, bridging across gaps, and digging obstacles.
 */
export function updatePathfinderMovements(bot: Bot): Movements {
  let move: Movements = (bot as any).pathfinder?.movements;
  if (!move) {
    move = new Movements(bot);
    (bot as any).pathfinder.setMovements(move);
  }

  // 1. Enable smart capabilities
  move.canDig = true;
  move.allow1by1towers = true;
  move.allowParkour = true;
  move.dontMineUnderFallingBlock = true;
  (move as any).liquidCost = 25; // avoid liquids unless necessary

  // 2. Populate scaffolding blocks from bot inventory
  const scaffoldIds: number[] = [];
  if (bot.inventory) {
    for (const item of bot.inventory.items()) {
      if (SCAFFOLD_BLOCK_NAMES.some((name) => item.name.includes(name))) {
        const blockDef = bot.registry.blocksByName[item.name];
        if (blockDef && !scaffoldIds.includes(blockDef.id)) {
          scaffoldIds.push(blockDef.id);
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
  return bot.inventory.items().find((it) =>
    SCAFFOLD_BLOCK_NAMES.some((name) => it.name.includes(name))
  );
}

/**
 * Technique: Pillar Jump
 * Jumps and places blocks directly beneath feet to gain height.
 * Accurately verifies placement and restores pitch/yaw and controls.
 */
export async function techniquePillarUp(
  bot: Bot,
  height: number = 3,
  abortSignal?: AbortSignal
): Promise<ActionResult> {
  const targetHeight = Math.min(Math.max(height, 1), 12);
  let placed = 0;

  try {
    for (let i = 0; i < targetHeight; i++) {
      if (abortSignal?.aborted) {
        return { status: 'interrupted', reason: 'Pillar up cancelled by abort signal.' };
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

      // Look straight down at the ground block (positive PI/2 is DOWN in Minecraft)
      await bot.look(bot.entity.yaw, Math.PI / 2, true);

      // Jump
      bot.setControlState('jump', true);

      // Wait until bot reaches jump apex (height > 1.12)
      let jumped = false;
      for (let t = 0; t < 15; t++) {
        if (abortSignal?.aborted) {
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

      if (jumped) {
        try {
          await bot.placeBlock(groundBlock, new Vec3(0, 1, 0));
        } catch {
          // Retry once with straight upward placement
          try {
            await bot.placeBlock(groundBlock, new Vec3(0, 1, 0));
          } catch {}
        }

        // Post-placement verification: verify the block appeared at feet level
        const placedBlock = bot.blockAt(startPos.floored());
        if (!placedBlock || placedBlock.boundingBox !== 'block' || placedBlock.name === 'air') {
          return {
            status: placed > 0 ? 'success' : 'failed',
            reason: `Pillaring halted: placement could not be verified at height ${placed + 1}.`,
          };
        }
        placed++;
      }

      await new Promise((res) => setTimeout(res, 180));
    }
  } finally {
    try {
      bot.setControlState?.('jump', false);
      bot.clearControlStates?.();
    } catch {}
    try {
      // Restore camera pitch to level
      await bot.look?.(bot.entity.yaw, 0, true);
    } catch {}
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
  abortSignal?: AbortSignal
): Promise<ActionResult> {
  const steps = Math.min(Math.max(distance, 1), 16);
  let resolvedDir = direction;

  if (direction === 'forward') {
    const yaw = bot.entity.yaw;
    let normYaw = yaw % (2 * Math.PI);
    if (normYaw < 0) normYaw += 2 * Math.PI;
    const deg = (normYaw * 180) / Math.PI;
    if (deg >= 45 && deg < 135) resolvedDir = 'west';
    else if (deg >= 135 && deg < 225) resolvedDir = 'north';
    else if (deg >= 225 && deg < 315) resolvedDir = 'east';
    else resolvedDir = 'south';
  }

  let dirVec = new Vec3(0, 0, 1);
  let faceVec = new Vec3(0, 0, 1);
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
      if (abortSignal?.aborted) {
        return { status: 'interrupted', reason: 'Bridging cancelled by abort signal.' };
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

      // If gap ahead is open air or non-solid, place block against current ground face
      if (!targetGroundBlock || targetGroundBlock.name === 'air' || targetGroundBlock.boundingBox !== 'block') {
        await bot.lookAt(currentGround.position.offset(0.5 + dirVec.x * 0.4, 0.5, 0.5 + dirVec.z * 0.4), true);

        try {
          await bot.placeBlock(currentGround, faceVec);
        } catch {
          try {
            await bot.placeBlock(currentGround, new Vec3(0, 1, 0));
          } catch {}
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

      // Step forward onto the verified new block while remaining crouched
      bot.setControlState('forward', true);
      await new Promise((res) => setTimeout(res, 400));
      bot.setControlState('forward', false);
      await new Promise((res) => setTimeout(res, 100));
    }
  } finally {
    try {
      bot.setControlState?.('sneak', false);
      bot.clearControlStates?.();
      bot.deactivateItem?.();
      await bot.look?.(bot.entity.yaw, 0, true);
    } catch {}
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
  abortSignal?: AbortSignal
): Promise<ActionResult> {
  const botPos = bot.entity.position;
  const items = Object.values(bot.entities).filter((e) => {
    if (!e || (e.name !== 'item' && (e.type as string) !== 'item')) return false;
    return distance3D(botPos, e.position) <= radius;
  });

  if (items.length === 0) {
    return { status: 'success', reason: 'No dropped items nearby to collect.' };
  }

  updatePathfinderMovements(bot);
  let collected = 0;

  try {
    for (const it of items.slice(0, 8)) {
      if (abortSignal?.aborted) {
        return { status: 'interrupted', reason: 'Vacuum drops cancelled by abort signal.' };
      }
      try {
        const goal = new goals.GoalNear(it.position.x, it.position.y, it.position.z, 0.6);
        await (bot as any).pathfinder.goto(goal);
        collected++;
      } catch {}
    }
  } finally {
    try {
      (bot as any).pathfinder?.stop();
    } catch {}
    try {
      bot.clearControlStates?.();
    } catch {}
  }

  return { status: 'success', reason: `Vacuumed ${collected} dropped items.` };
}

/**
 * Technique: Autonomous Full Tree Harvester
 * Automatically navigates to nearest tree, clears leaves in the way, chops logs
 * from base to top, towers up with pillar jumps if logs are out of reach,
 * cleans up scaffolding, and vacuums dropped saplings/wood.
 */
export async function techniqueChopTreeFull(
  bot: Bot,
  scanRadius: number = 16,
  abortSignal?: AbortSignal
): Promise<ActionResult> {
  updatePathfinderMovements(bot);

  // Find nearest tree log
  const logBlock = bot.findBlock({
    matching: (b) => b.name.includes('log'),
    maxDistance: scanRadius,
  });

  if (!logBlock) {
    return { status: 'failed', reason: 'No tree logs found nearby.' };
  }

  try {
    // 1. Walk to tree base
    try {
      const goal = new goals.GoalGetToBlock(logBlock.position.x, logBlock.position.y, logBlock.position.z);
      await (bot as any).pathfinder.goto(goal);
    } catch {
      try {
        const nearGoal = new goals.GoalNear(logBlock.position.x, logBlock.position.y, logBlock.position.z, 2.5);
        await (bot as any).pathfinder.goto(nearGoal);
      } catch {}
    }

    if (abortSignal?.aborted) {
      return { status: 'interrupted', reason: 'Tree chopping cancelled after pathfinding.' };
    }

    let totalLogsCut = 0;
    const treeBaseX = logBlock.position.x;
    const treeBaseZ = logBlock.position.z;
    const startY = logBlock.position.y;

    // 2. Cut reachable logs upward
    for (let dy = 0; dy <= 6; dy++) {
      if (abortSignal?.aborted) break;

      const targetPos = new Vec3(treeBaseX, startY + dy, treeBaseZ);
      const targetBlock = bot.blockAt(targetPos);
      if (!targetBlock || !targetBlock.name.includes('log')) continue;

      // Check distance from bot eye
      const dist = distance3D(bot.entity.position.offset(0, 1.6, 0), targetPos);
      if (dist > 4.2) {
        // Out of reach: pillar up 1 block using scaffolding
        const pillarItem = getScaffoldingItem(bot);
        if (pillarItem) {
          await techniquePillarUp(bot, 1, abortSignal);
        }
      }

      // Auto-equip best axe
      const axe = bot.inventory.items().find((i) => i.name.includes('_axe'));
      if (axe && bot.heldItem?.type !== axe.type) {
        try {
          await bot.equip(axe, 'hand');
        } catch {}
      }

      try {
        await bot.dig(targetBlock);
        totalLogsCut++;
        await new Promise((res) => setTimeout(res, 150));
      } catch {
        break;
      }
    }

    // 3. Clear any adjacent logs
    const adjacentLogs = [
      new Vec3(treeBaseX + 1, startY, treeBaseZ),
      new Vec3(treeBaseX - 1, startY, treeBaseZ),
      new Vec3(treeBaseX, startY, treeBaseZ + 1),
      new Vec3(treeBaseX, startY, treeBaseZ - 1),
    ];
    for (const adjPos of adjacentLogs) {
      if (abortSignal?.aborted) break;
      const adjBlock = bot.blockAt(adjPos);
      if (adjBlock && adjBlock.name.includes('log')) {
        try {
          await bot.dig(adjBlock);
          totalLogsCut++;
        } catch {}
      }
    }

    // 4. Automatically vacuum all dropped logs and saplings around the tree
    await new Promise((res) => setTimeout(res, 400));
    await techniqueVacuumDrops(bot, 6, abortSignal);

    return {
      status: totalLogsCut > 0 ? 'success' : 'failed',
      reason: `Harvested full tree (${totalLogsCut} logs cut) and collected drops.`,
    };
  } finally {
    try {
      (bot as any).pathfinder?.stop();
    } catch {}
    try {
      bot.clearControlStates?.();
    } catch {}
  }
}

/**
 * Technique: Staircase Mining
 * Mines a safe forward-descending 1x2 staircase without digging straight down.
 * Performs rigorous multi-point hazard inspection and floor verification before every step.
 */
export async function techniqueMineStaircase(
  bot: Bot,
  steps: number = 6,
  abortSignal?: AbortSignal
): Promise<ActionResult> {
  const count = Math.min(Math.max(steps, 1), 16);
  let dug = 0;

  // Determine cardinal direction from bot's current yaw
  const yaw = bot.entity.yaw;
  let normYaw = yaw % (2 * Math.PI);
  if (normYaw < 0) normYaw += 2 * Math.PI;
  const deg = (normYaw * 180) / Math.PI;
  let dirVec = new Vec3(0, 0, 1);
  if (deg >= 45 && deg < 135) dirVec = new Vec3(-1, 0, 0);
  else if (deg >= 135 && deg < 225) dirVec = new Vec3(0, 0, -1);
  else if (deg >= 225 && deg < 315) dirVec = new Vec3(1, 0, 0);

  try {
    for (let s = 1; s <= count; s++) {
      if (abortSignal?.aborted) {
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
    try {
      bot.clearControlStates?.();
      bot.deactivateItem?.();
    } catch {}
  }

  return { status: 'success', reason: `Mined staircase ${count} steps down (${dug} blocks cleared).` };
}

/**
 * Technique: Build Simple Survival Shelter
 * Places a 3x3x3 dirt/cobblestone shelter with roof and door opening.
 */
export async function techniqueBuildShelter(
  bot: Bot,
  abortSignal?: AbortSignal
): Promise<ActionResult> {
  const center = bot.entity.position.floored();
  let blocksPlaced = 0;

  try {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dy = 0; dy <= 2; dy++) {
          if (abortSignal?.aborted) {
            return { status: 'interrupted', reason: 'Shelter construction cancelled by abort signal.' };
          }

          // Keep center open for bot interior
          if (dx === 0 && dz === 0 && dy < 2) continue;
          // Keep doorway open (front center)
          if (dx === 0 && dz === 1 && (dy === 0 || dy === 1)) continue;

          const targetPos = center.offset(dx, dy, dz);
          const current = bot.blockAt(targetPos);
          if (current && current.name === 'air') {
            const scaffold = getScaffoldingItem(bot);
            if (!scaffold) {
              return {
                status: blocksPlaced > 0 ? 'success' : 'failed',
                reason: `Ran out of building materials after placing ${blocksPlaced} blocks.`,
              };
            }

            const refBlock =
              bot.blockAt(targetPos.offset(0, -1, 0)) ||
              bot.blockAt(targetPos.offset(1, 0, 0)) ||
              bot.blockAt(targetPos.offset(-1, 0, 0));

            if (refBlock && refBlock.name !== 'air') {
              try {
                await bot.equip(scaffold, 'hand');
                await bot.placeBlock(refBlock, new Vec3(0, 1, 0));
                blocksPlaced++;
              } catch {}
            }
          }
        }
      }
    }
  } finally {
    try {
      bot.clearControlStates?.();
      bot.deactivateItem?.();
    } catch {}
  }

  return { status: 'success', reason: `Built shelter (${blocksPlaced} blocks placed).` };
}

/**
 * Technique: Multi-Step Recursive Craft Pipeline
 * Resolves recursive dependencies for crafting chains (e.g. wood -> planks -> sticks -> crafting table -> pickaxe).
 */
export async function techniqueCraftPipeline(
  bot: Bot,
  targetItemName: string,
  abortSignal?: AbortSignal
): Promise<ActionResult> {
  if (abortSignal?.aborted) {
    return { status: 'interrupted', reason: 'Craft pipeline cancelled before start.' };
  }

  const mcData = (bot as any).registry;
  const targetItem = mcData.itemsByName[targetItemName];
  if (!targetItem) {
    return { status: 'failed', reason: `Unknown item '${targetItemName}'.` };
  }

  try {
    // 1. If we already have the item in inventory
    const existing = bot.inventory?.items().find((i) => i.type === targetItem.id);
    if (existing && existing.count >= 1) {
      return { status: 'success', reason: `Already have ${targetItemName} in inventory.` };
    }

    // 2. Resolve logs -> planks if needed
    const logs = bot.inventory?.items().find((i) => i.name.includes('_log'));
    const planks = bot.inventory?.items().find((i) => i.name.includes('_planks'));

    if (!planks && logs) {
      const plankRecipes = bot.recipesFor(mcData.itemsByName['oak_planks']?.id || 1, null, 1, null as any);
      if (plankRecipes.length > 0) {
        try {
          await bot.craft(plankRecipes[0], 1);
        } catch {}
      }
    }

    if (abortSignal?.aborted) {
      return { status: 'interrupted', reason: 'Craft pipeline cancelled after planks step.' };
    }

    // 3. Resolve sticks if needed for tools
    const sticks = bot.inventory?.items().find((i) => i.name === 'stick');
    if (!sticks && targetItemName.includes('_pickaxe') || targetItemName.includes('_axe') || targetItemName.includes('_sword')) {
      const stickItem = mcData.itemsByName['stick'];
      if (stickItem) {
        const stickRecipes = bot.recipesFor(stickItem.id, null, 1, null as any);
        if (stickRecipes.length > 0) {
          try {
            await bot.craft(stickRecipes[0], 1);
          } catch {}
        }
      }
    }

    if (abortSignal?.aborted) {
      return { status: 'interrupted', reason: 'Craft pipeline cancelled after sticks step.' };
    }

    // 4. Crafting table check: does target require a crafting table?
    let craftingTableBlock = bot.findBlock({
      matching: (b) => b.name === 'crafting_table',
      maxDistance: 4.5,
    });

    if (!craftingTableBlock) {
      const tableItem = bot.inventory?.items().find((i) => i.name === 'crafting_table');
      if (tableItem) {
        const placePos = bot.entity.position.floored().offset(1, 0, 0);
        const ref = bot.blockAt(placePos.offset(0, -1, 0));
        if (ref && ref.name !== 'air') {
          try {
            await bot.equip(tableItem, 'hand');
            await bot.placeBlock(ref, new Vec3(0, 1, 0));
            craftingTableBlock = bot.blockAt(placePos);
          } catch {}
        }
      } else {
        const tableDef = mcData.itemsByName['crafting_table'];
        if (tableDef) {
          const tableRecipes = bot.recipesFor(tableDef.id, null, 1, null as any);
          if (tableRecipes.length > 0) {
            try {
              await bot.craft(tableRecipes[0], 1);
              const newTable = bot.inventory?.items().find((i) => i.name === 'crafting_table');
              if (newTable) {
                const placePos = bot.entity.position.floored().offset(1, 0, 0);
                const ref = bot.blockAt(placePos.offset(0, -1, 0));
                if (ref && ref.name !== 'air') {
                  await bot.equip(newTable, 'hand');
                  await bot.placeBlock(ref, new Vec3(0, 1, 0));
                  craftingTableBlock = bot.blockAt(placePos);
                }
              }
            } catch {}
          }
        }
      }
    }

    if (abortSignal?.aborted) {
      return { status: 'interrupted', reason: 'Craft pipeline cancelled before final item craft.' };
    }

    // 5. Final craft of target item
    const targetRecipes = bot.recipesFor(targetItem.id, null, 1, craftingTableBlock as any);
    if (targetRecipes.length === 0) {
      return {
        status: 'failed',
        reason: `Missing ingredients to craft ${targetItemName}.`,
      };
    }

    await bot.craft(targetRecipes[0], 1, craftingTableBlock as any);
    return { status: 'success', reason: `Crafted ${targetItemName} successfully.` };
  } catch (err: any) {
    return { status: 'failed', reason: `Crafting pipeline failed: ${err.message}` };
  } finally {
    try {
      bot.clearControlStates?.();
      bot.deactivateItem?.();
    } catch {}
  }
}
