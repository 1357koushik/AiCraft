import mineflayer, { Bot } from 'mineflayer';
import { pathfinder, Movements } from 'mineflayer-pathfinder';
import minecraftData from 'minecraft-data';
import { AppConfig } from '../config/index.js';
import { AgentLogger } from '../utils/logger.js';

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

  constructor(config: AppConfig, logger: AgentLogger) {
    this.config = config;
    this.logger = logger;
  }

  public get currentBot(): Bot | null {
    return this.bot;
  }

  public async connect(events?: ConnectionEvents): Promise<Bot> {
    return new Promise((resolve, reject) => {
      this.logger.info(
        `Connecting bot to ${this.config.server.host}:${this.config.server.port} as '${this.config.server.username}' (MC ${this.config.server.version})...`
      );

      const options: mineflayer.BotOptions = {
        host: this.config.server.host,
        port: this.config.server.port,
        version: this.config.server.version,
        username: this.config.server.username,
        auth: this.config.server.auth as any,
        checkTimeoutInterval: 30000,
      };

      const bot = mineflayer.createBot(options);
      this.bot = bot;

      // Attach pathfinder
      bot.loadPlugin(pathfinder);

      bot.once('spawn', () => {
        this.reconnectAttempts = 0;
        this.logger.info(`Bot successfully spawned in world as '${bot.username}'!`);

        // Configure pathfinder default movements for 1.21.6
        const defaultMove = new Movements(bot);
        defaultMove.canDig = true;
        defaultMove.allow1by1towers = false;
        (defaultMove as any).scafoldingBlocks = [];
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
    if (this.bot) {
      this.bot.quit();
      this.bot = null;
    }
  }

  private handleReconnect(events?: ConnectionEvents): void {
    if (this.reconnectAttempts >= this.config.server.reconnectMaxAttempts) {
      this.logger.error(`Max reconnect attempts (${this.config.server.reconnectMaxAttempts}) reached. Giving up.`);
      return;
    }

    this.reconnectAttempts++;
    // Exponential backoff with jitter
    const delay = Math.min(
      this.config.server.reconnectBaseDelayMs * Math.pow(1.5, this.reconnectAttempts - 1),
      this.config.server.reconnectMaxDelayMs
    );

    this.logger.info(`Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this.reconnectAttempts}/${this.config.server.reconnectMaxAttempts})...`);
    setTimeout(() => {
      if (this.shouldReconnect) {
        this.connect(events).catch((err) => {
          this.logger.error(`Reconnect attempt ${this.reconnectAttempts} failed: ${err.message}`);
        });
      }
    }, delay);
  }
}
