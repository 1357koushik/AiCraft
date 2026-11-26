import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { loadConfig } from '../config/index.js';
import { HarnessServer, RunningServer } from './server.js';
import { OracleSession, Verdict, formatVerdictMarkdown } from '../oracle/session.js';
import { TaskExpectations, validateExpectations } from '../oracle/expect.js';
import { logDir } from '../utils/paths.js';

/** One task for the real agent, judged by the server. */
export interface TaskSpec {
  id: string;
  /** What the owner says to the bot. */
  text: string;
  seed?: string;
  timeoutSec: number;
  expect?: TaskExpectations;
  /** Start from a copy of this world folder instead of a fresh world (the run is then labelled as such). */
  checkpoint?: string;
  /** Extra server.properties for this task, e.g. { difficulty: "easy" }. */
  properties?: Record<string, string>;
}

export interface RunOptions {
  /** Keep the server running after the verdict (for inspecting the world). */
  keepServer?: boolean;
  /** Poll interval for live checks. */
  pollMs?: number;
  /** How many old run worlds to keep in the instance folder. */
  keepWorlds?: number;
  log?: (line: string) => void;
}

export interface RunResult {
  runId: string;
  runDir: string;
  verdict: Verdict;
}

export function loadTaskFile(filePath: string): TaskSpec {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const spec: TaskSpec = {
    id: raw.id ?? path.basename(filePath, '.json'),
    text: raw.text,
    seed: raw.seed !== undefined ? String(raw.seed) : undefined,
    timeoutSec: raw.timeoutSec ?? 600,
    expect: raw.expect ?? {},
    checkpoint: raw.checkpoint,
    properties: raw.properties,
  };
  if (!spec.text || typeof spec.text !== 'string') throw new Error(`${filePath}: "text" is required`);
  validateExpectations(spec.expect ?? {});
  return spec;
}

function makeRunId(taskId: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '_');
  return `run_${stamp}_${taskId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40)}`;
}

function pruneOldWorlds(instanceDir: string, keep: number): void {
  if (!fs.existsSync(instanceDir)) return;
  const worlds = fs
    .readdirSync(instanceDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('run_'))
    .map((d) => d.name)
    .sort();
  for (const name of worlds.slice(0, Math.max(0, worlds.length - keep))) {
    fs.rmSync(path.join(instanceDir, name), { recursive: true, force: true });
  }
}

function startAgent(spec: TaskSpec, runDir: string): ChildProcess {
  const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const out = fs.createWriteStream(path.join(runDir, 'agent-stdout.log'));
  const child = spawn(process.execPath, [tsxCli, 'src/main.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENT_GOAL: spec.text,
      AGENT_HEADLESS: '1',
      AICRAFT_DATA_DIR: path.join(runDir, 'agent-data'),
      AICRAFT_LOG_DIR: path.join(runDir, 'agent-logs'),
      AICRAFT_PACKET_TRACE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout?.pipe(out);
  child.stderr?.pipe(out);
  return child;
}

async function stopAgent(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((r) => child.once('exit', () => r()));
  child.kill();
  await Promise.race([exited, new Promise((r) => setTimeout(r, 10000))]);
}

/** Runs the real agent on one task against a fresh harness server and returns the server-judged verdict. */
export async function runTask(spec: TaskSpec, options: RunOptions = {}): Promise<RunResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  validateExpectations(spec.expect ?? {});
  const config = loadConfig();
  const botName = config.server.username;
  const owners = config.agent.owners;

  const runId = makeRunId(spec.id);
  const runDir = path.resolve(logDir('runs', runId));
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'task.json'), JSON.stringify({ ...spec, runId }, null, 2));

  const server = new HarnessServer({ players: [botName, ...owners], port: config.server.port });
  if (config.server.host !== '127.0.0.1' && config.server.host !== 'localhost') {
    throw new Error(`config server.host is ${config.server.host}; the harness only runs a local server (127.0.0.1).`);
  }
  server.ensureInstance();
  pruneOldWorlds(server.instanceDir, options.keepWorlds ?? 5);

  const world = { name: runId, seed: spec.seed, checkpointDir: spec.checkpoint, properties: spec.properties };
  server.prepareWorld(world);
  log(`[harness] run ${runId}: starting server (seed ${spec.seed ?? 'random'}${spec.checkpoint ? `, checkpoint ${spec.checkpoint}` : ''})`);

  let running: RunningServer | null = null;
  let agent: ChildProcess | null = null;
  let verdict: Verdict | null = null;
  try {
    running = await server.start(world, { stdoutPath: path.join(runDir, 'server-stdout.log') });
    const session = new OracleSession({
      rcon: running.rcon,
      logPath: running.logPath,
      worldDir: running.worldDir,
      bot: botName,
      owners,
      expect: spec.expect ?? {},
      timelinePath: path.join(runDir, 'timeline.ndjson'),
    });
    await session.begin();
    log(`[harness] server ready; starting agent with task: "${spec.text}" (timeout ${spec.timeoutSec} s)`);

    agent = startAgent(spec, runDir);
    let agentExit: number | null = null;
    agent.once('exit', (code) => {
      agentExit = code ?? -1;
    });

    const deadline = Date.now() + spec.timeoutSec * 1000;
    const pollMs = options.pollMs ?? 1000;
    let endReason = '';
    let lastProgress = '';
    for (;;) {
      const status = await session.poll();
      const progress = status.checks.map((c) => `${c.check}=${c.actual}${c.ok ? '✓' : ''}`).join(' ');
      if (progress && progress !== lastProgress) {
        log(`[harness] ${Math.round((Date.now() - (deadline - spec.timeoutSec * 1000)) / 1000)} s: ${progress}`);
        lastProgress = progress;
      }
      if (status.met) {
        endReason = 'expectations met';
        break;
      }
      if (agentExit !== null) {
        endReason = `agent exited with code ${agentExit}`;
        break;
      }
      if (Date.now() >= deadline) {
        endReason = `timed out after ${spec.timeoutSec} s`;
        break;
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }

    await stopAgent(agent);
    verdict = await session.finish(endReason);
  } catch (err) {
    const message = (err as Error).message;
    log(`[harness] error: ${message}`);
    verdict = {
      status: 'ERROR',
      reason: message,
      checks: [],
      assists: [],
      deaths: 0,
      deathMessages: [],
      discrepancies: [],
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationSec: 0,
      finalSnapshot: null,
    };
  } finally {
    if (agent) await stopAgent(agent);
    if (running) {
      if (fs.existsSync(running.logPath)) fs.copyFileSync(running.logPath, path.join(runDir, 'server.log'));
      if (!options.keepServer) await running.stop();
    }
  }

  fs.writeFileSync(path.join(runDir, 'verdict.json'), JSON.stringify(verdict, null, 2));
  fs.writeFileSync(path.join(runDir, 'verdict.md'), formatVerdictMarkdown(spec.text, runId, verdict!));
  log(`[harness] ${verdict!.status}: ${verdict!.reason}`);
  log(`[harness] run folder: ${runDir}`);
  return { runId, runDir, verdict: verdict! };
}
