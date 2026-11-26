import { z } from 'zod';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { goals } from 'mineflayer-pathfinder';
import { resolveTag } from '../knowledge/vanilla.js';
import { withInventoryLock } from '../actions/reliable_craft.js';
import { SAFE_SCAFFOLD_ITEMS } from '../actions/techniques.js';
import { Precondition, ProgressWatchdog, SkillContext, SkillDefinition, SkillOutcome } from './contract.js';
import { pickUpDrops } from './collect_drops.js';
import { DIG_REACH, GoalReachBlock, canHold, countItems, eyeDistance, goTo, posKey, sleep, stopOnAbort, stopPathfinder, stripNs } from './world.js';

/**
 * chop_tree: get `count` more logs by felling trees.
 *
 * A tree is a connected cluster of log blocks (26-neighbourhood) whose lowest log stands on solid ground, which
 * keeps floating leftovers and player-made pillars out of the search. The nearest tree is walked to, its logs are cut
 * lowest first with the best axe held (bare hand otherwise), and the drops are collected. A log beyond arm's reach
 * is cut from a short pillar built in the trunk's own column (scaffold blocks held, or dirt dug on the spot), and the
 * pillar is dismantled afterwards. Trees that yield nothing are set aside and the next one is tried.
 */

const Args = z.object({
  count: z.number().int().min(1).max(2304),
  log: z.string().min(1).transform(stripNs).optional(),
});
type ChopArgs = z.infer<typeof Args>;

const LOG_NAMES: Set<string> = new Set(resolveTag('block', 'logs').map(stripNs));
const SEARCH_RADIUS = 64;
const MAX_PILLAR = 8;

function allowedFor(args: ChopArgs): (name: string) => boolean {
  return args.log ? (n) => n === args.log : (n) => LOG_NAMES.has(n);
}

interface Tree {
  logs: Vec3[]; // lowest first
  base: Vec3;
}

function connectedLogs(bot: Bot, start: Vec3, allowed: (n: string) => boolean, limit = 80): Vec3[] {
  const seen = new Set<string>([posKey(start)]);
  const queue: Vec3[] = [start.clone()];
  const out: Vec3[] = [];
  while (queue.length && out.length < limit) {
    const cur = queue.shift()!;
    out.push(cur);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          if (!dx && !dy && !dz) continue;
          const p = cur.offset(dx, dy, dz);
          const k = posKey(p);
          if (seen.has(k)) continue;
          seen.add(k);
          const b = bot.blockAt(p);
          if (b && allowed(b.name)) queue.push(p);
        }
  }
  return out;
}

function findTree(bot: Bot, allowed: (n: string) => boolean, failed: Set<string>): { tree: Tree | null; sawLogs: boolean } {
  const ids = [...LOG_NAMES].map((n) => (bot.registry as any).blocksByName[n]?.id).filter((x) => x !== undefined);
  const positions: Vec3[] = bot.findBlocks({ matching: ids, maxDistance: SEARCH_RADIUS, count: 256 }).filter((p) => {
    const b = bot.blockAt(p);
    return b && allowed(b.name);
  });
  const me = bot.entity.position;
  positions.sort((a, b) => a.distanceTo(me) - b.distanceTo(me));
  const seen = new Set<string>();
  let best: { tree: Tree; score: number } | null = null;
  let examined = 0;
  for (const p of positions) {
    if (seen.has(posKey(p))) continue;
    if (examined >= 10) break;
    const logs = connectedLogs(bot, p, allowed);
    for (const l of logs) seen.add(posKey(l));
    examined++;
    logs.sort((a, b) => a.y - b.y || a.distanceTo(me) - b.distanceTo(me));
    const lowest = logs[0];
    const bases = logs.filter((l) => l.y === lowest.y);
    bases.sort((a, b) => a.distanceTo(me) - b.distanceTo(me));
    const base = bases[0];
    const below = bot.blockAt(base.offset(0, -1, 0));
    if (!below || below.boundingBox !== 'block' || allowed(below.name)) continue;
    if (failed.has(posKey(base))) continue;
    const score = Math.hypot(base.x - me.x, base.z - me.z) + Math.abs(base.y - me.y) * 2.5;
    if (!best || score < best.score) best = { tree: { logs, base }, score };
  }
  return { tree: best?.tree ?? null, sawLogs: positions.length > 0 };
}

