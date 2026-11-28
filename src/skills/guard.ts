import { z } from 'zod';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { goals } from 'mineflayer-pathfinder';
import { updatePathfinderMovements } from '../actions/techniques.js';
import { body } from '../reflexes/body.js';
import { withInventoryLock } from '../actions/reliable_craft.js';
import { HOSTILE, bestWeaponInHand, creeperFusing } from '../reflexes/guard.js';
import { SkillDefinition, SkillOutcome } from './contract.js';
import { playerEntity } from './come_to.js';
import { sleep, stopMotion, stopPathfinder } from './world.js';

/**
 * guard: protect a player (or a place) from hostile mobs. The bot stays within a few blocks of the protected spot
 * and goes out to meet any hostile mob that comes within `radius` of it, the one nearest to the protected spot
 * first, so a mob is fought away from the owner rather than next to them.
 *
 * Working with the reflexes (src/reflexes/guard.ts): they fight anything that comes within 4.5 blocks of the bot
 * and hold the body while they do. This skill never moves or swings while a reflex holds the body; it carries on
 * afterwards. It swings itself only when it is the one closing in, with the same ~650 ms between hits. A creeper
 * walking toward the owner is a target here: it is hit with a sprinting swing (knock-back) and the bot then steps
 * back so its fuse cannot run. The reflex only runs from a creeper whose fuse is lit or that is within 3 blocks,
 * and when it does this skill waits for it, like for any other reflex.
 *
 * Never attacked: players, pets, villagers, iron golems, and mobs that are only hostile when provoked (endermen,
 * piglins, zombified piglins, wolves, bees). Only the mob names in the reflexes' HOSTILE list are engaged.
 *
 * Kills are counted from the entity's death right after one of the bot's own swings at it, not from it merely
 * disappearing (a despawn or an unloaded chunk does not count).
 */

const Args = z.object({
  player: z.string().min(1).max(16).optional(),
  place: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional(),
  radius: z.number().min(4).max(32).default(12),
  minutes: z.number().positive().max(240).optional(),
  /** Guard until the clock reaches morning (time of day back under MORNING_BEFORE after a night). */
  until: z.literal('morning').optional(),
});
type GuardArgs = z.infer<typeof Args>;

/** Where the bot waits when nothing threatens: this close to the protected spot. */
const STAY = 3;
/** Reach for a melee swing, from the bot's position to the mob's. */
const SWING_REACH = 3.2;
/** Same pace as the reflex fight: a sword's attack cooldown. */
const SWING_MS = 650;
/** A mob not dead after this long of trying is left alone for IGNORE_MS (stuck behind something, out of reach). */
const ENGAGE_MS = 25000;
const IGNORE_MS = 30000;
/** How long after the bot's last swing at a mob its death still counts as the bot's kill. */
const KILL_WINDOW_MS = 3000;
/** The player may be out of sight this long before the skill gives up. */
const LOST_MS = 20000;
/** Back-off after a hit on a creeper. */
const CREEPER_BACKOFF_MS = 600;
/** A creeper is met this much farther out than other mobs: a late response to one costs the owner the most. */
const CREEPER_EXTRA_RADIUS = 8;

/** Morning has come when the clock is back under this after the night (0 is sunrise, night is 12542 to 23459). */
const MORNING_BEFORE = 1000;
const NIGHT_FROM = 12000;
/** `until: "morning"` stops waiting for a morning that never comes (a full day is 20 minutes). */
const MAX_UNTIL_MORNING_MS = 25 * 60 * 1000;

const fmtSec = (ms: number) => `${Math.round(ms / 1000)} s`;

/** Mobs this skill may attack: the reflexes' hostile list, never a player or anything tame or neutral. */
export function isGuardTarget(name: string | undefined): boolean {
  return name !== undefined && HOSTILE.has(name);
}

interface Threat {
  entity: any;
  /** Distance from the protected spot. */
  fromSpot: number;
}

const ARCHER_NAMES = new Set(['skeleton', 'stray', 'bogged', 'pillager']);

