import { Bot } from 'mineflayer';
import { ActionDef, ActionExecutionContext, ActionResult } from '../types/index.js';
import { distance3D } from '../utils/math.js';
import { goals } from 'mineflayer-pathfinder';

export const combatActions: ActionDef[] = [
  {
    name: 'attack',
    category: 'combat',
    description: 'Attack a specific entity with held weapon (strictly forbids owner & friend-listed players).',
    parameterSchema: {
      targetId: { type: 'string', description: 'Target entity ID (e.g. e1)' },
    },
    isAvailable: (bot, obs) => obs.vitals.isAlive && obs.entities.some((e) => !e.isOwner && !e.isItem),
    getAvailableChoices: (bot, obs) => ({
      targetId: obs.entities.filter((e) => !e.isOwner && !e.isItem).map((e) => e.id),
    }),
    execute: async (bot: Bot, params: any, ctx: ActionExecutionContext): Promise<ActionResult> => {
      const targetId = params.targetId;
      const targetObs = ctx.observation.entities.find((e) => e.id === targetId);
      if (!targetObs) return { status: 'failed', reason: `Entity ${targetId} not found.` };

      // Safety check: NEVER attack owner or friends
      if (targetObs.isOwner || ctx.config.agent.owners.includes(targetObs.name) || ctx.config.agent.friends.includes(targetObs.name)) {
        return { status: 'failed', reason: `Safety violation: Target ${targetObs.name} is protected (owner/friend).` };
      }

      const rawEntity = bot.entities[targetObs.rawId];
      if (!rawEntity) return { status: 'failed', reason: 'Target entity no longer exists.' };

      // Auto equip best sword or axe if available
      const bestWeapon = bot.inventory.items().find((i) => i.name.endsWith('_sword')) || bot.inventory.items().find((i) => i.name.endsWith('_axe'));
      if (bestWeapon && bot.heldItem?.type !== bestWeapon.type) {
        try {
          await bot.equip(bestWeapon, 'hand');
        } catch {}
      }

      // Approach if farther than 3 blocks
      const dist = distance3D(bot.entity.position, rawEntity.position);
      if (dist > 3.0) {
        try {
          const goal = new goals.GoalFollow(rawEntity, 2.5);
          (bot as any).pathfinder.setGoal(goal, true);
          await new Promise((res) => setTimeout(res, 1000));
          (bot as any).pathfinder.setGoal(null);
        } catch {}
      }

      try {
        await bot.lookAt(rawEntity.position.offset(0, rawEntity.height ? rawEntity.height / 2 : 1, 0), true);
        bot.attack(rawEntity);
        return { status: 'success', reason: `Attacked ${targetObs.name} (${targetObs.type}).` };
      } catch (err: any) {
        return { status: 'failed', reason: `Attack failed: ${err.message}` };
      }
    },
  },
  {
    name: 'attack_nearest',
    category: 'combat',
    description: 'Attack the nearest hostile mob.',
    parameterSchema: {},
    isAvailable: (bot, obs) => obs.vitals.isAlive && obs.entities.some((e) => e.isHostile),
    execute: async (bot: Bot, params: any, ctx: ActionExecutionContext): Promise<ActionResult> => {
      const nearestHostile = ctx.observation.entities.find((e) => e.isHostile);
      if (!nearestHostile) return { status: 'failed', reason: 'No hostile mobs nearby.' };

      return combatActions[0].execute(bot, { targetId: nearestHostile.id }, ctx);
    },
  },
  {
    name: 'block_with_shield',
    category: 'combat',
    description: 'Raise shield in off-hand to block incoming damage.',
    parameterSchema: {
      durationMs: { type: 'number', description: 'Duration in ms (default 1500)' },
    },
    isAvailable: (bot, obs) => obs.vitals.isAlive && obs.inventory.toolSummary.hasShield,
    execute: async (bot: Bot, params: any): Promise<ActionResult> => {
      const duration = Math.min(params.durationMs || 1500, 4000);
      try {
        bot.activateItem(true); // off-hand shield
        await new Promise((res) => setTimeout(res, duration));
        bot.deactivateItem();
        return { status: 'success', reason: `Shield raised for ${duration}ms.` };
      } catch (err: any) {
        bot.deactivateItem();
        return { status: 'failed', reason: `Shield block failed: ${err.message}` };
      }
    },
  },
  {
    name: 'shoot',
    category: 'combat',
    description: 'Shoot bow or crossbow at target.',
    parameterSchema: {
      targetId: { type: 'string' },
    },
    isAvailable: (bot, obs) => {
      const inv = obs.inventory.aggregates.totalItemCounts;
      return obs.vitals.isAlive && (Boolean(inv['bow']) || Boolean(inv['crossbow'])) && Boolean(inv['arrow']);
    },
    execute: async (bot: Bot, params: any, ctx: ActionExecutionContext): Promise<ActionResult> => {
      const targetObs = ctx.observation.entities.find((e) => e.id === params.targetId);
      if (!targetObs) return { status: 'failed', reason: 'Target not found.' };

      const bowItem = bot.inventory.items().find((i) => i.name === 'bow' || i.name === 'crossbow');
      if (!bowItem) return { status: 'failed', reason: 'No bow or crossbow in inventory.' };

      const rawEntity = bot.entities[targetObs.rawId];
      if (!rawEntity) return { status: 'failed', reason: 'Target no longer in range.' };

      try {
        await bot.equip(bowItem, 'hand');
        await bot.lookAt(rawEntity.position.offset(0, rawEntity.height ? rawEntity.height * 0.8 : 1.2, 0), true);
        bot.activateItem();
        await new Promise((res) => setTimeout(res, 1200)); // Charge bow
        bot.deactivateItem();
        return { status: 'success', reason: `Shot arrow at ${targetObs.name}.` };
      } catch (err: any) {
        bot.deactivateItem();
        return { status: 'failed', reason: `Shoot failed: ${err.message}` };
      }
    },
  },
];