function inReach(bot: Bot, pos: Vec3): boolean {
  const feet = bot.entity.position.floored();
  if (feet.x === pos.x && feet.z === pos.z && feet.y >= pos.y) return false;
  return eyeDistance(bot, pos) <= DIG_REACH;
}

function bestAxe(bot: Bot, block: any): any | null {
  let best: any = null;
  let bestTime = Infinity;
  try {
    bestTime = block.digTime(null, false, false, false, [], {});
  } catch {
    // keep Infinity
  }
  for (const it of bot.inventory.items()) {
    if (!it.name.endsWith('_axe')) continue;
    try {
      const t = block.digTime(it.type, false, false, false, [], {});
      if (t < bestTime) {
        bestTime = t;
        best = it;
      }
    } catch {
      // ignore
    }
  }
  return best;
}

function scaffoldItem(bot: Bot): any | null {
  const rank = (n: string) => (n === 'dirt' || n === 'coarse_dirt' ? 0 : n === 'cobblestone' || n === 'cobbled_deepslate' ? 1 : n.endsWith('_planks') ? 3 : 2);
  const items = bot.inventory.items().filter((i) => SAFE_SCAFFOLD_ITEMS.has(i.name));
  items.sort((a, b) => rank(a.name) - rank(b.name));
  return items[0] ?? null;
}

async function digLog(ctx: SkillContext, pos: Vec3, allowed: (n: string) => boolean): Promise<boolean> {
  const bot = ctx.bot;
  for (let attempt = 0; attempt < 2; attempt++) {
    const live = bot.blockAt(pos);
    if (!live || !allowed(live.name)) return true;
    const axe = bestAxe(bot, live);
    if (axe && bot.heldItem?.type !== axe.type) {
      try {
        await withInventoryLock(() => bot.equip(axe, 'hand'));
      } catch {
        // dig by hand rather than fail
      }
    }
    if (ctx.signal.aborted) return false;
    try {
      await bot.dig(live, true);
    } catch {
      if (ctx.signal.aborted) return false;
    }
    await sleep(80);
    const after = bot.blockAt(pos);
    if (!after || !allowed(after.name)) return true;
  }
  return false;
}

let pillarWhy = '';
/** Jumps and places one scaffold block under the feet. Returns the position of the placed block. */
async function pillarOnce(ctx: SkillContext): Promise<Vec3 | null> {
  const bot = ctx.bot;
  const item = scaffoldItem(bot);
  if (!item) {
    pillarWhy = 'no scaffold item';
    return null;
  }
  const startY = bot.entity.position.y;
  const groundPos = bot.entity.position.floored().offset(0, -1, 0);
  const ground = bot.blockAt(groundPos);
  if (!ground || ground.boundingBox !== 'block') {
    pillarWhy = `no solid ground under feet (${ground?.name})`;
    return null;
  }
  const head = bot.blockAt(bot.entity.position.floored().offset(0, 2, 0));
  if (head && head.boundingBox === 'block') {
    pillarWhy = `blocked overhead (${head.name})`;
    return null;
  }
  const target = groundPos.offset(0, 1, 0);
  try {
    await withInventoryLock(() => bot.equip(item, 'hand'));
    await bot.look(bot.entity.yaw, -Math.PI / 2, true);
    bot.setControlState('jump', true);
    let up = false;
    for (let t = 0; t < 20 && !ctx.signal.aborted; t++) {
      await sleep(30);
      if (bot.entity.position.y - startY > 1.05) {
        up = true;
        break;
      }
    }
    if (!up || ctx.signal.aborted) {
      pillarWhy = 'jump did not rise';
      return null;
    }
    try {
      await bot.placeBlock(ground, new Vec3(0, 1, 0));
    } catch {
      // Mineflayer can time out even when the block went down; the world check below decides.
    }
  } finally {
    bot.setControlState('jump', false);
  }
  await sleep(250);
  const placed = bot.blockAt(target);
  if (!placed || placed.boundingBox !== 'block') {
    pillarWhy = `block not placed at ${target}`;
    return null;
  }
  if (bot.entity.position.y - startY < 0.85) {
    pillarWhy = 'no height gained after placing';
    return null;
  }
  return target;
}

