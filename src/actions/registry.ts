import { ActionDef } from '../types/index.js';
import { movementActions } from './movement.js';
import { miningBuildingActions } from './mining_building.js';
import { inventoryCraftingActions } from './inventory_crafting.js';
import { combatActions } from './combat.js';
import { worldInteractionActions } from './world_interaction.js';
import { metaActions } from './meta.js';

export const allActions: ActionDef[] = [
  ...movementActions,
  ...miningBuildingActions,
  ...inventoryCraftingActions,
  ...combatActions,
  ...worldInteractionActions,
  ...metaActions,
];

export const actionMap = new Map<string, ActionDef>();
for (const act of allActions) {
  actionMap.set(act.name, act);
}
