import { describe, it, expect, vi } from 'vitest';
import { AvailabilityEngine } from '../src/actions/availability.js';
import { loadConfig } from '../src/config/index.js';
import { allActions, actionMap } from '../src/actions/registry.js';

describe('Availability Engine & Action Revalidation', () => {
  const config = loadConfig();

  const mockObs: any = {
    vitals: {
      isAlive: true,
      food: 15,
      movementState: { isSleeping: false, isRiding: false, onGround: true, inWater: false },
    },
    inventory: {
      mainInventory: [{ name: 'bread', count: 2 }],
      foodList: [{ name: 'bread', count: 2, foodPoints: 5, saturation: 6 }],
      aggregates: { totalItemCounts: { bread: 2 }, freeSlots: 30 },
      toolSummary: { bestHoe: 'iron_hoe' },
      placeableBlocks: {},
      craftableNow: [],
    },
    blocks: {
      notableBlocks: [{ name: 'oak_log', count: 5, nearestDistance: 3 }],
      walkability: { north: 'free', south: 'free', east: 'free', west: 'free' },
      hazards: [],
    },
    entities: [{ id: 'e1', name: 'zombie', isHostile: true, isOwner: false }],
    container: { isOpen: false },
    position: { blockCoords: { x: 0, y: 64, z: 0 }, dimension: 'overworld' },
    environment: { dayPhase: 'day', weather: 'clear' },
  };

  it('computes catalog containing valid legal actions', () => {
    const catalog = AvailabilityEngine.computeAvailableCatalog({} as any, mockObs, config, null);
    const actionNames = catalog.map((a) => a.action);

    expect(actionNames).toContain('goto');
    expect(actionNames).toContain('eat');
    expect(actionNames).toContain('attack');
    expect(actionNames).toContain('wait');
    // Blocked action should not be in catalog
    expect(actionNames).not.toContain('run_command');
  });

  it('verifies that every action in the registry has complete metadata and valid callbacks', () => {
    expect(allActions.length).toBe(actionMap.size);
    expect(allActions.length).toBeGreaterThanOrEqual(50);

    const validCategories = [
      'movement',
      'mining_building',
      'inventory_crafting',
      'combat',
      'world_interaction',
      'meta',
    ];

    for (const act of allActions) {
      expect(typeof act.name).toBe('string');
      expect(act.name.length).toBeGreaterThan(0);
      expect(validCategories).toContain(act.category);
      expect(typeof act.description).toBe('string');
      expect(typeof act.parameterSchema).toBe('object');
      expect(typeof act.isAvailable).toBe('function');
      expect(typeof act.execute).toBe('function');
    }
  });

  it('revalidates actions at runtime before execution', () => {
    const validCheck = AvailabilityEngine.revalidateAction('eat', {}, {} as any, mockObs, config, null);
    expect(validCheck.valid).toBe(true);

    const invalidCheck = AvailabilityEngine.revalidateAction('sleep', {}, {} as any, mockObs, config, null);
    expect(invalidCheck.valid).toBe(false); // not night and no bed
  });
});