/** Digs the scaffold blocks this skill placed, top first, standing on them, then collects them again. */
async function dismantle(ctx: SkillContext, placed: Vec3[]): Promise<void> {
  const bot = ctx.bot;
  while (placed.length && !ctx.signal.aborted) {
    const top = placed.pop()!;
    const b = bot.blockAt(top);
    if (!b || b.boundingBox !== 'block') continue;
    if (eyeDistance(bot, top) > DIG_REACH) continue;
    try {
      await bot.dig(b, true);
    } catch {
      return;
    }
    await sleep(250);
  }
}

/** Digs up to `n` dirt-like blocks nearby to use as scaffold. */
async function gatherScaffold(ctx: SkillContext, n: number, avoid: Vec3): Promise<number> {
  const bot = ctx.bot;
  const names = ['dirt', 'grass_block', 'coarse_dirt'];
  const ids = names.map((x) => (bot.registry as any).blocksByName[x]?.id).filter((x) => x !== undefined);
  let got = 0;
  const tried = new Set<string>();
  for (let i = 0; i < n + 4 && got < n && !ctx.signal.aborted; i++) {
    const cands: Vec3[] = bot.findBlocks({ matching: ids, maxDistance: 10, count: 32 }).filter((p: Vec3) => {
      if (tried.has(posKey(p))) return false;
      if (Math.abs(p.x - avoid.x) <= 1 && Math.abs(p.z - avoid.z) <= 1) return false; // keep the trunk's footing
      const up = bot.blockAt(p.offset(0, 1, 0));
      if (!up || up.boundingBox === 'block') return false;
      for (const o of [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(0, 1, 0)]) {
        const nb = bot.blockAt(p.plus(o));
        if (!nb || nb.name === 'water' || nb.name === 'lava') return false;
      }
      const feet = bot.entity.position.floored();
      return !(feet.x === p.x && feet.z === p.z);
    });
    cands.sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position));
    const p = cands[0];
    if (!p) break;
    tried.add(posKey(p));
    if (!inReach(bot, p)) {
      const r = await goTo(ctx, new GoalReachBlock(p, 3), () => eyeDistance(bot, p), 6000, false);
      if (!r.ok) continue;
    }
    const live = bot.blockAt(p);
    if (!live) continue;
    const before = countItems(bot, (x) => SAFE_SCAFFOLD_ITEMS.has(x));
    try {
      await bot.dig(live, true);
    } catch {
      continue;
    }
    await pickUpDrops(ctx, { radius: 4, around: p.offset(0.5, 0.5, 0.5), wanted: (x) => SAFE_SCAFFOLD_ITEMS.has(x), windowMs: 3000 });
    if (countItems(bot, (x) => SAFE_SCAFFOLD_ITEMS.has(x)) > before) got++;
  }
  return got;
}

interface TreeResult {
  cut: number;
  reachedTree: boolean;
  evidence: string[];
}

