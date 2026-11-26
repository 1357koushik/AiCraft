import { EventEmitter } from 'events';

/**
 * Who is driving the body right now: a skill, or a reflex that took over to keep the bot alive.
 *
 * A reflex takes over, stops the pathfinder and digging, does its job, and releases. Skills do not fail
 * because of that: helpers such as world.goTo see `reflexActive`, wait for the release, and carry on.
 * This is the "pause and resume" from ROADMAP.md Phase 1. One bot per process, so one instance.
 */
class BodyControl extends EventEmitter {
  private holder: string | null = null;
  private releasedAt = 0;

  get reflexActive(): boolean {
    return this.holder !== null;
  }

  get reason(): string | null {
    return this.holder;
  }

  /** True if a reflex let go within the last `ms`; a goto that failed just now was probably stopped by it. */
  releasedWithin(ms: number): boolean {
    return Date.now() - this.releasedAt <= ms;
  }

  takeover(reason: string): void {
    this.holder = reason;
    this.emit('takeover', reason);
  }

  release(): void {
    if (this.holder === null) return;
    this.holder = null;
    this.releasedAt = Date.now();
    this.emit('release');
  }

  /** Resolves when no reflex holds the body (immediately if none does), or when `signal` aborts. */
  waitForRelease(signal?: AbortSignal): Promise<void> {
    if (this.holder === null) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        this.off('release', done);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      this.on('release', done);
      signal?.addEventListener('abort', done, { once: true });
    });
  }
}

export const body = new BodyControl();
