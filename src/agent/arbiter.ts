import { Bot } from 'mineflayer';

export enum ActionPriority {
  LOW = 10,
  BACKGROUND = 20,
  NORMAL = 50,
  OWNER_URGENT = 60,
  COMBAT_REFLEX = 80,
  SURVIVAL_EMERGENCY = 100,
}

export type Actuator = 'movement' | 'look' | 'hands' | 'window';
export const ALL_ACTUATORS: Actuator[] = ['movement', 'look', 'hands', 'window'];
export const PHYSICAL_ACTUATORS: Actuator[] = ['movement', 'look', 'hands'];
export const MOVEMENT_ACTUATORS: Actuator[] = ['movement', 'look'];
export const WINDOW_ACTUATORS: Actuator[] = ['window'];

export interface RunningActionInfo {
  actionId: string;
  name: string;
  priority: number;
  startedAt: number;
  epoch: number;
  abortController: AbortController;
  actuators: Set<Actuator>;
}

export interface StartActionOptions {
  actuators?: Actuator[];
  preemptEqual?: boolean;
}

export interface StartActionResult {
  actionId: string;
  signal: AbortSignal;
  epoch: number;
}

/**
 * ActionArbiter coordinates exclusive actuator ownership between long-running skills,
 * pathfinder, and real-time emergency reflexes (drowning, lava escape, combat defense).
 *
 * Enforces single actuator ownership: at any moment there is at most one owner of
 * movement controls and one owner of a window/GUI. Competing skills and daemons cannot
 * fight over actuators without proper arbitration.
 */
export class ActionArbiter {
  private currentAction: RunningActionInfo | null = null;
  private runningActions: Map<string, RunningActionInfo> = new Map();
  private actuatorOwners: Map<Actuator, RunningActionInfo> = new Map();
  private currentEpoch: number = 0;
  private logger: any;

  constructor(logger: any) {
    this.logger = logger;
  }

  public get epoch(): number {
    return this.currentEpoch;
  }

  public get activeActionName(): string | null {
    const highest = this.getHighestPriorityAction();
    return highest ? highest.name : null;
  }

  public get activeActionId(): string | null {
    const highest = this.getHighestPriorityAction();
    return highest ? highest.actionId : null;
  }

  public get activePriority(): number {
    const highest = this.getHighestPriorityAction();
    return highest ? highest.priority : 0;
  }

  public isBusy(actuator?: Actuator): boolean {
    if (actuator) {
      return this.actuatorOwners.has(actuator);
    }
    return this.runningActions.size > 0;
  }

  public isActionActive(actionId: string): boolean {
    return this.runningActions.has(actionId);
  }

  /**
   * Monotonically guarded ownership check: verifies action ID, epoch, and un-aborted signal.
   */
  public isCurrent(actionId: string, epoch: number): boolean {
    const action = this.runningActions.get(actionId);
    return Boolean(action && action.epoch === epoch && !action.abortController.signal.aborted);
  }

  /**
   * Checks whether the specified action currently holds exclusive ownership of an actuator.
   */
  public hasActuatorAccess(actuator: Actuator, actionId: string, epoch: number): boolean {
    const owner = this.actuatorOwners.get(actuator);
    return Boolean(
      owner &&
      owner.actionId === actionId &&
      owner.epoch === epoch &&
      !owner.abortController.signal.aborted
    );
  }

  public getActuatorOwner(actuator: Actuator): RunningActionInfo | null {
    return this.actuatorOwners.get(actuator) || null;
  }

