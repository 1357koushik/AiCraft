import type { Bot } from 'mineflayer';
import { SkillRegistry } from '../skills/contract.js';
import { runBrain, BrainResult } from '../brain/loop.js';
import { ChatClient } from '../brain/llm_client.js';
import type { RequirementsSource } from '../brain/brief.js';

/**
 * The companion (ROADMAP.md Phase 4, CAPABILITIES.md section 22): takes tasks from its owners in chat, keeps a
 * queue, runs each through the LLM decision loop, and reports back. Control commands (stop, pause, resume,
 * status, queue) are answered by code at once, with no LLM call, and work even while the LLM is slow or down.
 *
 * Only configured owners can give tasks or commands; everyone else's chat is ignored, and so are the judge's
 * "[oracle]" lines.
 */

export type TaskStatus = 'queued' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled';

export interface TaskItem {
  id: number;
  text: string;
  from: string;
  receivedAt: number;
  status: TaskStatus;
  startedAt?: number;
  endedAt?: number;
  outcome?: BrainResult['outcome'];
  message?: string;
  calls?: number;
}

export interface CompanionOptions {
  bot: Bot;
  owners: string[];
  registry: SkillRegistry;
  llm: ChatClient;
  requirements?: RequirementsSource;
  log: (line: string) => void;
  callBudget?: number;
  record?: (entry: Record<string, unknown>) => void;
}

type Control = 'stop' | 'stop_all' | 'pause' | 'resume' | 'status' | 'queue';

