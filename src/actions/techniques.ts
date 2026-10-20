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
 */
export async function techniquePillarUp(bot: Bot, height: number = 3): Promise<ActionResult> {
  const targetHeight = Math.min(Math.max(height, 1), 12);
  let placed = 0;

  for (let i = 0; i < targetHeight; i++) {
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

    if (!groundBlock || groundBlock.name === 'air') {
      return { status: 'failed', reason: 'No solid block beneath to jump from.' };
    }

    try {
      // Look straight down at the ground block (positive PI/2 is DOWN in Minecraft)
      await bot.look(bot.entity.yaw, Math.PI / 2, true);

      // Jump
      bot.setControlState('jump', true);

      // Wait until bot reaches jump apex (height > 1.12)
      let jumped = false;
      for (let t = 0; t < 15; t++) {
        await new Promise((res) => setTimeout(res, 30));
        if (bot.entity.position.y - startPos.y > 1.12) {
          jumped = true;
          break;
        }
      }

      if (jumped) {
        try {
          const refBlock = bot.blockAt(startPos.floored());
          if (refBlock && refBlock.name !== 'air') {
            await bot.placeBlock(refBlock, new Vec3(0, 1, 0));
            placed++;
          }
        } catch {}
      }
    } finally {
      bot.setControlState('jump', false);
    }
    await new Promise((res) => setTimeout(res, 180));
  }

  return { status: 'success', reason: `Successfully pillared up ${placed} blocks.` };
}

/**
 * Technique: Safe Sneak-Bridging
 * Crouches (sneak) to prevent falling off cliffs and extends a bridge across open air.
 * Strictly verifies block placement before moving forward.
 */
