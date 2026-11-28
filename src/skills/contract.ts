import type { Bot } from 'mineflayer';
import { z } from 'zod';

/**
 * The skill contract (CAPABILITIES.md section 3, ROADMAP.md sections 3 and 4).
 *
 * A skill carries out one step the LLM chose. It must:
 *  1. say before starting whether it can run (check),
 *  2. verify its own result by reading the game after acting,
 *  3. stop on lack of progress rather than on a fixed timer,
 *  4. survive being paused by a reflex,
 *  5. return a result the LLM can act on: what changed, and on failure a cause from a fixed list.
 *
 * The runner, not the skill, measures the inventory change, so a skill cannot claim items it did not get.
 */

/** Why a step did not finish. A fixed list, so the LLM and the recovery logic can act on it. */
export const FAILURE_CAUSES = [
  'missing_item', // an ingredient, block or fuel is not held
  'missing_tool', // the right tool (or tier) is not held
  'missing_station', // a crafting table, furnace or other station is needed and none is usable
  'not_found_nearby', // nothing of that kind within what the bot can see or remembers
  'unreachable', // the target exists but no path reaches it
  'blocked', // something occupies the place or the way (a block, an entity, a full container)
  'too_dangerous', // the skill refused because of a hazard (lava, a drop, a hostile mob)
  'interrupted', // cancelled by the owner, a reflex or a newer step
  'no_progress', // the watchdog saw no progress for its whole window
  'inventory_full', // nowhere to put what the skill produced or picked up
  'invalid_args', // the step's arguments do not name real items or blocks, or are out of range
  'server_rejected', // the server undid an action (a desync, a protection rule)
  'unknown', // an unexpected error; the message says what happened
] as const;
export type FailureCause = (typeof FAILURE_CAUSES)[number];

export type SkillStatus = 'done' | 'partial' | 'failed' | 'interrupted';

/** Item counts gained (positive) and lost (negative), keyed by item name without the minecraft: prefix. */
export type InventoryDelta = Record<string, number>;

export interface BlockChange {
  x: number;
  y: number;
  z: number;
  block: string;
}

export interface WorldDelta {
  placed: BlockChange[];
  broken: BlockChange[];
}

export interface SkillResult {
  status: SkillStatus;
  /** Required unless status is 'done'. */
  cause?: FailureCause;
  /** One plain sentence for the LLM and the logs. */
  message: string;
  /** Measured by the runner from the inventory before and after; a skill's own value is overwritten. */
  inventoryDelta: InventoryDelta;
  worldDelta?: WorldDelta;
  /** Blocks moved, straight-line from start to end. */
  distanceMoved?: number;
  durationMs: number;
  /** What would fix a failure, when the skill knows: "needs 2 more sticks". */
  fix?: string;
  /** Facts the skill checked, for the trace: "stick count 0 -> 4". */
  evidence: string[];
}

/** The answer to "can this skill run right now with these arguments?". */
export type Precondition = { ok: true } | { ok: false; cause: FailureCause; message: string; fix?: string };

export interface SkillContext {
  bot: Bot;
  /** Aborted when the step is cancelled. Skills must stop promptly and leave no item on the cursor or in a grid. */
  signal: AbortSignal;
  log: (line: string) => void;
}

/** What a skill implementation returns; the runner fills in inventoryDelta and durationMs. */
export type SkillOutcome = Omit<SkillResult, 'inventoryDelta' | 'durationMs'> & { inventoryDelta?: InventoryDelta };

