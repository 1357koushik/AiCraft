import { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { Observation, ActionResult } from '../types/index.js';
import { AppConfig } from '../config/index.js';
import { movementActions } from '../actions/movement.js';
import { inventoryCraftingActions } from '../actions/inventory_crafting.js';
import { distance3D } from '../utils/math.js';
import { ActionArbiter, ActionPriority } from './arbiter.js';
import { isAlive } from '../safety/index.js';
import { selectBestFood } from '../safety/survival_policy.js';

export interface ReflexTriggerResult {
  triggered: boolean;
  name?: string;
  result?: ActionResult;
}

export interface AirPocketRoute {
  target: Vec3;
  path: Vec3[];
}

/**
 * Bounded 3D Breadth-First Search (BFS) to find a reachable two-block air pocket.
 * Explores around underwater obstacles, walls, and overhangs.
 */
export function findReachableAirPocketBFS(
  bot: Bot,
  startPos: Vec3,
  maxRadius: number = 6,
  maxIterations: number = 350
): AirPocketRoute | null {
  if (!bot.blockAt) return null;

  const queue: Vec3[] = [startPos.floored()];
  const visited = new Set<string>();
  const parentMap = new Map<string, Vec3>();

  const startKey = `${startPos.x},${startPos.y},${startPos.z}`;
  visited.add(startKey);

  let iterations = 0;
  const directions = [
    new Vec3(1, 0, 0),
    new Vec3(-1, 0, 0),
    new Vec3(0, 0, 1),
    new Vec3(0, 0, -1),
    new Vec3(0, 1, 0),
    new Vec3(0, -1, 0),
  ];

  while (queue.length > 0 && iterations < maxIterations) {
    iterations++;
    const current = queue.shift()!;

    // Check if current node is a valid air pocket (head space is air, feet space is passable)
    if (!current.equals(startPos.floored())) {
      const bFeet = bot.blockAt(current);
      const bHead = bot.blockAt(current.offset(0, 1, 0));

      if (bFeet && bHead) {
        const isHeadAir = bHead.name === 'air' || bHead.name === 'cave_air';
        const isFeetPassable =
          bFeet.boundingBox !== 'block' &&
          bFeet.name !== 'lava' &&
          bFeet.name !== 'flowing_lava' &&
          bFeet.name !== 'fire';

        if (isHeadAir && isFeetPassable) {
          // Reconstruct path
          const path: Vec3[] = [];
          let currKey = `${current.x},${current.y},${current.z}`;
          let currPos: Vec3 | undefined = current;
          while (currPos && !currPos.equals(startPos.floored())) {
            path.unshift(currPos);
            currPos = parentMap.get(currKey);
            if (currPos) {
              currKey = `${currPos.x},${currPos.y},${currPos.z}`;
            }
          }
          return { target: current, path };
        }
      }
    }

    // Expand neighbors (only explore current depth and upward for air escape)
    for (const dir of directions) {
      const neighbor = current.plus(dir);
      if (neighbor.y < startPos.y) continue; // Do not dive deeper during drowning emergency
      if (neighbor.y - startPos.y > 4) continue; // Restrict upward search to realistic reach

      const key = `${neighbor.x},${neighbor.y},${neighbor.z}`;
      if (visited.has(key)) continue;

      const dist = Math.max(
        Math.abs(neighbor.x - startPos.x),
        Math.abs(neighbor.y - startPos.y),
        Math.abs(neighbor.z - startPos.z)
      );
      if (dist > maxRadius) continue;

      visited.add(key);

      const bFeet = bot.blockAt(neighbor);
      const bHead = bot.blockAt(neighbor.offset(0, 1, 0));

      // Both feet and head must be loaded and passable to traverse
      if (!bFeet || !bHead) continue;
      if (bFeet.boundingBox === 'block' || bHead.boundingBox === 'block') continue;
      if (
        bFeet.name === 'lava' ||
        bFeet.name === 'flowing_lava' ||
        bFeet.name === 'fire' ||
        bHead.name === 'lava' ||
        bHead.name === 'flowing_lava' ||
        bHead.name === 'fire'
      ) {
        continue;
      }

      parentMap.set(key, current);
      queue.push(neighbor);
    }
  }

  return null;
}

export class ReflexLayer {
  private config: AppConfig;
  private logger: any;
  private lastAutoAttackTime = 0;
  private autoAttackEnabled = false; // Opt-in: strictly disabled by default
  private isEating = false;
  private currentCombatTargetId: number | null = null;

  constructor(config: AppConfig, logger: any) {
    this.config = config;
    this.logger = logger;
    this.autoAttackEnabled = Boolean(config.safety.reflexes.autoAttackHostiles);
  }

  public setAutoAttackEnabled(enabled: boolean): void {
    this.autoAttackEnabled = enabled;
  }

  public isAutoAttackEnabled(): boolean {
    return this.autoAttackEnabled;
  }

  public getIsEating(): boolean {
    return this.isEating;
  }

  public getCurrentCombatTargetId(): number | null {
    return this.currentCombatTargetId;
  }

  public clearCombatTarget(): void {
    this.currentCombatTargetId = null;
  }

  public async evaluateReflexes(bot: Bot, obs: Observation, arbiter?: ActionArbiter): Promise<ReflexTriggerResult> {
    const rConfig = this.config.safety.reflexes;
    if (!obs.vitals.isAlive || !bot.entity) return { triggered: false };

    // 1. Drowning reflex (air < 8 and underwater) - HIGHEST PRIORITY
    if (rConfig.escapeLavaWater && obs.vitals.underwater && obs.vitals.oxygen < 8) {
      if (this.isEating) {
        try { bot.deactivateItem(); } catch {}
        this.isEating = false;
      }
      this.logger?.warn?.('REFLEX TRIGGERED: Low oxygen in water! Checking overhead clearance and escaping to air.');
      
      let actionId = '';
      let epoch = 0;
      if (arbiter) {
        arbiter.preempt(bot, 'Drowning emergency: low oxygen in water', ActionPriority.SURVIVAL_EMERGENCY);
        const actionInfo = arbiter.startAction('swim_up_low_oxygen', ActionPriority.SURVIVAL_EMERGENCY, bot, ['movement', 'look']);
        actionId = actionInfo.actionId;
        epoch = actionInfo.epoch;
      }

      try {
        (bot as any).pathfinder?.stop();
      } catch {}

      const feetPos = bot.entity.position.floored();
      const overheadBlock = bot.blockAt ? bot.blockAt(feetPos.offset(0, 2, 0)) : null;
      const isCeilingBlocked = Boolean(overheadBlock && overheadBlock.boundingBox === 'block');

      let airTarget: Vec3 | null = null;
      let escapeStatus: 'success' | 'failed' = 'success';
      let escapeReason = '';

      try {
        if (!isCeilingBlocked && (!overheadBlock || overheadBlock.name !== 'lava')) {
          // Open water column above: swim straight upward
          bot.setControlState('jump', true);
          await new Promise((res) => setTimeout(res, 800));
          escapeReason = 'Swam upward through open water column to restore oxygen.';
        } else {
          // Overhead is blocked by solid ceiling or unloaded block (underwater cave / ice sheet / structure).
          // Search in 3D using bounded BFS for a genuinely breathable, reachable two-block air pocket.
          const route = findReachableAirPocketBFS(bot, feetPos, 6, 350);

          if (route && route.path.length > 0) {
            airTarget = route.target;
            let routeTraversed = true;

            for (const waypoint of route.path) {
              // Dynamic route revalidation: verify waypoint has not become solid, unloaded, or hazardous
              const bStepFeet = bot.blockAt ? bot.blockAt(waypoint) : null;
              const bStepHead = bot.blockAt ? bot.blockAt(waypoint.offset(0, 1, 0)) : null;

              if (
                !bStepFeet ||
                !bStepHead ||
                bStepFeet.boundingBox === 'block' ||
                bStepHead.boundingBox === 'block' ||
                bStepFeet.name === 'lava' ||
                bStepFeet.name === 'flowing_lava' ||
                bStepFeet.name === 'fire' ||
                bStepHead.name === 'lava' ||
                bStepHead.name === 'flowing_lava' ||
                bStepHead.name === 'fire'
              ) {
                routeTraversed = false;
                escapeStatus = 'failed';
                escapeReason = `Air pocket route obstructed dynamically at ${waypoint.x}, ${waypoint.y}, ${waypoint.z}`;
                break;
              }

              if (bot.lookAt) {
                await bot.lookAt(waypoint.offset(0.5, 1.0, 0.5), true);
              }
              bot.setControlState('forward', true);
              bot.setControlState('jump', true);
              await new Promise((res) => setTimeout(res, 200));
            }

            if (routeTraversed) {
              // Final revalidation of destination breathable state
              const destHead = bot.blockAt ? bot.blockAt(airTarget.offset(0, 1, 0)) : null;
              const destFeet = bot.blockAt ? bot.blockAt(airTarget) : null;
              if (
                destHead &&
                (destHead.name === 'air' || destHead.name === 'cave_air') &&
                destFeet &&
                destFeet.boundingBox !== 'block'
              ) {
                escapeStatus = 'success';
                escapeReason = `Navigated toward air pocket away from underwater ceiling obstruction at ${airTarget.x}, ${airTarget.y}, ${airTarget.z} via 3D BFS.`;
              } else {
                escapeStatus = 'failed';
                escapeReason = `Reached air pocket waypoint at ${airTarget.x}, ${airTarget.y}, ${airTarget.z} but space is not breathable.`;
              }
            }
          } else {
            escapeStatus = 'failed';
            escapeReason = 'No reachable air pocket found; overhead obstructed and horizontal paths blocked.';
          }
        }
      } finally {
        try {
          bot.setControlState?.('jump', false);
          bot.clearControlStates?.();
        } catch {}
        if (arbiter && actionId) {
          arbiter.finishAction(actionId, epoch, bot);
        }
      }

      return {
        triggered: true,
        name: 'swim_up_low_oxygen',
        result: {
          status: escapeStatus,
          reason: escapeReason,
        },
      };
    }

    // 2. Lava emergency reflex - HIGH PRIORITY
    if (rConfig.escapeLavaWater && (obs.vitals.movementState?.inLava || obs.vitals.isBurning)) {
      if (this.isEating) {
        try { bot.deactivateItem(); } catch {}
        this.isEating = false;
      }
      this.logger?.warn?.('REFLEX TRIGGERED: Lava/fire hazard! Scanning for route-aware safe ground.');

      let actionId = '';
      let epoch = 0;
      if (arbiter) {
        arbiter.preempt(bot, 'Lava emergency', ActionPriority.SURVIVAL_EMERGENCY);
        const actionInfo = arbiter.startAction('flee_lava_hazard', ActionPriority.SURVIVAL_EMERGENCY, bot, ['movement', 'look']);
        actionId = actionInfo.actionId;
        epoch = actionInfo.epoch;
      }

      try {
        (bot as any).pathfinder?.stop();
      } catch {}

      const feetPos = bot.entity.position.floored();
      const directions = [
        new Vec3(1, 0, 0),
        new Vec3(-1, 0, 0),
        new Vec3(0, 0, 1),
        new Vec3(0, 0, -1),
        new Vec3(1, 0, 1),
        new Vec3(-1, 0, 1),
        new Vec3(1, 0, -1),
        new Vec3(-1, 0, -1),
      ];

      let safePos: Vec3 | null = null;

      // 1. Scan immediate neighbors (radius 1 and radius 2) for verified safe ground
      for (const distMult of [1, 2]) {
        for (const dir of directions) {
          const stepDir = dir.scaled(distMult);
          // Check 1 block up (bank), level, and 1 block down
          for (const dy of [1, 0, -1]) {
            const checkFeet = feetPos.plus(stepDir).offset(0, dy, 0);
            const checkHead = checkFeet.offset(0, 1, 0);
            const checkGround = checkFeet.offset(0, -1, 0);

            const bFeet = bot.blockAt(checkFeet);
            const bHead = bot.blockAt(checkHead);
            const bGround = bot.blockAt(checkGround);

            // Reject if any candidate block data is unloaded
            if (bFeet === null || bHead === null || bGround === null) continue;

            // Ground must be solid non-hazardous block
            const isGroundSafe =
              bGround.boundingBox === 'block' &&
              bGround.name !== 'lava' &&
              bGround.name !== 'flowing_lava' &&
              bGround.name !== 'magma_block' &&
              bGround.name !== 'fire' &&
              bGround.name !== 'soul_fire';

            // Feet and Head must be passable non-hazardous space (not solid wall, not lava/fire)
            const isSpaceClear =
              bFeet.boundingBox !== 'block' &&
              bFeet.name !== 'lava' &&
              bFeet.name !== 'flowing_lava' &&
              bFeet.name !== 'fire' &&
              bFeet.name !== 'soul_fire' &&
              bFeet.name !== 'cactus' &&
              bFeet.name !== 'sweet_berry_bush' &&
              bFeet.name !== 'powder_snow' &&
              bHead.boundingBox !== 'block' &&
              bHead.name !== 'lava' &&
              bHead.name !== 'flowing_lava' &&
              bHead.name !== 'fire';

            // If radius 2, check that intermediate space has clearance and no wall or lava trap
            let isIntermediateClear = true;
            if (distMult === 2) {
              const interFeetPos = feetPos.plus(dir).offset(0, dy > 0 ? 1 : 0, 0);
              const interHeadPos = interFeetPos.offset(0, 1, 0);
              const bInterFeet = bot.blockAt(interFeetPos);
              const bInterHead = bot.blockAt(interHeadPos);

              if (
                bInterFeet === null ||
                bInterHead === null ||
                bInterFeet.boundingBox === 'block' ||
                bInterHead.boundingBox === 'block' ||
                bInterFeet.name === 'lava' ||
                bInterFeet.name === 'flowing_lava' ||
                bInterFeet.name === 'fire'
              ) {
                isIntermediateClear = false;
              }
            }

            if (isGroundSafe && isSpaceClear && isIntermediateClear) {
              safePos = checkFeet;
              break;
            }
          }
          if (safePos) break;
        }
        if (safePos) break;
      }

      // Check overhead clearance for fallback jumping
      const overhead = bot.blockAt(feetPos.offset(0, 2, 0));
      const isOverheadBlocked = Boolean(!overhead || overhead.boundingBox === 'block');

      let lavaResultStatus: 'success' | 'failed' = 'success';
      let lavaResultReason = '';

      try {
        if (safePos) {
          // Found safe ground: look towards safe ground and jump toward it
          if (bot.lookAt) {
            await bot.lookAt(safePos.offset(0.5, 0.5, 0.5), true);
          }
          bot.setControlState('forward', true);
          bot.setControlState('jump', true);
          await new Promise((res) => setTimeout(res, 600));
          lavaResultReason = `Escaped toward safe ground at ${safePos.x}, ${safePos.y}, ${safePos.z}`;
        } else if (!isOverheadBlocked) {
          // No safe ground confirmed but overhead is clear: jump straight up to avoid submerging deeper
          bot.setControlState('jump', true);
          await new Promise((res) => setTimeout(res, 400));
          lavaResultStatus = 'failed';
          lavaResultReason = 'No safe ground reachable; performed emergency jump upward to avoid submerging in lava.';
        } else {
          // Overhead is blocked and no safe ground found: completely enclosed in lava
          lavaResultStatus = 'failed';
          lavaResultReason = 'Enclosed in lava hazard with overhead ceiling and no validated escape route.';
        }
      } finally {
        try {
          bot.setControlState?.('jump', false);
          bot.clearControlStates?.();
        } catch {}
        if (arbiter && actionId) {
          arbiter.finishAction(actionId, epoch, bot);
        }
      }

      return {
        triggered: true,
        name: 'flee_lava_hazard',
        result: {
          status: lavaResultStatus,
          reason: lavaResultReason,
        },
      };
    }

    // 3. Critically low health emergency flee reflex
    if (rConfig.emergencyFlee && obs.vitals.health <= rConfig.fleeHealthThreshold) {
      const hostileNearby = obs.entities.find((e) => e.isHostile && e.distance < 8);
      if (hostileNearby) {
        this.logger?.warn?.(`REFLEX TRIGGERED: Health critical (${obs.vitals.health}) with hostile ${hostileNearby.name} nearby!`);
        const fleeDef = movementActions.find((a) => a.name === 'flee');
        if (fleeDef) {
          let actionId = '';
          let epoch = 0;
          if (arbiter) {
            arbiter.preempt(bot, 'Emergency flee hostile', ActionPriority.SURVIVAL_EMERGENCY);
            const actionInfo = arbiter.startAction('emergency_flee_hostile', ActionPriority.SURVIVAL_EMERGENCY, bot, ['movement', 'look']);
            actionId = actionInfo.actionId;
            epoch = actionInfo.epoch;
          }
          try {
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
          } finally {
            if (arbiter && actionId) arbiter.finishAction(actionId, epoch, bot);
          }
        }
      }
    }

    // 4. Auto-eat when hunger is low or health damaged (food <= threshold or natural regen needed, not already eating)
    const needsFoodForHunger = obs.vitals.food <= rConfig.eatFoodThreshold;
    const needsFoodForRegen = obs.vitals.health < 20 && obs.vitals.food < 18;
    if (rConfig.autoEat && !this.isEating && (needsFoodForHunger || needsFoodForRegen) && obs.inventory.foodList.length > 0) {
      // Validate that safe edible food actually exists before triggering reflex
      const isStarving = obs.vitals.food <= 2 || obs.vitals.health <= 6;
      const healthPriority = obs.vitals.health <= 10;
      const foodChoice = selectBestFood(bot, { healthPriority, allowEmergencyOnly: isStarving });

      if (foodChoice.selectedItem) {
        this.logger?.info?.(`REFLEX TRIGGERED: Hunger/regen needed (food=${obs.vitals.food}, hp=${obs.vitals.health}). Eating ${foodChoice.foodDef?.name}.`);
        const eatDef = inventoryCraftingActions.find((a) => a.name === 'eat');
        if (eatDef) {
          this.isEating = true;
          let actionId = '';
          let epoch = 0;
          if (arbiter) {
            arbiter.preempt(bot, 'Auto-eat hunger/health reflex', ActionPriority.NORMAL);
            const actionInfo = arbiter.startAction('auto_eat', ActionPriority.NORMAL, bot, ['hands']);
            actionId = actionInfo.actionId;
            epoch = actionInfo.epoch;
          }
          try {
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
          } catch (err: any) {
            return {
              triggered: true,
              name: 'auto_eat',
              result: { status: 'failed', reason: `Auto-eat error: ${err.message}` },
            };
          } finally {
            this.isEating = false;
            if (arbiter && actionId) arbiter.finishAction(actionId, epoch, bot);
          }
        }
      }
    }

    // 5. Auto-Attack Hostile Mobs Reflex (Auto-Defense Mode - Opt-in only)
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
          if (isAlive(rawEntity)) {
            let actionId = '';
            let epoch = 0;
            if (arbiter) {
              arbiter.preempt(bot, `Auto-attack ${targetHostile.name}`, ActionPriority.COMBAT_REFLEX);
              const actionInfo = arbiter.startAction(`auto_attack_${targetHostile.name}`, ActionPriority.COMBAT_REFLEX, bot, ['hands', 'look']);
              actionId = actionInfo.actionId;
              epoch = actionInfo.epoch;
            }
            try {
              this.lastAutoAttackTime = now;
              this.currentCombatTargetId = rawEntity.id;
              this.logger?.info?.(`AUTO-ATTACK MOD TRIGGERED: Defending against ${targetHostile.name} at distance ${targetHostile.distance}m.`);

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

                // Auto shield block if enabled and mob is skeleton or creeper
                if (
                  rConfig.autoShieldBlock &&
                  obs.inventory.toolSummary.hasShield &&
                  (targetHostile.type === 'skeleton' || targetHostile.type === 'creeper')
                ) {
                  try {
                    bot.activateItem(true);
                    await new Promise((res) => setTimeout(res, 400));
                  } finally {
                    try { bot.deactivateItem(); } catch {}
                  }
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
                this.logger?.warn?.(`Auto-attack failed: ${err.message}`);
              }
            } finally {
              if (arbiter && actionId) arbiter.finishAction(actionId, epoch, bot);
            }
          }
        }
      }
    }

    return { triggered: false };
  }

  public async autoDefendAttacker(bot: Bot, attacker: any, arbiter?: ActionArbiter): Promise<boolean> {
    if (!this.autoAttackEnabled || !attacker || !bot.entity) return false;

    // Safety checks
    const username = attacker.username || attacker.name;
    if (this.config.agent.owners.includes(username) || this.config.agent.friends.includes(username)) {
      return false;
    }
    if (this.config.safety.protectedEntities.includes(attacker.type || attacker.name)) {
      return false;
    }

    // Verify attacker is alive and loaded using universal isAlive helper
    if (!isAlive(attacker)) return false;

    const dist = distance3D(bot.entity.position, attacker.position);
    if (dist > (this.config.safety.reflexes.autoAttackRadius || 4.5)) return false;

    let actionId = '';
    let epoch = 0;
    if (arbiter) {
      arbiter.preempt(bot, `Retaliating against ${username || attacker.name}`, ActionPriority.COMBAT_REFLEX);
      const actionInfo = arbiter.startAction('auto_defend_attacker', ActionPriority.COMBAT_REFLEX, bot, ['hands', 'look']);
      actionId = actionInfo.actionId;
      epoch = actionInfo.epoch;
    }

    try {
      this.logger?.info?.(`AUTO-DEFENSE: Retaliating against attacker ${username || attacker.name}.`);

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
        this.currentCombatTargetId = attacker.id;
        return true;
      } catch {
        return false;
      }
    } finally {
      if (arbiter && actionId) arbiter.finishAction(actionId, epoch, bot);
    }
  }
}
