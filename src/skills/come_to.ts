import { z } from 'zod';
import type { Bot } from 'mineflayer';
import { Precondition, SkillDefinition, SkillOutcome } from './contract.js';
import { travel } from './go_to.js';

/**
 * come_to: walk to a player. The target is where the player stands when the step starts and again after each leg,
 * so a player who moves while the bot walks is still reached. The bot must see the player (the player's entity).
 */

const Args = z.object({
  player: z.string().min(1).max(16),
  range: z.number().min(1).max(32).default(2),
});
type ComeToArgs = z.infer<typeof Args>;

export function playerEntity(bot: Bot, name: string): any | null {
  const e = (bot.players as any)?.[name]?.entity;
  return e?.position ? e : null;
}

function distance(bot: Bot, e: any): number {
  return bot.entity.position.distanceTo(e.position);
}

export const comeToSkill: SkillDefinition<ComeToArgs> = {
  name: 'come_to',
  summary: 'come_to {player, range?=2}: walk to the named player (who must be in sight) and stop within `range` blocks of them. Use for "come here".',
  args: Args,
  check(ctx, args): Precondition {
    if (!(ctx.bot as any).pathfinder) return { ok: false, cause: 'unknown', message: 'The pathfinder is not available.' };
    if (!playerEntity(ctx.bot, args.player)) {
      return { ok: false, cause: 'not_found_nearby', message: `${args.player} is not in sight.`, fix: 'ask the owner where they are, or walk toward where they were last seen' };
    }
    return { ok: true };
  },
  async run(ctx, args): Promise<SkillOutcome> {
    const bot = ctx.bot;
    const evidence: string[] = [];
    for (let leg = 0; leg < 4; leg++) {
      const e = playerEntity(bot, args.player);
      if (!e) return { status: 'failed', cause: 'not_found_nearby', message: `${args.player} went out of sight.`, evidence };
      if (distance(bot, e) <= args.range + 0.5) break;
      const p = e.position;
      const t = await travel(ctx, p.x, p.y, p.z, args.range);
      evidence.push(`leg ${leg + 1}: ${t.start} -> ${t.end} (${t.message})`);
      if (!t.ok) {
        return { status: t.cause === 'interrupted' ? 'interrupted' : 'failed', cause: t.cause ?? 'unreachable', message: `Could not reach ${args.player}: ${t.message}`, evidence };
      }
    }
    const e = playerEntity(bot, args.player);
    if (!e) return { status: 'failed', cause: 'not_found_nearby', message: `${args.player} went out of sight.`, evidence };
    const d = distance(bot, e);
    evidence.push(`distance to ${args.player}: ${d.toFixed(1)}`);
    if (d <= args.range + 1) return { status: 'done', message: `Now ${d.toFixed(1)} blocks from ${args.player}.`, evidence };
    return { status: 'failed', cause: 'no_progress', message: `Still ${d.toFixed(1)} blocks from ${args.player}; they keep moving away.`, evidence };
  },
};
