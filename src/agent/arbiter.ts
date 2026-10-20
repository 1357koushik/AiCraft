import { Bot } from 'mineflayer';

export interface RunningActionInfo {
  name: string;
  startedAt: number;
  abortController: AbortController;
}

/**
 * ActionArbiter coordinates control of the bot between long-running actions
 * and real-time emergency reflexes (lava escape, drowning, auto-defense).
 * It ensures that only one system controls movement keys and equipment at a time,
 * and cleanly pre-empts lower priority macros when an emergency strikes.
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

  public isBusy(): boolean {
    return this.currentAction !== null;
  }

  public startAction(actionName: string): AbortSignal {
    if (this.currentAction) {
      this.preemptRunningAction(`Preempted by new action: ${actionName}`);
    }

    const abortController = new AbortController();
    this.currentAction = {
      name: actionName,
      startedAt: Date.now(),
      abortController,
    };

    return abortController.signal;
  }

  public finishAction(actionName?: string): void {
    if (this.currentAction && (!actionName || this.currentAction.name === actionName)) {
      this.currentAction = null;
    }
  }

  public preempt(bot: Bot, reason: string): boolean {
    if (!this.currentAction) return false;

    this.logger.warn(`ACTION ARBITER PREEMPTION: ${this.currentAction.name} interrupted -> ${reason}`);
    this.currentAction.abortController.abort();
    this.currentAction = null;

    // Release all physical controls cleanly
    try {
      (bot as any).pathfinder?.stop();
    } catch {}
    bot.clearControlStates();
    try {
      bot.deactivateItem();
    } catch {}

    return true;
  }

  private preemptRunningAction(reason: string): void {
    if (this.currentAction) {
      this.logger.debug(`Arbiter cancelling ${this.currentAction.name}: ${reason}`);
      this.currentAction.abortController.abort();
      this.currentAction = null;
    }
  }
}
