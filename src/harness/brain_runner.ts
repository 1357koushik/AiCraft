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
  return { ...out, brain };
}
