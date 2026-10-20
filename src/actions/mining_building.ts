import { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { goals } from 'mineflayer-pathfinder';
import { ActionDef, ActionExecutionContext, ActionResult } from '../types/index.js';
import { distance3D } from '../utils/math.js';
import {
  techniqueChopTreeFull,
  techniqueMineStaircase,
  techniqueBuildShelter,
  techniqueVacuumDrops,
  updatePathfinderMovements,
} from './techniques.js';

async function autoEquipBestTool(bot: Bot, block: any): Promise<void> {
  if (!bot.inventory) return;
  const items = bot.inventory.items();
  let bestItem: any = null;
  let fastestTime = Infinity;

  for (const it of items) {
    if (it.name.includes('pickaxe') || it.name.includes('axe') || it.name.includes('shovel') || it.name.includes('hoe') || it.name.includes('shears')) {
      const time = block.digTime(it.type, false, false, false);
      if (time < fastestTime) {
        fastestTime = time;
        bestItem = it;
      }
    }
  }

  if (bestItem && bot.heldItem?.type !== bestItem.type) {
    try {
      await bot.equip(bestItem, 'hand');
    } catch {}
  }
}

export const miningBuildingActions: ActionDef[] = [
  {
    name: 'dig_block',
    category: 'mining_building',
    description: 'Dig a specific block in reach or at known coordinates with the best tool.',
    parameterSchema: {
      blockType: { type: 'string', description: 'Block name (e.g. oak_log, stone)' },
      x: { type: 'number' },
      y: { type: 'number' },
      z: { type: 'number' },
    },
    isAvailable: (bot, obs) => obs.vitals.isAlive && !obs.container.isOpen,
    getAvailableChoices: (bot, obs) => ({
      blockType: obs.blocks.notableBlocks.map((b) => b.name),
    }),
    execute: async (bot: Bot, params: any, ctx: ActionExecutionContext): Promise<ActionResult> => {
      let targetBlock: any = null;

      if (params.x !== undefined && params.y !== undefined && params.z !== undefined) {
        targetBlock = bot.blockAt(new Vec3(params.x, params.y, params.z));
      } else if (params.blockType) {
        targetBlock = bot.findBlock({
          matching: (b) => b.name === params.blockType,
          maxDistance: 4.5,
        });
      }

      if (!targetBlock || targetBlock.name === 'air' || targetBlock.name === 'bedrock') {
        return { status: 'failed', reason: 'No diggable block found at target.' };
      }

      const dist = distance3D(bot.entity.position.offset(0, 1.6, 0), targetBlock.position);
      if (dist > 4.5) {
        try {
          const goal = new goals.GoalGetToBlock(targetBlock.position.x, targetBlock.position.y, targetBlock.position.z);
          await (bot as any).pathfinder.goto(goal);
        } catch (err: any) {
          return { status: 'failed', reason: `Cannot reach block: ${err.message}` };
        }
      }

      await autoEquipBestTool(bot, targetBlock);

      try {
        await bot.dig(targetBlock);
        return { status: 'success', reason: `Dug ${targetBlock.name} at ${targetBlock.position.x}, ${targetBlock.position.y}, ${targetBlock.position.z}.` };
      } catch (err: any) {
        return { status: 'failed', reason: `Digging interrupted: ${err.message}` };
      }
    },
  },
  {
    name: 'mine_resource',
    category: 'mining_building',
    description: 'Macro to find, approach, and mine up to [count] blocks of a specified resource (e.g. oak_log, coal_ore, stone).',
    parameterSchema: {
      blockType: { type: 'string', description: 'Name of the block to mine (e.g. oak_log, iron_ore, dirt)' },
      count: { type: 'number', description: 'Number of blocks to mine (1 to 8)' },
    },
    isAvailable: (bot, obs) => obs.vitals.isAlive && obs.blocks.notableBlocks.length > 0 && !obs.container.isOpen,
    getAvailableChoices: (bot, obs) => ({
      blockType: obs.blocks.notableBlocks.map((b) => b.name),
    }),
    execute: async (bot: Bot, params: any, ctx: ActionExecutionContext): Promise<ActionResult> => {
      const targetType = params.blockType || 'oak_log';
      const maxCount = Math.min(params.count || 1, 8);
      let minedCount = 0;

      for (let i = 0; i < maxCount; i++) {
        const block = bot.findBlock({
          matching: (b) => b.name === targetType || b.name.includes(targetType),
          maxDistance: ctx.config.perception.scanRadius || 16,
        });

        if (!block) break;

        const dist = distance3D(bot.entity.position, block.position);
        if (dist > 4.0) {
          try {
            const goal = new goals.GoalLookAtBlock(block.position, bot.world);
            await (bot as any).pathfinder.goto(goal);
          } catch {
            break;
          }
        }

        await autoEquipBestTool(bot, block);

        try {
          await bot.dig(block);
          minedCount++;
          await new Promise((res) => setTimeout(res, 200));
        } catch {
          break;
        }
      }

      if (minedCount === 0) {
        return { status: 'failed', reason: `Could not mine any ${targetType}.` };
      }
      return { status: 'success', reason: `Mined ${minedCount} of ${targetType}.` };
    },
  },
  {
    name: 'chop_tree',
    category: 'mining_building',
    description: 'Autonomous macro: Navigates to tree, clears obstructing leaves, chops logs base-to-top, towers up if tall, and auto-vacuums all dropped wood/saplings.',
    parameterSchema: {
      logType: { type: 'string', description: 'Optional log name (e.g. oak_log)' },
    },
    isAvailable: (bot, obs) => obs.vitals.isAlive && obs.blocks.notableBlocks.some((b) => b.name.includes('log')),
    execute: async (bot: Bot, params: any, ctx: ActionExecutionContext): Promise<ActionResult> => {
      return techniqueChopTreeFull(bot, ctx.config.perception.scanRadius || 16, ctx.abortSignal);
    },
  },
  {
    name: 'place_block',
    category: 'mining_building',
    description: 'Place a block from inventory against a reference block face.',
    parameterSchema: {
      item: { type: 'string', description: 'Name of the block item to place' },
      referenceX: { type: 'number' },
      referenceY: { type: 'number' },
      referenceZ: { type: 'number' },
      face: { type: 'string', enum: ['top', 'north', 'south', 'east', 'west', 'bottom'] },
    },
    isAvailable: (bot, obs) => obs.vitals.isAlive && Object.keys(obs.inventory.placeableBlocks).length > 0,
    getAvailableChoices: (bot, obs) => ({
      item: Object.keys(obs.inventory.placeableBlocks),
      face: ['top', 'north', 'south', 'east', 'west', 'bottom'],
    }),
    execute: async (bot: Bot, params: any, ctx: ActionExecutionContext): Promise<ActionResult> => {
      const itemName = params.item;
      const invItem = bot.inventory.items().find((it) => it.name === itemName);
      if (!invItem) {
        return { status: 'failed', reason: `Do not have ${itemName} in inventory.` };
      }

      let refPos: Vec3;
      if (params.referenceX !== undefined && params.referenceY !== undefined && params.referenceZ !== undefined) {
        refPos = new Vec3(params.referenceX, params.referenceY, params.referenceZ);
      } else {
        // Place on ground below feet or block ahead
        refPos = bot.entity.position.floored().offset(0, -1, 0);
      }

      const refBlock = bot.blockAt(refPos);
      if (!refBlock || refBlock.name === 'air') {
        return { status: 'failed', reason: 'Invalid reference block for placement.' };
      }

      let faceVec = new Vec3(0, 1, 0); // top default
      if (params.face === 'north') faceVec = new Vec3(0, 0, -1);
      else if (params.face === 'south') faceVec = new Vec3(0, 0, 1);
      else if (params.face === 'east') faceVec = new Vec3(1, 0, 0);
      else if (params.face === 'west') faceVec = new Vec3(-1, 0, 0);
      else if (params.face === 'bottom') faceVec = new Vec3(0, -1, 0);

      try {
        await bot.equip(invItem, 'hand');
        await bot.placeBlock(refBlock, faceVec);
        return { status: 'success', reason: `Placed ${itemName} at ${refPos.x + faceVec.x}, ${refPos.y + faceVec.y}, ${refPos.z + faceVec.z}.` };
      } catch (err: any) {
        return { status: 'failed', reason: `Failed to place block: ${err.message}` };
      }
    },
  },
  {
    name: 'collect_items',
    category: 'mining_building',
    description: 'Walk to and collect nearby dropped items.',
    parameterSchema: {},
    isAvailable: (bot, obs) => obs.vitals.isAlive && obs.entities.some((e) => e.isItem) && obs.inventory.aggregates.freeSlots > 0,
    execute: async (bot: Bot, params: any, ctx: ActionExecutionContext): Promise<ActionResult> => {
      const droppedItems = ctx.observation.entities.filter((e) => e.isItem);
      if (droppedItems.length === 0) {
        return { status: 'failed', reason: 'No dropped items nearby.' };
      }

      let collected = 0;
      for (const item of droppedItems.slice(0, 3)) {
        try {
          const goal = new goals.GoalNear(item.position.x, item.position.y, item.position.z, 0.5);
          await (bot as any).pathfinder.goto(goal);
          collected++;
        } catch {
          continue;
        }
      }

      return { status: 'success', reason: `Collected ${collected} dropped item(s).` };
    },
  },
  {
    name: 'use_bucket',
    category: 'mining_building',
    description: 'Fill or empty a bucket (water/lava).',
    parameterSchema: {
      action: { type: 'string', enum: ['fill', 'empty'] },
    },
    isAvailable: (bot, obs) => {
      const items = obs.inventory.aggregates.totalItemCounts;
      return obs.vitals.isAlive && (Boolean(items['bucket']) || Boolean(items['water_bucket']) || Boolean(items['lava_bucket']));
    },
    execute: async (bot: Bot, params: any): Promise<ActionResult> => {
      const action = params.action || 'fill';
      const items = bot.inventory.items();
      if (action === 'fill') {
        const bucket = items.find((i) => i.name === 'bucket');
        if (!bucket) return { status: 'failed', reason: 'No empty bucket in inventory.' };
        const liquidBlock = bot.findBlock({ matching: (b) => b.name === 'water' || b.name === 'lava', maxDistance: 4 });
        if (!liquidBlock) return { status: 'failed', reason: 'No liquid block in reach.' };
        await bot.equip(bucket, 'hand');
        await bot.activateBlock(liquidBlock);
        return { status: 'success', reason: `Filled bucket with ${liquidBlock.name}.` };
      } else {
        const fullBucket = items.find((i) => i.name === 'water_bucket' || i.name === 'lava_bucket');
        if (!fullBucket) return { status: 'failed', reason: 'No water/lava bucket in inventory.' };
        await bot.equip(fullBucket, 'hand');
        bot.activateItem();
        return { status: 'success', reason: `Emptied ${fullBucket.name}.` };
      }
    },
  },
  {
    name: 'till',
    category: 'mining_building',
    description: 'Till dirt or grass into farmland using a hoe.',
    parameterSchema: {},
    isAvailable: (bot, obs) => obs.vitals.isAlive && Boolean(obs.inventory.toolSummary.bestHoe),
    execute: async (bot: Bot): Promise<ActionResult> => {
      const dirt = bot.findBlock({ matching: (b) => b.name === 'dirt' || b.name === 'grass_block', maxDistance: 4 });
      if (!dirt) return { status: 'failed', reason: 'No dirt or grass in reach.' };
      const hoe = bot.inventory.items().find((i) => i.name.includes('_hoe'));
      if (!hoe) return { status: 'failed', reason: 'No hoe in inventory.' };
      await bot.equip(hoe, 'hand');
      await bot.activateBlock(dirt);
      return { status: 'success', reason: 'Tilled block into farmland.' };
    },
  },
  {
    name: 'plant',
    category: 'mining_building',
    description: 'Plant seeds on nearby farmland.',
    parameterSchema: {
      seed: { type: 'string', description: 'Name of seeds (wheat_seeds, carrot, potato, beetroot_seeds)' },
    },
    isAvailable: (bot, obs) => {
      const counts = obs.inventory.aggregates.totalItemCounts;
      return obs.vitals.isAlive && (Boolean(counts['wheat_seeds']) || Boolean(counts['carrot']) || Boolean(counts['potato']));
    },
    execute: async (bot: Bot, params: any): Promise<ActionResult> => {
      const seedName = params.seed || 'wheat_seeds';
      const seedItem = bot.inventory.items().find((i) => i.name === seedName);
      if (!seedItem) return { status: 'failed', reason: `No ${seedName} in inventory.` };
      const farmland = bot.findBlock({ matching: (b) => b.name === 'farmland', maxDistance: 4 });
      if (!farmland) return { status: 'failed', reason: 'No farmland in reach.' };
      await bot.equip(seedItem, 'hand');
      await bot.placeBlock(farmland, new Vec3(0, 1, 0));
      return { status: 'success', reason: `Planted ${seedName}.` };
    },
  },
  {
    name: 'harvest',
    category: 'mining_building',
    description: 'Harvest mature crops nearby.',
    parameterSchema: {},
    isAvailable: (bot, obs) => obs.vitals.isAlive,
    execute: async (bot: Bot): Promise<ActionResult> => {
      const matureCrop = bot.findBlock({
        matching: (b) => {
          if (['wheat', 'carrots', 'potatoes', 'beetroots'].includes(b.name)) {
            const props = b.getProperties ? b.getProperties() : {};
            return props.age === '7' || props.age === 7;
          }
          return false;
        },
        maxDistance: 4,
      });

      if (!matureCrop) return { status: 'failed', reason: 'No mature crop found in reach.' };
      await bot.dig(matureCrop);
      return { status: 'success', reason: `Harvested ${matureCrop.name}.` };
    },
  },
  {
    name: 'mine_staircase',
    category: 'mining_building',
    description: 'Autonomous technique: Safely mine a forward-descending 1x2 staircase without digging straight down, automatically lighting dark areas.',
    parameterSchema: {
      steps: { type: 'number', description: 'Number of descending steps to mine (default 6)' },
    },
    isAvailable: (bot, obs) => obs.vitals.isAlive && !obs.container.isOpen,
    execute: async (bot: Bot, params: any, ctx: ActionExecutionContext): Promise<ActionResult> => {
      return techniqueMineStaircase(bot, params.steps || 6, ctx.abortSignal);
    },
  },
  {
    name: 'build_shelter',
    category: 'mining_building',
    description: 'Autonomous macro: Constructs a 3x3x3 dirt/cobblestone survival shelter with doorway and roof.',
    parameterSchema: {},
    isAvailable: (bot, obs) => obs.vitals.isAlive && Object.keys(obs.inventory.placeableBlocks).length > 0,
    execute: async (bot: Bot, params: any, ctx: ActionExecutionContext): Promise<ActionResult> => {
      return techniqueBuildShelter(bot, ctx.abortSignal);
    },
  },
  {
    name: 'vacuum_drops',
    category: 'mining_building',
    description: 'Autonomous macro: Walks to and vacuums all dropped items in a 10-block radius.',
    parameterSchema: {
      radius: { type: 'number', description: 'Radius in blocks (default 10)' },
    },
    isAvailable: (bot, obs) => obs.vitals.isAlive && obs.entities.some((e) => e.isItem),
    execute: async (bot: Bot, params: any, ctx: ActionExecutionContext): Promise<ActionResult> => {
      return techniqueVacuumDrops(bot, params.radius || 10, ctx.abortSignal);
    },
  },
];
