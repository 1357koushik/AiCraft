import fs from 'fs';
import path from 'path';
import mineflayer, { Bot } from 'mineflayer';
import { pathfinder } from 'mineflayer-pathfinder';
import { HarnessServer, RunningServer } from './server.js';
import { OracleSession, Verdict, formatVerdictMarkdown } from '../oracle/session.js';
import { TaskExpectations, validateExpectations } from '../oracle/expect.js';
import { updatePathfinderMovements } from '../actions/techniques.js';
import { installPacketTrace } from '../utils/packet_trace.js';
import { applyProtocolFixes } from '../connection/protocol_fixes.js';
import { logDir } from '../utils/paths.js';
import { installReflexGuard } from '../reflexes/guard.js';
import { PlacesMemory, setActivePlaces, startPlacesScan } from '../memory/places.js';
import { OwnerSim, OwnerSpec, DEFAULT_OWNER_NAME, validateOwnerSpec } from './owner_sim.js';

/**
 * One judged run with a bare bot (no old agent loop): fresh seeded world, setup commands before measuring
 * starts, then `body` drives the bot, then the server-side oracle gives the verdict. Shared by the plan runner
 * (hand-written step plans) and the brain runner (the LLM decision loop).
 */

export interface JudgedSpec {
  kind: 'plan' | 'brain';
  id: string;
  seed?: string;
  timeoutSec: number;
  setup?: string[];
  expect: TaskExpectations;
  checkpoint?: string;
  properties?: Record<string, string>;
  /** A scripted second player who plays the human owner. Joins after the bot, before measuring starts. */
  owner?: OwnerSpec;
}

export interface BodyContext {
  bot: Bot;
  signal: AbortSignal;
  log: (line: string) => void;
  runDir: string;
}

export interface BodyOutput {
  /** Why the run ended, shown in the verdict ("plan completed: ...", "brain done: ..."). */
  endReason: string;
  /** Extra markdown appended to verdict.md. */
  summaryMarkdown?: string;
}

export interface JudgedOutput {
  runId: string;
  runDir: string;
  verdict: Verdict;
}

function stampNow(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '_');
}

