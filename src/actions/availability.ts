import { Bot } from 'mineflayer';
import {
  ActionDef,
  ActionExecutionContext,
  ActionResult,
  AvailableActionCatalogItem,
  Observation,
} from '../types/index.js';
import { actionMap, allActions } from './registry.js';
import { AppConfig } from '../config/index.js';

export class AvailabilityEngine {
  public static computeAvailableCatalog(
    bot: Bot,
    obs: Observation,
    config: AppConfig,
    logger: any
  ): AvailableActionCatalogItem[] {
    const catalog: AvailableActionCatalogItem[] = [];
    const ctx: ActionExecutionContext = { bot, observation: obs, config, logger };

    for (const act of allActions) {
      // Check if blocked in safety config
      if (config.safety.blockedActions.includes(act.name)) {
        continue;
      }

      try {
        if (act.isAvailable(bot, obs, ctx)) {
          let choices: Record<string, any[]> | undefined;
          if (act.getAvailableChoices) {
            choices = act.getAvailableChoices(bot, obs, ctx);
          }

          catalog.push({
            action: act.name,
            category: act.category,
            description: act.description,
            parameters: act.parameterSchema,
            availableChoices: choices,
          });
        }
      } catch (err: any) {
        logger?.debug({ action: act.name, err: err.message }, 'Availability check threw');
      }
    }

    return catalog;
  }

  public static revalidateAction(
    actionName: string,
    params: any,
    bot: Bot,
    obs: Observation,
    config: AppConfig,
    logger: any
  ): { valid: boolean; reason?: string } {
    const act = actionMap.get(actionName);
    if (!act) {
      return { valid: false, reason: `Unknown action: "${actionName}"` };
    }

    if (config.safety.blockedActions.includes(actionName)) {
      return { valid: false, reason: `Action "${actionName}" is blocked by safety configuration.` };
    }

    const ctx: ActionExecutionContext = { bot, observation: obs, config, logger };
    const available = act.isAvailable(bot, obs, ctx);
    if (!available) {
      return { valid: false, reason: `Action "${actionName}" is not currently available in world state.` };
    }

    // Specific parameter checks
    if (actionName === 'attack' && params?.targetId) {
      const ent = obs.entities.find((e) => e.id === params.targetId);
      if (ent && (ent.isOwner || config.agent.owners.includes(ent.name) || config.agent.friends.includes(ent.name))) {
        return { valid: false, reason: `Cannot attack protected entity: ${ent.name}` };
      }
    }

    if (actionName === 'dig_block' && params?.blockType) {
      if (params.blockType === 'bedrock') {
        return { valid: false, reason: 'Bedrock cannot be mined.' };
      }
    }

    return { valid: true };
  }

  public static async executeWithTimeout(
    actionName: string,
    params: any,
    bot: Bot,
    obs: Observation,
    config: AppConfig,
    logger: any,
    abortSignal?: AbortSignal,
    timeoutMs: number = 25000
  ): Promise<ActionResult> {
    const act = actionMap.get(actionName);
    if (!act) {
      return { status: 'failed', reason: `Unknown action: "${actionName}"` };
    }

    if (abortSignal?.aborted) {
      return { status: 'interrupted', reason: `Action "${actionName}" was aborted before execution.` };
    }

    const ctx: ActionExecutionContext = { bot, observation: obs, config, logger, abortSignal };

    let timer: NodeJS.Timeout | null = null;
    let onAbort: (() => void) | null = null;

    const timeoutPromise = new Promise<ActionResult>((resolve) => {
      timer = setTimeout(() => {
        try {
          (bot as any).pathfinder?.stop();
          (bot as any).pathfinder?.setGoal(null);
        } catch {}
        try {
          bot.clearControlStates();
          bot.deactivateItem();
        } catch {}
        resolve({ status: 'interrupted', reason: `Action "${actionName}" timed out after ${timeoutMs}ms.` });
      }, timeoutMs);
    });

    const abortPromise = new Promise<ActionResult>((resolve) => {
      if (abortSignal) {
        onAbort = () => {
          try {
            (bot as any).pathfinder?.stop();
            (bot as any).pathfinder?.setGoal(null);
          } catch {}
          try {
            bot.clearControlStates();
            bot.deactivateItem();
          } catch {}
          resolve({ status: 'interrupted', reason: `Action "${actionName}" was preempted or cancelled.` });
        };
        if (abortSignal.aborted) {
          onAbort();
        } else {
          abortSignal.addEventListener('abort', onAbort, { once: true });
        }
      }
    });

    try {
      const result = await Promise.race([act.execute(bot, params, ctx), timeoutPromise, abortPromise]);
      return result;
    } catch (err: any) {
      return { status: 'failed', reason: `Action execution error: ${err.message || 'unknown error'}` };
    } finally {
      if (timer) clearTimeout(timer);
      if (abortSignal && onAbort) {
        abortSignal.removeEventListener('abort', onAbort);
      }
    }
  }
}
