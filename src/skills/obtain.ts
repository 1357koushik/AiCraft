import { z } from 'zod';
import type { Bot } from 'mineflayer';
import { FailureCause, runSkill, SkillContext, SkillDefinition, SkillOutcome, SkillResult } from './contract.js';
import { waysToGet } from '../brain/requirements.js';
import { toolPlanFor, blockRequiresTool, minimumTool } from '../knowledge/harvest.js';
import { craftSkill } from './craft.js';
import { mineSkill } from './mine.js';
import { chopTreeSkill } from './chop_tree.js';
import { useStationSkill } from './use_station.js';
import { exploreForSkill } from './explore_for.js';

/**
 * obtain: get `count` more of any item, by whatever route the game data offers: chop, craft, smelt or mine,
 * getting the ingredients, tools, fuel and stations along the way (ROADMAP.md Phase 3, CAPABILITIES.md 11).
 *
 * It is the old code planner rebuilt on the skill contract: every step it takes is an ordinary skill, so every
 * step verifies itself. It returns to the LLM at the first real choice instead of guessing: an item that only
 * comes from mobs, chests or trading, or a step that failed in a way it cannot fix.
 */

const Args = z.object({
  item: z.string().min(1).transform((s) => s.replace(/^minecraft:/, '')),
  count: z.number().int().min(1).max(512).default(1),
});
type ObtainArgs = z.infer<typeof Args>;

const MAX_DEPTH = 12;
const MAX_STEPS = 40;
const FUELS = ['coal', 'charcoal', 'coal_block', 'blaze_rod', 'lava_bucket', 'dried_kelp_block'];
const WOOD_FUEL = /_(log|wood|planks|stem|hyphae)$|^stick$/;

interface Job {
  ctx: SkillContext;
  steps: number;
  evidence: string[];
  /** Items being obtained higher up the chain, to stop cycles (planks -> logs -> ... -> planks). */
  stack: string[];
}

class ObtainStop extends Error {
  constructor(message: string, readonly cause: FailureCause, readonly fix?: string) {
    super(message);
  }
}

function held(bot: Bot, names: string[]): number {
  let n = 0;
  for (const it of bot.inventory.items()) if (names.includes(it.name)) n += it.count;
  return n;
}

const isLog = (name: string) => /_(log|wood|stem|hyphae)$/.test(name) && !name.startsWith('stripped_');

async function step(job: Job, label: string, def: SkillDefinition, args: Record<string, unknown>): Promise<SkillResult> {
  if (++job.steps > MAX_STEPS) throw new ObtainStop(`Gave up after ${MAX_STEPS} sub-steps.`, 'no_progress', 'split the task or choose a different route');
  if (job.ctx.signal.aborted) throw new ObtainStop('Cancelled.', 'interrupted');
  job.ctx.log(`[obtain] ${'  '.repeat(job.stack.length)}${label}: ${def.name} ${JSON.stringify(args)}`);
  const r = await runSkill(def, job.ctx, args);
  job.evidence.push(`${def.name} ${JSON.stringify(args)} -> ${r.status}${r.cause ? ` (${r.cause})` : ''}`);
  if (r.status === 'interrupted') throw new ObtainStop('Cancelled.', 'interrupted');
  return r;
}

/** Picks which member of an ingredient's options to go for: one held, else one craftable from what is held. */
function chooseOption(bot: Bot, options: string[]): string {
  let best = options[0];
  let bestHeld = -1;
  for (const o of options) {
    const h = held(bot, [o]);
    if (h > bestHeld) {
      best = o;
      bestHeld = h;
    }
  }
  if (bestHeld > 0) return best;
  // Planks and similar: prefer the variant whose source (its log) is held.
  for (const o of options) {
    const craft = waysToGet(o).find((w) => w.kind === 'craft');
    if (craft && craft.kind === 'craft' && craft.inputs.every((i) => held(bot, i.options ?? [i.item]) >= i.count)) return o;
  }
  // Nothing held: prefer the variant whose source is nearby (a birch forest means birch planks), nearest first.
  let nearest: { option: string; d: number } | null = null;
  for (const o of options) {
    const craft = waysToGet(o).find((w) => w.kind === 'craft');
    const sources = craft && craft.kind === 'craft' ? craft.inputs.flatMap((i) => i.options ?? [i.item]) : [o];
    const block = bot.findBlock({ matching: (b: any) => sources.includes(b.name), maxDistance: 48 });
    if (block) {
      const d = block.position.distanceTo(bot.entity.position);
      if (!nearest || d < nearest.d) nearest = { option: o, d };
    }
  }
  return nearest?.option ?? options[0];
}

