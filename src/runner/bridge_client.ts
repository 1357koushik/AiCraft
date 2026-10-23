import http from 'http';
import fs from 'fs';
import path from 'path';
import { ObservedServerEvent, ServerObserverSnapshot } from './types.js';

export interface BridgeClientOptions {
  host?: string;
  port?: number;
  tokenFile?: string;
  token?: string;
  logDir?: string;
  timeoutMs?: number;
}

export class VanillaBridgeClient {
  private host: string;
  private port: number;
  private tokenFile: string;
  private token: string;
  private logDir: string;
  private timeoutMs: number;

  constructor(options: BridgeClientOptions = {}) {
    this.host = options.host || '127.0.0.1';
    this.port = options.port || 25580;
    this.tokenFile = path.resolve(process.cwd(), options.tokenFile || 'logs/integration/.bridge_token');
    this.token = options.token || '';
    this.logDir = path.resolve(process.cwd(), options.logDir || 'logs/integration');
    this.timeoutMs = options.timeoutMs || 4000;
  }

  private resolveToken(): string {
    if (this.token) return this.token;
    if (fs.existsSync(this.tokenFile)) {
      try {
        const t = fs.readFileSync(this.tokenFile, 'utf8').trim();
        if (t) {
          this.token = t;
          return t;
        }
      } catch {}
    }
    return '';
  }

  private request<T = any>(
    method: 'GET' | 'POST',
    apiPath: string,
    body?: any
  ): Promise<{ statusCode: number; data: T }> {
    return new Promise((resolve, reject) => {
      const token = this.resolveToken();
      const payload = body ? JSON.stringify(body) : '';

      const req = http.request(
        {
          hostname: this.host,
          port: this.port,
          path: apiPath,
          method,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            'X-Observer-Token': token,
          },
          timeout: this.timeoutMs,
        },
        (res) => {
          let responseData = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            responseData += chunk;
          });
          res.on('end', () => {
            let parsed: any = responseData;
            try {
              parsed = JSON.parse(responseData);
            } catch {}
            resolve({
              statusCode: res.statusCode || 0,
              data: parsed as T,
            });
          });
        }
      );

      req.on('timeout', () => {
        req.destroy(new Error(`Bridge request timed out after ${this.timeoutMs}ms: ${method} ${apiPath}`));
      });

      req.on('error', (err) => {
        reject(err);
      });

      if (payload) {
        req.write(payload);
      }
      req.end();
    });
  }

  public async checkHealth(): Promise<{ ok: boolean; status?: string; serverRunId?: string; currentSeq?: number }> {
    try {
      const res = await this.request('GET', '/status');
      if (res.statusCode === 200 && res.data && res.data.status === 'ACTIVE') {
        return {
          ok: true,
          status: res.data.status,
          serverRunId: res.data.serverRunId,
          currentSeq: res.data.currentSeq,
        };
      }
      return { ok: false, status: `HTTP ${res.statusCode}` };
    } catch (err: any) {
      return { ok: false, status: err.message };
    }
  }

  public async getSnapshot(): Promise<ServerObserverSnapshot | null> {
    try {
      const res = await this.request<{ timestamp: number; snapshot: any }>('GET', '/snapshot');
      if (res.statusCode === 200 && res.data && res.data.snapshot) {
        const raw = res.data.snapshot;
        const tracked = raw.trackedPlayer;
        return {
          timestamp: new Date(res.data.timestamp || Date.now()).toISOString(),
          dimension: raw.dimension || 'minecraft:overworld',
          playerName: raw.username || 'unknown',
          position: tracked?.position || raw.position || null,
          health: raw.health,
          food: raw.food,
          onlinePlayers: raw.players || [],
          rawSnapshot: raw,
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  public async bindAction(
    runId: string,
    goalId: string,
    actionId: string,
    actionName: string
  ): Promise<{ ok: boolean; seq?: number }> {
    try {
      const res = await this.request<{ ok: boolean; seq: number }>('POST', '/action/start', {
        runId,
        goalId,
        actionId,
        actionName,
      });
      return { ok: res.statusCode === 200 && Boolean(res.data?.ok), seq: res.data?.seq };
    } catch {
      return { ok: false };
    }
  }

  public async unbindAction(): Promise<{ ok: boolean; seq?: number }> {
    try {
      const res = await this.request<{ ok: boolean; seq: number }>('POST', '/action/end');
      return { ok: res.statusCode === 200 && Boolean(res.data?.ok), seq: res.data?.seq };
    } catch {
      return { ok: false };
    }
  }

  public async readEventsForAction(actionId: string, serverRunId?: string): Promise<ObservedServerEvent[]> {
    const results: ObservedServerEvent[] = [];
    try {
      if (!fs.existsSync(this.logDir)) return [];

      const files = fs
        .readdirSync(this.logDir)
        .filter((f) => f.endsWith('.jsonl') && (!serverRunId || f.includes(serverRunId)))
        .map((f) => path.join(this.logDir, f));

      for (const filePath of files) {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const ev = JSON.parse(trimmed);
            if (
              ev.activeContext?.actionId === actionId ||
              ev.details?.actionId === actionId ||
              ev.details?.completedAction?.actionId === actionId
            ) {
              results.push(ev);
            }
          } catch {}
        }
      }
    } catch {}

    // Sort by sequence number
    results.sort((a, b) => a.seq - b.seq);
    return results;
  }
}
