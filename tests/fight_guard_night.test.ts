import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { guardSkill, morningReached } from '../src/skills/guard.js';
import { huntSkill, isHuntTarget, pickTargets } from '../src/skills/hunt.js';
import { bestWeaponInHand, dropAhead } from '../src/reflexes/guard.js';
import { inventoryLockBusy, withInventoryLock } from '../src/actions/reliable_craft.js';

const mob = (id: number, name: string, x: number, z: number, extra: Record<string, unknown> = {}) => ({ id, name, type: 'hostile', position: new Vec3(x, 0, z), ...extra });
const ctxOf = (bot: any, signal = new AbortController().signal) => ({ bot, signal, log: () => undefined });

describe('hunt takes a hostile mob only when it is named', () => {
  it('accepts the HOSTILE list when named, with no baby check', () => {
    for (const n of ['zombie', 'skeleton', 'spider', 'creeper', 'husk']) expect(isHuntTarget(mob(1, n, 1, 1), [n])).toBe(true);
    expect(isHuntTarget(mob(1, 'zombie', 1, 1, { metadata: Object.assign([], { 16: true }) }), ['zombie'])).toBe(true); // a baby zombie is still a zombie
  });

  it('never takes neutral mobs, players, pets, villagers or golems, even named, and not hostiles that were not named', () => {
    for (const n of ['enderman', 'piglin', 'zombified_piglin', 'wolf', 'bee', 'villager', 'iron_golem', 'cat', 'player']) expect(isHuntTarget(mob(1, n, 1, 1), [n])).toBe(false);
    expect(isHuntTarget({ ...mob(1, 'zombie', 1, 1), type: 'player', username: 'Zed' }, ['zombie'])).toBe(false);
    expect(isHuntTarget(mob(1, 'zombie', 1, 1))).toBe(false); // the default list is the passive animals
    expect(isHuntTarget(mob(1, 'zombie', 1, 1, { metadata: Object.assign([], { 2: { text: 'Bob' } }) }), ['zombie'])).toBe(false); // a named mob
    expect(isHuntTarget(mob(1, 'zombie', 1, 1, { isValid: false }), ['zombie'])).toBe(false);
  });

  it('ignores spare for hostiles', () => {
    const me = new Vec3(0, 0, 0);
    const list = [mob(1, 'zombie', 5, 0), mob(2, 'zombie', 6, 0)];
    expect(pickTargets(list, ['zombie'], me, me, 2, new Map(), 0, new Set()).targets.map((e) => e.id)).toEqual([1, 2]);
  });

  it('check passes for a zombie in range, fails for an enderman, and the summary names the use', async () => {
    const bot: any = { pathfinder: {}, registry: { itemsByName: {}, entitiesByName: {} }, entity: { position: new Vec3(0, 0, 0) }, entities: { 1: mob(1, 'zombie', 8, 0), 2: mob(2, 'enderman', 3, 0) } };
    expect(await huntSkill.check(ctxOf(bot), huntSkill.args.parse({ animal: 'zombie', count: 1 }))).toEqual({ ok: true });
    expect(await huntSkill.check(ctxOf(bot), huntSkill.args.parse({ animal: 'enderman' }))).toMatchObject({ ok: false, cause: 'invalid_args' });
    expect(await huntSkill.check(ctxOf(bot), huntSkill.args.parse({ animal: 'skeleton' }))).toMatchObject({ ok: false, cause: 'not_found_nearby' });
    expect(huntSkill.args.parse({ animal: 'zombies' }).animal).toBe('zombie');
    expect(huntSkill.summary).toMatch(/hunt \{animal:"zombie", count:1\}/);
  });
});

