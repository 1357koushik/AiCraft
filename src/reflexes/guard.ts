import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import { Vec3 } from 'vec3';
import { body } from './body.js';
import { withInventoryLock } from '../actions/reliable_craft.js';
import { ProgressWatchdog } from '../skills/contract.js';
import { installArmorUpkeep } from './armor.js';

/**
 * Reflexes: the per-tick layer that keeps the bot alive while a skill runs (ROADMAP.md section 3, the reflex
 * clock). Checked four times a second; when one fires it takes over the body, acts, and releases, and the skill
 * resumes. In priority order: get out of lava, swim up when drowning, flee a creeper or anything when health is
 * low, fight a hostile mob that comes close, eat when hungry and safe.
 *
 * Players are never attacked here. Fighting players happens only when a task calls for it.
 */

export const HOSTILE = new Set([
  'zombie', 'husk', 'drowned', 'zombie_villager', 'skeleton', 'stray', 'bogged', 'spider', 'cave_spider', 'creeper', 'witch',
  'slime', 'magma_cube', 'phantom', 'pillager', 'vindicator', 'evoker', 'ravager', 'vex', 'silverfish', 'endermite', 'blaze',
  'wither_skeleton', 'guardian', 'elder_guardian', 'hoglin', 'zoglin', 'piglin_brute', 'breeze', 'ghast',
]);
/** Mobs to run from rather than fight. */
const FLEE_FROM = new Set(['creeper', 'warden', 'ravager', 'elder_guardian']);
const WEAPONS = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword', 'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'wooden_axe'];
const BAD_FOOD = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chorus_fruit', 'suspicious_stew', 'golden_apple', 'enchanted_golden_apple']);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Creeper fuse state. minecraft-data 1.21.6 lists the creeper's metadata keys in index order as the entity keys 0-7,
 * living entity keys 8-14, mob_flags 15, then swell_dir 16, is_powered 17, is_ignited 18. swell_dir is -1 while idle
 * and 1 while the fuse is running; is_ignited is true once lit with flint and steel or fire.
 */
const CREEPER_SWELL_DIR = 16;
const CREEPER_IGNITED = 18;
/** A creeper this close is an emergency even before its fuse is lit (its fuse starts inside about 3 blocks). */
const CREEPER_DANGER_RANGE = 3;

export function creeperFusing(e: Entity): boolean {
  const m: any[] = ((e as any).metadata ?? []) as any[];
  const v = (i: number) => (m[i] && typeof m[i] === 'object' && 'value' in m[i] ? m[i].value : m[i]);
  return v(CREEPER_SWELL_DIR) === 1 || v(CREEPER_IGNITED) === true;
}

