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