describe('guard until morning', () => {
  it('takes until: "morning" and then is not an open-ended skill', () => {
    expect(guardSkill.args.parse({ player: 'OwnerPlayer', until: 'morning' }).until).toBe('morning');
    expect(guardSkill.args.safeParse({ until: 'noon' }).success).toBe(false);
    expect(guardSkill.untilStopped!({})).toBe(true);
    expect(guardSkill.untilStopped!({ until: 'morning' })).toBe(false);
    expect(guardSkill.untilStopped!({ minutes: 2 })).toBe(false);
    expect(guardSkill.summary).toMatch(/until: "morning"/);
  });

  it('is morning only after a night has been seen and the clock is back under 1000', () => {
    expect(morningReached(18000, true)).toBe(false);
    expect(morningReached(500, true)).toBe(true);
    expect(morningReached(500, false)).toBe(false); // a daytime start, not the end of a night
    expect(morningReached(2500, true)).toBe(false);
    expect(morningReached(undefined, true)).toBe(false);
  });

  it('runs through the night and ends done when the clock wraps to morning', async () => {
    const bot: any = new EventEmitter();
    Object.assign(bot, {
      pathfinder: { thinkTimeout: 0, goal: null, setGoal() {}, stop() {}, setMovements() {} },
      registry: {},
      entity: { position: new Vec3(0, 0, 0) },
      entities: {},
      players: {},
      inventory: { items: () => [], slots: [] },
      getEquipmentDestSlot: () => 5,
      clearControlStates() {},
      setControlState() {},
      stopDigging() {},
      attack() {},
      time: { timeOfDay: 18000 },
    });
    setTimeout(() => (bot.time.timeOfDay = 23999), 150);
    setTimeout(() => (bot.time.timeOfDay = 300), 400);
    const out = await guardSkill.run(ctxOf(bot), guardSkill.args.parse({ until: 'morning' }));
    expect(out.status).toBe('done');
    expect(out.message).toMatch(/until morning/);
  });
});

describe('ledge check before running', () => {
  // Floor at y=0 (the bot stands at y=1) for x < 3; from x=3 on the column is whatever `beyond` says.
  const world = (beyond: (y: number) => string | null) => (p: Vec3) => {
    const name = Math.floor(p.x) < 3 ? (p.y < 1 ? 'stone' : 'air') : beyond(Math.floor(p.y));
    if (!name) return null;
    return { name, boundingBox: name === 'air' || name === 'water' || name === 'lava' ? 'empty' : 'block' };
  };
  const botAt = (blockAt: (p: Vec3) => any, x: number): any => ({ entity: { position: new Vec3(x, 1, 0.5) }, blockAt });
  const floorTo = (lowest: number) => (y: number) => (y <= lowest ? 'stone' : 'air');

  it('allows flat ground and a drop of up to 3 blocks', () => {
    expect(dropAhead(botAt(world(floorTo(0)), 2.5), 1, 0)).toBe(false);
    expect(dropAhead(botAt(world(floorTo(-2)), 2.5), 1, 0)).toBe(false); // lands 3 blocks down
  });

  it('refuses a drop of more than 3, lava and a void', () => {
    expect(dropAhead(botAt(world(floorTo(-4)), 2.5), 1, 0)).toBe(true);
    expect(dropAhead(botAt(world((y) => (y === -1 ? 'lava' : y <= -2 ? 'stone' : 'air')), 2.5), 1, 0)).toBe(true);
    expect(dropAhead(botAt(world(() => 'air'), 2.5), 1, 0)).toBe(true);
    expect(dropAhead(botAt(world(() => null), 2.5), 1, 0)).toBe(true);
  });

  it('looks two blocks ahead', () => {
    // From x=1.5 the first cell (2.5) is floor and the second (3.5) is the void.
    expect(dropAhead(botAt(world(() => 'air'), 1.5), 1, 0)).toBe(true);
    // From x=0.5 the cells at 1.5 and 2.5 are floor.
    expect(dropAhead(botAt(world(() => 'air'), 0.5), 1, 0)).toBe(false);
  });

  it('accepts water as a landing, and moving away from the edge or not at all is always fine', () => {
    expect(dropAhead(botAt(world((y) => (y <= -3 ? 'water' : 'air')), 2.5), 1, 0)).toBe(false);
    expect(dropAhead(botAt(world(() => 'air'), 2.5), 0, 0)).toBe(false);
    expect(dropAhead(botAt(world(() => 'air'), 2.5), -1, 0)).toBe(false);
  });
});

describe('weapon equip in the reflex', () => {
  const botWithSword = () => {
    const calls: string[] = [];
    return { calls, bot: { inventory: { items: () => [{ name: 'iron_sword', count: 1 }] }, heldItem: null, equip: async (i: any) => void calls.push(i.name) } as any };
  };

  it('equips when the inventory lock is free', async () => {
    const { bot, calls } = botWithSword();
    expect(inventoryLockBusy()).toBe(false);
    await bestWeaponInHand(bot);
    expect(calls).toEqual(['iron_sword']);
    expect(inventoryLockBusy()).toBe(false);
  });

  it('skips, and does not queue an equip for later, while a craft holds the lock', async () => {
    const { bot, calls } = botWithSword();
    let release!: () => void;
    const held = withInventoryLock(() => new Promise<void>((r) => (release = r)));
    expect(inventoryLockBusy()).toBe(true);
    await bestWeaponInHand(bot);
    release();
    await held;
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual([]);
    expect(inventoryLockBusy()).toBe(false);
  });
});
