import { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { goals, Movements } from 'mineflayer-pathfinder';
import { ActionExecutionContext, ActionResult } from '../types/index.js';
import { distance3D } from '../utils/math.js';
import { updatePathfinderMovements } from './techniques.js';
import { isActionContextActive } from '../agent/arbiter.js';
import {
  NavigationFailureKind,
  BlacklistEntry,
  NavigationBlacklist,
  navigationBlacklist,
} from './blacklist.js';

export { NavigationFailureKind, BlacklistEntry, NavigationBlacklist, navigationBlacklist };

export type NavigationIntent = '3d' | 'horizontal';

export type NavigationStatus =
  | 'idle'
  | 'preflight'
  | 'navigating'
  | 'arrived'
  | 'unreachable'
  | 'stalled'
  | 'timed_out'
  | 'cancelled'
  | 'stale_target'
  | 'hazard'
  | 'failed';

export interface CandidateRiskAssessment {
  valid: boolean;
  score: number; // lower score is better (distance + hazard/risk penalties)
  riskFactors: string[];
  failureKind?: NavigationFailureKind;
  rejectionReason?: string;
  targetPos: Vec3;
}

export interface CandidateEvaluationOptions {
  intent?: NavigationIntent;
  maxDistance?: number;
  allowWater?: boolean;
}

/**
 * Evaluates candidate navigation targets using fresh observations, environmental
 * hazards, blacklist state, and hostile mob proximity to calculate route/risk cost.
 */
export function evaluateCandidateTarget(
  bot: Bot,
  candidate: Vec3,
  options: CandidateEvaluationOptions = {}
): CandidateRiskAssessment {
  const riskFactors: string[] = [];
  const botPos = bot.entity?.position ?? new Vec3(0, 64, 0);
  const dist = distance3D(botPos, candidate);
  const intent = options.intent ?? '3d';
  const horizontalOnly = intent === 'horizontal';

  // 1. Max distance limit
  if (options.maxDistance && dist > options.maxDistance) {
    return {
      valid: false,
      score: Infinity,
      riskFactors: ['exceeds_max_distance'],
      failureKind: 'UNREACHABLE',
      rejectionReason: `Target distance (${dist.toFixed(1)}m) exceeds maximum allowed (${options.maxDistance}m).`,
      targetPos: candidate,
    };
  }

  // 2. Blacklist check
  if (navigationBlacklist.isBlacklisted(candidate, 1.2, horizontalOnly)) {
    const entry = navigationBlacklist.getEntry(candidate, horizontalOnly);
    return {
      valid: false,
      score: Infinity,
      riskFactors: ['blacklisted'],
      failureKind: entry?.failureKind ?? 'UNREACHABLE',
      rejectionReason: `Target coordinate (${candidate.x}, ${candidate.y}, ${candidate.z}) is blacklisted: ${entry?.reason || 'recent failure'}.`,
      targetPos: candidate,
    };
  }

  // 3. Chunk loaded / observation freshness check
  if (bot.blockAt) {
    const destBlock = bot.blockAt(candidate);
    if (destBlock === null) {
      // Chunk not loaded or unloaded
      return {
        valid: false,
        score: Infinity,
        riskFactors: ['unloaded_chunk'],
        failureKind: 'STALE_TARGET',
        rejectionReason: `Target block at (${candidate.x}, ${candidate.y}, ${candidate.z}) is in an unloaded chunk.`,
        targetPos: candidate,
      };
    }

    const groundBlock = bot.blockAt(candidate.offset(0, -1, 0));
    // Environmental hazard checks
    const isLava = destBlock?.name === 'lava' || destBlock?.name === 'flowing_lava' || groundBlock?.name === 'lava';
    const isFire = destBlock?.name === 'fire' || destBlock?.name === 'soul_fire';
    if (isLava || isFire) {
      return {
        valid: false,
        score: Infinity,
        riskFactors: ['lava_fire_hazard'],
        failureKind: 'HAZARD_OBSTRUCTION',
        rejectionReason: 'Target destination contains deadly lava or fire hazard.',
        targetPos: candidate,
      };
    }

    const inWater = Boolean((bot.entity as any)?.isInWater);
    const isWater = destBlock?.name === 'water' || destBlock?.name === 'flowing_water' || groundBlock?.name === 'water';
    if (isWater && !inWater && !options.allowWater) {
      return {
        valid: false,
        score: Infinity,
        riskFactors: ['water_drowning_hazard'],
        failureKind: 'HAZARD_OBSTRUCTION',
        rejectionReason: 'Target destination is a water hazard (drowning risk).',
        targetPos: candidate,
      };
    }

    // Fall hazard: ground is air for > 3 blocks down
    if (groundBlock?.name === 'air') {
      let fallDepth = 1;
      while (fallDepth <= 4) {
        const below = bot.blockAt(candidate.offset(0, -(fallDepth + 1), 0));
        if (below && below.name !== 'air') break;
        fallDepth++;
      }
      if (fallDepth > 3) {
        riskFactors.push('deep_chasm_drop');
      }

      // Floating sky target check: target is suspended high in mid-air with no solid footing
      if (intent !== 'horizontal') {
        let airBlocksBelow = 0;
        for (let dy = 1; dy <= 4; dy++) {
          const below = bot.blockAt(candidate.offset(0, -dy, 0));
          if (below && (below.name === 'air' || below.name === 'cave_air' || below.name === 'void_air')) {
            airBlocksBelow++;
          } else {
            break;
          }
        }
        const botY = bot.entity?.position?.y ?? candidate.y;
        const heightDelta = candidate.y - botY;
        if (airBlocksBelow >= 3 && heightDelta > 3) {
          return {
            valid: false,
            score: Infinity,
            riskFactors: ['floating_sky_target', 'unreachable_elevation'],
            failureKind: 'UNREACHABLE',
            rejectionReason: `Target destination at (${candidate.x}, ${candidate.y}, ${candidate.z}) is floating in mid-air with no solid footing (${airBlocksBelow} air blocks beneath).`,
            targetPos: candidate,
          };
        }
      }
    }
  }

  // 4. Hostile mob proximity risk
  let mobPenalty = 0;
  if (bot.entities) {
    for (const ent of Object.values(bot.entities) as any[]) {
      if (!ent || !ent.position) continue;
      const mobDist = distance3D(ent.position, candidate);
      if (mobDist < 8) {
        const name = (ent.name || '').toLowerCase();
        if (name === 'creeper') {
          riskFactors.push('near_creeper');
          mobPenalty += (8 - mobDist) * 15;
        } else if (['zombie', 'skeleton', 'spider', 'witch', 'enderman', 'drowned'].includes(name)) {
          riskFactors.push(`near_${name}`);
          mobPenalty += (8 - mobDist) * 5;
        }
      }
    }
  }

  let baseScore = dist + mobPenalty;
  if (riskFactors.includes('deep_chasm_drop')) baseScore += 25;

  return {
    valid: true,
    score: baseScore,
    riskFactors,
    targetPos: candidate,
  };
}

export interface NavigationOptions {
  target: Vec3;
  range?: number;
  intent?: NavigationIntent;
  timeoutMs?: number;
  allowStallRecovery?: boolean;
  preflightCheck?: boolean;
  preflightTimeoutMs?: number;
  stuckThresholdMs?: number;
  customGoal?: goals.Goal;
  maxStuckResets?: number;
}

export interface NavigationExecutionResult {
  status: NavigationStatus;
  success: boolean;
  failureKind?: NavigationFailureKind;
  reason: string;
  attempt: {
    startPos: Vec3;
    targetPos: Vec3;
    intent: NavigationIntent;
    distance: number;
    elapsedMs: number;
    stalled: boolean;
    timedOut: boolean;
  };
}

/**
 * Bounded navigation controller with explicit start/target, status, deadline,
 * progress/stall detection, cancellation, and failure recording.
 */
export async function navigateWithBounds(
  bot: Bot,
  options: NavigationOptions,
  ctx: ActionExecutionContext
): Promise<NavigationExecutionResult> {
  const startedAt = Date.now();
  const startPos = bot.entity?.position ? bot.entity.position.clone() : new Vec3(0, 64, 0);
  const targetPos = options.target.clone();
  const range = options.range ?? 1.5;
  const intent: NavigationIntent = options.intent ?? (options.target.y !== undefined ? '3d' : 'horizontal');
  const horizontalOnly = intent === 'horizontal';
  const initialDist = distance3D(startPos, targetPos);

  const attempt = {
    startPos,
    targetPos,
    intent,
    distance: initialDist,
    elapsedMs: 0,
    stalled: false,
    timedOut: false,
  };

  // 1. Cancellation check
  if (ctx.abortSignal?.aborted || !isActionContextActive(ctx)) {
    return {
      status: 'cancelled',
      success: false,
      failureKind: 'CANCELLED',
      reason: 'Navigation cancelled before start.',
      attempt,
    };
  }

  // 2. Candidate & Hazard Pre-check
  const assessment = evaluateCandidateTarget(bot, targetPos, {
    intent,
    maxDistance: Math.max(32, (ctx.config?.perception?.scanRadius || 16) * 3),
  });

  if (!assessment.valid) {
    return {
      status: assessment.failureKind === 'STALE_TARGET' ? 'stale_target' : assessment.failureKind === 'HAZARD_OBSTRUCTION' ? 'hazard' : 'unreachable',
      success: false,
      failureKind: assessment.failureKind ?? 'UNREACHABLE',
      reason: assessment.rejectionReason || 'Target validation failed.',
      attempt,
    };
  }

  // 3. Range check (already arrived)
  if (intent === 'horizontal') {
    const horizontalDist = Math.hypot(startPos.x - targetPos.x, startPos.z - targetPos.z);
    if (horizontalDist <= range) {
      return {
        status: 'arrived',
        success: true,
        reason: `Already within horizontal range (${horizontalDist.toFixed(1)}m).`,
        attempt,
      };
    }
  } else {
    if (initialDist <= range) {
      return {
        status: 'arrived',
        success: true,
        reason: `Already within range (${initialDist.toFixed(1)}m).`,
        attempt,
      };
    }
  }

  // 4. Goal selection (strictly enforcing 3D vs horizontal intent)
  const goal: goals.Goal = options.customGoal
    ? options.customGoal
    : horizontalOnly
    ? new goals.GoalNearXZ(targetPos.x, targetPos.z, range)
    : new goals.GoalNear(targetPos.x, targetPos.y, targetPos.z, range);

  // 5. Update Movements and Run Non-blocking Path Preflight
  const movements = updatePathfinderMovements(bot);
  if (options.preflightCheck !== false && (bot as any).pathfinder?.getPathTo && movements) {
    try {
      const preflightTimeout = Math.min(options.preflightTimeoutMs || 100, 150);
      const preflightResult = (bot as any).pathfinder.getPathTo(movements, goal, preflightTimeout);
      if (preflightResult && preflightResult.status === 'noPath') {
        navigationBlacklist.recordFailure(targetPos, 'unreachable (preflight noPath)', 'UNREACHABLE', undefined, horizontalOnly);
        return {
          status: 'unreachable',
          success: false,
          failureKind: 'UNREACHABLE',
          reason: 'Target unreachable: pathfinder preflight found no valid path.',
          attempt: { ...attempt, elapsedMs: Date.now() - startedAt },
        };
      }
    } catch {
      // Preflight error is non-fatal: proceed to live execution
    }
  }

  // 6. Deadline calculation (dynamic based on distance, bounded between 4s and 30s)
  const deadlineMs = options.timeoutMs ?? Math.max(4000, Math.min(30000, 3000 + initialDist * 600));

  // 7. Navigation execution with stall detector, deadline watchdog & abort monitoring
  let progressInterval: any = null;
  let onAbort: (() => void) | null = null;
  let onPathReset: ((reason: string) => void) | null = null;
  let lastPos = startPos.clone();
  let stationaryDurationMs = 0;
  let stuckResetCount = 0;
  const stuckThresholdMs = options.stuckThresholdMs ?? 2000;
  const maxStuckResets = options.maxStuckResets ?? 2;

  try {
    const gotoPromise = (bot as any).pathfinder.goto(goal);

    const racePromise = new Promise<never>((_, reject) => {
      // (a) Abort listener
      if (ctx.abortSignal) {
        onAbort = () => {
          try {
            (bot as any).pathfinder?.stop();
            (bot as any).pathfinder?.setGoal(null);
          } catch {}
          bot.clearControlStates?.();
          const err: any = new Error('Navigation cancelled by preemption signal.');
          err.name = 'NavigationCancelled';
          reject(err);
        };
        ctx.abortSignal.addEventListener('abort', onAbort, { once: true });
      }

      // (b) path_reset listener for stuck events
      onPathReset = (reason: string) => {
        if (reason === 'stuck') {
          stuckResetCount++;
          if (stuckResetCount >= maxStuckResets) {
            try {
              (bot as any).pathfinder?.stop();
              (bot as any).pathfinder?.setGoal(null);
            } catch {}
            bot.clearControlStates?.();
            navigationBlacklist.recordFailure(targetPos, 'stalled (repeated path_reset stuck)', 'STALLED', 45_000, horizontalOnly);
            const err: any = new Error(`Navigation stalled: pathfinder reset with stuck ${stuckResetCount} times.`);
            err.name = 'NavigationStalled';
            reject(err);
          }
        }
      };
      bot.on?.('path_reset', onPathReset);

      // (c) Positional progress & deadline polling interval (250ms)
      const intervalMs = 250;
      progressInterval = setInterval(() => {
        if (ctx.abortSignal?.aborted || !isActionContextActive(ctx)) {
          clearInterval(progressInterval);
          try {
            (bot as any).pathfinder?.stop();
            (bot as any).pathfinder?.setGoal(null);
          } catch {}
          bot.clearControlStates?.();
          const err: any = new Error('Navigation cancelled by preemption signal.');
          err.name = 'NavigationCancelled';
          reject(err);
          return;
        }

        const now = Date.now();
        const elapsed = now - startedAt;

        // Check deadline
        if (elapsed >= deadlineMs) {
          clearInterval(progressInterval);
          try {
            (bot as any).pathfinder?.stop();
            (bot as any).pathfinder?.setGoal(null);
          } catch {}
          bot.clearControlStates?.();
          navigationBlacklist.recordFailure(targetPos, `timed_out after ${(elapsed / 1000).toFixed(1)}s`, 'TIMED_OUT', 30_000, horizontalOnly);
          const err: any = new Error(`Navigation deadline exceeded (${(elapsed / 1000).toFixed(1)}s > ${(deadlineMs / 1000).toFixed(1)}s).`);
          err.name = 'NavigationTimedOut';
          reject(err);
          return;
        }

        // Check stall / positional progress
        if (options.allowStallRecovery !== false && bot.entity?.position) {
          const currentPos = bot.entity.position;
          const posDelta = distance3D(currentPos, lastPos);
          if (posDelta < 0.25) {
            stationaryDurationMs += intervalMs;
            if (stationaryDurationMs >= stuckThresholdMs && elapsed > 1500) {
              clearInterval(progressInterval);
              try {
                (bot as any).pathfinder?.stop();
                (bot as any).pathfinder?.setGoal(null);
              } catch {}
              bot.clearControlStates?.();
              navigationBlacklist.recordFailure(targetPos, `stalled: no movement progress for ${(stationaryDurationMs / 1000).toFixed(1)}s`, 'STALLED', 45_000, horizontalOnly);
              const err: any = new Error(`Navigation stalled: no movement progress for ${(stationaryDurationMs / 1000).toFixed(1)}s.`);
              err.name = 'NavigationStalled';
              reject(err);
              return;
            }
          } else {
            stationaryDurationMs = 0;
            lastPos = currentPos.clone();
          }
        }
      }, intervalMs);
    });

    await Promise.race([gotoPromise, racePromise]);

    attempt.elapsedMs = Date.now() - startedAt;
    return {
      status: 'arrived',
      success: true,
      reason: `Arrived at (${targetPos.x.toFixed(1)}, ${targetPos.y.toFixed(1)}, ${targetPos.z.toFixed(1)}).`,
      attempt,
    };
  } catch (err: any) {
    attempt.elapsedMs = Date.now() - startedAt;

    if (err.name === 'NavigationCancelled' || ctx.abortSignal?.aborted || !isActionContextActive(ctx)) {
      return {
        status: 'cancelled',
        success: false,
        failureKind: 'CANCELLED',
        reason: 'Navigation cancelled by preemption signal.',
        attempt,
      };
    }

    if (err.name === 'NavigationStalled') {
      attempt.stalled = true;
      return {
        status: 'stalled',
        success: false,
        failureKind: 'STALLED',
        reason: err.message,
        attempt,
      };
    }

    if (err.name === 'NavigationTimedOut') {
      attempt.timedOut = true;
      return {
        status: 'timed_out',
        success: false,
        failureKind: 'TIMED_OUT',
        reason: err.message,
        attempt,
      };
    }

    const msg = (err.message || '').toLowerCase();
    if (err.name === 'NoPath' || msg.includes('no path') || msg.includes('nopath')) {
      navigationBlacklist.recordFailure(targetPos, 'unreachable (NoPath)', 'UNREACHABLE', undefined, horizontalOnly);
      return {
        status: 'unreachable',
        success: false,
        failureKind: 'UNREACHABLE',
        reason: `Target unreachable: ${err.message}`,
        attempt,
      };
    }

    return {
      status: 'failed',
      success: false,
      failureKind: 'UNKNOWN',
      reason: `Navigation failed: ${err.message}`,
      attempt,
    };
  } finally {
    if (progressInterval) clearInterval(progressInterval);
    if (ctx.abortSignal && onAbort) ctx.abortSignal.removeEventListener('abort', onAbort);
    if (onPathReset) bot.removeListener?.('path_reset', onPathReset);

    if (isActionContextActive(ctx)) {
      try {
        (bot as any).pathfinder?.stop();
        (bot as any).pathfinder?.setGoal(null);
      } catch {}
      bot.clearControlStates?.();
    }
  }
}
