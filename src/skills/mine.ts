import { z } from 'zod';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { getLootTables, resolveTag } from '../knowledge/vanilla.js';
import { withInventoryLock } from '../actions/reliable_craft.js';
import { Precondition, ProgressWatchdog, SkillContext, SkillDefinition, SkillOutcome } from './contract.js';
import { pickUpDrops } from './collect_drops.js';
import { DIG_REACH, FACE_OFFSETS, GoalReachBlock, canHold, countItems, eyeDistance, goTo, isLiquid, posKey, sleep, stopOnAbort, stopPathfinder, stripNs } from './world.js';

/**
 * mine: break `count` blocks of one kind with the best tool held, and pick up what drops.
 *
 * Tool choice and harvest tiers come from the game's own data: block/mineable/<tool> tags say which tool
 * type works, block/incorrect_for_<material>_tool tags say which materials are too weak, the block's loot
 * table says what drops (ignoring silk touch), and minecraft-data's harvestTools says whether the block drops
 * nothing without a correct tool. Safety rules: never dig the block under the bot's own feet, never dig a block
 * that touches lava or water, never tunnel to reach a block (the pathfinder may not dig while walking).
 */

const Args = z.object({
  block: z.string().min(1).transform(stripNs),
  count: z.number().int().min(1).max(2304),
  maxDistance: z.number().int().min(1).max(128).default(48),
});
type MineArgs = z.infer<typeof Args>;

const TOOL_TYPES = ['pickaxe', 'axe', 'shovel', 'hoe'] as const;
type ToolType = (typeof TOOL_TYPES)[number];
/** Weakest first. The tag names use "wooden" and "gold"; the item names use "wooden" and "golden". */
const MATERIALS = [
  { item: 'wooden', tag: 'wooden' },
  { item: 'golden', tag: 'gold' },
  { item: 'stone', tag: 'stone' },
  { item: 'iron', tag: 'iron' },
  { item: 'diamond', tag: 'diamond' },
  { item: 'netherite', tag: 'netherite' },
] as const;
/** Order to suggest a tool in a "fix": by tier, skipping gold (same tier as wood but not a natural first tool). */
const SUGGEST_ORDER = ['wooden', 'stone', 'iron', 'diamond', 'netherite'];

export interface ToolPlan {
  /** Tool type that mines this block fastest, or null when the block has no tool tag (dirt-like by hand, e.g. glass). */
  type: ToolType | null;
  /** True when the block drops nothing without a correct tool and tier. */
  requiresTool: boolean;
  /** Item names that work, weakest tier first. Empty when requiresTool is false and any tool is fine. */
  workingTools: string[];
  /** Item names the block drops without silk touch. */
  drops: string[];
}

let tagSets: Map<string, Set<string>> | null = null;
function tagSet(tag: string): Set<string> {
  if (!tagSets) tagSets = new Map();
  let s = tagSets.get(tag);
  if (!s) {
    s = new Set(resolveTag('block', tag).map(stripNs));
    tagSets.set(tag, s);
  }
  return s;
}

/** Collects the item names a loot table can yield when mined without silk touch. */
export function lootDrops(blockName: string): string[] {
  const table: any = getLootTables()[`blocks/${blockName}`];
  const out = new Set<string>();
  const needsSilk = (conditions: any[] | undefined) => (conditions ?? []).some((c) => JSON.stringify(c).includes('silk_touch'));
  const walk = (entry: any, silk: boolean) => {
    const s = silk || needsSilk(entry.conditions);
    if (entry.type === 'minecraft:item' && entry.name && !s) out.add(stripNs(entry.name));
    for (const child of entry.children ?? []) walk(child, s);
  };
  for (const pool of table?.pools ?? []) {
    const poolSilk = needsSilk(pool.conditions);
    for (const entry of pool.entries ?? []) walk(entry, poolSilk);
  }
  return [...out];
}

export function planTool(bot: Bot, blockName: string): ToolPlan {
  const type = TOOL_TYPES.find((t) => tagSet(`mineable/${t}`).has(blockName)) ?? null;
  const reg = (bot.registry as any).blocksByName[blockName];
  const requiresTool = Boolean(reg?.harvestTools);
  const workingTools: string[] = [];
  if (type) {
    for (const m of MATERIALS) {
      if (!tagSet(`incorrect_for_${m.tag}_tool`).has(blockName)) workingTools.push(`${m.item}_${type}`);
    }
  }
  return { type, requiresTool, workingTools, drops: lootDrops(blockName) };
}

function minimumTool(plan: ToolPlan): string | null {
  for (const m of SUGGEST_ORDER) {
    const t = plan.workingTools.find((w) => w.startsWith(`${m}_`));
    if (t) return t;
  }
  return plan.workingTools[0] ?? null;
}

