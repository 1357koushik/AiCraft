import { describe, it, expect } from 'vitest';
import { Vec3 } from 'vec3';
import { buildRegistry } from '../src/skills/registry.js';
import { classifyBedMessage, findBedSpot, isMorning, isNightTime, isRespawnSetMessage, sleepSkill, yawFor, Cell as BedCell } from '../src/skills/sleep.js';
import { chooseMethod, enclosureCells, openCells, pickShelterBlocks, planDigDown, planEnclosure, shelterRank, shelterSkill, DigView } from '../src/skills/shelter.js';

describe('sleep: time and refusals', () => {
  it('knows night, thunder and morning', () => {
    expect(isNightTime(13000)).toBe(true);
    expect(isNightTime(12541)).toBe(false);
    expect(isNightTime(23459)).toBe(true);
    expect(isNightTime(6000)).toBe(false);
    expect(isNightTime(6000, true)).toBe(true);
    expect(isMorning(0)).toBe(true);
    expect(isMorning(1499)).toBe(true);
    expect(isMorning(18000)).toBe(false);
    expect(isMorning(undefined)).toBe(false);
  });

  it('maps the server refusals to causes with a fix', () => {
    const day = classifyBedMessage('You can sleep only at night or during thunderstorms');
    expect(day).toMatchObject({ cause: 'blocked' });
    expect(day!.fix).toMatch(/night/);
    expect(classifyBedMessage('You may not rest now; there are monsters nearby')).toMatchObject({ cause: 'blocked' });
    expect(classifyBedMessage('You may not rest now; there are monsters nearby')!.fix).toMatch(/monsters/);
    expect(classifyBedMessage('You may not rest now, the bed is too far away')).toMatchObject({ cause: 'unreachable', retryCloser: true });
    expect(classifyBedMessage('This bed is obstructed')).toMatchObject({ cause: 'blocked' });
    expect(classifyBedMessage('This bed is occupied')).toMatchObject({ cause: 'blocked' });
    expect(classifyBedMessage('Respawn point set')).toBeNull();
    expect(isRespawnSetMessage('Respawn point set')).toBe(true);
    expect(isRespawnSetMessage('hello')).toBe(false);
  });

  it('yaw faces the bed direction', () => {
    expect(yawFor(0, -1)).toBeCloseTo(0);
    expect(yawFor(1, 0)).toBeCloseTo(-Math.PI / 2);
  });
});

// A flat world: solid ground at y=0 (cells y<=0), air above.
const flat = (extraSolid: BedCell[] = []) => {
  const solid = new Set(extraSolid.map((c) => `${c.x},${c.y},${c.z}`));
  return {
    solid: (c: BedCell) => c.y <= 0 || solid.has(`${c.x},${c.y},${c.z}`),
    free: (c: BedCell) => c.y > 0 && !solid.has(`${c.x},${c.y},${c.z}`),
  };
};

describe('sleep: bed spot', () => {
  it('finds two free cells in a row with a standing cell behind', () => {
    const spot = findBedSpot(flat(), { x: 0, y: 1, z: 0 })!;
    expect(spot).toBeTruthy();
    expect(Math.abs(spot.head.x - spot.foot.x) + Math.abs(spot.head.z - spot.foot.z)).toBe(1);
    expect(spot.stand.x).toBe(spot.foot.x - spot.dx);
    expect(spot.stand.z).toBe(spot.foot.z - spot.dz);
    expect(spot.foot.y).toBe(1);
  });

  it('keeps the bed off cells where a player stands', () => {
    // A player stands at 1 1 0, right next to the bot at 0 1 0.
    const taken = (c: BedCell) => c.x === 1 && c.z === 0 && c.y === 1;
    const view = { ...flat(), occupied: (c: BedCell, self: boolean) => taken(c) || (self && c.x === 0 && c.z === 0 && c.y === 1) };
    const spot = findBedSpot(view, { x: 0, y: 1, z: 0 })!;
    expect(spot).toBeTruthy();
    for (const cell of [spot.foot, spot.head, spot.stand]) expect(taken(cell)).toBe(false);
    // The bed never goes where the bot itself stands either; the bot may stand on the standing cell.
    for (const cell of [spot.foot, spot.head]) expect(cell.x === 0 && cell.z === 0).toBe(false);
  });

  it('refuses a spot with a block above, and finds nothing in a closed room', () => {
    const roof: BedCell[] = [];
    for (let x = -8; x <= 8; x++) for (let z = -8; z <= 8; z++) roof.push({ x, y: 2, z });
    expect(findBedSpot(flat(roof), { x: 0, y: 1, z: 0 })).toBeNull();
  });

  it('skips cells without ground', () => {
    const none = { solid: () => false, free: () => true };
    expect(findBedSpot(none, { x: 0, y: 1, z: 0 })).toBeNull();
  });
});