export async function techniqueBridge(
  bot: Bot,
  direction: 'north' | 'south' | 'east' | 'west' | 'forward',
  distance: number = 4
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

  // Engage sneak so the bot CANNOT fall off the ledge!
  bot.setControlState('sneak', true);
  let placed = 0;

  try {
    for (let i = 0; i < steps; i++) {
      const scaffoldItem = getScaffoldingItem(bot);
      if (!scaffoldItem) {
        break;
      }
      await bot.equip(scaffoldItem, 'hand');

      const currentFeet = bot.entity.position.floored();
      const currentGround = bot.blockAt(currentFeet.offset(0, -1, 0));
      const targetGroundPos = currentFeet.offset(dirVec.x, -1, dirVec.z);
      const targetGroundBlock = bot.blockAt(targetGroundPos);

      // If gap ahead is open air, place block against current ground face
      if (currentGround && (!targetGroundBlock || targetGroundBlock.name === 'air')) {
        await bot.lookAt(currentGround.position.offset(0.5 + dirVec.x * 0.4, 0.5, 0.5 + dirVec.z * 0.4), true);

        try {
          await bot.placeBlock(currentGround, faceVec);
        } catch {
          try {
            await bot.placeBlock(currentGround, new Vec3(0, 1, 0));
          } catch {}
        }

        // Post-placement verification: Confirm block actually appeared before stepping!
        const verifyBlock = bot.blockAt(targetGroundPos);
        if (!verifyBlock || verifyBlock.name === 'air') {
          // Block placement failed or was cancelled by server; DO NOT walk into the void!
          return {
            status: 'failed',
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
    // Release sneak safely
    bot.setControlState('sneak', false);
    bot.clearControlStates();
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
export async function techniqueVacuumDrops(bot: Bot, radius: number = 10): Promise<ActionResult> {
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

  for (const it of items.slice(0, 8)) {
    try {
      const goal = new goals.GoalNear(it.position.x, it.position.y, it.position.z, 0.6);
      await (bot as any).pathfinder.goto(goal);
      collected++;
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
export async function techniqueChopTreeFull(bot: Bot, scanRadius: number = 16): Promise<ActionResult> {
  updatePathfinderMovements(bot);

  // Find nearest tree log
  const logBlock = bot.findBlock({
    matching: (b) => b.name.includes('log'),
    maxDistance: scanRadius,
  });

  if (!logBlock) {
    return { status: 'failed', reason: 'No tree logs found nearby.' };
  }

  // 1. Walk to tree base (digging obstructive leaves or brush in the way!)
  try {
    const goal = new goals.GoalGetToBlock(logBlock.position.x, logBlock.position.y, logBlock.position.z);
    await (bot as any).pathfinder.goto(goal);
  } catch (err: any) {
    // Try approaching nearby
    try {
      const nearGoal = new goals.GoalNear(logBlock.position.x, logBlock.position.y, logBlock.position.z, 2.5);
      await (bot as any).pathfinder.goto(nearGoal);
    } catch {}
  }

  let totalLogsCut = 0;
  const treeBaseX = logBlock.position.x;
  const treeBaseZ = logBlock.position.z;
  const startY = logBlock.position.y;

  // 2. Cut reachable logs upward
  for (let dy = 0; dy <= 6; dy++) {
    const targetPos = new Vec3(treeBaseX, startY + dy, treeBaseZ);
    const targetBlock = bot.blockAt(targetPos);
    if (!targetBlock || !targetBlock.name.includes('log')) continue;

    // Check distance from bot eye
    const dist = distance3D(bot.entity.position.offset(0, 1.6, 0), targetPos);
    if (dist > 4.2) {
      // Out of reach: pillar up 1 or 2 blocks using dirt/scaffolding
      const pillarItem = getScaffoldingItem(bot);
      if (pillarItem) {
        await techniquePillarUp(bot, 1);
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

  // 3. Clear any obstructive leaves around the trunk if more logs exist
  const adjacentLogs = [
    new Vec3(treeBaseX + 1, startY, treeBaseZ),
    new Vec3(treeBaseX - 1, startY, treeBaseZ),
    new Vec3(treeBaseX, startY, treeBaseZ + 1),
    new Vec3(treeBaseX, startY, treeBaseZ - 1),
  ];
  for (const adjPos of adjacentLogs) {
    const adjBlock = bot.blockAt(adjPos);
    if (adjBlock && adjBlock.name.includes('log')) {
      try {
        await bot.dig(adjBlock);
        totalLogsCut++;
      } catch {}
    }
  }

  // 4. Automatically vacuum all dropped logs and saplings around the tree
  await new Promise((res) => setTimeout(res, 500));
  await techniqueVacuumDrops(bot, 6);

  return {
    status: totalLogsCut > 0 ? 'success' : 'failed',
    reason: `Harvested full tree (${totalLogsCut} logs cut) and collected drops.`,
  };
}

/**
 * Technique: Staircase Mining
 * Mines a safe forward-descending 1x2 staircase without digging straight down.
 */
export async function techniqueMineStaircase(bot: Bot, steps: number = 6): Promise<ActionResult> {
  const count = Math.min(Math.max(steps, 1), 16);
  let dug = 0;

  // Determine cardinal direction
  const yaw = bot.entity.yaw;
  let normYaw = yaw % (2 * Math.PI);
  if (normYaw < 0) normYaw += 2 * Math.PI;
  const deg = (normYaw * 180) / Math.PI;
  let dirVec = new Vec3(0, 0, 1);
  if (deg >= 45 && deg < 135) dirVec = new Vec3(-1, 0, 0);
  else if (deg >= 135 && deg < 225) dirVec = new Vec3(0, 0, -1);
  else if (deg >= 225 && deg < 315) dirVec = new Vec3(1, 0, 0);

  for (let s = 1; s <= count; s++) {
    const currentFeet = bot.entity.position.floored();
    const stepAhead = currentFeet.offset(dirVec.x, 0, dirVec.z);

    // Hazard pre-inspection: Check for lava or unstable falling blocks
    const overhead = bot.blockAt(stepAhead.offset(0, 2, 0));
    if (overhead && (overhead.name === 'sand' || overhead.name === 'gravel')) {
      return { status: 'failed', reason: 'Staircase mining halted: unstable falling gravel/sand detected overhead.' };
    }

    const surrounding = [
      bot.blockAt(stepAhead.offset(0, 1, 0)),
      bot.blockAt(stepAhead),
      bot.blockAt(stepAhead.offset(0, -1, 0)),
      bot.blockAt(stepAhead.offset(dirVec.x, 0, dirVec.z)),
    ];
    if (surrounding.some((b) => b?.name === 'lava' || b?.name === 'flowing_lava')) {
      return { status: 'failed', reason: 'Staircase mining halted: lava hazard detected ahead.' };
    }

    // Auto-equip best pickaxe or shovel
    const pickaxe = bot.inventory.items().find((i) => i.name.includes('pickaxe'));
    if (pickaxe && bot.heldItem?.type !== pickaxe.type) {
      try {
        await bot.equip(pickaxe, 'hand');
      } catch {}
    }

    // Dig top block ahead (eye level)
    const blockHead = bot.blockAt(stepAhead.offset(0, 1, 0));
    if (blockHead && blockHead.name !== 'air' && blockHead.name !== 'bedrock') {
      try {
        await bot.dig(blockHead);
        dug++;
      } catch {}
    }

    // Dig middle block ahead (foot level)
    const blockFeet = bot.blockAt(stepAhead);
    if (blockFeet && blockFeet.name !== 'air' && blockFeet.name !== 'bedrock') {
      try {
        await bot.dig(blockFeet);
        dug++;
      } catch {}
    }

    // Dig ground block ahead (descending step)
    const blockGround = bot.blockAt(stepAhead.offset(0, -1, 0));
    if (blockGround && blockGround.name !== 'air' && blockGround.name !== 'bedrock') {
      try {
        await bot.dig(blockGround);
        dug++;
      } catch {}
    }

    // Step down onto the new step
    bot.setControlState('forward', true);
    await new Promise((res) => setTimeout(res, 400));
    bot.setControlState('forward', false);
    await new Promise((res) => setTimeout(res, 100));

    // Place torch if dark (every 5 steps)
    if (s % 5 === 0) {
      const torch = bot.inventory.items().find((i) => i.name === 'torch');
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

  return { status: 'success', reason: `Mined staircase ${count} steps down (${dug} blocks cleared).` };
}

/**
 * Technique: Build Simple Survival Shelter
 * Places a 3x3x3 dirt/cobblestone shelter with roof and door opening.
 */
export async function techniqueBuildShelter(bot: Bot): Promise<ActionResult> {
  const center = bot.entity.position.floored();
  let blocksPlaced = 0;

  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = 0; dy <= 2; dy++) {
        // Keep center open for bot interior
        if (dx === 0 && dz === 0 && dy < 2) continue;
        // Keep doorway open (front center)
        if (dx === 0 && dz === 1 && (dy === 0 || dy === 1)) continue;

        const targetPos = center.offset(dx, dy, dz);
        const current = bot.blockAt(targetPos);
        if (current && current.name === 'air') {
          const item = getScaffoldingItem(bot);
          if (!item) {
            return {
              status: blocksPlaced > 0 ? 'success' : 'failed',
              reason: `Ran out of building materials after placing ${blocksPlaced} blocks.`,
            };
          }

          // Find adjacent reference block to place against
          const adj = bot.blockAt(targetPos.offset(0, -1, 0));
          if (adj && adj.name !== 'air') {
            try {
              await bot.equip(item, 'hand');
              await bot.placeBlock(adj, new Vec3(0, 1, 0));
              blocksPlaced++;
              await new Promise((res) => setTimeout(res, 80));
            } catch {}
          }
        }
      }
    }
  }

  return { status: 'success', reason: `Built survival shelter (${blocksPlaced} blocks placed).` };
}

/**
 * Technique: Automated Multi-Step Crafting Pipeline
 * Recursively crafts prerequisite items (logs -> planks -> table -> sticks -> tool) in code.
 */
export async function techniqueCraftPipeline(bot: Bot, targetItemName: string): Promise<ActionResult> {
  const registry = bot.registry;
  const targetItem = registry.itemsByName[targetItemName];
  if (!targetItem) return { status: 'failed', reason: `Unknown item ${targetItemName}` };

  // Step 1: If we need planks and have logs, auto-craft planks
  const logs = bot.inventory.items().find((i) => i.name.includes('log'));
  if (logs) {
    const plankDef = Object.values(registry.itemsByName).find(
      (i) => i.name.endsWith('_planks')
    );
    if (plankDef) {
      const plankRecipes = bot.recipesFor(plankDef.id, null, 1, null);
      if (plankRecipes.length > 0) {
        try {
          await bot.craft(plankRecipes[0], 2, undefined);
        } catch {}
      }
    }
  }

  // Step 2: If we need sticks and have planks, craft sticks
  const sticks = bot.inventory.items().find((i) => i.name === 'stick');
  const planks = bot.inventory.items().find((i) => i.name.endsWith('_planks'));
  if (!sticks && planks && planks.count >= 2) {
    const stickDef = registry.itemsByName['stick'];
    if (stickDef) {
      const stickRecipes = bot.recipesFor(stickDef.id, null, 1, null);
      if (stickRecipes.length > 0) {
        try {
          await bot.craft(stickRecipes[0], 1, undefined);
        } catch {}
      }
    }
  }

  // Step 3: Check if crafting table is needed
  let craftingTableBlock = bot.findBlock({ matching: (b) => b.name === 'crafting_table', maxDistance: 4.5 });
  if (!craftingTableBlock) {
    // Check if table in inventory
    const tableItem = bot.inventory.items().find((i) => i.name === 'crafting_table');
    if (tableItem) {
      // Place table on ground
      const ground = bot.blockAt(bot.entity.position.floored().offset(1, -1, 0));
      if (ground) {
        try {
          await bot.equip(tableItem, 'hand');
          await bot.placeBlock(ground, new Vec3(0, 1, 0));
          craftingTableBlock = bot.blockAt(bot.entity.position.floored().offset(1, 0, 0));
        } catch {}
      }
    } else {
      // Craft a crafting table if we have 4 planks
      const currentPlanks = bot.inventory.items().find((i) => i.name.endsWith('_planks'));
      if (currentPlanks && currentPlanks.count >= 4) {
        const tableDef = registry.itemsByName['crafting_table'];
        const tableRecipes = bot.recipesFor(tableDef.id, null, 1, null);
        if (tableRecipes.length > 0) {
          try {
            await bot.craft(tableRecipes[0], 1, undefined);
            const ground = bot.blockAt(bot.entity.position.floored().offset(1, -1, 0));
            const newTableItem = bot.inventory.items().find((i) => i.name === 'crafting_table');
            if (newTableItem && ground) {
              await bot.equip(newTableItem, 'hand');
              await bot.placeBlock(ground, new Vec3(0, 1, 0));
              craftingTableBlock = bot.blockAt(bot.entity.position.floored().offset(1, 0, 0));
            }
          } catch {}
        }
      }
    }
  }

  // Step 4: Craft final requested item
  const finalRecipes = bot.recipesFor(targetItem.id, null, 1, craftingTableBlock);
  if (finalRecipes.length === 0) {
    return {
      status: 'failed',
      reason: `Could not craft ${targetItemName}: missing prerequisite resources.`,
    };
  }

  try {
    await bot.craft(finalRecipes[0], 1, craftingTableBlock || undefined);
    return { status: 'success', reason: `Pipeline successfully crafted ${targetItemName}.` };
  } catch (err: any) {
    return { status: 'failed', reason: `Crafting pipeline failed: ${err.message}` };
  }
}
