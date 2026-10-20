import { Vec3 } from 'vec3';
import { Bot } from 'mineflayer';
import { Facing } from '../types/index.js';

export function getFacing(yaw: number): Facing {
  // yaw in mineflayer: 0 = south, PI/2 = west, PI or -PI = north, 3*PI/2 or -PI/2 = east
  let normalizedYaw = yaw % (2 * Math.PI);
  if (normalizedYaw < 0) normalizedYaw += 2 * Math.PI;

  const deg = (normalizedYaw * 180) / Math.PI;
  if (deg >= 45 && deg < 135) {
    return 'west';
  } else if (deg >= 135 && deg < 225) {
    return 'north';
  } else if (deg >= 225 && deg < 315) {
    return 'east';
  } else {
    return 'south';
  }
}

export function distance3D(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function manhattanDistance(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z);
}

export function hasLineOfSight(bot: Bot, targetPos: Vec3): boolean {
  if (!bot.entity) return false;
  const eyePos = bot.entity.position.offset(0, bot.entity.height || 1.6, 0);
  const diff = targetPos.minus(eyePos);
  const dist = diff.norm();
  if (dist === 0) return true;

  const dir = diff.scaled(1 / dist);
  const step = 0.5;
  const numSteps = Math.floor(dist / step);

  for (let i = 1; i < numSteps; i++) {
    const currentPos = eyePos.plus(dir.scaled(i * step));
    const block = bot.blockAt(currentPos);
    if (block && block.boundingBox === 'block' && block.name !== 'air' && !block.name.includes('glass')) {
      return false; // Occluded
    }
  }

  return true;
}

export function isWithinBounds(
  pos: { x: number; y: number; z: number },
  origin: { x: number; y: number; z: number },
  maxHorizontalRadius: number,
  maxVerticalRadius: number = 32
): boolean {
  const dx = Math.abs(pos.x - origin.x);
  const dy = Math.abs(pos.y - origin.y);
  const dz = Math.abs(pos.z - origin.z);
  return dx <= maxHorizontalRadius && dz <= maxHorizontalRadius && dy <= maxVerticalRadius;
}
