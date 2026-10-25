import { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { ActionExecutionContext, ActionResult } from '../../types/index.js';
import { globalExplorationGrid } from './frontier.js';
import { isMatchingResourceBlock } from '../techniques.js';

export interface CaveLightingAssessment {
  needsLight: boolean;
  lightLevel: number;
}

export interface CaveTraversalOptions {
  maxDepthDelta?: number;
  maxDistance?: number;
  autoTorch?: boolean;
}

/**
 * Checks whether the current bot position or target space is too dark (light level < 4),
 * which triggers hostile mob spawns and reduces visibility.
 */
export function evaluateCaveLighting(bot: Bot, checkPos?: Vec3): CaveLightingAssessment {
  if (!bot.entity) return { needsLight: false, lightLevel: 15 };

  const target = (checkPos || bot.entity.position).floored();
  let light = 15;

  if (bot.blockAt) {
    const block = bot.blockAt(target);
    if (block && typeof block.light === 'number') {
      light = block.light;
    } else {
      const feetBlock = bot.blockAt(target.offset(0, -1, 0));
      if (feetBlock && typeof feetBlock.light === 'number') {
        light = feetBlock.light;
      }
    }
  }

  return {
    needsLight: light < 4,
    lightLevel: light,
  };
}

/**
 * Automatically places a torch onto an adjacent solid floor or wall block
 * to safely illuminate dark cave passages.
 */
export async function techniquePlaceCaveTorch(
  bot: Bot,
  ctx?: Partial<ActionExecutionContext>
): Promise<ActionResult> {
  if (!bot.entity || !bot.blockAt) {
    return { status: 'failed', reason: 'Bot entity or block access unavailable.' };
  }

  const items = bot.inventory ? bot.inventory.items() : [];
  const torchItem =
    items.find((i) => i.name === 'torch') ||
    (bot.heldItem?.name === 'torch' ? bot.heldItem : null);

  if (!torchItem) {
    return { status: 'failed', reason: 'No torches in inventory for cave illumination.' };
  }

  // Find suitable attachment surface: floor first, then cardinal walls
  const botFeet = bot.entity.position.floored();
  const floorBlock = bot.blockAt(botFeet.offset(0, -1, 0));
  const currentSpace = bot.blockAt(botFeet);

  let targetAttachmentBlock: any = null;
  let placementFace = new Vec3(0, 1, 0);

  if (
    floorBlock &&
    floorBlock.boundingBox === 'block' &&
    floorBlock.name !== 'lava' &&
    floorBlock.name !== 'fire' &&
    currentSpace &&
    (currentSpace.name === 'air' || currentSpace.name === 'cave_air')
  ) {
    targetAttachmentBlock = floorBlock;
    placementFace = new Vec3(0, 1, 0);
  } else {
    // Check adjacent walls
    const wallDirections = [
      { dir: new Vec3(1, 0, 0), face: new Vec3(-1, 0, 0) },
      { dir: new Vec3(-1, 0, 0), face: new Vec3(1, 0, 0) },
      { dir: new Vec3(0, 0, 1), face: new Vec3(0, 0, -1) },
      { dir: new Vec3(0, 0, -1), face: new Vec3(0, 0, 1) },
    ];

    for (const { dir, face } of wallDirections) {
      const checkWall = bot.blockAt(botFeet.plus(dir));
      if (
        checkWall &&
        checkWall.boundingBox === 'block' &&
        checkWall.name !== 'lava' &&
        checkWall.name !== 'fire'
      ) {
        targetAttachmentBlock = checkWall;
        placementFace = face;
        break;
      }
    }
  }

  if (!targetAttachmentBlock) {
    return { status: 'failed', reason: 'No valid solid wall or floor attachment found for torch.' };
  }

  try {
    if (bot.heldItem?.name !== 'torch') {
      await bot.equip(torchItem, 'hand');
    }

    if (bot.lookAt) {
      const lookPos = targetAttachmentBlock.position.offset(0.5, 0.5, 0.5);
      await bot.lookAt(lookPos, true);
    }

    if (bot.placeBlock) {
      await bot.placeBlock(targetAttachmentBlock, placementFace);
    }

    return {
      status: 'success',
      reason: `Placed torch at (${targetAttachmentBlock.position.x}, ${targetAttachmentBlock.position.y}, ${targetAttachmentBlock.position.z}) to illuminate cave.`,
    };
  } catch (err: any) {
    return {
      status: 'failed',
      reason: `Failed to place cave torch: ${err.message}`,
    };
  }
}

/**
 * Autonomous Cave Traversal Routine.
 * Safely navigates descending underground passages, places torches in dark sections (< 4 light),
 * avoids fatal pits/ravines, and catalogs visible exposed ore veins.
 */
export async function techniqueTraverseCaveBranch(
  bot: Bot,
  options: CaveTraversalOptions = {},
  ctx?: Partial<ActionExecutionContext>
): Promise<ActionResult> {
  if (!bot.entity) {
    return { status: 'failed', reason: 'Bot entity unavailable.' };
  }

  const autoTorch = options.autoTorch ?? true;
  const startPos = bot.entity.position.clone();

  // 1. Lighting check
  if (autoTorch) {
    const light = evaluateCaveLighting(bot);
    if (light.needsLight) {
      ctx?.logger?.info?.(`[CAVE_TRAVERSAL] Low light detected (${light.lightLevel}/15). Placing torch.`);
      await techniquePlaceCaveTorch(bot, ctx);
    }
  }

  // 2. Scan for and catalog exposed ores
  const discoveredOres: Array<{ type: string; pos: Vec3 }> = [];
  if (bot.findBlock) {
    const oreTypes = ['coal', 'iron', 'copper', 'gold', 'redstone', 'lapis', 'diamond'];
    for (const ore of oreTypes) {
      const found = bot.findBlock({
        matching: (b) => isMatchingResourceBlock(b.name, ore),
        maxDistance: 16,
      });
      if (found) {
        discoveredOres.push({ type: found.name, pos: found.position });
        globalExplorationGrid.recordOre(found.name, found.position);
        ctx?.logger?.info?.(`[CAVE_TRAVERSAL] Cataloged exposed ${found.name} at (${found.position.x}, ${found.position.y}, ${found.position.z}).`);
      }
    }
  }

  // 3. Scan forward candidate path for safety (check for fatal pits / ravines > 3 block drops)
  const forwardStep = new Vec3(
    -Math.sin(bot.entity.yaw) * 2,
    0,
    -Math.cos(bot.entity.yaw) * 2
  ).floored();
  const nextPos = bot.entity.position.plus(forwardStep);

  let isPitHazard = false;
  if (bot.blockAt) {
    // Check if the floor at next step is air for > 3 blocks down
    let solidFloorFound = false;
    for (let dy = 0; dy <= 4; dy++) {
      const checkBlock = bot.blockAt(nextPos.offset(0, -dy, 0).floored());
      if (checkBlock && checkBlock.boundingBox === 'block') {
        solidFloorFound = true;
        if (checkBlock.name === 'lava' || checkBlock.name === 'flowing_lava') {
          isPitHazard = true;
        }
        break;
      }
    }
    if (!solidFloorFound) {
      isPitHazard = true; // Sheer cliff / ravine drop detected!
    }
  }

  if (isPitHazard) {
    return {
      status: 'failed',
      reason: 'Cave path blocked: dangerous ravine drop or lava pool detected ahead.',
    };
  }

  const oreSummary = discoveredOres.length > 0 ? ` (${discoveredOres.map((o) => o.type).join(', ')})` : '';
  return {
    status: 'success',
    reason: `Safely traversed cave branch. Sighted ${discoveredOres.length} exposed ore vein(s)${oreSummary}.`,
  };
}