async function acquire(job: Job, item: string, count: number, alternatives?: string[]): Promise<void> {
  const bot = job.ctx.bot;
  const names = alternatives?.length ? alternatives : [item];
  const target = held(bot, names) + count;
  if (job.stack.includes(item)) throw new ObtainStop(`${item} needs itself further down the chain.`, 'invalid_args');
  if (job.stack.length >= MAX_DEPTH) throw new ObtainStop(`The chain for ${job.stack[0]} is deeper than ${MAX_DEPTH} steps.`, 'no_progress', 'obtain an intermediate item first');
  job.stack.push(item);
  try {
    for (let rounds = 0; held(bot, names) < target; rounds++) {
      if (rounds > 6) throw new ObtainStop(`Could not get ${count} ${item} after several rounds.`, 'no_progress');
      const need = target - held(bot, names);

      // Logs come from trees.
      if (names.every(isLog) || isLog(item)) {
        const chopArgs = names.length > 1 ? { count: need } : { count: need, log: item };
        let r = await step(job, `${need} ${item}`, chopTreeSkill, chopArgs);
        if (r.status === 'failed' && r.cause === 'not_found_nearby') {
          // No tree within reach: go looking for one, then chop again.
          const found = await step(job, `find ${item}`, exploreForSkill, { target: names.length > 1 ? 'logs' : item });
          if (found.status === 'failed') throw new ObtainStop(`No trees within reach and the search failed: ${found.message}`, found.cause ?? 'not_found_nearby', found.fix);
          r = await step(job, `${need} ${item}`, chopTreeSkill, chopArgs);
        }
        if (r.status === 'failed') throw new ObtainStop(`Could not chop logs: ${r.message}`, r.cause ?? 'unknown', r.fix);
        continue;
      }

      const target1 = alternatives?.length ? chooseOption(bot, alternatives) : item;
      const ways = waysToGet(target1);
      const craft = ways.find((w) => w.kind === 'craft' && !w.inputs.some((i) => names.includes(i.item)));
      const smelt = ways.find((w) => w.kind === 'smelt' && (w.station === 'furnace' || w.station === 'smoker' || w.station === 'blast_furnace'));
      const mine = ways.find((w) => w.kind === 'mine');
      const first = ways[0];

      if (first?.kind === 'mine' || (!craft && !smelt && mine)) {
        await viaMining(job, target1, need, mine as Extract<typeof first, { kind: 'mine' }>);
      } else if (craft && (first?.kind === 'craft' || !smelt)) {
        await viaCrafting(job, target1, need, craft as any);
      } else if (smelt) {
        await viaSmelting(job, target1, need, smelt as any);
      } else if (mine) {
        await viaMining(job, target1, need, mine as any);
      } else {
        const drop = ways.find((w) => w.kind === 'drop');
        const loot = ways.find((w) => w.kind === 'loot');
        const where = drop && drop.kind === 'drop' ? `it drops from ${drop.entities.slice(0, 4).join(', ')}` : loot && loot.kind === 'loot' ? `it is found in ${loot.tables.slice(0, 3).join(', ')}` : 'there is no known way to get it';
        throw new ObtainStop(`${target1} cannot be crafted, smelted or mined: ${where}.`, 'not_found_nearby', drop && drop.kind === 'drop' ? `hunt ${drop.entities[0]}` : undefined);
      }
    }
  } finally {
    job.stack.pop();
  }
}

async function viaCrafting(job: Job, item: string, need: number, way: { station: string; makes: number; inputs: { item: string; count: number; options?: string[] }[] }): Promise<void> {
  const bot = job.ctx.bot;
  const times = Math.ceil(need / way.makes);
  // The station first: making a crafting table uses planks the recipe itself may need.
  if (way.station === 'crafting_table') {
    const tableNear = Boolean(bot.findBlock({ matching: (b: any) => b.name === 'crafting_table', maxDistance: 32 }));
    if (!tableNear && held(bot, ['crafting_table']) === 0) await acquire(job, 'crafting_table', 1);
  }
  // Getting one ingredient can use up another (sticks are made from the planks the recipe also needs),
  // so check them all again until every one is held at once.
  for (let pass = 0; ; pass++) {
    const short = way.inputs.filter((input) => held(bot, input.options ?? [input.item]) < input.count * times);
    if (!short.length) break;
    if (pass >= 4) throw new ObtainStop(`Could not hold all the ingredients for ${item} at once.`, 'no_progress');
    for (const input of short) {
      const options = input.options ?? [input.item];
      const want = input.count * times - held(bot, options);
      if (want > 0) await acquire(job, options.length > 1 ? chooseOption(bot, options) : input.item, want, options.length > 1 ? options : undefined);
    }
  }
  const r = await step(job, `${need} ${item}`, craftSkill, { item, count: need });
  if (r.status === 'failed') throw new ObtainStop(`Crafting ${item} failed: ${r.message}`, r.cause ?? 'unknown', r.fix);
}

