import { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { AppConfig } from '../config/index.js';
import {
  Observation,
  PositionState,
  EnvironmentState,
  StatusEffectInfo,
  CrosshairInfo,
  ContainerState,
  AgentInternalState,
  MemoryNotes,
  RecentEventsState,
  AvailableActionCatalogItem,
  DayPhase,
} from '../types/index.js';
import { extractVitals } from './vitals.js';
import { extractInventory } from './inventory.js';
import { extractBlocks } from './blocks.js';
import { extractEntities } from './entities.js';
import { getFacing, distance3D } from '../utils/math.js';

export function buildObservation(
  bot: Bot,
  config: AppConfig,
  agentState: AgentInternalState,
  memory: MemoryNotes,
  recentEvents: RecentEventsState,
  availableActions: AvailableActionCatalogItem[]
): Observation {
  const entity = bot.entity;
  const pos = entity ? entity.position : new Vec3(0, 64, 0);
  const yaw = entity?.yaw || 0;
  const pitch = entity?.pitch || 0;
  const facing = getFacing(yaw);

  // 1. Position and Orientation
  const blockCoords = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
  const altitudeAboveSeaLevel = blockCoords.y - 63;
  const skyExposed = Boolean(bot.blockAt(pos)?.skyLight === 15);
  const isUnderground = altitudeAboveSeaLevel < 0 || (!skyExposed && blockCoords.y < 55);

  const homePos = memory.namedLocations['home'];
  const distanceToHome = homePos ? Math.round(distance3D(blockCoords, homePos) * 10) / 10 : undefined;

  const positionState: PositionState = {
    x: Math.round(pos.x * 100) / 100,
    y: Math.round(pos.y * 100) / 100,
    z: Math.round(pos.z * 100) / 100,
    blockCoords,
    velocity: {
      x: Math.round((entity?.velocity?.x || 0) * 100) / 100,
      y: Math.round((entity?.velocity?.y || 0) * 100) / 100,
      z: Math.round((entity?.velocity?.z || 0) * 100) / 100,
    },
    yaw: Math.round(yaw * 100) / 100,
    pitch: Math.round(pitch * 100) / 100,
    facing,
    dimension: (bot.game?.dimension as any) || 'overworld',
    biome: bot.blockAt(pos)?.biome?.name || 'unknown',
    depthContext: {
      skyExposed,
      isUnderground,
      altitudeAboveSeaLevel,
    },
    spawnOrBed: bot.spawnPoint ? { x: bot.spawnPoint.x, y: bot.spawnPoint.y, z: bot.spawnPoint.z } : undefined,
    lastDeath: memory.namedLocations['last_death'],
    distanceToHome,
  };

  // 2. Time, Weather, Light
  const timeOfDay = bot.time?.timeOfDay ?? 6000;
  const worldAge = bot.time?.age ?? 0;
  const dayCount = Math.floor(worldAge / 24000);
  const moonPhase = bot.time?.moonPhase ?? 0;

  let dayPhase: DayPhase = 'day';
  if (timeOfDay >= 23000 || timeOfDay < 1000) dayPhase = 'dawn';
  else if (timeOfDay >= 1000 && timeOfDay < 12000) dayPhase = 'day';
  else if (timeOfDay >= 12000 && timeOfDay < 13500) dayPhase = 'dusk';
  else dayPhase = 'night';

  const isRaining = Boolean(bot.isRaining);
  const isThundering = Boolean(bot.thunderState && bot.thunderState > 0);
  const weather = isThundering ? 'thunder' : (isRaining ? 'rain' : 'clear');

  const currentBlock = bot.blockAt(pos);
  const lightLevelAtFeet = {
    block: (currentBlock as any)?.blockLight ?? 0,
    sky: currentBlock?.skyLight ?? 15,
    total: currentBlock?.light ?? 15,
  };

  const environmentState: EnvironmentState = {
    timeOfDay,
    worldAge,
    dayPhase,
    dayCount,
    moonPhase,
    weather,
    lightLevelAtFeet,
    openSky: skyExposed,
    difficulty: bot.game?.difficulty || 'normal',
    ping: (bot.player as any)?.ping || 0,
  };

  // 3. Status effects
  const statusEffects: StatusEffectInfo[] = [];
  if ((bot as any).entity?.effects) {
    for (const [id, eff] of Object.entries((bot as any).entity.effects) as [string, any][]) {
      const effDef = bot.registry.effects[id as any];
      statusEffects.push({
        name: effDef?.name || `effect_${id}`,
        level: (eff.amplifier || 0) + 1,
        durationSeconds: eff.duration !== undefined ? Math.round(eff.duration / 20) : 'unknown',
      });
    }
  }

  // 4. Crosshair inspection
  let crosshair: CrosshairInfo = { block: null, entity: null };
  try {
    const blockInSight = bot.blockAtCursor(4.5);
    if (blockInSight) {
      const dist = distance3D(pos.offset(0, 1.6, 0), blockInSight.position);
      const heldItem = bot.heldItem;
      const canHarvest = blockInSight.canHarvest(heldItem ? heldItem.type : null);
      const digTimeMs = blockInSight.digTime(heldItem ? heldItem.type : null, false, false, false);

      crosshair.block = {
        name: blockInSight.name,
        position: { x: blockInSight.position.x, y: blockInSight.position.y, z: blockInSight.position.z },
        distance: Math.round(dist * 10) / 10,
        face: 'top',
        harvestable: canHarvest,
        digTimeEstSeconds: Math.round((digTimeMs / 1000) * 10) / 10,
        properties: blockInSight.getProperties ? blockInSight.getProperties() : {},
      };
    }

    const entityInSight = bot.entityAtCursor(3.5);
    if (entityInSight) {
      crosshair.entity = {
        id: `e_cursor`,
        rawId: entityInSight.id,
        type: entityInSight.name || entityInSight.type || 'unknown',
        name: entityInSight.username || entityInSight.name || 'entity',
        distance: Math.round(distance3D(pos.offset(0, 1.6, 0), entityInSight.position) * 10) / 10,
      };
    }
  } catch {
    // Crosshair inspection non-critical
  }

  // 5. Container window state
  const currentWindow = bot.currentWindow;
  const containerState: ContainerState = {
    isOpen: Boolean(currentWindow && currentWindow.type !== 'minecraft:inventory'),
    type: currentWindow?.type !== undefined ? String(currentWindow.type) : null,
    title: (currentWindow as any)?.title || undefined,
    slotsCount: currentWindow?.slots?.length || 0,
    items: currentWindow?.slots?.map((s) => (s ? { slot: s.slot, name: s.name, count: s.count } : null)) || [],
  };

  // Combine components
  return {
    version: '1.21.6',
    timestamp: Date.now(),
    vitals: extractVitals(bot),
    position: positionState,
    environment: environmentState,
    statusEffects,
    inventory: extractInventory(bot, config.agent.handedness),
    crosshair,
    blocks: extractBlocks(bot, config),
    entities: extractEntities(bot, config),
    recentEvents,
    container: containerState,
    agentState,
    memory,
    derived: {
      availableActions,
    },
  };
}
