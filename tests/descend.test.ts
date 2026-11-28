import { describe, it, expect } from 'vitest';
import { Vec3 } from 'vec3';
import { deepTargetY, descentTarget, liquidNear, oreVariants, shaftBad, stepHazard } from '../src/skills/descend.js';

/** A tiny world: everything is stone except the listed cells. */
function world(cells: Record<string, string>, fill = 'stone') {
  return (p: Vec3) => cells[`${p.x},${p.y},${p.z}`] ?? fill;
}
const solidIn = (name: (p: Vec3) => string | null) => (p: Vec3) => !['air', 'lava', 'water'].includes(name(p) ?? 'air');

describe('oreVariants', () => {
  const has = (n: string) => ['diamond_ore', 'deepslate_diamond_ore', 'iron_ore', 'deepslate_iron_ore', 'stone', 'quartz_ore'].includes(n);
  it('maps an ore to both of its kinds', () => {
    expect(oreVariants('diamond_ore', has)).toEqual(['diamond_ore', 'deepslate_diamond_ore']);
    expect(oreVariants('deepslate_diamond_ore', has)).toEqual(['diamond_ore', 'deepslate_diamond_ore']);
  });
  it('leaves other blocks and ores without a deepslate kind alone', () => {
    expect(oreVariants('stone', has)).toEqual(['stone']);
    expect(oreVariants('quartz_ore', has)).toEqual(['quartz_ore']);
  });
});

describe('depth choice', () => {
  it('only deep ores need digging down', () => {
    expect(deepTargetY('diamond_ore')).toBe(-58);
    expect(deepTargetY('deepslate_diamond_ore')).toBe(-58);
    expect(deepTargetY('iron_ore')).toBeNull();
  });
  it('goes to the best level when no ore is known, and only as deep as a known ore otherwise', () => {
    expect(descentTarget('diamond_ore', 72, null)).toBe(-58);
    expect(descentTarget('diamond_ore', 72, 10)).toBe(10);
    expect(descentTarget('diamond_ore', 72, -62)).toBe(-58);
  });
  it('does not dig when already close to the level, or for ordinary ores', () => {
    expect(descentTarget('diamond_ore', -56, null)).toBeNull();
    expect(descentTarget('diamond_ore', 12, 10)).toBeNull();
    expect(descentTarget('iron_ore', 72, null)).toBeNull();
  });
});

describe('lava and water next to a dig', () => {
  const feet = new Vec3(0, 10, 0);
  const east = new Vec3(1, 0, 0);
  it('is safe in plain stone', () => {
    const name = world({});
    expect(liquidNear(name, new Vec3(1, 10, 0))).toBe(false);
    expect(stepHazard(name, solidIn(name), feet, east)).toBeNull();
  });
  it('refuses lava on any of the six sides of a cell it will dig', () => {
    for (const off of [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 1, 0), new Vec3(0, -1, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]) {
      const c = new Vec3(1, 10, 0);
      const p = c.plus(off);
      const name = world({ [`${p.x},${p.y},${p.z}`]: 'lava' });
      expect(liquidNear(name, c), `lava at offset ${off}`).toBe(true);
    }
  });
  it('refuses a step whose head, foot or lower cell touches lava, or whose floor is lava', () => {
    expect(stepHazard(world({ '1,12,0': 'lava' }), () => true, feet, east)).toMatch(/liquid/); // above the head cell
    expect(stepHazard(world({ '2,10,0': 'water' }), () => true, feet, east)).toMatch(/liquid/);
    const lavaFloor = world({ '1,8,0': 'lava' });
    expect(stepHazard(lavaFloor, solidIn(lavaFloor), feet, east)).toMatch(/liquid/);
  });
  it('refuses an open drop under the new foot cell and bedrock', () => {
    const cave = world({ '1,8,0': 'air' });
    expect(stepHazard(cave, solidIn(cave), feet, east)).toMatch(/no solid floor/);
    expect(stepHazard(world({ '1,9,0': 'bedrock' }), () => true, feet, east)).toMatch(/bedrock/);
  });
  it('treats unloaded ground as unsafe', () => {
    expect(liquidNear(() => null, feet)).toBe(true);
  });
  it('lava two cells away is not a problem', () => {
    const name = world({ '3,10,0': 'lava' });
    expect(stepHazard(name, solidIn(name), feet, east)).toBeNull();
  });
});

describe('choosing a shaft column', () => {
  it('counts caves, liquid and unloaded cells around the shaft, and ignores rock beyond the ring', () => {
    expect(shaftBad(world({}), 0, 0, -10, 10)).toBe(0);
    expect(shaftBad(world({ '2,0,2': 'air' }), 0, 0, -10, 10)).toBe(1); // the outer ring counts
    expect(shaftBad(world({ '3,0,3': 'air' }), 0, 0, -10, 10)).toBe(0); // beyond it does not
    expect(shaftBad(world({ '0,-5,0': 'lava', '1,-6,1': 'water' }), 0, 0, -10, 10)).toBe(2);
    expect(shaftBad(world({ '0,20,0': 'air' }), 0, 0, -10, 10)).toBe(0); // above the top does not
    expect(shaftBad(() => null, 0, 0, 0, 0)).toBe(16);
  });
  it('stops counting past the limit', () => {
    expect(shaftBad(world({}, 'air'), 0, 0, -10, 10, 5)).toBe(6);
  });
});

describe('digPickaxeName', () => {
  it('digs with the weakest pickaxe of stone tier or better, keeping iron for the ore', async () => {
    const { digPickaxeName } = await import('../src/skills/descend.js');
    expect(digPickaxeName(['iron_pickaxe', 'stone_pickaxe', 'torch'])).toBe('stone_pickaxe');
    expect(digPickaxeName(['iron_pickaxe', 'wooden_pickaxe'])).toBe('iron_pickaxe');
    expect(digPickaxeName(['wooden_pickaxe'])).toBe('wooden_pickaxe');
    expect(digPickaxeName(['diamond_pickaxe', 'iron_pickaxe'])).toBe('iron_pickaxe');
    expect(digPickaxeName(['torch'])).toBeNull();
  });
});

describe('pickaxesToCraft', () => {
  it('makes enough stone pickaxes for the staircase, limited by sticks and stone', async () => {
    const { pickaxesToCraft } = await import('../src/skills/descend.js');
    // 130 levels at 3.5 digs each is 455 digs: 4 stone pickaxes (131 uses each).
    expect(pickaxesToCraft(130, 1, 8, 16)).toBe(3);
    expect(pickaxesToCraft(130, 0, 8, 16)).toBe(4);
    expect(pickaxesToCraft(130, 0, 2, 16)).toBe(1);
    expect(pickaxesToCraft(130, 0, 8, 5)).toBe(1);
    expect(pickaxesToCraft(20, 1, 8, 16)).toBe(0);
  });
});
