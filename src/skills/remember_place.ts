import { z } from 'zod';
import { SkillDefinition, SkillOutcome } from './contract.js';
import { getPlaces, normalizeName } from '../memory/places.js';

/**
 * remember_place: store a position under a name ("base", "the furnace") so later steps and later tasks can use it:
 * go_to {place: "base"}, and the KNOWN PLACES section of the decision brief. Without x, y, z it stores where the
 * bot stands now. A name that already exists is overwritten, and the message says so.
 */

const Args = z
  .object({
    name: z.string().min(1).max(40),
    x: z.number().finite().optional(),
    y: z.number().finite().optional(),
    z: z.number().finite().optional(),
  })
  .refine((a) => [a.x, a.y, a.z].every((v) => v === undefined) || [a.x, a.y, a.z].every((v) => v !== undefined), { message: 'give all of x, y, z or none of them' });
type RememberArgs = z.infer<typeof Args>;

export const rememberPlaceSkill: SkillDefinition<RememberArgs> = {
  name: 'remember_place',
  summary: 'remember_place {name, x?, y?, z?}: remember a position under a name ("base"); with no coordinates it is where you stand now. Use go_to {place: name} to return.',
  args: Args,
  check(ctx, a) {
    if (!normalizeName(a.name)) return { ok: false, cause: 'invalid_args', message: 'The place needs a name.' };
    if (a.x === undefined && !ctx.bot.entity) return { ok: false, cause: 'unknown', message: 'The bot is not in the world.' };
    if (a.y !== undefined && Math.abs(a.y) > 400) return { ok: false, cause: 'invalid_args', message: `y=${a.y} is outside the world.` };
    return { ok: true };
  },
  async run(ctx, a): Promise<SkillOutcome> {
    const p = a.x === undefined ? ctx.bot.entity.position : { x: a.x, y: a.y!, z: a.z! };
    const places = getPlaces();
    const { replaced } = places.setNamed(a.name, p);
    const saved = places.getNamed(a.name)!;
    places.save();
    return {
      status: 'done',
      message: `Remembered "${saved.name}" at ${saved.x} ${saved.y} ${saved.z}${replaced ? ` (it was ${replaced.x} ${replaced.y} ${replaced.z})` : ''}.`,
      evidence: [`${saved.name} = ${saved.x} ${saved.y} ${saved.z}`, `known places: ${places.listNamed().map((n) => n.name).join(', ')}`],
    };
  },
};
