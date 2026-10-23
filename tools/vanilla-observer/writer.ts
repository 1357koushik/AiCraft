import fs from 'fs';
import path from 'path';

export interface ObserverEventCoordinates {
  x: number;
  y: number;
  z: number;
}

export interface ObserverEventCancellation {
  cancelled: boolean;
  reason?: string | null;
}

export interface ActiveActionContext {
  runId?: string;
  goalId?: string;
  actionId?: string;
  actionName?: string;
}

export interface ObserverEvent {
  seq: number;
  timestamp: string;
  serverRunId: string;
  dimension: string;
  playerUuid?: string | null;
  playerName?: string | null;
  eventType: string;
  coordinates?: ObserverEventCoordinates | null;
  blockId?: string | null;
  itemId?: string | null;
  amount?: number | null;
  cancellation?: ObserverEventCancellation | null;
  activeContext?: ActiveActionContext | null;
  details?: Record<string, any>;
}

export interface WriterOptions {
  logDir: string;
  runId: string;
  maxSizeBytes?: number;
  maxFiles?: number;
}

export class RotatingJsonlWriter {
  private logDir: string;
  private runId: string;
  private maxSizeBytes: number;
  private maxFiles: number;

  private seq: number = 0;
  private currentFileIndex: number = 0;
  private currentFilePath: string = '';
  private currentBytesWritten: number = 0;
  private isClosed: boolean = false;

  constructor(options: WriterOptions) {
    this.logDir = path.resolve(process.cwd(), options.logDir);
    this.runId = options.runId || `run_${Date.now()}`;
    this.maxSizeBytes = options.maxSizeBytes || 50 * 1024 * 1024; // 50 MB
    this.maxFiles = options.maxFiles || 5;
  }

  public async start(): Promise<void> {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
    this.rotate();
  }

  public nextSeq(): number {
    this.seq++;
    return this.seq;
  }

  public get currentSequence(): number {
    return this.seq;
  }

  public get activeFilePath(): string {
    return this.currentFilePath;
  }

  public static redact(text: string): string {
    if (!text) return text;
    return text
      .replace(/sk-[a-zA-Z0-9_-]{20,}/g, 'sk-***REDACTED***')
      .replace(
        /(["']?(?:token|password|secret|bearer)["']?\s*[:=]\s*["']?)([^"',\s\}]+)(["']?)/gi,
        '$1***REDACTED***$3'
      );
  }

  public write(event: ObserverEvent): void {
    if (this.isClosed) return;

    const line = JSON.stringify(event) + '\n';
    const redacted = RotatingJsonlWriter.redact(line);
    const lineBytes = Buffer.byteLength(redacted, 'utf8');

    if (this.currentBytesWritten > 0 && this.currentBytesWritten + lineBytes >= this.maxSizeBytes) {
      this.rotate();
    }

    fs.appendFileSync(this.currentFilePath, redacted, 'utf8');
    this.currentBytesWritten += lineBytes;
  }

  private rotate(): void {
    this.currentFileIndex++;
    const fileName = `observer-vanilla-${this.runId}-part${String(this.currentFileIndex).padStart(2, '0')}.jsonl`;
    this.currentFilePath = path.join(this.logDir, fileName);
    fs.appendFileSync(this.currentFilePath, '', 'utf8');
    this.currentBytesWritten = 0;

    this.purgeOldFiles();
  }

  private purgeOldFiles(): void {
    try {
      const files = fs
        .readdirSync(this.logDir)
        .filter((f) => f.startsWith(`observer-vanilla-${this.runId}-part`) && f.endsWith('.jsonl'))
        .sort(); // Lexicographical sort by part number: part01, part02, part03...

      if (files.length > this.maxFiles) {
        const toDelete = files.slice(0, files.length - this.maxFiles);
        for (const file of toDelete) {
          const filePath = path.join(this.logDir, file);
          // Do not delete current active file
          if (filePath !== this.currentFilePath) {
            try {
              fs.unlinkSync(filePath);
            } catch {}
          }
        }
      }
    } catch {}
  }

  public async close(): Promise<void> {
    this.isClosed = true;
  }
}
