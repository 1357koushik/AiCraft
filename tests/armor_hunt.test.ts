import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { Vec3 } from 'vec3';
import { z } from 'zod';

// obtain's route test replaces the two skills that touch the world; everything else is the real code.
const calls: Array<{ skill: string; args: any }> = [];
let fake: any = null;
vi.mock('../src/skills/hunt.js', async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    huntSkill: {
      name: 'hunt',
      summary: 'stub',
      args: z.any(),
      check: () => ({ ok: true }),
      run: async (_ctx: any, args: any) => {
        calls.push({ skill: 'hunt', args });
        fake.give(args.item, 3);
        return { status: 'done', message: 'stub hunt', evidence: [] };
      },
    },
  };
});
vi.mock('../src/skills/use_station.js', () => ({
  useStationSkill: {
    name: 'use_station',
    summary: 'stub',
    args: z.any(),
    check: () => ({ ok: true }),
    run: async (_ctx: any, args: any) => {
      calls.push({ skill: 'use_station', args });
      fake.take(args.input, args.count);
      fake.give('cooked_beef', args.count);
      return { status: 'done', message: 'stub smelt', evidence: [] };
    },
  },
}));

import { armorScore, planArmorUpgrades } from '../src/reflexes/armor.js';
import { HUNTABLE, animalsDropping, isHuntTarget, pickTargets } from '../src/skills/hunt.js';
import { obtainSkill } from '../src/skills/obtain.js';
import { buildRegistry } from '../src/skills/registry.js';
import { parseEquipment } from '../src/oracle/probe.js';
import { parseDataGetReply } from '../src/oracle/snbt.js';
import { evaluateExpectations, hasExpectations, validateExpectations } from '../src/oracle/expect.js';

const animal = (id: number, name: string, x: number, z: number, extra: Record<string, unknown> = {}) => ({ id, name, type: 'animal', position: new Vec3(x, 0, z), ...extra });

describe('armor ranking', () => {
  it('ranks by material and slot, netherite over diamond over iron over chainmail over golden over leather', () => {
    const order = ['netherite', 'diamond', 'iron', 'chainmail', 'golden', 'leather'];
    for (const kind of ['helmet', 'chestplate', 'leggings', 'boots'] as const) {
      const scores = order.map((m) => armorScore(`${m}_${kind}`, kind)!);
      for (let i = 1; i < scores.length; i++) expect(scores[i - 1]).toBeGreaterThan(scores[i]);
    }
  });

  it('knows turtle helmets, and rejects pumpkins, elytra, skulls and the wrong slot', () => {
    expect(armorScore('turtle_helmet', 'helmet')).toBeGreaterThan(armorScore('leather_helmet', 'helmet')!);
    expect(armorScore('turtle_helmet', 'helmet')).toBeLessThan(armorScore('iron_helmet', 'helmet')! + 1);
    for (const n of ['carved_pumpkin', 'elytra', 'zombie_head', 'shield', 'iron_ingot']) expect(armorScore(n, 'helmet')).toBeNull();
    expect(armorScore('iron_boots', 'helmet')).toBeNull();
  });
});

describe('armor upgrade plan', () => {
  const none = { head: undefined, torso: undefined, legs: undefined, feet: undefined };

  it('fills empty slots with the best piece held', () => {
    const plan = planArmorUpgrades(['iron_helmet', 'leather_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots', 'diamond_boots'], none);
    expect(plan).toEqual([
      { slot: 'head', item: 'iron_helmet' },
      { slot: 'torso', item: 'iron_chestplate' },
      { slot: 'legs', item: 'iron_leggings' },
      { slot: 'feet', item: 'diamond_boots' },
    ]);
  });

  it('replaces a worse piece, keeps an equal or better one', () => {
    const plan = planArmorUpgrades(['iron_boots', 'leather_helmet'], { head: 'iron_helmet', torso: undefined, legs: undefined, feet: 'leather_boots' });
    expect(plan).toEqual([{ slot: 'feet', item: 'iron_boots', replaces: 'leather_boots' }]);
  });

  it('never takes off an elytra, never wears a carved pumpkin, never replaces a worn pumpkin or skull', () => {
    expect(planArmorUpgrades(['iron_chestplate', 'carved_pumpkin'], { ...none, torso: 'elytra' })).toEqual([]);
    expect(planArmorUpgrades(['carved_pumpkin'], none)).toEqual([]);
    expect(planArmorUpgrades(['iron_helmet'], { ...none, head: 'carved_pumpkin' })).toEqual([]);
    expect(planArmorUpgrades(['iron_helmet'], { ...none, head: 'creeper_head' })).toEqual([]);
  });
});