/** Hostile mobs within `radius` of `spot`, nearest to the spot first, skipping those in `ignored` (entity id -> until). */
export function threatsNear(entities: Iterable<any>, spot: Vec3, radius: number, ignored: Map<number, number>, now: number, self?: any, creeperBonus = 0): Threat[] {
  const out: Threat[] = [];
  for (const e of entities) {
    if (e === self || !e?.position || e.isValid === false || !isGuardTarget(e.name)) continue;
    if ((ignored.get(e.id) ?? 0) > now) continue;
    const d = e.position.distanceTo(spot);
    // Creepers and archers are met farther out: a creeper late costs the most, and an archer hits from range.
    if (d <= radius + (e.name === 'creeper' || ARCHER_NAMES.has(e.name) ? creeperBonus : 0)) out.push({ entity: e, fromSpot: d });
  }
  return out.sort((a, b) => a.fromSpot - b.fromSpot);
}

/** True once the clock shows morning after a night: `sawNight` is whether a time of day of NIGHT_FROM or more was seen. */
export function morningReached(tod: number | undefined, sawNight: boolean): boolean {
  return sawNight && tod !== undefined && tod < MORNING_BEFORE;
}

/** The creeper tactic shared with hunt: a sprinting swing (knock-back), after which the caller steps back so the fuse cannot run. */
export async function creeperStrike(ctx: { bot: Bot }, e: any, swingReach: number): Promise<boolean> {
  const bot: any = ctx.bot;
  stopPathfinder(ctx.bot);
  await bestWeaponInHand(ctx.bot);
  await bot.lookAt(e.position.offset(0, (e.height ?? 1.7) * 0.8, 0), true);
  // A sprinting swing knocks the creeper back; sprint is toggled so the server sees a fresh sprint start.
  bot.setControlState('sprint', false);
  bot.setControlState('sprint', true);
  bot.setControlState('forward', true);
  await sleep(60);
  let swung = false;
  if (e.isValid !== false && e.position.distanceTo(bot.entity.position) <= swingReach + 0.6) {
    bot.attack(e);
    swung = true;
  }
  bot.setControlState('forward', false);
  bot.setControlState('sprint', false);
  return swung;
}

/** One step back (call every ~50 ms while backing off a creeper). */
export function creeperBackStep(bot: Bot): void {
  bot.setControlState('sprint', false);
  bot.setControlState('forward', false);
  bot.setControlState('back', true);
  bot.setControlState('jump', (bot.entity as any).isCollidedHorizontally === true);
}

export const CREEPER_BACKOFF = CREEPER_BACKOFF_MS;

const ARMOR_SLOTS: Array<['head' | 'torso' | 'legs' | 'feet', string]> = [['head', 'helmet'], ['torso', 'chestplate'], ['legs', 'leggings'], ['feet', 'boots']];
const ARMOR_TIERS = ['netherite', 'diamond', 'iron', 'chainmail', 'golden', 'leather'];

/** Puts on the best armor piece held for each empty or weaker slot. Never fails the skill. */
async function wearBestArmor(bot: Bot, evidence: string[]): Promise<void> {
  for (const [dest, kind] of ARMOR_SLOTS) {
    const rank = (n?: string) => (n ? ARMOR_TIERS.findIndex((t) => n === `${t}_${kind}`) : 99);
    const worn = (bot.inventory.slots as any[])[bot.getEquipmentDestSlot(dest)];
    const best = bot.inventory.items().filter((i) => rank(i.name) >= 0).sort((a, b) => rank(a.name) - rank(b.name))[0];
    if (!best || (worn && rank(worn.name) >= 0 && rank(worn.name) <= rank(best.name))) continue;
    try {
      await withInventoryLock(() => bot.equip(best, dest));
      evidence.push(`put on ${best.name}`);
    } catch (err) {
      evidence.push(`could not put on ${best.name}: ${(err as Error).message}`);
    }
  }
}

