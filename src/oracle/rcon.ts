import net from 'net';

/**
 * Minimal Source-RCON client for the vanilla Minecraft server.
 *
 * Vanilla splits long replies into several 4096-byte packets that share the
 * request id and gives no end marker. To know a reply is complete, a packet of
 * an unknown type (0) is sent after the first reply packet arrives; the server
 * answers it with "Unknown request 0" only after the rest of the reply.
 *
 * Vanilla also reads one packet per socket read and drops anything else in the
 * same read, so packets are never pipelined: one command is in flight at a time.
 */

const TYPE_AUTH = 3;
const TYPE_COMMAND = 2;
const TYPE_TERMINATOR = 0;

export interface RconPacket {
  id: number;
  type: number;
  body: string;
}

export function encodePacket(id: number, type: number, body: string): Buffer {
  const payload = Buffer.from(body, 'utf8');
  const packet = Buffer.alloc(14 + payload.length);
  packet.writeInt32LE(10 + payload.length, 0);
  packet.writeInt32LE(id, 4);
  packet.writeInt32LE(type, 8);
  payload.copy(packet, 12);
  packet.writeInt16LE(0, 12 + payload.length);
  return packet;
}

/** Splits a byte stream into packets. Returns the packets and the unconsumed remainder. */
export function decodePackets(buffer: Buffer): { packets: RconPacket[]; rest: Buffer } {
  const packets: RconPacket[] = [];
  let offset = 0;
  while (buffer.length - offset >= 4) {
    const length = buffer.readInt32LE(offset);
    if (length < 10 || buffer.length - offset < 4 + length) break;
    const id = buffer.readInt32LE(offset + 4);
    const type = buffer.readInt32LE(offset + 8);
    const body = buffer.toString('utf8', offset + 12, offset + 4 + length - 2);
    packets.push({ id, type, body });
    offset += 4 + length;
  }
  return { packets, rest: buffer.subarray(offset) };
}

interface Pending {
  text: string;
  commandId: number;
  terminatorId: number;
  terminatorSent: boolean;
  chunks: string[];
  resolve: (body: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | null;
}

export interface RconOptions {
  host?: string;
  port: number;
  password: string;
  commandTimeoutMs?: number;
}

export class RconClient {
  private socket: net.Socket | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending: Pending[] = [];
  private authWaiter: { id: number; resolve: () => void; reject: (e: Error) => void } | null = null;
  private closed = false;

  constructor(private readonly options: RconOptions) {}

  get connected(): boolean {
    return this.socket !== null && !this.closed;
  }

  async connect(): Promise<void> {
    const { host = '127.0.0.1', port, password } = this.options;
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(port, host);
      const onError = (err: Error) => {
        socket.destroy();
        reject(err);
      };
      socket.once('error', onError);
      socket.once('connect', () => {
        socket.off('error', onError);
        this.socket = socket;
        this.closed = false;
        socket.on('data', (data) => this.onData(data));
        socket.on('error', (err) => this.failAll(err));
        socket.on('close', () => {
          this.closed = true;
          this.failAll(new Error('RCON connection closed'));
        });
        resolve();
      });
    });

    const id = this.nextId++;
    await new Promise<void>((resolve, reject) => {
      this.authWaiter = { id, resolve, reject };
      this.socket!.write(encodePacket(id, TYPE_AUTH, password));
    });
  }

  /** Runs one command and returns the full reply text. Commands are queued and run one at a time, in order. */
  command(text: string): Promise<string> {
    if (!this.socket || this.closed) return Promise.reject(new Error('RCON not connected'));
    return new Promise<string>((resolve, reject) => {
      this.pending.push({
        text,
        commandId: this.nextId++,
        terminatorId: this.nextId++,
        terminatorSent: false,
        chunks: [],
        resolve,
        reject,
        timer: null,
      });
      if (this.pending.length === 1) this.sendHead();
    });
  }

  private sendHead(): void {
    const head = this.pending[0];
    if (!head || !this.socket) return;
    const timeoutMs = this.options.commandTimeoutMs ?? 15000;
    head.timer = setTimeout(() => {
      // The connection is now out of step with the server; drop it.
      this.failAll(new Error(`RCON command timed out after ${timeoutMs} ms: ${head.text}`));
      this.close();
    }, timeoutMs);
    this.socket.write(encodePacket(head.commandId, TYPE_COMMAND, head.text));
  }

  close(): void {
    this.closed = true;
    this.socket?.end();
    this.socket?.destroy();
    this.socket = null;
  }

  private onData(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);
    const { packets, rest } = decodePackets(this.buffer);
    this.buffer = rest;
    for (const packet of packets) this.onPacket(packet);
  }

  private onPacket(packet: RconPacket): void {
    if (this.authWaiter) {
      const waiter = this.authWaiter;
      if (packet.id === -1) {
        this.authWaiter = null;
        waiter.reject(new Error('RCON authentication failed (wrong password)'));
        return;
      }
      if (packet.id === waiter.id && packet.type === TYPE_COMMAND) {
        this.authWaiter = null;
        waiter.resolve();
        return;
      }
    }
    const head = this.pending[0];
    if (!head) return;
    if (packet.id === head.commandId) {
      head.chunks.push(packet.body);
      if (!head.terminatorSent) {
        head.terminatorSent = true;
        this.socket?.write(encodePacket(head.terminatorId, TYPE_TERMINATOR, ''));
      }
      return;
    }
    if (packet.id !== head.terminatorId) return;
    if (head.timer) clearTimeout(head.timer);
    this.pending.shift();
    head.resolve(head.chunks.join(''));
    this.sendHead();
  }

  private failAll(err: Error): void {
    if (this.authWaiter) {
      this.authWaiter.reject(err);
      this.authWaiter = null;
    }
    const pending = this.pending;
    this.pending = [];
    for (const entry of pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(err);
    }
  }
}

/** Connects, retrying until the server's RCON listener is up or the deadline passes. */
export async function connectRconWithRetry(options: RconOptions, deadlineMs: number): Promise<RconClient> {
  const start = Date.now();
  let lastError: unknown = null;
  while (Date.now() - start < deadlineMs) {
    const client = new RconClient(options);
    try {
      await client.connect();
      return client;
    } catch (err) {
      lastError = err;
      client.close();
      if (err instanceof Error && err.message.includes('authentication failed')) throw err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`RCON not reachable within ${deadlineMs} ms: ${String((lastError as Error)?.message ?? lastError)}`);
}
