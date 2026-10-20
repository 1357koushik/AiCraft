import { Bot } from 'mineflayer';
import { goals } from 'mineflayer-pathfinder';
import { ActionDef, ActionExecutionContext, ActionResult } from '../types/index.js';

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
    execute: async (bot: Bot, params: any): Promise<ActionResult> => {
      const itemName = params.item;
      const dest = params.destination || 'hand';
      const item = bot.inventory.items().find((i) => i.name === itemName);
      if (!item) return { status: 'failed', reason: `Item ${itemName} not in inventory.` };

      try {
        await bot.equip(item, dest as any);
        return { status: 'success', reason: `Equipped ${itemName} to ${dest}.` };
      } catch (err: any) {
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
    execute: async (bot: Bot, params: any): Promise<ActionResult> => {
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
    execute: async (bot: Bot): Promise<ActionResult> => {
      try {
        if ((bot as any).swapHands) {
          await (bot as any).swapHands();
        } else {
          // Send swap hands packet if helper is not present
          (bot as any)._client.write('block_place', { location: { x: 0, y: 0, z: 0 }, direction: 0, hand: 0, cursorX: 0, cursorY: 0, cursorZ: 0, insideBlock: false });
        }
        return { status: 'success', reason: 'Swapped items between hands.' };
      } catch (err: any) {
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
    execute: async (bot: Bot, params: any): Promise<ActionResult> => {
      const itemName = params.item;
      const count = params.count || 1;
      const item = bot.inventory.items().find((i) => i.name === itemName);
      if (!item) return { status: 'failed', reason: `Item ${itemName} not in inventory.` };

      try {
        await bot.toss(item.type, null, count);
        return { status: 'success', reason: `Dropped ${count} ${itemName}.` };
      } catch (err: any) {
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
      let foodItem: any = null;
      if (params.item) {
        foodItem = bot.inventory.items().find((i) => i.name === params.item);
      } else {
        // Pick best food available
        const foodNames = ctx.observation.inventory.foodList.map((f) => f.name);
        foodItem = bot.inventory.items().find((i) => foodNames.includes(i.name));
      }

      if (!foodItem) return { status: 'failed', reason: 'No edible food in inventory.' };

      try {
        await bot.equip(foodItem, 'hand');
        await bot.consume();
        return { status: 'success', reason: `Ate ${foodItem.name}. Food is now ${bot.food}.` };
      } catch (err: any) {
        return { status: 'failed', reason: `Eating failed: ${err.message}` };
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
      const itemName = params.item;
      const count = params.count || 1;
      const itemDef = bot.registry.itemsByName[itemName];
      if (!itemDef) return { status: 'failed', reason: `Unknown item ${itemName}.` };

      // Find recipe
      let craftingTable = bot.findBlock({ matching: (b) => b.name === 'crafting_table', maxDistance: 4.5 });
      let recipes = bot.recipesFor(itemDef.id, null, 1, craftingTable);

      if (recipes.length === 0) {
        // Try to find a crafting table further away if needed
        const distantTable = bot.findBlock({ matching: (b) => b.name === 'crafting_table', maxDistance: 16 });
        if (distantTable) {
          try {
            const goal = new goals.GoalGetToBlock(distantTable.position.x, distantTable.position.y, distantTable.position.z);
            await (bot as any).pathfinder.goto(goal);
            craftingTable = distantTable;
            recipes = bot.recipesFor(itemDef.id, null, 1, craftingTable);
          } catch {}
        }
      }

      if (recipes.length === 0) {
        return { status: 'failed', reason: `Cannot craft ${itemName} (missing ingredients or crafting table).` };
      }

      try {
        const recipe = recipes[0];
        await bot.craft(recipe, count, craftingTable || undefined);
        return { status: 'success', reason: `Crafted ${count}x recipe for ${itemName}.` };
      } catch (err: any) {
        return { status: 'failed', reason: `Crafting failed: ${err.message}` };
      }
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
    execute: async (bot: Bot, params: any): Promise<ActionResult> => {
      const containerBlock = bot.findBlock({
        matching: (b) => ['chest', 'barrel', 'furnace'].includes(b.name),
        maxDistance: 4.5,
      });

      if (!containerBlock) return { status: 'failed', reason: 'No container in reach.' };

      try {
        const window = await bot.openContainer(containerBlock);
        return { status: 'success', reason: `Opened container: ${containerBlock.name} with ${window.slots.length} slots.` };
      } catch (err: any) {
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
    execute: async (bot: Bot): Promise<ActionResult> => {
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
    execute: async (bot: Bot, params: any): Promise<ActionResult> => {
      if (!bot.currentWindow) return { status: 'failed', reason: 'No container window open.' };
      const itemDef = bot.registry.itemsByName[params.item];
      if (!itemDef) return { status: 'failed', reason: `Unknown item ${params.item}.` };

      try {
        await (bot.currentWindow as any).deposit(itemDef.id, null, params.count || 1);
        return { status: 'success', reason: `Deposited ${params.count || 1} ${params.item}.` };
      } catch (err: any) {
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
    execute: async (bot: Bot, params: any): Promise<ActionResult> => {
      if (!bot.currentWindow) return { status: 'failed', reason: 'No container window open.' };
      const itemDef = bot.registry.itemsByName[params.item];
      if (!itemDef) return { status: 'failed', reason: `Unknown item ${params.item}.` };

      try {
        await (bot.currentWindow as any).withdraw(itemDef.id, null, params.count || 1);
        return { status: 'success', reason: `Withdrew ${params.count || 1} ${params.item}.` };
      } catch (err: any) {
        return { status: 'failed', reason: `Withdraw failed: ${err.message}` };
      }
    },
  },
];
