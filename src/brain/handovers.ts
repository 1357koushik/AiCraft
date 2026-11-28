import type { Bot } from 'mineflayer';

/**
 * Counts items other players picked up, from the server's collect packets, so a done-condition such as
 * "OwnerPlayer has received 5 oak_log" is decided by code from server evidence, not by the LLM. Only pickups
 * after install() count: a task's tally starts at zero.
 */
export type GivenFn = (player: string, item: string) => number;

export class HandoverTally {
  private readonly counts = new Map<string, number>();
  private readonly onCollect = (p: any) => {
    const collected = this.bot.entities[p.collectedEntityId] as any;
    if (collected?.name !== 'item') return;
    const item = collected.getDroppedItem?.()?.name;
    if (!item) return;
    const collector = this.bot.entities[p.collectorEntityId] as any;
    const player = collector?.type === 'player' ? collector.username : undefined;
    if (!player || player === this.bot.username) return;
    const key = `${player}\u0000${item}`;
    this.counts.set(key, (this.counts.get(key) ?? 0) + Number(p.pickupItemCount ?? collected.getDroppedItem?.()?.count ?? 1));
  };

  constructor(private readonly bot: Bot) {
    (bot as any)._client?.on?.('collect', this.onCollect);
  }

  readonly given: GivenFn = (player, item) => this.counts.get(`${player}\u0000${item.replace(/^minecraft:/, '')}`) ?? 0;

  dispose(): void {
    (this.bot as any)._client?.off?.('collect', this.onCollect);
  }
}

export type KilledFn = (mob: string) => number;

/** A death this soon after one of the bot's own hits is the bot's kill. */
const KILL_WINDOW_MS = 3000;

/**
 * Counts mobs the bot killed during a task, whoever drove the swing (a skill or a fight reflex), so "kill that
 * zombie" is done when the zombie dies to the bot even if a reflex got there first. A kill is a death right after the
 * bot's own hit on that entity, as in guard and hunt; a despawn or an unloaded chunk is not one.
 */
export class KillTally {
  private readonly counts = new Map<string, number>();
  private readonly lastHit = new Map<number, number>();
  private readonly counted = new Set<number>();
  private readonly originalAttack: any;
  private readonly onDead = (e: any) => {
    const at = this.lastHit.get(e?.id);
    if (!e?.name || at === undefined || Date.now() - at > KILL_WINDOW_MS || this.counted.has(e.id)) return;
    this.counted.add(e.id);
    this.counts.set(e.name, (this.counts.get(e.name) ?? 0) + 1);
  };

  constructor(private readonly bot: Bot) {
    const b: any = bot;
    this.originalAttack = b.attack;
    if (typeof this.originalAttack === 'function') {
      b.attack = (target: any, ...rest: any[]) => {
        if (target?.id !== undefined) this.lastHit.set(target.id, Date.now());
        return this.originalAttack.call(bot, target, ...rest);
      };
    }
    bot.on?.('entityDead', this.onDead);
  }

  readonly killed: KilledFn = (mob) => this.counts.get(mob.replace(/^minecraft:/, '')) ?? 0;

  dispose(): void {
    // Skills that wrap attack themselves restore what they found, so by now attack is ours again.
    if (typeof this.originalAttack === 'function') (this.bot as any).attack = this.originalAttack;
    this.bot.off?.('entityDead', this.onDead);
  }
}