async function fellTree(ctx: SkillContext, tree: Tree, needed: number, allowed: (n: string) => boolean): Promise<TreeResult> {
  const bot = ctx.bot;
  const evidence: string[] = [];
  const near = await goTo(ctx, new GoalReachBlock(tree.base, 2.6), () => eyeDistance(bot, tree.base), 8000, true);
  if (!near.ok) {
    evidence.push(`could not reach tree at ${tree.base} (${near.reason}${near.detail ? `: ${near.detail}` : ''})`);
    return { cut: 0, reachedTree: false, evidence };
  }
  let cut = 0;
  const skipped = new Set<string>();
  const placed: Vec3[] = [];
  const remaining = () => tree.logs.filter((p) => !skipped.has(posKey(p)) && allowed(bot.blockAt(p)?.name ?? ''));

  try {
    while (cut < needed && !ctx.signal.aborted) {
      const left = remaining();
      if (!left.length) break;
      left.sort((a, b) => a.y - b.y || a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position));
      let next = left.find((p) => inReach(bot, p));
      if (!next) {
        // Walk first; pillar only if walking cannot get an arm's length from the lowest remaining log.
        const target = left[0];
        const r = await goTo(ctx, new GoalReachBlock(target, DIG_REACH - 0.6), () => eyeDistance(bot, target), 6000, true);
        if (ctx.signal.aborted) break;
        if (r.ok && inReach(bot, target)) next = target;
        else {
          const trunk = new Vec3(tree.base.x, 0, tree.base.z);
          if (placed.length >= MAX_PILLAR) {
            for (const p of left) skipped.add(posKey(p));
            break;
          }
          // Stand in the trunk's column (cut cell) and build upward.
          const baseCell = bot.blockAt(tree.base);
          if (baseCell && allowed(baseCell.name)) {
            if (!(await digLog(ctx, tree.base, allowed))) {
              for (const p of left) skipped.add(posKey(p));
              break;
            }
          }
          const above = bot.blockAt(tree.base.offset(0, 1, 0));
          if (above && allowed(above.name)) await digLog(ctx, tree.base.offset(0, 1, 0), allowed);
          const feet = bot.entity.position.floored();
          if (placed.length === 0 && !(feet.x === tree.base.x && feet.z === tree.base.z)) {
            const go = await goTo(ctx, new goals.GoalBlock(tree.base.x, tree.base.y, tree.base.z), () => bot.entity.position.distanceTo(tree.base.offset(0.5, 0, 0.5)), 6000, true);
            if (!go.ok) {
              evidence.push(`could not step into the trunk column at ${tree.base} (${go.reason})`);
              for (const p of left) skipped.add(posKey(p));
              break;
            }
          }
          if (!scaffoldItem(bot)) {
            const need = Math.min(MAX_PILLAR, Math.max(2, Math.ceil(left[left.length - 1].y - tree.base.y) - 3));
            const got = await gatherScaffold(ctx, need, trunk);
            evidence.push(`gathered ${got} dirt for pillaring`);
            const back = await goTo(ctx, new goals.GoalBlock(tree.base.x, tree.base.y, tree.base.z), () => bot.entity.position.distanceTo(tree.base.offset(0.5, 0, 0.5)), 6000, true);
            if (!back.ok) {
              for (const p of left) skipped.add(posKey(p));
              break;
            }
          }
          // Clear whatever is overhead in the column, then jump and place.
          const over = bot.blockAt(bot.entity.position.floored().offset(0, 2, 0));
          if (over && over.boundingBox === 'block' && (allowed(over.name) || over.name.endsWith('_leaves'))) await digLog(ctx, over.position, (n) => allowed(n) || n.endsWith('_leaves'));
          const p = await pillarOnce(ctx);
          if (!p) {
            evidence.push(`pillar step failed: ${pillarWhy}`);
            for (const q of left) skipped.add(posKey(q));
            break;
          }
          placed.push(p);
          continue;
        }
      }
      if (!next) break;
      if (await digLog(ctx, next, allowed)) {
        cut++;
      } else {
        skipped.add(posKey(next));
      }
    }
  } finally {
    if (placed.length) {
      const height = placed.length;
      await dismantle(ctx, placed);
      await pickUpDrops(ctx, { radius: 5, around: tree.base.offset(0.5, 0.5, 0.5), wanted: (x) => SAFE_SCAFFOLD_ITEMS.has(x), windowMs: 3000 });
      evidence.push(`pillared ${height} high and took the pillar down`);
    }
  }
  return { cut, reachedTree: true, evidence };
}

function canTakeLog(bot: Bot, args: ChopArgs): boolean {
  if (bot.inventory.emptySlotCount() > 0) return true;
  const match = allowedFor(args);
  return bot.inventory.items().some((i) => match(i.name) && canHold(bot, i.name));
}