// ---- shelter ----

const worldOf = (solidCells: Array<[number, number, number]>, opts: { lava?: string[]; occupied?: string[] } = {}): DigView => {
  const solid = new Set(solidCells.map((c) => c.join(',')));
  const k = (c: BedCell) => `${c.x},${c.y},${c.z}`;
  return {
    solid: (c) => c.y <= 0 || solid.has(k(c)),
    replaceable: (c) => c.y > 0 && !solid.has(k(c)) && !(opts.occupied ?? []).includes(k(c)) && !(opts.lava ?? []).includes(k(c)),
    lava: (c) => (opts.lava ?? []).includes(k(c)),
    describe: (c) => ((opts.occupied ?? []).includes(k(c)) ? 'oak_fence' : c.y <= 0 || solid.has(k(c)) ? 'stone' : 'air'),
    diggable: (c) => c.y <= 0,
  };
};
const feet: BedCell = { x: 0, y: 1, z: 0 };

describe('shelter: enclosure planning', () => {
  it('lists the 8 side cells and the cell above the head', () => {
    const { sides, top } = enclosureCells(feet);
    expect(sides).toHaveLength(8);
    expect(top).toEqual({ x: 0, y: 3, z: 0 });
    expect(new Set(sides.map((c) => c.y))).toEqual(new Set([1, 2]));
  });

  it('on open flat ground needs 8 walls + roof + one scaffold = 10, scaffold before the roof', () => {
    const p = planEnclosure(worldOf([]), feet);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.needed).toBe(10);
    const scaffoldAt = p.steps.findIndex((s) => s.kind === 'scaffold');
    const topAt = p.steps.findIndex((s) => s.kind === 'top');
    expect(scaffoldAt).toBeGreaterThan(-1);
    expect(scaffoldAt).toBeLessThan(topAt);
    expect(p.steps[0].cell.y).toBe(1);
  });

  it('counts only the missing cells: a nook with 3 walls already', () => {
    const walls: Array<[number, number, number]> = [];
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, -1]]) for (const y of [1, 2, 3]) walls.push([dx, y, dz]);
    const p = planEnclosure(worldOf(walls), feet);
    expect(p.ok && p.needed).toBe(3); // south feet + south head + roof (rests on the wall blocks beside it)
  });

  it('is already sealed when all nine cells are solid', () => {
    const cells: Array<[number, number, number]> = [];
    const { sides, top } = enclosureCells(feet);
    for (const c of [...sides, top]) cells.push([c.x, c.y, c.z]);
    const w = worldOf(cells);
    const p = planEnclosure(w, feet);
    expect(p.ok && p.needed).toBe(0);
    expect(openCells(w, feet)).toEqual([]);
  });

  it('names an open cell', () => {
    const cells: Array<[number, number, number]> = [];
    const { sides, top } = enclosureCells(feet);
    for (const c of [...sides.slice(1), top]) cells.push([c.x, c.y, c.z]);
    expect(openCells(worldOf(cells), feet)).toEqual([sides[0]]);
  });

  it('refuses a cell that cannot be built over, and lava', () => {
    const fence = planEnclosure(worldOf([], { occupied: ['1,1,0'] }), feet);
    expect(fence.ok).toBe(false);
    if (!fence.ok) expect(fence).toMatchObject({ reason: 'occupied', cell: { x: 1, y: 1, z: 0 } });
    const lava = planEnclosure(worldOf([], { lava: ['0,3,0'] }), feet);
    expect(lava.ok).toBe(false);
    if (!lava.ok) expect(lava.reason).toBe('lava');
  });
});

