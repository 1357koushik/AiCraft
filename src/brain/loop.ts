import type { Bot } from 'mineflayer';
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
  outcome: 'done' | 'gave_up' | 'asked_owner' | 'budget_exhausted' | 'stalled' | 'cancelled' | 'llm_error';
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

/** Checks the done-condition from what the bot can see. Only code decides that a task is finished. */
export function isDone(bot: Bot, doneWhen: DoneWhen | undefined): boolean {
  if (!doneWhen?.inventory || !Object.keys(doneWhen.inventory).length) return false;
  const have = inventory(bot);
  return Object.entries(doneWhen.inventory).every(([item, expr]) => compare(have[item.replace(/^minecraft:/, '')] ?? 0, parseComparison(expr)));
}

/** How far the inventory is from the done-condition, in missing items. Lower is better. */
function shortfall(bot: Bot, doneWhen: DoneWhen | undefined): number {
  if (!doneWhen?.inventory) return Number.POSITIVE_INFINITY;
  const have = inventory(bot);
  let missing = 0;
  for (const [item, expr] of Object.entries(doneWhen.inventory)) {
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

  const state: BriefState = { task: o.task, trigger: 'This is a new task.', notes: '', lastSteps: [], journal: [], callsUsed: 0, callBudget };
  const result: BrainResult = { outcome: 'done', message: '', calls: 0, inputTokens: 0, outputTokens: 0, llmMs: 0, steps: [], notes: '' };
  // Failed steps by key, with the inventory at the time, so an identical retry with nothing changed is refused.
  const failed = new Map<string, { cause: string; inv: string }>();
  let best = Number.POSITIVE_INFINITY;
  let stalled = 0;

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
    if (now < best) {
      best = now;
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
    if (d.done_when && !state.doneWhen) {
      state.doneWhen = d.done_when;
      best = shortfall(o.bot, state.doneWhen);
      o.log(`[brain] done_when ${JSON.stringify(d.done_when)}`);
    }
    if (d.give_up) return finish('gave_up', d.give_up);
    if (d.ask_owner) return finish('asked_owner', d.ask_owner);
    if (!state.doneWhen) {
      state.trigger = 'You did not set done_when. Set it in this reply.';
      continue;
    }
    if (isDone(o.bot, state.doneWhen)) continue;

    // Loop-breaker: refuse a first step that already failed with nothing relevant changed.
    const invKey = JSON.stringify(inventory(o.bot));
    const first = parsed.plan!.steps[0];
    const prior = failed.get(stepKey(first.skill, first.args));
    if (prior && prior.inv === invKey) {
      const line = `Refused to repeat ${stepKey(first.skill, first.args)}: it already failed (${prior.cause}) and nothing has changed since.`;
      state.journal.push(line);
      state.trigger = line;
      o.log(`[brain] ${line}`);
      continue;
    }

    o.log(`[brain] plan: ${parsed.plan!.steps.map((s) => stepKey(s.skill, s.args)).join(' -> ')}`);
    const run = await runPlan(parsed.plan!, o.registry, { bot: o.bot, signal: o.signal, log: o.log });
    result.steps.push(...run.steps);
    state.lastSteps = run.steps;
    for (const r of run.steps) {
      if (r.result.status !== 'done') {
        failed.set(stepKey(r.step.skill, r.step.args), { cause: r.result.cause ?? 'unknown', inv: JSON.stringify(inventory(o.bot)) });
        state.journal.push(`${stepKey(r.step.skill, r.step.args)} -> ${r.result.status} (${r.result.cause}): ${r.result.message}`);
      }
    }
    state.trigger =
      run.outcome === 'completed'
        ? 'Your plan finished. Check DONE WHEN and decide what is left.'
        : run.outcome === 'invalid'
          ? `Your plan was rejected: ${run.message}`
          : `A step did not finish: ${run.message}`;
  }
}
