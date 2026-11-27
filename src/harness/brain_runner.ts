import fs from 'fs';
import path from 'path';
import type { Verdict } from '../oracle/session.js';
import { TaskExpectations, validateExpectations } from '../oracle/expect.js';
import { SkillRegistry } from '../skills/contract.js';
import { buildRegistry } from '../skills/registry.js';
import { runBrain, BrainResult } from '../brain/loop.js';
import { createChatClient, ChatClient } from '../brain/llm_client.js';
import type { RequirementsSource } from '../brain/brief.js';
import { runJudged } from './judged_run.js';

/**
 * Runs a task in plain words through the LLM decision loop on a fresh judged world (ROADMAP.md Phase 2).
 * The bot never sees the task's `expect`; the LLM writes its own done-condition, and the server judges
 * independently.
 */

export interface BrainTaskSpec {
  id: string;
  text: string;
  seed?: string;
  timeoutSec: number;
  setup?: string[];
  expect: TaskExpectations;
  callBudget?: number;
  /** For tasks judged by the decision itself: "answered" for a question, "gave_up" for an impossible request. */
  expectOutcome?: BrainResult['outcome'];
  /** For questions: every one of these must appear in the answer (case-insensitive). */
  expectAnswerIncludes?: string[];
  checkpoint?: string;
  properties?: Record<string, string>;
}

export function loadBrainTask(filePath: string): BrainTaskSpec {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!raw.text) throw new Error(`${filePath}: "text" is required`);
  const spec: BrainTaskSpec = {
    id: raw.id ?? path.basename(filePath, '.json'),
    text: raw.text,
    seed: raw.seed !== undefined ? String(raw.seed) : undefined,
    timeoutSec: raw.timeoutSec ?? 600,
    setup: raw.setup ?? [],
    expect: raw.expect ?? {},
    callBudget: raw.callBudget,
    expectOutcome: raw.expectOutcome,
    expectAnswerIncludes: raw.expectAnswerIncludes,
    checkpoint: raw.checkpoint,
    properties: raw.properties,
  };
  validateExpectations(spec.expect);
  return spec;
}

export interface BrainRunOutput {
  runId: string;
  runDir: string;
  verdict: Verdict;
  brain: BrainResult | null;
}

export async function runBrainTask(
  spec: BrainTaskSpec,
  opts: { registry?: SkillRegistry; llm?: ChatClient; requirements?: RequirementsSource; log?: (l: string) => void } = {}
): Promise<BrainRunOutput> {
  const registry = opts.registry ?? buildRegistry();
  const llm = opts.llm ?? createChatClient();
  let brain: BrainResult | null = null;
  const out = await runJudged(
    { kind: 'brain', id: spec.id, seed: spec.seed, timeoutSec: spec.timeoutSec, setup: spec.setup, expect: spec.expect, checkpoint: spec.checkpoint, properties: spec.properties },
    async ({ bot, signal, log, runDir }) => {
      const decisions = fs.createWriteStream(path.join(runDir, 'decisions.ndjson'));
      try {
        brain = await runBrain({
          bot,
          task: spec.text,
          registry,
          llm,
          signal,
          log,
          requirements: opts.requirements,
          callBudget: spec.callBudget,
          record: (e) => decisions.write(`${JSON.stringify({ t: new Date().toISOString(), ...e })}\n`),
        });
      } finally {
        decisions.end();
      }
      const b: BrainResult = brain;
      fs.writeFileSync(path.join(runDir, 'brain.json'), JSON.stringify(b, null, 2));
      return {
        endReason: `brain ${b.outcome}: ${b.message}`,
        summaryMarkdown: [
          '',
          '## Decision loop',
          '',
          `- Outcome: **${b.outcome}**: ${b.message}`,
          `- LLM: ${llm.model}, ${b.calls} calls, ${b.inputTokens} input + ${b.outputTokens} output tokens, ${Math.round(b.llmMs / 1000)} s waiting`,
          `- Done-condition the LLM wrote: \`${JSON.stringify(b.doneWhen ?? null)}\``,
          `- Steps run: ${b.steps.length}`,
          '',
          ...b.steps.map((s, i) => `${i + 1}. \`${s.step.skill}\` ${JSON.stringify(s.step.args)}: **${s.result.status}**${s.result.cause ? ` (${s.result.cause})` : ''}, ${s.result.message}`),
        ].join('\n'),
      };
    },
    { log: opts.log, extraFiles: { 'task.json': spec } }
  );
  // Decision-level checks (the server cannot see a question being answered or a request being declined).
  const b = brain as BrainResult | null;
  if (spec.expectOutcome || spec.expectAnswerIncludes?.length) {
    const checks: { check: string; expected: string; actual: string; ok: boolean; source: string }[] = [];
    if (spec.expectOutcome) {
      checks.push({ check: 'decision outcome', expected: spec.expectOutcome, actual: b?.outcome ?? 'none', ok: b?.outcome === spec.expectOutcome, source: 'brain decision log' });
    }
    for (const word of spec.expectAnswerIncludes ?? []) {
      const said = b?.outcome === 'answered' ? b.message : '';
      checks.push({ check: `answer mentions "${word}"`, expected: 'yes', actual: said.toLowerCase().includes(word.toLowerCase()) ? 'yes' : 'no', ok: said.toLowerCase().includes(word.toLowerCase()), source: 'brain decision log' });
    }
    out.verdict.checks.push(...checks);
    if (checks.some((c) => !c.ok) && (out.verdict.status === 'PASS' || out.verdict.status === 'UNVERIFIED')) {
      out.verdict.status = 'FAIL';
      out.verdict.reason = `Decision check failed: ${checks.filter((c) => !c.ok).map((c) => c.check).join(', ')}`;
    } else if (out.verdict.status === 'UNVERIFIED' && checks.every((c) => c.ok)) {
      out.verdict.status = 'PASS';
      out.verdict.reason = 'Decision checks passed and no world change was expected.';
    }
    fs.writeFileSync(path.join(out.runDir, 'verdict.json'), JSON.stringify(out.verdict, null, 2));
  }
  return { ...out, brain };
}
