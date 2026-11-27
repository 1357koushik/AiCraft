import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import { Vec3 } from 'vec3';
import { DeathWatch, whyNotRecoverable, allItems, DeathRecord } from '../src/survival/deaths.js';
import { recoveredCounts } from '../src/skills/recover_items.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeBot() {
  const bot: any = new EventEmitter();
  bot.username = 'dragonai';
  bot.inventory = { slots: new Array(46).fill(null) };
  bot.entity = { position: new Vec3(10.26, 64, -3.71) };
  bot.health = 20;
  bot.game = { dimension: 'overworld' };
  return bot;
}

const rec = (over: Partial<DeathRecord> = {}): DeathRecord => ({ at: Date.now(), pos: { x: 0, y: 64, z: 0 }, dimension: 'overworld', items: { iron_ingot: 5 }, respawned: true, ...over });

describe('the death log', () => {
  it('remembers what was carried, where and why, and the respawn', async () => {
    const bot = fakeBot();
    bot.inventory.slots[36] = { name: 'iron_ingot', count: 5 };
    bot.inventory.slots[5] = { name: 'iron_helmet', count: 1 };
    bot.inventory.slots[2] = { name: 'stick', count: 1 }; // crafting grid: not counted
    const w = new DeathWatch(bot);
    expect(allItems(bot)).toEqual({ iron_ingot: 5, iron_helmet: 1 });
    // The server empties the slots around the same time it reports the death.
    bot.health = 0;
    bot.inventory.slots = new Array(46).fill(null);
    bot.emit('death');
    bot.emit('messagestr', 'dragonai was slain by Zombie', 'system');
    expect(w.last?.items).toEqual({ iron_ingot: 5, iron_helmet: 1 });
    expect(w.last?.pos).toEqual({ x: 10.3, y: 64, z: -3.7 });
    expect(w.last?.cause).toBe('dragonai was slain by Zombie');
    bot.health = 20;
    bot.entity.position = new Vec3(0, 70, 0);
    bot.emit('spawn');
    expect(await w.waitForRespawn(3000)).toBe(true);
    expect(w.last?.respawnAt).toEqual({ x: 0, y: 70, z: 0 });
    expect(w.last?.itemsAfterRespawn).toEqual({});
    w.dispose();
  });

  it('takes the cause from a death message that came just before the death', () => {
    const bot = fakeBot();
    const w = new DeathWatch(bot);
    bot.emit('messagestr', 'dragonai was killed', 'system');
    bot.emit('death');
    expect(w.last?.cause).toBe('dragonai was killed');
    w.dispose();
  });

  it('ignores player chat that mentions the bot', async () => {
    const bot = fakeBot();
    const w = new DeathWatch(bot);
    bot.emit('death');
    bot.emit('messagestr', '<Owner> dragonai you died lol', 'chat');
    expect(w.last?.cause).toBeUndefined();
    w.dispose();
    await sleep(1);
  });

  it('knows when going back is pointless', () => {
    const bot = fakeBot();
    expect(whyNotRecoverable(rec(), bot)).toBeNull();
    expect(whyNotRecoverable(rec({ items: {} }), bot)).toMatch(/nothing/);
    expect(whyNotRecoverable(rec({ cause: 'dragonai tried to swim in lava' }), bot)).toMatch(/lost/);
    expect(whyNotRecoverable(rec({ cause: 'dragonai fell out of the world' }), bot)).toMatch(/lost/);
    expect(whyNotRecoverable(rec({ at: Date.now() - 6 * 60000 }), bot)).toMatch(/despawned/);
    expect(whyNotRecoverable(rec({ dimension: 'the_nether' }), bot)).toMatch(/the_nether/);
    expect(whyNotRecoverable(rec({ cause: 'dragonai was slain by Zombie' }), bot)).toBeNull();
  });
});

describe('recoveredCounts', () => {
  it('counts what came back against what was lost', () => {
    const r = recoveredCounts({ iron_ingot: 5, oak_log: 10, bread: 2 }, { bread: 0 }, { iron_ingot: 5, oak_log: 7, dirt: 3 });
    expect(r.got).toEqual({ iron_ingot: 5, oak_log: 7 });
    expect(r.missing).toEqual({ oak_log: 3, bread: 2 });
  });
  it('does not count items held after respawn as recovered', () => {
    const r = recoveredCounts({ oak_log: 4 }, { oak_log: 1 }, { oak_log: 2 });
    expect(r.got).toEqual({ oak_log: 1 });
    expect(r.missing).toEqual({ oak_log: 2 });
  });
});