/** The held tool that breaks the block fastest among those allowed, or null to use the bare hand. */
function chooseTool(bot: Bot, plan: ToolPlan, block: any): any | null {
  let best: any = null;
  let bestTime = Infinity;
  const consider = (item: any | null) => {
    let t = Infinity;
    try {
      t = block.digTime(item ? item.type : null, false, false, false, [], {});
    } catch {
      return;
    }
    if (t < bestTime) {
      bestTime = t;
      best = item;
    }
  };
  if (!plan.requiresTool) consider(null);
  for (const it of bot.inventory.items()) {
    if (!/_(pickaxe|axe|shovel|hoe)$/.test(it.name)) continue;
    if (plan.requiresTool && !plan.workingTools.includes(it.name)) continue;
    consider(it);
  }
  return best;
}

function heldCanHarvest(bot: Bot, plan: ToolPlan): boolean {
  if (!plan.requiresTool) return true;
  return bot.inventory.items().some((i) => plan.workingTools.includes(i.name)) || plan.workingTools.includes(bot.heldItem?.name ?? '');
}

function evaluate(bot: Bot, args: MineArgs): Precondition & { plan?: ToolPlan } {
  const reg = (bot.registry as any).blocksByName[args.block];
  if (!reg) return { ok: false, cause: 'invalid_args', message: `There is no block called "${args.block}".` };
  const plan = planTool(bot, args.block);
  if (plan.drops.length === 0) {
    return {
      ok: false,
      cause: 'missing_tool',
      message: `${args.block} drops nothing when mined without silk touch, so mining it gives no items.`,
      fix: 'use a tool with silk touch, or choose another block',
    };
  }
  if (!heldCanHarvest(bot, plan)) {
    const min = minimumTool(plan);
    const unreachableByTools = plan.workingTools.length === 0;
    return {
      ok: false,
      cause: 'missing_tool',
      message: unreachableByTools
        ? `${args.block} cannot be harvested with any tool in the game data.`
        : `${args.block} drops nothing unless mined with ${min} or better, and none is held.`,
      fix: min ? `get a ${min} (or better)` : undefined,
    };
  }
  const found = bot.findBlocks({ matching: [reg.id], maxDistance: args.maxDistance, count: 1 });
  if (!found.length) return { ok: false, cause: 'not_found_nearby', message: `No ${args.block} within ${args.maxDistance} blocks in the loaded world.`, fix: 'explore to find some' };
  return { ok: true, plan };
}

type Verdict = { ok: true; exposed: boolean } | { ok: false; why: 'hazard' | 'unknown' };

/** Looks at the six neighbours: refuses liquid contact, notes whether the block touches air. */
function inspectTarget(bot: Bot, pos: Vec3): Verdict {
  let exposed = false;
  for (const off of FACE_OFFSETS) {
    const n = bot.blockAt(pos.plus(off));
    if (!n) return { ok: false, why: 'unknown' };
    if (isLiquid(n.name) || n.name === 'fire' || n.name === 'magma_block') return { ok: false, why: 'hazard' };
    if (n.boundingBox !== 'block') exposed = true;
  }
  // Something falling onto us is harmless, but a liquid two above a block we open to the top could flood the hole.
  return { ok: true, exposed };
}

function standingOn(bot: Bot, pos: Vec3): boolean {
  const feet = bot.entity.position.floored();
  return feet.x === pos.x && feet.z === pos.z && feet.y > pos.y;
}

function inReach(bot: Bot, pos: Vec3): boolean {
  return eyeDistance(bot, pos) <= DIG_REACH && !standingOn(bot, pos);
}

