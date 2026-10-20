import { Bot } from 'mineflayer';
import { ActionDef, ActionExecutionContext, ActionResult } from '../types/index.js';

export const worldInteractionActions: ActionDef[] = [
  {
    name: 'interact_block',
    category: 'world_interaction',
    description: 'Interact with / right click a block (door, button, lever, gate, crafting table).',
    parameterSchema: {
      blockType: { type: 'string', description: 'Block name or notable block' },
    },
    isAvailable: (bot, obs) => obs.vitals.isAlive && !obs.container.isOpen,
    execute: async (bot: Bot, params: any): Promise<ActionResult> => {
      const block = bot.findBlock({
        matching: (b) => ['door', 'gate', 'button', 'lever', 'trapdoor', 'crafting_table'].some((k) => b.name.includes(k)),
        maxDistance: 4.5,
      });

      if (!block) return { status: 'failed', reason: 'No interactable block in reach.' };

      try {
        await bot.activateBlock(block);
        return { status: 'success', reason: `Interacted with ${block.name}.` };
      } catch (err: any) {
        return { status: 'failed', reason: `Interaction failed: ${err.message}` };
      }
    },
  },
  {
    name: 'interact_entity',
    category: 'world_interaction',
    description: 'Right click an entity (e.g. trade with villager, pet dog, etc.).',
    parameterSchema: {
      targetId: { type: 'string' },
    },
    isAvailable: (bot, obs) => obs.vitals.isAlive && obs.entities.length > 0,
    execute: async (bot: Bot, params: any, ctx: ActionExecutionContext): Promise<ActionResult> => {
      const entObs = ctx.observation.entities.find((e) => e.id === params.targetId);
      if (!entObs) return { status: 'failed', reason: 'Entity not found.' };

      const rawEntity = bot.entities[entObs.rawId];
      if (!rawEntity) return { status: 'failed', reason: 'Entity no longer available.' };

      try {
        await bot.activateEntity(rawEntity);
        return { status: 'success', reason: `Interacted with ${entObs.name}.` };
      } catch (err: any) {
        return { status: 'failed', reason: `Entity interaction failed: ${err.message}` };
      }
    },
  },
  {
    name: 'sleep',
    category: 'world_interaction',
    description: 'Sleep in a nearby bed (only at night or thunderstorm in Overworld).',
    parameterSchema: {},
    isAvailable: (bot, obs) => {
      return (
        Boolean(obs.vitals?.isAlive) &&
        !obs.vitals?.movementState?.isSleeping &&
        (obs.environment?.dayPhase === 'night' || obs.environment?.weather === 'thunder') &&
        obs.position?.dimension === 'overworld' &&
        obs.blocks?.notableBlocks?.some((b) => b.name.includes('bed'))
      );
    },
    execute: async (bot: Bot): Promise<ActionResult> => {
      const bed = bot.findBlock({ matching: (b) => b.name.includes('bed'), maxDistance: 4.5 });
      if (!bed) return { status: 'failed', reason: 'No bed in reach.' };

      try {
        await bot.sleep(bed);
        return { status: 'success', reason: 'Sleeping in bed.' };
      } catch (err: any) {
        return { status: 'failed', reason: `Cannot sleep: ${err.message}` };
      }
    },
  },
  {
    name: 'wake',
    category: 'world_interaction',
    description: 'Wake up from bed.',
    parameterSchema: {},
    isAvailable: (bot, obs) => obs.vitals.movementState.isSleeping,
    execute: async (bot: Bot): Promise<ActionResult> => {
      try {
        await bot.wake();
        return { status: 'success', reason: 'Woke up from bed.' };
      } catch (err: any) {
        return { status: 'failed', reason: `Failed to wake: ${err.message}` };
      }
    },
  },
  {
    name: 'mount',
    category: 'world_interaction',
    description: 'Mount a nearby rideable entity (boat, horse, minecart).',
    parameterSchema: {
      targetId: { type: 'string' },
    },
    isAvailable: (bot, obs) => obs.vitals.isAlive && !obs.vitals.movementState.isRiding,
    execute: async (bot: Bot, params: any, ctx: ActionExecutionContext): Promise<ActionResult> => {
      const entObs = ctx.observation.entities.find((e) => ['boat', 'horse', 'minecart', 'donkey'].includes(e.type));
      if (!entObs) return { status: 'failed', reason: 'No rideable entity nearby.' };
      const raw = bot.entities[entObs.rawId];
      if (!raw) return { status: 'failed', reason: 'Rideable entity not available.' };

      try {
        await bot.mount(raw);
        return { status: 'success', reason: `Mounted ${entObs.name}.` };
      } catch (err: any) {
        return { status: 'failed', reason: `Mount failed: ${err.message}` };
      }
    },
  },
  {
    name: 'dismount',
    category: 'world_interaction',
    description: 'Dismount from the vehicle currently riding.',
    parameterSchema: {},
    isAvailable: (bot, obs) => obs.vitals.movementState.isRiding,
    execute: async (bot: Bot): Promise<ActionResult> => {
      try {
        await bot.dismount();
        return { status: 'success', reason: 'Dismounted from vehicle.' };
      } catch (err: any) {
        return { status: 'failed', reason: `Dismount failed: ${err.message}` };
      }
    },
  },
];
