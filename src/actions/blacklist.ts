export type NavigationFailureKind =
  | 'UNREACHABLE'
  | 'OBSTRUCTED'
  | 'STALLED'
  | 'TIMED_OUT'
  | 'STALE_TARGET'
  | 'HAZARD_OBSTRUCTION'
  | 'CANCELLED'
  | 'UNKNOWN';

export interface BlacklistEntry {
  key: string;
  position: { x: number; y: number; z: number };
  reason: string;
  failureKind: NavigationFailureKind;
  failedAt: number;
  expiresAt: number;
}

/**
 * Small, bounded failed-target blacklist registry with TTL expiry.
 * Prevents repeating the same impossible navigation target indefinitely.
 */
export class NavigationBlacklist {
  private entries = new Map<string, BlacklistEntry>();
  private readonly maxEntries: number;
  private readonly defaultTtlMs: number;

  constructor(maxEntries = 128, defaultTtlMs = 60_000) {
    this.maxEntries = maxEntries;
    this.defaultTtlMs = defaultTtlMs;
  }

  private makeKey(pos: { x: number; y?: number; z: number }, horizontalOnly = false): string {
    const fx = Math.floor(pos.x);
    const fz = Math.floor(pos.z);
    if (horizontalOnly || pos.y === undefined) {
      return `${fx},${fz}`;
    }
    return `${fx},${Math.floor(pos.y)},${fz}`;
  }

  recordFailure(
    pos: { x: number; y?: number; z: number },
    reason: string,
    failureKind: NavigationFailureKind = 'UNREACHABLE',
    ttlMs?: number,
    horizontalOnly = false
  ): void {
    this.evictExpired();
    if (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey) this.entries.delete(oldestKey);
    }
    const key = this.makeKey(pos, horizontalOnly);
    const now = Date.now();
    const duration = ttlMs ?? this.defaultTtlMs;
    this.entries.set(key, {
      key,
      position: { x: pos.x, y: pos.y ?? 0, z: pos.z },
      reason,
      failureKind,
      failedAt: now,
      expiresAt: now + duration,
    });
  }

  isBlacklisted(pos: { x: number; y?: number; z: number }, radius = 1.0, horizontalOnly = false): boolean {
    this.evictExpired();
    const key = this.makeKey(pos, horizontalOnly);
    if (this.entries.has(key)) return true;

    if (radius > 0) {
      for (const entry of this.entries.values()) {
        const dx = entry.position.x - pos.x;
        const dz = entry.position.z - pos.z;
        const dy = horizontalOnly || pos.y === undefined ? 0 : entry.position.y - pos.y;
        if (Math.hypot(dx, dy, dz) <= radius) {
          return true;
        }
      }
    }
    return false;
  }

  getEntry(pos: { x: number; y?: number; z: number }, horizontalOnly = false): BlacklistEntry | undefined {
    this.evictExpired();
    return this.entries.get(this.makeKey(pos, horizontalOnly));
  }

  clear(): void {
    this.entries.clear();
  }

  evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries.entries()) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
  }

  size(): number {
    this.evictExpired();
    return this.entries.size;
  }
}

export const navigationBlacklist = new NavigationBlacklist(128, 60_000);
