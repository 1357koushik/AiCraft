import { z } from 'zod';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { goals } from 'mineflayer-pathfinder';
import { updatePathfinderMovements } from '../actions/techniques.js';
import { body } from '../reflexes/body.js';
import { bestWeaponInHand } from '../reflexes/guard.js';
import { lootTableItems } from '../knowledge/harvest.js';
import { Precondition, SkillContext, SkillDefinition, SkillOutcome } from './contract.js';
import { pickUpDrops } from './collect_drops.js';
import { countItems, sleep, stopMotion, stopPathfinder, stripNs } from './world.js';

/**
 * hunt: kill passive farm animals for what they drop (beef, porkchop, mutton, chicken, rabbit, leather, feathers...).
 *
 * Who may be attacked: only the animals in HUNTABLE, adults (a calf drops nothing and is the herd's future), with no
 * name tag. Players, villagers, golems, horses and donkeys, wolves, cats, parrots and every other mob are never in
 * the list, so they can never be picked, and a named animal is somebody's pet whatever its species.
 *
 * `count` means "this many more of `item`" when `item` is given (beef x3), else "this many kills" of `animal`.
 * `spare` (default 2) animals of a kind are always left alive within SPARE_RADIUS of where the hunt started, so a
 * pen or a small herd is not wiped out; when only the spare ones are left the skill stops and says so.
 *
 * Kills are counted from the animal's death right after one of the bot's own swings (like guard), and the result is
 * read from the inventory: the item count must really have gone up.
 *
 * explore_for only searches for blocks, not animals, so when none are around the fix hint points at moving to
 * grassland or a village rather than at a search that cannot find them.
 */

/** Animals this skill may kill. Goats drop nothing, so they are hunted only when named in `animal`. */
export const HUNTABLE = ['cow', 'mooshroom', 'pig', 'sheep', 'chicken', 'rabbit', 'goat'] as const;
const PASSIVE_DEFAULT = HUNTABLE.filter((a) => a !== 'goat');

const Args = z
  .object({
    animal: z.string().min(1).transform((s) => s.trim().toLowerCase().replace(/^minecraft:/, '').replace(/s$/, '')).optional(),
    item: z.string().min(1).transform(stripNs).optional(),
    count: z.number().int().min(1).max(64).default(1),
    spare: z.number().int().min(0).max(32).default(2),
  })
  .refine((a) => a.animal || a.item, { message: 'give an animal or an item to hunt for' });
type HuntArgs = z.infer<typeof Args>;

const SEARCH_RADIUS = 48;
const SPARE_RADIUS = 32;
const SWING_REACH = 3.0;
/** A sword's attack cooldown, as in the fight reflex. */
const SWING_MS = 650;
const ENGAGE_MS = 25000;
const IGNORE_MS = 40000;
const KILL_WINDOW_MS = 3000;
const DROP_WAIT_MS = 700;

/** Animals whose loot table drops `item` (from the game's loot tables), in HUNTABLE order. */
export function animalsDropping(item: string): string[] {
  return HUNTABLE.filter((a) => dropsOf(a).includes(item));
}

/** What an animal drops (game loot table). */
export function dropsOf(animal: string): string[] {
  try {
    return lootTableItems(`entities/${animal}`, { followRefs: true });
  } catch {
    return [];
  }
}

function metaValue(e: any, index: number): any {
  const m = e?.metadata?.[index];
  return m && typeof m === 'object' && !Array.isArray(m) && 'value' in m ? m.value : m;
}

/** Index of a metadata key in the entity's metadata array, from minecraft-data (falls back to the 1.21 layout). */
function metaIndex(bot: Bot | undefined, name: string, key: string, fallback: number): number {
  const keys: string[] | undefined = (bot?.registry as any)?.entitiesByName?.[name]?.metadataKeys;
  const i = keys ? keys.indexOf(key) : -1;
  return i >= 0 ? i : fallback;
}

