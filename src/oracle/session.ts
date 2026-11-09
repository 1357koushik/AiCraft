import fs from 'fs';
import { RconClient } from './rcon.js';
import { LogTailer, parseServerLogLine, isAssistingCommand, ServerLogEntry } from './log.js';
import { readAdvancements, readStats, diffStats, shortId } from './files.js';
import { snapshotPlayer, hasAdvancement, trackStat, readScore, PlayerSnapshot } from './probe.js';
import { TaskExpectations, Evidence, CheckResult, evaluateExpectations, hasExpectations } from './expect.js';
import { offlinePlayerUuid } from './uuid.js';

/**
 * Judges one run using only server-side evidence: RCON reads, the bot_oracle
 * event log, the server log and the world's stats/advancement files. The bot's
 * own reports are never consulted.
 */

export type VerdictStatus = 'PASS' | 'FAIL' | 'ASSISTED' | 'UNVERIFIED' | 'ERROR';

export interface Verdict {
  status: VerdictStatus;
  reason: string;
  checks: CheckResult[];
  /** Commands that changed the game during the measured window. */
  assists: string[];
  deaths: number;
  deathMessages: string[];
  /** Places where two server-side sources disagreed. */
  discrepancies: string[];
  startedAt: string;
  endedAt: string;
  durationSec: number;
  finalSnapshot: PlayerSnapshot | null;
}

export interface SessionOptions {
  rcon: RconClient;
  logPath: string;
  worldDir: string;
  bot: string;
  owners: string[];
  expect: TaskExpectations;
  /** NDJSON file receiving every snapshot and classified log entry. */
  timelinePath: string;
}

export interface LiveStatus {
  met: boolean;
  checks: CheckResult[];
  snapshot: PlayerSnapshot;
}

export class OracleSession {
  private readonly tailer: LogTailer;
  private readonly botUuid: string;
  private readonly timeline: fs.WriteStream;
  private measuring = false;
  private startedAt = new Date();
  private baselineStats: Record<string, number> = {};
  private statObjectives = new Map<string, string>();
  private liveAdvancements = new Set<string>();
  private lastOnlineSnapshot: PlayerSnapshot | null = null;
  private deaths = 0;
  private deathMessages: string[] = [];
  private assists: string[] = [];
  private discrepancies: string[] = [];

  constructor(private readonly options: SessionOptions) {
    this.tailer = new LogTailer(options.logPath);
    this.botUuid = offlinePlayerUuid(options.bot);
    this.timeline = fs.createWriteStream(options.timelinePath, { flags: 'a' });
  }

