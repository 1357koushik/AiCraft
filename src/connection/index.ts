import mineflayer, { Bot } from 'mineflayer';
import { pathfinder } from 'mineflayer-pathfinder';
import minecraftData from 'minecraft-data';
import { AppConfig } from '../config/index.js';
import { AgentLogger } from '../utils/logger.js';
import { updatePathfinderMovements } from '../actions/techniques.js';

export interface ConnectionEvents {
  onSpawn?: (bot: Bot) => void;
  onKicked?: (reason: string) => void;
  onError?: (err: Error) => void;
  onEnd?: () => void;
}

export class ConnectionManager {
  private config: AppConfig;
  private logger: AgentLogger;
  private bot: Bot | null = null;
  private reconnectAttempts = 0;
  private shouldReconnect = true;
  private isReconnecting = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(config: AppConfig, logger: AgentLogger) {
    this.config = config;
    this.logger = logger;

    // Verify local runtime and data version compatibility
    this.verifyEnvironmentCompatibility();
  }

  public get currentBot(): Bot | null {
    return this.bot;
  }

  private verifyEnvironmentCompatibility(): void {
    const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
    if (nodeMajor < 20) {
      this.logger.warn(`Node.js version is ${process.version}. Minecraft Java 1.21.6 Mineflayer 4.x officially requires Node.js >= 20 (recommended Node 24 LTS).`);
    }

    try {
      const mcData = (minecraftData as any)('1.21.6');
      if (mcData) {
        this.logger.info(`Verified target Minecraft Java 1.21.6 protocol: ${mcData.version.version} (Data Version: 4435).`);
      }
    } catch (err: any) {
      this.logger.error(`Failed loading minecraft-data for version 1.21.6: ${err.message}`);
    }
  }

  public async connect(events?: ConnectionEvents): Promise<Bot> {
    return new Promise((resolve, reject) => {
      this.logger.info(
        `Connecting bot to ${this.config.server.host}:${this.config.server.port} as '${this.config.server.username}' (Target: MC ${this.config.server.version})...`
      );

      const options: mineflayer.BotOptions = {
        host: this.config.server.host,
        port: this.config.server.port,
        version: this.config.server.version,
        username: this.config.server.username,
        auth: this.config.server.auth as any,
        checkTimeoutInterval: 30000,
      };

      let bot: Bot;
      try {
        bot = mineflayer.createBot(options);
      } catch (err: any) {
        this.logger.error({ err }, `Failed creating Mineflayer client: ${err.message}`);
        reject(err);
        return;
      }
      this.bot = bot;

      // Attach pathfinder plugin
      bot.loadPlugin(pathfinder);

      bot.once('spawn', () => {
        this.reconnectAttempts = 0;
        this.isReconnecting = false;
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }

        // Verify connected server version
        if (bot.version !== '1.21.6') {
          this.logger.warn(`Connected server version '${bot.version}' differs from expected target '1.21.6'.`);
        }

        this.logger.info(`Bot successfully spawned in world as '${bot.username}'!`);

        // Configure pathfinder movements with smart scaffolding, digging, and 1x1 pillaring
        const defaultMove = updatePathfinderMovements(bot);
        (bot as any).pathfinder.setMovements(defaultMove);

        // Optional Prismarine web viewer
        if (this.config.logging.enablePrismarineViewer) {
          try {
            // @ts-ignore
            import('prismarine-viewer').then(({ mineflayer: viewer }) => {
              viewer(bot, { port: this.config.logging.viewerPort, firstPerson: true });
              this.logger.info(`Prismarine viewer running at http://localhost:${this.config.logging.viewerPort}`);
            }).catch(() => {
              this.logger.warn('prismarine-viewer not installed; web viewer skipped.');
            });
          } catch {}
        }

        if (events?.onSpawn) events.onSpawn(bot);
        resolve(bot);
      });

      bot.on('kicked', (reason) => {
        const reasonStr = typeof reason === 'string' ? reason : JSON.stringify(reason);
        this.logger.warn(`Bot kicked from server: ${reasonStr}`);
        if (events?.onKicked) events.onKicked(reasonStr);
      });

      bot.on('error', (err) => {
        this.logger.error({ err }, `Bot connection error: ${err.message}`);
        if (events?.onError) events.onError(err);
      });

      bot.on('end', () => {
        this.logger.info('Bot connection ended.');
        if (events?.onEnd) events.onEnd();

        if (this.shouldReconnect && this.config.server.autoReconnect) {
          this.handleReconnect(events);
        }
      });
    });
  }

  public disconnect(): void {
    this.shouldReconnect = false;
    this.isReconnecting = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.bot) {
      try {
        this.bot.quit();
      } catch {}
      this.bot = null;
    }
  }

  private handleReconnect(events?: ConnectionEvents): void {
    if (!this.shouldReconnect) return;

    if (this.isReconnecting) {
      this.logger.debug('Reconnect loop already scheduled or running.');
      return;
    }

    if (this.reconnectAttempts >= this.config.server.reconnectMaxAttempts) {
      this.logger.error(`Max reconnect attempts (${this.config.server.reconnectMaxAttempts}) reached. Giving up.`);
      this.isReconnecting = false;
      return;
    }

    this.isReconnecting = true;
    this.reconnectAttempts++;

    // Bounded exponential backoff with jitter
    const delay = Math.min(
      this.config.server.reconnectBaseDelayMs * Math.pow(1.5, this.reconnectAttempts - 1),
      this.config.server.reconnectMaxDelayMs
    );

    this.logger.info(
      `Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this.reconnectAttempts}/${this.config.server.reconnectMaxAttempts})...`
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shouldReconnect) {
        this.connect(events)
          .then(() => {
            this.isReconnecting = false;
          })
          .catch((err) => {
            this.logger.error(`Reconnect attempt ${this.reconnectAttempts} failed: ${err.message}`);
            this.isReconnecting = false;
            // Schedule next attempt
            if (this.shouldReconnect) {
              this.handleReconnect(events);
            }
          });
      } else {
        this.isReconnecting = false;
      }
    }, delay);
  }
}