/** True for an entity this skill may attack: a listed adult animal that is alive and has no name tag. */
export function isHuntTarget(e: any, allowed: readonly string[] = PASSIVE_DEFAULT, bot?: Bot): boolean {
  if (!e?.position || !e.name || e.isValid === false) return false;
  if (e.type === 'player' || e.username) return false;
  if (!allowed.includes(e.name) || !(HUNTABLE as readonly string[]).includes(e.name)) return false;
  const nameTag = metaValue(e, metaIndex(bot, e.name, 'custom_name', 2));
  if (nameTag !== undefined && nameTag !== null && nameTag !== false && nameTag !== '') return false;
  if (metaValue(e, metaIndex(bot, e.name, 'baby', 16)) === true) return false;
  return true;
}

interface Candidates {
  /** Targets that may be killed now, nearest first. */
  targets: any[];
  /** Adults of each species alive near the start. */
  alive: Record<string, number>;
  /** Targets left alone only because of `spare`. */
  spared: number;
}

export function pickTargets(entities: Iterable<any>, species: readonly string[], me: Vec3, spot: Vec3, spare: number, ignored: Map<number, number>, now: number, dead: Set<number>, bot?: Bot): Candidates {
  const alive: Record<string, number> = {};
  const all: any[] = [];
  for (const e of entities) {
    if (!isHuntTarget(e, species, bot) || dead.has(e.id)) continue;
    if (e.position.distanceTo(spot) <= SPARE_RADIUS) alive[e.name] = (alive[e.name] ?? 0) + 1;
    if (e.position.distanceTo(me) <= SEARCH_RADIUS && (ignored.get(e.id) ?? 0) <= now) all.push(e);
  }
  const targets = all.filter((e) => (alive[e.name] ?? 0) > spare).sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me));
  return { targets, alive, spared: all.length - targets.length };
}

function speciesFor(args: HuntArgs): { species: string[]; error?: string } {
  if (args.animal) {
    if (!(HUNTABLE as readonly string[]).includes(args.animal)) {
      return { species: [], error: `${args.animal} is not an animal this skill hunts (cow, mooshroom, pig, sheep, chicken, rabbit, goat). Pets, villagers, golems and horses are never attacked.` };
    }
    return { species: [args.animal] };
  }
  const list = animalsDropping(args.item!);
  if (!list.length) return { species: [], error: `None of the huntable animals drops ${args.item}.` };
  return { species: list };
}

function check(ctx: { bot: Bot }, args: HuntArgs): Precondition {
  const bot = ctx.bot;
  if (!(bot as any).pathfinder) return { ok: false, cause: 'unknown', message: 'The pathfinder is not available.' };
  if (args.item && !bot.registry.itemsByName[args.item]) return { ok: false, cause: 'invalid_args', message: `There is no item called "${args.item}".` };
  const s = speciesFor(args);
  if (s.error) return { ok: false, cause: 'invalid_args', message: s.error, fix: 'name a farm animal (cow, pig, sheep, chicken, rabbit) or an item one of them drops (beef, porkchop, mutton, chicken, rabbit, leather, feather, wool)' };
  const me = bot.entity.position;
  const c = pickTargets(Object.values(bot.entities), s.species, me, me, args.spare, new Map(), Date.now(), new Set(), bot);
  if (c.targets.length) return { ok: true };
  const what = s.species.join(' or ');
  if (c.spared > 0) {
    return { ok: false, cause: 'blocked', message: `Only ${c.spared} ${what} within ${SEARCH_RADIUS} blocks and ${args.spare} must be spared.`, fix: `set spare lower to take them, or find another herd of ${what}` };
  }
  return { ok: false, cause: 'not_found_nearby', message: `No ${what} within ${SEARCH_RADIUS} blocks.`, fix: `walk to where ${what} live (grassland or a village; explore_for searches blocks only, so try explore_for {target:"village"} or another direction) and hunt again` };
}

function heldCount(bot: Bot, item: string): number {
  return countItems(bot, (n) => n === item);
}

