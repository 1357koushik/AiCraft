import { describe, it, expect } from 'vitest';
import { Vec3 } from 'vec3';
import { isGuardTarget, threatsNear } from '../src/skills/guard.js';
import { guardSkill } from '../src/skills/guard.js';
import { buildRegistry } from '../src/skills/registry.js';

const mob = (id: number, name: string, x: number, z: number, extra: Record<string, unknown> = {}) => ({ id, name, position: new Vec3(x, 0, z), ...extra });

describe('guard targets', () => {
  it('attacks hostile mobs only', () => {
    for (const n of ['zombie', 'skeleton', 'creeper', 'spider', 'husk']) expect(isGuardTarget(n)).toBe(true);
    for (const n of ['player', 'villager', 'iron_golem', 'wolf', 'enderman', 'piglin', 'zombified_piglin', 'bee', 'cow', 'cat', undefined]) expect(isGuardTarget(n as string | undefined)).toBe(false);
  });

  it('orders threats by distance from the protected spot, not from the bot', () => {
    const spot = new Vec3(0, 0, 0);
    const list = [mob(1, 'zombie', 10, 0), mob(2, 'skeleton', 4, 0), mob(3, 'zombie', 30, 0), mob(4, 'cow', 1, 0), mob(5, 'enderman', 2, 0)];
    const t = threatsNear(list, spot, 12, new Map(), 0);
    expect(t.map((x) => x.entity.id)).toEqual([2, 1]);
  });

  it('skips ignored, dead and invalid mobs and the bot itself', () => {
    const spot = new Vec3(0, 0, 0);
    const self = mob(9, 'zombie', 1, 0);
    const list = [mob(1, 'zombie', 3, 0), mob(2, 'zombie', 4, 0, { isValid: false }), mob(3, 'zombie', 5, 0), self];
    const t = threatsNear(list, spot, 12, new Map([[1, 1000]]), 500, self);
    expect(t.map((x) => x.entity.id)).toEqual([3]);
    expect(threatsNear(list, spot, 12, new Map([[1, 1000]]), 1500, self).map((x) => x.entity.id)).toEqual([1, 3]);
  });
});

describe('guard arguments', () => {
  it('is in the registry and takes optional player, place, radius and minutes', () => {
    expect(buildRegistry().has('guard')).toBe(true);
    expect(guardSkill.args.safeParse({}).success).toBe(true);
    expect(guardSkill.args.parse({ player: 'OwnerPlayer', minutes: 1 }).radius).toBe(12);
    expect(guardSkill.args.safeParse({ place: { x: 1, y: 2, z: 3 }, radius: 20 }).success).toBe(true);
    expect(guardSkill.args.safeParse({ radius: 1 }).success).toBe(false);
    expect(guardSkill.args.safeParse({ minutes: 0 }).success).toBe(false);
  });
});
