import { z } from 'zod';
import { Vec3 } from 'vec3';
import { SkillDefinition, SkillOutcome } from './contract.js';
import { goTo, GoalReachBlock, eyeDistance } from './world.js';

/**
 * use_block: right-click a block that does something without a window: a lever, button, door, trapdoor,
 * fence gate, bell, note block, repeater or comparator. Verified by the block's state changing (or, for
 * buttons and bells, by the server registering the use).
 */

const Args = z.object({ x: z.number(), y: z.number(), z: z.number() });
type UseArgs = z.infer<typeof Args>;

const REACH = 4.5;
/** Blocks whose use only flips back on its own or plays a sound, so their state may not stay changed. */
const MOMENTARY = /button|bell|note_block|pressure_plate/;

function stateText(block: any): string {
  const props = block?.getProperties?.() ?? {};
  return Object.entries(props).map(([k, v]) => `${k}=${v}`).join(',');
}

export const useBlockSkill: SkillDefinition<UseArgs> = {
  name: 'use_block',
  summary: 'use_block {x, y, z}: right-click the block there (lever, button, door, trapdoor, fence gate, bell, note block, repeater, comparator), walking into reach first.',
  args: Args,
  check(ctx, a) {
    const b = ctx.bot.blockAt(new Vec3(Math.floor(a.x), Math.floor(a.y), Math.floor(a.z)));
    if (!b) return { ok: false, cause: 'not_found_nearby', message: `The block at ${a.x} ${a.y} ${a.z} is not loaded.` };
    if (b.name === 'air' || b.name === 'cave_air') return { ok: false, cause: 'not_found_nearby', message: `There is nothing at ${a.x} ${a.y} ${a.z}.` };
    return { ok: true };
  },
  async run(ctx, a): Promise<SkillOutcome> {
    const bot = ctx.bot;
    const pos = new Vec3(Math.floor(a.x), Math.floor(a.y), Math.floor(a.z));
    const evidence: string[] = [];
    if (eyeDistance(bot, pos) > REACH) {
      const r = await goTo(ctx, new GoalReachBlock(pos, REACH - 0.4), () => eyeDistance(bot, pos), 15000, true);
      evidence.push(`walk: ${r.reason}${r.detail ? ` (${r.detail})` : ''}`);
      if (eyeDistance(bot, pos) > REACH) return { status: 'failed', cause: r.reason === 'aborted' ? 'interrupted' : 'unreachable', message: `Could not get within reach of ${a.x} ${a.y} ${a.z}.`, evidence };
    }
    const before = bot.blockAt(pos);
    const beforeState = stateText(before);
    await bot.activateBlock(before as any);
    await bot.waitForTicks(4);
    const after = bot.blockAt(pos);
    const afterState = stateText(after);
    evidence.push(`${before?.name} [${beforeState}] -> ${after?.name} [${afterState}]`);
    if (afterState !== beforeState || MOMENTARY.test(before?.name ?? '')) {
      return { status: 'done', message: `Used the ${before?.name} at ${a.x} ${a.y} ${a.z}${afterState !== beforeState ? ` (now ${afterState})` : ''}.`, evidence };
    }
    return { status: 'failed', cause: 'blocked', message: `Using the ${before?.name} changed nothing (it may need power, a key, or not be usable).`, evidence };
  },
};
