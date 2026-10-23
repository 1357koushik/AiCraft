import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Vec3 } from 'vec3';
import { ActionArbiter, ActionPriority } from '../src/agent/arbiter.js';
import { ReflexLayer } from '../src/agent/reflex.js';
import { SafetySupervisor } from '../src/agent/supervisor.js';
import {
  FOOD_REGISTRY,
  selectBestFood,
  isHarmfulFood,
  isPoorEmergencyFood,
  isProtectedItem,
  DISPOSABLE_SURPLUS_ALLOWLIST,
  handleFullInventoryReliability,
  getToolDurabilityInfo,
  findBestHealthyTool,
  isWaterBucketClutchPermitted,
} from '../src/safety/survival_policy.js';
import { inventoryCraftingActions } from '../src/actions/inventory_crafting.js';
import { techniqueVacuumDrops } from '../src/actions/techniques.js';
import { loadConfig } from '../src/config/index.js';
import { ActionExecutionContext, Observation } from '../src/types/index.js';

describe('Phase 4: Survival & Inventory Reliability Subsystem', () => {
  let config: any;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    config = loadConfig();
    config.logging.level = 'error';
  });

  const createMockObservation = (overrides: Partial<Observation> = {}): Observation => ({
    version: '1.21.6',
    timestamp: Date.now(),
    vitals: {
      health: 20,
      food: 20,
      oxygen: 20,
      isAlive: true,
      armor: 0,
      underwater: false,
      isBurning: false,
      movementState: { onGround: true, inWater: false, isSleeping: false, isRiding: false, inLava: false },
      ...(overrides.vitals || {}),
    } as any,
    position: {
      x: 10,
      y: 64,
      z: 10,
      blockCoords: { x: 10, y: 64, z: 10 },
      velocity: { x: 0, y: 0, z: 0 },
      yaw: 0,
      pitch: 0,
      facing: 'north',
      dimension: 'overworld',
    } as any,
    environment: { dayPhase: 'day', weather: 'clear' } as any,
    statusEffects: [],
    inventory: {
      mainHand: null,
      offHand: null,
      heldItemHint: 'empty',
      aggregates: { totalItemCounts: {} },
      toolSummary: {},
      craftableNow: [],
      foodList: [],
      placeableBlocks: {},
      mainInventory: [],
    } as any,
    crosshair: {},
    blocks: { notableBlocks: [], hazards: [], walkability: { forward: true, back: true, left: true, right: true }, localMap: { ascii: '', legend: {} } } as any,
    entities: [],
    recentEvents: {} as any,
    container: { isOpen: false, type: null, slotsCount: 0, items: [] },
    agentState: { currentGoal: 'Survive', planSteps: [], stepNumber: 1, stuckCounter: 0, timeSinceLastProgressSeconds: 0 },
    memory: { namedLocations: {}, facts: [], dangerZones: [], completedGoals: [] },
    derived: { availableActions: [] },
    ...overrides,
  });

  const createMockBot = (options: {
    health?: number;
    food?: number;
    oxygen?: number;
    inventory?: Array<{ name: string; count: number; durabilityUsed?: number; maxDurability?: number }>;
    botPos?: Vec3;
    blocks?: Map<string, any>;
    entities?: Record<string, any>;
  } = {}) => {
    const items = (options.inventory || []).map((inv, idx) => ({
      type: idx + 100,
      name: inv.name,
      count: inv.count,
      durabilityUsed: inv.durabilityUsed,
      maxDurability: inv.maxDurability,
    }));

    const blockMap = options.blocks || new Map<string, any>();
    const pos = options.botPos || new Vec3(10, 64, 10);

    const mockBot: any = {
      health: options.health ?? 20,
      food: options.food ?? 20,
      oxygenLevel: options.oxygen ?? 20,
      isAlive: true,
      entity: {
        position: pos.clone(),
        isInWater: false,
        isInLava: false,
        isBurning: false,
        onGround: true,
      },
      entities: options.entities || {},
      inventory: {
        items: vi.fn(() => items),
        emptySlotCount: vi.fn(() => Math.max(0, 36 - items.length)),
      },
      heldItem: items[0] || null,
      blockAt: vi.fn((p: Vec3) => {
        const key = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
        if (blockMap.has(key)) return blockMap.get(key);
        return { name: p.y >= 64 ? 'air' : 'stone', position: p.clone(), boundingBox: p.y >= 64 ? 'empty' : 'block' };
      }),
      findBlock: vi.fn((opts: any) => {
        for (const b of blockMap.values()) {
          if (opts.matching(b)) return b;
        }
        return null;
      }),
      equip: vi.fn(async (item: any) => {
        mockBot.heldItem = item;
      }),
      consume: vi.fn(async () => {
        mockBot.food = Math.min(20, (mockBot.food || 0) + 5);
      }),
      deactivateItem: vi.fn(),
      clearControlStates: vi.fn(),
      setControlState: vi.fn(),
      lookAt: vi.fn().mockResolvedValue(undefined),
      toss: vi.fn(async (_type: number, _meta: any, count: number) => {
        if (items.length > 0) {
          items[0].count = Math.max(0, items[0].count - count);
        }
      }),
      openContainer: vi.fn().mockResolvedValue({
        slots: new Array(27),
        deposit: vi.fn().mockResolvedValue(undefined),
        withdraw: vi.fn().mockResolvedValue(undefined),
      }),
      closeWindow: vi.fn(),
      pathfinder: {
        goto: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn(),
      },
      on: vi.fn(),
      removeListener: vi.fn(),
    };

    return { mockBot, items, blockMap };
  };

  // =========================================================================
  // 1. Food Selection & Unsuitable / Harmful Food Exclusion
  // =========================================================================
  describe('1. Version-Supported Food Classification & Unsuitable Food Rejection', () => {
    it('classifies harmful and poor emergency foods correctly', () => {
      expect(isHarmfulFood('spider_eye')).toBe(true);
      expect(isHarmfulFood('poisonous_potato')).toBe(true);
      expect(isHarmfulFood('pufferfish')).toBe(true);
      expect(isHarmfulFood('chorus_fruit')).toBe(true);
      expect(isHarmfulFood('bread')).toBe(false);
      expect(isHarmfulFood('cooked_beef')).toBe(false);

      expect(isPoorEmergencyFood('rotten_flesh')).toBe(true);
      expect(isPoorEmergencyFood('raw_chicken')).toBe(true);
      expect(isPoorEmergencyFood('cooked_chicken')).toBe(false);
    });

    it('rejects harmful food (spider_eye / pufferfish) even when requested directly', async () => {
      const { mockBot } = createMockBot({
        inventory: [{ name: 'spider_eye', count: 5 }],
      });
      const eatAction = inventoryCraftingActions.find((a) => a.name === 'eat')!;
      const ctx: ActionExecutionContext = {
        bot: mockBot,
        observation: createMockObservation(),
        config,
        isCurrent: () => true,
      };

      const result = await eatAction.execute(mockBot, { item: 'spider_eye' }, ctx);

      expect(result.status).toBe('failed');
      expect(result.reason).toContain('Refused to eat spider_eye: toxic/harmful food');
      expect(mockBot.consume).not.toHaveBeenCalled();
    });

    it('rejects poor emergency food (rotten_flesh) when safer food exists or not starving', async () => {
      const { mockBot } = createMockBot({
        food: 14,
        inventory: [
          { name: 'rotten_flesh', count: 10 },
          { name: 'cooked_beef', count: 2 },
        ],
      });
      const eatAction = inventoryCraftingActions.find((a) => a.name === 'eat')!;
      const ctx: ActionExecutionContext = {
        bot: mockBot,
        observation: createMockObservation(),
        config,
        isCurrent: () => true,
      };

      const result = await eatAction.execute(mockBot, { item: 'rotten_flesh' }, ctx);

      expect(result.status).toBe('failed');
      expect(result.reason).toContain('Refused to eat poor emergency food rotten_flesh');
      expect(mockBot.consume).not.toHaveBeenCalled();
    });

    it('selects highest nutrition safe food (cooked_beef over sweet_berries)', () => {
      const { mockBot } = createMockBot({
        food: 12,
        inventory: [
          { name: 'sweet_berries', count: 16 },
          { name: 'cooked_beef', count: 4 },
        ],
      });

      const selection = selectBestFood(mockBot);

      expect(selection.selectedItem).not.toBeNull();
      expect(selection.foodDef?.name).toBe('cooked_beef');
      expect(selection.isEmergencyFallback).toBe(false);
    });

    it('permits golden_apple priority when health is low (< 10) for emergency regeneration', () => {
      const { mockBot } = createMockBot({
        health: 8,
        food: 12,
        inventory: [
          { name: 'cooked_beef', count: 5 },
          { name: 'golden_apple', count: 2 },
        ],
      });

      const selection = selectBestFood(mockBot, { healthPriority: true });

      expect(selection.selectedItem?.name).toBe('golden_apple');
      expect(selection.foodDef?.effects).toContain('regeneration');
    });

    it('allows rotten_flesh strictly as a last resort when starving (food <= 2) and zero safe food exists', () => {
      const { mockBot } = createMockBot({
        food: 1,
        inventory: [{ name: 'rotten_flesh', count: 3 }],
      });

      const selection = selectBestFood(mockBot, { allowEmergencyOnly: true });

      expect(selection.selectedItem?.name).toBe('rotten_flesh');
      expect(selection.isEmergencyFallback).toBe(true);
      expect(selection.reason).toContain('strictly due to starvation');
    });
  });

  // =========================================================================
  // 2. Health & Hunger Reflex Evaluation
  // =========================================================================
  describe('2. Health & Hunger Reflex Triggering', () => {
    it('triggers auto-eat reflex when hunger is below eatFoodThreshold', async () => {
      const { mockBot } = createMockBot({
        food: 6,
        inventory: [{ name: 'bread', count: 4 }],
      });
      const arbiter = new ActionArbiter(logger);
      const reflex = new ReflexLayer(config, logger);
      const obs = createMockObservation({
        vitals: { food: 6, health: 20, isAlive: true } as any,
        inventory: { foodList: [{ name: 'bread', count: 4, foodPoints: 5, saturation: 6 }] } as any,
      });

      const result = await reflex.evaluateReflexes(mockBot, obs, arbiter);

      expect(result.triggered).toBe(true);
      expect(result.name).toBe('auto_eat');
      expect(mockBot.consume).toHaveBeenCalled();
    });

    it('triggers auto-eat reflex to initiate natural regeneration when health is damaged (< 20) and food < 18', async () => {
      const { mockBot } = createMockBot({
        health: 14,
        food: 16, // Above standard eatFoodThreshold (14), but below natural regen threshold (18)
        inventory: [{ name: 'cooked_porkchop', count: 2 }],
      });
      const arbiter = new ActionArbiter(logger);
      const reflex = new ReflexLayer(config, logger);
      const obs = createMockObservation({
        vitals: { food: 16, health: 14, isAlive: true } as any,
        inventory: { foodList: [{ name: 'cooked_porkchop', count: 2, foodPoints: 8, saturation: 12.8 }] } as any,
      });

      const result = await reflex.evaluateReflexes(mockBot, obs, arbiter);

      expect(result.triggered).toBe(true);
      expect(result.name).toBe('auto_eat');
      expect(mockBot.consume).toHaveBeenCalled();
    });

    it('refuses to trigger auto-eat when inventory contains only harmful food (spider_eye)', async () => {
      const { mockBot } = createMockBot({
        food: 10,
        inventory: [{ name: 'spider_eye', count: 3 }],
      });
      const arbiter = new ActionArbiter(logger);
      const reflex = new ReflexLayer(config, logger);
      const obs = createMockObservation({
        vitals: { food: 10, health: 20, isAlive: true } as any,
        inventory: { foodList: [{ name: 'spider_eye', count: 3, foodPoints: 2, saturation: 3.2 }] } as any,
      });

      const result = await reflex.evaluateReflexes(mockBot, obs, arbiter);

      // Must NOT trigger eating reflex to protect bot from self-poisoning!
      expect(result.triggered).toBe(false);
      expect(mockBot.consume).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 3. Drowning & Lava Preemption Interrupts & Arbiter Ownership
  // =========================================================================
  describe('3. Drowning & Lava Preemption Interrupts under Arbiter Lock', () => {
    it('drowning emergency interrupts eating immediately and swims up under SURVIVAL_EMERGENCY lock', async () => {
      const { mockBot } = createMockBot({
        oxygen: 4,
      });
      const arbiter = new ActionArbiter(logger);
      const reflex = new ReflexLayer(config, logger);

      // Start an action representing eating
      const normalAction = arbiter.startAction('eat_bread', ActionPriority.NORMAL, mockBot, ['hands']);
      expect(normalAction.signal.aborted).toBe(false);

      const obs = createMockObservation({
        vitals: {
          oxygen: 4,
          underwater: true,
          isAlive: true,
          movementState: { inWater: true } as any,
        } as any,
      });

      const result = await reflex.evaluateReflexes(mockBot, obs, arbiter);

      expect(result.triggered).toBe(true);
      expect(result.name).toBe('swim_up_low_oxygen');
      // Normal eating was preempted
      expect(normalAction.signal.aborted).toBe(true);
      expect(mockBot.deactivateItem).toHaveBeenCalled();
      expect(mockBot.setControlState).toHaveBeenCalledWith('jump', true);
      // Released control state on finish
      expect(mockBot.clearControlStates).toHaveBeenCalled();
    });

    it('lava emergency preempts normal work and flees to verified safe ground', async () => {
      const { mockBot, blockMap } = createMockBot();
      const arbiter = new ActionArbiter(logger);
      const reflex = new ReflexLayer(config, logger);

      const normalSkill = arbiter.startAction('mine_stone', ActionPriority.NORMAL, mockBot, ['movement', 'hands']);

      // Setup safe non-lava ground at adjacent coordinates
      const safeGround = { name: 'stone', position: new Vec3(11, 63, 10), boundingBox: 'block' };
      blockMap.set('11,63,10', safeGround);

      const obs = createMockObservation({
        vitals: {
          isBurning: true,
          isAlive: true,
          movementState: { inLava: true } as any,
        } as any,
      });

      const result = await reflex.evaluateReflexes(mockBot, obs, arbiter);

      expect(result.triggered).toBe(true);
      expect(result.name).toBe('flee_lava_hazard');
      expect(normalSkill.signal.aborted).toBe(true);
      expect(mockBot.clearControlStates).toHaveBeenCalled();
    });

    it('confirms water-bucket clutch stunts are strictly disabled by default policy', () => {
      // Must return false per blueprint requirement
      expect(isWaterBucketClutchPermitted()).toBe(false);
    });
  });

  // =========================================================================
  // 4. Full Inventory Management & Reserved Ingredients Protection
  // =========================================================================
  describe('4. Full Inventory Reliability, Container Storage & Reserved Items', () => {
    it('deposits surplus materials into nearby container rather than dropping them', async () => {
      const { mockBot, blockMap, items } = createMockBot({
        inventory: [
          { name: 'cobblestone', count: 64 },
          { name: 'dirt', count: 64 },
          { name: 'iron_ingot', count: 12 },
        ],
      });
      // Mock full inventory
      mockBot.inventory.emptySlotCount = vi.fn().mockReturnValue(0);

      // Reachable chest nearby
      const chestBlock = { name: 'chest', position: new Vec3(11, 64, 10) };
      blockMap.set('11,64,10', chestBlock);

      const result = await handleFullInventoryReliability(mockBot);

      expect(result.status).toBe('deposited');
      expect(mockBot.openContainer).toHaveBeenCalled();
      expect(result.actionTaken).toContain('Deposited surplus materials into chest');
    });

    it('strictly preserves reserved ingredients when dropping surplus from full inventory', async () => {
      const { mockBot, items } = createMockBot({
        inventory: [
          { name: 'cobblestone', count: 128 }, // 128 cobblestone (64 reserved, 64 min preserved)
          { name: 'dirt', count: 100 },        // 100 dirt (0 reserved, 64 preserved -> 36 surplus)
          { name: 'oak_log', count: 32 },       // 32 logs (reserved parent goal!)
        ],
      });
      mockBot.inventory.emptySlotCount = vi.fn().mockReturnValue(0);

      const reservedMaterials = {
        oak_log: 32,
        cobblestone: 64,
      };

      const result = await handleFullInventoryReliability(mockBot, {
        reservedMaterials,
        minimumPreservedSurplus: 64,
        allowDropping: true,
      });

      // Must drop surplus dirt (exceeding min 64)
      expect(result.status).toBe('dropped');
      expect(result.itemProcessed).toBe('dirt');
      // Must NOT drop oak_log or cobblestone!
      expect(mockBot.toss).toHaveBeenCalled();
      expect(result.itemProcessed).not.toBe('oak_log');
    });

    it('never drops protected items (tools, weapons, armor, food, ores, workstations)', () => {
      expect(isProtectedItem('diamond_pickaxe')).toBe(true);
      expect(isProtectedItem('iron_sword')).toBe(true);
      expect(isProtectedItem('cooked_beef')).toBe(true);
      expect(isProtectedItem('diamond')).toBe(true);
      expect(isProtectedItem('raw_iron')).toBe(true);
      expect(isProtectedItem('crafting_table')).toBe(true);
      expect(isProtectedItem('furnace')).toBe(true);
      expect(isProtectedItem('torch')).toBe(true);

      // Disposable surplus allowlist
      expect(isProtectedItem('dirt')).toBe(false);
      expect(isProtectedItem('cobblestone')).toBe(false);
      expect(isProtectedItem('gravel')).toBe(false);
      expect(DISPOSABLE_SURPLUS_ALLOWLIST.has('dirt')).toBe(true);
      expect(DISPOSABLE_SURPLUS_ALLOWLIST.has('cobblestone')).toBe(true);
    });
  });

  // =========================================================================
  // 5. Tool Durability & Protection Policy
  // =========================================================================
  describe('5. Tool Durability Protection', () => {
    it('flags tool as critically damaged when remaining uses <= threshold', () => {
      const freshPick = { name: 'iron_pickaxe', maxDurability: 250, durabilityUsed: 50 };
      const damagedPick = { name: 'diamond_pickaxe', maxDurability: 1561, durabilityUsed: 1559 }; // 2 uses left

      const freshInfo = getToolDurabilityInfo(freshPick, 5);
      const damagedInfo = getToolDurabilityInfo(damagedPick, 5);

      expect(freshInfo?.isCriticallyDamaged).toBe(false);
      expect(freshInfo?.remainingUses).toBe(200);

      expect(damagedInfo?.isCriticallyDamaged).toBe(true);
      expect(damagedInfo?.remainingUses).toBe(2);
    });

    it('selects healthy tool over critically damaged high-tier tool to prevent breakage', () => {
      const { mockBot } = createMockBot({
        inventory: [
          { name: 'diamond_pickaxe', count: 1, maxDurability: 1561, durabilityUsed: 1560 }, // 1 use left!
          { name: 'iron_pickaxe', count: 1, maxDurability: 250, durabilityUsed: 20 },        // Healthy!
        ],
      });

      // Avoids the 1-use diamond pickaxe and chooses the healthy iron pickaxe
      const selected = findBestHealthyTool(mockBot, 'pickaxe', 2, 3);

      expect(selected).not.toBeNull();
      expect(selected.name).toBe('iron_pickaxe');
    });
  });

  // =========================================================================
  // 6. Drop Vacuuming Reliability & Hazard Avoidance
  // =========================================================================
  describe('6. Drop Recovery & Hazard Avoidance', () => {
    it('aborts vacuum drops cleanly when inventory is completely full', async () => {
      const { mockBot } = createMockBot({
        entities: {
          item1: { name: 'item', position: new Vec3(12, 64, 10) },
        },
      });
      mockBot.inventory.emptySlotCount = vi.fn().mockReturnValue(0);

      const result = await techniqueVacuumDrops(mockBot, 10);

      expect(result.status).toBe('failed');
      expect(result.reason).toContain('inventory is completely full');
      expect(mockBot.pathfinder.goto).not.toHaveBeenCalled();
    });

    it('skips drops submerged in lava or fire hazard', async () => {
      const { mockBot, blockMap } = createMockBot({
        entities: {
          lavaDrop: { name: 'item', position: new Vec3(14, 64, 10) },
        },
      });
      // Item is sitting in lava
      blockMap.set('14,64,10', { name: 'lava', boundingBox: 'empty' });

      const result = await techniqueVacuumDrops(mockBot, 10);

      expect(result.status).toBe('success');
      expect(result.reason).toContain('No dropped items nearby');
      // Did NOT pathfind into lava
      expect(mockBot.pathfinder.goto).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 7. Safety Action Preempting a Normal Skill (SafetySupervisor End-to-End)
  // =========================================================================
  describe('7. Safety Action Preempting a Normal Skill', () => {
    it('SafetySupervisor preempts active normal skill for urgent drowning emergency', async () => {
      let listeners: Record<string, Function[]> = {};
      const { mockBot } = createMockBot();
      mockBot.on = vi.fn((ev: string, fn: Function) => {
        if (!listeners[ev]) listeners[ev] = [];
        listeners[ev].push(fn);
      });
      mockBot.removeListener = vi.fn();

      const arbiter = new ActionArbiter(logger);
      const reflexLayer = new ReflexLayer(config, logger);
      const supervisor = new SafetySupervisor({
        bot: mockBot,
        arbiter,
        reflexLayer,
        logger,
        config,
      });

      supervisor.start();

      // Normal gathering skill running
      const normalTask = arbiter.startAction('chop_tree', ActionPriority.NORMAL, mockBot, ['movement', 'hands']);
      expect(normalTask.signal.aborted).toBe(false);

      // Breath drops below 8 in water
      mockBot.oxygenLevel = 5;
      mockBot.entity.isInWater = true;

      const breathListeners = listeners['breath'] || [];
      for (const fn of breathListeners) {
        fn();
      }

      await new Promise((res) => queueMicrotask(res));
      await new Promise((res) => setTimeout(res, 25));

      // Normal task was preempted by supervisor
      expect(normalTask.signal.aborted).toBe(true);
      expect(mockBot.clearControlStates).toHaveBeenCalled();

      supervisor.stop();
    });
  });
});
