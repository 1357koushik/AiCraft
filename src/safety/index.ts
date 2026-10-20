import { Bot } from 'mineflayer';
import { AppConfig } from '../config/index.js';
import { Observation, EntityInfo } from '../types/index.js';
import { isWithinBounds, distance3D } from '../utils/math.js';

export interface SafetyCheckResult {
  allowed: boolean;
  reason?: string;
}

export interface TargetResolutionResult {
  valid: boolean;
  rawEntity?: any;
  targetObs?: EntityInfo;
  reason?: string;
}

/**
 * Resolves a target entity ID from an observation and verifies the live entity state.
 * Prevents targeting dead entities, despawned entities, ID reuse, and protected entities.
 */
export function resolveAndValidateTarget(
  bot: Bot,
  targetId: string,
  observation: Observation,
  config: AppConfig,
  maxReach: number = 4.5
): TargetResolutionResult {
  // 1. Look up target in the observation snapshot that generated the request
  const targetObs = observation.entities.find((e) => e.id === targetId || e.name === targetId);
  if (!targetObs) {
    return { valid: false, reason: `Target entity '${targetId}' was not found in the decision observation.` };
  }

  // 2. Safety checks against owner and friends
  if (targetObs.isOwner || config.agent.owners.includes(targetObs.name) || config.agent.friends.includes(targetObs.name)) {
    return { valid: false, reason: `Safety invariant violation: '${targetObs.name}' is an owner or friend.` };
  }
  if (config.safety.protectedEntities.includes(targetObs.type)) {
    return { valid: false, reason: `Safety invariant violation: '${targetObs.type}' is a protected entity type.` };
  }

  // 3. Look up the live entity by rawId
  const rawEntity = bot.entities[targetObs.rawId];
  if (!rawEntity) {
    return { valid: false, reason: `Target entity '${targetObs.name}' (rawId ${targetObs.rawId}) is no longer loaded in the world.` };
  }

  // 4. Validate that the live entity is alive and valid
  if ((rawEntity as any).isValid === false) {
    return { valid: false, reason: `Target entity '${targetObs.name}' is no longer valid.` };
  }
  if (typeof (rawEntity as any).health === 'number' && (rawEntity as any).health <= 0) {
    return { valid: false, reason: `Target entity '${targetObs.name}' is dead.` };
  }

  // 5. Prevent entity ID reuse / stale substitution:
  // Check that the live entity type matches the snapshot type
  const currentType = rawEntity.name || rawEntity.type || 'unknown';
  if (currentType !== targetObs.type && rawEntity.username !== targetObs.name) {
    return {
      valid: false,
      reason: `Target entity ID mismatch: entity was '${targetObs.type}' but is now '${currentType}'. ID was reused by server.`,
    };
  }

  // 6. Check distance from bot
  if (bot.entity) {
    const dist = distance3D(bot.entity.position, rawEntity.position);
    if (dist > maxReach) {
      return {
        valid: false,
        rawEntity,
        targetObs,
        reason: `Target '${targetObs.name}' is out of reach (${dist.toFixed(1)}m > max ${maxReach}m).`,
      };
    }
  }

  return { valid: true, rawEntity, targetObs };
}

export class SafetyManager {
  private config: AppConfig;
  private actionTimestamps: number[] = [];
  private maxActionsPerMinute = 60;

  constructor(config: AppConfig) {
    this.config = config;
  }

  public checkActionRateLimit(): SafetyCheckResult {
    const now = Date.now();
    this.actionTimestamps = this.actionTimestamps.filter((t) => now - t < 60000);

    if (this.actionTimestamps.length >= this.maxActionsPerMinute) {
      return {
        allowed: false,
        reason: `Action rate limit exceeded (${this.maxActionsPerMinute}/min). Slowing down.`,
      };
    }

    this.actionTimestamps.push(now);
    return { allowed: true };
  }

  public validateActionSafety(actionName: string, params: any, obs: Observation): SafetyCheckResult {
    // 1. Blocked actions check
    if (this.config.safety.blockedActions.includes(actionName)) {
      return {
        allowed: false,
        reason: `Action '${actionName}' is explicitly blocked in safety settings.`,
      };
    }

    // 2. Command execution safety
    if (actionName === 'run_command') {
      if (!this.config.safety.allowCommandExecution) {
        return {
          allowed: false,
          reason: 'Command execution is disabled by default.',
        };
      }
      const rawCmd = String(params?.command || '').trim();
      // Block command chaining or injection characters
      if (/[\n\r;&|`$><\\()]/.test(rawCmd)) {
        return {
          allowed: false,
          reason: 'Command injection rejected: control characters, chaining, pipes, or shell operators are forbidden.',
        };
      }
      const cleanedCmd = rawCmd.replace(/^\//, '').trim();
      const tokens = cleanedCmd.split(/\s+/);
      const baseCmd = tokens[0]?.toLowerCase();
      if (!baseCmd || !this.config.safety.commandAllowlist.map((c) => c.toLowerCase()).includes(baseCmd)) {
        return {
          allowed: false,
          reason: `Command '${baseCmd || 'empty'}' is not permitted by command allowlist.`,
        };
      }
    }

    // 3. Attack protection check (owner, friends, protected entities)
    if (actionName === 'attack' || actionName === 'shoot') {
      const targetId = params?.targetId;
      if (targetId) {
        const ent = obs.entities.find((e) => e.id === targetId);
        if (ent) {
          if (ent.isOwner || this.config.agent.owners.includes(ent.name)) {
            return {
              allowed: false,
              reason: `Safety violation: Target ${ent.name} is the bot owner. Attack forbidden.`,
            };
          }
          if (this.config.agent.friends.includes(ent.name)) {
            return {
              allowed: false,
              reason: `Safety violation: Target ${ent.name} is a designated friend. Attack forbidden.`,
            };
          }
          if (this.config.safety.protectedEntities.includes(ent.type)) {
            return {
              allowed: false,
              reason: `Safety violation: Target type ${ent.type} is protected. Attack forbidden.`,
            };
          }
        }
      }
    }

    // 4. Bounded coordinates check for goto
    if (actionName === 'goto' && params?.x !== undefined && params?.z !== undefined) {
      const botPos = obs.position.blockCoords;
      const targetPos = { x: params.x, y: params.y ?? botPos.y, z: params.z };
      const maxRadius = this.config.perception.scanRadius * 2;

      if (!isWithinBounds(targetPos, botPos, maxRadius, 64)) {
        return {
          allowed: false,
          reason: `Coordinate (${params.x}, ${params.z}) exceeds safe local bound of ${maxRadius} blocks from bot.`,
        };
      }
    }

    return { allowed: true };
  }

  public isAuthorizedOwnerCommand(sender: string, message: string): boolean {
    if (!this.config.agent.owners.includes(sender)) {
      return false;
    }
    return message.startsWith('!') || message.startsWith('/');
  }
}
