import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { runPlan, SkillRegistry, StepRecord } from '../skills/contract.js';
import { parseComparison, compare } from '../oracle/expect.js';
import { ChatClient } from './llm_client.js';
import { parseDecision, DoneWhen } from './decision.js';
import { systemPrompt, userBrief, RequirementsSource, BriefState } from './brief.js';

/**
 * The decision loop (ROADMAP.md section 4). The LLM chooses step plans; code runs them and calls the LLM
 * again only when something needs deciding: the plan finished, a step did not finish, or the task is new.
 * Never on a timer.
 */

export interface BrainOptions {
  bot: Bot;
  task: string;
  /** Name of the player the task comes from, shown in the brief together with where that player is. */
  owner?: string;
  registry: SkillRegistry;
  llm: ChatClient;
  signal: AbortSignal;
  log: (line: string) => void;
  requirements?: RequirementsSource;
  /** Most LLM calls for this task. When used up, the bot stops and reports. */
  callBudget?: number;
  /** Decisions in a row without progress before the loop gives up. */
  stallLimit?: number;
  /** Writes every prompt and reply here, for replay and debugging. */
  record?: (entry: Record<string, unknown>) => void;
}

export interface BrainResult {
  outcome: 'done' | 'answered' | 'gave_up' | 'asked_owner' | 'budget_exhausted' | 'stalled' | 'cancelled' | 'llm_error';
  message: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  llmMs: number;
  steps: StepRecord[];
  doneWhen?: DoneWhen;
  notes: string;
}

function inventory(bot: Bot): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of bot.inventory.items()) out[it.name] = (out[it.name] ?? 0) + it.count;
  return out;
}

/** Compares a block with "name" or "name[prop=value,...]"; every listed property must match. */
function blockMatches(bot: Bot, x: number, y: number, z: number, want: string): boolean | null {
  const b = bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)));
  if (!b) return null; // not loaded: can't tell from here
  const m = want.replace(/^minecraft:/, '').match(/^([a-z0-9_]+)(?:\[(.*)\])?$/);
  if (!m) return false;
  const [, name, props] = m;
  if (name === 'air') return b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air';
  if (b.name !== name) return false;
  if (!props) return true;
  const actual: Record<string, unknown> = (b as any).getProperties?.() ?? {};
  return props.split(',').every((kv) => {
    const [k, v] = kv.split('=').map((t) => t.trim());
    return String(actual[k]) === v;
  });
}

/** Checks the done-condition from what the bot can see. Only code decides that a task is finished. */
export function isDone(bot: Bot, doneWhen: DoneWhen | undefined): boolean {
  if (!doneWhen) return false;
  const parts: boolean[] = [];
  if (doneWhen.inventory && Object.keys(doneWhen.inventory).length) {
    const have = inventory(bot);
    parts.push(Object.entries(doneWhen.inventory).every(([item, expr]) => compare(have[item.replace(/^minecraft:/, '')] ?? 0, parseComparison(expr))));
  }
  if (doneWhen.blocks?.length) parts.push(doneWhen.blocks.every((b) => blockMatches(bot, b.x, b.y, b.z, b.block) === true));
  if (doneWhen.near) {
    const n = doneWhen.near;
    parts.push(bot.entity.position.distanceTo(new Vec3(n.x + 0.5, n.y, n.z + 0.5)) <= n.range + 0.5);
  }
  return parts.length > 0 && parts.every(Boolean);
}

/** How far the bot is from the done-condition: missing items, wrong blocks, and distance. Lower is better. */
function shortfall(bot: Bot, doneWhen: DoneWhen | undefined): number {
  if (!doneWhen) return Number.POSITIVE_INFINITY;
  const have = inventory(bot);
  let missing = 0;
  for (const b of doneWhen.blocks ?? []) if (blockMatches(bot, b.x, b.y, b.z, b.block) !== true) missing++;
  if (doneWhen.near) {
    const n = doneWhen.near;
    missing += Math.max(0, Math.floor(bot.entity.position.distanceTo(new Vec3(n.x + 0.5, n.y, n.z + 0.5)) - n.range));
  }
  for (const [item, expr] of Object.entries(doneWhen.inventory ?? {})) {
    const c = parseComparison(expr);
    const n = have[item.replace(/^minecraft:/, '')] ?? 0;
    if (c.op === '>=' || c.op === '>' || c.op === '==') missing += Math.max(0, c.value + (c.op === '>' ? 1 : 0) - n);
  }
  return missing;
}

