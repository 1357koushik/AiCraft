import fs from 'fs';
import path from 'path';
import type { Verdict } from '../oracle/session.js';
import { TaskExpectations, validateExpectations } from '../oracle/expect.js';
import { runPlan, PlanRunResult, validatePlan, SkillRegistry } from '../skills/contract.js';
import { buildRegistry } from '../skills/registry.js';
import { runJudged, validateEvents, WorldEvent } from './judged_run.js';

/**
 * Runs a hand-written step plan with a bare bot (no agent loop, no LLM) on a fresh judged world.
 * This is the "body alone" test from ROADMAP.md section 8: it shows whether the skills work, with no
 * decision-making in the way. The verdict comes from the same server-side oracle as task runs.
 */

export interface PlanSpec {
  id: string;
  seed?: string;
  timeoutSec: number;
  /** RCON commands run after the bot joins and before measuring starts (labelled setup, not assistance). */
  setup?: string[];
  plan: unknown;
  expect: TaskExpectations;
  checkpoint?: string;
  properties?: Record<string, string>;
  /** Timed things the world does during the run (see JudgedSpec.events). */
  events?: WorldEvent[];
}

export interface PlanRunOutput {
  runId: string;
  runDir: string;
  verdict: Verdict;
  plan: PlanRunResult | null;
}

export function loadPlanFile(filePath: string): PlanSpec {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const spec: PlanSpec = {
    id: raw.id ?? path.basename(filePath, '.json'),
    seed: raw.seed !== undefined ? String(raw.seed) : undefined,
    timeoutSec: raw.timeoutSec ?? 600,
    setup: raw.setup ?? [],
    plan: raw.plan,
    expect: raw.expect ?? {},
    checkpoint: raw.checkpoint,
    properties: raw.properties,
    events: validateEvents(raw.events),
  };
  validateExpectations(spec.expect);
  return spec;
}

export async function runPlanSpec(spec: PlanSpec, opts: { registry?: SkillRegistry; botName?: string; log?: (l: string) => void } = {}): Promise<PlanRunOutput> {
  const registry = opts.registry ?? buildRegistry();
  const check = validatePlan(spec.plan, registry);
  if (!check.ok) throw new Error(`Plan ${spec.id} is invalid: ${check.errors.join('; ')}`);

  let planResult: PlanRunResult | null = null;
  const out = await runJudged(
    { kind: 'plan', id: spec.id, seed: spec.seed, timeoutSec: spec.timeoutSec, setup: spec.setup, expect: spec.expect, checkpoint: spec.checkpoint, properties: spec.properties, events: spec.events },
    async ({ bot, signal, log, runDir }) => {
      planResult = await runPlan(spec.plan, registry, { bot, signal, log });
      fs.writeFileSync(path.join(runDir, 'steps.json'), JSON.stringify(planResult, null, 2));
      const p: PlanRunResult = planResult;
      return {
        endReason: `plan ${p.outcome}: ${p.message}`,
        summaryMarkdown: [
          '',
          '## Steps',
          '',
          ...p.steps.map(
            (s) =>
              `${s.index + 1}. \`${s.step.skill}\` ${JSON.stringify(s.step.args)}: **${s.result.status}**${s.result.cause ? ` (${s.result.cause})` : ''}, ${s.result.message} [${Math.round(s.result.durationMs / 100) / 10} s, delta ${JSON.stringify(s.result.inventoryDelta)}]`
          ),
        ].join('\n'),
      };
    },
    { botName: opts.botName, log: opts.log, extraFiles: { 'plan.json': spec } }
  );
  return { ...out, plan: planResult };
}
