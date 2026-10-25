import { TaskBaseline } from '../../types/index.js';

export interface RequiredToolSpec {
  toolType: 'pickaxe' | 'axe' | 'shovel' | 'sword' | 'hoe';
  minTier: number; // 0=hand/any, 1=wood/gold, 2=stone, 3=iron, 4=diamond, 5=netherite
}

export interface ItemQuantity {
  item: string;
  count: number;
}

export interface IOperatorDefinition {
  id: string;
  name: string;
  actionName: string;
  category: 'gather' | 'craft' | 'smelt' | 'interact';
  producedItems: ItemQuantity[];
  requiredTools?: RequiredToolSpec[];
  consumedItems: ItemQuantity[];
  workstation?: 'crafting_table' | 'furnace';
  budgetMs?: number;
  maxRetries?: number;
  buildParams: (targetCount: number, currentInventory: Record<string, number>) => Record<string, any>;
  postcondition?: (bot: any, baseline: TaskBaseline, targetCount: number) => Promise<boolean> | boolean;
}

export const TOOL_TIERS: Record<string, Record<string, number>> = {
  pickaxe: {
    wooden_pickaxe: 1,
    golden_pickaxe: 1,
    stone_pickaxe: 2,
    iron_pickaxe: 3,
    diamond_pickaxe: 4,
    netherite_pickaxe: 5,
  },
  axe: {
    wooden_axe: 1,
    golden_axe: 1,
    stone_axe: 2,
    iron_axe: 3,
    diamond_axe: 4,
    netherite_axe: 5,
  },
  shovel: {
    wooden_shovel: 1,
    golden_shovel: 1,
    stone_shovel: 2,
    iron_shovel: 3,
    diamond_shovel: 4,
    netherite_shovel: 5,
  },
  sword: {
    wooden_sword: 1,
    golden_sword: 1,
    stone_sword: 2,
    iron_sword: 3,
    diamond_sword: 4,
    netherite_sword: 5,
  },
};

