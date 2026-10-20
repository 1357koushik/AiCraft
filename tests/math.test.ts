import { describe, it, expect } from 'vitest';
import { getFacing, distance3D, manhattanDistance, isWithinBounds } from '../src/utils/math.js';

describe('Math and Geometry Utilities', () => {
  it('correctly maps yaw to cardinal facing directions', () => {
    // 0 rad = south
    expect(getFacing(0)).toBe('south');
    // Math.PI / 2 = west
    expect(getFacing(Math.PI / 2)).toBe('west');
    // Math.PI = north
    expect(getFacing(Math.PI)).toBe('north');
    // -Math.PI / 2 or 3 * Math.PI / 2 = east
    expect(getFacing(-Math.PI / 2)).toBe('east');
  });

  it('computes 3D euclidean distance and manhattan distance', () => {
    const a = { x: 0, y: 0, z: 0 };
    const b = { x: 3, y: 0, z: 4 };
    expect(distance3D(a, b)).toBe(5);
    expect(manhattanDistance(a, b)).toBe(7);
  });

  it('enforces safe bounding radius', () => {
    const origin = { x: 100, y: 64, z: 100 };
    const inside = { x: 110, y: 64, z: 115 };
    const outside = { x: 160, y: 64, z: 100 };

    expect(isWithinBounds(inside, origin, 32)).toBe(true);
    expect(isWithinBounds(outside, origin, 32)).toBe(false);
  });
});
