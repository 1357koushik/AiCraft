import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Vec3 } from 'vec3';
import {
  WorldStateTracker,
  isFactFresh,
  DEFAULT_TTLS,
  PROVENANCE_PRIORITY,
} from '../src/perception/world_state.js';
import {
  CachedBlockFact,
  CachedEntityFact,
  CachedInventoryFact,
} from '../src/types/index.js';

describe('WorldStateTracker (Phase 2: World State & Event Reducer)', () => {
  let tracker: WorldStateTracker;
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    tracker = new WorldStateTracker(mockLogger, 100);
  });

  // =========================================================================
  // 1. Event Ordering & Out-of-Order Rejection
  // =========================================================================
  describe('1. Event Ordering & Out-of-Order Rejection', () => {
    it('accepts newer events and rejects stale out-of-order events', () => {
      const key = 'block:10,64,10';
      const t1 = 1000;
      const t2 = 1500;
      const tStale = 800;

      // Initial observation at t1
      const accepted1 = tracker.setFact(key, { name: 'stone' }, {
        source: 'event',
        observedAt: t1,
        ttlMs: 10000,
      });
      expect(accepted1).toBe(true);
      expect(tracker.getFact(key)?.value).toEqual({ name: 'stone' });
      expect(tracker.getFact(key)?.observedAt).toBe(t1);

      // Newer observation at t2 overwrites t1
      const accepted2 = tracker.setFact(key, { name: 'cobblestone' }, {
        source: 'event',
        observedAt: t2,
        ttlMs: 10000,
      });
      expect(accepted2).toBe(true);
      expect(tracker.getFact(key)?.value).toEqual({ name: 'cobblestone' });
      expect(tracker.getFact(key)?.observedAt).toBe(t2);

      // Stale out-of-order observation at tStale (< t2) is rejected
      const acceptedStale = tracker.setFact(key, { name: 'dirt' }, {
        source: 'event',
        observedAt: tStale,
        ttlMs: 10000,
      });
      expect(acceptedStale).toBe(false);
      // State remains the newer cobblestone
      expect(tracker.getFact(key)?.value).toEqual({ name: 'cobblestone' });
      expect(tracker.getFact(key)?.observedAt).toBe(t2);
    });

    it('rejects out-of-order entity movement updates', () => {
      const entityId = 42;
      const t1 = 2000;
      const t2 = 2500;
      const tOld = 2100;

      tracker.handleEntitySpawn({
        id: entityId,
        name: 'zombie',
        type: 'mob',
        position: { x: 5, y: 64, z: 5 },
      }, t1);

      tracker.handleEntityMoved({
        id: entityId,
        position: { x: 6, y: 64, z: 5 },
      }, t2);

      expect(tracker.getEntityFact(entityId)?.value.position).toEqual({ x: 6, y: 64, z: 5 });

      // Stale packet from network jitter arriving late
      const staleAccepted = tracker.setFact(`entity:${entityId}`, {
        id: entityId,
        name: 'zombie',
        type: 'mob',
        position: { x: 5.2, y: 64, z: 5 },
        isAlive: true,
        isHostile: true,
        isPlayer: false,
      }, {
        source: 'event',
        observedAt: tOld,
      });

      expect(staleAccepted).toBe(false);
      expect(tracker.getEntityFact(entityId)?.value.position).toEqual({ x: 6, y: 64, z: 5 });
    });
  });

  // =========================================================================
  // 2. Duplicate Event Coalescing & High-Frequency Bursts
  // =========================================================================
  describe('2. Duplicate Event Coalescing', () => {
    it('coalesces duplicate blockUpdate events within the same tick/window without thrashing', () => {
      const pos = { x: 10, y: 64, z: 10 };
      const block = { name: 'oak_log', position: pos, boundingBox: 'block', hardness: 2.0, diggable: true };
      const t0 = 1000;

      tracker.handleBlockUpdate(null, block, t0);
      const initialFact = tracker.getBlockFact(pos);
      expect(initialFact?.value.name).toBe('oak_log');
      expect(initialFact?.observedAt).toBe(t0);
      expect(initialFact?.expiresAt).toBe(t0 + DEFAULT_TTLS.BLOCK_MS);

      // Duplicate packet fired 20ms later in same network tick
      tracker.handleBlockUpdate(null, block, t0 + 20);
      const coalescedFact = tracker.getBlockFact(pos);
      // Value remains same, expiry and observedAt updated smoothly
      expect(coalescedFact?.value.name).toBe('oak_log');
      expect(coalescedFact?.observedAt).toBe(t0 + 20);
      expect(coalescedFact?.expiresAt).toBe(t0 + 20 + DEFAULT_TTLS.BLOCK_MS);
    });

    it('updates position and extends TTL for moving entities without recreation churn', () => {
      const entity = { id: 99, name: 'cow', type: 'passive', position: { x: 0, y: 64, z: 0 } };
      tracker.handleEntitySpawn(entity, 1000);

      tracker.handleEntityMoved({ id: 99, position: { x: 1, y: 64, z: 0 } }, 1100);
      tracker.handleEntityMoved({ id: 99, position: { x: 2, y: 64, z: 0 } }, 1200);

      const entityFact = tracker.getEntityFact(99);
      expect(entityFact?.value.position).toEqual({ x: 2, y: 64, z: 0 });
      expect(entityFact?.observedAt).toBe(1200);
      expect(entityFact?.expiresAt).toBe(1200 + DEFAULT_TTLS.ENTITY_MS);
      expect(entityFact?.value.isAlive).toBe(true);
    });
  });

  // =========================================================================
  // 3. TTL Expiry & Unknown State Fallback
  // =========================================================================
  describe('3. TTL Expiry & Unknown State Fallback', () => {
    it('treats facts as fresh before TTL and unknown (undefined) after TTL', () => {
      const key = 'custom:target';
      const t0 = 5000;
      const ttl = 2000; // 2 seconds

      tracker.setFact(key, { targetId: 'mob_1' }, {
        source: 'scan',
        observedAt: t0,
        ttlMs: ttl,
      });

      // At t0 + 1000 (1s later): Fact is fresh and accessible
      expect(isFactFresh(tracker.getFact(key), t0 + 1000)).toBe(true);
      expect(tracker.getFreshFact(key, t0 + 1000)).toEqual({ targetId: 'mob_1' });

      // At t0 + 2000 (exactly at expiry): Not fresh
      expect(isFactFresh(tracker.getFact(key), t0 + 2000)).toBe(false);
      expect(tracker.getFreshFact(key, t0 + 2000)).toBeUndefined();

      // At t0 + 3000 (past expiry): Fact treated as unknown
      expect(isFactFresh(tracker.getFact(key), t0 + 3000)).toBe(false);
      expect(tracker.getFreshFact(key, t0 + 3000)).toBeUndefined();
    });

    it('prunes expired facts from internal cache on demand', () => {
      tracker.setFact('k1', 'val1', { source: 'scan', observedAt: 1000, ttlMs: 1000 }); // expires 2000
      tracker.setFact('k2', 'val2', { source: 'scan', observedAt: 1000, ttlMs: 5000 }); // expires 6000

      expect(tracker.pruneExpired(2500)).toBe(1);
      expect(tracker.getFact('k1')).toBeUndefined();
      expect(tracker.getFact('k2')).toBeDefined();
    });
  });

  // =========================================================================
  // 4. Provenance Priority & Conflict Resolution
  // =========================================================================
  describe('4. Provenance Priority & Conflict Resolution', () => {
    it('enforces provenance hierarchy: event (4) > scan (3) > inference (2) > memory (1)', () => {
      const key = 'block:5,64,5';
      const t0 = 1000;

      // 1. Low-priority memory says 'dirt'
      tracker.setFact(key, { name: 'dirt' }, { source: 'memory', observedAt: t0, ttlMs: 10000 });
      expect(tracker.getFact(key)?.value).toEqual({ name: 'dirt' });

      // 2. Medium-priority inference updates to 'grass_block'
      tracker.setFact(key, { name: 'grass_block' }, { source: 'inference', observedAt: t0 + 10, ttlMs: 10000 });
      expect(tracker.getFact(key)?.value).toEqual({ name: 'grass_block' });

      // 3. Scan confirms 'stone'
      tracker.setFact(key, { name: 'stone' }, { source: 'scan', observedAt: t0 + 20, ttlMs: 10000 });
      expect(tracker.getFact(key)?.value).toEqual({ name: 'stone' });

      // 4. Authoritative packet event says 'iron_ore'
      tracker.setFact(key, { name: 'iron_ore' }, { source: 'event', observedAt: t0 + 30, ttlMs: 10000 });
      expect(tracker.getFact(key)?.value).toEqual({ name: 'iron_ore' });

      // 5. Stale memory or inference cannot overwrite fresh authoritative event
      const rejectedInfer = tracker.setFact(key, { name: 'cobblestone' }, {
        source: 'inference',
        observedAt: t0 + 40,
        ttlMs: 10000,
      });
      expect(rejectedInfer).toBe(false);
      expect(tracker.getFact(key)?.value).toEqual({ name: 'iron_ore' });

      const rejectedMem = tracker.setFact(key, { name: 'bedrock' }, {
        source: 'memory',
        observedAt: t0 + 50,
        ttlMs: 10000,
      });
      expect(rejectedMem).toBe(false);
      expect(tracker.getFact(key)?.value).toEqual({ name: 'iron_ore' });
    });

    it('detects conflicting updates at equal priority and degrades confidence to unknown', () => {
      const key = 'entity:target:zone';
      const t0 = 1000;

      tracker.setFact(key, { threat: 'creeper' }, {
        source: 'scan',
        observedAt: t0,
        ttlMs: 5000,
      });

      // Conflicting scan at same priority with different value
      const updated = tracker.setFact(key, { threat: 'pig' }, {
        source: 'scan',
        observedAt: t0 + 50,
        ttlMs: 5000,
      });
      expect(updated).toBe(true);

      const fact = tracker.getFact(key);
      expect(fact?.metadata?.conflictDetected).toBe(true);
      expect(fact?.confidence).toBe(0.5);

      // Treated as unknown by isFactFresh and getFreshFact due to unresolved conflict!
      expect(isFactFresh(fact, t0 + 100)).toBe(false);
      expect(tracker.getFreshFact(key, t0 + 100)).toBeUndefined();
    });
  });

  // =========================================================================
  // 5. Stale-Target Rejection & Pre-Action Validation
  // =========================================================================
  describe('5. Stale-Target Rejection & Pre-Action Validation', () => {
    it('validates fresh matching target block successfully', () => {
      const pos = { x: 12, y: 64, z: 8 };
      tracker.handleChunkLoad({ x: 12, z: 8 }, 1000);
      tracker.handleBlockUpdate(null, {
        name: 'diamond_ore',
        position: pos,
        boundingBox: 'block',
        hardness: 3.0,
        diggable: true,
      }, 1000);

      const res = tracker.validateTargetBlock(pos, 'diamond_ore', 1500);
      expect(res.valid).toBe(true);
      expect(res.fact?.value.name).toBe('diamond_ore');
    });

    it('rejects target block if expected name does not match', () => {
      const pos = { x: 12, y: 64, z: 8 };
      tracker.handleChunkLoad({ x: 12, z: 8 }, 1000);
      tracker.handleBlockUpdate(null, {
        name: 'stone',
        position: pos,
      }, 1000);

      const res = tracker.validateTargetBlock(pos, 'diamond_ore', 1500);
      expect(res.valid).toBe(false);
      expect(res.reason).toContain("expected 'diamond_ore' but observed 'stone'");
    });

    it('rejects target block if block has been broken to air', () => {
      const pos = { x: 12, y: 64, z: 8 };
      tracker.handleChunkLoad({ x: 12, z: 8 }, 1000);
      tracker.handleBlockUpdate(null, {
        name: 'air',
        position: pos,
      }, 1000);

      const res = tracker.validateTargetBlock(pos, 'oak_log', 1500);
      expect(res.valid).toBe(false);
      expect(res.reason).toContain("expected 'oak_log' but observed 'air'");

      // Also rejected if expectedName is omitted
      const resUnspecified = tracker.validateTargetBlock(pos, undefined, 1500);
      expect(resUnspecified.valid).toBe(false);
      expect(resUnspecified.reason).toContain('is empty (air)');
    });

    it('rejects target block if observation fact is stale (expired TTL)', () => {
      const pos = { x: 12, y: 64, z: 8 };
      tracker.handleChunkLoad({ x: 12, z: 8 }, 1000);
      tracker.handleBlockUpdate(null, {
        name: 'oak_log',
        position: pos,
      }, 1000);

      // Check after block TTL (30s)
      const res = tracker.validateTargetBlock(pos, 'oak_log', 1000 + DEFAULT_TTLS.BLOCK_MS + 100);
      expect(res.valid).toBe(false);
      expect(res.reason).toContain('is stale');
    });

    it('rejects target block if situated in an unloaded chunk', () => {
      const pos = { x: 120, y: 64, z: 80 }; // chunk (7, 5)
      tracker.handleChunkLoad({ x: 0, z: 0 }, 1000); // chunk (0, 0) loaded

      tracker.handleBlockUpdate(null, {
        name: 'oak_log',
        position: pos,
      }, 1000);

      const res = tracker.validateTargetBlock(pos, 'oak_log', 1500);
      expect(res.valid).toBe(false);
      expect(res.reason).toContain('unloaded chunk');
    });

    it('validates living entity and rejects dead or despawned entity', () => {
      const entityId = 55;
      tracker.handleEntitySpawn({
        id: entityId,
        name: 'zombie',
        type: 'mob',
        position: { x: 10, y: 64, z: 10 },
      }, 1000);

      // Alive and fresh
      const validRes = tracker.validateTargetEntity(entityId, 'mob', 1500);
      expect(validRes.valid).toBe(true);

      // Despawned via entityGone
      tracker.handleEntityGone({ id: entityId }, 2000);
      const deadRes = tracker.validateTargetEntity(entityId, 'mob', 2100);
      expect(deadRes.valid).toBe(false);
      expect(deadRes.reason).toContain('is dead or despawned');
    });

    it('rejects target entity if observation has unresolved conflict', () => {
      const entityId = 77;
      tracker.setFact(`entity:${entityId}`, {
        id: entityId,
        name: 'skeleton',
        type: 'mob',
        isAlive: true,
        position: { x: 0, y: 64, z: 0 },
      }, {
        source: 'inference',
        observedAt: 1000,
        ttlMs: 5000,
      });

      // Conflicting inference at equal priority
      tracker.setFact(`entity:${entityId}`, {
        id: entityId,
        name: 'creeper',
        type: 'mob',
        isAlive: true,
        position: { x: 0, y: 64, z: 0 },
      }, {
        source: 'inference',
        observedAt: 1010,
        ttlMs: 5000,
      });

      const res = tracker.validateTargetEntity(entityId, undefined, 1100);
      expect(res.valid).toBe(false);
      expect(res.reason).toContain('unresolved conflict');
    });
  });

  // =========================================================================
  // 6. Chunk & Entity Lifecycle Invalidation
  // =========================================================================
  describe('6. Chunk & Entity Lifecycle Invalidation', () => {
    it('invalidates chunk state, blocks, and entities when chunkColumnUnload fires', () => {
      const chunkPoint = { x: 32, z: 48 }; // chunk (2, 3)
      const blockPos = { x: 35, y: 64, z: 50 }; // inside chunk (2, 3)
      const outsideBlockPos = { x: 0, y: 64, z: 0 }; // inside chunk (0, 0)
      const entityPos = { x: 34, y: 64, z: 49 };

      tracker.handleChunkLoad(chunkPoint, 1000);
      tracker.handleChunkLoad({ x: 0, z: 0 }, 1000);

      tracker.handleBlockUpdate(null, { name: 'oak_planks', position: blockPos }, 1000);
      tracker.handleBlockUpdate(null, { name: 'stone', position: outsideBlockPos }, 1000);
      tracker.handleEntitySpawn({ id: 101, name: 'sheep', type: 'passive', position: entityPos }, 1000);

      expect(tracker.isChunkLoaded(2, 3)).toBe(true);
      expect(tracker.validateTargetBlock(blockPos, 'oak_planks', 1500).valid).toBe(true);

      // Unload chunk (2, 3)
      tracker.handleChunkUnload(chunkPoint, 2000);

      expect(tracker.isChunkLoaded(2, 3)).toBe(false);
      // Target validation inside unloaded chunk fails
      expect(tracker.validateTargetBlock(blockPos, 'oak_planks', 2100).valid).toBe(false);
      // Entity inside unloaded chunk marked despawned/expired
      expect(tracker.validateTargetEntity(101, undefined, 2100).valid).toBe(false);
      // Outside chunk unaffected
      expect(tracker.validateTargetBlock(outsideBlockPos, 'stone', 2100).valid).toBe(true);
    });

    it('handles playerCollect by expiring collected item drop entities', () => {
      const dropId = 505;
      tracker.handleEntitySpawn({
        id: dropId,
        name: 'item',
        type: 'object',
        position: { x: 1, y: 64, z: 1 },
      }, 1000);

      expect(tracker.validateTargetEntity(dropId, undefined, 1100).valid).toBe(true);

      tracker.handlePlayerCollect({ id: 1 }, { id: dropId }, 1200);

      expect(tracker.validateTargetEntity(dropId, undefined, 1300).valid).toBe(false);
      expect(tracker.getEntityFact(dropId)?.value.isAlive).toBe(false);
    });
  });

  // =========================================================================
  // 7. Bot Disconnect & Reconnect Reset Lifecycle
  // =========================================================================
  describe('7. Bot Disconnect & Reconnect Reset Lifecycle', () => {
    it('purges volatile entity state, invalidates chunks and closes windows on disconnect', () => {
      tracker.handleChunkLoad({ x: 16, z: 16 }, 1000);
      tracker.handleEntitySpawn({ id: 88, name: 'pig', type: 'passive', position: { x: 16, y: 64, z: 16 } }, 1000);
      tracker.handleBlockUpdate(null, { name: 'sand', position: { x: 16, y: 64, z: 16 } }, 1000);
      tracker.handleWindowOpen({ id: 1, type: 'minecraft:crafting_table' }, 1000);

      expect(tracker.getEntityFact(88)?.value.isAlive).toBe(true);
      expect(tracker.getInventoryFact()?.value.windowOpen).toBe(true);
      expect(tracker.isChunkLoaded(1, 1)).toBe(true);

      // Bot disconnects (server kick, socket close, network loss)
      tracker.handleDisconnect('socket_closed', 2000);

      // Live volatile facts are immediately invalidated
      expect(tracker.getEntityFact(88)?.value.isAlive).toBe(false);
      expect(tracker.isChunkLoaded(1, 1)).toBe(false);
      expect(tracker.getInventoryFact()?.value.windowOpen).toBe(false);
      expect(tracker.validateTargetBlock({ x: 16, y: 64, z: 16 }, 'sand', 2100).valid).toBe(false);
    });
  });

  // =========================================================================
  // 8. Targeted Rescans & Bounded Space Queries
  // =========================================================================
  describe('8. Targeted Rescans & Bounded Space Queries', () => {
    it('rescans single target block on demand using bot.blockAt', () => {
      const mockBlock = {
        name: 'chest',
        position: new Vec3(10, 64, 10),
        boundingBox: 'block',
        hardness: 2.5,
        diggable: true,
      };
      const mockBot: any = {
        blockAt: vi.fn().mockImplementation((pos: Vec3) => {
          if (pos.x === 10 && pos.y === 64 && pos.z === 10) return mockBlock;
          return null;
        }),
      };

      const fact = tracker.rescanTargetBlock(mockBot, { x: 10, y: 64, z: 10 });
      expect(mockBot.blockAt).toHaveBeenCalled();
      expect(fact).not.toBeNull();
      expect(fact?.value.name).toBe('chest');
      expect(fact?.source).toBe('scan');
    });

    it('rescans bounded target area without unbounded world scans', () => {
      const queriedPositions: string[] = [];
      const mockBot: any = {
        blockAt: vi.fn().mockImplementation((pos: Vec3) => {
          queriedPositions.push(`${pos.x},${pos.y},${pos.z}`);
          return { name: 'stone', position: pos, boundingBox: 'block', hardness: 1.5, diggable: true };
        }),
      };

      // Rescan with radius 1 centered at (0, 64, 0) -> (3x3x3 = 27 blocks)
      tracker.rescanTargetArea(mockBot, { x: 0, y: 64, z: 0 }, 1);
      expect(queriedPositions.length).toBe(27);

      // Verify clamped bounding: radius 10 is clamped to max radius 2 (5x5x5 = 125 blocks)
      queriedPositions.length = 0;
      tracker.rescanTargetArea(mockBot, { x: 0, y: 64, z: 0 }, 10);
      expect(queriedPositions.length).toBe(125);
    });
  });

  // =========================================================================
  // 9. Cache Capacity & Bounds Enforcement
  // =========================================================================
  describe('9. Cache Capacity & Bounds Enforcement', () => {
    it('bounds internal fact cache to max capacity, evicting oldest block entries', () => {
      const smallTracker = new WorldStateTracker(mockLogger, 5); // max 5 blocks

      for (let i = 0; i < 10; i++) {
        smallTracker.handleBlockUpdate(null, {
          name: `block_${i}`,
          position: { x: i, y: 64, z: 0 },
        }, 1000 + i * 10);
      }

      // Oldest block (block:0,64,0) should have been pruned to stay within bounds
      expect(smallTracker.getBlockFact({ x: 0, y: 64, z: 0 })).toBeUndefined();
      // Most recent block (block:9,64,0) must exist
      expect(smallTracker.getBlockFact({ x: 9, y: 64, z: 0 })).toBeDefined();
    });
  });

  // =========================================================================
  // 10. Safe Bot Listener Lifecycle Management
  // =========================================================================
  describe('10. Safe Bot Listener Lifecycle Management', () => {
    it('attaches and removes listeners without calling removeAllListeners on bot', () => {
      const listeners: Record<string, Function[]> = {};
      const mockBot: any = {
        on: vi.fn().mockImplementation((event: string, fn: Function) => {
          if (!listeners[event]) listeners[event] = [];
          listeners[event].push(fn);
        }),
        removeListener: vi.fn().mockImplementation((event: string, fn: Function) => {
          if (listeners[event]) {
            listeners[event] = listeners[event].filter((f) => f !== fn);
          }
        }),
        removeAllListeners: vi.fn(),
      };

      tracker.attachBot(mockBot);
      expect(mockBot.on).toHaveBeenCalledWith('blockUpdate', expect.any(Function));
      expect(mockBot.on).toHaveBeenCalledWith('chunkColumnLoad', expect.any(Function));
      expect(mockBot.on).toHaveBeenCalledWith('chunkColumnUnload', expect.any(Function));
      expect(mockBot.on).toHaveBeenCalledWith('entitySpawn', expect.any(Function));
      expect(mockBot.on).toHaveBeenCalledWith('entityGone', expect.any(Function));
      expect(mockBot.on).toHaveBeenCalledWith('entityMoved', expect.any(Function));
      expect(mockBot.on).toHaveBeenCalledWith('windowOpen', expect.any(Function));
      expect(mockBot.on).toHaveBeenCalledWith('windowClose', expect.any(Function));

      // Clean detachment
      tracker.detachBot();
      expect(mockBot.removeListener).toHaveBeenCalled();
      // Crucial: Must NEVER call removeAllListeners on shared bot object
      expect(mockBot.removeAllListeners).not.toHaveBeenCalled();
    });
  });
});
