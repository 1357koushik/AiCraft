import { spawn, spawnSync, ChildProcess } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { connectRconWithRetry, RconClient } from '../oracle/rcon.js';
import { offlinePlayerUuid } from '../oracle/uuid.js';

/**
 * Runs a dedicated vanilla server instance for judged runs, separate from the
 * hand-managed `server/` folder. One fresh (or checkpoint-copied) world per run.
 */

export interface HarnessServerOptions {
  /** Vanilla server jar. Default: server/server.jar or $HARNESS_SERVER_JAR. */
  jarPath?: string;
  /** Instance folder (worlds, logs, properties). Default: runtime/server or $HARNESS_SERVER_DIR. */
  instanceDir?: string;
  /** Java executable (needs 21+). Default: $HARNESS_JAVA or "java". */
  javaPath?: string;
  port?: number;
  rconPort?: number;
  maxMemory?: string;
  /** Players allowed on the whitelist (bot and owners). */
  players: string[];
  /** Folder holding server.properties templates and datapacks. Default: server-kit. */
  kitDir?: string;
}

export interface WorldOptions {
  name: string;
  seed?: string;
  /** Copy this world folder instead of generating a new one. */
  checkpointDir?: string;
  /** Datapacks to install (folder names under server-kit/datapacks). */
  datapacks?: string[];
  /** Extra server.properties overrides for this run. */
  properties?: Record<string, string>;
}

export interface RunningServer {
  process: ChildProcess;
  rcon: RconClient;
  worldDir: string;
  logPath: string;
  stop: () => Promise<void>;
}

const repoRoot = process.cwd();

function resolve(p: string): string {
  return path.isAbsolute(p) ? p : path.join(repoRoot, p);
}

