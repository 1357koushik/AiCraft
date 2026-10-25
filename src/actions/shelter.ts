import { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { ActionExecutionContext, ActionResult } from '../types/index.js';
import { distance3D } from '../utils/math.js';
import { isActionContextActive } from '../agent/arbiter.js';
import { isAlive } from '../safety/index.js';

// ============================================================================
// 1. Blueprint Specification & Bill of Materials (BOM)
// ============================================================================

export interface BlueprintBlockSpec {
  relX: number;
  relY: number;
  relZ: number;
  role: 'wall' | 'roof' | 'doorway' | 'interior' | 'floor';
}

export interface ShelterBlueprint {
  name: string;
  dimensions: { width: number; height: number; depth: number };
  interiorOffset: Vec3;
  entryOffset?: Vec3;
  torchOffset?: Vec3;
  blocks: BlueprintBlockSpec[];
}

export interface ShelterBuildResult {
  success: boolean;
  blocksPlaced: number;
  expectedBlocks: number;
  missingCoordinates: Vec3[];
  unobstructedInterior: boolean;
}

/**
 * Standard 3x3x3 Survival Shelter Blueprint:
 * - 3x3 footprint, 3 blocks high (Y=0, 1, 2 relative to bot feet).
 * - Central standing space (0, 0, 0) and (0, 1, 0) kept clear for bot.
 * - Single 1x2 doorway on front face (0, 0, 1) and (0, 1, 1).
 * - 8 perimeter wall blocks at feet level (Y=0), 1 doorway opening -> 7 blocks.
 * - 8 perimeter wall blocks at eye level (Y=1), 1 doorway opening -> 7 blocks.
 * - Full 3x3 solid roof at head ceiling level (Y=2) -> 9 blocks.
 * - Total materials required: 7 + 7 + 9 = 23 solid blocks.
 */
export const SURVIVAL_SHELTER_BLUEPRINT: ShelterBlueprint = {
  name: 'standard_survival_shelter_3x3',
  dimensions: { width: 3, height: 3, depth: 3 },
  interiorOffset: new Vec3(0, 0, 0),
  entryOffset: new Vec3(0, 0, 1),
  torchOffset: new Vec3(0, 1, -1),
  blocks: [
    // --- Layer 0: Lower Wall (Feet level) ---
    { relX: -1, relY: 0, relZ: -1, role: 'wall' },
    { relX:  0, relY: 0, relZ: -1, role: 'wall' },
    { relX:  1, relY: 0, relZ: -1, role: 'wall' },
    { relX: -1, relY: 0, relZ:  0, role: 'wall' },
    { relX:  0, relY: 0, relZ:  0, role: 'interior' }, // Interior standing room
    { relX:  1, relY: 0, relZ:  0, role: 'wall' },
    { relX: -1, relY: 0, relZ:  1, role: 'wall' },
    { relX:  0, relY: 0, relZ:  1, role: 'doorway' },  // Doorway lower opening
    { relX:  1, relY: 0, relZ:  1, role: 'wall' },

    // --- Layer 1: Upper Wall (Eye level) ---
    { relX: -1, relY: 1, relZ: -1, role: 'wall' },
    { relX:  0, relY: 1, relZ: -1, role: 'wall' },
    { relX:  1, relY: 1, relZ: -1, role: 'wall' },
    { relX: -1, relY: 1, relZ:  0, role: 'wall' },
    { relX:  0, relY: 1, relZ:  0, role: 'interior' }, // Interior head room
    { relX:  1, relY: 1, relZ:  0, role: 'wall' },
    { relX: -1, relY: 1, relZ:  1, role: 'wall' },
    { relX:  0, relY: 1, relZ:  1, role: 'doorway' },  // Doorway upper opening
    { relX:  1, relY: 1, relZ:  1, role: 'wall' },

    // --- Layer 2: Roof (Overhead Ceiling) ---
    { relX: -1, relY: 2, relZ: -1, role: 'roof' },
    { relX:  0, relY: 2, relZ: -1, role: 'roof' },
    { relX:  1, relY: 2, relZ: -1, role: 'roof' },
    { relX: -1, relY: 2, relZ:  0, role: 'roof' },
    { relX:  0, relY: 2, relZ:  0, role: 'roof' },     // Roof center closure
    { relX:  1, relY: 2, relZ:  0, role: 'roof' },
    { relX: -1, relY: 2, relZ:  1, role: 'roof' },
    { relX:  0, relY: 2, relZ:  1, role: 'roof' },     // Roof doorway lintel
    { relX:  1, relY: 2, relZ:  1, role: 'roof' },
  ],
};

export interface MaterialBill {
  requiredTotal: number;
  availableTotal: number;
  feasible: boolean;
  chosenMaterial: string | null;
  breakdown: Record<string, number>;
}

/**
 * Calculates material requirements for a blueprint against current bot inventory.
 * Prefers common building materials: cobblestone, cobbled_deepslate, stone, dirt.
 */
export function calculateShelterBOM(
  bot: Bot,
  blueprint: ShelterBlueprint = SURVIVAL_SHELTER_BLUEPRINT,
  reservedMaterials: Record<string, number> = {}
): MaterialBill {
  const solidBlocksNeeded = blueprint.blocks.filter((b) => b.role === 'wall' || b.role === 'roof').length;
  const preferredMaterials = ['cobblestone', 'cobbled_deepslate', 'stone', 'dirt', 'oak_planks'];

  const inventoryItems = typeof bot.inventory?.items === 'function' ? bot.inventory.items() : [];
  const breakdown: Record<string, number> = {};

  let totalAvailable = 0;
  let bestCandidateMaterial: string | null = null;
  let maxCandidateCount = 0;

  for (const it of inventoryItems) {
    if (!it || !it.name) continue;
    const reserved = reservedMaterials[it.name] || 0;
    const available = Math.max(0, it.count - reserved);

    if (available > 0 && (preferredMaterials.includes(it.name) || it.name.includes('planks') || it.name.includes('stone'))) {
      breakdown[it.name] = (breakdown[it.name] || 0) + available;
      totalAvailable += available;

      if (available > maxCandidateCount) {
        maxCandidateCount = available;
        bestCandidateMaterial = it.name;
      }
    }
  }

  return {
    requiredTotal: solidBlocksNeeded,
    availableTotal: totalAvailable,
    feasible: totalAvailable >= solidBlocksNeeded,
    chosenMaterial: bestCandidateMaterial,
    breakdown,
  };
}

// ============================================================================
// 2. Placement Support & Face Reference Resolution
// ============================================================================

export interface PlacementSupportResult {
  valid: boolean;
  refBlock: any | null;
  placeVector: Vec3 | null;
  reason?: string;
}

/**
 * Resolves placement support and exact reference face vector for a target position.
 * Verifies that the reference block is loaded, solid, and non-hazardous.
 */
export function resolvePlacementSupport(bot: Bot, targetPos: Vec3): PlacementSupportResult {
  if (typeof bot.blockAt !== 'function') {
    return { valid: false, refBlock: null, placeVector: null, reason: 'bot.blockAt unavailable' };
  }

  // Potential neighbor support directions: Below, North, South, East, West, Above
  const candidates: Array<{ offset: Vec3; faceVector: Vec3 }> = [
    { offset: new Vec3(0, -1, 0), faceVector: new Vec3(0, 1, 0) },   // Below (place on top face)
    { offset: new Vec3(0, 0, -1), faceVector: new Vec3(0, 0, 1) },   // North (place on south face)
    { offset: new Vec3(0, 0, 1), faceVector: new Vec3(0, 0, -1) },   // South (place on north face)
    { offset: new Vec3(-1, 0, 0), faceVector: new Vec3(1, 0, 0) },   // West (place on east face)
    { offset: new Vec3(1, 0, 0), faceVector: new Vec3(-1, 0, 0) },   // East (place on west face)
  ];

  for (const { offset, faceVector } of candidates) {
    const refPos = targetPos.plus(offset);
    const refBlock = bot.blockAt(refPos);

    if (!refBlock) continue;
    if (refBlock.boundingBox !== 'block') continue; // Must be solid block
    if (
      refBlock.name === 'air' ||
      refBlock.name === 'cave_air' ||
      refBlock.name === 'lava' ||
      refBlock.name === 'flowing_lava' ||
      refBlock.name === 'fire' ||
      refBlock.name === 'water' ||
      refBlock.name === 'flowing_water'
    ) {
      continue;
    }

    return {
      valid: true,
      refBlock,
      placeVector: faceVector,
    };
  }

  return {
    valid: false,
    refBlock: null,
    placeVector: null,
    reason: `No solid support neighbor found adjacent to (${targetPos.x}, ${targetPos.y}, ${targetPos.z})`,
  };
}

// ============================================================================
// 3. Closed-Loop Physical Enclosure Verification
// ============================================================================

export interface EnclosureVerificationReport {
  isFullyEnclosed: boolean;
  wallsComplete: boolean;
  roofComplete: boolean;
  interiorClear: boolean;
  doorwayValid: boolean;
  exteriorSafe: boolean;
  placedCount: number;
  totalBlueprintBlocks: number;
  missingBlocks: Vec3[];
  nearbyThreats: string[];
  reason: string;
}

/**
 * Closed-Loop Verification:
 * Examines actual world block states to certify genuine physical enclosure.
 * A placement function returning without error is NOT proof a shelter exists!
 */
export function verifyShelterEnclosure(
  bot: Bot,
  anchorPos: Vec3,
  blueprint: ShelterBlueprint = SURVIVAL_SHELTER_BLUEPRINT
): EnclosureVerificationReport {
  const missingBlocks: Vec3[] = [];
  let wallCount = 0;
  let wallPlaced = 0;
  let roofCount = 0;
  let roofPlaced = 0;
  let interiorClear = true;
  let doorwayValid = true;

  if (typeof bot.blockAt !== 'function') {
    return {
      isFullyEnclosed: false,
      wallsComplete: false,
      roofComplete: false,
      interiorClear: false,
      doorwayValid: false,
      exteriorSafe: false,
      placedCount: 0,
      totalBlueprintBlocks: blueprint.blocks.length,
      missingBlocks: [],
      nearbyThreats: [],
      reason: 'World inspection unavailable (bot.blockAt missing).',
    };
  }

  for (const b of blueprint.blocks) {
    const worldPos = anchorPos.offset(b.relX, b.relY, b.relZ);
    const liveBlock = bot.blockAt(worldPos);

    if (b.role === 'wall') {
      wallCount++;
      if (liveBlock && liveBlock.boundingBox === 'block') {
        wallPlaced++;
      } else {
        missingBlocks.push(worldPos);
      }
    } else if (b.role === 'roof') {
      roofCount++;
      if (liveBlock && liveBlock.boundingBox === 'block') {
        roofPlaced++;
      } else {
        missingBlocks.push(worldPos);
      }
    } else if (b.role === 'interior') {
      // Interior must be air/passable so the bot is not suffocating inside a wall
      if (liveBlock && liveBlock.boundingBox === 'block') {
        interiorClear = false;
      }
    } else if (b.role === 'doorway') {
      // Doorway must not be blocked by solid stone/dirt
      if (liveBlock && liveBlock.boundingBox === 'block' && !liveBlock.name.includes('door')) {
        doorwayValid = false;
      }
    }
  }

  const wallsComplete = wallCount > 0 && wallPlaced === wallCount;
  const roofComplete = roofCount > 0 && roofPlaced === roofCount;

  // Immediate exterior threat scan (radius 6 blocks)
  const nearbyThreats: string[] = [];
  if (bot.entities) {
    for (const id of Object.keys(bot.entities)) {
      const e = bot.entities[id];
      if (!e || e === bot.entity || !isAlive(e)) continue;
      if (e.position && e.type === 'mob' && distance3D(anchorPos, e.position) <= 6.0) {
        nearbyThreats.push(`${e.name || 'hostile'} at dist ${distance3D(anchorPos, e.position).toFixed(1)}m`);
      }
    }
  }

  const exteriorSafe = nearbyThreats.length === 0;
  const isFullyEnclosed = wallsComplete && roofComplete && interiorClear && doorwayValid;

  let reason = '';
  if (!isFullyEnclosed) {
    const reasons: string[] = [];
    if (!wallsComplete) reasons.push(`Walls incomplete (${wallPlaced}/${wallCount})`);
    if (!roofComplete) reasons.push(`Roof incomplete (${roofPlaced}/${roofCount})`);
    if (!interiorClear) reasons.push('Interior is obstructed/suffocating');
    if (!doorwayValid) reasons.push('Doorway obstructed');
    reason = `Shelter incomplete: ${reasons.join(', ')}.`;
  } else if (!exteriorSafe) {
    reason = `Shelter physically enclosed, but immediate exterior threats detected: ${nearbyThreats.join(', ')}.`;
  } else {
    reason = `Verified complete survival shelter enclosure (${wallPlaced + roofPlaced} blocks placed: ${wallPlaced} wall blocks, ${roofPlaced} roof blocks, interior clear, no immediate exterior threats).`;
  }

  return {
    isFullyEnclosed,
    wallsComplete,
    roofComplete,
    interiorClear,
    doorwayValid,
    exteriorSafe,
    placedCount: wallPlaced + roofPlaced,
    totalBlueprintBlocks: wallCount + roofCount,
    missingBlocks,
    nearbyThreats,
    reason,
  };
}

// ============================================================================
// 4. Autonomous Verified Shelter Construction Execution
// ============================================================================

export interface ShelterBuildOptions {
  blueprint?: ShelterBlueprint;
  reservedMaterials?: Record<string, number>;
  anchorPos?: Vec3;
}

/**
 * Executes Verified Shelter Construction:
 * 1. Checks Material Bill (BOM) before placing any blocks.
 * 2. Anchors blueprint to absolute world coordinates to support SAFE RESUMPTION if interrupted.
 * 3. Inspects current world state and skips already placed blocks.
 * 4. Places missing blocks bottom-up (layer 0 walls -> layer 1 walls -> layer 2 roof).
 * 5. Uses verified placement support and dynamic reference face vectors.
 * 6. Performs post-construction closed-loop physical enclosure verification.
 */
export async function techniqueBuildVerifiedShelter(
  bot: Bot,
  options: ShelterBuildOptions = {},
  ctx?: Partial<ActionExecutionContext>
): Promise<ActionResult> {
  if (ctx && !isActionContextActive(ctx)) {
    return { status: 'interrupted', reason: 'Shelter construction cancelled before start.' };
  }

  const blueprint = options.blueprint || SURVIVAL_SHELTER_BLUEPRINT;
  const anchorPos = options.anchorPos || bot.entity.position.floored();

  // 1. Pre-flight Bill of Materials check
  const bom = calculateShelterBOM(bot, blueprint, options.reservedMaterials);
  if (!bom.feasible) {
    return {
      status: 'failed',
      reason: `Insufficient building materials: need ${bom.requiredTotal} solid blocks, but only ${bom.availableTotal} available in inventory.`,
      details: { required: bom.requiredTotal, available: bom.availableTotal, breakdown: bom.breakdown },
    };
  }

  // 2. Identify missing blocks (Resumption support!)
  const initialInspection = verifyShelterEnclosure(bot, anchorPos, blueprint);
  if (initialInspection.isFullyEnclosed && initialInspection.exteriorSafe) {
    return {
      status: 'success',
      reason: 'Shelter at this location is already fully constructed and safely enclosed.',
      details: { inspection: initialInspection },
    };
  }

  console.log(`[SHELTER_BUILD] Constructing verified survival shelter at (${anchorPos.x}, ${anchorPos.y}, ${anchorPos.z}) with ${bom.chosenMaterial}...`);

  // Clear internal brush, vegetation, and soft obstructions in the 3x3x3 footprint
  if (typeof bot.blockAt === 'function') {
    for (const b of blueprint.blocks) {
      const worldPos = anchorPos.offset(b.relX, b.relY, b.relZ);
      const blk = bot.blockAt(worldPos);
      if (blk && blk.name !== 'air' && blk.name !== 'cave_air') {
        const isInteriorOrDoor = b.role === 'interior' || b.role === 'doorway';
        const isSoftFoliage =
          blk.boundingBox === 'empty' ||
          ['short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'dandelion', 'poppy', 'vine', 'cave_vines'].includes(blk.name);
        if (isInteriorOrDoor || isSoftFoliage) {
          const canDig = typeof bot.canDigBlock === 'function' ? bot.canDigBlock(blk) : true;
          if (canDig && typeof bot.dig === 'function') {
            try {
              await bot.dig(blk);
            } catch {}
          }
        }
      }
    }
  }

  // Sort blocks to build bottom-up: layer 0 walls first, then layer 1 walls, then layer 2 roof
  const blocksToBuild = blueprint.blocks
    .filter((b) => b.role === 'wall' || b.role === 'roof')
    .sort((a, b) => a.relY - b.relY);

  let placedInSession = 0;

  try {
    for (const b of blocksToBuild) {
      if (ctx && !isActionContextActive(ctx)) {
        return {
          status: 'interrupted',
          reason: `Shelter construction interrupted by higher-priority signal after placing ${placedInSession} blocks. Safe to resume later.`,
        };
      }

      const worldPos = anchorPos.offset(b.relX, b.relY, b.relZ);
      const current = typeof bot.blockAt === 'function' ? bot.blockAt(worldPos) : null;

      // Skip block if already placed
      if (current && current.boundingBox === 'block') {
        continue;
      }

      // Resolve placement support and reference face
      const support = resolvePlacementSupport(bot, worldPos);
      if (!support.valid || !support.refBlock || !support.placeVector) {
        console.log(`[SHELTER_BUILD] Warning: cannot place block at (${worldPos.x}, ${worldPos.y}, ${worldPos.z}): ${support.reason}`);
        continue;
      }

      // Equip building material
      const items = typeof bot.inventory?.items === 'function' ? bot.inventory.items() : [];
      const scaffoldItem = items.find((i) => i.name === bom.chosenMaterial) || items.find((i) => ['cobblestone', 'dirt', 'stone'].includes(i.name));

      if (!scaffoldItem) {
        return {
          status: 'failed',
          reason: `Ran out of building materials mid-construction after placing ${placedInSession} blocks.`,
          details: { placedInSession },
        };
      }

      if (bot.equip) {
        try { await bot.equip(scaffoldItem, 'hand'); } catch {}
      }

      if (ctx && !isActionContextActive(ctx)) {
        return { status: 'interrupted', reason: 'Shelter construction cancelled before block placement.' };
      }

      // Execute verified block placement
      if (bot.placeBlock) {
        try {
          await bot.placeBlock(support.refBlock, support.placeVector);
          placedInSession++;
        } catch (placeErr: any) {
          console.log(`[SHELTER_BUILD] PlaceBlock failed at (${worldPos.x}, ${worldPos.y}, ${worldPos.z}): ${placeErr.message}`);
        }
      }
    }
  } finally {
    if (ctx && isActionContextActive(ctx)) {
      try { bot.clearControlStates?.(); } catch {}
    }
  }

  // 3. Post-Construction Closed-Loop Enclosure Verification
  const finalInspection = verifyShelterEnclosure(bot, anchorPos, blueprint);

  const buildResult: ShelterBuildResult = {
    success: finalInspection.isFullyEnclosed,
    blocksPlaced: finalInspection.placedCount,
    expectedBlocks: finalInspection.totalBlueprintBlocks,
    missingCoordinates: finalInspection.missingBlocks,
    unobstructedInterior: finalInspection.interiorClear,
  };

  if (!finalInspection.isFullyEnclosed) {
    return {
      status: 'failed',
      reason: finalInspection.reason,
      details: {
        placedInSession,
        inspection: finalInspection,
        buildResult,
      },
    };
  }

  return {
    status: 'success',
    reason: finalInspection.reason,
    details: {
      placedInSession,
      inspection: finalInspection,
      buildResult,
    },
  };
}
