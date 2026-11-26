import fs from 'fs';
import path from 'path';
import mineflayer, { Bot } from 'mineflayer';
import { pathfinder } from 'mineflayer-pathfinder';
import { HarnessServer, RunningServer } from './server.js';
import { OracleSession, Verdict, formatVerdictMarkdown } from '../oracle/session.js';
import { TaskExpectations, validateExpectations } from '../oracle/expect.js';
import { runPlan, PlanRunResult, validatePlan, SkillRegistry } from '../skills/contract.js';
import { buildRegistry } from '../skills/registry.js';
import { updatePathfinderMovements } from '../actions/techniques.js';
import { installPacketTrace } from '../utils/packet_trace.js';
import { applyProtocolFixes } from '../connection/protocol_fixes.js';
import { logDir } from '../utils/paths.js';

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
  };
  validateExpectations(spec.expect);
  return spec;
}

function stampNow(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '_');
}

function errorVerdict(message: string): Verdict {
  const now = new Date().toISOString();
  return { status: 'ERROR', reason: message, checks: [], assists: [], deaths: 0, deathMessages: [], discrepancies: [], startedAt: now, endedAt: now, durationSec: 0, finalSnapshot: null };
}

async function connectBot(port: number, username: string): Promise<Bot> {
  const bot = mineflayer.createBot({ host: '127.0.0.1', port, username, version: '1.21.6', auth: 'offline' });
  bot.loadPlugin(pathfinder);
  applyProtocolFixes(bot);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The bot did not spawn within 60 s.')), 60000);
    bot.once('spawn', () => {
      clearTimeout(timer);
      resolve();
    });
    bot.once('kicked', (reason) => reject(new Error(`Kicked: ${reason}`)));
    bot.once('error', reject);
  });
  updatePathfinderMovements(bot);
  return bot;
}

export async function runPlanSpec(spec: PlanSpec, opts: { registry?: SkillRegistry; botName?: string; log?: (l: string) => void } = {}): Promise<PlanRunOutput> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const registry = opts.registry ?? buildRegistry();
  const botName = opts.botName ?? 'dragonai';

  const check = validatePlan(spec.plan, registry);
  if (!check.ok) throw new Error(`Plan ${spec.id} is invalid: ${check.errors.join('; ')}`);

  const runId = `plan_${stampNow()}_${spec.id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40)}`;
  const runDir = path.resolve(logDir('runs', runId));
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'plan.json'), JSON.stringify({ ...spec, runId }, null, 2));
  const stepLog = fs.createWriteStream(path.join(runDir, 'plan.log'));
  const planLog = (line: string) => {
    stepLog.write(`${new Date().toISOString()} ${line}\n`);
    log(line);
  };

  const server = new HarnessServer({ players: [botName] });
  server.ensureInstance();
  const world = { name: runId, seed: spec.seed, checkpointDir: spec.checkpoint, properties: spec.properties };
  server.prepareWorld(world);
  log(`[plan] run ${runId}: starting server (seed ${spec.seed ?? 'random'})`);

  let running: RunningServer | null = null;
  let bot: Bot | null = null;
  let verdict: Verdict;
  let planResult: PlanRunResult | null = null;
  try {
    running = await server.start(world, { stdoutPath: path.join(runDir, 'server-stdout.log') });
    if (process.env.AICRAFT_PACKET_TRACE !== '0') {
      process.env.AICRAFT_PACKET_TRACE = '1';
    }
    bot = await connectBot(server.port, botName);
    installPacketTrace(bot, path.join(runDir, 'packets.ndjson'));
    await bot.waitForTicks(40);

    for (const cmd of spec.setup ?? []) {
      const out = await running.rcon.command(cmd);
      planLog(`[setup] ${cmd} -> ${out.trim()}`);
    }
    if (spec.setup?.length) await bot.waitForTicks(20);

    const session = new OracleSession({
      rcon: running.rcon,
      logPath: running.logPath,
      worldDir: running.worldDir,
      bot: botName,
      owners: [],
      expect: spec.expect,
      timelinePath: path.join(runDir, 'timeline.ndjson'),
    });
    await session.begin();

    const abort = new AbortController();
    const deadline = setTimeout(() => abort.abort(new Error('time limit')), spec.timeoutSec * 1000);
    let polling = true;
    const poller = (async () => {
      while (polling) {
        try {
          await session.poll();
        } catch {
          // A failed poll is recorded by finish(); keep going.
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    })();

    const b = bot;
    planResult = await runPlan(spec.plan, registry, { bot: b, signal: abort.signal, log: planLog });
    clearTimeout(deadline);
    polling = false;
    await poller;
    fs.writeFileSync(path.join(runDir, 'steps.json'), JSON.stringify(planResult, null, 2));
    await b.waitForTicks(20);
    verdict = await session.finish(`plan ${planResult.outcome}: ${planResult.message}`);
  } catch (err) {
    const message = (err as Error).message;
    log(`[plan] error: ${message}`);
    verdict = errorVerdict(message);
  } finally {
    bot?.quit();
    await new Promise((r) => setTimeout(r, 1000));
    if (running) {
      if (fs.existsSync(running.logPath)) fs.copyFileSync(running.logPath, path.join(runDir, 'server.log'));
      await running.stop();
    }
    stepLog.end();
  }

  fs.writeFileSync(path.join(runDir, 'verdict.json'), JSON.stringify(verdict, null, 2));
  const summary = planResult ? ['', '## Steps', '', ...planResult.steps.map((s) => `${s.index + 1}. \`${s.step.skill}\` ${JSON.stringify(s.step.args)}: **${s.result.status}**${s.result.cause ? ` (${s.result.cause})` : ''}, ${s.result.message} [${Math.round(s.result.durationMs / 100) / 10} s, delta ${JSON.stringify(s.result.inventoryDelta)}]`)].join('\n') : '';
  fs.writeFileSync(path.join(runDir, 'verdict.md'), formatVerdictMarkdown(`plan ${spec.id}`, runId, verdict) + summary + '\n');
  log(`[plan] ${verdict.status}: ${verdict.reason}`);
  log(`[plan] run folder: ${runDir}`);
  return { runId, runDir, verdict, plan: planResult };
}
