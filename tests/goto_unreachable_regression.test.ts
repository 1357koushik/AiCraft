import { describe, it, expect, vi } from 'vitest';
import { Vec3 } from 'vec3';
import { movementActions } from '../src/actions/movement.js';
import { evaluateCandidateTarget } from '../src/actions/navigator.js';
import { updatePathfinderMovements } from '../src/actions/techniques.js';
import { ActionExecutionContext, Observation } from '../src/types/index.js';

describe('Regression: goto Unreachable Floating Target & Pillar Restriction', () => {
  const createMockBot = (botPos: Vec3 = new Vec3(0, 64, 0)) => {
    const blocks: Record<string, any> = {};

    // By default, ground at y=63 is stone, everything else is air
    const getBlockKey = (p: Vec3) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;

    const bot: any = {
      entity: {
        position: botPos.clone(),
        yaw: 0,
        pitch: 0,
        isInWater: false,
      },
      registry: {
        blocksByName: {
          air: { id: 0, name: 'air' },
          stone: { id: 1, name: 'stone' },
          dirt: { id: 2, name: 'dirt' },
        },
        itemsByName: {
          dirt: { id: 2, name: 'dirt' },
        },
      },
      pathfinder: {
        movements: {
          blocksToAvoid: new Set(),
          blocksCantBreak: new Set(),
          scafoldingBlocks: [],
          allow1by1towers: true,
        },
        setMovements: vi.fn((m) => {
          bot.pathfinder.movements = m;
        }),
        goto: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn(),
      },
      inventory: {
        items: () => [{ type: 2, name: 'dirt', count: 64 }],
      },
      blockAt: vi.fn((pos: Vec3) => {
        const key = getBlockKey(pos);
        if (blocks[key]) return blocks[key];
        if (Math.floor(pos.y) < 64) {
          return { name: 'stone', boundingBox: 'block', position: pos.floored() };
        }
        return { name: 'air', boundingBox: 'empty', position: pos.floored() };
      }),
      setBlock: (pos: Vec3, name: string) => {
        blocks[getBlockKey(pos)] = { name, boundingBox: name === 'air' ? 'empty' : 'block', position: pos.floored() };
      },
      clearControlStates: vi.fn(),
    };

    return bot;
  };

  const createMockCtx = (bot: any): ActionExecutionContext => ({
    bot,
    observation: {
      version: '1.21.6',
      timestamp: Date.now(),
      vitals: {
        health: 20,
        food: 20,
        oxygen: 20,
        isAlive: true,
        movementState: {
          inWater: false,
          isSneaking: false,
          isSprinting: false,
          isSleeping: false,
          isRiding: false,
          elevation: 64,
        },
      },
      inventory: {
        mainHand: null,
        offHand: null,
        armor: { head: null, torso: null, legs: null, feet: null },
        hotbar: [],
        items: [],
        aggregates: { totalSlots: 36, occupiedSlots: 0, emptySlots: 36, totalItemCounts: {} },
        craftableNow: [],
      },
      blocks: { standingOn: 'stone', notableBlocks: [] },
      entities: [],
      chat: { lastMessages: [] },
      container: { isOpen: false, type: null, title: null, totalSlots: 0, occupiedSlots: 0, items: [] },
      delta: { timeDeltaMs: 50, inventoryGained: [], inventoryLost: [], healthDelta: 0, blockInteractionsDetected: [] },
      activeGoal: null,
      memory: { currentGoal: null, subTasks: [], keyCheckpoints: [], quarantinedCorruptedData: [] },
    },
    config: { perception: { scanRadius: 16 } },
  });

  it('evaluates floating sky target (y+40 in mid-air) as invalid UNREACHABLE during preflight', () => {
    const bot = createMockBot(new Vec3(0, 64, 0));
    const target = new Vec3(0, 104, 0);

    const assessment = evaluateCandidateTarget(bot, target, {
      intent: '3d',
      maxDistance: 64,
    });

    expect(assessment.valid).toBe(false);
    expect(assessment.failureKind).toBe('UNREACHABLE');
    expect(assessment.rejectionReason).toContain('floating in mid-air with no solid footing');
  });

  it('rejects goto immediately with failed status when destination is floating in mid-air without attempting to pathfind or pillar', async () => {
    const bot = createMockBot(new Vec3(0, 64, 0));
    const ctx = createMockCtx(bot);
    const gotoAction = movementActions.find((a) => a.name === 'goto')!;

    const result = await gotoAction.execute(bot, { x: 0, y: 104, z: 0, range: 1.5 }, ctx);

    expect(result.status).toBe('failed');
    expect(result.reason).toContain('floating in mid-air with no solid footing');
    expect(bot.pathfinder.goto).not.toHaveBeenCalled();
  });

  it('configures pathfinder movements with allow1by1towers=false by default to forbid general navigation pillaring', () => {
    const bot = createMockBot(new Vec3(0, 64, 0));
    const movements = updatePathfinderMovements(bot);

    expect(movements).not.toBeNull();
    expect(movements!.allow1by1towers).toBe(false);
  });

  it('records preflight-rejected candidate to navigationBlacklist for instant fast-path rejection on retry', async () => {
    const bot = createMockBot(new Vec3(0, 64, 0));
    const ctx = createMockCtx(bot);
    const gotoAction = movementActions.find((a) => a.name === 'goto')!;
    const skyPos = { x: 5, y: 110, z: 5 };

    const firstResult = await gotoAction.execute(bot, { ...skyPos, range: 1.5 }, ctx);
    expect(firstResult.status).toBe('failed');

    // Second attempt should be immediately rejected via blacklist
    const secondResult = await gotoAction.execute(bot, { ...skyPos, range: 1.5 }, ctx);
    expect(secondResult.status).toBe('failed');
    expect(secondResult.reason).toContain('blacklisted');
  });

  it('rejects target completely obstructed inside solid block wall without calling pathfinder', async () => {
    const bot = createMockBot(new Vec3(0, 64, 0));
    bot.setBlock(new Vec3(2, 64, 0), 'stone');
    bot.setBlock(new Vec3(2, 65, 0), 'stone');
    const ctx = createMockCtx(bot);
    const gotoAction = movementActions.find((a) => a.name === 'goto')!;

    const result = await gotoAction.execute(bot, { x: 2, y: 64, z: 0, range: 1.0 }, ctx);
    expect(result.status).toBe('failed');
    expect(result.reason).toContain('completely obstructed by solid blocks');
    expect(bot.pathfinder.goto).not.toHaveBeenCalled();
  });

  it('detects false arrival if pathfinder goto resolves but bot is still far from target', async () => {
    const bot = createMockBot(new Vec3(0, 64, 0));
    // Path finder resolves without bot moving
    bot.pathfinder.goto = vi.fn().mockResolvedValue(undefined);
    const ctx = createMockCtx(bot);
    const gotoAction = movementActions.find((a) => a.name === 'goto')!;

    const result = await gotoAction.execute(bot, { x: 10, y: 64, z: 10, range: 1.5, verifyArrival: true }, ctx);
    expect(result.status).toBe('failed');
    expect(result.reason).toContain('exceeds range');
  });

  it('allows allow1by1towers=true only when explicit allowPillaring option is passed', () => {
    const bot = createMockBot(new Vec3(0, 64, 0));
    const movements = updatePathfinderMovements(bot, { allowPillaring: true });

    expect(movements).not.toBeNull();
    expect(movements!.allow1by1towers).toBe(true);
  });
});
