import { Bot } from 'mineflayer';
import { Observation, ActionResult } from '../types/index.js';
import { AppConfig } from '../config/index.js';
import { movementActions } from '../actions/movement.js';
import { inventoryCraftingActions } from '../actions/inventory_crafting.js';
import { distance3D } from '../utils/math.js';

export interface ReflexTriggerResult {
  triggered: boolean;
  name?: string;
  result?: ActionResult;
}

export class ReflexLayer {
  private config: AppConfig;
  private logger: any;
  private lastAutoAttackTime = 0;
  private autoAttackEnabled = true;

  constructor(config: AppConfig, logger: any) {
    this.config = config;
    this.logger = logger;
    this.autoAttackEnabled = config.safety.reflexes.autoAttackHostiles;
  }

  public setAutoAttackEnabled(enabled: boolean): void {
    this.autoAttackEnabled = enabled;
  }

  public isAutoAttackEnabled(): boolean {
    return this.autoAttackEnabled;
  }

  public async evaluateReflexes(bot: Bot, obs: Observation): Promise<ReflexTriggerResult> {
    const rConfig = this.config.safety.reflexes;
    if (!obs.vitals.isAlive) return { triggered: false };

    // 1. Drowning reflex (air < 8 and underwater)
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

    // 5. Auto-Attack Hostile Mobs Reflex (Auto-Defense Mode)
    if (this.autoAttackEnabled) {
      const now = Date.now();
      // Attack cooldown throttle: 650ms (matches ~1.5 attack speed for swords)
      if (now - this.lastAutoAttackTime > 650) {
        const attackRadius = rConfig.autoAttackRadius || 3.8;
        const targetHostile = obs.entities.find((e) => {
          if (!e.isHostile || e.distance > attackRadius) return false;
          // Safety: never attack owner, friends, or protected entities
          if (e.isOwner || this.config.agent.owners.includes(e.name) || this.config.agent.friends.includes(e.name)) {
            return false;
          }
          if (this.config.safety.protectedEntities.includes(e.type)) {
            return false;
          }
          return true;
        });

        if (targetHostile) {
          const rawEntity = bot.entities[targetHostile.rawId];
          if (rawEntity) {
            this.lastAutoAttackTime = now;
            this.logger.info(`AUTO-ATTACK MOD TRIGGERED: Defending against ${targetHostile.name} at distance ${targetHostile.distance}m.`);

            // Auto-equip best weapon
            if (bot.inventory) {
              const bestWeapon =
                bot.inventory.items().find((i) => i.name.endsWith('_sword')) ||
                bot.inventory.items().find((i) => i.name.endsWith('_axe'));
              if (bestWeapon && bot.heldItem?.type !== bestWeapon.type) {
                try {
                  await bot.equip(bestWeapon, 'hand');
                } catch {}
              }
            }

            try {
              await bot.lookAt(rawEntity.position.offset(0, rawEntity.height ? rawEntity.height * 0.75 : 1.2, 0), true);
              bot.attack(rawEntity);

              // Auto shield block if enabled and mob is skeleton or creeper about to explode
              if (rConfig.autoShieldBlock && obs.inventory.toolSummary.hasShield && (targetHostile.type === 'skeleton' || targetHostile.type === 'creeper')) {
                bot.activateItem(true);
                await new Promise((res) => setTimeout(res, 400));
                bot.deactivateItem();
              }

              return {
                triggered: true,
                name: `auto_attack_${targetHostile.name}`,
                result: {
                  status: 'success',
                  reason: `Auto-attack reflex defended against ${targetHostile.name}`,
                },
              };
            } catch (err: any) {
              this.logger.warn(`Auto-attack failed: ${err.message}`);
            }
          }
        }
      }
    }

    return { triggered: false };
  }

  public async autoDefendAttacker(bot: Bot, attacker: any): Promise<boolean> {
    if (!this.autoAttackEnabled || !attacker || !bot.entity) return false;

    // Safety checks
    const username = attacker.username || attacker.name;
    if (this.config.agent.owners.includes(username) || this.config.agent.friends.includes(username)) {
      return false;
    }
    if (this.config.safety.protectedEntities.includes(attacker.type || attacker.name)) {
      return false;
    }

    const dist = distance3D(bot.entity.position, attacker.position);
    if (dist > (this.config.safety.reflexes.autoAttackRadius || 4.5)) return false;

    this.logger.info(`AUTO-DEFENSE: Retaliating against hostile attacker ${username || attacker.name}.`);

    // Auto-equip weapon
    if (bot.inventory) {
      const bestWeapon =
        bot.inventory.items().find((i) => i.name.endsWith('_sword')) ||
        bot.inventory.items().find((i) => i.name.endsWith('_axe'));
      if (bestWeapon && bot.heldItem?.type !== bestWeapon.type) {
        try {
          await bot.equip(bestWeapon, 'hand');
        } catch {}
      }
    }

    try {
      await bot.lookAt(attacker.position.offset(0, attacker.height ? attacker.height / 2 : 1, 0), true);
      bot.attack(attacker);
      this.lastAutoAttackTime = Date.now();
      return true;
    } catch {
      return false;
    }
  }
}
