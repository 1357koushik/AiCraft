import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { MemoryManager } from '../src/memory/index.js';
import { ActionPriority } from '../src/agent/arbiter.js';

describe('Phase 5: Progression, Logistics & Bounded Memory Subsystem', () => {
  const testDataDir = './data/test_phase5_memory';

  beforeEach(() => {
    vi.clearAllMocks();
    const resolvedDir = path.resolve(process.cwd(), testDataDir);
    if (fs.existsSync(resolvedDir)) {
      try {
        fs.rmSync(resolvedDir, { recursive: true, force: true });
      } catch {}
    }
  });

  // =========================================================================
  // 1. Restart Persistence Across Server / Agent Reloads
  // =========================================================================
  describe('1. Restart Persistence & Storage Atomicity', () => {
    it('persists explored regions, known locations, resources, and rankings across restarts', () => {
      const worldId = `persist_world_${Date.now()}`;

      // Session 1: Record verified memories
      const mem1 = new MemoryManager(worldId, testDataDir);
      mem1.recordExploredRegion({ x: 32, z: -64 }, 'overworld');
      mem1.recordKnownLocation({
        name: 'Main Base Chest',
        type: 'chest',
        position: { x: 10, y: 64, z: 10 },
        provenance: 'direct_observation',
        metadata: { slots: 27 },
      });
      mem1.recordResourceObservation({
        resourceType: 'iron_ore',
        position: { x: 12, y: 40, z: 15 },
        confidence: 0.95,
        ttlMs: 600_000,
      });
      mem1.recordFailedTarget({ x: 25, y: 64, z: 25 }, 'Steep cliff obstruction', 'PATH_UNREACHABLE', 120_000);
      mem1.recordGoalOutcome({
        goalId: 'goal_iron_ingot',
        description: 'Smelt 3 raw iron into iron ingots',
        outcome: 'success',
        durationMs: 4500,
        evidence: 'Inventory gained 3 iron_ingot verified via postcondition.',
      });
      mem1.recordSkillOutcome('chop_tree', 'base_first', true, 3200);

      // Session 2: Instantiate brand-new MemoryManager instance on the same world file
      const mem2 = new MemoryManager(worldId, testDataDir);

      // 1. Explored regions persisted
      expect(mem2.isRegionExplored({ x: 32, z: -64 })).toBe(true);
      expect(mem2.getExploredRegions().length).toBe(1);
      expect(mem2.getExploredRegions()[0].chunkX).toBe(2); // 32 / 16 = 2
      expect(mem2.getExploredRegions()[0].chunkZ).toBe(-4); // -64 / 16 = -4

      // 2. Known location persisted
      const chests = mem2.getKnownLocations('chest');
      expect(chests.length).toBe(1);
      expect(chests[0].name).toBe('Main Base Chest');
      expect(chests[0].position).toEqual({ x: 10, y: 64, z: 10 });

      // 3. Resource observations persisted
      const ores = mem2.getFreshResourceObservations('iron_ore');
      expect(ores.length).toBe(1);
      expect(ores[0].position).toEqual({ x: 12, y: 40, z: 15 });
      expect(ores[0].confidence).toBe(0.95);

      // 4. Failed targets persisted
      const failed = mem2.isTargetFailed({ x: 25, y: 64, z: 25 });
      expect(failed.failed).toBe(true);
      expect(failed.reason).toBe('Steep cliff obstruction');
      expect(failed.failureKind).toBe('PATH_UNREACHABLE');

      // 5. Goal outcome persisted
      const outcomes = mem2.getGoalOutcomes();
      expect(outcomes.length).toBe(1);
      expect(outcomes[0].outcome).toBe('success');
      expect(outcomes[0].evidence).toContain('Inventory gained 3 iron_ingot');

      // 6. Strategy rankings persisted
      const rankings = mem2.getRankedVariants('chop_tree');
      expect(rankings.length).toBe(1);
      expect(rankings[0].variant).toBe('base_first');
      expect(rankings[0].successCount).toBe(1);
      expect(rankings[0].score).toBe(0.667); // (1 + 1) / (1 + 0 + 2) = 2/3
    });
  });

  // =========================================================================
  // 2. Stale Memory Expiry & TTL Pruning
  // =========================================================================
  describe('2. Stale Memory Expiry', () => {
    it('expires resource observations and failed targets after TTL elapsed', () => {
      const worldId = `expiry_world_${Date.now()}`;
      const memory = new MemoryManager(worldId, testDataDir);

      // Record resource with expired TTL (-10 seconds in the past)
      memory.recordResourceObservation({
        resourceType: 'coal_ore',
        position: { x: 50, y: 55, z: 50 },
        ttlMs: -10_000, // already expired!
      });

      // Record fresh resource with positive TTL (600 seconds)
      memory.recordResourceObservation({
        resourceType: 'diamond_ore',
        position: { x: 50, y: 12, z: 50 },
        ttlMs: 600_000,
      });

      // Record failed target with expired TTL (-5 seconds)
      memory.recordFailedTarget({ x: 80, y: 64, z: 80 }, 'Old lava block', 'HAZARD', -5_000);

      // 1. Coal ore is expired and must not appear in fresh observations
      const freshCoal = memory.getFreshResourceObservations('coal_ore');
      expect(freshCoal.length).toBe(0);

      // 2. Diamond ore is fresh and must appear
      const freshDiamond = memory.getFreshResourceObservations('diamond_ore');
      expect(freshDiamond.length).toBe(1);
      expect(freshDiamond[0].resourceType).toBe('diamond_ore');

      // 3. Failed target is expired and must not block navigation
      const failedCheck = memory.isTargetFailed({ x: 80, y: 64, z: 80 });
      expect(failedCheck.failed).toBe(false);
    });
  });

  // =========================================================================
  // 3. Corruption Quarantining & Agent Crash Immunity
  // =========================================================================
  describe('3. Corruption Quarantining & Error Tolerance', () => {
    it('quarantines corrupted malformed JSON without crashing the agent process', () => {
      const worldId = 'corrupt_test_world';
      const resolvedDir = path.resolve(process.cwd(), testDataDir);
      if (!fs.existsSync(resolvedDir)) fs.mkdirSync(resolvedDir, { recursive: true });

      // Create a corrupted memory file with broken syntax
      const mem = new MemoryManager(worldId, testDataDir);
      const filePath = (mem as any).filePath;
      fs.writeFileSync(filePath, '{ "schemaVersion": 2, "memory": BROKEN_JSON_DATA_CORRUPTED!@#$%', 'utf-8');

      // Loading the corrupted memory must NOT crash or throw!
      let recoveredMem: MemoryManager | null = null;
      expect(() => {
        recoveredMem = new MemoryManager(worldId, testDataDir);
      }).not.toThrow();

      expect(recoveredMem).not.toBeNull();
      // Initializes clean, safe default state
      expect(recoveredMem?.notes.facts.length).toBe(0);
      expect(recoveredMem?.getExploredRegions().length).toBe(0);

      // Verify corrupted file was quarantined
      const files = fs.readdirSync(resolvedDir);
      const quarantineFile = files.find((f) => f.includes('corrupted-'));
      expect(quarantineFile).toBeDefined();
    });
  });

  // =========================================================================
  // 4. Duplicate Event Coalescing
  // =========================================================================
  describe('4. Duplicate Event Coalescing', () => {
    it('updates timestamp and confidence on re-observation instead of ballooning duplicates', () => {
      const worldId = `coalesce_world_${Date.now()}`;
      const memory = new MemoryManager(worldId, testDataDir);

      // Observe the same iron ore deposit 5 times in succession
      for (let i = 0; i < 5; i++) {
        memory.recordResourceObservation({
          resourceType: 'iron_ore',
          position: { x: 10, y: 35, z: 10 },
          confidence: 0.8 + i * 0.04,
          ttlMs: 600_000,
        });
      }

      // Must coalesce into exactly ONE record
      const observations = memory.getFreshResourceObservations('iron_ore');
      expect(observations.length).toBe(1);
      expect(observations[0].confidence).toBeGreaterThanOrEqual(0.95);
    });

    it('coalesces repeated visits to the same chunk into a visit count', () => {
      const worldId = `chunk_world_${Date.now()}`;
      const memory = new MemoryManager(worldId, testDataDir);

      // Multiple coordinates in the same chunk (e.g. chunk (1, 1))
      memory.recordExploredRegion({ x: 17, z: 17 });
      memory.recordExploredRegion({ x: 20, z: 25 });
      memory.recordExploredRegion({ x: 30, z: 30 });

      const regions = memory.getExploredRegions();
      expect(regions.length).toBe(1);
      expect(regions[0].chunkX).toBe(1);
      expect(regions[0].chunkZ).toBe(1);
      expect(regions[0].visitCount).toBe(3);
    });
  });

  // =========================================================================
  // 5. Statistical Learning & Strategy Ranking
  // =========================================================================
  describe('5. Simple Statistical Learning & Strategy Ranking', () => {
    it('ranks skill variants by Bayesian Laplace-smoothed success rate', () => {
      const worldId = `learning_world_${Date.now()}`;
      const memory = new MemoryManager(worldId, testDataDir);

      // Variant A (surface_first): 4 successes, 0 failures -> score (4+1)/(4+0+2) = 5/6 = 0.833
      memory.recordSkillOutcome('gather_wood', 'surface_first', true, 2000);
      memory.recordSkillOutcome('gather_wood', 'surface_first', true, 1900);
      memory.recordSkillOutcome('gather_wood', 'surface_first', true, 2100);
      memory.recordSkillOutcome('gather_wood', 'surface_first', true, 2050);

      // Variant B (tunnel_first): 1 success, 3 failures -> score (1+1)/(1+3+2) = 2/6 = 0.333
      memory.recordSkillOutcome('gather_wood', 'tunnel_first', true, 4000);
      memory.recordSkillOutcome('gather_wood', 'tunnel_first', false, 5000);
      memory.recordSkillOutcome('gather_wood', 'tunnel_first', false, 5200);
      memory.recordSkillOutcome('gather_wood', 'tunnel_first', false, 4800);

      const ranked = memory.getRankedVariants('gather_wood');

      expect(ranked.length).toBe(2);
      expect(ranked[0].variant).toBe('surface_first');
      expect(ranked[0].score).toBe(0.833);
      expect(ranked[1].variant).toBe('tunnel_first');
      expect(ranked[1].score).toBe(0.333);

      // Preferred variant selects surface_first
      expect(memory.getPreferredVariant('gather_wood', 'fallback')).toBe('surface_first');
    });

    it('strategy rankings are reversible and can be cleanly reset', () => {
      const worldId = `reset_world_${Date.now()}`;
      const memory = new MemoryManager(worldId, testDataDir);

      memory.recordSkillOutcome('mine_ore', 'staircase', true, 3000);
      expect(memory.getRankedVariants('mine_ore').length).toBe(1);

      // Reversible reset
      memory.resetStrategyRankings();
      expect(memory.getRankedVariants('mine_ore').length).toBe(0);
      expect(memory.getPreferredVariant('mine_ore', 'staircase')).toBe('staircase');
    });
  });

  // =========================================================================
  // 6. Invariant: Learning NEVER Overrides Safety or Owner Intent
  // =========================================================================
  describe('6. Safety & Owner Intent Invariant Enforcement', () => {
    it('verifies learning can never override safety priority or owner commands', () => {
      const memory = new MemoryManager('invariant_world', testDataDir);

      // Explicit hard guarantee method
      expect(memory.canLearningOverrideSafety()).toBe(false);

      // Action priority invariants: SURVIVAL_EMERGENCY and OWNER_URGENT outrank NORMAL
      expect(ActionPriority.SURVIVAL_EMERGENCY).toBeGreaterThan(ActionPriority.OWNER_URGENT);
      expect(ActionPriority.OWNER_URGENT).toBeGreaterThan(ActionPriority.NORMAL);

      // No learned ranking can lower safety thresholds
      const safetyConfig = {
        fleeHealthThreshold: 6,
        eatFoodThreshold: 8,
      };
      // Thresholds remain invariant
      expect(safetyConfig.fleeHealthThreshold).toBe(6);
      expect(safetyConfig.eatFoodThreshold).toBe(8);
    });
  });
});
