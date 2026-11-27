import fs from 'fs';
import path from 'path';
import type { Verdict } from '../oracle/session.js';
import { TaskExpectations, validateExpectations } from '../oracle/expect.js';
import { SkillRegistry } from '../skills/contract.js';
import { buildRegistry } from '../skills/registry.js';
import { createChatClient, ChatClient } from '../brain/llm_client.js';
import type { RequirementsSource } from '../brain/brief.js';
import { Companion, TaskItem } from '../companion/companion.js';
import type { OwnerSpec } from './owner_sim.js';
import { DEFAULT_OWNER_NAME } from './owner_sim.js';
import { runJudged, validateEvents, WorldEvent } from './judged_run.js';

/**
 * A judged run where the owner gives tasks the way a player would: by saying them in chat. The scripted owner
 * speaks; the companion hears, queues and runs them; the server judges the world. What the bot said is judged
 * from the server's own log, never from the bot.
 */

export interface CompanionSpec {
  id: string;
  seed?: string;
  /** How long the companion runs; the owner's script plays out within it. */
  runSeconds: number;
  setup?: string[];
  owner: OwnerSpec;
  expect: TaskExpectations;
  /** Regexes; each must match at least one chat line the bot sent (from the server log). */
  expectBotSaid?: string[];
  /** Outcome of each task in the order the owner gave them: done, failed, cancelled. */
  expectTaskStatuses?: Array<TaskItem['status']>;
  callBudget?: number;
  checkpoint?: string;
  properties?: Record<string, string>;
  /** Timed things the world does during the run (see JudgedSpec.events). */
  events?: WorldEvent[];
}

export function loadCompanionSpec(filePath: string): CompanionSpec {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!raw.owner?.script?.length) throw new Error(`${filePath}: an "owner" with a "script" is required (the owner gives the tasks in chat)`);
  const spec: CompanionSpec = {
    id: raw.id ?? path.basename(filePath, '.json'),
    seed: raw.seed !== undefined ? String(raw.seed) : undefined,
    runSeconds: raw.runSeconds ?? 120,
    setup: raw.setup ?? [],
    owner: raw.owner,
    expect: raw.expect ?? {},
    expectBotSaid: raw.expectBotSaid,
    expectTaskStatuses: raw.expectTaskStatuses,
    callBudget: raw.callBudget,
    checkpoint: raw.checkpoint,
    properties: raw.properties,
    events: validateEvents(raw.events),
  };
  validateExpectations(spec.expect);
  for (const pattern of spec.expectBotSaid ?? []) {
    // In JSON "\b" is a backspace, not a word boundary; a pattern holding one can never match chat.
    if (/[\x00-\x1f]/.test(pattern)) throw new Error(`${filePath}: expectBotSaid ${JSON.stringify(pattern)} holds a control character; write regex escapes doubled in JSON ("\\\\b10\\\\b")`);
    new RegExp(pattern, 'i');
  }
  return spec;
}

export interface CompanionRunOutput {
  runId: string;
  runDir: string;
  verdict: Verdict;
  tasks: TaskItem[];
}

export async function runCompanionSpec(
  spec: CompanionSpec,
  opts: { registry?: SkillRegistry; llm?: ChatClient; requirements?: RequirementsSource; log?: (l: string) => void; botName?: string } = {}
): Promise<CompanionRunOutput> {
  const registry = opts.registry ?? buildRegistry();
  const llm = opts.llm ?? createChatClient();
  const botName = opts.botName ?? 'dragonai';
  const ownerName = spec.owner.name ?? DEFAULT_OWNER_NAME;
  let tasks: TaskItem[] = [];
  const out = await runJudged(
    {
      kind: 'brain',
      id: `companion_${spec.id}`,
      seed: spec.seed,
      timeoutSec: spec.runSeconds + 30,
      setup: spec.setup,
      expect: spec.expect,
      owner: spec.owner,
      checkpoint: spec.checkpoint,
      properties: spec.properties,
      events: spec.events,
    },
    async ({ bot, signal, log, runDir }) => {
      const decisions = fs.createWriteStream(path.join(runDir, 'decisions.ndjson'));
      const companion = new Companion({
        bot,
        owners: [ownerName],
        registry,
        llm,
        requirements: opts.requirements,
        callBudget: spec.callBudget,
        log,
        record: (e) => decisions.write(`${JSON.stringify({ t: new Date().toISOString(), ...e })}\n`),
      });
      companion.start();
      const until = Date.now() + spec.runSeconds * 1000;
      while (Date.now() < until && !signal.aborted) await new Promise((r) => setTimeout(r, 500));
      await companion.shutdown();
      decisions.end();
      tasks = companion.history;
      fs.writeFileSync(path.join(runDir, 'tasks.json'), JSON.stringify(tasks, null, 2));
      return {
        endReason: `companion ran ${spec.runSeconds} s; tasks: ${tasks.map((t) => `#${t.id} ${t.status}`).join(', ') || 'none'}`,
        summaryMarkdown: ['', '## Tasks heard in chat', '', ...tasks.map((t) => `- #${t.id} "${t.text}" from ${t.from}: **${t.status}** (${t.outcome ?? '-'}, ${t.calls ?? 0} LLM calls)${t.message ? `: ${t.message}` : ''}`)].join('\n'),
      };
    },
    { log: opts.log, botName, extraFiles: { 'companion.json': spec } }
  );

  // Checks the server cannot do on its own: what the bot said (from the server's log), and how each task ended.
  const checks: Verdict['checks'] = [];
  if (spec.expectBotSaid?.length) {
    const logPath = path.join(out.runDir, 'server.log');
    const said = fs.existsSync(logPath)
      ? fs
          .readFileSync(logPath, 'utf8')
          .split(/\r?\n/)
          .map((l) => l.match(new RegExp(`<${botName}> (.*)$`))?.[1])
          .filter((x): x is string => Boolean(x))
      : [];
    for (const pattern of spec.expectBotSaid) {
      const re = new RegExp(pattern, 'i');
      const hit = said.find((s) => re.test(s));
      checks.push({ check: `bot said /${pattern}/`, expected: 'a matching chat line', actual: hit ?? `no match in ${said.length} lines`, ok: Boolean(hit), source: 'server log chat' });
    }
  }
  if (spec.expectTaskStatuses?.length) {
    const actual = tasks.map((t) => t.status);
    const ok = spec.expectTaskStatuses.length === actual.length && spec.expectTaskStatuses.every((s, i) => s === actual[i]);
    checks.push({ check: 'task outcomes in order', expected: spec.expectTaskStatuses.join(', '), actual: actual.join(', ') || 'none', ok, source: 'companion task log' });
  }
  if (checks.length) {
    out.verdict.checks.push(...checks);
    if (checks.some((c) => !c.ok) && (out.verdict.status === 'PASS' || out.verdict.status === 'UNVERIFIED')) {
      out.verdict.status = 'FAIL';
      out.verdict.reason = `Failed: ${checks.filter((c) => !c.ok).map((c) => c.check).join(', ')}`;
    } else if (out.verdict.status === 'UNVERIFIED' && checks.every((c) => c.ok)) {
      out.verdict.status = 'PASS';
      out.verdict.reason = 'Chat and task checks passed; no world change was expected.';
    }
    fs.writeFileSync(path.join(out.runDir, 'verdict.json'), JSON.stringify(out.verdict, null, 2));
  }
  return { ...out, tasks };
}
