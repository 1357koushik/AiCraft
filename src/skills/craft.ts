import { z } from 'zod';
import type { Bot } from 'mineflayer';
import { goals } from 'mineflayer-pathfinder';
import { getAllRecipesForItem } from '../actions/crafting.js';
import { craftReliably, CraftError } from '../actions/reliable_craft.js';
import { findSafePlacementSpot, updatePathfinderMovements } from '../actions/techniques.js';
import { Precondition, SkillContext, SkillDefinition, SkillOutcome, ProgressWatchdog } from './contract.js';

/**
 * craft: make `count` more of one item from ingredients the bot already holds.
 *
 * It does one thing. It never crafts the ingredients themselves: if sticks are missing for a pickaxe it fails
 * with cause missing_item and says how many more are needed, and the LLM (or the obtain skill) decides the
 * next step. This is the reference implementation for the other skills: check is cheap and side-effect free,
 * run re-checks, acts, then verifies against the inventory.
 */

const Args = z.object({
  item: z.string().min(1).transform((s) => s.replace(/^minecraft:/, '')),
  count: z.number().int().min(1).max(2304).default(1),
});
type CraftArgs = z.infer<typeof Args>;

/** How close a crafting table must be to use it without walking. */
const REACH = 4.5;
/** How far the skill will walk to a table it can see. Beyond this it places one from the inventory, if it has one. */
const WALK_TO_TABLE = 32;

interface Choice {
  recipe: any;
  executions: number;
  needsTable: boolean;
  missing: { name: string; count: number }[];
}

function heldById(bot: Bot): Map<number, number> {
  const out = new Map<number, number>();
  for (const it of bot.inventory.items()) out.set(it.type, (out.get(it.type) ?? 0) + it.count);
  return out;
}

/** Picks the recipe that needs nothing more, or failing that the one missing the fewest items. */
function chooseRecipe(bot: Bot, itemId: number, count: number): Choice | null {
  const recipes = getAllRecipesForItem(bot, itemId);
  if (!recipes.length) return null;
  const held = heldById(bot);
  const reg: any = bot.registry;
  let best: Choice | null = null;
  for (const recipe of recipes) {
    const perCraft = recipe.result?.count ?? 1;
    const executions = Math.ceil(count / perCraft);
    const need = new Map<number, number>();
    for (const d of recipe.delta ?? []) if (d.count < 0) need.set(d.id, (need.get(d.id) ?? 0) + -d.count * executions);
    const missing: Choice['missing'] = [];
    for (const [id, n] of need) {
      const short = n - (held.get(id) ?? 0);
      if (short > 0) missing.push({ name: reg.items[id]?.name ?? `item#${id}`, count: short });
    }
    const choice: Choice = { recipe, executions, needsTable: Boolean(recipe.requiresTable), missing };
    const total = (c: Choice) => c.missing.reduce((a, m) => a + m.count, 0);
    if (!best || total(choice) < total(best) || (total(choice) === total(best) && !choice.needsTable && best.needsTable)) best = choice;
    if (!missing.length && !choice.needsTable) break;
  }
  return best;
}

function findTable(bot: Bot, maxDistance: number): any | null {
  return bot.findBlock({ matching: (b: any) => b.name === 'crafting_table', maxDistance }) ?? null;
}

function hasTableItem(bot: Bot): boolean {
  return bot.inventory.items().some((i) => i.name === 'crafting_table');
}

function evaluate(bot: Bot, args: CraftArgs): Precondition & { choice?: Choice } {
  const def = bot.registry.itemsByName[args.item];
  if (!def) return { ok: false, cause: 'invalid_args', message: `There is no item called "${args.item}".` };
  const choice = chooseRecipe(bot, def.id, args.count);
  if (!choice) {
    return { ok: false, cause: 'invalid_args', message: `${args.item} has no crafting recipe; it is obtained another way (mined, smelted, dropped, traded).` };
  }
  if (choice.missing.length) {
    const list = choice.missing.map((m) => `${m.count} more ${m.name}`).join(', ');
    return { ok: false, cause: 'missing_item', message: `Crafting ${args.count} ${args.item} needs ${list}.`, fix: `get ${list}` };
  }
  if (choice.needsTable && !findTable(bot, WALK_TO_TABLE) && !hasTableItem(bot)) {
    return {
      ok: false,
      cause: 'missing_station',
      message: `${args.item} needs a crafting table, and there is none within ${WALK_TO_TABLE} blocks or in the inventory.`,
      fix: 'craft a crafting_table (4 planks) or go to one',
    };
  }
  return { ok: true, choice };
}