export interface SkillDefinition<Args = any> {
  name: string;
  /** One line for the skill catalogue shown to the LLM. */
  summary: string;
  /** Input may differ from output (defaults, transforms); the output type is what run() receives. */
  args: z.ZodType<Args, z.ZodTypeDef, any>;
  /** Cheap, side-effect free. Called before run and again when a plan reaches this step. */
  check(ctx: SkillContext, args: Args): Precondition | Promise<Precondition>;
  run(ctx: SkillContext, args: Args): Promise<SkillOutcome>;
  /** True when, with these (raw) args, the skill runs until it is cancelled (guard or follow with no `minutes`). */
  untilStopped?: (rawArgs: Record<string, unknown>) => boolean;
  /** Only looks (opens and reads something, changes nothing), so a plan of these needs no done_when. */
  readOnly?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Inventory measurement. Counts every slot the bot owns, including the 2x2 crafting grid, the
// open window's crafting grid and the cursor, so items parked there are never mistaken for lost.
// ---------------------------------------------------------------------------------------------

export interface InventoryCounts {
  /** Main inventory, hotbar, armor and off hand. */
  held: Record<string, number>;
  /** Items sitting in a crafting grid, a result slot or on the cursor. Should be empty between steps. */
  parked: Record<string, number>;
}

function add(map: Record<string, number>, name: string, count: number): void {
  map[name] = (map[name] ?? 0) + count;
}

export function countInventory(bot: Bot): InventoryCounts {
  const held: Record<string, number> = {};
  const parked: Record<string, number> = {};
  const inv: any = bot.inventory;
  const slots: any[] = inv?.slots ?? [];
  // Player inventory window: 0 result, 1-4 grid, 5-8 armor, 9-44 main and hotbar, 45 off hand.
  for (let i = 0; i < slots.length; i++) {
    const it = slots[i];
    if (!it) continue;
    add(i <= 4 ? parked : held, it.name, it.count);
  }
  const win: any = bot.currentWindow;
  // There is one cursor. While another window is open it belongs to that window, so count it once, there.
  if ((!win || win === inv) && inv?.selectedItem) add(parked, inv.selectedItem.name, inv.selectedItem.count);
  if (win && win !== inv) {
    // Container windows hold the player's inventory at inventoryStart..inventoryEnd, which is already
    // counted above; only the window's own crafting slots (result + grid) and cursor are added.
    if (typeof win.type === 'string' && win.type.startsWith('minecraft:crafting')) {
      for (let i = 0; i <= 9; i++) {
        const it = win.slots?.[i];
        if (it) add(parked, it.name, it.count);
      }
    }
    if (win.selectedItem) add(parked, win.selectedItem.name, win.selectedItem.count);
  }
  return { held, parked };
}

export function totalCounts(c: InventoryCounts): Record<string, number> {
  const out: Record<string, number> = { ...c.held };
  for (const [k, v] of Object.entries(c.parked)) add(out, k, v);
  return out;
}

export function diffCounts(before: Record<string, number>, after: Record<string, number>): InventoryDelta {
  const delta: InventoryDelta = {};
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const d = (after[name] ?? 0) - (before[name] ?? 0);
    if (d !== 0) delta[name] = d;
  }
  return delta;
}

// ---------------------------------------------------------------------------------------------
// Running one skill.
// ---------------------------------------------------------------------------------------------

function failure(cause: FailureCause, message: string, startedAt: number, extra: Partial<SkillResult> = {}): SkillResult {
  return { status: cause === 'interrupted' ? 'interrupted' : 'failed', cause, message, inventoryDelta: {}, durationMs: Date.now() - startedAt, evidence: [], ...extra };
}

/**
 * Validates arguments, checks preconditions, runs the skill and measures what really changed.
 * Never throws: an exception from a skill becomes cause 'unknown' (or 'interrupted' if the signal fired).
 */
export async function runSkill<A>(def: SkillDefinition<A>, ctx: SkillContext, rawArgs: unknown): Promise<SkillResult> {
  const startedAt = Date.now();
  const parsed = def.args.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return failure('invalid_args', `${def.name}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'args'} ${i.message}`).join('; ')}`, startedAt);
  }
  const args = parsed.data;
  if (ctx.signal.aborted) return failure('interrupted', `${def.name} was cancelled before it started.`, startedAt);

  let pre: Precondition;
  try {
    pre = await def.check(ctx, args);
  } catch (err) {
    return failure('unknown', `${def.name} precondition check threw: ${(err as Error).message}`, startedAt);
  }
  if (!pre.ok) return failure(pre.cause, pre.message, startedAt, pre.fix ? { fix: pre.fix } : {});

  const before = countInventory(ctx.bot);
  const startPos = ctx.bot.entity?.position?.clone?.();
  let outcome: SkillOutcome;
  try {
    outcome = await def.run(ctx, args);
  } catch (err) {
    outcome = ctx.signal.aborted
      ? { status: 'interrupted', cause: 'interrupted', message: `${def.name} was cancelled: ${(err as Error).message}`, evidence: [] }
      : { status: 'failed', cause: 'unknown', message: `${def.name} threw: ${(err as Error).message}`, evidence: [] };
  }
  const after = countInventory(ctx.bot);

  const result: SkillResult = {
    ...outcome,
    inventoryDelta: diffCounts(before.held, after.held),
    durationMs: Date.now() - startedAt,
    evidence: [...(outcome.evidence ?? [])],
  };
  if (startPos && ctx.bot.entity?.position) result.distanceMoved = Number(startPos.distanceTo(ctx.bot.entity.position).toFixed(2));
  if (result.status !== 'done' && !result.cause) result.cause = 'unknown';

  // Items left in a grid or on the cursor are a contract breach: they look lost to everything else.
  const leftover = diffCounts(before.parked, after.parked);
  const stranded = Object.entries(leftover).filter(([, n]) => n > 0);
  if (stranded.length) {
    result.evidence.push(`left in crafting grid or on cursor: ${stranded.map(([k, n]) => `${k} x${n}`).join(', ')}`);
    if (result.status === 'done') {
      result.status = 'partial';
      result.cause = 'server_rejected';
      result.message = `${result.message} But items were left in the crafting grid or on the cursor.`;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Step plans: what the LLM sends. Data only, never code.
// ---------------------------------------------------------------------------------------------

export const StepSchema = z.object({
  skill: z.string().min(1),
  args: z.record(z.unknown()).default({}),
});
export type Step = z.infer<typeof StepSchema>;

export const StepPlanSchema = z.object({
  notes: z.string().optional(),
  steps: z.array(StepSchema).min(1).max(40),
  /** Checked by code when the plan ends. Kept opaque here; the done-condition checker owns its shape. */
  done_when: z.record(z.unknown()).optional(),
});
export type StepPlan = z.infer<typeof StepPlanSchema>;

export interface StepRecord {
  index: number;
  step: Step;
  result: SkillResult;
}

export interface PlanRunResult {
  /** 'completed': every step done. 'stopped': a step did not finish; the LLM is asked again. */
  outcome: 'completed' | 'stopped' | 'invalid';
  steps: StepRecord[];
  /** Index of the step that stopped the plan, if any. */
  stoppedAt?: number;
  message: string;
}

export type SkillRegistry = Map<string, SkillDefinition>;

/** Checks a plan against the catalogue before anything runs, so a typo costs nothing in the game. */
export function validatePlan(raw: unknown, registry: SkillRegistry): { ok: true; plan: StepPlan } | { ok: false; errors: string[] } {
  const parsed = StepPlanSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || 'plan'}: ${i.message}`) };
  const errors: string[] = [];
  parsed.data.steps.forEach((s, i) => {
    const def = registry.get(s.skill);
    if (!def) {
      errors.push(`steps.${i}: unknown skill "${s.skill}"`);
      return;
    }
    const a = def.args.safeParse(s.args);
    if (!a.success) errors.push(...a.error.issues.map((iss) => `steps.${i} (${s.skill}) ${iss.path.join('.') || 'args'}: ${iss.message}`));
  });
  return errors.length ? { ok: false, errors } : { ok: true, plan: parsed.data };
}

