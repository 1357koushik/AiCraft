import mineflayer, { Bot } from 'mineflayer';
import { RotatingJsonlWriter, ObserverEvent } from './writer.js';
import { VanillaBridgeServer } from './bridge.js';

export interface VanillaObserverConfig {
  serverHost?: string;
  serverPort?: number;
  observerUsername?: string;
  runId?: string;
  logDir?: string;
  bridgePort?: number;
  bridgeTokenFile?: string;
  snapshotIntervalMs?: number;
  logger?: any;
}

export class VanillaGroundTruthObserver {
  private config: VanillaObserverConfig;
  private writer: RotatingJsonlWriter;
  private bridge: VanillaBridgeServer;
  private bot: Bot | null = null;
  private snapshotInterval: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;

  constructor(config: VanillaObserverConfig = {}) {
    this.config = {
      serverHost: config.serverHost || '127.0.0.1',
      serverPort: config.serverPort || 25565,
      observerUsername: config.observerUsername || 'observer_bot',
      runId: config.runId || `vanilla_${Date.now()}`,
      logDir: config.logDir || 'logs/integration',
      bridgePort: config.bridgePort || 25580,
      bridgeTokenFile: config.bridgeTokenFile || 'logs/integration/.bridge_token',
      snapshotIntervalMs: config.snapshotIntervalMs || 1000,
      logger: config.logger || console,
    };

    this.writer = new RotatingJsonlWriter({
      logDir: this.config.logDir!,
      runId: this.config.runId!,
      maxSizeBytes: 50 * 1024 * 1024,
      maxFiles: 5,
    });

    this.bridge = new VanillaBridgeServer({
      host: '127.0.0.1',
      port: this.config.bridgePort,
      tokenFile: this.config.bridgeTokenFile,
      runId: this.config.runId!,
      writer: this.writer,
      getSnapshotHandler: () => this.getLiveSnapshot(),
      logger: this.config.logger,
    });
  }

  public get logWriter(): RotatingJsonlWriter {
    return this.writer;
  }

  public get bridgeServer(): VanillaBridgeServer {
    return this.bridge;
  }

  public get observerBot(): Bot | null {
    return this.bot;
  }

  public async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    // 1. Start Log Writer
    await this.writer.start();

    // 2. Start Bridge Server
    await this.bridge.start();

    // 3. Record Startup Event
    const seq = this.writer.nextSeq();
    this.writer.write({
      seq,
      timestamp: new Date().toISOString(),
      serverRunId: this.config.runId!,
      dimension: 'server',
      playerName: 'observer',
      eventType: 'OBSERVER_STARTUP',
      details: {
        targetServer: `${this.config.serverHost}:${this.config.serverPort}`,
        bridgePort: this.config.bridgePort,
        implementation: 'Vanilla-Compatible Ground-Truth Observer',
      },
    });