describe('hunt targets', () => {
  it('lists only farm animals', () => {
    expect([...HUNTABLE]).toEqual(['cow', 'mooshroom', 'pig', 'sheep', 'chicken', 'rabbit', 'goat']);
    for (const n of ['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom']) expect(isHuntTarget(animal(1, n, 1, 1))).toBe(true);
    for (const n of ['player', 'villager', 'iron_golem', 'wolf', 'cat', 'parrot', 'horse', 'donkey', 'llama', 'zombie', 'axolotl']) expect(isHuntTarget(animal(1, n, 1, 1))).toBe(false);
  });

  it('skips goats unless named in the species list, players, babies, name-tagged and dead ones', () => {
    expect(isHuntTarget(animal(1, 'goat', 1, 1))).toBe(false);
    expect(isHuntTarget(animal(1, 'goat', 1, 1), ['goat'])).toBe(true);
    expect(isHuntTarget({ ...animal(1, 'cow', 1, 1), type: 'player', username: 'Cow' })).toBe(false);
    const meta = (i: number, v: unknown) => {
      const m: any[] = [];
      m[i] = v;
      return m;
    };
    expect(isHuntTarget(animal(1, 'cow', 1, 1, { metadata: meta(16, true) }))).toBe(false); // calf
    expect(isHuntTarget(animal(1, 'cow', 1, 1, { metadata: meta(16, false) }))).toBe(true);
    expect(isHuntTarget(animal(1, 'cow', 1, 1, { metadata: meta(2, { text: 'Bessie' }) }))).toBe(false); // name tag
    expect(isHuntTarget(animal(1, 'cow', 1, 1, { metadata: meta(2, { value: { text: 'Bessie' } }) }))).toBe(false);
    expect(isHuntTarget(animal(1, 'cow', 1, 1, { isValid: false }))).toBe(false);
  });

  it('maps drops to animals from the game data', () => {
    expect(animalsDropping('beef')).toEqual(['cow', 'mooshroom']);
    expect(animalsDropping('porkchop')).toEqual(['pig']);
    expect(animalsDropping('mutton')).toEqual(['sheep']);
    expect(animalsDropping('feather')).toEqual(['chicken']);
    expect(animalsDropping('bone')).toEqual([]);
  });

  it('picks the nearest target and spares the last two of a kind', () => {
    const me = new Vec3(0, 0, 0);
    const herd = [animal(1, 'cow', 10, 0), animal(2, 'cow', 5, 0), animal(3, 'cow', 20, 0), animal(4, 'cow', 7, 0), animal(5, 'pig', 2, 0), animal(6, 'villager', 1, 0)];
    const c = pickTargets(herd, ['cow'], me, me, 2, new Map(), 0, new Set());
    expect(c.targets.map((e) => e.id)).toEqual([2, 4, 1, 3]);
    expect(c.alive).toEqual({ cow: 4 });
    // After two are dead, only the spare two remain and nothing may be killed.
    const after = pickTargets(herd, ['cow'], me, me, 2, new Map(), 0, new Set([2, 4]));
    expect(after.targets).toEqual([]);
    expect(after.spared).toBe(2);
    expect(pickTargets(herd, ['cow'], me, me, 0, new Map(), 0, new Set([2, 4])).targets.map((e) => e.id)).toEqual([1, 3]);
  });

  it('ignores animals out of search range and ones put on the ignore list', () => {
    const me = new Vec3(0, 0, 0);
    const herd = [animal(1, 'cow', 60, 0), animal(2, 'cow', 4, 0), animal(3, 'cow', 5, 0), animal(4, 'cow', 6, 0)];
    expect(pickTargets(herd, ['cow'], me, me, 1, new Map(), 0, new Set()).targets.map((e) => e.id)).toEqual([2, 3, 4]);
    expect(pickTargets(herd, ['cow'], me, me, 1, new Map([[2, 100]]), 0, new Set()).targets.map((e) => e.id)).toEqual([3, 4]);
  });
});