  private record(entry: Record<string, unknown>): void {
    this.timeline.write(`${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  }

  /** Setup before the bot joins. Everything after the t0 mark is measured. */
  async begin(): Promise<void> {
    const { rcon, expect } = this.options;
    this.baselineStats = readStats(this.options.worldDir, this.botUuid);
    let index = 0;
    for (const key of Object.keys(expect.stats ?? {})) {
      this.statObjectives.set(key, await trackStat(rcon, index++, key));
    }
    this.startedAt = new Date();
    await rcon.command('function bot_oracle:mark {label:"t0"}');
    this.record({ kind: 'mark', label: 't0' });
    // The measured window opens when the mark appears in the server log. If it never does, nothing after it
    // (commands, deaths) would be counted, so treat that as a harness failure rather than judging blind.
    const deadline = Date.now() + 10000;
    while (!this.measuring && Date.now() < deadline) {
      this.drainLog();
      if (!this.measuring) await new Promise((r) => setTimeout(r, 200));
    }
    if (!this.measuring) {
      throw new Error('The bot_oracle t0 mark never appeared in the server log; is the datapack loaded? Refusing to judge this run.');
    }
  }

  private drainLog(): void {
    const players = [this.options.bot, ...this.options.owners];
    for (const line of this.tailer.poll()) {
      const entry = parseServerLogLine(line, players);
      if (!entry || entry.kind === 'other') continue;
      this.onLogEntry(entry);
    }
  }

  private onLogEntry(entry: ServerLogEntry): void {
    if (entry.kind === 'oracle' && entry.event.ev === 'mark' && entry.event.label === 't0') {
      this.measuring = true;
    }
    this.record({ kind: 'log', entry: { ...entry, raw: undefined } });
    if (!this.measuring) return;
    if (entry.kind === 'oracle' && entry.event.ev === 'death' && entry.event.uuid === this.botUuid) {
      this.deaths++;
    }
    if (entry.kind === 'player_message' && entry.player === this.options.bot) {
      this.deathMessages.push(`${entry.time} ${entry.player} ${entry.text}`);
    }
    if (isAssistingCommand(entry) && entry.kind === 'command') {
      this.assists.push(`${entry.time} [${entry.source}] ${entry.feedback}`);
    }
  }

  private async liveEvidence(snapshot: PlayerSnapshot): Promise<Evidence> {
    const { rcon, bot, expect } = this.options;
    if (snapshot.online) {
      for (const adv of expect.advancements ?? []) {
        const id = shortId(adv);
        if (!this.liveAdvancements.has(id) && (await hasAdvancement(rcon, bot, id))) this.liveAdvancements.add(id);
      }
    }
    const statDeltas: Record<string, number> = {};
    for (const [key, objective] of this.statObjectives) statDeltas[key] = await readScore(rcon, bot, objective);
    return { items: snapshot.items, advancements: this.liveAdvancements, statDeltas, dimension: snapshot.dimension, deaths: this.deaths };
  }

  /** One observation: snapshot, new log lines, and a live check of the expectations. */
  async poll(): Promise<LiveStatus> {
    const { rcon, bot, owners, expect } = this.options;
    const snapshot = await snapshotPlayer(rcon, bot);
    if (snapshot.online) this.lastOnlineSnapshot = snapshot;
    this.record({ kind: 'snapshot', player: snapshot });
    for (const owner of owners) {
      const ownerSnapshot = await snapshotPlayer(rcon, owner);
      if (ownerSnapshot.online) this.record({ kind: 'snapshot', player: ownerSnapshot });
    }
    this.drainLog();
    const evidence = await this.liveEvidence(snapshot.online ? snapshot : this.lastOnlineSnapshot ?? snapshot);
    const checks = evaluateExpectations(expect, evidence, { stats: 'scoreboard stat objective', advancements: 'advancement selector' });
    const met = hasExpectations(expect) && checks.length > 0 && checks.every((c) => c.ok);
    return { met, checks, snapshot };
  }

  /** Final verdict. Saves the world first so stat and advancement files are current. */
  async finish(endReason: string, opts: { error?: boolean } = {}): Promise<Verdict> {
    const { rcon, worldDir, expect } = this.options;
    let snapshot: PlayerSnapshot | null = this.lastOnlineSnapshot;
    try {
      const live = await this.poll();
      if (live.snapshot.online) snapshot = live.snapshot;
      await rcon.command('save-all flush');
    } catch (err) {
      this.discrepancies.push(`Final RCON read failed: ${(err as Error).message}`);
    }
    // Give the log writer a moment to flush the last lines.
    await new Promise((r) => setTimeout(r, 500));
    this.drainLog();

    const fileStats = diffStats(this.baselineStats, readStats(worldDir, this.botUuid));
    const fileAdvancements = new Set(
      Object.entries(readAdvancements(worldDir, this.botUuid))
        .filter(([, v]) => v.done)
        .map(([k]) => k)
    );
    for (const [key, objective] of this.statObjectives) {
      let score = 0;
      try {
        score = await readScore(rcon, this.options.bot, objective);
      } catch {
        continue;
      }
      if (score !== (fileStats[key] ?? 0)) {
        this.discrepancies.push(`stat ${key}: scoreboard says ${score}, stats file says ${fileStats[key] ?? 0}`);
      }
    }
    for (const id of this.liveAdvancements) {
      if (!fileAdvancements.has(id)) this.discrepancies.push(`advancement ${id}: selector said done, file does not`);
    }

    const evidence: Evidence = {
      items: snapshot?.items ?? {},
      advancements: fileAdvancements,
      statDeltas: fileStats,
      dimension: snapshot?.dimension,
      deaths: this.deaths,
    };
    const checks = evaluateExpectations(expect, evidence, { stats: 'world stats file', advancements: 'world advancements file' });
    const allOk = checks.length > 0 && checks.every((c) => c.ok);

    let status: VerdictStatus;
    let reason: string;
    if (opts.error) {
      status = 'ERROR';
      reason = endReason;
    } else if (!hasExpectations(expect)) {
      status = 'UNVERIFIED';
      reason = `No server-checkable expectations were given (${endReason}). Evidence is recorded but nothing was judged.`;
    } else if (allOk && this.assists.length > 0) {
      status = 'ASSISTED';
      reason = `Expectations met, but ${this.assists.length} command(s) changed the game during the run.`;
    } else if (allOk) {
      status = 'PASS';
      reason = 'All expectations confirmed by the server.';
    } else {
      status = 'FAIL';
      reason = `${endReason}; failed: ${checks.filter((c) => !c.ok).map((c) => c.check).join(', ')}`;
    }

    const endedAt = new Date();
    const verdict: Verdict = {
      status,
      reason,
      checks,
      assists: this.assists,
      deaths: this.deaths,
      deathMessages: this.deathMessages,
      discrepancies: this.discrepancies,
      startedAt: this.startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationSec: Math.round((endedAt.getTime() - this.startedAt.getTime()) / 1000),
      finalSnapshot: snapshot,
    };
    this.record({ kind: 'verdict', verdict });
    await new Promise<void>((r) => this.timeline.end(r));
    return verdict;
  }
}

export function formatVerdictMarkdown(taskText: string, runId: string, verdict: Verdict): string {
  const lines = [
    `# ${verdict.status}: ${taskText}`,
    '',
    `Run \`${runId}\` · ${verdict.durationSec} s · ${verdict.startedAt} → ${verdict.endedAt}`,
    '',
    verdict.reason,
    '',
    '## Checks (server-side evidence only)',
    '',
    '| Check | Expected | Actual | Result | Source |',
    '| --- | --- | --- | --- | --- |',
    ...verdict.checks.map((c) => `| ${c.check} | ${c.expected} | ${c.actual} | ${c.ok ? 'ok' : '**failed**'} | ${c.source} |`),
    '',
    `Deaths: ${verdict.deaths}${verdict.deathMessages.length ? ` (${verdict.deathMessages.join('; ')})` : ''}`,
    '',
    `Commands that changed the game during the run: ${verdict.assists.length ? '' : 'none'}`,
    ...verdict.assists.map((a) => `- ${a}`),
  ];
  if (verdict.discrepancies.length) {
    lines.push('', '## Discrepancies between server sources', ...verdict.discrepancies.map((d) => `- ${d}`));
  }
  if (verdict.finalSnapshot) {
    const s = verdict.finalSnapshot;
    lines.push(
      '',
      '## Final bot state (RCON)',
      '',
      `- Online: ${s.online} · Dimension: ${s.dimension ?? '?'} · Position: ${s.pos?.map((n) => n.toFixed(1)).join(', ') ?? '?'} · Health: ${s.health ?? '?'} · Food: ${s.food ?? '?'}`,
      `- Items: ${Object.entries(s.items).map(([k, v]) => `${k} ×${v}`).join(', ') || 'none'}`
    );
  }
  return `${lines.join('\n')}\n`;
}
