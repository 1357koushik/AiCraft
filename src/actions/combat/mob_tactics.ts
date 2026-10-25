import { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { goals } from 'mineflayer-pathfinder';
import { ActionResult, ActionExecutionContext } from '../../types/index.js';
import { distance3D } from '../../utils/math.js';
import { isAlive } from '../../safety/index.js';
import { isActionContextActive } from '../../agent/arbiter.js';
import { ensureShieldInOffHand, raiseShieldAgainst } from './shield_manager.js';
import { techniquePillarUp } from '../techniques.js';

/**
 * Returns minimum delay in ms between attacks to achieve 100% full attack damage
 * according to Minecraft Java Edition weapon attack speed mechanics.
 */
export function getAttackCooldownMs(heldItemName?: string | null): number {
  if (!heldItemName) return 250; // Hand / default: 4.0 attack speed
  const name = heldItemName.toLowerCase();

  // Swords: 1.6 attack speed => 625ms
  if (name.endsWith('_sword')) return 625;

  // Axes: 0.8 - 1.0 attack speed
  if (name.includes('wooden_axe') || name.includes('stone_axe')) return 1250; // 0.8 speed
  if (name.includes('iron_axe')) return 1111; // 0.9 speed
  if (name.includes('diamond_axe') || name.includes('netherite_axe') || name.includes('golden_axe')) return 1000; // 1.0 speed
  if (name.endsWith('_axe')) return 1000;

  // Pickaxes: 1.2 attack speed => 833ms
  if (name.endsWith('_pickaxe')) return 833;

  // Shovels: 1.0 attack speed => 1000ms
  if (name.endsWith('_shovel')) return 1000;

  // Default: 4.0 attack speed => 250ms
  return 250;
}

/**
 * Equips best available sword or axe from inventory.
 */
export async function equipBestWeapon(bot: Bot): Promise<void> {
  if (!bot.inventory || !bot.equip) return;
  const items = bot.inventory.items();
  const sword = items.find((i) => i.name.endsWith('_sword'));
  const axe = items.find((i) => i.name.endsWith('_axe'));
  const weapon = sword || axe;

  if (weapon && bot.heldItem?.name !== weapon.name) {
    try {
      await bot.equip(weapon, 'hand');
    } catch {}
  }
}

/**
 * Creeper Tactic: Hit and Sprint Retreat!
 * Approaches to melee range, delivers a full-cooldown strike, then immediately sprints
 * backwards to stay outside the 3-block fuse trigger radius. Repeats until creeper dies.
 */
export async function techniqueEngageCreeper(
  bot: Bot,
  creeper: any,
  ctx: ActionExecutionContext
): Promise<ActionResult> {
  if (!isActionContextActive(ctx)) return { status: 'interrupted', reason: 'Creeper combat cancelled.' };

  await equipBestWeapon(bot);
  const cooldown = getAttackCooldownMs(bot.heldItem?.name);

  let strikes = 0;
  while (isAlive(creeper) && strikes < 10) {
    if (!isActionContextActive(ctx)) {
      return { status: 'interrupted', reason: 'Creeper combat interrupted.' };
    }

    const dist = distance3D(bot.entity.position, creeper.position);

    // 1. If far, approach close enough to strike (2.5 - 3.0m)
    if (dist > 3.0) {
      if ((bot as any).pathfinder) {
        try {
          const goal = new goals.GoalNear(creeper.position.x, creeper.position.y, creeper.position.z, 2.2);
          (bot as any).pathfinder.setGoal(goal);
          await new Promise((res) => setTimeout(res, 400));
          (bot as any).pathfinder.setGoal(null);
        } catch {}
      }
    }

    if (!isActionContextActive(ctx)) break;

    // 2. Face and strike
    if (bot.lookAt) {
      await bot.lookAt(creeper.position.offset(0, creeper.height ? creeper.height / 2 : 0.8, 0), true);
    }
    if (bot.attack) {
      bot.attack(creeper);
      strikes++;
    }

    // 3. Immediately sprint back 4 blocks away to abort creeper swelling
    bot.setControlState('back', true);
    bot.setControlState('sprint', true);
    await new Promise((res) => setTimeout(res, 600));
    bot.setControlState('back', false);
    bot.setControlState('sprint', false);

    // 4. Respect weapon attack cooldown
    await new Promise((res) => setTimeout(res, cooldown));
  }

  bot.clearControlStates?.();
  return {
    status: 'success',
    reason: `Engaged creeper with ${strikes} hit-and-retreat strike(s).`,
  };
}

/**
 * Skeleton Tactic: Shield Draw Blocking & Stun Rush
 * Raises shield when skeleton aims bow from afar, closes distance during reload,
 * then stunlocks skeleton at close melee range.
 */
export async function techniqueEngageSkeleton(
  bot: Bot,
  skeleton: any,
  ctx: ActionExecutionContext
): Promise<ActionResult> {
  if (!isActionContextActive(ctx)) return { status: 'interrupted', reason: 'Skeleton combat cancelled.' };

  await equipBestWeapon(bot);
  await ensureShieldInOffHand(bot);
  const cooldown = getAttackCooldownMs(bot.heldItem?.name);

  let strikes = 0;
  while (isAlive(skeleton) && strikes < 10) {
    if (!isActionContextActive(ctx)) {
      return { status: 'interrupted', reason: 'Skeleton combat interrupted.' };
    }

    const dist = distance3D(bot.entity.position, skeleton.position);

    // 1. If at range (> 3.5m), raise shield momentarily to absorb incoming arrow
    if (dist > 3.5) {
      await raiseShieldAgainst(bot, skeleton, 800, ctx.abortSignal, ctx.isCurrent);
      if (!isActionContextActive(ctx)) break;

      // Rush forward during skeleton reload window
      if ((bot as any).pathfinder) {
        try {
          const goal = new goals.GoalNear(skeleton.position.x, skeleton.position.y, skeleton.position.z, 2.0);
          (bot as any).pathfinder.setGoal(goal);
          await new Promise((res) => setTimeout(res, 600));
          (bot as any).pathfinder.setGoal(null);
        } catch {}
      }
    }

    if (!isActionContextActive(ctx)) break;

    // 2. Deliver melee blow
    if (bot.lookAt) {
      await bot.lookAt(skeleton.position.offset(0, skeleton.height ? skeleton.height / 2 : 1.0, 0), true);
    }
    if (bot.attack) {
      bot.attack(skeleton);
      strikes++;
    }

    await new Promise((res) => setTimeout(res, cooldown));
  }

  return {
    status: 'success',
    reason: `Defeated/engaged skeleton with ${strikes} tactical strike(s).`,
  };
}

/**
 * Spider Tactic: Leap Interception & Backpedal
 * Backpedals slightly when spider lunges to evade the leap strike,
 * then counters when spider lands in front.
 */
export async function techniqueEngageSpider(
  bot: Bot,
  spider: any,
  ctx: ActionExecutionContext
): Promise<ActionResult> {
  if (!isActionContextActive(ctx)) return { status: 'interrupted', reason: 'Spider combat cancelled.' };

  await equipBestWeapon(bot);
  const cooldown = getAttackCooldownMs(bot.heldItem?.name);

  let strikes = 0;
  while (isAlive(spider) && strikes < 8) {
    if (!isActionContextActive(ctx)) {
      return { status: 'interrupted', reason: 'Spider combat interrupted.' };
    }

    const dist = distance3D(bot.entity.position, spider.position);

    // Backpedal when spider gets within leap distance (2-4m)
    if (dist <= 4.0 && dist >= 2.0) {
      bot.setControlState('back', true);
      await new Promise((res) => setTimeout(res, 200));
      bot.setControlState('back', false);
    }

    if (bot.lookAt) {
      await bot.lookAt(spider.position.offset(0, spider.height ? spider.height / 2 : 0.5, 0), true);
    }
    if (bot.attack) {
      bot.attack(spider);
      strikes++;
    }

    await new Promise((res) => setTimeout(res, cooldown));
  }

  bot.clearControlStates?.();
  return {
    status: 'success',
    reason: `Engaged spider with ${strikes} leap-evasion strike(s).`,
  };
}

/**
 * Enderman Tactic: 3-Block Safety Pillaring
 * Builds a 3-block high scaffold column. Endermen are 3 blocks tall and cannot
 * hit a player standing 3 blocks high, allowing safe overhead melee attacks.
 */
export async function techniqueEngageEnderman(
  bot: Bot,
  enderman: any,
  ctx: ActionExecutionContext
): Promise<ActionResult> {
  if (!isActionContextActive(ctx)) return { status: 'interrupted', reason: 'Enderman combat cancelled.' };

  await equipBestWeapon(bot);

  // 1. Pillar up 3 blocks high for complete physical immunity from enderman reach
  try {
    ctx.logger?.info?.('[COMBAT_TACTIC] Pillaring up 3 blocks for safe enderman engagement...');
    await techniquePillarUp(bot, 3, ctx.abortSignal, ctx.isCurrent);
  } catch {}

  const cooldown = getAttackCooldownMs(bot.heldItem?.name);
  let strikes = 0;

  while (isAlive(enderman) && strikes < 15) {
    if (!isActionContextActive(ctx)) {
      return { status: 'interrupted', reason: 'Enderman combat interrupted.' };
    }

    const dist = distance3D(bot.entity.position, enderman.position);
    if (dist > 4.5) {
      // Wait for enderman to teleport or approach base of pillar
      await new Promise((res) => setTimeout(res, 500));
      continue;
    }

    if (bot.lookAt) {
      await bot.lookAt(enderman.position.offset(0, enderman.height ? enderman.height * 0.7 : 2.0, 0), true);
    }
    if (bot.attack) {
      bot.attack(enderman);
      strikes++;
    }

    await new Promise((res) => setTimeout(res, cooldown));
  }

  return {
    status: 'success',
    reason: `Safely engaged enderman from 3-block safety pillar with ${strikes} strike(s).`,
  };
}

/**
 * Zombie Tactic: Spacing and Knockback Timing
 * Maintains 2.5 - 3.0m reach advantage, timing attacks with cooldown to stunlock zombie.
 */
export async function techniqueEngageZombie(
  bot: Bot,
  zombie: any,
  ctx: ActionExecutionContext
): Promise<ActionResult> {
  if (!isActionContextActive(ctx)) return { status: 'interrupted', reason: 'Zombie combat cancelled.' };

  await equipBestWeapon(bot);
  const cooldown = getAttackCooldownMs(bot.heldItem?.name);

  let strikes = 0;
  while (isAlive(zombie) && strikes < 10) {
    if (!isActionContextActive(ctx)) {
      return { status: 'interrupted', reason: 'Zombie combat interrupted.' };
    }

    const dist = distance3D(bot.entity.position, zombie.position);
    if (dist > 3.0) {
      if ((bot as any).pathfinder) {
        try {
          const goal = new goals.GoalNear(zombie.position.x, zombie.position.y, zombie.position.z, 2.5);
          (bot as any).pathfinder.setGoal(goal);
          await new Promise((res) => setTimeout(res, 300));
          (bot as any).pathfinder.setGoal(null);
        } catch {}
      }
    }

    if (!isActionContextActive(ctx)) break;

    if (bot.lookAt) {
      await bot.lookAt(zombie.position.offset(0, zombie.height ? zombie.height / 2 : 1.0, 0), true);
    }
    if (bot.attack) {
      bot.attack(zombie);
      strikes++;
    }

    await new Promise((res) => setTimeout(res, cooldown));
  }

  return {
    status: 'success',
    reason: `Defeated/engaged zombie with ${strikes} rhythmic strike(s).`,
  };
}

/**
 * Emergency Combat Retreat:
 * Triggers when health drops below 8 HP (4 hearts).
 * Sprints away from nearest hostiles, raises shield against projectiles, and seeks safe ground.
 */
export async function techniqueEmergencyCombatRetreat(
  bot: Bot,
  ctx: ActionExecutionContext
): Promise<ActionResult> {
  ctx.logger?.warn?.('[COMBAT_RETREAT] Critical health detected! Executing emergency combat retreat...');

  // 1. Raise shield if hostiles are shooting or charging
  await ensureShieldInOffHand(bot);
  try {
    bot.activateItem(true);
  } catch {}

  // 2. Sprint in opposite direction of nearest hostile
  const hostiles = Object.values(bot.entities || {}).filter(
    (e: any) => e && e !== bot.entity && isAlive(e) && (e.type === 'mob' || e.type === 'hostile')
  );

  if (hostiles.length > 0 && bot.entity) {
    const nearest: any = hostiles[0];
    const fleeVec = bot.entity.position.minus(nearest.position).normalize();
    const fleeTarget = bot.entity.position.plus(fleeVec.scaled(12));

    if ((bot as any).pathfinder) {
      try {
        const goal = new goals.GoalNearXZ(fleeTarget.x, fleeTarget.z, 2);
        (bot as any).pathfinder.setGoal(goal);
        await new Promise((res) => setTimeout(res, 1200));
        (bot as any).pathfinder.setGoal(null);
      } catch {}
    }
  }

  try {
    bot.deactivateItem();
  } catch {}

  return {
    status: 'success',
    reason: 'Executed emergency combat retreat to safe distance.',
  };
}

/**
 * Universal Tactical Combat Dispatcher:
 * Selects the optimal combat tactic based on entity species.
 */
export async function techniqueTacticalCombat(
  bot: Bot,
  targetEntity: any,
  ctx: ActionExecutionContext
): Promise<ActionResult> {
  if (!targetEntity) return { status: 'failed', reason: 'No valid combat target entity.' };

  const mobName = (targetEntity.name || '').toLowerCase();

  // Check retreat precondition: health <= 8 HP
  if (bot.health !== undefined && bot.health <= 8) {
    return techniqueEmergencyCombatRetreat(bot, ctx);
  }

  if (mobName === 'creeper') {
    return techniqueEngageCreeper(bot, targetEntity, ctx);
  }
  if (mobName === 'skeleton' || mobName === 'stray' || mobName === 'bogged') {
    return techniqueEngageSkeleton(bot, targetEntity, ctx);
  }
  if (mobName === 'spider' || mobName === 'cave_spider') {
    return techniqueEngageSpider(bot, targetEntity, ctx);
  }
  if (mobName === 'enderman') {
    return techniqueEngageEnderman(bot, targetEntity, ctx);
  }
  if (mobName === 'zombie' || mobName === 'husk' || mobName === 'drowned' || mobName === 'zombie_villager') {
    return techniqueEngageZombie(bot, targetEntity, ctx);
  }

  // Fallback generic combat with attack cooldown synchronization
  await equipBestWeapon(bot);
  const cooldown = getAttackCooldownMs(bot.heldItem?.name);

  if (bot.lookAt) {
    await bot.lookAt(targetEntity.position.offset(0, targetEntity.height ? targetEntity.height / 2 : 1, 0), true);
  }
  if (bot.attack) {
    bot.attack(targetEntity);
  }
  await new Promise((res) => setTimeout(res, cooldown));

  return {
    status: 'success',
    reason: `Attacked ${targetEntity.name || 'entity'} using synchronized weapon cooldown (${cooldown}ms).`,
  };
}