async function walkTo(ctx: SkillContext, block: any): Promise<boolean> {
  const bot: any = ctx.bot;
  if (!bot.pathfinder) return false;
  updatePathfinderMovements(ctx.bot);
  const watchdog = new ProgressWatchdog(8000, bot.entity.position.distanceTo(block.position));
  const goal = new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2);
  const done = bot.pathfinder.goto(goal).then(
    () => true,
    () => false
  );
  for (;;) {
    const finished = await Promise.race([done, new Promise<null>((r) => setTimeout(() => r(null), 250))]);
    if (finished !== null) return finished && bot.entity.position.distanceTo(block.position) <= REACH;
    if (ctx.signal.aborted || (watchdog.report(bot.entity.position.distanceTo(block.position)), watchdog.stuck)) {
      bot.pathfinder.stop();
      return false;
    }
  }
}

async function placeTable(ctx: SkillContext): Promise<any | null> {
  const bot = ctx.bot;
  const item = bot.inventory.items().find((i) => i.name === 'crafting_table');
  if (!item) return null;
  const spot = findSafePlacementSpot(bot);
  if (!spot) return null;
  await bot.equip(item, 'hand');
  try {
    await bot.placeBlock(spot.refBlock, spot.placeVector);
  } catch {
    // Mineflayer can time out waiting for the block update even when the placement worked; check the world.
  }
  await bot.waitForTicks(4);
  const placed = bot.blockAt(spot.placePos);
  return placed?.name === 'crafting_table' ? placed : null;
}

export const craftSkill: SkillDefinition<CraftArgs> = {
  name: 'craft',
  summary: 'craft {item, count}: make `count` more of one item from ingredients already held; uses or places a crafting table when the recipe needs one. Does not craft the ingredients.',
  args: Args,
  check(ctx, args) {
    const r = evaluate(ctx.bot, args);
    return r.ok ? { ok: true } : r;
  },
  async run(ctx, args): Promise<SkillOutcome> {
    const bot = ctx.bot;
    const evidence: string[] = [];
    const r = evaluate(bot, args);
    if (!r.ok) return { status: 'failed', cause: r.cause, message: r.message, fix: r.fix, evidence };
    const choice = r.choice!;
    const before = bot.inventory.items().filter((i) => i.name === args.item).reduce((a, i) => a + i.count, 0);
    let table: any = null;
    const placedBlocks: { x: number; y: number; z: number; block: string }[] = [];

    if (choice.needsTable) {
      table = findTable(bot, REACH);
      if (!table) {
        const seen = findTable(bot, WALK_TO_TABLE);
        if (seen && (await walkTo(ctx, seen))) table = seen;
      }
      if (!table && hasTableItem(bot)) {
        table = await placeTable(ctx);
        if (table) placedBlocks.push({ x: table.position.x, y: table.position.y, z: table.position.z, block: 'crafting_table' });
      }
      if (!table) {
        return { status: 'failed', cause: 'unreachable', message: `Could not reach or place a crafting table for ${args.item}.`, evidence };
      }
      evidence.push(`crafting table at ${table.position}`);
    }

    try {
      await craftReliably(bot, choice.recipe, choice.executions, table, ctx.signal);
    } catch (err) {
      const cause = err instanceof CraftError ? err.cause : 'unknown';
      if (err instanceof CraftError) evidence.push(...err.evidence);
      return {
        status: cause === 'interrupted' ? 'interrupted' : 'failed',
        cause,
        message: `Crafting ${args.item} failed: ${(err as Error).message}`,
        evidence,
        worldDelta: { placed: placedBlocks, broken: [] },
      };
    }

    const after = bot.inventory.items().filter((i) => i.name === args.item).reduce((a, i) => a + i.count, 0);
    evidence.push(`${args.item} ${before} -> ${after}`);
    const gained = after - before;
    const worldDelta = { placed: placedBlocks, broken: [] };
    if (gained >= args.count) {
      return { status: 'done', message: `Crafted ${gained} ${args.item}.`, evidence, worldDelta };
    }
    return {
      status: gained > 0 ? 'partial' : 'failed',
      cause: 'server_rejected',
      message: `Expected ${args.count} more ${args.item}, got ${gained}.`,
      evidence,
      worldDelta,
    };
  },
};
