import { Bot } from 'mineflayer';
import { Observation, ActionResult } from '../types/index.js';
import { AppConfig } from '../config/index.js';
import { movementActions } from '../actions/movement.js';
import { inventoryCraftingActions } from '../actions/inventory_crafting.js';

export interface ReflexTriggerResult {
  triggered: boolean;
  name?: string;
  result?: ActionResult;
}

export class ReflexLayer {
  private config: AppConfig;
  private logger: any;

  constructor(config: AppConfig, logger: any) {
    this.config = config;
    this.logger = logger;
  }

  public async evaluateReflexes(bot: Bot, obs: Observation): Promise<ReflexTriggerResult> {
    const rConfig = this.config.safety.reflexes;
    if (!obs.vitals.isAlive) return { triggered: false };

    // 1. Drowning reflex (air < 6 and underwater)
    if (rConfig.escapeLavaWater && obs.vitals.underwater && obs.vitals.oxygen < 8) {
      this.logger.warn('REFLEX TRIGGERED: Low oxygen in water! Swimming up immediately.');
      bot.setControlState('jump', true);
      await new Promise((res) => setTimeout(res, 1200));
      bot.setControlState('jump', false);
      return {
        triggered: true,
        name: 'swim_up_low_oxygen',
        result: { status: 'success', reason: 'Swam upward to restore oxygen.' },
      };
    }

    // 2. Lava emergency reflex
    if (rConfig.escapeLavaWater && (obs.vitals.movementState.inLava || obs.vitals.isBurning)) {
      this.logger.warn('REFLEX TRIGGERED: Lava or fire hazard detected! Jumping and fleeing.');
      bot.setControlState('jump', true);
      bot.setControlState('forward', true);
      bot.setControlState('sprint', true);
      await new Promise((res) => setTimeout(res, 800));
      bot.setControlState('jump', false);
      bot.setControlState('forward', false);
      bot.setControlState('sprint', false);
      return {
        triggered: true,
        name: 'flee_lava_hazard',
        result: { status: 'success', reason: 'Fled from lava / fire hazard.' },
      };
    }

    // 3. Critically low health emergency flee reflex
    if (rConfig.emergencyFlee && obs.vitals.health <= rConfig.fleeHealthThreshold) {
      const hostileNearby = obs.entities.find((e) => e.isHostile && e.distance < 8);
      if (hostileNearby) {
        this.logger.warn(`REFLEX TRIGGERED: Health critical (${obs.vitals.health}) with hostile ${hostileNearby.name} nearby!`);
        const fleeDef = movementActions.find((a) => a.name === 'flee');
        if (fleeDef) {
          const res = await fleeDef.execute(bot, { threatId: hostileNearby.id, distance: 12 }, {
            bot,
            observation: obs,
            logger: this.logger,
            config: this.config,
          });
          return {
            triggered: true,
            name: 'emergency_flee_hostile',
            result: res,
          };
        }
      }
    }

    // 4. Auto-eat when hunger is low
    if (rConfig.autoEat && obs.vitals.food <= rConfig.eatFoodThreshold && obs.inventory.foodList.length > 0) {
      this.logger.info(`REFLEX TRIGGERED: Hunger below threshold (${obs.vitals.food} <= ${rConfig.eatFoodThreshold}). Eating food.`);
      const eatDef = inventoryCraftingActions.find((a) => a.name === 'eat');
      if (eatDef) {
        const res = await eatDef.execute(bot, {}, {
          bot,
          observation: obs,
          logger: this.logger,
          config: this.config,
        });
        return {
          triggered: true,
          name: 'auto_eat',
          result: res,
        };
      }
    }

    return { triggered: false };
  }
}