describe('shelter: dig down', () => {
  // Everything at y<=0 is solid in worldOf, so the hole (y=0 and y=-1, floor y=-2) has solid walls and floor.
  it('needs 2 blocks (scaffold + cap) where the ground is solid beside and below', () => {
    const p = planDigDown(worldOf([]), feet);
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.needed).toBe(2);
      expect(p.steps.map((s) => s.kind).sort()).toEqual(['scaffold', 'top']);
    }
  });

  it('is refused when the floor below the hole is not solid', () => {
    const w: DigView = { ...worldOf([]), solid: (c) => c.y <= 0 && c.y > -2 };
    expect(planDigDown(w, feet).ok).toBe(false);
  });

  it('is refused when the ground cannot be dug with what is held', () => {
    expect(planDigDown({ ...worldOf([]), diggable: () => false }, feet).ok).toBe(false);
  });

  it('is refused when a side of the hole is open', () => {
    const w: DigView = { ...worldOf([]), solid: (c) => c.y <= 0 && !(c.x === 1 && c.y === 0 && c.z === 0) };
    expect(planDigDown(w, feet).ok).toBe(false);
  });
});

describe('shelter: method choice and counting', () => {
  it('picks the hole on open ground (2 vs 10) and says how many are missing', () => {
    const w = worldOf([]);
    const walls = planEnclosure(w, feet);
    const hole = planDigDown(w, feet);
    expect(chooseMethod(walls, hole, 16)).toMatchObject({ method: 'hole', needed: 2, short: 0, other: { method: 'walls', needed: 10 } });
    expect(chooseMethod(walls, hole, 1)).toMatchObject({ method: 'hole', short: 1 });
    expect(chooseMethod(walls, null, 4)).toMatchObject({ method: 'walls', needed: 10, short: 6 });
  });

  it('prefers walls on a tie and explains when nothing works', () => {
    expect(chooseMethod({ ok: true, steps: [], needed: 2 }, { ok: true, cells: [feet, feet], steps: [], needed: 2 }, 5)).toMatchObject({ method: 'walls' });
    const none = chooseMethod({ ok: false, reason: 'lava', cell: feet, message: 'Lava near.' }, { ok: false, message: 'floor is air' }, 5);
    expect(none.method).toBe('none');
    if (none.method === 'none') expect(none.why).toMatch(/Lava near.*floor is air/);
  });
});

describe('shelter: which blocks are used', () => {
  const full = () => true;
  it('ranks cheap blocks first and skips valuables and falling blocks', () => {
    expect(shelterRank('dirt')).toBe(0);
    expect(shelterRank('oak_planks')).toBe(1);
    for (const n of ['sand', 'gravel', 'iron_block', 'diamond_ore', 'chest', 'crafting_table', 'tnt', 'white_concrete_powder', 'oak_leaves', 'white_bed']) expect(shelterRank(n)).toBe(-1);
    const picked = pickShelterBlocks([{ name: 'oak_planks', count: 20 }, { name: 'dirt', count: 5 }, { name: 'sand', count: 64 }, { name: 'dirt', count: 3 }, { name: 'cobblestone', count: 9 }], full);
    expect(picked.map((p) => p.name)).toEqual(['cobblestone', 'dirt', 'oak_planks']);
    expect(picked.find((p) => p.name === 'dirt')!.count).toBe(8);
  });

  it('drops items that are not one full cube', () => {
    expect(pickShelterBlocks([{ name: 'stone_slab', count: 5 }, { name: 'dirt', count: 1 }], (n) => n !== 'stone_slab').map((p) => p.name)).toEqual(['dirt']);
  });
});