    // 4. Connect read-only observer bot to Vanilla server
    await this.connectObserverBot();
  }

  private connectObserverBot(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.config.logger?.info?.(
        `[VanillaObserver] Connecting read-only spectator bot to ${this.config.serverHost}:${this.config.serverPort} as '${this.config.observerUsername}'...`
      );

      this.bot = mineflayer.createBot({
        host: this.config.serverHost,
        port: this.config.serverPort,
        username: this.config.observerUsername,
        version: '1.21.6',
        auth: 'offline',
      });

      this.bot.once('spawn', () => {
        this.config.logger?.info?.(
          `[VanillaObserver] Connected and spawned at ${this.bot?.entity?.position?.floored()}`
        );

        this.setupEventListeners();
        this.startSnapshotTimer();

        // Emit PLAYER_JOIN event
        const seq = this.writer.nextSeq();
        this.writer.write({
          seq,
          timestamp: new Date().toISOString(),
          serverRunId: this.config.runId!,
          dimension: this.bot?.game?.dimension || 'minecraft:overworld',
          playerName: this.bot?.username,
          eventType: 'PLAYER_JOIN',
          coordinates: this.bot?.entity?.position
            ? {
                x: Math.round(this.bot.entity.position.x * 100) / 100,
                y: Math.round(this.bot.entity.position.y * 100) / 100,
                z: Math.round(this.bot.entity.position.z * 100) / 100,
              }
            : null,
          details: {
            gameMode: this.bot?.game?.gameMode,
            difficulty: this.bot?.game?.difficulty,
          },
        });

        resolve();
      });

      this.bot.on('error', (err) => {
        this.config.logger?.warn?.(`[VanillaObserver] Bot connection error: ${err.message}`);
        reject(err);
      });

      this.bot.on('kicked', (reason) => {
        this.config.logger?.warn?.(`[VanillaObserver] Bot kicked: ${JSON.stringify(reason)}`);
        reject(new Error(`Bot kicked: ${JSON.stringify(reason)}`));
      });
    });
  }

  private setupEventListeners(): void {
    if (!this.bot) return;

    this.bot.on('playerJoined', (player) => {
      const seq = this.writer.nextSeq();
      this.writer.write({
        seq,
        timestamp: new Date().toISOString(),
        serverRunId: this.config.runId!,
        dimension: this.bot?.game?.dimension || 'minecraft:overworld',
        playerName: player.username,
        eventType: 'PLAYER_JOIN',
        details: { entityId: player.entity?.id },
      });
    });

    this.bot.on('playerLeft', (player) => {
      const seq = this.writer.nextSeq();
      this.writer.write({
        seq,
        timestamp: new Date().toISOString(),
        serverRunId: this.config.runId!,
        dimension: this.bot?.game?.dimension || 'minecraft:overworld',
        playerName: player.username,
        eventType: 'PLAYER_QUIT',
      });
    });

    this.bot.on('chat', (username, message) => {
      const seq = this.writer.nextSeq();
      this.writer.write({
        seq,
        timestamp: new Date().toISOString(),
        serverRunId: this.config.runId!,
        dimension: this.bot?.game?.dimension || 'minecraft:overworld',
        playerName: username,
        eventType: 'CHAT_MESSAGE',
        details: { message },
      });
    });

    this.bot.on('blockUpdate', (oldBlock: any, newBlock: any) => {
      const seq = this.writer.nextSeq();
      const isBreak = oldBlock && oldBlock.name !== 'air' && newBlock && newBlock.name === 'air';
      const isPlace = oldBlock && oldBlock.name === 'air' && newBlock && newBlock.name !== 'air';
      this.writer.write({
        seq,
        timestamp: new Date().toISOString(),
        serverRunId: this.config.runId!,
        dimension: this.bot?.game?.dimension || 'minecraft:overworld',
        eventType: isBreak ? 'BLOCK_BREAK' : isPlace ? 'BLOCK_PLACE' : 'BLOCK_CHANGE',
        coordinates: newBlock?.position
          ? { x: newBlock.position.x, y: newBlock.position.y, z: newBlock.position.z }
          : null,
        blockId: isBreak ? oldBlock?.name : newBlock?.name,
        activeContext: this.bridge.activeContext,
        details: {
          oldBlock: oldBlock?.name,
          newBlock: newBlock?.name,
        },
      });
    });

    this.bot.on('entitySpawn', (entity: any) => {
      if (entity.name === 'item') {
        const seq = this.writer.nextSeq();
        this.writer.write({
          seq,
          timestamp: new Date().toISOString(),
          serverRunId: this.config.runId!,
          dimension: this.bot?.game?.dimension || 'minecraft:overworld',
          eventType: 'ITEM_SPAWN',
          coordinates: entity.position
            ? {
                x: Math.round(entity.position.x * 100) / 100,
                y: Math.round(entity.position.y * 100) / 100,
                z: Math.round(entity.position.z * 100) / 100,
              }
            : null,
          activeContext: this.bridge.activeContext,
          details: { entityId: entity.id },
        });
      }
    });

    this.bot.on('entityGone', (entity: any) => {
      if (entity.name === 'item') {
        const seq = this.writer.nextSeq();
        this.writer.write({
          seq,
          timestamp: new Date().toISOString(),
          serverRunId: this.config.runId!,
          dimension: this.bot?.game?.dimension || 'minecraft:overworld',
          eventType: 'ITEM_PICKUP',
          coordinates: entity.position
            ? {
                x: Math.round(entity.position.x * 100) / 100,
                y: Math.round(entity.position.y * 100) / 100,
                z: Math.round(entity.position.z * 100) / 100,
              }
            : null,
          activeContext: this.bridge.activeContext,
          details: { entityId: entity.id },
        });
      }
    });

    this.bot.on('time', () => {
      // Periodic time synchronization
    });
  }

  private startSnapshotTimer(): void {
    this.snapshotInterval = setInterval(() => {
      if (!this.bot || !this.bot.entity) return;

      const pos = this.bot.entity.position;
      const seq = this.writer.nextSeq();
      this.writer.write({
        seq,
        timestamp: new Date().toISOString(),
        serverRunId: this.config.runId!,
        dimension: this.bot.game?.dimension || 'minecraft:overworld',
        playerName: this.bot.username,
        eventType: 'PERIODIC_SNAPSHOT',
        coordinates: {
          x: Math.round(pos.x * 100) / 100,
          y: Math.round(pos.y * 100) / 100,
          z: Math.round(pos.z * 100) / 100,
        },
        activeContext: this.bridge.activeContext,
        details: {
          health: this.bot.health,
          food: this.bot.food,
          oxygen: (this.bot as any).oxygenLevel ?? 20,
          isAlive: this.bot.health > 0,
          onlinePlayers: Object.keys(this.bot.players || {}),
        },
      });
    }, this.config.snapshotIntervalMs);
  }

  public getLiveSnapshot(): any {
    if (!this.bot) return null;
    const tracked = this.bot.players?.['dragonai'];
    return {
      username: this.bot.username,
      dimension: this.bot.game?.dimension,
      gameMode: this.bot.game?.gameMode,
      health: this.bot.health,
      food: this.bot.food,
      position: this.bot.entity?.position,
      players: Object.keys(this.bot.players || {}),
      trackedPlayer: tracked
        ? {
            username: 'dragonai',
            position: tracked.entity?.position,
            entityId: tracked.entity?.id,
          }
        : null,
    };
  }

  public async stop(): Promise<void> {
    this.isRunning = false;

    if (this.snapshotInterval) {
      clearInterval(this.snapshotInterval);
      this.snapshotInterval = null;
    }

    if (this.bot) {
      try {
        this.bot.quit();
      } catch {}
      this.bot = null;
    }

    await this.bridge.stop();

    const seq = this.writer.nextSeq();
    this.writer.write({
      seq,
      timestamp: new Date().toISOString(),
      serverRunId: this.config.runId!,
      dimension: 'server',
      playerName: 'observer',
      eventType: 'OBSERVER_SHUTDOWN',
      details: { finalSeq: seq },
    });

    await this.writer.close();
  }
}
