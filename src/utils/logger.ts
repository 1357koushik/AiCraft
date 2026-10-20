import fs from 'fs';
import path from 'path';
import pino from 'pino';
import { AppConfig } from '../config/index.js';

export interface StepRecord {
  step: number;
  timestamp: string;
  goal: string;
  vitals: {
    health: number;
    food: number;
    isAlive: boolean;
  };
  position: { x: number; y: number; z: number };
  decisionSummary: string;
  selectedActions: any[];
  actionResults: any[];
  latencyMs: number;
  tokens?: { prompt: number; completion: number; total: number };
  reflexFired?: string;
  error?: string;
}

export class AgentLogger {
  private pinoLogger: pino.Logger;
  private jsonlFilePath: string;
  private config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
    const logDir = path.resolve(process.cwd(), config.logging.folder);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.jsonlFilePath = path.join(logDir, `agent-steps-${timestamp}.jsonl`);

    this.pinoLogger = pino({
      level: config.logging.level,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss',
          ignore: 'pid,hostname',
        },
      },
    });
  }

  public get logger(): pino.Logger {
    return this.pinoLogger;
  }

  public redact(text: string): string {
    if (!this.config.logging.redactSecrets || !text) return text;
    // Redact common API keys or authorization patterns
    return text
      .replace(/sk-[a-zA-Z0-9_-]{20,}/g, 'sk-***REDACTED***')
      .replace(/bearer\s+[a-zA-Z0-9_\-\.]{20,}/gi, 'Bearer ***REDACTED***');
  }

  public recordStep(record: StepRecord): void {
    try {
      const line = JSON.stringify(record) + '\n';
      fs.appendFileSync(this.jsonlFilePath, line, 'utf-8');
    } catch (err: any) {
      this.pinoLogger.error({ err }, 'Failed to write step record to JSONL');
    }
  }

  public info(msgOrObj: any, ...args: any[]): void {
    if (typeof msgOrObj === 'object') {
      this.pinoLogger.info(msgOrObj, args[0], ...args.slice(1));
    } else {
      this.pinoLogger.info(msgOrObj, ...args);
    }
  }

  public warn(msgOrObj: any, ...args: any[]): void {
    if (typeof msgOrObj === 'object') {
      this.pinoLogger.warn(msgOrObj, args[0], ...args.slice(1));
    } else {
      this.pinoLogger.warn(msgOrObj, ...args);
    }
  }

  public error(msgOrObj: any, ...args: any[]): void {
    if (typeof msgOrObj === 'object') {
      this.pinoLogger.error(msgOrObj, args[0], ...args.slice(1));
    } else {
      this.pinoLogger.error(msgOrObj, ...args);
    }
  }

  public debug(msgOrObj: any, ...args: any[]): void {
    if (typeof msgOrObj === 'object') {
      this.pinoLogger.debug(msgOrObj, args[0], ...args.slice(1));
    } else {
      this.pinoLogger.debug(msgOrObj, ...args);
    }
  }
}
