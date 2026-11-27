import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import { HandoverTally } from '../src/brain/handovers.js';
import { DoneWhenSchema } from '../src/brain/decision.js';
import { isDone } from '../src/brain/loop.js';

function fakeBot() {
  const client = new EventEmitter();
  const bot: any = {
    username: 'dragonai',
    _client: client,
    entities: {
      1: { type: 'player', username: 'dragonai' },
      2: { type: 'player', username: 'Steve' },
      10: { name: 'item', getDroppedItem: () => ({ name: 'oak_log', count: 3 }) },
      11: { name: 'item', getDroppedItem: () => ({ name: 'oak_log', count: 2 }) },
      12: { name: 'item', getDroppedItem: () => ({ name: 'dirt', count: 1 }) },
    },
    inventory: { items: () => [] },
  };
  return { bot, client };
}

describe('HandoverTally', () => {
  it('counts what another player picks up, per item, and ignores the bot itself', () => {
    const { bot, client } = fakeBot();
    const tally = new HandoverTally(bot);
    client.emit('collect', { collectedEntityId: 10, collectorEntityId: 2, pickupItemCount: 3 });
    client.emit('collect', { collectedEntityId: 11, collectorEntityId: 1, pickupItemCount: 2 });
    client.emit('collect', { collectedEntityId: 12, collectorEntityId: 2, pickupItemCount: 1 });
    expect(tally.given('Steve', 'oak_log')).toBe(3);
    expect(tally.given('Steve', 'minecraft:dirt')).toBe(1);
    expect(tally.given('dragonai', 'oak_log')).toBe(0);
    tally.dispose();
    client.emit('collect', { collectedEntityId: 10, collectorEntityId: 2, pickupItemCount: 3 });
    expect(tally.given('Steve', 'oak_log')).toBe(3);
  });

  it('decides a given done-condition only from the tally', () => {
    const { bot, client } = fakeBot();
    const tally = new HandoverTally(bot);
    const dw = DoneWhenSchema.parse({ given: { player: 'Steve', items: { oak_log: 5 } } });
    expect(isDone(bot, dw, tally.given)).toBe(false);
    expect(isDone(bot, dw)).toBe(false);
    client.emit('collect', { collectedEntityId: 10, collectorEntityId: 2, pickupItemCount: 3 });
    expect(isDone(bot, dw, tally.given)).toBe(false);
    client.emit('collect', { collectedEntityId: 11, collectorEntityId: 2, pickupItemCount: 2 });
    expect(isDone(bot, dw, tally.given)).toBe(true);
  });

  it('rejects an empty items map', () => {
    expect(() => DoneWhenSchema.parse({ given: { player: 'Steve', items: {} } })).toThrow();
  });
});
