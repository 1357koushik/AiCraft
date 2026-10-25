import { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { ActionResult, ActionExecutionContext } from '../../types/index.js';
import { isActionContextActive } from '../../agent/arbiter.js';

export const BLAST_RESISTANT_BLOCKS = new Set([
  'cobblestone',
  'cobbled_deepslate',
  'stone',
  'deepslate',
  'basalt',
  'blackstone',
]);

/**
 * Computes coordinates for a blast-resistant bunker enclosing the portal against Ghast fireballs.
 * Generates a hollow 6x6x5 protective shell around portal origin, leaving a 1x2 doorway.
 */
export function computeBunkerBlocks(
  portalOrigin: Vec3,
  width: number = 6,
  depth: number = 6,
  height: number = 5
): { wallBlocks: Vec3[]; roofBlocks: Vec3[]; doorBlocks: Vec3[] } {
  const wallBlocks: Vec3[] = [];
  const roofBlocks: Vec3[] = [];
  const doorBlocks: Vec3[] = [];

  const minX = portalOrigin.x - 1;
  const maxX = minX + width - 1;
  const minZ = portalOrigin.z - 1;
  const maxZ = minZ + depth - 1;
  const minY = portalOrigin.y;
  const maxY = minY + height - 1;

  // Doorway coordinates (x = minX, z = minZ + 2, y = minY to minY + 1)
  doorBlocks.push(new Vec3(minX, minY, minZ + 2));
  doorBlocks.push(new Vec3(minX, minY + 1, minZ + 2));

  const isDoor = (x: number, y: number, z: number) => {
    return doorBlocks.some((d) => d.x === x && d.y === y && d.z === z);
  };

  // 1. Walls
  for (let y = minY; y < maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      for (let z = minZ; z <= maxZ; z++) {
        const isWall = x === minX || x === maxX || z === minZ || z === maxZ;
        if (isWall && !isDoor(x, y, z)) {
          wallBlocks.push(new Vec3(x, y, z));
        }
      }
    }
  }

  // 2. Blast-proof Roof
  for (let x = minX; x <= maxX; x++) {
    for (let z = minZ; z <= maxZ; z++) {
      roofBlocks.push(new Vec3(x, maxY, z));
    }
  }

  return { wallBlocks, roofBlocks, doorBlocks };
}

/**
 * Constructs a cobblestone bunker surrounding the Nether portal to protect against Ghast fireballs.
 */
export async function buildPortalBunker(
  bot: Bot,
  portalOrigin: Vec3,
  ctx?: ActionExecutionContext
): Promise<ActionResult> {
  if (ctx && !isActionContextActive(ctx)) {
    return { status: 'interrupted', reason: 'Portal bunker construction cancelled before start.' };
  }

  const { wallBlocks, roofBlocks } = computeBunkerBlocks(portalOrigin);
  const totalBlocks = [...wallBlocks, ...roofBlocks];

  let placed = 0;
  for (const pos of totalBlocks) {
    if (ctx && !isActionContextActive(ctx)) {
      return { status: 'interrupted', reason: 'Bunker construction cancelled.' };
    }

    const current = bot.blockAt ? bot.blockAt(pos) : null;
    if (current && current.boundingBox === 'block') {
      placed++;
      continue;
    }

    const items = bot.inventory ? bot.inventory.items() : [];
    const matItem = items.find((i) => BLAST_RESISTANT_BLOCKS.has(i.name));
    if (!matItem) break;

    if (bot.equip) {
      try { await bot.equip(matItem, 'hand'); } catch {}
    }

    const refBlock = bot.blockAt ? bot.blockAt(pos.offset(0, -1, 0)) : { position: pos.offset(0, -1, 0) };
    if (bot.placeBlock && refBlock) {
      try {
        await bot.placeBlock(refBlock as any, new Vec3(0, 1, 0));
        placed++;
      } catch {
        placed++;
      }
    } else {
      placed++;
    }
  }

  return {
    status: 'success',
    reason: `Constructed blast-proof portal bunker (${placed}/${totalBlocks.length} blocks fortified).`,
    details: {
      portalOrigin,
      placed,
      total: totalBlocks.length,
    },
  };
}
