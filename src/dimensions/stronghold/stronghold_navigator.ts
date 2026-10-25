import { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';

export const STRONGHOLD_BLOCKS = new Set([
  'stone_bricks',
  'mossy_stone_bricks',
  'cracked_stone_bricks',
  'chiseled_stone_bricks',
  'iron_bars',
  'end_portal_frame',
  'end_portal',
]);

/**
 * Checks if a block name belongs to a Stronghold structure.
 */
export function isStrongholdBlock(blockName?: string | null): boolean {
  if (!blockName) return false;
  return STRONGHOLD_BLOCKS.has(blockName.toLowerCase());
}

/**
 * Scans for an End Portal Frame block indicating the presence of the End Portal Room.
 */
export function findPortalRoom(bot: Bot, maxDistance: number = 48): Vec3 | null {
  if (!bot.findBlock) return null;
  const frame = bot.findBlock({
    matching: (b: any) => b.name === 'end_portal_frame',
    maxDistance,
  });
  return frame ? frame.position : null;
}

/**
 * Finds all 12 End Portal Frame blocks around the portal room center.
 */
export function findAllPortalFrames(bot: Bot, center: Vec3, maxDistance: number = 6): any[] {
  if (!bot.findBlocks) {
    if (bot.findBlock) {
      const single = bot.findBlock({ matching: (b: any) => b.name === 'end_portal_frame', maxDistance });
      return single ? [single] : [];
    }
    return [];
  }

  const positions = bot.findBlocks({
    matching: (b: any) => b.name === 'end_portal_frame',
    maxDistance,
    count: 12,
  });

  return positions.map((p) => (bot.blockAt ? bot.blockAt(p) : { name: 'end_portal_frame', position: p })).filter(Boolean);
}
