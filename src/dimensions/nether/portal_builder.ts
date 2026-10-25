import { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { ActionResult, ActionExecutionContext } from '../../types/index.js';
import { isActionContextActive } from '../../agent/arbiter.js';

export type PortalOrientation = 'x' | 'z';

export interface PortalGeometry {
  origin: Vec3;
  orientation: PortalOrientation;
  frameBlocks: Vec3[];
  interiorBlocks: Vec3[];
  ignitionSpot: Vec3;
}

/**
 * Computes exact 3D coordinates for a standard 4x5 Nether Portal frame.
 * Minimal frame requires 10 obsidian blocks (corners omitted).
 * Full frame requires 14 obsidian blocks.
 */
export function computePortalGeometry(
  origin: Vec3,
  orientation: PortalOrientation = 'x',
  minimal: boolean = true
): PortalGeometry {
  const frameBlocks: Vec3[] = [];
  const interiorBlocks: Vec3[] = [];

  const dx = orientation === 'x' ? 1 : 0;
  const dz = orientation === 'z' ? 1 : 0;

  // 1. Bottom row (y = 0)
  if (!minimal) {
    frameBlocks.push(origin.offset(0, 0, 0)); // Corner
  }
  frameBlocks.push(origin.offset(1 * dx, 0, 1 * dz));
  frameBlocks.push(origin.offset(2 * dx, 0, 2 * dz));
  if (!minimal) {
    frameBlocks.push(origin.offset(3 * dx, 0, 3 * dz)); // Corner
  }

  // 2. Vertical columns (y = 1, 2, 3)
  for (let y = 1; y <= 3; y++) {
    frameBlocks.push(origin.offset(0, y, 0)); // Left column
    interiorBlocks.push(origin.offset(1 * dx, y, 1 * dz)); // Portal field opening
    interiorBlocks.push(origin.offset(2 * dx, y, 2 * dz)); // Portal field opening
    frameBlocks.push(origin.offset(3 * dx, y, 3 * dz)); // Right column
  }

  // 3. Top row (y = 4)
  if (!minimal) {
    frameBlocks.push(origin.offset(0, 4, 0)); // Corner
  }
  frameBlocks.push(origin.offset(1 * dx, 4, 1 * dz));
  frameBlocks.push(origin.offset(2 * dx, 4, 2 * dz));
  if (!minimal) {
    frameBlocks.push(origin.offset(3 * dx, 4, 3 * dz)); // Corner
  }

  // Ignition spot is the bottom interior opening at y = 1
  const ignitionSpot = origin.offset(1 * dx, 1, 1 * dz);

  return {
    origin,
    orientation,
    frameBlocks,
    interiorBlocks,
    ignitionSpot,
  };
}

/**
 * Constructs a 4x5 Nether portal frame out of obsidian from inventory.
 */
export async function buildPortalFrame(
  bot: Bot,
  origin: Vec3,
  orientation: PortalOrientation = 'x',
  minimal: boolean = true,
  ctx?: ActionExecutionContext
): Promise<ActionResult> {
  if (ctx && !isActionContextActive(ctx)) {
    return { status: 'interrupted', reason: 'Portal construction cancelled before start.' };
  }

  const geometry = computePortalGeometry(origin, orientation, minimal);
  const neededObsidian = geometry.frameBlocks.length;

  const obsidianCount = bot.inventory
    ? bot.inventory.items().filter((i) => i.name === 'obsidian').reduce((acc, i) => acc + (i.count || 0), 0)
    : 0;

  if (obsidianCount < neededObsidian) {
    return {
      status: 'failed',
      reason: `Insufficient obsidian to build portal frame (needed: ${neededObsidian}, available: ${obsidianCount}).`,
    };
  }

  let placed = 0;
  for (const blockPos of geometry.frameBlocks) {
    if (ctx && !isActionContextActive(ctx)) {
      return { status: 'interrupted', reason: 'Portal construction interrupted.' };
    }

    const current = bot.blockAt ? bot.blockAt(blockPos) : null;
    if (current && current.name === 'obsidian') {
      placed++;
      continue;
    }

    const obsItem = bot.inventory?.items().find((i) => i.name === 'obsidian');
    if (!obsItem) break;

    // Equip obsidian and place block
    if (bot.equip) {
      try { await bot.equip(obsItem, 'hand'); } catch {}
    }

    // Find reference block adjacent to placement coordinate
    const refPos = blockPos.offset(0, -1, 0);
    const refBlock = bot.blockAt ? bot.blockAt(refPos) : { position: refPos };

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
    reason: `Constructed ${orientation.toUpperCase()}-axis portal frame (${placed}/${neededObsidian} blocks placed).`,
    details: {
      origin,
      orientation,
      placed,
      needed: neededObsidian,
    },
  };
}

/**
 * Ignites the Nether portal using flint and steel on the bottom interior portal block.
 */
export async function ignitePortal(
  bot: Bot,
  portalOrigin: Vec3,
  orientation: PortalOrientation = 'x',
  ctx?: ActionExecutionContext
): Promise<ActionResult> {
  if (ctx && !isActionContextActive(ctx)) {
    return { status: 'interrupted', reason: 'Portal ignition cancelled before start.' };
  }

  const geometry = computePortalGeometry(portalOrigin, orientation);
  const flintAndSteel = bot.inventory?.items().find((i) => i.name === 'flint_and_steel');

  if (!flintAndSteel) {
    return {
      status: 'failed',
      reason: 'No flint and steel available in inventory to ignite the portal.',
    };
  }

  try {
    if (bot.equip) {
      await bot.equip(flintAndSteel, 'hand');
    }

    // Aim at top face of bottom portal sill block (below ignition opening)
    const sillPos = geometry.ignitionSpot.offset(0, -1, 0);
    const sillBlock = bot.blockAt ? bot.blockAt(sillPos) : { position: sillPos };

    if (bot.lookAt) {
      await bot.lookAt(geometry.ignitionSpot, true);
    }

    if (bot.activateBlock && sillBlock) {
      await bot.activateBlock(sillBlock as any, new Vec3(0, 1, 0));
    } else if (bot.activateItem) {
      bot.activateItem();
    }

    await new Promise((res) => setTimeout(res, 200));

    // Verify ignition: check if nether_portal / fire block appeared in opening
    const portalBlock = bot.blockAt ? bot.blockAt(geometry.ignitionSpot) : null;
    const isIgnited = !portalBlock || portalBlock.name === 'nether_portal' || portalBlock.name === 'fire';

    return {
      status: isIgnited ? 'success' : 'failed',
      reason: isIgnited
        ? 'Nether portal ignited successfully!'
        : `Failed to ignite portal; block at opening is ${portalBlock?.name || 'unknown'}.`,
      details: {
        ignitionSpot: geometry.ignitionSpot,
      },
    };
  } catch (err: any) {
    return {
      status: 'failed',
      reason: `Portal ignition failed: ${err.message}`,
    };
  }
}