  /**
   * Starts a new action, checking actuator ownership.
   * - If an actuator is held by a higher-priority action, throws an error (rejects request).
   * - If an actuator is held by an equal-priority action and preemptEqual is false, throws an error (conflicting request).
   * - If an actuator is held by a lower-priority action (or equal with preemptEqual=true), preempts it safely.
   */
  public startAction(
    actionName: string,
    priority: number = ActionPriority.NORMAL,
    bot?: Bot,
    options?: Actuator[] | StartActionOptions
  ): StartActionResult {
    const requestedActuators: Actuator[] = Array.isArray(options)
      ? options
      : options?.actuators ?? ALL_ACTUATORS;
    const preemptEqual: boolean = Array.isArray(options)
      ? true
      : options?.preemptEqual ?? true;

    // Check for actuator ownership conflicts
    const actionsToPreempt = new Set<RunningActionInfo>();

    for (const actuator of requestedActuators) {
      const currentOwner = this.actuatorOwners.get(actuator);
      if (currentOwner) {
        if (currentOwner.priority > priority) {
          throw new Error(
            `Cannot start '${actionName}' (priority ${priority}): actuator '${actuator}' is currently held by higher priority action '${currentOwner.name}' (priority ${currentOwner.priority}).`
          );
        } else if (currentOwner.priority === priority) {
          if (!preemptEqual) {
            throw new Error(
              `Cannot start '${actionName}' (priority ${priority}): actuator '${actuator}' is currently held by conflicting action '${currentOwner.name}' at equal priority.`
            );
          } else {
            actionsToPreempt.add(currentOwner);
          }
        } else {
          // currentOwner.priority < priority: higher priority preempts lower
          actionsToPreempt.add(currentOwner);
        }
      }
    }

    // Preempt conflicting actions safely
    for (const action of actionsToPreempt) {
      this.preemptActionInstance(action, `Preempted by action '${actionName}' (priority ${priority})`, bot);
    }

    this.currentEpoch++;
    const epoch = this.currentEpoch;
    const abortController = new AbortController();
    const actionId = `${actionName}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    const newAction: RunningActionInfo = {
      actionId,
      name: actionName,
      priority,
      startedAt: Date.now(),
      epoch,
      abortController,
      actuators: new Set(requestedActuators),
    };

    this.runningActions.set(actionId, newAction);
    for (const actuator of requestedActuators) {
      this.actuatorOwners.set(actuator, newAction);
    }
    this.currentAction = this.getHighestPriorityAction();

    return {
      actionId,
      signal: abortController.signal,
      epoch,
    };
  }

  /**
   * Finishes an action safely. Cleanup from an old action NEVER clears a newer action, epoch, or unrelated actuators.
   */
  public finishAction(actionId: string, epochOrBot?: number | Bot, bot?: Bot): void {
    let epoch: number | undefined;
    let actualBot: Bot | undefined = bot;
    if (typeof epochOrBot === 'number') {
      epoch = epochOrBot;
    } else if (epochOrBot && typeof epochOrBot === 'object') {
      actualBot = epochOrBot as Bot;
    }

    const action = this.runningActions.get(actionId);
    if (!action) {
      return;
    }

    if (epoch !== undefined && action.epoch !== epoch) {
      // Late promise settlement from an earlier epoch; do not clear active controls or newer action
      return;
    }

    this.runningActions.delete(actionId);
    const releasedActuators = new Set<Actuator>();
    for (const act of action.actuators) {
      if (this.actuatorOwners.get(act) === action) {
        this.actuatorOwners.delete(act);
        releasedActuators.add(act);
      }
    }

    this.currentAction = this.getHighestPriorityAction();
    if (actualBot) {
      this.releasePhysicalControls(actualBot, false, releasedActuators);
    }
  }

  /**
   * Preempts running actions whose priority is <= the given priority.
   * Actions with higher priority (e.g. SURVIVAL_EMERGENCY vs OWNER_URGENT) are preserved.
   */
  public preempt(bot: Bot, reason: string, priority: number = ActionPriority.SURVIVAL_EMERGENCY): boolean {
    this.currentEpoch++;

    const actionsToPreempt: RunningActionInfo[] = [];
    for (const action of this.runningActions.values()) {
      if (action.priority <= priority) {
        actionsToPreempt.push(action);
      }
    }

    if (actionsToPreempt.length === 0) {
      if (this.runningActions.size > 0) {
        this.logger?.warn?.(
          `Preemption denied: active actions have higher priority than '${reason}' (priority ${priority})`
        );
      }
      this.releasePhysicalControls(bot, true);
      return false;
    }

    for (const action of actionsToPreempt) {
      this.logger?.warn?.(`ACTION ARBITER PREEMPTION: ${action.name} interrupted -> ${reason}`);
      action.abortController.abort(new Error(reason));
      this.runningActions.delete(action.actionId);
      for (const act of action.actuators) {
        if (this.actuatorOwners.get(act) === action) {
          this.actuatorOwners.delete(act);
        }
      }
    }

    this.currentAction = this.getHighestPriorityAction();
    this.releasePhysicalControls(bot, true);
    return true;
  }

  /**
   * Cancels any and all active actions unconditionally (e.g. on death, disconnect, or controller rebinding).
   */
  public cancelAll(bot?: Bot): void {
    this.currentEpoch++;
    for (const action of this.runningActions.values()) {
      this.logger?.warn?.(`Arbiter cancelAll: aborting active action ${action.name}`);
      action.abortController.abort(new Error('All actions cancelled by bot lifecycle reset.'));
    }
    this.runningActions.clear();
    this.actuatorOwners.clear();
    this.currentAction = null;

    if (bot) {
      this.releasePhysicalControls(bot, true);
    }
  }

  private preemptActionInstance(action: RunningActionInfo, reason: string, bot?: Bot): void {
    this.logger?.debug?.(`Arbiter cancelling ${action.name}: ${reason}`);
    action.abortController.abort(new Error(reason));
    this.runningActions.delete(action.actionId);
    for (const act of action.actuators) {
      if (this.actuatorOwners.get(act) === action) {
        this.actuatorOwners.delete(act);
      }
    }
    if (bot) {
      this.releasePhysicalControls(bot, true, action.actuators);
    }
  }

  private getHighestPriorityAction(): RunningActionInfo | null {
    let highest: RunningActionInfo | null = null;
    for (const action of this.runningActions.values()) {
      if (!highest || action.priority > highest.priority) {
        highest = action;
      }
    }
    return highest;
  }

  private releasePhysicalControls(bot?: Bot, immediate: boolean = true, actuators?: Set<Actuator>): void {
    if (!bot) return;

    const shouldReleaseMovement = !actuators || actuators.has('movement');
    const shouldReleaseHands = !actuators || actuators.has('hands');
    const shouldReleaseWindow = !actuators || actuators.has('window');

    if (shouldReleaseMovement) {
      try {
        if (immediate) {
          (bot as any).pathfinder?.setGoal(null);
          (bot as any).pathfinder?.stop();
        } else {
          (bot as any).pathfinder?.stop();
        }
      } catch {}
      try {
        bot.clearControlStates();
      } catch {}
    }

    if (shouldReleaseHands) {
      try {
        (bot as any).stopDigging?.();
      } catch {}
      try {
        bot.deactivateItem();
      } catch {}
    }

    if (shouldReleaseWindow) {
      try {
        if (bot.currentWindow) {
          bot.closeWindow(bot.currentWindow);
        }
      } catch {}
    }
  }
}

/**
 * Checks whether an action execution context is still the active, non-aborted owner of physical controls.
 * If aborted, superseded, or from an obsolete epoch, returns false, signaling that stale cleanups or subsequent mutations must not occur.
 */
export function isActionContextActive(ctx?: {
  abortSignal?: AbortSignal;
  actionId?: string;
  epoch?: number;
  isCurrent?: () => boolean;
}): boolean {
  if (!ctx) return true;
  if (ctx.abortSignal?.aborted) return false;
  if (ctx.isCurrent && !ctx.isCurrent()) return false;
  return true;
}