let realHunt: any;
beforeAll(async () => {
  realHunt = ((await vi.importActual('../src/skills/hunt.js')) as any).huntSkill;
});

describe('hunt arguments and precondition', () => {
  const fakeBot = (entities: any[]) => ({ pathfinder: {}, registry: { itemsByName: { beef: {}, bone: {} }, entitiesByName: {} }, entity: { position: new Vec3(0, 0, 0) }, entities: Object.fromEntries(entities.map((e) => [e.id, e])) }) as any;
  const ctx = (bot: any) => ({ bot, signal: new AbortController().signal, log: () => undefined });

  it('is registered, needs an animal or an item, defaults spare to 2', () => {
    expect(buildRegistry().has('hunt')).toBe(true);
    expect(realHunt.args.safeParse({}).success).toBe(false);
    expect(realHunt.args.safeParse({ count: 2 }).success).toBe(false);
    expect(realHunt.args.parse({ item: 'beef', count: 3 }).spare).toBe(2);
    expect(realHunt.args.parse({ animal: 'cows' }).animal).toBe('cow');
  });

  it('refuses animals and items it must not hunt', async () => {
    const bot = fakeBot([]);
    expect((await realHunt.check(ctx(bot), realHunt.args.parse({ animal: 'villager' }))) as any).toMatchObject({ ok: false, cause: 'invalid_args' });
    expect((await realHunt.check(ctx(bot), realHunt.args.parse({ animal: 'wolf' }))) as any).toMatchObject({ ok: false, cause: 'invalid_args' });
    expect((await realHunt.check(ctx(bot), realHunt.args.parse({ item: 'bone' }))) as any).toMatchObject({ ok: false, cause: 'invalid_args' });
  });

  it('says not_found_nearby with a fix when there are none, and blocked when only the spare ones are around', async () => {
    const none = (await realHunt.check(ctx(fakeBot([])), realHunt.args.parse({ item: 'beef', count: 1 }))) as any;
    expect(none).toMatchObject({ ok: false, cause: 'not_found_nearby' });
    expect(none.fix).toMatch(/walk to where/);
    const two = (await realHunt.check(ctx(fakeBot([animal(1, 'cow', 3, 0), animal(2, 'cow', 4, 0)])), realHunt.args.parse({ item: 'beef', count: 1 }))) as any;
    expect(two).toMatchObject({ ok: false, cause: 'blocked' });
    expect(two.fix).toMatch(/spare/);
    const three = await realHunt.check(ctx(fakeBot([animal(1, 'cow', 3, 0), animal(2, 'cow', 4, 0), animal(3, 'cow', 5, 0)])), realHunt.args.parse({ item: 'beef', count: 1 }));
    expect(three).toEqual({ ok: true });
  });
});