const CONTROLS: Array<[RegExp, Control]> = [
  [/^(stop|cancel|halt)\s+(all|everything)\b|^clear\s+(the\s+)?(queue|list)\b|^forget\s+everything\b/i, 'stop_all'],
  [/^(stop|cancel|halt|abort|never\s*mind|nevermind|forget\s+(it|that))\b[\s.!]*$/i, 'stop'],
  [/^(pause|wait|hold\s+on|hold\s+up)\b[\s.!]*$/i, 'pause'],
  [/^(resume|continue|carry\s+on|go\s+on|keep\s+going|unpause)\b[\s.!]*$/i, 'resume'],
  [/^(status|what\s+are\s+you\s+doing|what('?s| is)\s+up|what\s+are\s+you\s+up\s+to)\b[\s?.!]*$/i, 'status'],
  [/^(queue|what('?s| is)\s+next|list\s+(your\s+)?tasks|tasks)\b[\s?.!]*$/i, 'queue'],
];

export function parseControl(text: string): Control | null {
  const t = text.trim();
  for (const [re, c] of CONTROLS) if (re.test(t)) return c;
  return null;
}

const MAX_CHAT = 240;

export class Companion {
  readonly history: TaskItem[] = [];
  private readonly queue: TaskItem[] = [];
  private current: { item: TaskItem; abort: AbortController; lastStep?: string } | null = null;
  private nextId = 1;
  private stopped = false;
  private wake: (() => void) | null = null;
  private readonly onChat = (username: string, message: string) => this.handleChat(username, message);
  private worker: Promise<void> | null = null;

  constructor(private readonly o: CompanionOptions) {}

  start(): void {
    this.o.bot.on('chat', this.onChat);
    this.worker = this.loop();
  }

  /** Stops taking tasks, cancels the running one, and waits for the worker to finish. */
  async shutdown(): Promise<void> {
    this.stopped = true;
    this.o.bot.off('chat', this.onChat);
    this.current?.abort.abort(new Error('shutting down'));
    this.wake?.();
    await this.worker;
  }

  get idle(): boolean {
    return !this.current && !this.queue.some((t) => t.status === 'queued');
  }

  /** Adds a task as if an owner had said it (used by the console and tests). */
  submit(text: string, from: string): TaskItem {
    const item: TaskItem = { id: this.nextId++, text: text.trim(), from, receivedAt: Date.now(), status: 'queued' };
    this.queue.push(item);
    this.o.record?.({ kind: 'task_queued', id: item.id, text: item.text, from });
    if (this.current) this.say(`Queued (#${this.queue.filter((t) => t.status === 'queued').length} next): ${item.text}`);
    else this.say(`On it: ${item.text}`);
    this.wake?.();
    return item;
  }

  private say(text: string): void {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean) return;
    const line = clean.length > MAX_CHAT ? `${clean.slice(0, MAX_CHAT - 3)}...` : clean;
    this.o.log(`[companion] says: ${line}`);
    try {
      this.o.bot.chat(line);
    } catch (err) {
      this.o.log(`[companion] chat failed: ${(err as Error).message}`);
    }
  }

  private handleChat(username: string, message: string): void {
    if (username === this.o.bot.username) return;
    if (!this.o.owners.includes(username)) return;
    if (/^\s*\[oracle\]/.test(message)) return;
    const text = message.trim();
    if (!text) return;
    this.o.log(`[companion] ${username}: ${text}`);
    const control = parseControl(text);
    if (control) this.control(control, username);
    else this.submit(text, username);
  }

  private control(c: Control, from: string): void {
    this.o.record?.({ kind: 'control', control: c, from });
    const cur = this.current;
    switch (c) {
      case 'stop':
        if (!cur) return this.say('Nothing to stop.');
        cur.item.status = 'cancelled';
        cur.abort.abort(new Error('owner said stop'));
        return this.say(`Stopped: ${cur.item.text}`);
      case 'stop_all': {
        const dropped = this.queue.filter((t) => t.status === 'queued' || t.status === 'paused');
        for (const t of dropped) t.status = 'cancelled';
        if (cur) {
          cur.item.status = 'cancelled';
          cur.abort.abort(new Error('owner said stop all'));
        }
        return this.say(`Stopped everything${cur ? ` (was: ${cur.item.text})` : ''}; cleared ${dropped.length} queued.`);
      }
      case 'pause':
        if (!cur) return this.say('Nothing to pause.');
        cur.item.status = 'paused';
        cur.abort.abort(new Error('owner said pause'));
        return this.say(`Paused: ${cur.item.text}. Say "resume" to carry on.`);
      case 'resume': {
        const paused = this.queue.find((t) => t.status === 'paused');
        if (!paused) return this.say(cur ? `Already working on: ${cur.item.text}` : 'Nothing is paused.');
        paused.status = 'queued';
        // Resume before anything queued after it.
        this.queue.splice(this.queue.indexOf(paused), 1);
        this.queue.unshift(paused);
        this.say(`Resuming: ${paused.text}`);
        this.wake?.();
        return;
      }
      case 'status': {
        const waiting = this.queue.filter((t) => t.status === 'queued').length;
        const paused = this.queue.filter((t) => t.status === 'paused').length;
        if (!cur) return this.say(`Idle.${waiting ? ` ${waiting} queued.` : ''}${paused ? ` ${paused} paused.` : ''}`);
        const secs = Math.round((Date.now() - (cur.item.startedAt ?? Date.now())) / 1000);
        return this.say(`Working on: ${cur.item.text} (${secs} s${cur.lastStep ? `, last: ${cur.lastStep}` : ''}).${waiting ? ` ${waiting} queued.` : ''}`);
      }
      case 'queue': {
        const items = this.queue.filter((t) => t.status === 'queued' || t.status === 'paused');
        if (!items.length) return this.say(cur ? `Only the current task: ${cur.item.text}` : 'The queue is empty.');
        return this.say(items.map((t, i) => `${i + 1}. ${t.text}${t.status === 'paused' ? ' (paused)' : ''}`).join(' | '));
      }
    }
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      const next = this.queue.find((t) => t.status === 'queued');
      if (!next) {
        await new Promise<void>((r) => {
          this.wake = r;
          setTimeout(r, 1000);
        });
        this.wake = null;
        continue;
      }
      this.queue.splice(this.queue.indexOf(next), 1);
      await this.runTask(next);
    }
  }

  private async runTask(item: TaskItem): Promise<void> {
    const abort = new AbortController();
    item.status = 'running';
    item.startedAt = Date.now();
    this.current = { item, abort };
    this.o.record?.({ kind: 'task_start', id: item.id, text: item.text });
    let result: BrainResult | null = null;
    try {
      result = await runBrain({
        bot: this.o.bot,
        task: item.text,
        owner: item.from,
        registry: this.o.registry,
        llm: this.o.llm,
        signal: abort.signal,
        requirements: this.o.requirements,
        callBudget: this.o.callBudget,
        record: this.o.record,
        log: (line) => {
          const m = line.match(/\[plan\] step \d+ -> (.*)$/);
          if (m && this.current) this.current.lastStep = m[1].slice(0, 80);
          this.o.log(line);
        },
      });
    } catch (err) {
      this.o.log(`[companion] task #${item.id} threw: ${(err as Error).message}`);
    }
    this.current = null;
    item.endedAt = Date.now();
    item.outcome = result?.outcome;
    item.message = result?.message;
    item.calls = result?.calls;
    // The status may have been changed by a control command (stop, pause) while the brain ran.
    const status = item.status as TaskStatus;
    if (status === 'paused') {
      // Keep it for "resume", ahead of anything queued later.
      this.queue.unshift(item);
    } else {
      if (status !== 'cancelled') {
        item.status = result?.outcome === 'done' || result?.outcome === 'answered' ? 'done' : 'failed';
        this.report(item, result);
      }
      this.history.push(item);
    }
    this.o.record?.({ kind: 'task_end', id: item.id, status: item.status, outcome: item.outcome, calls: item.calls });
  }

  private report(item: TaskItem, r: BrainResult | null): void {
    if (!r) return this.say(`Something went wrong with: ${item.text}`);
    switch (r.outcome) {
      case 'done':
        return this.say(`Done: ${item.text}.`);
      case 'answered':
        return this.say(r.message);
      case 'gave_up':
        return this.say(`I can't do that: ${r.message}`);
      case 'asked_owner':
        return this.say(r.message);
      case 'cancelled':
        return;
      default:
        return this.say(`I couldn't finish "${item.text}": ${r.message}`);
    }
  }
}
