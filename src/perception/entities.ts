import { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { AppConfig } from '../config/index.js';
import { EntityInfo } from '../types/index.js';
import { distance3D, hasLineOfSight } from '../utils/math.js';

const HOSTILE_MOBS = new Set([
  'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'enderman',
  'witch', 'slime', 'drowned', 'husk', 'stray', 'phantom', 'pillager',
  'vindicator', 'evoker', 'ravager', 'vex', 'silverfish', 'blaze',
  'ghast', 'magma_cube', 'wither_skeleton', 'hoglin', 'piglin_brute',
  'warden', 'breeze', 'bogged',
]);

const PASSIVE_ANIMALS = new Set([
  'cow', 'sheep', 'pig', 'chicken', 'horse', 'donkey', 'mule',
  'rabbit', 'cat', 'ocelot', 'fox', 'wolf', 'bat', 'squid', 'glow_squid',
  'parrot', 'llama', 'turtle', 'axolotl', 'frog', 'sniffer', 'camel', 'armadillo',
]);

export function extractEntities(bot: Bot, config: AppConfig, idMap?: Map<number, string>): EntityInfo[] {
  if (!bot.entity) return [];
  const botPos = bot.entity.position;
  const maxRadius = config.perception.entityRadius || 20;

  const rawEntities = Object.values(bot.entities).filter((e) => {
    if (!e || e === bot.entity) return false;
    const dist = distance3D(botPos, e.position);
    return dist <= maxRadius;
  });

  // Sort by distance so e1, e2, etc. are closest first
  rawEntities.sort((a, b) => distance3D(botPos, a.position) - distance3D(botPos, b.position));

  const result: EntityInfo[] = [];
  let next = idMap ? idMap.size + 1 : 1;

  for (const ent of rawEntities) {
    let id = idMap?.get(ent.id);
    if (!id) {
      id = `e${next++}`;
      idMap?.set(ent.id, id);
    }
    const rawType = ent.name || ent.type || 'unknown';
    const isPlayer = ent.type === 'player';
    const username = ent.username || rawType;
    const isOwner = Boolean(isPlayer && config.agent.owners.includes(username));
    const isHostile = HOSTILE_MOBS.has(rawType);
    const isPassive = PASSIVE_ANIMALS.has(rawType);
    const isItem = ent.name === 'item' || rawType === 'item';

    // Item details
    let itemName = rawType;
    let itemCount = 1;
    if (isItem && (ent as any).metadata) {
      const itemMeta = (ent as any).metadata[8] || (ent as any).metadata[7] || (ent as any).metadata[6];
      if (itemMeta && itemMeta.itemId) {
        const itemDef = bot.registry.items[itemMeta.itemId];
        if (itemDef) {
          itemName = itemDef.name;
          itemCount = itemMeta.itemCount || 1;
        }
      }
    }

    // Line of sight
    const los = hasLineOfSight(bot, ent.position.offset(0, ent.height ? ent.height / 2 : 0.8, 0));

    // Health: only report if directly observed, otherwise 'unknown'
    const healthObserved = (ent as any).health !== undefined ? Math.round((ent as any).health) : 'unknown';

    result.push({
      id,
      rawId: ent.id,
      type: rawType,
      name: isItem ? itemName : (isPlayer ? username : rawType),
      distance: Math.round(distance3D(botPos, ent.position) * 10) / 10,
      relativePos: {
        x: Math.round((ent.position.x - botPos.x) * 10) / 10,
        y: Math.round((ent.position.y - botPos.y) * 10) / 10,
        z: Math.round((ent.position.z - botPos.z) * 10) / 10,
      },
      position: {
        x: Math.round(ent.position.x * 10) / 10,
        y: Math.round(ent.position.y * 10) / 10,
        z: Math.round(ent.position.z * 10) / 10,
      },
      isOwner,
      isHostile,
      isPassive,
      isItem,
      itemCount: isItem ? itemCount : undefined,
      lineOfSight: los,
      health: healthObserved,
    });

    if (result.length >= 25) break; // Limit entity list size
  }

  return result;
}
