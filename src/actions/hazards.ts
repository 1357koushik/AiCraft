import { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { ActionExecutionContext, ActionResult, HazardSignal, Observation } from '../types/index.js';
import { isWaterBucketClutchPermitted } from '../safety/survival_policy.js';

export { HazardSignal };

/**
 * Evaluates whether the bot is currently in a dangerous free-fall that requires
 * emergency fall damage mitigation (water bucket clutch).
 */
export function detectFreeFallHazard(bot: Bot, obs?: Observation): HazardSignal | null {
  if (!bot.entity) return null;

  // Grounded or immersed states do not warrant fall clutching
  const onGround = Boolean(bot.entity.onGround ?? obs?.vitals?.movementState?.onGround);
  const inWater = Boolean((bot.entity as any)?.isInWater ?? obs?.vitals?.movementState?.inWater);
  const inLava = Boolean((bot.entity as any)?.isInLava ?? obs?.vitals?.movementState?.inLava);
  if (onGround || inWater || inLava) return null;

  const velocityY = bot.entity.velocity?.y ?? 0;
  const fallDistance = (bot.entity as any)?.fallDistance ?? obs?.vitals?.movementState?.fallDistance ?? 0;

  // Minecraft applies fall damage when fall distance > 3.0 blocks.
  // Detect if bot is falling rapidly (negative Y velocity) with substantial accumulated or impending fall distance.
  const isFallingDown = velocityY < -0.3;
  if (!isFallingDown && fallDistance < 3.0) return null;

  // Check distance to highest solid ground directly below the bot
  let groundY: number | null = null;
  const botPos = bot.entity.position;
  if (bot.blockAt) {
    for (let dy = 1; dy <= 40; dy++) {
      const checkBlock = bot.blockAt(botPos.offset(0, -dy, 0).floored());
      if (checkBlock && checkBlock.boundingBox === 'block') {
        groundY = checkBlock.position.y;
        break;
      }
    }
  }

  const currentHeightAboveGround = groundY !== null ? (botPos.y - (groundY + 1)) : fallDistance;
  const totalProjectedFall = Math.max(fallDistance, currentHeightAboveGround);

  if (totalProjectedFall < 3.5) {
    return null;
  }

  const severity = totalProjectedFall >= 15 ? 'FATAL' : totalProjectedFall >= 5 ? 'CRITICAL' : 'WARNING';
  const groundBlock = groundY !== null ? new Vec3(Math.floor(botPos.x), groundY, Math.floor(botPos.z)) : undefined;

  return {
    type: 'FREE_FALL',
    severity,
    sourceBlock: groundBlock,
    recommendedAction: 'CLUTCH_WATER',
    details: `Free fall detected: velocityY=${velocityY.toFixed(2)}, fallDistance=${fallDistance.toFixed(1)}, heightAboveGround=${currentHeightAboveGround.toFixed(1)}`,
  };
}

export const SUFFOCATING_GRAVITY_BLOCKS = new Set([
  'gravel',
  'sand',
  'red_sand',
  'suspicious_sand',
  'suspicious_gravel',
  'concrete_powder',
]);

/**
 * Detects whether the bot's head is trapped inside a falling gravity block (gravel, sand, concrete powder, etc.)
 * causing active or impending suffocation damage.
 */
export function detectSuffocationHazard(bot: Bot): HazardSignal | null {
  if (!bot.entity || !bot.blockAt) return null;

  const headPos = bot.entity.position.offset(0, 1.6, 0).floored();
  const headBlock = bot.blockAt(headPos);

  if (
    headBlock &&
    headBlock.boundingBox === 'block' &&
    SUFFOCATING_GRAVITY_BLOCKS.has(headBlock.name)
  ) {
    return {
      type: 'SUFFOCATION',
      severity: 'CRITICAL',
      sourceBlock: headPos,
      recommendedAction: 'DIG_OUT',
      details: `Head is trapped in solid gravity block ${headBlock.name} at (${headPos.x}, ${headPos.y}, ${headPos.z})`,
    };
  }

  return null;
}

/**
 * Detects whether a nearby creeper is preparing to detonate (swelling / ignited).
 */
export function detectExplosionHazard(bot: Bot, obs?: Observation): HazardSignal | null {
  if (!bot.entity) return null;

  const botPos = bot.entity.position;
  let targetCreeper: any = null;
  let minDistance = Infinity;

  // Check both raw bot.entities and parsed observation entities
  if (bot.entities) {
    for (const id of Object.keys(bot.entities)) {
      const ent = bot.entities[id];
      if (!ent || ent === bot.entity || ent.name !== 'creeper' || !ent.position) continue;
      const dist = Math.hypot(ent.position.x - botPos.x, ent.position.y - botPos.y, ent.position.z - botPos.z);
      if (dist <= 6.0 && dist < minDistance) {
        minDistance = dist;
        targetCreeper = ent;
      }
    }
  }

  if (!targetCreeper && obs?.entities) {
    for (const ent of obs.entities) {
      if ((ent.type === 'creeper' || ent.name === 'creeper') && ent.distance <= 6.0) {
        const raw = bot.entities?.[ent.rawId];
        if (raw && ent.distance < minDistance) {
          minDistance = ent.distance;
          targetCreeper = raw;
        }
      }
    }
  }

  if (!targetCreeper) return null;

  // Check creeper fuse / swelling metadata
  // In Minecraft Java Edition metadata:
  // index 16 is creeper state: 1 = swelling/igniting, -1 = idle
  const metadataSwelling = (targetCreeper as any).metadata?.[16] === 1;
  const isIgnited = Boolean((targetCreeper as any).ignited || (targetCreeper as any).fuse > 0);
  const isImminent = minDistance <= 3.2 || metadataSwelling || isIgnited;

  if (!isImminent) return null;

  const hasShield =
    Boolean(obs?.inventory?.toolSummary?.hasShield) ||
    Boolean(bot.inventory?.items().some((i) => i.name === 'shield')) ||
    bot.heldItem?.name === 'shield' ||
    (bot as any).supportFeature?.('offHand') && (bot as any).inventory?.slots[45]?.name === 'shield';

  const severity = minDistance <= 3.0 ? 'FATAL' : 'CRITICAL';

  return {
    type: 'EXPLOSION_IMMINENT',
    severity,
    sourceEntity: targetCreeper,
    recommendedAction: hasShield ? 'SHIELD_DEPLOY' : 'SPRINT_RETREAT',
    details: `Creeper at distance ${minDistance.toFixed(1)}m is swelling (ignited=${isIgnited}, swelling=${metadataSwelling})`,
  };
}

/**
 * Emergency Fall Mitigation Technique: Water Bucket Clutch.
 * Deploys water onto landing surface right before impact and scoops it back up.
 */
export async function techniqueWaterBucketClutch(
  bot: Bot,
  ctx?: Partial<ActionExecutionContext>
): Promise<ActionResult> {
  if (!bot.entity) {
    return { status: 'failed', reason: 'Bot entity unavailable for clutch.' };
  }

  // Dimension & safety check
  if (!isWaterBucketClutchPermitted(bot, { isEmergencyFall: true })) {
    return {
      status: 'failed',
      reason: 'Water bucket clutch is prohibited in this dimension (e.g. Nether evaporates water).',
    };
  }

  const items = bot.inventory ? bot.inventory.items() : [];
  const waterBucket = items.find((i) => i.name === 'water_bucket') || (bot.heldItem?.name === 'water_bucket' ? bot.heldItem : null);

  if (!waterBucket) {
    // Fallback: search for nearby existing water or soft landing blocks to steer toward
    let steerTarget: Vec3 | null = null;
    if (bot.blockAt) {
      const botPos = bot.entity.position.floored();
      for (let dy = 1; dy <= 16; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          for (let dz = -4; dz <= 4; dz++) {
            const check = bot.blockAt(botPos.offset(dx, -dy, dz));
            if (check && (check.name === 'water' || check.name === 'hay_block' || check.name === 'slime_block')) {
              steerTarget = check.position;
              break;
            }
          }
          if (steerTarget) break;
        }
        if (steerTarget) break;
      }
    }

    if (steerTarget && bot.lookAt) {
      try {
        await bot.lookAt(steerTarget.offset(0.5, 0.5, 0.5), true);
        bot.setControlState('forward', true);
      } catch {}
    }

    return {
      status: 'failed',
      reason: 'No water bucket available in inventory; attempted emergency trajectory steering.',
    };
  }

  // Equip water bucket in hand
  try {
    if (bot.heldItem?.name !== 'water_bucket') {
      await bot.equip(waterBucket, 'hand');
    }
  } catch (err: any) {
    return { status: 'failed', reason: `Failed to equip water bucket: ${err.message}` };
  }

  // Locate ground impact block directly underneath bot
  let groundBlock: any = null;
  const botPos = bot.entity.position;
  if (bot.blockAt) {
    for (let dy = 1; dy <= 20; dy++) {
      const b = bot.blockAt(botPos.offset(0, -dy, 0).floored());
      if (b && b.boundingBox === 'block') {
        groundBlock = b;
        break;
      }
    }
  }

  const targetFacePos = groundBlock
    ? groundBlock.position.offset(0.5, 1.0, 0.5)
    : botPos.offset(0, -1.5, 0);

  try {
    // Look directly down at the impact block
    if (bot.lookAt) {
      await bot.lookAt(targetFacePos, true);
    }

    // Place water
    bot.activateItem();

    // Brief cushion delay to ensure player contacts water column and resets fall distance
    await new Promise((res) => setTimeout(res, 200));

    // Scoop water back up to avoid flood contamination and preserve water bucket
    const emptyBucket = bot.inventory?.items().find((i) => i.name === 'bucket');
    if (emptyBucket && bot.heldItem?.name !== 'bucket') {
      try {
        await bot.equip(emptyBucket, 'hand');
      } catch {}
    }
    if (bot.lookAt) {
      await bot.lookAt(targetFacePos, true);
    }
    bot.activateItem();

    return {
      status: 'success',
      reason: 'Water bucket clutch successfully executed to prevent fall damage.',
    };
  } catch (err: any) {
    return { status: 'failed', reason: `Water bucket clutch failed: ${err.message}` };
  } finally {
    try {
      bot.clearControlStates?.();
    } catch {}
  }
}

