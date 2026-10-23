/**
 * Registry to track workstations placed by this bot during autonomous operation.
 * Guarantees that the bot ONLY dismantles workstations that it placed and owns,
 * preserving natural village, base, or player-placed workstations.
 */
export class WorkstationOwnershipRegistry {
  private owned = new Map<string, { type: string; placedAt: number }>();

  public recordPlacement(pos: { x: number; y: number; z: number }, type: string): void {
    const key = `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
    this.owned.set(key, { type, placedAt: Date.now() });
  }

  public isOwnedByBot(pos: { x: number; y: number; z: number }): boolean {
    const key = `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
    return this.owned.has(key);
  }

  public forgetPlacement(pos: { x: number; y: number; z: number }): void {
    const key = `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
    this.owned.delete(key);
  }

  public clear(): void {
    this.owned.clear();
  }
}

export const workstationRegistry = new WorkstationOwnershipRegistry();