/**
 * Runs a validated plan one step at a time. Each step's preconditions are checked when the step is reached
 * (inside runSkill), not when the plan was written, so a stale plan stops instead of doing harm.
 * The plan stops at the first step that is not 'done'; the caller then asks the LLM what to do next.
 */
export async function runPlan(raw: unknown, registry: SkillRegistry, ctx: SkillContext): Promise<PlanRunResult> {
  const v = validatePlan(raw, registry);
  if (!v.ok) return { outcome: 'invalid', steps: [], message: `Plan rejected: ${v.errors.join('; ')}` };
  const records: StepRecord[] = [];
  for (let i = 0; i < v.plan.steps.length; i++) {
    const step = v.plan.steps[i];
    if (ctx.signal.aborted) {
      return { outcome: 'stopped', steps: records, stoppedAt: i, message: `Plan cancelled before step ${i + 1} (${step.skill}).` };
    }
    ctx.log(`[plan] step ${i + 1}/${v.plan.steps.length}: ${step.skill} ${JSON.stringify(step.args)}`);
    const result = await runSkill(registry.get(step.skill)!, ctx, step.args);
    records.push({ index: i, step, result });
    ctx.log(`[plan] step ${i + 1} -> ${result.status}${result.cause ? ` (${result.cause})` : ''}: ${result.message}`);
    if (result.status !== 'done') {
      return { outcome: 'stopped', steps: records, stoppedAt: i, message: `Stopped at step ${i + 1} (${step.skill}): ${result.message}` };
    }
  }
  return { outcome: 'completed', steps: records, message: `All ${records.length} steps done.` };
}

// ---------------------------------------------------------------------------------------------
// Progress watchdog: replaces fixed timeouts. A skill reports a number that should improve
// (distance left, items still needed); the watchdog fails only when it stops improving.
// ---------------------------------------------------------------------------------------------

export class ProgressWatchdog {
  /**
   * True while something else legitimately holds the body (a reflex fighting or fleeing). Time spent then does
   * not count as lack of progress. Set by the reflex guard; false by default.
   */
  static isPaused: () => boolean = () => false;

  private best: number;
  private lastImprovedAt: number;

  /**
   * @param windowMs how long without improvement counts as stuck
   * @param lowerIsBetter true for "distance left" style measures
   */
  constructor(private readonly windowMs: number, initial: number, private readonly lowerIsBetter = true, private readonly now: () => number = Date.now) {
    this.best = initial;
    this.lastImprovedAt = this.now();
  }

  /** Records a new measurement; returns true if it improved on the best so far. */
  report(value: number): boolean {
    const improved = this.lowerIsBetter ? value < this.best : value > this.best;
    if (improved) {
      this.best = value;
      this.lastImprovedAt = this.now();
    }
    return improved;
  }

  /** Also counts as progress: work that is moving but not yet measurable (digging a block, a window opening). */
  touch(): void {
    this.lastImprovedAt = this.now();
  }

  get stuck(): boolean {
    if (ProgressWatchdog.isPaused()) {
      this.lastImprovedAt = this.now();
      return false;
    }
    return this.now() - this.lastImprovedAt > this.windowMs;
  }

  get stalledForMs(): number {
    return this.now() - this.lastImprovedAt;
  }
}
