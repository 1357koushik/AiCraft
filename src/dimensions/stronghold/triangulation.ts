import { Vec3 } from 'vec3';

export interface EyeThrow {
  playerPos: { x: number; z: number };
  yawDegrees: number; // In Minecraft: 0 = South (+Z), 90 = West (-X), 180 = North (-Z), 270 = East (+X)
}

/**
 * Converts Minecraft yaw degrees into a normalized horizontal 2D direction vector (dx, dz).
 * In Minecraft Java:
 * dx = -sin(yaw)
 * dz = cos(yaw)
 */
export function yawToDirectionVector(yawDegrees: number): { dx: number; dz: number } {
  const rad = (yawDegrees * Math.PI) / 180;
  const dx = -Math.sin(rad);
  const dz = Math.cos(rad);
  return { dx, dz };
}

/**
 * Calculates the exact 2D (X, Z) Stronghold coordinates by computing the intersection
 * of two Eye of Ender flight rays thrown from different positions.
 */
export function triangulateStronghold(
  throw1: EyeThrow,
  throw2: EyeThrow
): { x: number; z: number } | null {
  const v1 = yawToDirectionVector(throw1.yawDegrees);
  const v2 = yawToDirectionVector(throw2.yawDegrees);

  const x1 = throw1.playerPos.x;
  const z1 = throw1.playerPos.z;
  const x2 = throw2.playerPos.x;
  const z2 = throw2.playerPos.z;

  // Line 1: P1 + t * v1
  // Line 2: P2 + u * v2
  // x1 + t * v1.dx = x2 + u * v2.dx  =>  v1.dx * t - v2.dx * u = x2 - x1
  // z1 + t * v1.dz = z2 + u * v2.dz  =>  v1.dz * t - v2.dz * u = z2 - z1

  const det = v2.dx * v1.dz - v1.dx * v2.dz;
  if (Math.abs(det) < 1e-5) {
    // Rays are parallel or collinear; cannot triangulate
    return null;
  }

  const dxDiff = x2 - x1;
  const dzDiff = z2 - z1;

  // Cramer's rule for t:
  // numT = (x2 - x1) * (-v2.dz) - (z2 - z1) * (-v2.dx)
  const numT = -dxDiff * v2.dz + dzDiff * v2.dx;
  const t = numT / det;

  // Target coordinates
  const strongholdX = Math.round(x1 + t * v1.dx);
  const strongholdZ = Math.round(z1 + t * v1.dz);

  return { x: strongholdX, z: strongholdZ };
}