export function javaMajorVersion(javaPath: string): number {
  const result = spawnSync(javaPath, ['-version'], { encoding: 'utf8' });
  if (result.error) throw new Error(`Could not run "${javaPath} -version": ${result.error.message}`);
  const text = `${result.stderr}\n${result.stdout}`;
  const match = text.match(/version "(\d+)(?:\.(\d+))?/);
  if (!match) throw new Error(`Could not read Java version from: ${text.trim()}`);
  const major = parseInt(match[1], 10);
  return major === 1 && match[2] ? parseInt(match[2], 10) : major;
}

export function portInUse(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((res) => {
    const socket = net.connect(port, host);
    socket.once('connect', () => {
      socket.destroy();
      res(true);
    });
    socket.once('error', () => res(false));
  });
}

export function parseProperties(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

export function formatProperties(props: Record<string, string>): string {
  return ['# Written by the bot harness. Edit server-kit/properties instead.', ...Object.entries(props).map(([k, v]) => `${k}=${v}`), ''].join('\n');
}

export class HarnessServer {
  readonly jarPath: string;
  readonly instanceDir: string;
  readonly javaPath: string;
  readonly port: number;
  readonly rconPort: number;
  readonly kitDir: string;
  private readonly maxMemory: string;
  private readonly players: string[];

  constructor(options: HarnessServerOptions) {
    this.jarPath = resolve(options.jarPath ?? process.env.HARNESS_SERVER_JAR ?? 'server/server.jar');
    this.instanceDir = resolve(options.instanceDir ?? process.env.HARNESS_SERVER_DIR ?? 'runtime/server');
    this.javaPath = options.javaPath ?? process.env.HARNESS_JAVA ?? 'java';
    this.port = options.port ?? 25565;
    this.rconPort = options.rconPort ?? 25575;
    this.maxMemory = options.maxMemory ?? '2G';
    this.kitDir = resolve(options.kitDir ?? 'server-kit');
    this.players = options.players;
  }

  /** Creates the instance folder: EULA (copied, never accepted on your behalf), whitelist, no ops, RCON password. */
  ensureInstance(): void {
    if (!fs.existsSync(this.jarPath)) throw new Error(`Server jar not found: ${this.jarPath}`);
    const major = javaMajorVersion(this.javaPath);
    if (major < 21) {
      throw new Error(`Minecraft 1.21.6 needs Java 21+, but "${this.javaPath}" is Java ${major}. Set HARNESS_JAVA to a newer java executable.`);
    }
    fs.mkdirSync(this.instanceDir, { recursive: true });

    const eulaPath = path.join(this.instanceDir, 'eula.txt');
    if (!/eula\s*=\s*true/i.test(fs.existsSync(eulaPath) ? fs.readFileSync(eulaPath, 'utf8') : '')) {
      const accepted = path.join(path.dirname(this.jarPath), 'eula.txt');
      if (fs.existsSync(accepted) && /eula\s*=\s*true/i.test(fs.readFileSync(accepted, 'utf8'))) {
        fs.copyFileSync(accepted, eulaPath);
      } else {
        throw new Error(
          `The Minecraft EULA has not been accepted. Read https://aka.ms/MinecraftEULA and set eula=true in ${accepted} (the harness copies it from there).`
        );
      }
    }

    const whitelist = this.players.map((name) => ({ uuid: offlinePlayerUuid(name), name }));
    fs.writeFileSync(path.join(this.instanceDir, 'whitelist.json'), JSON.stringify(whitelist, null, 2));
    fs.writeFileSync(path.join(this.instanceDir, 'ops.json'), '[]');

    const passwordPath = path.join(this.instanceDir, '.rcon-password');
    if (!fs.existsSync(passwordPath)) fs.writeFileSync(passwordPath, crypto.randomBytes(18).toString('hex'));
  }

  get rconPassword(): string {
    return fs.readFileSync(path.join(this.instanceDir, '.rcon-password'), 'utf8').trim();
  }

  worldDir(name: string): string {
    if (!/^[A-Za-z0-9_\-]+$/.test(name)) throw new Error(`World name must be letters, digits, _ or - (got "${name}")`);
    return path.join(this.instanceDir, name);
  }

  /** Prepares a fresh world folder with datapacks installed before the first start. */
  prepareWorld(world: WorldOptions): string {
    const dir = this.worldDir(world.name);
    if (fs.existsSync(dir)) throw new Error(`World ${dir} already exists; use a new run id.`);
    if (world.checkpointDir) {
      fs.cpSync(resolve(world.checkpointDir), dir, { recursive: true });
      fs.rmSync(path.join(dir, 'session.lock'), { force: true });
    } else {
      fs.mkdirSync(dir, { recursive: true });
    }
    for (const pack of world.datapacks ?? ['bot_oracle']) {
      const source = path.join(this.kitDir, 'datapacks', pack);
      if (!fs.existsSync(path.join(source, 'pack.mcmeta'))) throw new Error(`Datapack not found: ${source}`);
      const target = path.join(dir, 'datapacks', pack);
      fs.rmSync(target, { recursive: true, force: true });
      fs.cpSync(source, target, { recursive: true });
    }
    return dir;
  }

  writeProperties(world: WorldOptions): void {
    const base = parseProperties(fs.readFileSync(path.join(this.kitDir, 'properties', 'test.properties'), 'utf8'));
    const props: Record<string, string> = {
      ...base,
      'level-name': world.name,
      'level-seed': world.seed ?? '',
      'server-port': String(this.port),
      'query.port': String(this.port),
      'rcon.port': String(this.rconPort),
      'rcon.password': this.rconPassword,
      'enable-rcon': 'true',
      ...(world.properties ?? {}),
    };
    fs.writeFileSync(path.join(this.instanceDir, 'server.properties'), formatProperties(props));
  }

  /**
   * If a harness server from an earlier crashed run is still up, stop it. Only a server that accepts this
   * instance's RCON password is touched; anything else on the ports is reported and left alone.
   */
  async stopLeftoverServer(): Promise<boolean> {
    if (!(await portInUse(this.rconPort))) return false;
    let rcon: RconClient;
    try {
      rcon = await connectRconWithRetry({ port: this.rconPort, password: this.rconPassword }, 3000);
    } catch {
      return false;
    }
    try {
      await rcon.command('stop');
    } catch {
      // The connection drops as the server stops.
    }
    rcon.close();
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (!(await portInUse(this.port)) && !(await portInUse(this.rconPort))) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('A leftover harness server did not stop within 60 s.');
  }

  /** Starts the server on the given world and waits until RCON answers. */
  async start(world: WorldOptions, opts: { stdoutPath?: string; readyTimeoutMs?: number } = {}): Promise<RunningServer> {
    await this.stopLeftoverServer();
    for (const port of [this.port, this.rconPort]) {
      if (await portInUse(port)) {
        throw new Error(`Port ${port} is already in use by another program (for example the server in server/). Stop it first.`);
      }
    }
    this.writeProperties(world);
    const worldDir = this.worldDir(world.name);

    const child = spawn(this.javaPath, [`-Xms1G`, `-Xmx${this.maxMemory}`, '-jar', this.jarPath, 'nogui'], {
      cwd: this.instanceDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const out = opts.stdoutPath ? fs.createWriteStream(opts.stdoutPath, { flags: 'a' }) : null;
    child.stdout?.on('data', (d) => out?.write(d));
    child.stderr?.on('data', (d) => out?.write(d));

    let exited: number | null = null;
    const exitPromise = new Promise<void>((res) =>
      child.once('exit', (code) => {
        exited = code ?? -1;
        out?.end();
        res();
      })
    );

    let rcon: RconClient;
    try {
      rcon = await Promise.race([
        connectRconWithRetry({ port: this.rconPort, password: this.rconPassword }, opts.readyTimeoutMs ?? 180000),
        exitPromise.then(() => {
          throw new Error(`Server exited with code ${exited} before RCON came up. See ${opts.stdoutPath ?? 'server output'}.`);
        }),
      ]);
    } catch (err) {
      if (exited === null) child.kill();
      throw err;
    }

    const stop = async () => {
      if (exited !== null) return;
      try {
        await rcon.command('stop');
      } catch {
        // Connection may drop while stopping.
      }
      rcon.close();
      const timeout = new Promise<'timeout'>((res) => setTimeout(() => res('timeout'), 60000));
      if ((await Promise.race([exitPromise.then(() => 'exited' as const), timeout])) === 'timeout') child.kill();
      await exitPromise;
    };

    return { process: child, rcon, worldDir, logPath: path.join(this.instanceDir, 'logs', 'latest.log'), stop };
  }
}