describe('skill arguments and preconditions', () => {
  it('are registered with sensible args', () => {
    const r = buildRegistry();
    expect(r.has('sleep')).toBe(true);
    expect(r.has('shelter')).toBe(true);
    expect(sleepSkill.args.safeParse({}).success).toBe(true);
    expect(sleepSkill.args.safeParse({ x: 1, y: 70, z: 3 }).success).toBe(true);
    expect(shelterSkill.args.parse({}).open_after).toBe(true);
    expect(shelterSkill.args.safeParse({ minutes: 0 }).success).toBe(false);
    expect(shelterSkill.args.safeParse({ until: 'morning' }).success).toBe(true);
    expect(shelterSkill.args.safeParse({ until: 'noon' }).success).toBe(false);
  });

  // A tiny bot: flat stone ground at y<=0, the bot standing at y=1.
  const stone = (p: Vec3) => ({ name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]], position: p, hardness: 1.5, digTime: () => 100 });
  const bot = (over: Record<string, any> = {}, items: Array<{ name: string; count: number }> = []): any => ({
    entity: { position: new Vec3(0.5, 1, 0.5) },
    time: { timeOfDay: 14000 },
    game: { dimension: 'overworld' },
    isRaining: false,
    thunderState: 0,
    entities: {},
    registry: {
      blocksByName: { dirt: { boundingBox: 'block', id: 1 }, cobblestone: { boundingBox: 'block', id: 2 }, red_bed: { id: 9, name: 'red_bed' } },
      blockCollisionShapes: { blocks: { dirt: 1, cobblestone: 1 }, shapes: { 1: [[0, 0, 0, 1, 1, 1]] } },
    },
    inventory: { items: () => items.map((i, n) => ({ slot: 9 + n, ...i })) },
    findBlocks: () => [],
    blockAt: (p: Vec3) => (p.y <= 0 ? stone(p) : { name: 'air', boundingBox: 'empty', position: p }),
    ...over,
  });
  const ctx = (b: any) => ({ bot: b, signal: new AbortController().signal, log: () => undefined });

  it('sleep: refuses by day, in the nether, with a partial position and with no bed anywhere', async () => {
    expect(await sleepSkill.check(ctx(bot({ time: { timeOfDay: 6000 } })), {})).toMatchObject({ ok: false, cause: 'blocked' });
    expect(await sleepSkill.check(ctx(bot({ game: { dimension: 'the_nether' } })), {})).toMatchObject({ ok: false, cause: 'too_dangerous' });
    expect(await sleepSkill.check(ctx(bot()), {})).toMatchObject({ ok: false, cause: 'missing_item' });
    expect(await sleepSkill.check(ctx(bot()), { x: 1 } as any)).toMatchObject({ ok: false, cause: 'invalid_args' });
  });

  it('sleep: a held bed item makes it possible', async () => {
    const r = await sleepSkill.check(ctx(bot({}, [{ name: 'red_bed', count: 1 }])), {});
    expect(r.ok).toBe(true);
  });

  it('shelter: with stone below and no pickaxe only walls apply; it reports the exact shortfall', async () => {
    const noPick = bot({ blockAt: (p: Vec3) => (p.y <= 0 ? { ...stone(p), digTime: () => Infinity } : { name: 'air', boundingBox: 'empty', position: p }) }, [{ name: 'dirt', count: 4 }]);
    const r = await shelterSkill.check(ctx(noPick), {});
    expect(r).toMatchObject({ ok: false, cause: 'missing_item' });
    if (!r.ok) expect(r.message).toMatch(/needs 10 placeable blocks.*holds 4.*Needs 6 more/);
    const enough = bot({ blockAt: noPick.blockAt }, [{ name: 'dirt', count: 10 }]);
    expect((await shelterSkill.check(ctx(enough), {})).ok).toBe(true);
  });

  it('shelter: refuses by day without minutes, allows it with minutes', async () => {
    const noPick = (t: number) => bot({ time: { timeOfDay: t }, blockAt: (p: Vec3) => (p.y <= 0 ? { ...stone(p), digTime: () => Infinity } : { name: 'air', boundingBox: 'empty', position: p }) }, [{ name: 'dirt', count: 16 }]);
    expect(await shelterSkill.check(ctx(noPick(6000)), {})).toMatchObject({ ok: false, cause: 'invalid_args' });
    expect((await shelterSkill.check(ctx(noPick(6000)), { minutes: 1 })).ok).toBe(true);
  });

  it('shelter: refuses off solid ground', async () => {
    const air = bot({ blockAt: (p: Vec3) => ({ name: 'air', boundingBox: 'empty', position: p }) }, [{ name: 'dirt', count: 16 }]);
    expect(await shelterSkill.check(ctx(air), {})).toMatchObject({ ok: false, cause: 'blocked' });
  });
});
