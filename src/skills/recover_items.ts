import { z } from 'zod';
import { Vec3 } from 'vec3';
import { Precondition, SkillDefinition, SkillOutcome } from './contract.js';
import { travel } from './go_to.js';
import { pickUpDrops } from './collect_drops.js';
import { allItems, describeItems, watchDeaths, whyNotRecoverable, DROP_LIFETIME_MS } from '../survival/deaths.js';

/**
 * recover_items: after a death, walk back to where the bot died and pick up what it dropped. Success is measured
 * against the death log: every item held just before dying, compared with what the bot holds now minus what it
 * had right after respawning. The brain loop and the companion run this by themselves after a death; the LLM can
 * also call it.
 */

const Args = z.object({
  radius: z.number().min(2).max(16).default(8),
});
type RecoverArgs = z.infer<typeof Args>;

function evaluate(ctx: { bot: any }): Precondition {
  const rec = watchDeaths(ctx.bot).last;
  if (!rec) return { ok: false, cause: 'not_found_nearby', message: 'The bot has not died since it joined, so there is nothing to recover.' };
  if (!rec.respawned) return { ok: false, cause: 'blocked', message: 'The bot has not respawned yet.' };
  const why = whyNotRecoverable(rec, ctx.bot);
  if (why) return { ok: false, cause: 'blocked', message: `Cannot recover the items from the death at ${rec.pos.x} ${rec.pos.y} ${rec.pos.z}: ${why}.` };
  return { ok: true };
}

/** What recovery brought back of each item lost, given what was held before dying, after respawning, and now. */
export function recoveredCounts(before: Record<string, number>, afterRespawn: Record<string, number>, now: Record<string, number>): { got: Record<string, number>; missing: Record<string, number> } {
  const got: Record<string, number> = {};
  const missing: Record<string, number> = {};
  for (const [name, had] of Object.entries(before)) {
    const lost = had - Math.min(had, afterRespawn[name] ?? 0);
    if (lost <= 0) continue;
    const back = Math.max(0, Math.min(lost, (now[name] ?? 0) - (afterRespawn[name] ?? 0)));
    if (back > 0) got[name] = back;
    if (back < lost) missing[name] = lost - back;
  }
  return { got, missing };
}

export const recoverItemsSkill: SkillDefinition<RecoverArgs> = {
  name: 'recover_items',
  summary: `recover_items {radius?=8}: after dying, walk back to where the bot died and pick up its dropped items (they despawn ${DROP_LIFETIME_MS / 60000} minutes after the death). Runs by itself after a death; call it again if it was cut short.`,
  args: Args,
  check: (ctx) => evaluate(ctx),
  async run(ctx, args): Promise<SkillOutcome> {
    const bot = ctx.bot;
    const evidence: string[] = [];
    const pre = evaluate(ctx);
    if (!pre.ok) return { status: 'failed', cause: pre.cause, message: pre.message, evidence };
    const rec = watchDeaths(bot).last!;
    rec.recoveryTried = true;
    const afterRespawn = rec.itemsAfterRespawn ?? {};
    evidence.push(`died at ${rec.pos.x} ${rec.pos.y} ${rec.pos.z} (${rec.cause ?? 'cause not seen'}) holding ${describeItems(rec.items)}`);
    const t = await travel(ctx, rec.pos.x, rec.pos.y, rec.pos.z, 2);
    evidence.push(`walked ${t.start} -> ${t.end} (${t.message})`);
    if (ctx.signal.aborted) return { status: 'interrupted', cause: 'interrupted', message: 'Cancelled on the way back to the death spot.', evidence };
    if (!t.ok && t.left > args.radius) {
      return { status: 'failed', cause: t.cause ?? 'unreachable', message: `Could not get back to where the bot died (${rec.pos.x} ${rec.pos.y} ${rec.pos.z}): ${t.message}`, evidence };
    }
    const wanted = (name: string) => name in rec.items;
    const r = await pickUpDrops(ctx, { radius: args.radius, wanted, around: new Vec3(rec.pos.x, rec.pos.y, rec.pos.z), windowMs: 8000 });
    evidence.push(`picked up ${r.pickedUp} item(s); stopped by ${r.stoppedBy}`);
    const { got, missing } = recoveredCounts(rec.items, afterRespawn, allItems(bot));
    evidence.push(`recovered ${describeItems(got)}; still missing ${describeItems(missing)}`);
    if (r.stoppedBy === 'aborted') return { status: 'interrupted', cause: 'interrupted', message: `Cancelled while picking up; recovered ${describeItems(got)} so far.`, evidence };
    if (!Object.keys(missing).length) return { status: 'done', message: `Recovered everything dropped at death: ${describeItems(got)}.`, evidence };
    const left = r.left.length ? ` ${r.left.length} drop(s) are still on the ground there.` : ' The rest was not on the ground (despawned, burned or destroyed).';
    return {
      status: Object.keys(got).length ? 'partial' : 'failed',
      cause: r.stoppedBy === 'inventory_full' ? 'inventory_full' : 'not_found_nearby',
      message: `Recovered ${describeItems(got)}; missing ${describeItems(missing)}.${left}`,
      evidence,
    };
  },
};