export const mineSkill: SkillDefinition<MineArgs> = {
  name: 'mine',
  summary: 'mine {block, count, maxDistance?=48}: break `count` blocks of one kind (e.g. stone, iron_ore) with the best tool held and pick up the drops. Refuses with missing_tool when the block needs a better tool.',
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
    const plan = r.plan!;
    const reg = (bot.registry as any).blocksByName[args.block];
    const dropSet = new Set(plan.drops);
    const dropCount = () => countItems(bot, (n) => dropSet.has(n));
    const dropsBefore = dropCount();
    evidence.push(`${args.block} drops ${plan.drops.join(' or ')} (game loot table, no silk touch)`);

    const excluded = new Set<string>();
    const broken: { x: number; y: number; z: number; block: string }[] = [];
    let mined = 0;
    let hazardSkipped = 0;
    let unreachable = 0;
    let digFailures = 0;
    let everFound = false;
    let full = false;
    const watchdog = new ProgressWatchdog(30000, 0, false);
    const dispose = stopOnAbort(ctx);

    try {
      while (mined < args.count) {
        if (ctx.signal.aborted) break;
        if (watchdog.stuck) break;
        if (!plan.drops.some((d) => canHold(bot, d))) {
          full = true;
          break;
        }

        // Pick the next target: nearest first, blocks open to the air before buried ones.
        const positions: Vec3[] = bot.findBlocks({ matching: [reg.id], maxDistance: args.maxDistance, count: 64 });
        const me = bot.entity.position;
        const scored: { pos: Vec3; score: number }[] = [];
        for (const pos of positions) {
          if (excluded.has(posKey(pos))) continue;
          everFound = true;
          const v = inspectTarget(bot, pos);
          if (!v.ok) {
            if (v.why === 'hazard') hazardSkipped++;
            excluded.add(posKey(pos));
            continue;
          }
          scored.push({ pos, score: pos.offset(0.5, 0.5, 0.5).distanceTo(me) + (v.exposed ? 0 : 8) });
        }
        scored.sort((a, b) => a.score - b.score);
        const target = scored[0]?.pos;
        if (!target) break;
        const key = posKey(target);

        // Get within reach without standing on it.
        if (!inReach(bot, target)) {
          const res = await goTo(ctx, new GoalReachBlock(target), () => eyeDistance(bot, target), 8000, false);
          if (ctx.signal.aborted) break;
          if (!res.ok || !inReach(bot, target)) {
            unreachable++;
            excluded.add(key);
            evidence.push(`could not get within reach of ${args.block} at ${target} (${res.reason}${res.detail ? `: ${res.detail}` : ''})`);
            continue;
          }
        }

        // Re-read the block right before acting: it may have changed while we walked.
        const live = bot.blockAt(target);
        if (!live || live.name !== args.block) {
          excluded.add(key);
          continue;
        }
        const again = inspectTarget(bot, target);
        if (!again.ok) {
          hazardSkipped += again.why === 'hazard' ? 1 : 0;
          excluded.add(key);
          continue;
        }

        const tool = chooseTool(bot, plan, live);
        if (tool && bot.heldItem?.type !== tool.type) {
          try {
            await withInventoryLock(() => bot.equip(tool, 'hand'));
          } catch (err) {
            evidence.push(`equip ${tool.name} failed: ${(err as Error).message}`);
          }
        }
        if (ctx.signal.aborted) break;

        try {
          await bot.dig(live, true);
        } catch (err) {
          if (ctx.signal.aborted) break;
          digFailures++;
          evidence.push(`dig ${args.block} at ${target} failed: ${(err as Error).message}`);
          if (digFailures >= 3 * args.count + 3) break;
          excluded.add(key);
          continue;
        }
        await sleep(120);
        const after = bot.blockAt(target);
        if (after && after.name === args.block) {
          // The server put it back (protection, desync) or the break did not register.
          digFailures++;
          excluded.add(key);
          evidence.push(`${args.block} at ${target} still there after digging`);
          continue;
        }
        mined++;
        broken.push({ x: target.x, y: target.y, z: target.z, block: args.block });
        watchdog.report(mined);

        const got = await pickUpDrops(ctx, {
          radius: 5,
          around: target.offset(0.5, 0.5, 0.5),
          wanted: (n) => dropSet.has(n),
          windowMs: 4000,
        });
        if (got.stoppedBy === 'inventory_full') full = true;
      }
    } finally {
      dispose();
      stopPathfinder(bot);
    }

    const gained = dropCount() - dropsBefore;
    const worldDelta = { placed: [], broken };
    evidence.push(`tool: ${bot.heldItem?.name ?? 'bare hand'}`);
    evidence.push(`${[...dropSet].join('/')} ${dropsBefore} -> ${dropsBefore + gained}`);
    if (hazardSkipped) evidence.push(`skipped ${hazardSkipped} block(s) touching lava, water or fire`);

    if (ctx.signal.aborted) {
      return { status: 'interrupted', cause: 'interrupted', message: `mine was cancelled after breaking ${mined} ${args.block}.`, evidence, worldDelta };
    }
    if (mined >= args.count) {
      if (gained <= 0) {
        return {
          status: 'partial',
          cause: 'unreachable',
          message: `Broke ${mined} ${args.block} but no ${plan.drops.join('/')} reached the inventory; the drops are probably out of reach (fell into a pit or off a ledge).`,
          fix: 'walk to where the items lie (collect_drops) or dig down to them',
          evidence,
          worldDelta,
        };
      }
      return { status: 'done', message: `Mined ${mined} ${args.block}; ${plan.drops.join('/')} +${gained}.`, evidence, worldDelta };
    }

    let cause: SkillOutcome['cause'];
    let fix: string | undefined;
    if (full) {
      cause = 'inventory_full';
      fix = 'free inventory slots (drop or store items)';
    } else if (watchdog.stuck || digFailures) cause = 'no_progress';
    else if (hazardSkipped && !unreachable) {
      cause = 'too_dangerous';
      fix = `the remaining ${args.block} touches lava or water; find another ${args.block}`;
    } else if (unreachable) {
      cause = 'unreachable';
      fix = `dig a tunnel or stairs toward the ${args.block}, or go to where it is open`;
    } else if (!everFound) cause = 'not_found_nearby';
    else cause = 'not_found_nearby';
    return {
      status: mined > 0 ? 'partial' : 'failed',
      cause,
      message: `Mined ${mined}/${args.count} ${args.block} (${cause}).`,
      fix,
      evidence,
      worldDelta,
    };
  },
};
