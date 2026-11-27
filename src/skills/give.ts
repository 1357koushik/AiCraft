import { z } from 'zod';
import type { Bot } from 'mineflayer';
import { withInventoryLock, dropReliably } from '../actions/reliable_craft.js';
import { Precondition, SkillDefinition, SkillOutcome } from './contract.js';
import { playerEntity } from './come_to.js';
import { travel } from './go_to.js';
import { sleep } from './world.js';

/**
 * give: hand items to a player by tossing them at their feet from close by. Walks to within 2 blocks, faces
 * them, drops exactly `count` with settled one-at-a-time clicks (dropReliably, under the inventory lock), then
 * waits for the server's collect packets to show the player picked them all up. What the player really holds
 * is still the judge's business (server-side inventory).
 */

const Args = z.object({
  player: z.string().min(1).max(16),
  item: z.string().min(1).transform((s) => s.replace(/^minecraft:/, '')),
  count: z.number().int().min(1).max(2304),
});
type GiveArgs = z.infer<typeof Args>;

const CLOSE = 2.2;
/** A dropped item cannot be picked up for 40 ticks (2 s). */
const PICKUP_WAIT_MS = 2600;

/** Closer than this, a drop aimed at the player's feet lands in the bot's own pickup reach. */
const MIN_GIVE_DIST = 1.8;

/** Walks backwards (facing `from`) for `ms`, then stops. Moves away from the player without turning round. */
async function stepBack(bot: Bot, from: { x: number; y: number; z: number }, ms: number): Promise<void> {
  await bot.lookAt(new (bot.entity.position.constructor as any)(from.x, bot.entity.position.y + 1.6, from.z), true);
  bot.setControlState('back', true);
  try {
    await sleep(ms);
  } finally {
    bot.setControlState('back', false);
  }
}

const held = (bot: Bot, item: string) => bot.inventory.items().filter((i) => i.name === item).reduce((a, i) => a + i.count, 0);

/** Item entities of this kind lying within `radius` of a point. */
function groundItems(bot: Bot, item: string, around: { x: number; y: number; z: number }, radius: number): any[] {
  const out: any[] = [];
  for (const e of Object.values(bot.entities) as any[]) {
    if (!e?.position || e.name !== 'item' || e.isValid === false) continue;
    const dropped = e.getDroppedItem?.();
    if (dropped?.name !== item) continue;
    const p = e.position;
    if (Math.hypot(p.x - around.x, p.y - around.y, p.z - around.z) <= radius) out.push(e);
  }
  return out;
}

function evaluate(bot: Bot, args: GiveArgs): Precondition {
  if (!bot.registry.itemsByName[args.item]) return { ok: false, cause: 'invalid_args', message: `There is no item called "${args.item}".` };
  const n = held(bot, args.item);
  if (n < args.count) {
    return { ok: false, cause: 'missing_item', message: `Giving ${args.count} ${args.item} needs ${args.count - n} more; the bot holds ${n}.`, fix: `get ${args.count - n} more ${args.item}, or give fewer` };
  }
  if (!playerEntity(bot, args.player)) return { ok: false, cause: 'not_found_nearby', message: `${args.player} is not in sight.`, fix: 'use come_to first' };
  return { ok: true };
}