/** The creeper (or warden, ravager...) the bot must run from: a fuse is lit, or it is within the danger range. */
function explosiveEmergency(bot: Bot): Entity | null {
  let best: Entity | null = null;
  let bestD = Infinity;
  for (const e of Object.values(bot.entities)) {
    if (e === bot.entity || !e.position || e.name !== 'creeper' || (e as any).isValid === false) continue;
    const d = e.position.distanceTo(bot.entity.position);
    if ((creeperFusing(e) && d < 12) || d < CREEPER_DANGER_RANGE) {
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
  }
  return best;
}

export interface ReflexEvent {
  reflex: string;
  detail: string;
}

function nearestThreat(bot: Bot, range: number, skipCreepers = false): Entity | null {
  const me = bot.entity.position;
  let best: Entity | null = null;
  let bestD = range;
  for (const e of Object.values(bot.entities)) {
    if (e === bot.entity || !e.position || !e.name || !HOSTILE.has(e.name) || (skipCreepers && e.name === 'creeper')) continue;
    if ((e as any).isValid === false) continue;
    const d = e.position.distanceTo(me);
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

function stopEverything(bot: Bot): void {
  try {
    const pf: any = (bot as any).pathfinder;
    if (pf?.goal || pf?.isMoving?.()) {
      pf.stop();
      pf.setGoal(null);
    }
  } catch {
    // nothing to stop
  }
  try {
    bot.stopDigging();
  } catch {
    // not digging
  }
  bot.clearControlStates();
}

async function moveAwayFrom(bot: Bot, from: Vec3, ms: number, shouldStop: () => boolean): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until && !shouldStop()) {
    const me = bot.entity.position;
    const away = me.minus(from);
    const target = me.plus(new Vec3(away.x, 0, away.z).normalize().scaled(4));
    await bot.lookAt(target.offset(0, 1.6, 0), true);
    bot.setControlState('forward', true);
    bot.setControlState('sprint', true);
    // Jump over one-block steps when blocked.
    bot.setControlState('jump', (bot.entity as any).isCollidedHorizontally === true);
    await sleep(150);
  }
  bot.clearControlStates();
}

export async function bestWeaponInHand(bot: Bot): Promise<void> {
  const weapon = WEAPONS.map((n) => bot.inventory.items().find((i) => i.name === n)).find(Boolean);
  if (!weapon || bot.heldItem?.name === weapon.name) return;
  // Don't wait on a craft in progress: fight with what is in hand instead.
  const result = await Promise.race([withInventoryLock(() => bot.equip(weapon, 'hand')).then(() => true, () => false), sleep(400).then(() => false)]);
  void result;
}

async function fight(bot: Bot, target: Entity, log: (e: ReflexEvent) => void): Promise<void> {
  await bestWeaponInHand(bot);
  const until = Date.now() + 15000;
  let lastSwing = 0;
  while (Date.now() < until && target.isValid !== false && bot.health > 6) {
    const d = target.position.distanceTo(bot.entity.position);
    if (d > 8) break;
    await bot.lookAt(target.position.offset(0, (target.height ?? 1.8) * 0.8, 0), true);
    if (d > 3) {
      bot.setControlState('forward', true);
      bot.setControlState('sprint', d > 4);
      bot.setControlState('jump', (bot.entity as any).isCollidedHorizontally === true);
    } else {
      bot.setControlState('forward', false);
      bot.setControlState('sprint', false);
      // ~0.65 s matches a sword's attack cooldown; full-strength hits instead of spam.
      if (Date.now() - lastSwing > 650) {
        bot.attack(target);
        lastSwing = Date.now();
      }
    }
    await sleep(100);
  }
  bot.clearControlStates();
  log({ reflex: 'fight', detail: `${target.name} ${target.isValid === false ? 'killed or gone' : 'left or bot hurt'}` });
}

function bestFood(bot: Bot): any | null {
  const foods: any = (bot.registry as any).foodsByName ?? {};
  let best: any = null;
  let bestPoints = 0;
  for (const it of bot.inventory.items()) {
    const f = foods[it.name];
    if (!f || BAD_FOOD.has(it.name)) continue;
    if (f.foodPoints > bestPoints) {
      best = it;
      bestPoints = f.foodPoints;
    }
  }
  return best;
}

/**
 * Makes every walk, dig and placement pause while a reflex holds the body, at the one place all skills go
 * through: the bot's own pathfinder.goto, dig and placeBlock. A call made during a reflex waits for the release;
 * a walk or dig that the reflex interrupted starts again afterwards. Skills never see the interruption.
 */
const wrapped = new WeakSet<object>();
function installPauseWrappers(bot: Bot): void {
  if (wrapped.has(bot)) return;
  wrapped.add(bot);
  const interruptedByReflex = () => body.reflexActive || body.releasedWithin(750);
  const pf: any = (bot as any).pathfinder;
  if (pf && typeof pf.goto === 'function') {
    const goto = pf.goto.bind(pf);
    pf.goto = async (goal: any) => {
      for (let attempt = 0; ; attempt++) {
        await body.waitForRelease();
        try {
          return await goto(goal);
        } catch (err) {
          if (attempt < 30 && interruptedByReflex()) continue;
          throw err;
        }
      }
    };
  }
  const dig = bot.dig.bind(bot);
  (bot as any).dig = async (...args: any[]) => {
    for (let attempt = 0; ; attempt++) {
      await body.waitForRelease();
      try {
        return await (dig as any)(...args);
      } catch (err) {
        if (attempt < 10 && interruptedByReflex()) continue;
        throw err;
      }
    }
  };
  const placeBlock = bot.placeBlock.bind(bot);
  (bot as any).placeBlock = async (...args: any[]) => {
    await body.waitForRelease();
    return (placeBlock as any)(...args);
  };
}

/** Starts the reflex guard on this bot. Returns a function that stops it. */
export function installReflexGuard(bot: Bot, onEvent: (e: ReflexEvent) => void = () => undefined): () => void {
  installPauseWrappers(bot);
  ProgressWatchdog.isPaused = () => body.reflexActive;
  let busy = false;
  let lastHurtBy: Entity | null = null;
  let lastHurtAt = 0;

  const onHurt = (entity: Entity) => {
    if (entity !== bot.entity) return;
    // Drowning, burning, lava and suffocation hurt without an attacker; don't go looking for one.
    const head = bot.blockAt(bot.entity.position.offset(0, 1, 0))?.name;
    const feet = bot.blockAt(bot.entity.position)?.name;
    if (head === 'water' || feet === 'lava' || feet === 'fire' || head === 'lava' || (bot.entity as any).onFire) return;
    // Who hit us: the nearest living mob (never a player, item or projectile) within 5 blocks.
    let best: Entity | null = null;
    let bestD = 5;
    for (const e of Object.values(bot.entities)) {
      const kind = String(e.type);
      const living = kind === 'hostile' || kind === 'mob' || kind === 'animal' || (e.name !== undefined && HOSTILE.has(e.name));
      if (e === bot.entity || !e.position || !living || kind === 'player') continue;
      const d = e.position.distanceTo(bot.entity.position);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    if (best) {
      lastHurtBy = best;
      lastHurtAt = Date.now();
    }
  };
  bot.on('entityHurt', onHurt);

  const act = async (reason: string, fn: () => Promise<void>) => {
    busy = true;
    body.takeover(reason);
    stopEverything(bot);
    onEvent({ reflex: reason, detail: 'took over' });
    try {
      await fn();
    } catch (err) {
      onEvent({ reflex: reason, detail: `error: ${(err as Error).message}` });
    } finally {
      bot.clearControlStates();
      body.release();
      busy = false;
      onEvent({ reflex: reason, detail: 'released' });
    }
  };

  const tick = () => {
    if (busy || !bot.entity) return;
    const pos = bot.entity.position;
    const feet = bot.blockAt(pos);
    const head = bot.blockAt(pos.offset(0, 1, 0));

    // 1. Lava: get out, toward the nearest solid ground that is not lava.
    if (feet?.name === 'lava' || head?.name === 'lava') {
      void act('lava', async () => {
        const safe = bot.findBlock({ matching: (b: any) => b.boundingBox === 'block' && b.name !== 'magma_block', maxDistance: 6, useExtraInfo: (b: any) => bot.blockAt(b.position.offset(0, 1, 0))?.name === 'air' });
        const until = Date.now() + 4000;
        while (Date.now() < until && (bot.blockAt(bot.entity.position)?.name === 'lava' || bot.blockAt(bot.entity.position.offset(0, 1, 0))?.name === 'lava')) {
          if (safe) await bot.lookAt(safe.position.offset(0.5, 1.6, 0.5), true);
          bot.setControlState('jump', true);
          bot.setControlState('forward', true);
          bot.setControlState('sprint', true);
          await sleep(100);
        }
      });
      return;
    }

    // 2. Drowning: swim straight up until there is air.
    if (head?.name === 'water' && (bot as any).oxygenLevel !== undefined && (bot as any).oxygenLevel < 8) {
      void act('drowning', async () => {
        const until = Date.now() + 8000;
        while (Date.now() < until && bot.blockAt(bot.entity.position.offset(0, 1, 0))?.name === 'water') {
          await bot.look(bot.entity.yaw, Math.PI / 2, true);
          bot.setControlState('jump', true);
          await sleep(100);
        }
      });
      return;
    }

    const threat = nearestThreat(bot, 8);
    const fightThreat = nearestThreat(bot, 8, true);
    const recentAttacker = lastHurtBy && Date.now() - lastHurtAt < 3000 && lastHurtBy.isValid !== false ? lastHurtBy : null;

    // 3. Flee a creeper (or warden, ravager) that is close, or anything dangerous when health is low.
    // A creeper is an emergency when its fuse is lit or it is within 3 blocks; further off it is only a target (see the
    // guard skill), so a walking creeper is not run from. Warden, ravager and elder guardian are still fled at 7.
    const bomb = explosiveEmergency(bot);
    if (bomb) {
      void act('flee', async () => moveAwayFrom(bot, bomb.position, 4000, () => bomb.isValid === false || (!creeperFusing(bomb) && bomb.position.distanceTo(bot.entity.position) > 5) || bomb.position.distanceTo(bot.entity.position) > 12));
      return;
    }
    if (threat && threat.name !== 'creeper' && FLEE_FROM.has(threat.name!) && threat.position.distanceTo(pos) < 7) {
      void act('flee', async () => moveAwayFrom(bot, threat.position, 4000, () => threat.isValid === false || threat.position.distanceTo(bot.entity.position) > 12));
      return;
    }
    if (bot.health <= 6 && (threat || recentAttacker)) {
      const from = (threat ?? recentAttacker)!;
      void act('flee', async () => moveAwayFrom(bot, from.position, 5000, () => from.isValid === false || from.position.distanceTo(bot.entity.position) > 16));
      return;
    }

    // 4. Fight a hostile mob that is close, or whatever just hit us.
    const fightTarget = recentAttacker && recentAttacker.name !== 'creeper' && recentAttacker.position.distanceTo(pos) < 6 ? recentAttacker : fightThreat && fightThreat.position.distanceTo(pos) < 4.5 ? fightThreat : null;
    if (fightTarget) {
      void act('fight', async () => fight(bot, fightTarget, onEvent));
      return;
    }

    // 5. Eat when hungry and nothing is near.
    if (bot.food <= 14 && !threat) {
      const food = bestFood(bot);
      if (food) {
        void act('eat', async () => {
          await withInventoryLock(async () => {
            await bot.equip(food, 'hand');
            await bot.consume();
          });
        });
      }
    }
  };

  const timer = setInterval(tick, 250);
  const stopArmor = installArmorUpkeep(bot, onEvent);
  return () => {
    stopArmor();
    ProgressWatchdog.isPaused = () => false;
    clearInterval(timer);
    bot.off('entityHurt', onHurt);
  };
}
