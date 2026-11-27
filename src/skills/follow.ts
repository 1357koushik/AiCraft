import { z } from 'zod';
import { goals } from 'mineflayer-pathfinder';
import { updatePathfinderMovements } from '../actions/techniques.js';
import { body } from '../reflexes/body.js';
import { ProgressWatchdog, SkillDefinition, SkillOutcome } from './contract.js';
import { playerEntity } from './come_to.js';
import { sleep, stopPathfinder } from './world.js';

/**
 * follow: stay within `distance` blocks of a player, using the pathfinder's moving-target goal. With `minutes` it
 * ends when they have passed; without, it is open-ended and ends only when the step is cancelled (which is how the
 * owner says "stop"). A reflex that clears the pathfinder's goal is undone here: the goal is set again once the
 * reflex lets go.
 */

const Args = z.object({
  player: z.string().min(1).max(16),
  minutes: z.number().positive().max(240).optional(),
  distance: z.number().min(1).max(16).default(3),
});
type FollowArgs = z.infer<typeof Args>;

/** How long the player may be out of sight before the skill gives up. */
const LOST_MS = 20000;
/** How long the bot may stay farther than distance + SLACK without once getting close. */
const STALL_MS = 25000;
const SLACK = 2;

const fmtSec = (ms: number) => `${Math.round(ms / 1000)} s`;

export const followSkill: SkillDefinition<FollowArgs> = {
  name: 'follow',
  summary: 'follow {player, minutes?, distance?=3}: keep within `distance` blocks of the named player for `minutes`; with no `minutes` it follows until the owner says stop. Use for "follow me".',
  untilStopped: (raw) => raw.minutes === undefined,
  args: Args,
  check(ctx, args) {
    if (!(ctx.bot as any).pathfinder) return { ok: false, cause: 'unknown', message: 'The pathfinder is not available.' };
    if (!playerEntity(ctx.bot, args.player)) {
      return { ok: false, cause: 'not_found_nearby', message: `${args.player} is not in sight.`, fix: 'use come_to first, or walk toward where they were last seen' };
    }
    return { ok: true };
  },
  async run(ctx, args): Promise<SkillOutcome> {
    const bot: any = ctx.bot;
    const evidence: string[] = [];
    const movements = updatePathfinderMovements(ctx.bot);
    if (movements) movements.canDig = false; // Following never digs through the world.
    bot.pathfinder.thinkTimeout = 5000;
    const startedAt = Date.now();
    const endAt = args.minutes ? startedAt + args.minutes * 60000 : Infinity;
    const initial = playerEntity(ctx.bot, args.player);
    const watchdog = new ProgressWatchdog(STALL_MS, initial ? initial.position.distanceTo(bot.entity.position) : 0);
    let lostSince: number | null = null;
    let goalFor: any = null;
    let closest = Infinity;
    let farthest = 0;
    const took = () => fmtSec(Date.now() - startedAt);
    const finish = (extra: Pick<SkillOutcome, 'status' | 'message'> & Partial<SkillOutcome>): SkillOutcome => {
      stopPathfinder(ctx.bot);
      evidence.push(`followed for ${took()}; closest ${closest === Infinity ? '?' : closest.toFixed(1)}, farthest ${farthest.toFixed(1)}`);
      return { evidence, ...extra };
    };

    for (;;) {
      if (ctx.signal.aborted) {
        // Open-ended: being told to stop is the normal end. With minutes it was cut short.
        return args.minutes
          ? finish({ status: 'interrupted', cause: 'interrupted', message: `Stopped following ${args.player} after ${took()}, before the ${args.minutes} minutes were up.` })
          : finish({ status: 'done', message: `Followed ${args.player} for ${took()} until told to stop.` });
      }
      if (Date.now() >= endAt) return finish({ status: 'done', message: `Followed ${args.player} for ${took()} (${args.minutes} min asked).` });

      const e = playerEntity(ctx.bot, args.player);
      if (!e) {
        lostSince = lostSince ?? Date.now();
        if (Date.now() - lostSince > LOST_MS) {
          return finish({ status: 'failed', cause: 'not_found_nearby', message: `Lost sight of ${args.player} after following for ${took()}.`, fix: 'ask where they are' });
        }
        await sleep(250);
        continue;
      }
      lostSince = null;
      const d = e.position.distanceTo(bot.entity.position);
      closest = Math.min(closest, d);
      farthest = Math.max(farthest, d);
      if (d <= args.distance + SLACK) watchdog.touch();
      else watchdog.report(d);
      if (watchdog.stuck) {
        return finish({ status: 'failed', cause: 'no_progress', message: `Could not keep up with ${args.player}: ${d.toFixed(0)} blocks away for ${fmtSec(watchdog.stalledForMs)}.`, fix: 'the way may be blocked; use come_to or go_to' });
      }
      // (Re)aim when there is no goal: first time, after the player entity was re-created, or after a reflex cleared it.
      if (!body.reflexActive && (!bot.pathfinder.goal || goalFor !== e)) {
        // GoalFollow re-aims only once the player has moved more than its range from the point it last aimed at, so the
        // bot can end up a full range behind that: half the asked distance keeps the real gap within `distance`.
        bot.pathfinder.setGoal(new goals.GoalFollow(e, Math.max(1, args.distance / 2)), true);
        goalFor = e;
      }
      await sleep(250);
    }
  },
};
