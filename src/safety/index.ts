import { AppConfig } from '../config/index.js';
import { Observation } from '../types/index.js';
import { isWithinBounds } from '../utils/math.js';

export interface SafetyCheckResult {
  allowed: boolean;
  reason?: string;
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
      if (/[\n\r;&|]/.test(rawCmd)) {
        return {
          allowed: false,
          reason: 'Command chaining or control characters are forbidden.',
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
