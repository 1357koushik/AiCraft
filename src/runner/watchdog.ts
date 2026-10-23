import { Bot } from 'mineflayer';

export interface WatchdogOptions {
  noProgressTimeoutMs: number;
  checkIntervalMs?: number;
  onTrip?: (reason: string) => void;
}

export class NoProgressWatchdog {
  private bot: Bot;
  private noProgressTimeoutMs: number;
  private checkIntervalMs: number;
  private abortController: AbortController;
  private onTrip?: (reason: string) => void;

  private timer: NodeJS.Timeout | null = null;
  private lastProgressTime: number = Date.now();
  private lastPosition: { x: number; y: number; z: number } | null = null;
  private lastInventoryCount: number = 0;
  private lastHealth: number = 20;
  private lastWindowProgress: number = -1;
  private isRunning: boolean = false;
  private wasTripped: boolean = false;
  private tripReason: string = '';

  constructor(bot: Bot, abortController: AbortController, options: WatchdogOptions) {
    this.bot = bot;
    this.abortController = abortController;
    this.noProgressTimeoutMs = options.noProgressTimeoutMs || 5000;
    this.checkIntervalMs = options.checkIntervalMs || 250;
    this.onTrip = options.onTrip;
  }

  public get tripped(): boolean {
    return this.wasTripped;
  }

  public get reason(): string {
    return this.tripReason;
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.lastProgressTime = Date.now();
    this.wasTripped = false;
    this.tripReason = '';

    this.recordBaseline();

    this.timer = setInterval(() => {
      this.checkProgress();
    }, this.checkIntervalMs);
  }

  private recordBaseline(): void {
    if (this.bot.entity?.position) {
      const p = this.bot.entity.position;
      this.lastPosition = { x: p.x, y: p.y, z: p.z };
    }
    this.lastHealth = this.bot.health ?? 20;
    this.lastInventoryCount = this.computeTotalInventory();
    this.lastWindowProgress = -1;
  }

  private computeTotalInventory(): number {
    if (!this.bot.inventory) return 0;
    return this.bot.inventory.items().reduce((acc, it) => acc + (it.count || 1), 0);
  }

  private checkProgress(): void {
    if (!this.isRunning) return;

    let hasProgressed = false;

    // 1. Position check
    if (this.bot.entity?.position && this.lastPosition) {
      const p = this.bot.entity.position;
      const dx = p.x - this.lastPosition.x;
      const dy = p.y - this.lastPosition.y;
      const dz = p.z - this.lastPosition.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist >= 0.05) {
        hasProgressed = true;
        this.lastPosition = { x: p.x, y: p.y, z: p.z };
      }
    } else if (this.bot.entity?.position) {
      const p = this.bot.entity.position;
      this.lastPosition = { x: p.x, y: p.y, z: p.z };
    }

    // 2. Inventory check
    const currentInv = this.computeTotalInventory();
    if (currentInv !== this.lastInventoryCount) {
      hasProgressed = true;
      this.lastInventoryCount = currentInv;
    }

    // 3. Health check
    const currentHealth = this.bot.health ?? 20;
    if (currentHealth !== this.lastHealth) {
      hasProgressed = true;
      this.lastHealth = currentHealth;
    }

    // 4. Window / container GUI progress check (furnace cooking, craft window, etc.)
    const win = (this.bot as any).currentWindow;
    if (win) {
      const winProgress = (win as any).progress ?? (win as any).fuel ?? 0;
      if (winProgress !== this.lastWindowProgress) {
        hasProgressed = true;
        this.lastWindowProgress = winProgress;
      }
    }

    const now = Date.now();
    if (hasProgressed) {
      this.lastProgressTime = now;
    } else {
      const idleMs = now - this.lastProgressTime;
      if (idleMs >= this.noProgressTimeoutMs) {
        this.wasTripped = true;
        this.tripReason = `No-progress watchdog tripped: 0 physical movement or state progress for ${idleMs}ms (timeout: ${this.noProgressTimeoutMs}ms).`;
        this.stop();

        this.onTrip?.(this.tripReason);
        this.abortController.abort(new Error(this.tripReason));
      }
    }
  }

  public stop(): void {
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