const stepKey = (skill: string, args: unknown) => `${skill} ${JSON.stringify(args)}`;

export async function runBrain(o: BrainOptions): Promise<BrainResult> {
  const callBudget = o.callBudget ?? 12;
  const stallLimit = o.stallLimit ?? 4;
  const knownItems = new Set(Object.keys((o.bot.registry as any).itemsByName));
  const system = systemPrompt(o.registry);
  const record = o.record ?? (() => undefined);

  const state: BriefState = { task: o.task, owner: o.owner, trigger: 'This is a new task.', notes: '', lastSteps: [], journal: [], callsUsed: 0, callBudget };
  const result: BrainResult = { outcome: 'done', message: '', calls: 0, inputTokens: 0, outputTokens: 0, llmMs: 0, steps: [], notes: '' };
  // Failed steps by key, with the inventory at the time, so an identical retry with nothing changed is refused.
  const failed = new Map<string, { cause: string; inv: string }>();
  let best = Number.POSITIVE_INFINITY;
  let stalled = 0;
  // Whether the last plan changed anything: a step that gained or lost items, changed blocks, or moved the bot.
  // Intermediate work (sticks, a table) does not shrink the goal's shortfall but is still progress.
  let lastPlanProgressed = false;

  const finish = (outcome: BrainResult['outcome'], message: string): BrainResult => {
    Object.assign(result, { outcome, message, doneWhen: state.doneWhen, notes: state.notes });
    o.log(`[brain] ${outcome}: ${message} (${result.calls} LLM calls, ${result.inputTokens}+${result.outputTokens} tokens, ${Math.round(result.llmMs / 1000)} s thinking)`);
    return result;
  };

  for (;;) {
    if (o.signal.aborted) return finish('cancelled', 'The task was cancelled.');
    if (isDone(o.bot, state.doneWhen)) return finish('done', `Done-condition met: ${JSON.stringify(state.doneWhen)}.`);
    if (state.callsUsed >= callBudget) return finish('budget_exhausted', `Used all ${callBudget} decisions without finishing.`);

    // Progress is the shortfall against the done-condition; a decision that does not reduce it counts as a stall.
    const now = shortfall(o.bot, state.doneWhen);
    if (now < best || lastPlanProgressed) {
      best = Math.min(best, now);
      stalled = 0;
    } else if (state.callsUsed > 0) {
      stalled++;
      if (stalled >= stallLimit) return finish('stalled', `No progress over ${stalled} decisions.`);
    }

    // Ask the LLM, with one repair round for a reply that does not validate.
    let user = userBrief(o.bot, state, o.requirements);
    let parsed: ReturnType<typeof parseDecision> | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      let reply;
      try {
        reply = await o.llm.complete(system, user);
      } catch (err) {
        record({ kind: 'llm_error', error: (err as Error).message });
        return finish('llm_error', `The LLM could not be reached: ${(err as Error).message}`);
      }
      state.callsUsed++;
      result.calls++;
      result.inputTokens += reply.inputTokens;
      result.outputTokens += reply.outputTokens;
      result.llmMs += reply.latencyMs;
      parsed = parseDecision(reply.text, o.registry, knownItems);
      record({ kind: 'decision', attempt, trigger: state.trigger, system: state.callsUsed === 1 && attempt === 0 ? system : undefined, user, reply: reply.text, latencyMs: reply.latencyMs, valid: parsed.ok, error: parsed.ok ? undefined : parsed.error });
      o.log(`[brain] decision ${state.callsUsed}${attempt ? ' (repair)' : ''}: ${reply.latencyMs} ms, ${parsed.ok ? 'valid' : `invalid: ${parsed.error}`}`);
      if (parsed.ok) break;
      if (state.callsUsed >= callBudget) break;
      user = `${user}\n\nYOUR LAST REPLY WAS REJECTED: ${parsed.error}\nSend one corrected JSON object.`;
    }
    if (!parsed || !parsed.ok) return finish('llm_error', `No valid decision: ${parsed && !parsed.ok ? parsed.error : 'none'}.`);
    const d = parsed.decision;
    state.notes = d.notes;
    // The LLM may tighten its done-condition once it learns more (e.g. how much a chest holds),
    // but a new condition that is already true is refused, so it cannot be used to declare success.
    if (d.done_when && state.doneWhen && JSON.stringify(d.done_when) !== JSON.stringify(state.doneWhen)) {
      if (isDone(o.bot, d.done_when)) {
        state.journal.push(`Kept done_when ${JSON.stringify(state.doneWhen)}; the proposed ${JSON.stringify(d.done_when)} is already true.`);
      } else {
        state.journal.push(`done_when changed from ${JSON.stringify(state.doneWhen)} to ${JSON.stringify(d.done_when)}.`);
        o.log(`[brain] done_when updated to ${JSON.stringify(d.done_when)}`);
        state.doneWhen = d.done_when;
      }
    }
    if (d.done_when && !state.doneWhen) {
      // A condition that is already true before any step has run cannot tell whether the task was done.
      if (result.steps.length === 0 && isDone(o.bot, d.done_when) && !d.answer && !d.give_up && !d.ask_owner) {
        state.trigger = `Your done_when ${JSON.stringify(d.done_when)} is already true now, before anything was done, so it cannot show the task was finished. Describe the end state the owner asked for (for a block, include its state, e.g. "lever[powered=true]").`;
        state.journal.push(`Rejected done_when ${JSON.stringify(d.done_when)}: already true at the start.`);
        o.log(`[brain] rejected done_when that is already true: ${JSON.stringify(d.done_when)}`);
        continue;
      }
      state.doneWhen = d.done_when;
      best = shortfall(o.bot, state.doneWhen);
      o.log(`[brain] done_when ${JSON.stringify(d.done_when)}`);
    }
    if (d.answer) return finish('answered', d.answer);
    if (d.give_up) return finish('gave_up', d.give_up);
    if (d.ask_owner) return finish('asked_owner', d.ask_owner);
    if (!state.doneWhen) {
      state.trigger = 'You did not set done_when. Set it in this reply (or send "answer" if the task is only a question).';
      continue;
    }
    if (isDone(o.bot, state.doneWhen)) continue;
    // after_plan is only for a timed duty: without a step that has `minutes`, the plan's end proves nothing.
    if (state.doneWhen.after_plan && !parsed.plan!.steps.some((s) => typeof (s.args as any)?.minutes === 'number')) {
      state.doneWhen = undefined;
      state.trigger = 'done_when after_plan is only for a timed duty (a step with "minutes"). Describe the end state instead.';
      o.log('[brain] rejected after_plan: no timed step');
      continue;
    }

    // Loop-breaker: refuse a first step that already failed with nothing relevant changed.
    const invKey = JSON.stringify(inventory(o.bot));
    const first = parsed.plan!.steps[0];
    const prior = failed.get(stepKey(first.skill, first.args));
    if (prior && prior.inv === invKey) {
      lastPlanProgressed = false;
      const line = `Refused to repeat ${stepKey(first.skill, first.args)}: it already failed (${prior.cause}) and nothing has changed since.`;
      state.journal.push(line);
      state.trigger = line;
      o.log(`[brain] ${line}`);
      continue;
    }

    o.log(`[brain] plan: ${parsed.plan!.steps.map((s) => stepKey(s.skill, s.args)).join(' -> ')}`);
    const run = await runPlan(parsed.plan!, o.registry, { bot: o.bot, signal: o.signal, log: o.log });
    lastPlanProgressed = run.steps.some(
      (r) =>
        r.result.status !== 'failed' &&
        (Object.keys(r.result.inventoryDelta).length > 0 ||
          (r.result.worldDelta?.placed.length ?? 0) + (r.result.worldDelta?.broken.length ?? 0) > 0 ||
          (r.result.distanceMoved ?? 0) > 2)
    );
    result.steps.push(...run.steps);
    state.lastSteps = run.steps;
    for (const r of run.steps) {
      if (r.result.status !== 'done') {
        failed.set(stepKey(r.step.skill, r.step.args), { cause: r.result.cause ?? 'unknown', inv: JSON.stringify(inventory(o.bot)) });
        state.journal.push(`${stepKey(r.step.skill, r.step.args)} -> ${r.result.status} (${r.result.cause}): ${r.result.message}`);
      }
    }
    if (run.outcome === 'completed' && state.doneWhen?.after_plan) return finish('done', 'The timed duty ran to its end.');
    state.trigger =
      run.outcome === 'completed'
        ? 'Your plan finished. Check DONE WHEN and decide what is left.'
        : run.outcome === 'invalid'
          ? `Your plan was rejected: ${run.message}`
          : `A step did not finish: ${run.message}`;
  }
}