export const chopTreeSkill: SkillDefinition<ChopArgs> = {
  name: 'chop_tree',
  summary: 'chop_tree {count, log?}: fell the nearest reachable trees until `count` more logs are held (log like "oak_log" restricts the kind). Uses an axe if held, pillars up for high logs, picks up the drops.',
  args: Args,
  check(ctx, args): Precondition {
    if (args.log && !LOG_NAMES.has(args.log)) return { ok: false, cause: 'invalid_args', message: `"${args.log}" is not a log block.` };
    if (!canTakeLog(ctx.bot, args)) return { ok: false, cause: 'inventory_full', message: 'No inventory space for logs.', fix: 'free inventory slots' };
    const { tree, sawLogs } = findTree(ctx.bot, allowedFor(args), new Set());
    if (!sawLogs) return { ok: false, cause: 'not_found_nearby', message: `No ${args.log ?? 'log'} within ${SEARCH_RADIUS} blocks in the loaded world.`, fix: 'explore to find trees' };
    if (!tree) return { ok: false, cause: 'unreachable', message: 'Logs are nearby but none belongs to a tree standing on solid ground.' };
    return { ok: true };
  },
  async run(ctx, args): Promise<SkillOutcome> {
    const bot = ctx.bot;
    const allowed = allowedFor(args);
    const evidence: string[] = [];
    const held = () => countItems(bot, allowed);
    const start = held();
    const target = start + args.count;
    const failed = new Set<string>();
    const watchdog = new ProgressWatchdog(60000, start, false);
    const dispose = stopOnAbort(ctx);
    let trees = 0;
    let anyLogs = false;
    let anyReached = false;
    let full = false;

    try {
      for (let guard = 0; guard < 40 && held() < target; guard++) {
        if (ctx.signal.aborted || watchdog.stuck) break;
        if (!canTakeLog(bot, args)) {
          full = true;
          break;
        }
        const { tree, sawLogs } = findTree(bot, allowed, failed);
        anyLogs = anyLogs || sawLogs;
        if (!tree) break;
        const before = held();
        const res = await fellTree(ctx, tree, target - before, allowed);
        evidence.push(...res.evidence);
        anyReached = anyReached || res.reachedTree;
        trees++;
        const got = await pickUpDrops(ctx, { radius: 9, around: tree.base.offset(0.5, 0.5, 0.5), wanted: allowed, windowMs: 6000 });
        if (got.stoppedBy === 'inventory_full') full = true;
        if (got.left.length) evidence.push(`left on the ground: ${got.left.map((d) => `${d.name} at ${d.pos.floored()}`).join(', ')} (${got.stoppedBy})`);
        const gain = held() - before;
        evidence.push(`tree ${trees} at ${tree.base}: cut ${res.cut}, held +${gain}`);
        if (gain > 0) watchdog.report(held());
        else failed.add(posKey(tree.base));
        if (full) break;
      }
    } finally {
      dispose();
      stopPathfinder(bot);
    }

    const gained = held() - start;
    evidence.push(`logs ${start} -> ${start + gained}`);
    if (ctx.signal.aborted) return { status: 'interrupted', cause: 'interrupted', message: `chop_tree was cancelled with ${gained} log(s) gained.`, evidence };
    if (gained >= args.count) return { status: 'done', message: `Chopped ${gained} log(s) from ${trees} tree(s).`, evidence };

    let cause: SkillOutcome['cause'];
    let fix: string | undefined;
    if (full) {
      cause = 'inventory_full';
      fix = 'free inventory slots';
    } else if (watchdog.stuck) cause = 'no_progress';
    else if (!anyLogs) {
      cause = 'not_found_nearby';
      fix = 'explore to find trees';
    } else if (!anyReached) cause = 'unreachable';
    else cause = gained > 0 ? 'not_found_nearby' : 'no_progress';
    return {
      status: gained > 0 ? 'partial' : 'failed',
      cause,
      message: `Chopped ${gained}/${args.count} log(s) (${cause}).`,
      fix,
      evidence,
    };
  },
};