function check(ctx: { bot: Bot }, args: GuardArgs) {
  if (!(ctx.bot as any).pathfinder) return { ok: false as const, cause: 'unknown' as const, message: 'The pathfinder is not available.' };
  if (args.player && !playerEntity(ctx.bot, args.player)) {
    return { ok: false as const, cause: 'not_found_nearby' as const, message: `${args.player} is not in sight.`, fix: 'use come_to first, or walk toward where they were last seen' };
  }
  return { ok: true as const };
}

export const guardSkill: SkillDefinition<GuardArgs> = {
  name: 'guard',
  summary:
    'guard {player?, place?: {x,y,z}, radius?=12, minutes?, until?: "morning"}: stay near the player (or the place; with neither, where you stand) and kill hostile mobs that come within `radius` of it, nearest to them first; never touches players, pets or peaceful mobs. With `until: "morning"` it guards through the night and ends when the sun is up (use that for "guard me for the night" / "all night"; done_when {"time_of_day": "<2000"}); with `minutes` it guards that long; with neither it guards until the owner says stop. Use for "protect me", "guard me", "kill the zombies near my house".',
  args: Args,
  untilStopped: (raw) => raw.minutes === undefined && raw.until === undefined,
  check: (ctx, args) => check(ctx, args),
  async run(ctx, args): Promise<SkillOutcome> {
    const bot: any = ctx.bot;
    const evidence: string[] = [];
    const movements = updatePathfinderMovements(ctx.bot);
    if (movements) movements.canDig = false; // Guarding never digs through the world.
    bot.pathfinder.thinkTimeout = 3000;

    const startedAt = Date.now();
    const endAt = args.minutes ? startedAt + args.minutes * 60000 : args.until ? startedAt + MAX_UNTIL_MORNING_MS : Infinity;
    let sawNight = false;
    const clock = () => (typeof bot.time?.timeOfDay === 'number' ? (bot.time.timeOfDay as number) : undefined);
    const fixedSpot = args.place ? new Vec3(args.place.x, args.place.y, args.place.z) : args.player ? null : bot.entity.position.clone();
    const what = args.player ?? (args.place ? `${args.place.x} ${args.place.y} ${args.place.z}` : 'this spot');

    // --- Kill bookkeeping: remember when the bot last swung at each entity, and count deaths soon after. ---
    const lastSwingAt = new Map<number, number>();
    const originalAttack = bot.attack.bind(bot);
    bot.attack = (target: any, ...rest: any[]) => {
      if (target?.id !== undefined) lastSwingAt.set(target.id, Date.now());
      return originalAttack(target, ...rest);
    };
    const kills: Record<string, number> = {};
    const fusingSeenAt = new Map<number, number>();
    let explosions = 0;
    const counted = new Set<number>();
    const countKill = (e: any) => {
      counted.add(e.id);
      kills[e.name] = (kills[e.name] ?? 0) + 1;
      ctx.log(`[guard] killed ${e.name} (${Object.values(kills).reduce((a, b) => a + b, 0)} so far)`);
    };
    const swungRecently = (e: any) => {
      const at = lastSwingAt.get(e.id);
      return at !== undefined && Date.now() - at <= KILL_WINDOW_MS;
    };
    // The death status (entityDead) only comes from a mob that was killed. A creeper that explodes is removed without
    // it, so a creeper that vanishes with its fuse running is an explosion, not a kill.
    const onDeath = (e: any) => {
      if (!e || counted.has(e.id) || !isGuardTarget(e.name) || !swungRecently(e)) return;
      countKill(e);
    };
    const onGone = (e: any) => {
      if (!e || counted.has(e.id) || !isGuardTarget(e.name) || !swungRecently(e)) return;
      if (e.name === 'creeper' && (creeperFusing(e) || Date.now() - (fusingSeenAt.get(e.id) ?? 0) < 1500)) {
        counted.add(e.id);
        explosions++;
        ctx.log('[guard] a creeper exploded (not counted as a kill)');
        return;
      }
      countKill(e);
    };
    // Death animation (status 3) arrives before the removal; either one counts, once.
    bot.on('entityDead', onDeath);
    bot.on('entityGone', onGone);
    let ownerHurt = 0;
    const onHurt = (e: any) => {
      if (args.player && e?.username === args.player) ownerHurt++;
    };
    bot.on('entityHurt', onHurt);

    const ignored = new Map<number, number>();
    const engagedSince = new Map<number, number>();
    let backoffUntil = 0;
    let lastSwing = 0;
    let goalFor: any = null;
    let lostSince: number | null = null;
    let engagedTicks = 0;
    const took = () => fmtSec(Date.now() - startedAt);
    const total = () => Object.values(kills).reduce((a, b) => a + b, 0);
    const killText = () => (total() ? Object.entries(kills).map(([k, n]) => `${k} x${n}`).join(', ') : 'none');

    const cleanup = () => {
      bot.attack = originalAttack;
      bot.off('entityDead', onDeath);
      bot.off('entityGone', onGone);
      bot.off('entityHurt', onHurt);
      stopMotion(ctx.bot);
    };
    const finish = (extra: Pick<SkillOutcome, 'status' | 'message'> & Partial<SkillOutcome>): SkillOutcome => {
      cleanup();
      evidence.push(`guarded ${what} for ${took()}: killed ${killText()}; ${engagedTicks > 0 ? 'engaged mobs' : 'no hostile mob came within reach'}; owner hurt events seen: ${ownerHurt}; creepers that exploded: ${explosions}`);
      return { evidence, ...extra };
    };
    const setGoal = (goal: any, key: any) => {
      if (body.reflexActive) return;
      if (bot.pathfinder.goal && goalFor === key) return;
      bot.pathfinder.setGoal(goal, true);
      goalFor = key;
    };

    try {
      await wearBestArmor(ctx.bot, evidence);
      for (;;) {
        if (ctx.signal.aborted) {
          // Open-ended: being told to stop is the normal end. With minutes it was cut short.
          return args.minutes
            ? finish({ status: 'interrupted', cause: 'interrupted', message: `Stopped guarding ${what} after ${took()}, before the ${args.minutes} minutes were up; killed ${killText()}.` })
            : args.until
            ? finish({ status: 'interrupted', cause: 'interrupted', message: `Stopped guarding ${what} after ${took()}, before morning; killed ${killText()}.` })
            : finish({ status: 'done', message: `Guarded ${what} for ${took()} until told to stop; killed ${killText()}.` });
        }
        const tod = clock();
        if (tod !== undefined && tod >= NIGHT_FROM) sawNight = true;
        if (args.until && morningReached(tod, sawNight)) {
          return finish({ status: 'done', message: `Guarded ${what} until morning (time of day ${tod}) after ${took()}; killed ${killText()}.` });
        }
        if (Date.now() >= endAt) {
          if (args.until && !args.minutes) {
            return finish({ status: 'partial', cause: 'no_progress', message: `Guarded ${what} for ${took()} but morning had not come (time of day ${tod ?? 'unknown'}); killed ${killText()}.`, fix: 'guard again, or check the clock' });
          }
          return finish({ status: 'done', message: `Guarded ${what} for ${took()} (${args.minutes} min asked); killed ${killText()}.` });
        }

        // Where the protected spot is right now.
        let spot: Vec3;
        if (fixedSpot) spot = fixedSpot;
        else {
          const p = playerEntity(ctx.bot, args.player!);
          if (!p) {
            lostSince = lostSince ?? Date.now();
            if (Date.now() - lostSince > LOST_MS) {
              return finish({ status: 'failed', cause: 'not_found_nearby', message: `Lost sight of ${args.player} after guarding for ${took()}; killed ${killText()}.`, fix: 'ask where they are' });
            }
            await sleep(250);
            continue;
          }
          lostSince = null;
          spot = p.position;
        }

        for (const e of Object.values(bot.entities) as any[]) if (e?.name === 'creeper' && creeperFusing(e)) {
          if (!fusingSeenAt.has(e.id)) ctx.log(`[guard] creeper ${e.id} fuse lit; metadata[15..18] = ${JSON.stringify((e.metadata ?? []).slice(15, 19))}`);
          fusingSeenAt.set(e.id, Date.now());
        }

        // A reflex holds the body (fighting, fleeing, eating): wait, it was told to do that first.
        if (body.reflexActive) {
                    await sleep(100);
          continue;
        }

        const now = Date.now();
        const me = bot.entity.position as Vec3;
        const dSpot = me.distanceTo(spot);
        const threats = threatsNear(Object.values(bot.entities), spot, args.radius, ignored, now, bot.entity, CREEPER_EXTRA_RADIUS);

        if (threats.length === 0) {
          // Nothing to fight: stay close to the protected spot.
                    if (now < backoffUntil) {
            await sleep(60);
            continue;
          }
          bot.clearControlStates();
          if (dSpot > STAY + 1) {
            if (args.player) setGoal(new goals.GoalFollow(playerEntity(ctx.bot, args.player)!, STAY - 1), 'idle-follow');
            else setGoal(new goals.GoalNear(spot.x, spot.y, spot.z, STAY - 1), 'idle-near');
          } else if (bot.pathfinder.goal && goalFor !== null && dSpot <= STAY) {
            stopPathfinder(ctx.bot);
            goalFor = null;
          }
          await sleep(150);
          continue;
        }

        // Something to fight: the one nearest the protected spot. Far from the owner the bot would be leaving them alone.
        const t = threats[0];
        const e = t.entity;
        engagedTicks++;
        if (!engagedSince.has(e.id)) engagedSince.set(e.id, now);
        if (now - engagedSince.get(e.id)! > ENGAGE_MS) {
          ignored.set(e.id, now + IGNORE_MS);
          engagedSince.delete(e.id);
          ctx.log(`[guard] giving up on ${e.name} ${e.id} for ${fmtSec(IGNORE_MS)}: not dead after ${fmtSec(ENGAGE_MS)}`);
          continue;
        }
                const d = e.position.distanceTo(me);

        if (e.name === 'creeper') {
          // Step back after a hit so the fuse (which only runs within about 3 blocks) resets.
          if (now < backoffUntil) {
            creeperBackStep(ctx.bot);
            await sleep(50);
            continue;
          }
          bot.setControlState('back', false);
          if (d <= SWING_REACH && now - lastSwing >= SWING_MS) {
            goalFor = null;
            if (await creeperStrike(ctx, e, SWING_REACH)) lastSwing = Date.now();
            backoffUntil = Date.now() + CREEPER_BACKOFF_MS;
            await sleep(30);
            continue;
          }
          if (d > SWING_REACH) {
            bot.setControlState('back', false);
            setGoal(new goals.GoalFollow(e, 1), `chase-${e.id}`);
          }
          await sleep(50);
          continue;
        }

        // Any other hostile mob: close in, then swing at the sword's pace. (The reflex takes over at 4.5 blocks anyway.)
        if (d > SWING_REACH) {
          setGoal(new goals.GoalFollow(e, 1.5), `chase-${e.id}`);
          await sleep(100);
          continue;
        }
        stopPathfinder(ctx.bot);
        goalFor = null;
        await bestWeaponInHand(ctx.bot);
        await bot.lookAt(e.position.offset(0, (e.height ?? 1.8) * 0.8, 0), true);
        if (Date.now() - lastSwing >= SWING_MS && e.isValid !== false && !body.reflexActive) {
          bot.attack(e);
          lastSwing = Date.now();
        }
        await sleep(100);
      }
    } catch (err) {
      return finish({ status: ctx.signal.aborted ? 'interrupted' : 'failed', cause: ctx.signal.aborted ? 'interrupted' : 'unknown', message: `guard stopped: ${(err as Error).message}; killed ${killText()}.` });
    }
  },
};
