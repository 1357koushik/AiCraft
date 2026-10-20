import { Vec3 } from 'vec3';
import { Observation } from '../types/index.js';
import { distance3D } from '../utils/math.js';

export class StuckDetector {
  private lastPosition: { x: number; y: number; z: number } | null = null;
  private consecutiveSamePosSteps = 0;
  private consecutiveFailedActions = 0;
  private failedActionCounts: Record<string, number> = {};

  public check(obs: Observation, lastActionResult?: { action: string; status: string }): { isStuck: boolean; reason?: string } {
    const currentPos = obs.position.blockCoords;

    if (this.lastPosition) {
      const dist = distance3D(this.lastPosition, currentPos);
      if (dist < 1.0) {
        this.consecutiveSamePosSteps++;
      } else {
        this.consecutiveSamePosSteps = 0;
      }
    }
    this.lastPosition = currentPos;

    if (lastActionResult) {
      if (lastActionResult.status === 'failed') {
        this.consecutiveFailedActions++;
        this.failedActionCounts[lastActionResult.action] = (this.failedActionCounts[lastActionResult.action] || 0) + 1;
      } else {
        this.consecutiveFailedActions = 0;
        this.failedActionCounts[lastActionResult.action] = 0;
      }
    }

    if (this.consecutiveFailedActions >= 3) {
      return {
        isStuck: true,
        reason: `Action failed 3 times consecutively (recent: ${lastActionResult?.action}).`,
      };
    }

    if (this.consecutiveSamePosSteps >= 4 && !obs.vitals.movementState.isSleeping) {
      return {
        isStuck: true,
        reason: `Bot position unchanged for ${this.consecutiveSamePosSteps} steps while trying to perform tasks.`,
      };
    }

    return { isStuck: false };
  }

  public reset(): void {
    this.consecutiveSamePosSteps = 0;
    this.consecutiveFailedActions = 0;
    this.failedActionCounts = {};
  }
}
