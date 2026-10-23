import { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import {
  FactProvenance,
  ObservedFact,
  CachedBlockFact,
  CachedEntityFact,
  CachedInventoryFact,
  CachedChunkFact,
  TargetValidationResult,
} from '../types/index.js';

export const PROVENANCE_PRIORITY: Record<FactProvenance, number> = {
  event: 4,
  scan: 3,
  inference: 2,
  memory: 1,
};

export const DEFAULT_TTLS = {
  ENTITY_MS: 2000,
  BLOCK_MS: 30000,
  INVENTORY_MS: 10000,
  CHUNK_MS: 60000,
  TARGET_MS: 5000,
  VITALS_MS: 1500,
};

export function isFactFresh<T>(fact?: ObservedFact<T> | null, now: number = Date.now()): boolean {
  if (!fact) return false;
  return now < fact.expiresAt && fact.confidence >= 0.8;
}

/**
 * WorldStateTracker (Phase 2, Layer 1: World state and event reducer).
 *
 * Implements an authoritative live world-state and event reducer:
 * 1. Represents facts with value, observation time, TTL expiry, confidence, and provenance.
 * 2. Enforces event ordering (stale out-of-order events rejected; fresher timestamps prevail).
 * 3. Coalesces high-frequency event bursts in O(1) without triggering expensive whole-world scans.
 * 4. Resolves conflicting updates deterministically using provenance priority (event > scan > inference > memory).
 * 5. Rejects stale, unloaded, or despawned targets before skills execute side effects.
 *
 * Lifecycle & Cache Invalidation Semantics:
 * - Bot Disconnect: Clears active windows, purges live volatile entities, marks chunks unloaded.
 * - Chunk Unload: Invalidates block facts and ephemeral entities inside that chunk column.
 * - Entity Despawn: Marks entity dead/despawned; target validation rejects subsequent queries.
 * - Observation Expiry: Expired facts are treated as unknown (undefined) rather than assumed false.
 */
export class WorldStateTracker {
  private facts: Map<string, ObservedFact<any>> = new Map();
  private loadedChunks: Map<string, ObservedFact<CachedChunkFact>> = new Map();
  private dirtyBlockPositions: Set<string> = new Set();
  private logger?: any;
  private boundBotListeners: Array<{ event: string; listener: (...args: any[]) => void }> = [];
  private attachedBot: Bot | null = null;
  private maxCachedBlocks: number = 1000;

  constructor(logger?: any, maxCachedBlocks: number = 1000) {
    this.logger = logger;
    this.maxCachedBlocks = maxCachedBlocks;
  }

  // ---------------------------------------------------------------------------
  // Core Fact Accessors & Freshness
  // ---------------------------------------------------------------------------

  public getFact<T>(key: string): ObservedFact<T> | undefined {
    return this.facts.get(key);
  }

  public getFreshFact<T>(key: string, now: number = Date.now()): T | undefined {
    const fact = this.facts.get(key) as ObservedFact<T> | undefined;
    if (fact && isFactFresh(fact, now)) {
      return fact.value;
    }
    return undefined;
  }

  public setFact<T>(
    key: string,
    value: T,
    options: {
      source: FactProvenance;
      confidence?: number;
      ttlMs?: number;
      observedAt?: number;
      metadata?: Record<string, any>;
    }
  ): boolean {
    const observedAt = options.observedAt ?? Date.now();
    const ttlMs = options.ttlMs ?? DEFAULT_TTLS.BLOCK_MS;
    const expiresAt = observedAt + ttlMs;
    const confidence = options.confidence ?? 1.0;
    const source = options.source;

    const existing = this.facts.get(key);
    if (existing) {
      // 1. Strict Event Ordering: Reject out-of-order updates with older timestamps
      if (observedAt < existing.observedAt) {
        return false;
      }

      const existingPriority = PROVENANCE_PRIORITY[existing.source] || 0;
      const newPriority = PROVENANCE_PRIORITY[source] || 0;
      const isExistingFresh = observedAt < existing.expiresAt && existing.confidence >= 0.8;

      // 2. Provenance Priority: A lower-priority source cannot overwrite a fresh higher-priority source
      if (isExistingFresh && newPriority < existingPriority && existing.confidence >= confidence) {
        return false;
      }

      // 3. Conflict Resolution: If equal priority and fresh, but values conflict, treat as unknown/conflicted
      if (
        isExistingFresh &&
        newPriority === existingPriority &&
        JSON.stringify(existing.value) !== JSON.stringify(value)
      ) {
        this.facts.set(key, {
          value,
          observedAt,
          expiresAt,
          confidence: 0.5,
          source,
          metadata: { ...options.metadata, conflictDetected: true, previousValue: existing.value },
        });
        return true;
      }
    }

    this.facts.set(key, {
      value,
      observedAt,
      expiresAt,
      confidence,
      source,
      metadata: options.metadata,
    });

    return true;
  }

  public deleteFact(key: string): boolean {
    return this.facts.delete(key);
  }

  // ---------------------------------------------------------------------------
  // Specialized Typed Fact Helpers
  // ---------------------------------------------------------------------------

  public getBlockFact(pos: { x: number; y: number; z: number }): ObservedFact<CachedBlockFact> | undefined {
    return this.getFact<CachedBlockFact>(this.blockKey(pos));
  }

  public getEntityFact(id: number): ObservedFact<CachedEntityFact> | undefined {
    return this.getFact<CachedEntityFact>(`entity:${id}`);
  }

  public getInventoryFact(): ObservedFact<CachedInventoryFact> | undefined {
    return this.getFact<CachedInventoryFact>('inventory:state');
  }

  public isChunkLoaded(chunkX: number, chunkZ: number): boolean {
    const chunkFact = this.loadedChunks.get(this.chunkKey(chunkX, chunkZ));
    return Boolean(chunkFact && chunkFact.value.isLoaded);
  }

  // ---------------------------------------------------------------------------
  // Target Validation & Stale-Target Rejection
  // ---------------------------------------------------------------------------

  public validateTargetBlock(
    pos: { x: number; y: number; z: number },
    expectedName?: string,
    now: number = Date.now()
  ): TargetValidationResult {
    const chunkX = Math.floor(pos.x / 16);
    const chunkZ = Math.floor(pos.z / 16);

    // 1. Check if chunk is loaded
    if (this.loadedChunks.size > 0 && !this.isChunkLoaded(chunkX, chunkZ)) {
      return {
        valid: false,
        reason: `Target block at (${pos.x}, ${pos.y}, ${pos.z}) is in an unloaded chunk (${chunkX}, ${chunkZ}).`,
      };
    }

    // 2. Check cached fact freshness
    const fact = this.getBlockFact(pos);
    if (!fact) {
      return {
        valid: false,
        reason: `Target block at (${pos.x}, ${pos.y}, ${pos.z}) has no observation fact (unknown).`,
      };
    }

    if (!isFactFresh(fact, now)) {
      const isConflicted = fact.metadata?.conflictDetected || fact.confidence < 0.8;
      const reason = isConflicted
        ? `Target block observation at (${pos.x}, ${pos.y}, ${pos.z}) has unresolved conflict (confidence: ${fact.confidence}).`
        : `Target block observation at (${pos.x}, ${pos.y}, ${pos.z}) is stale (expired ${now - fact.expiresAt}ms ago).`;
      return {
        valid: false,
        reason,
        fact,
      };
    }

    // 3. Check expected block identity
    if (expectedName && fact.value.name !== expectedName) {
      return {
        valid: false,
        reason: `Target block mismatch: expected '${expectedName}' but observed '${fact.value.name}'.`,
        fact,
      };
    }

    // 4. If no specific name expected, empty/air block is not a valid physical target
    if (!expectedName && (fact.value.name === 'air' || fact.value.name === 'cave_air' || fact.value.name === 'void_air')) {
      return {
        valid: false,
        reason: `Target block at (${pos.x}, ${pos.y}, ${pos.z}) is empty (${fact.value.name}).`,
        fact,
      };
    }

    return { valid: true, fact };
  }

  public validateTargetEntity(
    entityId: number,
    expectedType?: string,
    now: number = Date.now()
  ): TargetValidationResult {
    const fact = this.getEntityFact(entityId);
    if (!fact) {
      return { valid: false, reason: `Target entity '${entityId}' not found in active state.` };
    }

    if (!fact.value.isAlive) {
      return { valid: false, reason: `Target entity '${entityId}' is dead or despawned.`, fact };
    }

    if (!isFactFresh(fact, now)) {
      const isConflicted = fact.metadata?.conflictDetected || fact.confidence < 0.8;
      const reason = isConflicted
        ? `Target entity '${entityId}' observation has unresolved conflict (confidence: ${fact.confidence}).`
        : `Target entity '${entityId}' observation is stale (expired ${now - fact.expiresAt}ms ago).`;
      return {
        valid: false,
        reason,
        fact,
      };
    }

    if (
      expectedType &&
      fact.value.type !== expectedType &&
      fact.value.name !== expectedType &&
      !(expectedType === 'mob' && fact.value.isHostile) &&
      !(expectedType === 'player' && fact.value.isPlayer)
    ) {
      return {
        valid: false,
        reason: `Target entity type mismatch: expected '${expectedType}' but found '${fact.value.type}'.`,
        fact,
      };
    }

    return { valid: true, fact };
  }

  // ---------------------------------------------------------------------------
  // Event Reducer: Consuming Mineflayer Events
  // ---------------------------------------------------------------------------

  public handleBlockUpdate(oldBlock: any, newBlock: any, timestamp: number = Date.now()): void {
    if (!newBlock?.position) return;
    const pos = {
      x: Math.floor(newBlock.position.x),
      y: Math.floor(newBlock.position.y),
      z: Math.floor(newBlock.position.z),
    };

    const key = this.blockKey(pos);
    const existing = this.facts.get(key);

    // Duplicate check: identical block within same tick
    if (
      existing &&
      existing.value.name === newBlock.name &&
      Math.abs(timestamp - existing.observedAt) < 100
    ) {
      existing.observedAt = timestamp;
      existing.expiresAt = timestamp + DEFAULT_TTLS.BLOCK_MS;
      return;
    }

    const blockFact: CachedBlockFact = {
      name: newBlock.name,
      position: pos,
      boundingBox: newBlock.boundingBox,
      hardness: newBlock.hardness,
      diggable: newBlock.diggable,
    };

    this.setFact(key, blockFact, {
      source: 'event',
      confidence: 1.0,
      ttlMs: DEFAULT_TTLS.BLOCK_MS,
      observedAt: timestamp,
    });

    this.dirtyBlockPositions.add(key);
    this.enforceCacheBounds();
  }

  public handleChunkLoad(point: { x: number; z: number }, timestamp: number = Date.now()): void {
    const chunkX = Math.floor(point.x / 16);
    const chunkZ = Math.floor(point.z / 16);
    const key = this.chunkKey(chunkX, chunkZ);

    this.loadedChunks.set(key, {
      value: { chunkX, chunkZ, loadedAt: timestamp, isLoaded: true },
      observedAt: timestamp,
      expiresAt: timestamp + DEFAULT_TTLS.CHUNK_MS,
      confidence: 1.0,
      source: 'event',
    });
  }

  public handleChunkUnload(point: { x: number; z: number }, timestamp: number = Date.now()): void {
    const chunkX = Math.floor(point.x / 16);
    const chunkZ = Math.floor(point.z / 16);
    const key = this.chunkKey(chunkX, chunkZ);

    const chunkFact = this.loadedChunks.get(key);
    if (chunkFact) {
      chunkFact.value.isLoaded = false;
      chunkFact.expiresAt = timestamp; // Immediately invalidate
    }

    // Invalidate live block facts situated in this chunk
    const chunkPrefix = `block:`;
    for (const [factKey, fact] of this.facts.entries()) {
      if (factKey.startsWith(chunkPrefix)) {
        const bPos = (fact.value as CachedBlockFact).position;
        if (bPos && Math.floor(bPos.x / 16) === chunkX && Math.floor(bPos.z / 16) === chunkZ) {
          fact.expiresAt = timestamp; // Stale immediately
        }
      }
    }

    // Invalidate entities situated in this chunk
    for (const [factKey, fact] of this.facts.entries()) {
      if (factKey.startsWith('entity:')) {
        const ePos = (fact.value as CachedEntityFact).position;
        if (ePos && Math.floor(ePos.x / 16) === chunkX && Math.floor(ePos.z / 16) === chunkZ) {
          fact.expiresAt = timestamp;
          fact.value.isAlive = false;
        }
      }
    }
  }

  public handleEntitySpawn(entity: any, timestamp: number = Date.now()): void {
    if (!entity || entity.id === undefined) return;
    const pos = entity.position ? { x: entity.position.x, y: entity.position.y, z: entity.position.z } : { x: 0, y: 0, z: 0 };
    const entityType = entity.type || entity.name || 'unknown';
    const entityName = entity.name || entity.username || entityType;

    const entityFact: CachedEntityFact = {
      id: entity.id,
      uuid: entity.uuid,
      name: entityName,
      type: entityType,
      position: pos,
      velocity: entity.velocity ? { x: entity.velocity.x, y: entity.velocity.y, z: entity.velocity.z } : undefined,
      height: entity.height,
      width: entity.width,
      health: entity.health,
      isAlive: true,
      isHostile: Boolean(entity.type === 'mob' || ['zombie', 'skeleton', 'creeper', 'spider', 'witch', 'enderman'].includes(entityName)),
      isPlayer: entity.type === 'player',
      username: entity.username,
    };

    this.setFact(`entity:${entity.id}`, entityFact, {
      source: 'event',
      confidence: 1.0,
      ttlMs: DEFAULT_TTLS.ENTITY_MS,
      observedAt: timestamp,
    });
  }

  public handleEntityGone(entity: any, timestamp: number = Date.now()): void {
    if (!entity || entity.id === undefined) return;
    const key = `entity:${entity.id}`;
    const existing = this.facts.get(key);
    if (existing) {
      existing.value.isAlive = false;
      existing.expiresAt = timestamp;
      existing.observedAt = timestamp;
    }
  }

  public handleEntityMoved(entity: any, timestamp: number = Date.now()): void {
    if (!entity || entity.id === undefined || !entity.position) return;
    const key = `entity:${entity.id}`;
    const existing = this.facts.get(key);

    if (existing && existing.value.isAlive) {
      existing.value.position = { x: entity.position.x, y: entity.position.y, z: entity.position.z };
      if (entity.velocity) {
        existing.value.velocity = { x: entity.velocity.x, y: entity.velocity.y, z: entity.velocity.z };
      }
      existing.observedAt = timestamp;
      existing.expiresAt = timestamp + DEFAULT_TTLS.ENTITY_MS;
    } else {
      this.handleEntitySpawn(entity, timestamp);
    }
  }

  public handleEntityHurt(entity: any, source?: any, timestamp: number = Date.now()): void {
    if (!entity || entity.id === undefined) return;
    const key = `entity:${entity.id}`;
    const existing = this.facts.get(key);
    if (existing) {
      existing.value.health = entity.health;
      existing.observedAt = timestamp;
      existing.expiresAt = timestamp + DEFAULT_TTLS.ENTITY_MS;
      if (typeof entity.health === 'number' && entity.health <= 0) {
        existing.value.isAlive = false;
      }
    }
  }

  public handlePlayerCollect(collector: any, collected: any, timestamp: number = Date.now()): void {
    if (collected?.id !== undefined) {
      this.handleEntityGone(collected, timestamp);
    }
  }

  public handleWindowOpen(window: any, timestamp: number = Date.now()): void {
    const existingFact = this.getFact<CachedInventoryFact>('inventory:state');
    const existingInv: CachedInventoryFact = existingFact?.value ? { ...existingFact.value } : {
      heldItem: null,
      quickBarSlot: 0,
      itemCounts: {},
      freeSlots: 36,
      windowOpen: false,
      windowType: null,
      windowId: null,
    };

    existingInv.windowOpen = true;
    existingInv.windowType = window?.type ? String(window.type) : 'unknown';
    existingInv.windowId = window?.id ?? null;

    this.setFact('inventory:state', existingInv, {
      source: 'event',
      confidence: 1.0,
      ttlMs: DEFAULT_TTLS.INVENTORY_MS,
      observedAt: timestamp,
    });
  }

  public handleWindowClose(window?: any, timestamp: number = Date.now()): void {
    const existingFact = this.getFact<CachedInventoryFact>('inventory:state');
    const existingInv: CachedInventoryFact = existingFact?.value ? { ...existingFact.value } : {
      heldItem: null,
      quickBarSlot: 0,
      itemCounts: {},
      freeSlots: 36,
      windowOpen: false,
      windowType: null,
      windowId: null,
    };

    existingInv.windowOpen = false;
    existingInv.windowType = null;
    existingInv.windowId = null;

    this.setFact('inventory:state', existingInv, {
      source: 'event',
      confidence: 1.0,
      ttlMs: DEFAULT_TTLS.INVENTORY_MS,
      observedAt: timestamp,
    });
  }

  public handleDisconnect(reason: string = 'disconnected', timestamp: number = Date.now()): void {
    this.logger?.warn?.(`[WORLD_STATE] Handling disconnect (${reason}). Purging volatile entity cache and marking chunks unloaded.`);

    // 1. Invalidate all entities
    for (const [key, fact] of this.facts.entries()) {
      if (key.startsWith('entity:')) {
        fact.value.isAlive = false;
        fact.expiresAt = timestamp;
      }
    }

    // 2. Invalidate all loaded chunks
    for (const chunk of this.loadedChunks.values()) {
      chunk.value.isLoaded = false;
      chunk.expiresAt = timestamp;
    }

    // 3. Clear window state
    this.handleWindowClose(null, timestamp);

    // 4. Invalidate volatile block cache
    for (const [key, fact] of this.facts.entries()) {
      if (key.startsWith('block:')) {
        fact.expiresAt = timestamp;
      }
    }
  }

  public handleSpawn(timestamp: number = Date.now()): void {
    this.logger?.info?.('[WORLD_STATE] Bot spawn/respawn detected. State tracker ready for fresh loaded packets.');
    this.handleWindowClose(null, timestamp);
  }

  // ---------------------------------------------------------------------------
  // Targeted Bounded Rescans
  // ---------------------------------------------------------------------------

  public rescanTargetBlock(bot: Bot, pos: { x: number; y: number; z: number }): ObservedFact<CachedBlockFact> | null {
    if (!bot || typeof bot.blockAt !== 'function') return null;
    const v3Pos = new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z));
    const block = bot.blockAt(v3Pos);
    if (!block) return null;

    const key = this.blockKey(v3Pos);
    const fact: CachedBlockFact = {
      name: block.name,
      position: { x: v3Pos.x, y: v3Pos.y, z: v3Pos.z },
      boundingBox: block.boundingBox,
      hardness: block.hardness,
      diggable: block.diggable,
    };

    const now = Date.now();
    this.setFact(key, fact, {
      source: 'scan',
      confidence: 1.0,
      ttlMs: DEFAULT_TTLS.TARGET_MS,
      observedAt: now,
    });

    return this.facts.get(key) || null;
  }

  public rescanTargetArea(bot: Bot, center: { x: number; y: number; z: number }, radius: number = 1): void {
    if (!bot || typeof bot.blockAt !== 'function') return;
    const boundedRadius = Math.min(Math.max(radius, 1), 2); // Max radius 2 (5x5x5)
    const cx = Math.floor(center.x);
    const cy = Math.floor(center.y);
    const cz = Math.floor(center.z);

    for (let dx = -boundedRadius; dx <= boundedRadius; dx++) {
      for (let dz = -boundedRadius; dz <= boundedRadius; dz++) {
        for (let dy = -boundedRadius; dy <= boundedRadius; dy++) {
          this.rescanTargetBlock(bot, { x: cx + dx, y: cy + dy, z: cz + dz });
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Public Bot Listener Management
  // ---------------------------------------------------------------------------

  public attachBot(bot: Bot): void {
    this.detachBot();
    this.attachedBot = bot;

    const add = (event: string, fn: (...args: any[]) => void) => {
      if (typeof bot.on === 'function') {
        bot.on(event as any, fn);
        this.boundBotListeners.push({ event, listener: fn });
      }
    };

    add('blockUpdate', (oldB: any, newB: any) => this.handleBlockUpdate(oldB, newB));
    add('chunkColumnLoad', (pt: any) => this.handleChunkLoad(pt));
    add('chunkColumnUnload', (pt: any) => this.handleChunkUnload(pt));
    add('entitySpawn', (e: any) => this.handleEntitySpawn(e));
    add('entityGone', (e: any) => this.handleEntityGone(e));
    add('entityMoved', (e: any) => this.handleEntityMoved(e));
    add('entityHurt', (e: any, s: any) => this.handleEntityHurt(e, s));
    add('playerCollect', (col: any, drop: any) => this.handlePlayerCollect(col, drop));
    add('windowOpen', (w: any) => this.handleWindowOpen(w));
    add('windowClose', (w: any) => this.handleWindowClose(w));
    add('end', () => this.handleDisconnect('end'));
    add('kicked', (r: any) => this.handleDisconnect(typeof r === 'string' ? r : JSON.stringify(r)));
    add('spawn', () => this.handleSpawn());
    add('respawn', () => this.handleSpawn());
  }

  public detachBot(): void {
    if (this.attachedBot && this.boundBotListeners.length > 0) {
      for (const { event, listener } of this.boundBotListeners) {
        try {
          if (typeof this.attachedBot.removeListener === 'function') {
            this.attachedBot.removeListener(event as any, listener);
          }
        } catch {}
      }
    }
    this.boundBotListeners = [];
    this.attachedBot = null;
  }

  public clear(): void {
    this.facts.clear();
    this.loadedChunks.clear();
    this.dirtyBlockPositions.clear();
  }

  public getDirtyBlockPositions(): string[] {
    return Array.from(this.dirtyBlockPositions);
  }

  public clearDirtyBlockPositions(): void {
    this.dirtyBlockPositions.clear();
  }

  public getLoadedChunksCount(): number {
    let count = 0;
    for (const chunk of this.loadedChunks.values()) {
      if (chunk.value.isLoaded) count++;
    }
    return count;
  }

  public pruneExpired(now: number = Date.now()): number {
    let pruned = 0;
    for (const [key, fact] of this.facts.entries()) {
      if (fact.expiresAt <= now) {
        this.facts.delete(key);
        pruned++;
      }
    }
    return pruned;
  }

  // ---------------------------------------------------------------------------
  // Internal Helpers
  // ---------------------------------------------------------------------------

  private blockKey(pos: { x: number; y: number; z: number }): string {
    return `block:${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
  }

  private chunkKey(chunkX: number, chunkZ: number): string {
    return `chunk:${chunkX},${chunkZ}`;
  }

  private enforceCacheBounds(): void {
    if (this.facts.size <= this.maxCachedBlocks) return;

    // Prune expired facts first
    const now = Date.now();
    for (const [key, fact] of this.facts.entries()) {
      if (fact.expiresAt <= now) {
        this.facts.delete(key);
      }
    }

    // If still over max capacity, evict oldest block facts
    if (this.facts.size > this.maxCachedBlocks) {
      const blockEntries: Array<[string, ObservedFact<any>]> = [];
      for (const entry of this.facts.entries()) {
        if (entry[0].startsWith('block:')) {
          blockEntries.push(entry);
        }
      }
      blockEntries.sort((a, b) => a[1].observedAt - b[1].observedAt);
      const toRemove = this.facts.size - this.maxCachedBlocks;
      for (let i = 0; i < Math.min(toRemove, blockEntries.length); i++) {
        this.facts.delete(blockEntries[i][0]);
      }
    }
  }
}
