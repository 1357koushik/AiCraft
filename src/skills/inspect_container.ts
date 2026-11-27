import { z } from 'zod';
import { Vec3 } from 'vec3';
import { SkillDefinition, SkillOutcome } from './contract.js';
import { goTo, GoalReachBlock, eyeDistance } from './world.js';
import { openContainer, closeContainer, countRange } from './container_io.js';
import { withInventoryLock } from '../actions/reliable_craft.js';

/**
 * inspect_container: look inside a chest, barrel, shulker box, furnace or similar and report what it holds,
 * without moving anything. The bot cannot see container contents until it opens one, so this is how the LLM
 * learns amounts before deciding ("smelt the raw iron in that chest": how much is there?).
 */

const Args = z.object({ x: z.number(), y: z.number(), z: z.number() });
type InspectArgs = z.infer<typeof Args>;
const REACH = 4.5;

export const inspectContainerSkill: SkillDefinition<InspectArgs> = {
  name: 'inspect_container',
  summary: 'inspect_container {x, y, z}: open the chest, barrel, shulker box or furnace there, report what it holds, and close it. Moves nothing.',
  args: Args,
  check(ctx, a) {
    const b = ctx.bot.blockAt(new Vec3(Math.floor(a.x), Math.floor(a.y), Math.floor(a.z)));
    if (!b) return { ok: false, cause: 'not_found_nearby', message: `The block at ${a.x} ${a.y} ${a.z} is not loaded.` };
    if (!/chest|barrel|shulker_box|furnace|smoker|hopper|dispenser|dropper/.test(b.name)) {
      return { ok: false, cause: 'not_found_nearby', message: `There is no container at ${a.x} ${a.y} ${a.z} (found ${b.name}).` };
    }
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
    const block = bot.blockAt(pos);
    let contents: Record<string, number> = {};
    try {
      await withInventoryLock(async () => {
        const win = await openContainer(bot, block);
        try {
          contents = countRange(win, 0, win.inventoryStart);
        } finally {
          await closeContainer(bot, win);
        }
      });
    } catch (err) {
      return { status: 'failed', cause: 'blocked', message: `Could not open the ${block?.name}: ${(err as Error).message}`, evidence };
    }
    const text = Object.entries(contents).map(([k, v]) => `${k} x${v}`).join(', ') || 'nothing';
    evidence.push(`contents: ${text}`);
    return { status: 'done', message: `The ${block?.name} at ${a.x} ${a.y} ${a.z} holds: ${text}.`, evidence };
  },
};
