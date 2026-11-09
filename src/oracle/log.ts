import fs from 'fs';
import { uuidFromIntArrayText } from './uuid.js';

/** One classified line of the vanilla server's logs/latest.log. */
export type ServerLogEntry =
  | { kind: 'oracle'; time: string; event: OracleEvent; raw: string }
  | { kind: 'command'; time: string; source: string; feedback: string; raw: string }
  | { kind: 'chat'; time: string; player: string; message: string; raw: string }
  | { kind: 'join' | 'leave'; time: string; player: string; raw: string }
  | { kind: 'advancement'; time: string; player: string; title: string; raw: string }
  | { kind: 'player_message'; time: string; player: string; text: string; raw: string }
  | { kind: 'other'; time: string; level: string; message: string; raw: string };

/** An event the bot_oracle datapack printed with `say [oracle] {json}`. */
export interface OracleEvent {
  ev: string;
  uuid?: string;
  dim?: string;
  x?: number;
  y?: number;
  z?: number;
  t?: number;
  label?: string;
  [key: string]: unknown;
}

const LINE = /^\[(\d{2}:\d{2}:\d{2})\] \[([^\]]+)\/([A-Z]+)\]: (.*)$/;
const NAME = '[A-Za-z0-9_]{1,16}';
/**
 * Datapack output. Functions run by the server (tick, load) print as [Server]; functions the harness runs
 * over RCON (e.g. the t0 mark) print as [Rcon]. Players cannot produce either prefix: their chat shows as
 * <name> and their /say as [name].
 */
const ORACLE = /^(?:\[Not Secure\] )?\[(?:Server|Rcon)\] \[oracle\] (\{.*\})$/;
const COMMAND = new RegExp(`^\\[(Rcon|${NAME}): (.*)\\]$`);
const CHAT = new RegExp(`^(?:\\[Not Secure\\] )?<(${NAME})> (.*)$`);
const JOIN = new RegExp(`^(${NAME}) joined the game$`);
const LEAVE = new RegExp(`^(${NAME}) left the game$`);
const ADVANCEMENT = new RegExp(`^(${NAME}) has (?:made the advancement|completed the challenge|reached the goal) \\[(.+)\\]$`);
/** Lines that start with a player name but are not death messages. */
const NOT_DEATH = /^(?:joined the game|left the game|lost connection|\[\/|moved too quickly|moved wrongly|has (?:made the advancement|completed the challenge|reached the goal))/;

export function parseServerLogLine(raw: string, knownPlayers: string[] = []): ServerLogEntry | null {
  const line = raw.replace(/\r$/, '');
  const match = line.match(LINE);
  if (!match) return null;
  const [, time, , level, message] = match;

  const oracle = message.match(ORACLE);
  if (oracle) {
    try {
      const event = JSON.parse(oracle[1]) as OracleEvent;
      if (typeof event.uuid === 'string') {
        event.uuid = uuidFromIntArrayText(event.uuid) ?? event.uuid;
      }
      return { kind: 'oracle', time, event, raw: line };
    } catch {
      return { kind: 'other', time, level, message, raw: line };
    }
  }
  const command = message.match(COMMAND);
  if (command) return { kind: 'command', time, source: command[1], feedback: command[2], raw: line };
  const chat = message.match(CHAT);
  if (chat) return { kind: 'chat', time, player: chat[1], message: chat[2], raw: line };
  const join = message.match(JOIN);
  if (join) return { kind: 'join', time, player: join[1], raw: line };
  const leave = message.match(LEAVE);
  if (leave) return { kind: 'leave', time, player: leave[1], raw: line };
  const advancement = message.match(ADVANCEMENT);
  if (advancement) return { kind: 'advancement', time, player: advancement[1], title: advancement[2], raw: line };

  for (const player of knownPlayers) {
    if (message.startsWith(`${player} `)) {
      const text = message.slice(player.length + 1);
      if (!NOT_DEATH.test(text)) return { kind: 'player_message', time, player, text, raw: line };
    }
  }
  return { kind: 'other', time, level, message, raw: line };
}

/**
 * Harness bookkeeping feedback that may appear after the measured window starts
 * and does not count as assistance.
 */
const HARNESS_FEEDBACK = [/^Running function bot_oracle:/, /^Saving the game/, /^Saved the game/, /^Stopping the server/];

/** True when a command line means someone changed the game during the measured window. */
export function isAssistingCommand(entry: ServerLogEntry): boolean {
  if (entry.kind !== 'command') return false;
  if (entry.source === 'Rcon') return !HARNESS_FEEDBACK.some((re) => re.test(entry.feedback));
  return true;
}

/** Reads new lines appended to a log file since the last poll. */
export class LogTailer {
  private offset = 0;
  private partial = '';

  constructor(private readonly filePath: string) {}

  poll(): string[] {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.filePath);
    } catch {
      return [];
    }
    if (stat.size < this.offset) {
      // File was rotated or truncated: start over.
      this.offset = 0;
      this.partial = '';
    }
    if (stat.size === this.offset) return [];
    const fd = fs.openSync(this.filePath, 'r');
    try {
      const length = stat.size - this.offset;
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, this.offset);
      this.offset = stat.size;
      const text = this.partial + buffer.toString('utf8');
      const lines = text.split('\n');
      this.partial = lines.pop() ?? '';
      return lines.filter((l) => l.length > 0);
    } finally {
      fs.closeSync(fd);
    }
  }
}
