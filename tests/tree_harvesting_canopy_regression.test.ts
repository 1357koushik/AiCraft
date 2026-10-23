import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Vec3 } from 'vec3';
import {
  findConnectedTreeLogs,
  techniqueChopTreeFull,
  clearFailedTreeBlacklist,
} from '../src/actions/techniques.js';

describe('Regression Reproduction: Tree harvesting chooses unreachable canopy blocks before base trunk', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearFailedTreeBlacklist();
  });

  it('FAILING BEFORE FIX: findConnectedTreeLogs initiated from an elevated canopy log fails to discover lower trunk logs', () => {
    // Tree layout:
    // Ground level: Y=64
    // Trunk: (10, 64, 10), (10, 65, 10), (10, 66, 10), (10, 67, 10)
    // Canopy branch: (9, 66, 10)
    const blocks: Record<string, any> = {
      '10,64,10': { name: 'oak_log', position: new Vec3(10, 64, 10) },
      '10,65,10': { name: 'oak_log', position: new Vec3(10, 65, 10) },
      '10,66,10': { name: 'oak_log', position: new Vec3(10, 66, 10) },
      '10,67,10': { name: 'oak_log', position: new Vec3(10, 67, 10) },
      '9,66,10': { name: 'oak_log', position: new Vec3(9, 66, 10) }, // canopy branch
      '10,68,10': { name: 'oak_leaves', position: new Vec3(10, 68, 10) },
    };

    const mockBot: any = {
      blockAt: (pos: Vec3) => blocks[`${pos.x},${pos.y},${pos.z}`] || null,
    };

    const canopyLog = blocks['9,66,10'];
    const discovered = findConnectedTreeLogs(mockBot, canopyLog, 16);

    // Expected: All 5 logs discovered, starting from base Y=64 up to Y=67
    // Actual (before fix): Only 2 logs discovered (Y=66 and Y=67), lower trunk logs at Y=64 and Y=65 are missed!
    expect(discovered.length).toBe(5);
    expect(discovered[0].position.y).toBe(64); // lowest base log first
    expect(discovered.some((b) => b.position.y === 64)).toBe(true);
    expect(discovered.some((b) => b.position.y === 65)).toBe(true);
  });

  it('FAILING BEFORE FIX: candidate selection targets the base trunk at Y=64 even when canopy log is closer in 3D distance', async () => {
    // Bot is standing at (8, 66, 10) on elevated terrain
    // Distance to canopy log (9, 66, 10) is 1.0m
    // Distance to base trunk (10, 64, 10) is 2.83m
    const botPos = new Vec3(8, 66, 10);
    const canopyLogPos = new Vec3(9, 66, 10);
    const trunkBasePos = new Vec3(10, 64, 10);

    const blocks: Record<string, any> = {
      '10,64,10': { name: 'oak_log', position: trunkBasePos },
      '10,65,10': { name: 'oak_log', position: new Vec3(10, 65, 10) },
      '10,66,10': { name: 'oak_log', position: new Vec3(10, 66, 10) },
      '10,67,10': { name: 'oak_log', position: new Vec3(10, 67, 10) },
      '9,66,10': { name: 'oak_log', position: canopyLogPos },
    };

    const targetedGoals: any[] = [];
    const mockBot: any = {
      entity: { position: botPos },
      inventory: {
        items: () => [],
        emptySlotCount: () => 35,
      },
      findBlocks: vi.fn().mockReturnValue([canopyLogPos, trunkBasePos]),
      blockAt: (pos: Vec3) => blocks[`${pos.x},${pos.y},${pos.z}`] || null,
      pathfinder: {
        goto: vi.fn().mockImplementation(async (goal: any) => {
          targetedGoals.push(goal);
          // If approach targets the airborne canopy log at Y=66, simulate failure or verify destination
          return;
        }),
      },
      dig: vi.fn().mockResolvedValue(undefined),
    };

    await techniqueChopTreeFull(mockBot, 16, undefined, undefined, { count: 1 });

    // Expected: First pathfinding goal MUST target the base trunk at Y=64, NOT the airborne canopy at Y=66
    expect(targetedGoals.length).toBeGreaterThan(0);
    const firstGoal = targetedGoals[0];
    expect(firstGoal.y).toBe(64);
    expect(firstGoal.x).toBe(10);
    expect(firstGoal.z).toBe(10);
  });
});