async function viaSmelting(job: Job, item: string, need: number, way: { station: string; input: string; options?: string[] }): Promise<void> {
  const bot = job.ctx.bot;
  const inputs = way.options ?? [way.input];
  const have = held(bot, inputs);
  if (have < need) await acquire(job, inputs.length > 1 ? chooseOption(bot, inputs) : way.input, need - have, inputs.length > 1 ? inputs : undefined);
  // Fuel: coal-like first, then wood. 1 coal smelts 8; 1 plank smelts 1.5.
  const coal = held(bot, FUELS);
  const wood = bot.inventory.items().filter((i) => WOOD_FUEL.test(i.name)).reduce((a, i) => a + i.count, 0);
  if (coal * 8 + wood * 1.5 < need) {
    const coalNeeded = Math.ceil((need - wood * 1.5) / 8);
    try {
      await acquire(job, 'coal', Math.max(1, coalNeeded));
    } catch (err) {
      if (!(err instanceof ObtainStop) || err.cause === 'interrupted') throw err;
      await acquire(job, 'oak_log', Math.ceil(need / 6)); // a log burns for 1.5 items as a log, 6 as 4 planks; logs are simplest
    }
  }
  const station = way.station;
  const stationNear = Boolean(bot.findBlock({ matching: (b: any) => b.name === station, maxDistance: 32 }));
  if (!stationNear && held(bot, [station]) === 0) await acquire(job, station, 1);
  const input = held(bot, [way.input]) >= need ? way.input : inputs.find((i) => held(bot, [i]) > 0) ?? way.input;
  const r = await step(job, `${need} ${item}`, useStationSkill, { station, input, count: need });
  if (r.status === 'failed') throw new ObtainStop(`Smelting ${input} failed: ${r.message}`, r.cause ?? 'unknown', r.fix);
}

async function viaMining(job: Job, item: string, need: number, way: { blocks: string[] }): Promise<void> {
  const bot = job.ctx.bot;
  // Prefer a block kind that is actually nearby; ores come in stone and deepslate forms.
  const nearBlock = () => way.blocks.find((b) => bot.findBlock({ matching: (x: any) => x.name === b, maxDistance: 48 }));
  let near = nearBlock();
  if (!near) {
    // Nothing within 48 blocks: go looking (the places memory first, then outward), then mine what was found.
    const found = await step(job, `find ${way.blocks[0]}`, exploreForSkill, { target: way.blocks[0] });
    if (found.status === 'failed') throw new ObtainStop(`No ${way.blocks[0]} within reach and the search failed: ${found.message}`, found.cause ?? 'not_found_nearby', found.fix);
    near = nearBlock();
  }
  near ??= way.blocks[0];
  const plan = toolPlanFor(near, blockRequiresTool(near));
  if (plan.requiresTool && !plan.workingTools.some((t) => held(bot, [t]) > 0)) {
    const tool = minimumTool(plan);
    if (!tool) throw new ObtainStop(`No tool can harvest ${near}.`, 'missing_tool');
    await acquire(job, tool, 1);
  }
  const r = await step(job, `${need} ${item}`, mineSkill, { block: near, count: need, maxDistance: 64 });
  if (r.status === 'failed') throw new ObtainStop(`Mining ${near} failed: ${r.message}`, r.cause ?? 'unknown', r.fix);
}

export const obtainSkill: SkillDefinition<ObtainArgs> = {
  name: 'obtain',
  summary:
    'obtain {item, count}: get `count` more of any item by chopping, crafting, smelting or mining, fetching the ingredients, tools, fuel and stations along the way. Stops and reports when the item only comes from mobs, chests or trading, or a step fails.',
  args: Args,
  check(ctx, a) {
    if (!(ctx.bot.registry as any).itemsByName[a.item]) return { ok: false, cause: 'invalid_args', message: `There is no item called "${a.item}".` };
    if (!waysToGet(a.item).length && !isLog(a.item)) return { ok: false, cause: 'invalid_args', message: `${a.item} cannot be obtained in survival.` };
    return { ok: true };
  },
  async run(ctx, a): Promise<SkillOutcome> {
    const job: Job = { ctx, steps: 0, evidence: [], stack: [] };
    const before = held(ctx.bot, [a.item]);
    try {
      await acquire(job, a.item, a.count);
    } catch (err) {
      const got = held(ctx.bot, [a.item]) - before;
      if (err instanceof ObtainStop) {
        return { status: got > 0 ? 'partial' : err.cause === 'interrupted' ? 'interrupted' : 'failed', cause: err.cause, message: `${err.message} (got ${got} of ${a.count} ${a.item})`, fix: err.fix, evidence: job.evidence };
      }
      throw err;
    }
    const got = held(ctx.bot, [a.item]) - before;
    return { status: 'done', message: `Obtained ${got} ${a.item} in ${job.steps} steps.`, evidence: job.evidence };
  },
};
