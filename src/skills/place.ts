import { z } from 'zod';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { FailureCause, Precondition, SkillDefinition, SkillOutcome } from './contract.js';
import { equipItem } from './equip.js';
import { travel } from './go_to.js';
import { settleInventory } from '../actions/reliable_craft.js';

/**
 * place: put a held block at an exact position. It picks a solid neighbour to place against, walks into reach,
 * places, then reads the world (not the placeBlock promise, which can time out when the block was placed).
 */

const Args = z.object({
  item: z.string().min(1).transform((s) => s.replace(/^minecraft:/, '')),
  x: z.number().int(),
  y: z.number().int(),
  z: z.number().int(),
});
type PlaceArgs = z.infer<typeof Args>;

/** Survival block reach is 4.5; stay inside it with some margin for the eye-to-face-centre distance. */
const REACH = 4.0;
const FACES = [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];

/** Blocks a placement simply replaces. */
const REPLACEABLE = /^(air|cave_air|void_air|water|lava|short_grass|tall_grass|fern|large_fern|dead_bush|seagrass|tall_seagrass|snow|vine|glow_lichen|light|fire|soul_fire)$/;

function isSolidRef(b: any): boolean {
  return Boolean(b) && b.boundingBox === 'block' && !REPLACEABLE.test(b.name);
}

function isOccupied(b: any): boolean {
  return Boolean(b) && !REPLACEABLE.test(b.name);
}

/** The first non-item entity whose box overlaps the cell, or null. Includes the bot itself when `includeSelf`. */
function entityIn(bot: Bot, p: Vec3, includeSelf: boolean): any | null {
  for (const e of Object.values(bot.entities) as any[]) {
    if (!e || !e.position) continue;
    if (e === bot.entity && !includeSelf) continue;
    if (e.name === 'item' || e.name === 'experience_orb' || e.type === 'orb' || e.type === 'other' || e.name === 'arrow') continue;
    const w = (e.width ?? 0.6) / 2;
    const h = e.height ?? 1.8;
    const overlaps = e.position.x + w > p.x + 0.001 && e.position.x - w < p.x + 1 - 0.001 && e.position.z + w > p.z + 0.001 && e.position.z - w < p.z + 1 - 0.001 && e.position.y + h > p.y + 0.001 && e.position.y < p.y + 1 - 0.001;
    if (overlaps) return e;
  }
  return null;
}

function heldCount(bot: Bot, name: string): number {
  return bot.inventory.items().filter((i: any) => i.name === name && i.slot > 4 && i.slot < 45).reduce((a, i) => a + i.count, 0);
}

function describeBlock(b: any): string {
  if (!b) return 'unloaded';
  let props = '';
  try {
    const p = b.getProperties?.();
    if (p && Object.keys(p).length) props = ` [${Object.entries(p).map(([k, v]) => `${k}=${v}`).join(',')}]`;
  } catch {
    // Properties are only evidence.
  }
  return `${b.name}${props}`;
}

function evaluate(bot: Bot, args: PlaceArgs): Precondition {
  const def = bot.registry.itemsByName[args.item];
  if (!def) return { ok: false, cause: 'invalid_args', message: `There is no item called "${args.item}".` };
  if (heldCount(bot, args.item) < 1) return { ok: false, cause: 'missing_item', message: `No ${args.item} in the inventory.`, fix: `get a ${args.item}` };
  const target = new Vec3(args.x, args.y, args.z);
  const block = bot.blockAt(target);
  if (!block) return { ok: false, cause: 'unreachable', message: `The chunk at ${target} is not loaded.`, fix: 'walk closer first' };
  if (isOccupied(block)) {
    return { ok: false, cause: 'blocked', message: `${target} is already ${block.name}.`, fix: 'choose an empty position or break the block first' };
  }
  const ent = entityIn(bot, target, false);
  if (ent) return { ok: false, cause: 'blocked', message: `A ${ent.name ?? ent.type} is standing at ${target}.`, fix: 'wait for it to move' };
  if (bot.game?.dimension && args.y < -64) return { ok: false, cause: 'invalid_args', message: `y=${args.y} is below the world.` };
  return { ok: true };
}

/** Faces of the target that touch a solid block, nearest the bot's eyes first. */
function candidateFaces(bot: Bot, target: Vec3): { ref: any; face: Vec3; dist: number }[] {
  const eye = bot.entity.position.offset(0, bot.entity.height ?? 1.62, 0);
  const out: { ref: any; face: Vec3; dist: number }[] = [];
  for (const f of FACES) {
    // f points from the reference block to the target, so the reference block is target - f.
    const ref = bot.blockAt(target.minus(f));
    if (!isSolidRef(ref)) continue;
    const faceCentre = ref!.position.offset(0.5, 0.5, 0.5).plus(f.scaled(0.5));
    out.push({ ref, face: f, dist: eye.distanceTo(faceCentre) });
  }
  return out.sort((a, b) => a.dist - b.dist);
}

function matches(item: string, block: any): boolean {
  if (!block) return false;
  const n = block.name as string;
  return n === item || n === item.replace(/torch$/, 'wall_torch') || n === item.replace(/_sign$/, '_wall_sign') || n === item.replace(/_banner$/, '_wall_banner') || (item === 'redstone' && n === 'redstone_wire');
}

