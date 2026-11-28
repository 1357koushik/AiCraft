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
  /** Reconnect the bot when it is kicked or drops, as `npm run companion` does (see JudgedSpec.reconnect). */
  reconnect?: boolean;
  /** Windows (seconds after the run starts) in which every LLM call fails, as in a provider outage. */
  llmOutages?: Array<{ from: number; to: number }>;
}

/** An LLM client that fails every call inside the outage windows, measured from `start`. */
export function withOutages(llm: ChatClient, outages: Array<{ from: number; to: number }>, start: () => number): ChatClient {
  if (!outages.length) return llm;
  return {
    model: llm.model,
    async complete(system, user) {
      const t = (Date.now() - start()) / 1000;
      if (outages.some((o) => t >= o.from && t < o.to)) throw new Error(`fetch failed (simulated LLM outage at ${Math.round(t)} s)`);
      return llm.complete(system, user);
    },
  };
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
    reconnect: raw.reconnect === true,
    llmOutages: raw.llmOutages,
  };
  for (const o of spec.llmOutages ?? []) {
    if (!(typeof o?.from === 'number' && typeof o?.to === 'number' && o.from >= 0 && o.to > o.from)) throw new Error(`${filePath}: llmOutages entries need 0 <= from < to (seconds)`);
  }
  validateExpectations(spec.expect);
  for (const pattern of spec.expectBotSaid ?? []) {
    // In JSON "\b" is a backspace, not a word boundary; a pattern holding one can never match chat.
    if (/[\x00-\x1f]/.test(pattern)) throw new Error(`${filePath}: expectBotSaid ${JSON.stringify(pattern)} holds a control character; write regex escapes doubled in JSON ("\\\\b10\\\\b")`);
    new RegExp(pattern, 'i');
  }
  return spec;
}

/**
 * What the bot said in chat during the run, from the judge's timeline of the server log (every line it tailed, also
 * across the log rotation at midnight), falling back to the copied server.log.
 */
export function botChat(runDir: string, botName: string): string[] {
  const timeline = path.join(runDir, 'timeline.ndjson');
  if (fs.existsSync(timeline)) {
    const out: string[] = [];
    for (const line of fs.readFileSync(timeline, 'utf8').split(/\r?\n/)) {
      if (!line.includes('"chat"')) continue;
      try {
        const e = JSON.parse(line);
        if (e.kind === 'log' && e.entry?.kind === 'chat' && e.entry.player === botName) out.push(String(e.entry.message));
      } catch {
        // a torn last line
      }
    }
    if (out.length) return out;
  }
  const logPath = path.join(runDir, 'server.log');
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.match(new RegExp(`<${botName}> (.*)$`))?.[1])
    .filter((x): x is string => Boolean(x));
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
  let startedAt = Date.now();
  const llm = withOutages(opts.llm ?? createChatClient(), spec.llmOutages ?? [], () => startedAt);
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
      reconnect: spec.reconnect,
    },
    async ({ bot, signal, log, runDir, onBotChange }) => {
      startedAt = Date.now();
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
      onBotChange?.((nb) => (nb ? companion.rebind(nb) : companion.detach()));
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
    const said = botChat(out.runDir, botName);
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