export const huntSkill: SkillDefinition<HuntArgs> = {
  name: 'hunt',
  summary:
    'hunt {animal?, item?, count, spare?=2}: kill passive farm animals (cow, mooshroom, pig, sheep, chicken, rabbit) and pick up the drops, until `count` more of `item` is held (item "beef", count 3) or, with only `animal`, `count` animals are killed. Leaves `spare` animals of a kind alive nearby. Never touches players, pets, villagers, horses or named animals.',
  args: Args,
  check: (ctx, args) => check(ctx, args),
  async run(ctx: SkillContext, args): Promise<SkillOutcome> {
    const bot: any = ctx.bot;
    const evidence: string[] = [];
    const { species } = speciesFor(args);
    const movements = updatePathfinderMovements(ctx.bot);
    if (movements) movements.canDig = false; // Hunting never digs through the world.
    bot.pathfinder.thinkTimeout = 3000;

    const spot: Vec3 = bot.entity.position.clone();
    const startedAt = Date.now();
    const startHeld = args.item ? heldCount(ctx.bot, args.item) : 0;
    const wantHeld = startHeld + args.count;

    // --- Kill bookkeeping, as in guard: a death right after one of the bot's own swings is its kill. ---
    const lastSwingAt = new Map<number, number>();
    const originalAttack = bot.attack.bind(bot);
    bot.attack = (target: any, ...rest: any[]) => {
      if (target?.id !== undefined) lastSwingAt.set(target.id, Date.now());
      return originalAttack(target, ...rest);
    };
    const kills: Record<string, number> = {};
    const counted = new Set<number>();
    const pending: Vec3[] = []; // where kills fell, to collect their drops
    const totalKills = () => Object.values(kills).reduce((a, b) => a + b, 0);
    const speciesKills = () => (args.animal ? kills[args.animal] ?? 0 : totalKills());
    const swungRecently = (e: any) => {
      const at = lastSwingAt.get(e.id);
      return at !== undefined && Date.now() - at <= KILL_WINDOW_MS;
    };
    const countKill = (e: any) => {
      counted.add(e.id);
      kills[e.name] = (kills[e.name] ?? 0) + 1;
      if (e.position) pending.push(e.position.clone());
      ctx.log(`[hunt] killed ${e.name} (${totalKills()} so far)`);
    };
    // entityDead (the death animation) arrives before entityGone; either counts, once.
    const onDeath = (e: any) => {
      if (!e || counted.has(e.id) || !(species as string[]).includes(e.name) || !swungRecently(e)) return;
      countKill(e);
    };
    bot.on('entityDead', onDeath);
    bot.on('entityGone', onDeath);
    const killText = () => (totalKills() ? Object.entries(kills).map(([k, n]) => `${k} x${n}`).join(', ') : 'none');

    const ignored = new Map<number, number>();
    const engagedSince = new Map<number, number>();
    let lastSwing = 0;
    let goalFor: number | null = null;
    let sparedSeen = 0;
    let noneSeenSince: number | null = null;
    let collected = 0;

    const done = () => (args.item ? heldCount(ctx.bot, args.item) >= wantHeld : speciesKills() >= args.count);
    const gained = () => (args.item ? heldCount(ctx.bot, args.item) - startHeld : speciesKills());
    const unit = args.item ?? `${args.animal} kill(s)`;

    const cleanup = () => {
      bot.attack = originalAttack;
      bot.off('entityDead', onDeath);
      bot.off('entityGone', onDeath);
      stopMotion(ctx.bot);
    };
    const finish = (o: Pick<SkillOutcome, 'status' | 'message'> & Partial<SkillOutcome>): SkillOutcome => {
      cleanup();
      evidence.push(`hunted ${species.join('/')} for ${Math.round((Date.now() - startedAt) / 1000)} s: killed ${killText()}${args.item ? `; ${args.item} ${startHeld} -> ${heldCount(ctx.bot, args.item)}` : ''}; picked up ${collected} item(s)`);
      return { evidence, ...o };
    };

    const collectKills = async () => {
      while (pending.length && !ctx.signal.aborted) {
        const at = pending.shift()!;
        await sleep(DROP_WAIT_MS); // the drops appear when the death animation ends
        const r = await pickUpDrops(ctx, { radius: 6, around: at, windowMs: 5000 });
        collected += r.pickedUp;
        ctx.log(`[hunt] collected ${r.pickedUp} item(s) near ${at.floored()}; stopped by ${r.stoppedBy}`);
      }
    };

    try {
      while (!done()) {
        if (ctx.signal.aborted) return finish({ status: 'interrupted', cause: 'interrupted', message: `hunt was cancelled; killed ${killText()}, gained ${gained()} ${unit} of ${args.count}.` });
        if (body.reflexActive) {
          await sleep(100);
          continue;
        }
        if (pending.length) {
          await collectKills();
          continue;
        }
        const now = Date.now();
        const me: Vec3 = bot.entity.position;
        const c = pickTargets(Object.values(bot.entities), species, me, spot, args.spare, ignored, now, counted, ctx.bot);
        sparedSeen = Math.max(sparedSeen, c.spared);
        if (!c.targets.length) {
          // Give the entity list a moment: animals can be briefly out of the loaded set while chasing.
          noneSeenSince = noneSeenSince ?? now;
          if (now - noneSeenSince < 1500) {
            await sleep(200);
            continue;
          }
          break;
        }
        noneSeenSince = null;
        const e = c.targets[0];
        if (!engagedSince.has(e.id)) engagedSince.set(e.id, now);
        if (now - engagedSince.get(e.id)! > ENGAGE_MS) {
          ignored.set(e.id, now + IGNORE_MS);
          engagedSince.delete(e.id);
          ctx.log(`[hunt] giving up on ${e.name} ${e.id} for a while: not dead after ${ENGAGE_MS / 1000} s`);
          continue;
        }
        const d = e.position.distanceTo(me);
        if (d > SWING_REACH) {
          if (!(bot.pathfinder.goal && goalFor === e.id)) {
            bot.pathfinder.setGoal(new goals.GoalFollow(e, 1.5), true);
            goalFor = e.id;
          }
          await sleep(100);
          continue;
        }
        stopPathfinder(ctx.bot);
        goalFor = null;
        await bestWeaponInHand(ctx.bot);
        await bot.lookAt(e.position.offset(0, (e.height ?? 1.2) * 0.7, 0), true);
        if (Date.now() - lastSwing >= SWING_MS && e.isValid !== false && !body.reflexActive && e.position.distanceTo(bot.entity.position) <= SWING_REACH + 0.5) {
          bot.attack(e);
          lastSwing = Date.now();
        }
        await sleep(100);
      }
      // A kill made on the last swing: collect its drops before judging.
      await collectKills();
      if (!done()) await sleep(300);
    } catch (err) {
      return finish({ status: ctx.signal.aborted ? 'interrupted' : 'failed', cause: ctx.signal.aborted ? 'interrupted' : 'unknown', message: `hunt stopped: ${(err as Error).message}; killed ${killText()}.` });
    }

    const got = gained();
    if (done()) {
      return finish({ status: 'done', message: args.item ? `Hunted ${killText()} and now hold ${got} more ${args.item} (${heldCount(ctx.bot, args.item)} in all).` : `Killed ${killText()}.` });
    }
    const what = species.join(' or ');
    const sparing = sparedSeen > 0;
    if (totalKills() > 0 && args.item && got <= 0) {
      return finish({ status: 'failed', cause: 'server_rejected', message: `Killed ${killText()} but ${args.item} did not enter the inventory.`, fix: 'collect_drops near where the animals died, then check the inventory' });
    }
    return finish({
      status: got > 0 ? 'partial' : 'failed',
      cause: sparing ? 'blocked' : 'not_found_nearby',
      message: `Got ${got} of ${args.count} ${unit}: ${sparing ? `only the ${args.spare} animals to spare are left within ${SPARE_RADIUS} blocks` : `no more ${what} within ${SEARCH_RADIUS} blocks`}; killed ${killText()}.`,
      fix: sparing ? `only the ${args.spare} spared ${what} are left here; set spare lower to take them, or find another herd` : `walk to where ${what} live (grassland or a village; explore_for searches blocks only) and hunt again`,
    });
  },
};