/**
 * Emergency Suffocation Escape Technique.
 * Immediately digs out gravel, sand, or solid blocks encasing the bot's head.
 */
export async function techniqueEscapeSuffocation(
  bot: Bot,
  ctx?: Partial<ActionExecutionContext>
): Promise<ActionResult> {
  if (!bot.entity || !bot.blockAt) {
    return { status: 'failed', reason: 'Bot entity or block access unavailable.' };
  }

  const headPos = bot.entity.position.offset(0, 1.6, 0).floored();
  const headBlock = bot.blockAt(headPos);

  if (!headBlock || headBlock.boundingBox !== 'block' || headBlock.name === 'air' || headBlock.name === 'cave_air') {
    return { status: 'success', reason: 'Head is not currently suffocated.' };
  }

  // Equip best digging tool (shovel for gravel/sand, pickaxe for stone)
  const isSandOrGravel = ['gravel', 'sand', 'red_sand', 'concrete_powder', 'dirt'].includes(headBlock.name);
  if (bot.inventory) {
    const bestTool = bot.inventory.items().find((i) =>
      isSandOrGravel ? i.name.endsWith('_shovel') : (i.name.endsWith('_pickaxe') || i.name.endsWith('_shovel'))
    );
    if (bestTool && bot.heldItem?.name !== bestTool.name) {
      try {
        await bot.equip(bestTool, 'hand');
      } catch {}
    }
  }

  try {
    if (bot.dig) {
      await bot.dig(headBlock);
    }

    // Check block immediately above head for falling gravity columns
    const overheadPos = headPos.offset(0, 1, 0);
    const overheadBlock = bot.blockAt(overheadPos);
    if (overheadBlock && ['gravel', 'sand', 'red_sand', 'concrete_powder'].includes(overheadBlock.name)) {
      if (bot.dig) {
        await bot.dig(overheadBlock);
      }
    }

    return {
      status: 'success',
      reason: `Suffocation cleared by mining ${headBlock.name} at (${headPos.x}, ${headPos.y}, ${headPos.z})`,
    };
  } catch (err: any) {
    return {
      status: 'failed',
      reason: `Failed to mine suffocating block: ${err.message}`,
    };
  }
}

