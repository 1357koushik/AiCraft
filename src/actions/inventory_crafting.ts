import { Bot } from 'mineflayer';
import { goals } from 'mineflayer-pathfinder';
import { ActionDef, ActionExecutionContext, ActionResult } from '../types/index.js';
import { techniqueCraftPipeline, techniqueSmeltItem, techniqueSmeltPipeline } from './techniques.js';
import { isActionContextActive } from '../agent/arbiter.js';
import { ClosedLoopCraftingExecutor } from './crafting.js';
import {
  selectBestFood,
  isHarmfulFood,
  isPoorEmergencyFood,
  handleFullInventoryReliability,
} from '../safety/survival_policy.js';

export const inventoryCraftingActions: ActionDef[] = [
  {
    name: 'equip',
    category: 'inventory_crafting',
    description: 'Equip an item from inventory to hand, off-hand, or armor slot.',
    parameterSchema: {
      item: { type: 'string', description: 'Item name' },
      destination: { type: 'string', enum: ['hand', 'off-hand', 'head', 'torso', 'legs', 'feet'] },
    },
    isAvailable: (bot, obs) => obs.vitals.isAlive && obs.inventory.mainInventory.some((i) => i !== null),
    getAvailableChoices: (bot, obs) => ({
      item: Object.keys(obs.inventory.aggregates.totalItemCounts),
      destination: ['hand', 'off-hand', 'head', 'torso', 'legs', 'feet'],
    }),
    execute: async (bot: Bot, params: any, ctx: ActionExecutionContext): Promise<ActionResult> => {
      if (!isActionContextActive(ctx)) {
        return { status: 'interrupted', reason: 'Equip cancelled before start.' };
      }
      const itemName = params.item;
      const dest = params.destination || 'hand';
      const item = bot.inventory.items().find((i) => i.name === itemName);
      if (!item) return { status: 'failed', reason: `Item ${itemName} not in inventory.` };

      try {
        if (!isActionContextActive(ctx)) {
          return { status: 'interrupted', reason: 'Equip cancelled.' };
        }
        await bot.equip(item, dest as any);
        return { status: 'success', reason: `Equipped ${itemName} to ${dest}.` };
      } catch (err: any) {
        if (!isActionContextActive(ctx)) {
          return { status: 'interrupted', reason: 'Equip cancelled.' };
        }
        return { status: 'failed', reason: `Equip failed: ${err.message}` };
      }
    },
  },
  {
    name: 'select_hotbar',
    category: 'inventory_crafting',
    description: 'Select hotbar slot 0 to 8.',
    parameterSchema: {
      slot: { type: 'number', minimum: 0, maximum: 8 },
    },
    isAvailable: (bot, obs) => obs.vitals.isAlive && !obs.container.isOpen,
    execute: async (bot: Bot, params: any, ctx: ActionExecutionContext): Promise<ActionResult> => {
      if (!isActionContextActive(ctx)) {
        return { status: 'interrupted', reason: 'Select hotbar cancelled.' };
      }
      const slot = Math.min(Math.max(params.slot || 0, 0), 8);
      bot.setQuickBarSlot(slot);
      return { status: 'success', reason: `Selected hotbar slot ${slot}.` };
    },
  },
  {
    name: 'swap_hands',
    category: 'inventory_crafting',
    description: 'Swap items between main hand and off-hand (F key).',
    parameterSchema: {},
    isAvailable: (bot, obs) => obs.vitals.isAlive && (Boolean(obs.inventory.mainHand) || Boolean(obs.inventory.offHand)),
    execute: async (bot: Bot, params: any, ctx: ActionExecutionContext): Promise<ActionResult> => {
      if (!isActionContextActive(ctx)) {
        return { status: 'interrupted', reason: 'Swap hands cancelled.' };
      }
      try {
        if ((bot as any).swapHands) {
          await (bot as any).swapHands();
        } else {
          // Send swap hands packet if helper is not present
          (bot as any)._client.write('block_place', { location: { x: 0, y: 0, z: 0 }, direction: 0, hand: 0, cursorX: 0, cursorY: 0, cursorZ: 0, insideBlock: false });
        }
        return { status: 'success', reason: 'Swapped items between hands.' };
      } catch (err: any) {
        if (!isActionContextActive(ctx)) {
          return { status: 'interrupted', reason: 'Swap hands cancelled.' };
        }
        return { status: 'failed', reason: `Swap failed: ${err.message}` };
      }
    },
  },
  {
    name: 'drop',
    category: 'inventory_crafting',
    description: 'Drop an item or quantity of items from inventory onto the ground.',
    parameterSchema: {
      item: { type: 'string', description: 'Item name' },
      count: { type: 'number', description: 'Number to drop' },
    },
    isAvailable: (bot, obs) => obs.vitals.isAlive && obs.inventory.mainInventory.some((i) => i !== null),
    getAvailableChoices: (bot, obs) => ({
      item: Object.keys(obs.inventory.aggregates.totalItemCounts),
    }),
    execute: async (bot: Bot, params: any, ctx: ActionExecutionContext): Promise<ActionResult> => {
      if (!isActionContextActive(ctx)) {
        return { status: 'interrupted', reason: 'Drop cancelled before start.' };
      }
      const itemName = params.item;
      const count = params.count || 1;
      const item = bot.inventory.items().find((i) => i.name === itemName);
      if (!item) return { status: 'failed', reason: `Item ${itemName} not in inventory.` };

      try {
        if (!isActionContextActive(ctx)) {
          return { status: 'interrupted', reason: 'Drop cancelled.' };
        }
        await bot.toss(item.type, null, count);
        return { status: 'success', reason: `Dropped ${count} ${itemName}.` };
      } catch (err: any) {
        if (!isActionContextActive(ctx)) {
          return { status: 'interrupted', reason: 'Drop cancelled.' };
        }
        return { status: 'failed', reason: `Drop failed: ${err.message}` };
      }
    },
  },
  {
    name: 'eat',
    category: 'inventory_crafting',
    description: 'Eat food from inventory to restore hunger points and health.',
    parameterSchema: {
      item: { type: 'string', description: 'Food item name' },
    },
    isAvailable: (bot, obs) => {
      return (
        obs.vitals.isAlive &&
        obs.inventory.foodList.length > 0 &&
        (obs.vitals.food < 20 || obs.inventory.foodList.some((f) => f.name.includes('golden_apple')))
      );
    },
    getAvailableChoices: (bot, obs) => ({
      item: obs.inventory.foodList.map((f) => f.name),
    }),
    execute: async (bot: Bot, params: any, ctx: ActionExecutionContext): Promise<ActionResult> => {
      if (ctx.abortSignal?.aborted) {
        return { status: 'interrupted', reason: 'Eat cancelled before start.' };
      }

      let foodItem: any = null;
      if (params.item) {
        if (isHarmfulFood(params.item)) {
          return {
            status: 'failed',
            reason: `Refused to eat ${params.item}: toxic/harmful food with severe debuffs.`,
          };
        }
        if (isPoorEmergencyFood(params.item)) {
          const isStarving = (bot.food !== undefined && bot.food <= 2) || (bot.health !== undefined && bot.health <= 6);
          const hasSafeAlternative = bot.inventory?.items().some((i) => {
            const def = selectBestFood(bot, { allowEmergencyOnly: false });
            return Boolean(def.selectedItem);
          });
          if (hasSafeAlternative || !isStarving) {
            return {
              status: 'failed',
              reason: `Refused to eat poor emergency food ${params.item} when safer food exists or starvation threshold not met.`,
            };
          }
        }
        foodItem = bot.inventory?.items().find((i) => i.name === params.item);
      } else {
        // Safe version-supported food selection
        const isStarving = (bot.food !== undefined && bot.food <= 2) || (bot.health !== undefined && bot.health <= 6);
        const healthPriority = Boolean(bot.health !== undefined && bot.health <= 10);
        const foodResult = selectBestFood(bot, { healthPriority, allowEmergencyOnly: isStarving });
        if (!foodResult.selectedItem) {
          return { status: 'failed', reason: foodResult.reason };
        }
        foodItem = foodResult.selectedItem;
      }

      if (!foodItem) return { status: 'failed', reason: 'No edible food in inventory.' };

      let onAbort: (() => void) | null = null;
      try {
        if (ctx.abortSignal) {
          onAbort = () => {
            try { bot.deactivateItem(); } catch {}
          };
          ctx.abortSignal.addEventListener('abort', onAbort, { once: true });
        }
        if (!isActionContextActive(ctx)) {
          return { status: 'interrupted', reason: 'Eating cancelled before equip.' };
        }
        await bot.equip(foodItem, 'hand');
        if (!isActionContextActive(ctx)) {
          return { status: 'interrupted', reason: 'Eating cancelled before consume.' };
        }
        await bot.consume();
        return { status: 'success', reason: `Ate ${foodItem.name}. Food is now ${bot.food}.` };
      } catch (err: any) {
        if (!isActionContextActive(ctx)) {
          return { status: 'interrupted', reason: 'Eating interrupted by higher-priority emergency or cancellation.' };
        }
        return { status: 'failed', reason: `Eating failed: ${err.message}` };
      } finally {
        if (ctx.abortSignal && onAbort) {
          ctx.abortSignal.removeEventListener('abort', onAbort);
        }
        if (isActionContextActive(ctx)) {
          try {
            bot.deactivateItem();
          } catch {}
        }
      }
    },
  },
  {
    name: 'craft',
    category: 'inventory_crafting',
    description: 'Craft an item recipe (using 2x2 player grid or nearby 3x3 crafting table).',
    parameterSchema: {
      item: { type: 'string', description: 'Item name to craft (e.g. oak_planks, crafting_table, wooden_pickaxe)' },
      count: { type: 'number', description: 'Number of times to craft recipe' },
    },
    isAvailable: (bot, obs) => obs.vitals.isAlive && obs.inventory.craftableNow.length > 0,
    getAvailableChoices: (bot, obs) => ({
      item: obs.inventory.craftableNow,
    }),
    execute: async (bot: Bot, params: any, ctx: ActionExecutionContext): Promise<ActionResult> => {
      if (!isActionContextActive(ctx)) {
        return { status: 'interrupted', reason: 'Craft cancelled before start.' };
      }
      const itemName = params.item || params.itemName || params.targetItem;
      const count = params.count !== undefined ? Number(params.count) : 1;
      const executor = new ClosedLoopCraftingExecutor(bot);
      return executor.craftItem(itemName, count, ctx);
    },
  },
  {
    name: 'open_container',
    category: 'inventory_crafting',
    description: 'Open a chest, barrel, or furnace in reach.',
    parameterSchema: {
      blockType: { type: 'string', description: 'chest, barrel, or furnace' },
    },
    isAvailable: (bot, obs) => obs.vitals.isAlive && !obs.container.isOpen && obs.blocks.notableBlocks.some((b) => ['chest', 'barrel', 'furnace'].includes(b.name)),
    execute: async (bot: Bot, params: any, ctx: ActionExecutionContext): Promise<ActionResult> => {
      if (!isActionContextActive(ctx)) {
        return { status: 'interrupted', reason: 'Open container cancelled before start.' };
      }
      const containerBlock = bot.findBlock({
        matching: (b) => ['chest', 'barrel', 'furnace'].includes(b.name),
        maxDistance: 4.5,
      });

      if (!containerBlock) return { status: 'failed', reason: 'No container in reach.' };

      try {
        if (!isActionContextActive(ctx)) {
          return { status: 'interrupted', reason: 'Open container cancelled.' };
        }
        const window = await bot.openContainer(containerBlock);
        return { status: 'success', reason: `Opened container: ${containerBlock.name} with ${window.slots.length} slots.` };
      } catch (err: any) {
        if (!isActionContextActive(ctx)) {
          return { status: 'interrupted', reason: 'Open container cancelled.' };
        }
        return { status: 'failed', reason: `Failed to open container: ${err.message}` };
      }
    },
  },
  {
    name: 'close_container',
    category: 'inventory_crafting',
    description: 'Close the currently open window/container.',
    parameterSchema: {},
    isAvailable: (bot, obs) => obs.container.isOpen,
    execute: async (bot: Bot, params: any, ctx: ActionExecutionContext): Promise<ActionResult> => {
      if (!isActionContextActive(ctx)) {
        return { status: 'interrupted', reason: 'Close container cancelled.' };
      }
      if (bot.currentWindow) {
        bot.closeWindow(bot.currentWindow);
        return { status: 'success', reason: 'Closed open container.' };
      }
      return { status: 'success', reason: 'No open container.' };
    },
  },
  {
    name: 'deposit',
    category: 'inventory_crafting',
    description: 'Deposit an item from bot inventory into the currently open container.',
    parameterSchema: {
      item: { type: 'string', description: 'Item name' },
      count: { type: 'number' },
    },
    isAvailable: (bot, obs) => obs.container.isOpen,
    execute: async (bot: Bot, params: any, ctx: ActionExecutionContext): Promise<ActionResult> => {
      if (!isActionContextActive(ctx)) {
        return { status: 'interrupted', reason: 'Deposit cancelled before start.' };
      }
      if (!bot.currentWindow) return { status: 'failed', reason: 'No container window open.' };
      const itemDef = bot.registry.itemsByName[params.item];
      if (!itemDef) return { status: 'failed', reason: `Unknown item ${params.item}.` };

      try {
        if (!isActionContextActive(ctx)) {
          return { status: 'interrupted', reason: 'Deposit cancelled.' };
        }
        await (bot.currentWindow as any).deposit(itemDef.id, null, params.count || 1);
        return { status: 'success', reason: `Deposited ${params.count || 1} ${params.item}.` };
      } catch (err: any) {
        if (!isActionContextActive(ctx)) {
          return { status: 'interrupted', reason: 'Deposit cancelled.' };
        }
        return { status: 'failed', reason: `Deposit failed: ${err.message}` };
      }
    },
  },
  {
    name: 'withdraw',
    category: 'inventory_crafting',
    description: 'Withdraw an item from the currently open container into bot inventory.',
    parameterSchema: {
      item: { type: 'string', description: 'Item name' },
      count: { type: 'number' },
    },
    isAvailable: (bot, obs) => obs.container.isOpen,
    execute: async (bot: Bot, params: any, ctx: ActionExecutionContext): Promise<ActionResult> => {
      if (!isActionContextActive(ctx)) {
        return { status: 'interrupted', reason: 'Withdraw cancelled before start.' };
      }
      if (!bot.currentWindow) return { status: 'failed', reason: 'No container window open.' };
      const itemDef = bot.registry.itemsByName[params.item];
      if (!itemDef) return { status: 'failed', reason: `Unknown item ${params.item}.` };

      try {
        if (!isActionContextActive(ctx)) {
          return { status: 'interrupted', reason: 'Withdraw cancelled.' };
        }
        await (bot.currentWindow as any).withdraw(itemDef.id, null, params.count || 1);
        return { status: 'success', reason: `Withdrew ${params.count || 1} ${params.item}.` };
      } catch (err: any) {
        if (!isActionContextActive(ctx)) {
          return { status: 'interrupted', reason: 'Withdraw cancelled.' };
        }
        return { status: 'failed', reason: `Withdraw failed: ${err.message}` };
      }
    },
  },
  {
    name: 'craft_pipeline',
    category: 'inventory_crafting',
    description: 'Autonomous macro: Recursively crafts prerequisite items (logs -> planks -> table -> sticks -> tool) in a single code execution.',
    parameterSchema: {
      item: { type: 'string', description: 'Target tool or item (e.g. wooden_pickaxe, stone_pickaxe, crafting_table)' },
      count: { type: 'number', description: 'Count to craft (default 1)' },
    },
    isAvailable: (bot, obs) => obs.vitals.isAlive && (obs.inventory.craftableNow.length > 0 || Object.keys(obs.inventory.aggregates.totalItemCounts).some((k) => k.includes('log') || k.includes('plank'))),
    getAvailableChoices: () => ({
      item: ['wooden_pickaxe', 'stone_pickaxe', 'wooden_axe', 'stone_axe', 'wooden_sword', 'stone_sword', 'crafting_table'],
    }),
    execute: async (bot: Bot, params: any, ctx: ActionExecutionContext): Promise<ActionResult> => {
      const itemName = params.item || params.itemName || params.targetItem || 'wooden_pickaxe';
      const count = params.count !== undefined ? Number(params.count) : 1;
      const executor = new ClosedLoopCraftingExecutor(bot);
      return executor.craftItem(itemName, count, ctx);
    },
  },
  {
    name: 'craft_item',
    category: 'inventory_crafting',
    description: 'Autonomous macro: Crafts item and recursively crafts any missing prerequisites (planks, sticks, crafting table), managing workstation lifecycle.',
    parameterSchema: {
      item: { type: 'string', description: 'Target tool or item (e.g. wooden_pickaxe, stone_pickaxe, stone_axe, crafting_table, furnace)' },
      count: { type: 'number', description: 'Count to craft (default 1)' },
    },
    isAvailable: (bot, obs) => obs.vitals.isAlive,
    getAvailableChoices: () => ({
      item: ['wooden_pickaxe', 'stone_pickaxe', 'wooden_axe', 'stone_axe', 'wooden_sword', 'stone_sword', 'crafting_table', 'furnace'],
    }),
    execute: async (bot: Bot, params: any, ctx: ActionExecutionContext): Promise<ActionResult> => {
      const itemName = params.item || params.itemName || params.targetItem || 'wooden_pickaxe';
      const count = params.count !== undefined ? Number(params.count) : 1;
      const executor = new ClosedLoopCraftingExecutor(bot);
      return executor.craftItem(itemName, count, ctx);
    },
  },
  {
    name: 'manage_full_inventory',
    category: 'inventory_crafting',
    description: 'Autonomous inventory reliability: deposits surplus materials into nearby chests/barrels, or discards non-essential allowlisted items, strictly preserving tools, food, ores, workstations, and reserved ingredients.',
    parameterSchema: {
      allowDropping: { type: 'boolean', description: 'Whether dropping allowlisted surplus is permitted if no container is found' },
    },
    isAvailable: (bot, obs) => obs.vitals.isAlive,
    execute: async (bot: Bot, params: any, ctx: ActionExecutionContext): Promise<ActionResult> => {
      const res = await handleFullInventoryReliability(bot, {
        allowDropping: params.allowDropping ?? true,
      }, ctx);
      if (res.status === 'failed') {
        return { status: 'failed', reason: res.actionTaken };
      }
      return { status: 'success', reason: res.actionTaken, details: res };
    },
  },
  {
    name: 'smelt_items',
    category: 'inventory_crafting',
    description: 'Smelt raw ores or cook food in a furnace using fuel (e.g. raw_iron -> iron_ingot, raw_beef -> cooked_beef, cobblestone -> stone). Automatically places and recovers furnace.',
    parameterSchema: {
      itemToSmelt: { type: 'string', description: 'Item name to smelt (e.g. raw_iron, beef, cobblestone)' },
      count: { type: 'number', description: 'Number of items to smelt (default 1)' },
      fuelItem: { type: 'string', description: 'Optional fuel item name (e.g. coal, charcoal, oak_planks)' },
    },
    isAvailable: (bot, obs) => obs.vitals.isAlive && !obs.container.isOpen,
    execute: async (bot: Bot, params: any, ctx: ActionExecutionContext): Promise<ActionResult> => {
      const itemToSmelt = params.itemToSmelt || params.item || params.oreName;
      const count = params.count || 1;
      const fuelItem = params.fuelItem;
      return techniqueSmeltItem(bot, itemToSmelt, count, fuelItem, ctx.abortSignal, ctx.isCurrent);
    },
  },
  {
    name: 'smelt_ore_pipeline',
    category: 'inventory_crafting',
    description: 'Autonomous ore smelting pipeline: smelt raw ores into ingots using furnace and fuel.',
    parameterSchema: {
      oreName: { type: 'string', description: 'Raw ore or metal name to smelt (e.g. raw_iron, raw_gold, raw_copper)' },
      count: { type: 'number', description: 'Number of items to smelt (default 1)' },
    },
    isAvailable: (bot, obs) => obs.vitals.isAlive && !obs.container.isOpen,
    execute: async (bot: Bot, params: any, ctx: ActionExecutionContext): Promise<ActionResult> => {
      const itemToSmelt = params.oreName || params.itemToSmelt || params.item;
      const count = params.count || 1;
      return techniqueSmeltPipeline(bot, itemToSmelt, count, undefined, ctx.abortSignal, ctx.isCurrent);
    },
  },
];
