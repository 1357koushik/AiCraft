import { Bot } from 'mineflayer';

export enum ActionPriority {
  LOW = 10,
  NORMAL = 50,
  COMBAT_REFLEX = 80,
  SURVIVAL_EMERGENCY = 100,
}

export interface RunningActionInfo {
  actionId: string;
  name: string;
  priority: number;
  startedAt: number;
  abortController: AbortController;
}

export interface StartActionResult {
  actionId: string;
  signal: AbortSignal;
}

/**
 * ActionArbiter coordinates control of the bot between long-running actions
 * and real-time emergency reflexes (lava escape, drowning, auto-defense).
 * It ensures that only one system controls movement keys and equipment at a time,
 * enforces priority levels, and cleanly pre-empts lower priority macros when an emergency strikes.
 */
export class ActionArbiter {
  private currentAction: RunningActionInfo | null = null;
  private logger: any;

  constructor(logger: any) {
    this.logger = logger;
  }

  public get activeActionName(): string | null {
    return this.currentAction ? this.currentAction.name : null;
  }

  public get activeActionId(): string | null {
    return this.currentAction ? this.currentAction.actionId : null;
  }

  public get activePriority(): number {
    return this.currentAction ? this.currentAction.priority : 0;
  }

  public isBusy(): boolean {
    return this.currentAction !== null;
  }

  /**
   * Starts a new action, preempting any running action of equal or lower priority.
   * Throws an error if a higher-priority action is currently running.
   */
  public startAction(actionName: string, priority: number = ActionPriority.NORMAL, bot?: Bot): StartActionResult {
    if (this.currentAction) {
      if (this.currentAction.priority > priority) {
        throw new Error(
          `Cannot start '${actionName}' (priority ${priority}): higher priority action '${this.currentAction.name}' (priority ${this.currentAction.priority}) is currently active.`
        );
      }
      this.preemptRunningAction(`Preempted by new action: ${actionName}`, bot);
    }

    const abortController = new AbortController();
    const actionId = `${actionName}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    this.currentAction = {
      actionId,
      name: actionName,
      priority,
      startedAt: Date.now(),
      abortController,
    };

    return {
      actionId,
      signal: abortController.signal,
    };
  }

  /**
   * Finishes an action safely. Cleanup from an old action NEVER clears a newer action.
   */
  public finishAction(actionId: string, bot?: Bot): void {
    if (this.currentAction && this.currentAction.actionId === actionId) {
      this.currentAction = null;
      if (bot) {
        bot.clearControlStates();
        try {
          bot.deactivateItem();
        } catch {}
      }
    }
  }

  /**
   * Preempts the running action with an emergency priority.
   * Cleans physical controls, stops pathfinding, and aborts the signal.
   */
  public preempt(bot: Bot, reason: string, priority: number = ActionPriority.SURVIVAL_EMERGENCY): boolean {
    if (!this.currentAction) {
      // Still ensure physical controls are cleared
      this.releasePhysicalControls(bot);
      return false;
    }

    if (this.currentAction.priority > priority) {
      this.logger?.warn(
        `Preemption denied for '${this.currentAction.name}' (priority ${this.currentAction.priority}) by '${reason}' (priority ${priority})`
      );
      return false;
    }

    this.logger?.warn?.(`ACTION ARBITER PREEMPTION: ${this.currentAction.name} interrupted -> ${reason}`);
    this.currentAction.abortController.abort(new Error(reason));
    this.currentAction = null;

    // Release all physical controls cleanly
    this.releasePhysicalControls(bot);
    return true;
  }

  private preemptRunningAction(reason: string, bot?: Bot): void {
    if (this.currentAction) {
      this.logger?.debug?.(`Arbiter cancelling ${this.currentAction.name}: ${reason}`);
      this.currentAction.abortController.abort(new Error(reason));
      this.currentAction = null;
      if (bot) {
        this.releasePhysicalControls(bot);
      }
    }
  }

  private releasePhysicalControls(bot: Bot): void {
    try {
      (bot as any).pathfinder?.stop();
      (bot as any).pathfinder?.setGoal(null);
    } catch {}
    try {
      bot.clearControlStates();
    } catch {}
    try {
      bot.deactivateItem();
    } catch {}
  }
}
