import mineflayer, { Bot } from 'mineflayer';
import { pathfinder, Movements, goals } from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { applyProtocolFixes } from '../connection/protocol_fixes.js';

/**
 * The owner simulator: a second Mineflayer client that plays the human owner in tests (ROADMAP.md Phase 4).
 * It runs a short fixed script and never reacts to the bot, so it is a test actor and never a judge: the server's
 * view of both players decides pass or fail. Once its script ends it stands still, which is also how it "waits"
 * while the bot hands items over.
 */

export type Vec3Tuple = [number, number, number];
export type OwnerStep = { say: string } | { walk: Vec3Tuple } | { wait: number } | { look_at: Vec3Tuple };

export interface OwnerSpec {
  /** Default "OwnerPlayer", which is in the config's owners. */
  name?: string;
  /** Where the owner is teleported (by the harness, before measuring starts) once it has joined. */
  spawn?: Vec3Tuple;
  script?: OwnerStep[];
}

export const DEFAULT_OWNER_NAME = 'OwnerPlayer';

const isTriple = (v: unknown): v is Vec3Tuple => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));

/** Throws on a malformed owner block, so a bad task file fails before the server starts. */
export function validateOwnerSpec(owner: OwnerSpec): void {
  if (owner.name !== undefined && !/^[A-Za-z0-9_]{3,16}$/.test(owner.name)) throw new Error(`owner.name "${owner.name}" is not a valid player name`);
  if (owner.spawn !== undefined && !isTriple(owner.spawn)) throw new Error('owner.spawn must be [x, y, z]');
  (owner.script ?? []).forEach((step, i) => {
    const s = step as Record<string, unknown>;
    const keys = Object.keys(s);
    const where = `owner.script[${i}]`;
    if (keys.length !== 1) throw new Error(`${where} must have exactly one of say, walk, wait, look_at`);
    const [key] = keys;
    if (key === 'say' && typeof s.say === 'string' && s.say.length > 0) return;
    if ((key === 'walk' || key === 'look_at') && isTriple(s[key])) return;
    if (key === 'wait' && typeof s.wait === 'number' && s.wait >= 0 && s.wait <= 600) return;
    throw new Error(`${where}: invalid step ${JSON.stringify(step)}`);
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class OwnerSim {
  private constructor(readonly bot: Bot, readonly name: string) {}

  static async join(port: number, name: string): Promise<OwnerSim> {
    const bot = mineflayer.createBot({ host: '127.0.0.1', port, username: name, version: '1.21.6', auth: 'offline' });
    bot.loadPlugin(pathfinder);
    applyProtocolFixes(bot);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`The owner simulator ${name} did not spawn within 60 s.`)), 60000);
      bot.once('spawn', () => {
        clearTimeout(timer);
        resolve();
      });
      bot.once('kicked', (reason) => reject(new Error(`Owner simulator kicked: ${reason}`)));
      bot.once('error', reject);
    });
    const movements = new Movements(bot);
    movements.canDig = false; // The owner never changes the world.
    (bot as any).pathfinder.setMovements(movements);
    return new OwnerSim(bot, name);
  }

  /** Runs the script to its end or until the signal aborts. Never throws; problems go to `log`. */
  async run(script: OwnerStep[], signal: AbortSignal, log: (line: string) => void): Promise<void> {
    for (const step of script) {
      if (signal.aborted) return;
      try {
        if ('say' in step) {
          log(`[owner] says "${step.say}"`);
          this.bot.chat(step.say);
        } else if ('wait' in step) {
          log(`[owner] waits ${step.wait} s`);
          await this.wait(step.wait * 1000, signal);
        } else if ('look_at' in step) {
          await this.bot.lookAt(new Vec3(...step.look_at), true);
        } else if ('walk' in step) {
          log(`[owner] walks to ${step.walk.join(' ')}`);
          await this.walk(step.walk, signal);
          const p = this.bot.entity.position;
          log(`[owner] now at ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}`);
        }
      } catch (err) {
        log(`[owner] step ${JSON.stringify(step)} failed: ${(err as Error).message}`);
      }
    }
  }

  private async wait(ms: number, signal: AbortSignal): Promise<void> {
    const until = Date.now() + ms;
    while (Date.now() < until && !signal.aborted) await sleep(Math.min(200, until - Date.now()));
  }

  private async walk(to: Vec3Tuple, signal: AbortSignal): Promise<void> {
    const pf: any = (this.bot as any).pathfinder;
    const done = pf.goto(new goals.GoalNear(Math.floor(to[0]), Math.floor(to[1]), Math.floor(to[2]), 1)).then(
      () => null as string | null,
      (e: Error) => String(e?.message ?? e)
    );
    const timeout = Date.now() + 90000;
    for (;;) {
      const r = await Promise.race([done, sleep(200).then(() => 'tick' as const)]);
      if (r !== 'tick') {
        if (r) throw new Error(r);
        return;
      }
      if (signal.aborted || Date.now() > timeout) {
        pf.stop();
        pf.setGoal(null);
        return;
      }
    }
  }

  quit(): void {
    try {
      this.bot.quit();
    } catch {
      // already gone
    }
  }
}