export function errorVerdict(message: string): Verdict {
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

export async function runJudged(
  spec: JudgedSpec,
  body: (ctx: BodyContext) => Promise<BodyOutput>,
  opts: { botName?: string; log?: (l: string) => void; extraFiles?: Record<string, unknown> } = {}
): Promise<JudgedOutput> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const botName = opts.botName ?? 'dragonai';
  validateExpectations(spec.expect);
  if (spec.owner) validateOwnerSpec(spec.owner);
  const ownerName = spec.owner ? spec.owner.name ?? DEFAULT_OWNER_NAME : undefined;
  if (!ownerName && (spec.expect.ownerInventory || spec.expect.nearOwner || spec.expect.ownerDamageTakenMax !== undefined)) throw new Error('ownerInventory, nearOwner and ownerDamageTakenMax need an "owner" block in the task.');

  const runId = `${spec.kind}_${stampNow()}_${spec.id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40)}`;
  const runDir = path.resolve(logDir('runs', runId));
  fs.mkdirSync(runDir, { recursive: true });
  for (const [name, content] of Object.entries(opts.extraFiles ?? {})) {
    fs.writeFileSync(path.join(runDir, name), JSON.stringify(content, null, 2));
  }
  const fileLog = fs.createWriteStream(path.join(runDir, `${spec.kind}.log`));
  const runLog = (line: string) => {
    fileLog.write(`${new Date().toISOString()} ${line}\n`);
    log(line);
  };

  const server = new HarnessServer({ players: ownerName ? [botName, ownerName] : [botName] });
  server.ensureInstance();
  const world = { name: runId, seed: spec.seed, checkpointDir: spec.checkpoint, properties: spec.properties };
  server.prepareWorld(world);
  log(`[${spec.kind}] run ${runId}: starting server (seed ${spec.seed ?? 'random'})`);

  let running: RunningServer | null = null;
  let bot: Bot | null = null;
  let owner: OwnerSim | null = null;
  let verdict: Verdict;
  let summary = '';
  let stopReflexes: (() => void) | null = null;
  let stopPlaces: (() => void) | null = null;
  try {
    running = await server.start(world, { stdoutPath: path.join(runDir, 'server-stdout.log') });
    if (process.env.AICRAFT_PACKET_TRACE !== '0') process.env.AICRAFT_PACKET_TRACE = '1';
    bot = await connectBot(server.port, botName);
    installPacketTrace(bot, path.join(runDir, 'packets.ndjson'));
    if (ownerName) {
      // The instance folder is shared with queued runs, which rewrite whitelist.json with only their own players
      // before this server read it, so write ours again and make the running server re-read it.
      server.writeWhitelist();
      runLog(`[setup] whitelist reload -> ${(await running.rcon.command('whitelist reload')).trim()}`);
      owner = await OwnerSim.join(server.port, ownerName);
      runLog(`[owner] ${ownerName} joined`);
    }
    await bot.waitForTicks(40);
    // Reflexes run for the whole measured part: fight, flee, eat, escape lava and drowning, then let the skill resume.
    const reflexBot = bot;
    stopReflexes = installReflexGuard(reflexBot, (e) => runLog(`[reflex] ${e.reflex}: ${e.detail}`));

    for (const cmd of spec.setup ?? []) {
      const out = await running.rcon.command(cmd);
      runLog(`[setup] ${cmd} -> ${out.trim()}`);
    }
    if (owner && spec.owner?.spawn) {
      const [x, y, z] = spec.owner.spawn;
      const out = await running.rcon.command(`tp ${ownerName} ${x} ${y} ${z}`);
      runLog(`[setup] tp ${ownerName} ${x} ${y} ${z} -> ${out.trim()}`);
    }
    if (spec.setup?.length || spec.owner?.spawn) await bot.waitForTicks(20);

    const session = new OracleSession({
      rcon: running.rcon,
      logPath: running.logPath,
      worldDir: running.worldDir,
      bot: botName,
      owners: ownerName ? [ownerName] : [],
      expect: spec.expect,
      timelinePath: path.join(runDir, 'timeline.ndjson'),
    });
    await session.begin();

    // Places memory: fresh per run (in the run folder), fed from the loaded chunks every few seconds.
    const places = new PlacesMemory(path.join(runDir, 'places.json'));
    setActivePlaces(places);
    stopPlaces = startPlacesScan(reflexBot, places, { log: runLog });

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
    let out: BodyOutput;
    // The owner's script runs alongside the body. It is waited for afterwards, so a bot that stops early (for
    // example one that quits following) is still judged over the whole script.
    const ownerRun = owner && spec.owner?.script?.length ? owner.run(spec.owner.script, abort.signal, runLog) : Promise.resolve();
    try {
      out = await body({ bot: b, signal: abort.signal, log: runLog, runDir });
      await ownerRun;
    } finally {
      clearTimeout(deadline);
      polling = false;
      await poller;
    }
    summary = out.summaryMarkdown ?? '';
    // Let the last pickups land before the final read; a bot that died or disconnected must not turn a FAIL into an ERROR.
    await Promise.race([b.waitForTicks(20).catch(() => undefined), new Promise((r) => setTimeout(r, 2000))]);
    verdict = await session.finish(out.endReason);
  } catch (err) {
    const message = (err as Error).message;
    log(`[${spec.kind}] error: ${message}`);
    verdict = errorVerdict(message);
  } finally {
    stopReflexes?.();
    stopPlaces?.();
    setActivePlaces(null);
    owner?.quit();
    bot?.quit();
    await new Promise((r) => setTimeout(r, 1000));
    if (running) {
      if (fs.existsSync(running.logPath)) fs.copyFileSync(running.logPath, path.join(runDir, 'server.log'));
      await running.stop();
    }
    fileLog.end();
  }

  fs.writeFileSync(path.join(runDir, 'verdict.json'), JSON.stringify(verdict, null, 2));
  fs.writeFileSync(path.join(runDir, 'verdict.md'), formatVerdictMarkdown(`${spec.kind} ${spec.id}`, runId, verdict) + summary + '\n');
  log(`[${spec.kind}] ${verdict.status}: ${verdict.reason}`);
  log(`[${spec.kind}] run folder: ${runDir}`);
  return { runId, runDir, verdict };
}
