import { EventEmitter } from 'events';
import type { Bot } from 'mineflayer';

/**
 * Death log (ROADMAP.md Phase 5, CAPABILITIES.md section 15): what the bot carried, where it died and why, so it can
 * go back for its things. Code keeps it; the LLM only hears the result.
 *
 * The inventory is copied twice a second while the bot is alive, because by the time the death is noticed the
 * server is already emptying the slots. The cause comes from the server's death message ("dragonai was slain by
 * Zombie"), which every player sees in chat.
 */

export interface Point {
  x: number;
  y: number;
  z: number;
}

export interface DeathRecord {
  at: number;
  pos: Point;
  dimension: string;
  /** Everything held just before the death, armor and off hand included. */
  items: Record<string, number>;
  /** The server's death message, when one was seen. */
  cause?: string;
  respawned: boolean;
  respawnAt?: Point;
  /** What the bot held right after respawning (usually nothing), to measure what recovery brought back. */
  itemsAfterRespawn?: Record<string, number>;
  /** Set once recovery has been tried, so it is not tried twice. */
  recoveryTried?: boolean;
}

/** Items on the ground despawn after 6000 ticks (5 minutes) while their chunk is loaded. */
export const DROP_LIFETIME_MS = 5 * 60 * 1000;

/** Deaths whose drops cannot be fetched: burned, or fell out of the world. */
const LOST_CAUSES = /lava|burn|fire|flames|fell out of the world|didn't want to live in the same world|left the confines/i;

/** Every item the bot owns by name: main inventory, hotbar, armor and off hand (window slots 5 to 45). */
export function allItems(bot: Bot): Record<string, number> {
  const out: Record<string, number> = {};
  const slots: any[] = (bot.inventory as any)?.slots ?? [];
  for (let i = 5; i <= 45; i++) {
    const it = slots[i];
    if (it?.name) out[it.name] = (out[it.name] ?? 0) + (it.count ?? 1);
  }
  return out;
}

const round = (p: { x: number; y: number; z: number }): Point => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, z: Math.round(p.z * 10) / 10 });

export class DeathWatch extends EventEmitter {
  last: DeathRecord | null = null;
  readonly deaths: DeathRecord[] = [];
  private snapshot: Record<string, number> = {};
  private snapshotPos: Point | null = null;
  /** System messages naming the bot from the last few seconds: the death message can come before the death. */
  private recent: Array<{ at: number; text: string }> = [];
  private readonly timer: NodeJS.Timeout;
  private readonly onDeath = () => this.recordDeath();
  private readonly onSpawn = () => this.recordSpawn();
  private readonly onMessage = (msg: string, position?: string) => this.recordMessage(msg, position);
  private readonly onHealth = () => {
    if (this.bot.health > 0) this.capture();
  };

  constructor(private readonly bot: Bot) {
    super();
    this.capture();
    this.timer = setInterval(() => this.capture(), 500);
    bot.on('death', this.onDeath);
    bot.on('spawn', this.onSpawn);
    bot.on('messagestr', this.onMessage as any);
    bot.on('health', this.onHealth);
  }

  dispose(): void {
    clearInterval(this.timer);
    this.bot.off('death', this.onDeath);
    this.bot.off('spawn', this.onSpawn);
    this.bot.off('messagestr', this.onMessage as any);
    this.bot.off('health', this.onHealth);
  }

  private capture(): void {
    const bot = this.bot;
    if (!bot.entity || !(bot.health > 0) || (bot as any).isAlive === false) return;
    this.snapshot = allItems(bot);
    this.snapshotPos = round(bot.entity.position);
  }

  private recordDeath(): void {
    const bot = this.bot;
    const pos = bot.entity?.position ? round(bot.entity.position) : this.snapshotPos ?? { x: 0, y: 0, z: 0 };
    const rec: DeathRecord = { at: Date.now(), pos, dimension: String(bot.game?.dimension ?? 'overworld'), items: { ...this.snapshot }, respawned: false };
    const earlier = this.recent.filter((m) => rec.at - m.at < 3000).pop();
    if (earlier) rec.cause = earlier.text;
    this.last = rec;
    this.deaths.push(rec);
    this.emit('death', rec);
  }

  private recordSpawn(): void {
    const rec = this.last;
    if (!rec || rec.respawned) return;
    rec.respawned = true;
    rec.respawnAt = this.bot.entity?.position ? round(this.bot.entity.position) : undefined;
    // The slots can still be settling right after the respawn packet; read them a moment later.
    setTimeout(() => {
      rec.itemsAfterRespawn = allItems(this.bot);
      this.capture();
      this.emit('respawn', rec);
    }, 1000);
  }

  private recordMessage(msg: string, position?: string): void {
    if (position === 'chat') return;
    const name = this.bot.username;
    if (!name || !msg.includes(name) || msg.startsWith('<')) return;
    const text = msg.trim().slice(0, 200);
    const now = Date.now();
    this.recent = [...this.recent.filter((m) => now - m.at < 3000), { at: now, text }];
    const rec = this.last;
    if (rec && !rec.cause && now - rec.at <= 5000) rec.cause = text;
  }

  /** Resolves once the last death has respawned and settled (true), or after `ms` (false). */
  async waitForRespawn(ms = 15000, signal?: AbortSignal): Promise<boolean> {
    const until = Date.now() + ms;
    while (Date.now() < until && !signal?.aborted) {
      if (this.last?.respawned && this.last.itemsAfterRespawn) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    return Boolean(this.last?.respawned && this.last.itemsAfterRespawn);
  }
}

/** Why the drops of this death cannot be fetched, or null when going back is worth it. */
export function whyNotRecoverable(rec: DeathRecord, bot: Bot, now = Date.now()): string | null {
  if (!Object.keys(rec.items).length) return 'nothing was carried';
  if (rec.cause && LOST_CAUSES.test(rec.cause)) return `the drops are lost (${rec.cause})`;
  if (now - rec.at > DROP_LIFETIME_MS) return 'it was more than 5 minutes ago, so the drops have despawned';
  if (rec.dimension !== String(bot.game?.dimension ?? 'overworld')) return `the bot died in ${rec.dimension} and is now in ${bot.game?.dimension}`;
  if (rec.pos.y < -64) return 'the bot died below the world';
  return null;
}

const watches = new WeakMap<Bot, DeathWatch>();

/** The bot's death log, started on first use. Start it as soon as the bot spawns so the first death is seen. */
export function watchDeaths(bot: Bot): DeathWatch {
  let w = watches.get(bot);
  if (!w) {
    w = new DeathWatch(bot);
    watches.set(bot, w);
  }
  return w;
}

export function stopWatchingDeaths(bot: Bot): void {
  watches.get(bot)?.dispose();
  watches.delete(bot);
}

export function describeItems(items: Record<string, number>): string {
  const parts = Object.entries(items)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k}`);
  return parts.length ? parts.join(', ') : 'nothing';
}
