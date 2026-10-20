import { describe, it, expect, vi } from 'vitest';
import { Vec3 } from 'vec3';
import { loadConfig } from '../src/config/index.js';
import { buildObservation } from '../src/perception/index.js';

describe('Perception & Observation Builder', () => {
  it('correctly constructs observation from bot world state', () => {
    const config = loadConfig();

    const mockBot: any = {
      username: 'AIAgentBot',
      health: 16.5,
      food: 18,
      foodSaturation: 4.2,
      oxygenLevel: 20,
      isAlive: true,
      game: { gameMode: 'survival', dimension: 'overworld', difficulty: 'normal' },
      entity: {
        position: new Vec3(10.2, 64.0, -15.8),
        velocity: new Vec3(0, 0, 0),
        yaw: 0,
        pitch: 0,
        onGround: true,
      },
      entities: {
        101: {
          id: 101,
          name: 'pig',
          type: 'passive',
          position: new Vec3(12, 64, -15),
          height: 0.9,
        },
      },
      inventory: {
        slots: new Array(46).fill(null),
        items: () => [
          { slot: 36, name: 'iron_pickaxe', count: 1, maxDurability: 250, durabilityUsed: 10 },
          { slot: 37, name: 'bread', count: 5 },
        ],
        emptySlotCount: () => 34,
      },
      registry: {
        blocksByName: {},
        items: {},
        itemsByName: {},
        effects: {},
      },
      time: { timeOfDay: 6000, age: 12000, moonPhase: 1 },
      blockAt: vi.fn().mockImplementation((pos: Vec3) => {
        if (pos.y < 64) return { name: 'grass_block', boundingBox: 'block' };
        return { name: 'air', boundingBox: 'empty' };
      }),
      blockAtCursor: vi.fn().mockReturnValue(null),
      entityAtCursor: vi.fn().mockReturnValue(null),
      findBlock: vi.fn().mockReturnValue(null),
      recipesAll: vi.fn().mockReturnValue([]),
      recipesFor: vi.fn().mockReturnValue([]),
      setControlState: vi.fn(),
      clearControlStates: vi.fn(),
    };

    const agentState: any = {
      currentGoal: 'Test Goal',
      planSteps: [],
      stepNumber: 1,
      stuckCounter: 0,
      timeSinceLastProgressSeconds: 0,
    };

    const memory: any = {
      namedLocations: {},
      facts: [],
      dangerZones: [],
      completedGoals: [],
    };

    const recentEvents: any = {
      damageTaken: [],
      healthRegained: 0,
      itemsPickedUp: [],
      itemsBroken: [],
      blocksBroken: [],
      blocksPlaced: [],
      mobsKilled: [],
      deathRespawn: false,
      chatMessages: [],
    };

    const obs = buildObservation(mockBot, config, agentState, memory, recentEvents, []);

    expect(obs.version).toBe('1.21.6');
    expect(obs.vitals.health).toBe(16.5);
    expect(obs.vitals.food).toBe(18);
    expect(obs.position.blockCoords).toEqual({ x: 10, y: 64, z: -16 });
    expect(obs.position.facing).toBe('south');
    expect(obs.environment.dayPhase).toBe('day');
    expect(obs.inventory.toolSummary.bestPickaxe).toBe('iron_pickaxe');
    expect(obs.inventory.foodList[0].name).toBe('bread');
    expect(obs.entities.length).toBe(1);
    expect(obs.entities[0].name).toBe('pig');
    expect(obs.blocks.localMap.grid.length).toBe(config.perception.localMapSize);
  });
});
