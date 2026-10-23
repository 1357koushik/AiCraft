import { Bot } from 'mineflayer';
import { ActionDef, ActionExecutionContext, ActionResult } from '../types/index.js';
import { distance3D } from '../utils/math.js';
import { goals } from 'mineflayer-pathfinder';
import { resolveAndValidateTarget } from '../safety/index.js';
import { isActionContextActive } from '../agent/arbiter.js';

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
      const resolution = resolveAndValidateTarget(bot, params.targetId, ctx.observation, ctx.config, 4.5);
      if (!resolution.valid) {
        return { status: 'failed', reason: resolution.reason || 'Invalid combat target.' };
      }
      const rawEntity = resolution.rawEntity;
      const targetObs = resolution.targetObs!;

      // Auto equip best sword or axe if available
      const bestWeapon =
        bot.inventory?.items().find((i) => i.name.endsWith('_sword')) ||
        bot.inventory?.items().find((i) => i.name.endsWith('_axe'));
      if (bestWeapon && bot.heldItem?.type !== bestWeapon.type) {
        if (!isActionContextActive(ctx)) {
          return { status: 'interrupted', reason: 'Attack cancelled before weapon equip.' };
        }
        try {
          await bot.equip(bestWeapon, 'hand');
        } catch {}
      }

      if (!isActionContextActive(ctx)) {
        return { status: 'interrupted', reason: 'Attack cancelled before approach.' };
      }

      // Approach if farther than 3 blocks
      const dist = distance3D(bot.entity.position, rawEntity.position);
      console.log(`[COMBAT] Approaching and attacking ${targetObs.name} (dist: ${dist.toFixed(1)}m, weapon: ${bestWeapon?.name || 'hand'})...`);
      if (dist > 3.0) {
        if (Boolean((rawEntity as any).isInWater) && !Boolean((bot.entity as any)?.isInWater)) {
          return { status: 'failed', reason: 'Target is in water; halting melee approach to avoid entering water hazard.' };
        }
        try {
          const goal = new goals.GoalFollow(rawEntity, 2.5);
          (bot as any).pathfinder?.setGoal(goal, true);
          await new Promise((res) => setTimeout(res, 800));
          (bot as any).pathfinder?.setGoal(null);
        } catch {}
      }

      if (!isActionContextActive(ctx)) {
        return { status: 'interrupted', reason: 'Attack cancelled before strike.' };
      }

      try {
        await bot.lookAt(rawEntity.position.offset(0, rawEntity.height ? rawEntity.height / 2 : 1, 0), true);
        if (!isActionContextActive(ctx)) {
          return { status: 'interrupted', reason: 'Attack cancelled before strike.' };
        }
        bot.attack(rawEntity);
        return { status: 'success', reason: `Attacked ${targetObs.name} (${targetObs.type}).` };
      } catch (err: any) {
        if (!isActionContextActive(ctx)) {
          return { status: 'interrupted', reason: 'Attack cancelled.' };
        }
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
    execute: async (bot: Bot, params: any, ctx: ActionExecutionContext): Promise<ActionResult> => {
      if (ctx.abortSignal?.aborted) {
        return { status: 'interrupted', reason: 'Shield block cancelled before start.' };
      }

      const shield = bot.inventory?.items().find((i) => i.name === 'shield');
      if (!shield) {
        return { status: 'failed', reason: 'No shield found in inventory to block with.' };
      }

      try {
        await bot.equip(shield, 'off-hand');
      } catch (err: any) {
        return { status: 'failed', reason: `Failed equipping shield to off-hand: ${err.message}` };
      }

      const duration = Math.min(Math.max(params.durationMs || 1500, 100), 5000);
      let onAbort: (() => void) | null = null;
      try {
        bot.activateItem(true); // raise off-hand shield
        if (ctx.abortSignal) {
          onAbort = () => {
            try { bot.deactivateItem(); } catch {}
          };
          ctx.abortSignal.addEventListener('abort', onAbort, { once: true });
        }

        const interval = 50;
        const loops = Math.ceil(duration / interval);
        for (let i = 0; i < loops; i++) {
          if (ctx.abortSignal?.aborted) {
            return { status: 'interrupted', reason: 'Shield block interrupted by preemption signal.' };
          }
          await new Promise((res) => setTimeout(res, interval));
        }

        return { status: 'success', reason: `Shield raised for ${duration}ms.` };
      } catch (err: any) {
        if (ctx.abortSignal?.aborted) {
          return { status: 'interrupted', reason: 'Shield block interrupted by preemption signal.' };
        }
        return { status: 'failed', reason: `Shield block failed: ${err.message}` };
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
      const resolution = resolveAndValidateTarget(bot, params.targetId, ctx.observation, ctx.config, 24);
      if (!resolution.valid) {
        return { status: 'failed', reason: resolution.reason || 'Invalid shoot target.' };
      }
      const rawEntity = resolution.rawEntity;
      const targetObs = resolution.targetObs!;

      const bowItem = bot.inventory?.items().find((i) => i.name === 'bow' || i.name === 'crossbow');
      if (!bowItem) return { status: 'failed', reason: 'No bow or crossbow in inventory.' };

      if (!isActionContextActive(ctx)) {
        return { status: 'interrupted', reason: 'Shoot cancelled before weapon equip.' };
      }

      let onAbort: (() => void) | null = null;
      try {
        await bot.equip(bowItem, 'hand');
        if (!isActionContextActive(ctx)) {
          return { status: 'interrupted', reason: 'Shoot cancelled before aiming.' };
        }

        await bot.lookAt(rawEntity.position.offset(0, rawEntity.height ? rawEntity.height * 0.8 : 1.2, 0), true);
        if (!isActionContextActive(ctx)) {
          return { status: 'interrupted', reason: 'Shoot cancelled before draw.' };
        }

        bot.activateItem();

        if (ctx.abortSignal) {
          onAbort = () => {
            try { bot.deactivateItem(); } catch {}
          };
          ctx.abortSignal.addEventListener('abort', onAbort, { once: true });
        }

        const chargeInterval = 50;
        const chargeLoops = 24; // ~1200ms
        for (let i = 0; i < chargeLoops; i++) {
          if (!isActionContextActive(ctx)) {
            try { bot.deactivateItem(); } catch {}
            return { status: 'interrupted', reason: 'Bow charge interrupted by cancellation.' };
          }
          await new Promise((res) => setTimeout(res, chargeInterval));
        }

        if (!isActionContextActive(ctx)) {
          try { bot.deactivateItem(); } catch {}
          return { status: 'interrupted', reason: 'Bow charge interrupted by cancellation.' };
        }

        bot.deactivateItem();
        return { status: 'success', reason: `Shot arrow at ${targetObs.name}.` };
      } catch (err: any) {
        if (!isActionContextActive(ctx)) {
          return { status: 'interrupted', reason: 'Bow charge interrupted by cancellation.' };
        }
        return { status: 'failed', reason: `Shoot failed: ${err.message}` };
      } finally {
        if (ctx.abortSignal && onAbort) {
          ctx.abortSignal.removeEventListener('abort', onAbort);
        }
        if (isActionContextActive(ctx)) {
          try { bot.deactivateItem(); } catch {}
        }
      }
    },
  },
];
