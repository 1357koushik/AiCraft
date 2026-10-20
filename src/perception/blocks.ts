import { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { AppConfig } from '../config/index.js';
import {
  BlocksState,
  BlockWalkability,
  HazardInfo,
  NotableBlockInfo,
  ImmediateBlocksInfo,
  LocalMapInfo,
} from '../types/index.js';
import { distance3D, getFacing } from '../utils/math.js';

const NOTABLE_BLOCK_TYPES: Record<string, string[]> = {
  log: ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log', 'pale_oak_log'],
  ore: [
    'coal_ore', 'deepslate_coal_ore', 'iron_ore', 'deepslate_iron_ore',
    'copper_ore', 'deepslate_copper_ore', 'gold_ore', 'deepslate_gold_ore',
    'redstone_ore', 'deepslate_redstone_ore', 'lapis_ore', 'deepslate_lapis_ore',
    'diamond_ore', 'deepslate_diamond_ore', 'emerald_ore', 'deepslate_emerald_ore'
  ],
  utility: ['crafting_table', 'furnace', 'blast_furnace', 'smoker', 'chest', 'barrel', 'anvil', 'enchanting_table'],
  bed: ['white_bed', 'red_bed', 'blue_bed', 'black_bed', 'yellow_bed', 'green_bed'],
  door_gate: ['oak_door', 'iron_door', 'oak_trapdoor', 'oak_fence_gate'],
  liquid: ['water', 'lava'],
  crop: ['wheat', 'carrots', 'potatoes', 'beetroots'],
};

export function extractBlocks(bot: Bot, config: AppConfig): BlocksState {
  const entity = bot.entity;
  const feetPos = entity ? entity.position.floored() : new Vec3(0, 0, 0);
  const yaw = entity?.yaw || 0;
  const facing = getFacing(yaw);

  // 1. Immediate blocks
  const blockBelow = bot.blockAt(feetPos.offset(0, -1, 0));
  const blockAtFeet = bot.blockAt(feetPos);
  const blockAtEye = bot.blockAt(feetPos.offset(0, 1, 0));
  const blockAboveHead = bot.blockAt(feetPos.offset(0, 2, 0));

  let aheadOffset = new Vec3(0, 0, 0);
  if (facing === 'north') aheadOffset = new Vec3(0, 0, -1);
  else if (facing === 'south') aheadOffset = new Vec3(0, 0, 1);
  else if (facing === 'east') aheadOffset = new Vec3(1, 0, 0);
  else if (facing === 'west') aheadOffset = new Vec3(-1, 0, 0);

  const blockDirectlyAhead = bot.blockAt(feetPos.plus(aheadOffset));

  const immediate: ImmediateBlocksInfo = {
    belowFeet: blockBelow?.name || 'air',
    atFeet: blockAtFeet?.name || 'air',
    atEyeLevel: blockAtEye?.name || 'air',
    directlyAhead: blockDirectlyAhead?.name || 'air',
    aboveHead: blockAboveHead?.name || 'air',
  };

  // 2. Walkability in 4 cardinal directions
  const directions: Record<'north' | 'south' | 'east' | 'west', Vec3> = {
    north: new Vec3(0, 0, -1),
    south: new Vec3(0, 0, 1),
    east: new Vec3(1, 0, 0),
    west: new Vec3(-1, 0, 0),
  };

  const walkability: BlockWalkability = {
    north: 'free',
    south: 'free',
    east: 'free',
    west: 'free',
  };

  for (const [dir, offset] of Object.entries(directions) as ['north' | 'south' | 'east' | 'west', Vec3][]) {
    const targetGround = bot.blockAt(feetPos.plus(offset).offset(0, -1, 0));
    const targetFeet = bot.blockAt(feetPos.plus(offset));
    const targetHead = bot.blockAt(feetPos.plus(offset).offset(0, 1, 0));
    const targetStepUp = bot.blockAt(feetPos.plus(offset).offset(0, 2, 0));

    if (targetFeet?.name === 'lava' || targetGround?.name === 'lava') {
      walkability[dir] = 'lava';
    } else if (targetFeet?.name === 'water') {
      walkability[dir] = 'water';
    } else if (targetFeet?.boundingBox === 'block' || targetHead?.boundingBox === 'block') {
      // Check if step-up (1 block higher) is clear
      const stepUpFeet = bot.blockAt(feetPos.plus(offset).offset(0, 1, 0));
      const stepUpHead = targetStepUp;
      if (stepUpFeet?.boundingBox !== 'block' && stepUpHead?.boundingBox !== 'block') {
        walkability[dir] = 'step_up';
      } else {
        walkability[dir] = 'blocked';
      }
    } else if (!targetGround || targetGround.boundingBox !== 'block') {
      // Check depth of drop
      let dropCount = 1;
      for (let dy = -2; dy >= -4; dy--) {
        const check = bot.blockAt(feetPos.plus(offset).offset(0, dy, 0));
        if (check && check.boundingBox === 'block') break;
        dropCount++;
      }
      walkability[dir] = dropCount >= 3 ? 'drop' : 'free';
    } else {
      walkability[dir] = 'free';
    }
  }

  // 3. Hazards Scan (within radius 6)
  const hazards: HazardInfo[] = [];
  const hazardRadius = 6;
  for (let dx = -hazardRadius; dx <= hazardRadius; dx++) {
    for (let dz = -hazardRadius; dz <= hazardRadius; dz++) {
      for (let dy = -4; dy <= 2; dy++) {
        const checkPos = feetPos.offset(dx, dy, dz);
        const b = bot.blockAt(checkPos);
        if (!b) continue;

        const name = b.name;
        let type: HazardInfo['type'] | null = null;
        if (name === 'lava') type = 'lava';
        else if (name === 'fire' || name === 'soul_fire') type = 'fire';
        else if (name === 'cactus') type = 'cactus';
        else if (name === 'sweet_berry_bush') type = 'sweet_berry_bush';
        else if (name === 'magma_block') type = 'magma';
        else if (name === 'cobweb') type = 'cobweb';
        else if (name === 'powder_snow') type = 'powder_snow';

        if (type) {
          hazards.push({
            type,
            position: { x: checkPos.x, y: checkPos.y, z: checkPos.z },
            distance: Math.round(distance3D(feetPos, checkPos) * 10) / 10,
          });
        }
      }
    }
  }

  // Sort hazards by distance and keep top 5
  hazards.sort((a, b) => a.distance - b.distance);
  const trimmedHazards = hazards.slice(0, 5);

  // 4. Notable Blocks Scan (radius from config, max 16)
  const scanR = Math.min(config.perception.scanRadius, 16);
  const notableMap: Record<string, { count: number; nearestDist: number; nearestPos: Vec3; name: string }> = {};

  for (let dx = -scanR; dx <= scanR; dx += 2) {
    for (let dz = -scanR; dz <= scanR; dz += 2) {
      for (let dy = -8; dy <= 8; dy += 2) {
        const checkPos = feetPos.offset(dx, dy, dz);
        const b = bot.blockAt(checkPos);
        if (!b || b.name === 'air') continue;

        const bName = b.name;
        let matchedCategory: string | null = null;

        for (const [cat, names] of Object.entries(NOTABLE_BLOCK_TYPES)) {
          if (names.some((n) => bName.includes(n))) {
            matchedCategory = cat;
            break;
          }
        }

        if (matchedCategory) {
          const dist = distance3D(feetPos, checkPos);
          if (!notableMap[bName]) {
            notableMap[bName] = { count: 1, nearestDist: dist, nearestPos: checkPos, name: bName };
          } else {
            notableMap[bName].count++;
            if (dist < notableMap[bName].nearestDist) {
              notableMap[bName].nearestDist = dist;
              notableMap[bName].nearestPos = checkPos;
            }
          }
        }
      }
    }
  }

  const notableBlocks: NotableBlockInfo[] = Object.values(notableMap).map((item) => {
    const diff = item.nearestPos.minus(feetPos);
    let dir = '';
    if (diff.z < -1) dir += 'N';
    if (diff.z > 1) dir += 'S';
    if (diff.x > 1) dir += 'E';
    if (diff.x < -1) dir += 'W';
    if (diff.y > 1) dir += ' (above)';
    if (diff.y < -1) dir += ' (below)';

    return {
      type: item.name,
      name: item.name,
      count: item.count,
      nearestDistance: Math.round(item.nearestDist * 10) / 10,
      nearestPosition: { x: item.nearestPos.x, y: item.nearestPos.y, z: item.nearestPos.z },
      direction: dir || 'here',
    };
  });

  notableBlocks.sort((a, b) => a.nearestDistance - b.nearestDistance);

  // 5. Local Map (9x9 grid)
  const mapSize = config.perception.localMapSize || 9;
  const half = Math.floor(mapSize / 2);
  const grid: string[][] = [];

  const legend: Record<string, string> = {
    P: 'Bot',
    '.': 'Passable/Ground (solid floor support & clear headroom)',
    '#': 'Wall/Solid obstacle',
    v: 'Drop/Cliff/Gap (no solid floor support)',
    '?': 'Unknown/Unloaded chunk data',
    T: 'Wood/Tree',
    '~': 'Foliage/Leaves',
    W: 'Water',
    L: 'Lava/Hazard',
    O: 'Ore',
    C: 'Crafting/Chest/Furnace',
  };

  for (let z = -half; z <= half; z++) {
    const row: string[] = [];
    for (let x = -half; x <= half; x++) {
      if (x === 0 && z === 0) {
        row.push('P');
        continue;
      }

      // Check vertical slice: at feet (0), at eye (1), ground (-1)
      const bGround = bot.blockAt(feetPos.offset(x, -1, z));
      const bFeet = bot.blockAt(feetPos.offset(x, 0, z));
      const bHead = bot.blockAt(feetPos.offset(x, 1, z));

      // 1. Unloaded / Unknown block data
      if (bFeet === null || bGround === null) {
        row.push('?');
        continue;
      }

      const fName = bFeet.name || 'air';
      const gName = bGround.name || 'air';

      // 2. Liquids and hazards
      if (fName === 'water' || gName === 'water') {
        row.push('W');
      } else if (fName === 'lava' || gName === 'lava' || fName === 'fire') {
        row.push('L');
      } else if (fName.includes('log') || bHead?.name?.includes('log')) {
        row.push('T');
      } else if (fName.includes('leaves') || bHead?.name?.includes('leaves')) {
        row.push('~');
      } else if (fName.includes('ore') || gName.includes('ore')) {
        row.push('O');
      } else if (['crafting_table', 'chest', 'furnace', 'barrel'].includes(fName)) {
        row.push('C');
      } else if (bFeet.boundingBox === 'block' || bHead?.boundingBox === 'block') {
        row.push('#');
      } else if (bGround.boundingBox !== 'block') {
        // Air beneath feet: cliff / unsupported drop / void!
        row.push('v');
      } else {
        // Confirmed solid floor support with clear headroom
        row.push('.');
      }
    }
    grid.push(row);
  }

  const asciiRows = grid.map((r) => r.join(' ')).join('\n');

  return {
    immediate,
    walkability,
    hazards: trimmedHazards,
    notableBlocks: notableBlocks.slice(0, 10),
    localMap: {
      grid,
      ascii: asciiRows,
      legend,
      size: mapSize,
      origin: { x: feetPos.x, y: feetPos.y, z: feetPos.z },
    },
  };
}