describe('obtain goes through hunt for mob-only food', () => {
  beforeEach(() => {
    calls.length = 0;
    const slots: any[] = new Array(46).fill(null);
    const bot: any = {
      registry: { itemsByName: new Proxy({}, { get: () => ({}) }) },
      entity: { position: new Vec3(0, 0, 0), clone: () => 0 },
      inventory: {
        slots,
        selectedItem: null,
        items: () => slots.filter(Boolean),
      },
      currentWindow: null,
      findBlock: () => ({ position: new Vec3(1, 0, 1) }),
    };
    const add = (name: string, n: number) => {
      const have = slots.find((s, i) => s && s.name === name && i > 8);
      if (have) have.count += n;
      else {
        const i = slots.findIndex((s, idx) => idx > 8 && !s);
        slots[i] = { name, count: n, slot: i };
      }
    };
    fake = {
      bot,
      give: add,
      take: (name: string, n: number) => {
        const s = slots.find((x, i) => x && x.name === name && i > 8);
        s.count -= n;
        if (s.count <= 0) slots[s.slot] = null;
      },
    };
    add('coal', 2);
  });

  it('hunts the raw meat, then smelts it: cooked_beef end to end', async () => {
    const ctx = { bot: fake.bot, signal: new AbortController().signal, log: () => undefined };
    const out = await obtainSkill.run(ctx, obtainSkill.args.parse({ item: 'cooked_beef', count: 3 }));
    expect(out.status).toBe('done');
    expect(calls.map((c) => c.skill)).toEqual(['hunt', 'use_station']);
    expect(calls[0].args).toEqual({ item: 'beef', count: 3 });
    expect(calls[1].args).toMatchObject({ station: 'furnace', input: 'beef', count: 3 });
  });

  it('can be asked for raw beef alone', async () => {
    const ctx = { bot: fake.bot, signal: new AbortController().signal, log: () => undefined };
    const out = await obtainSkill.run(ctx, obtainSkill.args.parse({ item: 'beef', count: 2 }));
    expect(out.status).toBe('done');
    expect(calls.map((c) => c.skill)).toEqual(['hunt']);
  });

  it('still stops at items that only come from hostile mobs', async () => {
    const ctx = { bot: fake.bot, signal: new AbortController().signal, log: () => undefined };
    const out = await obtainSkill.run(ctx, obtainSkill.args.parse({ item: 'bone', count: 1 }));
    expect(out.status).toBe('failed');
    expect(calls).toEqual([]);
    expect(out.fix).toMatch(/^hunt /);
  });
});

describe('equipment expectation', () => {
  // The shape 1.21.5+ prints for `data get entity <player> equipment`.
  const reply = 'dragonai has the following entity data: {head: {id: "minecraft:iron_helmet", count: 1}, chest: {id: "minecraft:iron_chestplate", count: 1, components: {"minecraft:damage": 3}}, legs: {id: "minecraft:iron_leggings", count: 1}, offhand: {id: "minecraft:shield", count: 1}}';

  it('parses the equipment compound into slot -> item id and leaves empty slots out', () => {
    expect(parseEquipment(parseDataGetReply(reply))).toEqual({ head: 'iron_helmet', chest: 'iron_chestplate', legs: 'iron_leggings', offhand: 'shield' });
    expect(parseEquipment(null)).toEqual({});
  });

  it('judges each slot, and "none" means empty', () => {
    const equipment = parseEquipment(parseDataGetReply(reply));
    const ev = { items: {}, advancements: new Set<string>(), statDeltas: {}, deaths: 0, equipment };
    const ok = evaluateExpectations({ equipment: { head: 'iron_helmet', chest: 'minecraft:iron_chestplate', feet: 'none', offhand: 'shield' } }, ev, { stats: 's', advancements: 'a' });
    expect(ok.every((c) => c.ok)).toBe(true);
    expect(ok).toHaveLength(4);
    const bad = evaluateExpectations({ equipment: { feet: 'iron_boots', head: 'diamond_helmet' } }, ev, { stats: 's', advancements: 'a' });
    expect(bad.map((c) => [c.check, c.actual, c.ok])).toEqual([
      ['equipment feet', 'none', false],
      ['equipment head', 'iron_helmet', false],
    ]);
    const unknown = evaluateExpectations({ equipment: { head: 'iron_helmet' } }, { ...ev, equipment: undefined }, { stats: 's', advancements: 'a' });
    expect(unknown[0]).toMatchObject({ actual: 'unknown', ok: false });
  });

  it('counts as an expectation and rejects unknown slots', () => {
    expect(hasExpectations({ equipment: { head: 'iron_helmet' } })).toBe(true);
    expect(() => validateExpectations({ equipment: { head: 'iron_helmet' } })).not.toThrow();
    expect(() => validateExpectations({ equipment: { hat: 'iron_helmet' } as any })).toThrow(/slot/);
  });
});