export const placeSkill: SkillDefinition<PlaceArgs> = {
  name: 'place',
  summary: 'place {item, x, y, z}: place a held block at that exact position, walking into reach and placing against a solid neighbour.',
  args: Args,
  check(ctx, args) {
    return evaluate(ctx.bot, args);
  },
  async run(ctx, args): Promise<SkillOutcome> {
    const bot = ctx.bot;
    const evidence: string[] = [];
    const pre = evaluate(bot, args);
    if (!pre.ok) return { status: 'failed', cause: pre.cause, message: pre.message, fix: pre.fix, evidence };
    const target = new Vec3(args.x, args.y, args.z);
    const countBefore = heldCount(bot, args.item);
    const fail = (cause: FailureCause, message: string, fix?: string): SkillOutcome => ({
      status: cause === 'interrupted' ? 'interrupted' : 'failed',
      cause,
      message,
      fix,
      evidence,
    });

    if (!candidateFaces(bot, target).length) {
      return fail('unreachable', `${target} touches no solid block to place against.`, 'place a supporting block first, or pick a position next to the ground or a wall');
    }

    // Step out of the cell if the bot is standing in it.
    if (entityIn(bot, target, true) === bot.entity) {
      evidence.push('bot was standing in the target cell; stepping away');
      const away = target.offset(0.5, 0, 0.5);
      const t = await travel(ctx, away.x + 3, away.y, away.z, 1);
      evidence.push(`stepped to ${t.end}`);
      if (entityIn(bot, target, true) === bot.entity) return fail('blocked', `The bot is standing at ${target} and could not move out of it.`);
    }

    let placed: any = null;
    let lastError = '';
    for (let attempt = 0; attempt < 3 && !placed; attempt++) {
      if (ctx.signal.aborted) return fail('interrupted', 'Cancelled before placing.');
      let faces = candidateFaces(bot, target);
      if (!faces.length || faces[0].dist > REACH) {
        const t = await travel(ctx, target.x, target.y, target.z, 3);
        evidence.push(`walked ${t.start} -> ${t.end}`);
        if (!t.ok && t.cause === 'interrupted') return fail('interrupted', t.message);
        if (!t.ok) {
          faces = candidateFaces(bot, target);
          if (!faces.length || faces[0].dist > REACH) return fail(t.cause === 'no_progress' ? 'no_progress' : 'unreachable', `Could not get within reach of ${target}: ${t.message}`, 'clear a way to the spot');
        }
        faces = candidateFaces(bot, target);
        if (entityIn(bot, target, true) === bot.entity) {
          // The walk ended inside the target; step off and try again.
          await travel(ctx, target.x + 3, target.y, target.z, 1);
          faces = candidateFaces(bot, target);
        }
      }
      const reachable = faces.filter((f) => f.dist <= REACH);
      if (!reachable.length) return fail('unreachable', `No face of ${target} is within ${REACH} blocks of the bot after walking.`, 'clear a way to the spot');
      const choice = reachable[Math.min(attempt, reachable.length - 1)];

      // The block may have been taken by a mob or another action while we walked.
      const now = bot.blockAt(target);
      if (isOccupied(now)) return fail('blocked', `${target} became ${now!.name} while walking there.`);
      const ent = entityIn(bot, target, false);
      if (ent) return fail('blocked', `A ${ent.name ?? ent.type} moved into ${target}.`, 'wait for it to move');

      const err = await equipItem(bot, args.item, 'hand');
      if (err) return fail('server_rejected', `Could not hold ${args.item}: ${err}`);

      evidence.push(`attempt ${attempt + 1}: against ${choice.ref.name} at ${choice.ref.position} face ${choice.face}`);
      bot.setControlState('sneak', true); // so a chest or table used as support is not opened instead
      try {
        await (bot.placeBlock(choice.ref, choice.face) as Promise<void>).catch((e: Error) => {
          lastError = e.message;
        });
      } finally {
        bot.setControlState('sneak', false);
      }
      await settleInventory(bot);
      await bot.waitForTicks(4);
      const b = bot.blockAt(target);
      if (matches(args.item, b) || (isOccupied(b) && heldCount(bot, args.item) < countBefore)) placed = b;
      else evidence.push(`block at target after attempt: ${describeBlock(b)}${lastError ? `; placeBlock said: ${lastError}` : ''}`);
    }

    const countAfter = heldCount(bot, args.item);
    evidence.push(`${args.item} ${countBefore} -> ${countAfter}`);
    if (!placed) {
      return fail('server_rejected', `The server did not place ${args.item} at ${target}${lastError ? ` (${lastError})` : ''}.`, 'check that the spot is inside reach and not protected');
    }
    evidence.push(`block at ${target}: ${describeBlock(placed)}`);
    return {
      status: 'done',
      message: `Placed ${args.item} at ${target} (${describeBlock(placed)}).`,
      evidence,
      worldDelta: { placed: [{ x: args.x, y: args.y, z: args.z, block: placed.name }], broken: [] },
    };
  },
};
