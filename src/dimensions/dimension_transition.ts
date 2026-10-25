import { Bot } from 'mineflayer';
import { Movements } from 'mineflayer-pathfinder';
import { MemoryManager } from '../memory/index.js';
import { globalExplorationGrid } from '../actions/exploration/frontier.js';

export type DimensionType = 'overworld' | 'the_nether' | 'the_end';

export class DimensionManager {
  private currentDimension: DimensionType = 'overworld';

  constructor(initialDimension: DimensionType = 'overworld') {
    this.currentDimension = initialDimension;
  }

  public getCurrentDimension(): DimensionType {
    return this.currentDimension;
  }

  public setDimension(dim: DimensionType): void {
    this.currentDimension = dim;
  }

  /**
   * Identifies the current dimension from Mineflayer bot environment state.
   */
  public detectDimension(bot: Bot): DimensionType {
    const dim = (bot?.game as any)?.dimension;
    if (typeof dim === 'string') {
      if (dim.includes('nether')) return 'the_nether';
      if (dim.includes('end')) return 'the_end';
      return 'overworld';
    }
    return this.currentDimension;
  }

  /**
   * Handles safe dimension transition lifecycle:
   * 1. Stops Pathfinder and flushes pathfinder goal states.
   * 2. Re-initializes Movements instance with the new dimension's physics.
   * 3. Resets exploration frontier chunk tracking.
   * 4. Records portal coordinate in persistent memory.
   */
  public async handleDimensionTransition(
    bot: Bot,
    targetDimension: DimensionType,
    memory?: MemoryManager
  ): Promise<void> {
    this.currentDimension = targetDimension;

    // 1. Halt and clear pathfinder
    if ((bot as any).pathfinder) {
      try {
        (bot as any).pathfinder.stop();
        (bot as any).pathfinder.setGoal(null);
      } catch {}

      // 2. Re-bind safe movements for the new dimension
      if (bot.registry) {
        try {
          const move = new Movements(bot);
          // In Nether, water clutching is physically impossible; configure hazard blocks
          if (targetDimension === 'the_nether') {
            move.canDig = true;
            move.maxDropDown = 3;
            move.allowParkour = false;
          }
          (bot as any).pathfinder.setMovements(move);
        } catch {}
      }
    }

    // 3. Clear exploration grid chunk cache to prevent dimension coordinate collision
    globalExplorationGrid.chunkStatus.clear();
    globalExplorationGrid.detectedBiomes.clear();

    // 4. Record portal coordinate in persistent memory
    if (memory && bot.entity?.position) {
      memory.recordPortal(targetDimension, {
        x: Math.round(bot.entity.position.x),
        y: Math.round(bot.entity.position.y),
        z: Math.round(bot.entity.position.z),
      });
    }

    // 5. Brief stabilization period for world chunk reception
    await new Promise((res) => setTimeout(res, 300));
  }
}

export const defaultDimensionManager = new DimensionManager();