export const BASE_OPERATORS: IOperatorDefinition[] = [
  // 1. Gather Wood Logs
  {
    id: 'op_gather_logs',
    name: 'Gather Wood Logs',
    actionName: 'chop_tree',
    category: 'gather',
    producedItems: [{ item: 'oak_log', count: 1 }],
    consumedItems: [],
    requiredTools: [],
    budgetMs: 60000,
    maxRetries: 3,
    buildParams: (count) => ({ logType: 'oak_log', count: Math.max(count, 1) }),
  },

  // 2. Craft Wooden Planks
  {
    id: 'op_craft_planks',
    name: 'Craft Wooden Planks',
    actionName: 'craft_item',
    category: 'craft',
    producedItems: [{ item: 'oak_planks', count: 4 }],
    consumedItems: [{ item: 'oak_log', count: 1 }],
    budgetMs: 15000,
    maxRetries: 2,
    buildParams: (count) => ({ item: 'oak_planks', count: Math.max(count, 4) }),
  },

  // 3. Craft Sticks
  {
    id: 'op_craft_sticks',
    name: 'Craft Sticks',
    actionName: 'craft_item',
    category: 'craft',
    producedItems: [{ item: 'stick', count: 4 }],
    consumedItems: [{ item: 'oak_planks', count: 2 }],
    budgetMs: 15000,
    maxRetries: 2,
    buildParams: (count) => ({ item: 'stick', count: Math.max(Math.ceil(count / 4), 1) }),
  },

  // 4. Craft Crafting Table
  {
    id: 'op_craft_table',
    name: 'Craft Crafting Table',
    actionName: 'craft_item',
    category: 'craft',
    producedItems: [{ item: 'crafting_table', count: 1 }],
    consumedItems: [{ item: 'oak_planks', count: 4 }],
    budgetMs: 15000,
    maxRetries: 2,
    buildParams: (count) => ({ item: 'crafting_table', count: Math.max(count, 1) }),
  },

  // 5. Craft Wooden Pickaxe
  {
    id: 'op_craft_wooden_pickaxe',
    name: 'Craft Wooden Pickaxe',
    actionName: 'craft_item',
    category: 'craft',
    producedItems: [{ item: 'wooden_pickaxe', count: 1 }],
    consumedItems: [
      { item: 'oak_planks', count: 3 },
      { item: 'stick', count: 2 },
    ],
    workstation: 'crafting_table',
    budgetMs: 25000,
    maxRetries: 2,
    buildParams: (count) => ({ item: 'wooden_pickaxe', count: Math.max(count, 1) }),
  },

  // 6. Mine Cobblestone
  {
    id: 'op_mine_cobblestone',
    name: 'Mine Cobblestone',
    actionName: 'collect_resource',
    category: 'gather',
    producedItems: [{ item: 'cobblestone', count: 1 }],
    consumedItems: [],
    requiredTools: [{ toolType: 'pickaxe', minTier: 1 }],
    budgetMs: 60000,
    maxRetries: 3,
    buildParams: (count) => ({ resource: 'stone', count: Math.max(count, 1) }),
  },

  // 7. Craft Stone Pickaxe
  {
    id: 'op_craft_stone_pickaxe',
    name: 'Craft Stone Pickaxe',
    actionName: 'craft_item',
    category: 'craft',
    producedItems: [{ item: 'stone_pickaxe', count: 1 }],
    consumedItems: [
      { item: 'cobblestone', count: 3 },
      { item: 'stick', count: 2 },
    ],
    workstation: 'crafting_table',
    budgetMs: 25000,
    maxRetries: 2,
    buildParams: (count) => ({ item: 'stone_pickaxe', count: Math.max(count, 1) }),
  },

  // 8. Craft Furnace
  {
    id: 'op_craft_furnace',
    name: 'Craft Furnace',
    actionName: 'craft_item',
    category: 'craft',
    producedItems: [{ item: 'furnace', count: 1 }],
    consumedItems: [{ item: 'cobblestone', count: 8 }],
    workstation: 'crafting_table',
    budgetMs: 25000,
    maxRetries: 2,
    buildParams: (count) => ({ item: 'furnace', count: Math.max(count, 1) }),
  },

  // 9. Mine Coal
  {
    id: 'op_mine_coal',
    name: 'Mine Coal',
    actionName: 'collect_resource',
    category: 'gather',
    producedItems: [{ item: 'coal', count: 1 }],
    consumedItems: [],
    requiredTools: [{ toolType: 'pickaxe', minTier: 1 }],
    budgetMs: 60000,
    maxRetries: 3,
    buildParams: (count) => ({ resource: 'coal', count: Math.max(count, 1) }),
  },

  // 10. Mine Raw Iron (Ore)
  {
    id: 'op_mine_iron_ore',
    name: 'Mine Raw Iron',
    actionName: 'collect_resource',
    category: 'gather',
    producedItems: [{ item: 'raw_iron', count: 1 }],
    consumedItems: [],
    requiredTools: [{ toolType: 'pickaxe', minTier: 2 }], // Requires stone pickaxe or higher
    budgetMs: 90000,
    maxRetries: 3,
    buildParams: (count) => ({ resource: 'iron', count: Math.max(count, 1) }),
  },

  // 11. Smelt Iron Ingot
  {
    id: 'op_smelt_iron_ingot',
    name: 'Smelt Iron Ingot',
    actionName: 'smelt_items',
    category: 'smelt',
    producedItems: [{ item: 'iron_ingot', count: 1 }],
    consumedItems: [
      { item: 'raw_iron', count: 1 },
      { item: 'coal', count: 1 },
    ],
    workstation: 'furnace',
    budgetMs: 60000,
    maxRetries: 2,
    buildParams: (count) => ({ item: 'raw_iron', count: Math.max(count, 1) }),
  },

  // 12. Craft Iron Pickaxe
  {
    id: 'op_craft_iron_pickaxe',
    name: 'Craft Iron Pickaxe',
    actionName: 'craft_item',
    category: 'craft',
    producedItems: [{ item: 'iron_pickaxe', count: 1 }],
    consumedItems: [
      { item: 'iron_ingot', count: 3 },
      { item: 'stick', count: 2 },
    ],
    workstation: 'crafting_table',
    budgetMs: 30000,
    maxRetries: 2,
    buildParams: (count) => ({ item: 'iron_pickaxe', count: Math.max(count, 1) }),
  },

  // 13. Craft Swords (Wood, Stone, Iron)
  {
    id: 'op_craft_wooden_sword',
    name: 'Craft Wooden Sword',
    actionName: 'craft_item',
    category: 'craft',
    producedItems: [{ item: 'wooden_sword', count: 1 }],
    consumedItems: [
      { item: 'oak_planks', count: 2 },
      { item: 'stick', count: 1 },
    ],
    workstation: 'crafting_table',
    budgetMs: 20000,
    maxRetries: 2,
    buildParams: (count) => ({ item: 'wooden_sword', count: Math.max(count, 1) }),
  },
  {
    id: 'op_craft_stone_sword',
    name: 'Craft Stone Sword',
    actionName: 'craft_item',
    category: 'craft',
    producedItems: [{ item: 'stone_sword', count: 1 }],
    consumedItems: [
      { item: 'cobblestone', count: 2 },
      { item: 'stick', count: 1 },
    ],
    workstation: 'crafting_table',
    budgetMs: 20000,
    maxRetries: 2,
    buildParams: (count) => ({ item: 'stone_sword', count: Math.max(count, 1) }),
  },
  {
    id: 'op_craft_iron_sword',
    name: 'Craft Iron Sword',
    actionName: 'craft_item',
    category: 'craft',
    producedItems: [{ item: 'iron_sword', count: 1 }],
    consumedItems: [
      { item: 'iron_ingot', count: 2 },
      { item: 'stick', count: 1 },
    ],
    workstation: 'crafting_table',
    budgetMs: 25000,
    maxRetries: 2,
    buildParams: (count) => ({ item: 'iron_sword', count: Math.max(count, 1) }),
  },

  // 14. Craft Iron Armor
  {
    id: 'op_craft_iron_helmet',
    name: 'Craft Iron Helmet',
    actionName: 'craft_item',
    category: 'craft',
    producedItems: [{ item: 'iron_helmet', count: 1 }],
    consumedItems: [{ item: 'iron_ingot', count: 5 }],
    workstation: 'crafting_table',
    budgetMs: 25000,
    maxRetries: 2,
    buildParams: (count) => ({ item: 'iron_helmet', count: Math.max(count, 1) }),
  },
  {
    id: 'op_craft_iron_chestplate',
    name: 'Craft Iron Chestplate',
    actionName: 'craft_item',
    category: 'craft',
    producedItems: [{ item: 'iron_chestplate', count: 1 }],
    consumedItems: [{ item: 'iron_ingot', count: 8 }],
    workstation: 'crafting_table',
    budgetMs: 25000,
    maxRetries: 2,
    buildParams: (count) => ({ item: 'iron_chestplate', count: Math.max(count, 1) }),
  },
  {
    id: 'op_craft_iron_leggings',
    name: 'Craft Iron Leggings',
    actionName: 'craft_item',
    category: 'craft',
    producedItems: [{ item: 'iron_leggings', count: 1 }],
    consumedItems: [{ item: 'iron_ingot', count: 7 }],
    workstation: 'crafting_table',
    budgetMs: 25000,
    maxRetries: 2,
    buildParams: (count) => ({ item: 'iron_leggings', count: Math.max(count, 1) }),
  },
  {
    id: 'op_craft_iron_boots',
    name: 'Craft Iron Boots',
    actionName: 'craft_item',
    category: 'craft',
    producedItems: [{ item: 'iron_boots', count: 1 }],
    consumedItems: [{ item: 'iron_ingot', count: 4 }],
    workstation: 'crafting_table',
    budgetMs: 25000,
    maxRetries: 2,
    buildParams: (count) => ({ item: 'iron_boots', count: Math.max(count, 1) }),
  },

  // 15. Craft Shield & Bucket
  {
    id: 'op_craft_shield',
    name: 'Craft Shield',
    actionName: 'craft_item',
    category: 'craft',
    producedItems: [{ item: 'shield', count: 1 }],
    consumedItems: [
      { item: 'oak_planks', count: 6 },
      { item: 'iron_ingot', count: 1 },
    ],
    workstation: 'crafting_table',
    budgetMs: 25000,
    maxRetries: 2,
    buildParams: (count) => ({ item: 'shield', count: Math.max(count, 1) }),
  },
  {
    id: 'op_craft_bucket',
    name: 'Craft Bucket',
    actionName: 'craft_item',
    category: 'craft',
    producedItems: [{ item: 'bucket', count: 1 }],
    consumedItems: [{ item: 'iron_ingot', count: 3 }],
    workstation: 'crafting_table',
    budgetMs: 25000,
    maxRetries: 2,
    buildParams: (count) => ({ item: 'bucket', count: Math.max(count, 1) }),
  },
];

export class OperatorRegistry {
  private operators = new Map<string, IOperatorDefinition>();
  private itemToOperator = new Map<string, IOperatorDefinition[]>();

  constructor(customOperators: IOperatorDefinition[] = BASE_OPERATORS) {
    for (const op of customOperators) {
      this.register(op);
    }
  }

  public register(op: IOperatorDefinition): void {
    this.operators.set(op.id, op);
    for (const prod of op.producedItems) {
      const list = this.itemToOperator.get(prod.item) || [];
      list.push(op);
      this.itemToOperator.set(prod.item, list);
    }
  }

  public getById(id: string): IOperatorDefinition | undefined {
    return this.operators.get(id);
  }

  public getOperatorsFor(item: string): IOperatorDefinition[] {
    return this.itemToOperator.get(item) || [];
  }

  public getAll(): IOperatorDefinition[] {
    return Array.from(this.operators.values());
  }
}

export const defaultOperatorRegistry = new OperatorRegistry();