export const giveSkill: SkillDefinition<GiveArgs> = {
  name: 'give',
  summary: 'give {player, item, count}: walk up to the named player and hand them exactly `count` of an item you hold (tossed at their feet from about 2 blocks). Use for "give me 5 logs".',
  args: Args,
  check: (ctx, args) => evaluate(ctx.bot, args),
  async run(ctx, args): Promise<SkillOutcome> {
    const bot = ctx.bot;
    const evidence: string[] = [];
    const pre = evaluate(bot, args);
    if (!pre.ok) return { status: 'failed', cause: pre.cause, message: pre.message, fix: pre.fix, evidence };

    // Get close, and face them.
    for (let attempt = 0; attempt < 3; attempt++) {
      const e = playerEntity(bot, args.player);
      if (!e) return { status: 'failed', cause: 'not_found_nearby', message: `${args.player} went out of sight.`, evidence };
      if (bot.entity.position.distanceTo(e.position) <= CLOSE) break;
      const t = await travel(ctx, e.position.x, e.position.y, e.position.z, 2);
      evidence.push(`walked ${t.start} -> ${t.end} (${t.message})`);
      if (!t.ok) return { status: t.cause === 'interrupted' ? 'interrupted' : 'failed', cause: t.cause ?? 'unreachable', message: `Could not get to ${args.player}: ${t.message}`, evidence };
    }
    if (ctx.signal.aborted) return { status: 'interrupted', cause: 'interrupted', message: 'Cancelled before giving.', evidence };
    const target = playerEntity(bot, args.player);
    if (!target) return { status: 'failed', cause: 'not_found_nearby', message: `${args.player} went out of sight.`, evidence };
    const dist = bot.entity.position.distanceTo(target.position);
    evidence.push(`distance to ${args.player} when giving: ${dist.toFixed(1)}`);
    if (dist > CLOSE + 1.5) return { status: 'failed', cause: 'unreachable', message: `Only got within ${dist.toFixed(1)} blocks of ${args.player}.`, evidence };

    // What the server says the player picked up: collect packets whose collector is that player and whose
    // collected entity is an item of this kind. This is the bot's own evidence; the judge still reads the
    // player's inventory on the server.
    const ownerId = target.id;
    const myId = bot.entity.id;
    let toOwner = 0;
    let backToMe = 0;
    const onCollect = (p: any) => {
      const collected = bot.entities[p.collectedEntityId] as any;
      if (collected?.name !== 'item' || collected.getDroppedItem?.()?.name !== args.item) return;
      const n = Number(p.pickupItemCount ?? collected.getDroppedItem?.()?.count ?? 1);
      if (p.collectorEntityId === ownerId) toOwner += n;
      else if (p.collectorEntityId === myId) backToMe += n;
    };
    (bot as any)._client.on('collect', onCollect);
    try {
      const itemType = bot.registry.itemsByName[args.item].id;
      const before = held(bot, args.item);
      const left = await withInventoryLock(async () => {
        let live = playerEntity(bot, args.player);
        // Too close and the drop lands at the bot's own feet, where it picks it straight back up.
        if (live && bot.entity.position.distanceTo(live.position) < MIN_GIVE_DIST) {
          await stepBack(bot, live.position, 250);
          live = playerEntity(bot, args.player);
        }
        // Aim at their feet: a drop thrown level flies about 3 blocks and lands past them.
        if (live) await bot.lookAt(live.position.offset(0, 0.2, 0), true);
        const n = await dropReliably(bot, itemType, args.count, ctx.signal);
        // Back off during the 2 s pickup delay so only the player is in reach of what was dropped.
        const now = playerEntity(bot, args.player);
        if (now) await stepBack(bot, now.position, 450);
        return n;
      });
      evidence.push(`dropped ${left} ${args.item} (${args.item} ${before} -> ${held(bot, args.item)})`);
      if (ctx.signal.aborted) return { status: 'interrupted', cause: 'interrupted', message: `Cancelled while giving; ${left} ${args.item} left the inventory.`, evidence };
      if (left !== args.count) {
        return { status: left > 0 ? 'partial' : 'failed', cause: 'server_rejected', message: `Meant to give ${args.count} ${args.item}, but ${left} left the inventory.`, evidence };
      }

      // A dropped item cannot be picked up for 2 s; then wait until the player has collected all of it.
      const deadline = Date.now() + PICKUP_WAIT_MS + 3000;
      while (toOwner < args.count && Date.now() < deadline && !ctx.signal.aborted) await sleep(200);
      const at = playerEntity(bot, args.player)?.position ?? bot.entity.position;
      const unique = [...new Set([...groundItems(bot, args.item, at, 6), ...groundItems(bot, args.item, bot.entity.position, 6)])];
      const onGround = unique.reduce((a, e) => a + (e.getDroppedItem?.()?.count ?? 1), 0);
      evidence.push(`${args.player} picked up ${toOwner}, the bot took back ${backToMe}, ${onGround} still on the ground nearby`);
      if (toOwner >= args.count) return { status: 'done', message: `Gave ${args.count} ${args.item} to ${args.player} (they picked up ${toOwner}).`, evidence };
      const where = [backToMe ? `the bot picked ${backToMe} back up` : '', onGround ? `${onGround} are lying on the ground` : ''].filter(Boolean).join(', ') || 'the rest were not seen';
      return {
        status: toOwner > 0 ? 'partial' : 'failed',
        cause: 'blocked',
        message: `Dropped ${args.count} ${args.item}, but ${args.player} picked up only ${toOwner}; ${where}.`,
        fix: `give the missing ${args.count - toOwner} again from closer, or ask ${args.player} to pick them up`,
        evidence,
      };
    } finally {
      (bot as any)._client.off('collect', onCollect);
    }
  },
};