/**
 * Emergency Blast Mitigation Technique.
 * Deploys shield facing the creeper or sprint-retreats outside the blast radius.
 */
export async function techniqueDefendExplosion(
  bot: Bot,
  creeperEntity: any,
  ctx?: Partial<ActionExecutionContext>
): Promise<ActionResult> {
  if (!bot.entity) {
    return { status: 'failed', reason: 'Bot entity unavailable.' };
  }

  const items = bot.inventory ? bot.inventory.items() : [];
  const shield = items.find((i) => i.name === 'shield') || (bot.heldItem?.name === 'shield' ? bot.heldItem : null);

  // Strategy 1: Shield Block (absorbs 100% of explosion damage when facing detonation)
  if (shield) {
    try {
      try {
        await bot.equip(shield, 'off-hand');
      } catch {
        await bot.equip(shield, 'hand');
      }

      if (creeperEntity?.position && bot.lookAt) {
        const aimTarget = creeperEntity.position.offset(
          0,
          creeperEntity.height ? creeperEntity.height * 0.75 : 1.2,
          0
        );
        await bot.lookAt(aimTarget, true);
      }

      bot.activateItem(true);
      // Hold shield up through fuse duration
      await new Promise((res) => setTimeout(res, 600));
      try {
        bot.deactivateItem();
      } catch {}

      return {
        status: 'success',
        reason: 'Successfully raised shield to block creeper blast.',
      };
    } catch (err: any) {
      try { bot.deactivateItem(); } catch {}
      return { status: 'failed', reason: `Shield deployment failed: ${err.message}` };
    }
  }

  // Strategy 2: Sprint Retreat (no shield available)
  try {
    let retreatVector = new Vec3(1, 0, 0);
    if (creeperEntity?.position) {
      const diff = bot.entity.position.minus(creeperEntity.position);
      diff.y = 0;
      if (diff.norm() > 0.01) {
        retreatVector = diff.normalize();
      }
    }

    const retreatTarget = bot.entity.position.plus(retreatVector.scaled(10));
    if (bot.lookAt) {
      await bot.lookAt(retreatTarget, true);
    }

    bot.setControlState('sprint', true);
    bot.setControlState('forward', true);
    bot.setControlState('jump', true);

    await new Promise((res) => setTimeout(res, 800));

    bot.clearControlStates();

    return {
      status: 'success',
      reason: 'Sprint-retreated outside creeper blast radius.',
    };
  } catch (err: any) {
    return { status: 'failed', reason: `Sprint retreat failed: ${err.message}` };
  } finally {
    try {
      bot.clearControlStates?.();
    } catch {}
  }
}
