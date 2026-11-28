import type { Bot } from 'mineflayer';
import { runPlan, runSkill, SkillRegistry, StepPlan } from '../skills/contract.js';
import { runBrain, BrainResult, BrainOptions } from '../brain/loop.js';
import { ChatClient } from '../brain/llm_client.js';
import type { RequirementsSource } from '../brain/brief.js';
import { watchDeaths, whyNotRecoverable, DeathRecord, DeathWatch } from '../survival/deaths.js';
import { recoverItemsSkill } from '../skills/recover_items.js';

/**
 * The companion (ROADMAP.md Phase 4, CAPABILITIES.md section 22): takes tasks from its owners in chat, keeps a
 * queue, runs each through the LLM decision loop, and reports back. Control commands (stop, pause, resume,
 * status, queue, orders) are answered by code at once, with no LLM call, and work even while the LLM is slow or down.
 *
 * Standing orders (CAPABILITIES.md section 33: "always guard me", "keep the furnace fuelled", "every night, go
 * home"): the LLM turns the request into a plan once; code keeps that plan and runs it again between other tasks,
 * with no further LLM call unless it fails. A task given in chat always goes first: a running standing order is
 * set aside for it and picked up again afterwards.
 *
 * After a death, code goes back for the dropped items by itself before anything else (a running task does this
 * inside the brain loop).
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
  /** Set when the task became a standing order. */
  orderId?: number;
  /** Not started again before this time (a retry after the LLM could not be reached). */
  notBefore?: number;
  llmRetries?: number;
  /** Cut off by a disconnect: run again from the start once the bot is back. */
  requeue?: boolean;
}

/** Retries, with growing waits, for a task whose LLM could not be reached. */
const LLM_RETRIES = 3;
const LLM_RETRY_MS = 30000;

export interface StandingOrder {
  id: number;
  text: string;
  from: string;
  createdAt: number;
  plan: StepPlan;
  everyMs?: number;
  when?: 'night' | 'day';
  untilStopped: boolean;
  status: 'active' | 'cancelled' | 'suspended';
  runs: number;
  failuresInRow: number;
  /** Not run before this time (the period, or a back-off after a failure). */
  nextAt: number;
  /** For `when` orders: the night (or day) it last ran in, so it runs once per night. */
  lastKey?: string;
  lastMessage?: string;
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
  /** The decision loop; replaced in tests. */
  brain?: (o: BrainOptions) => Promise<BrainResult>;
}

type Control = 'stop' | 'stop_all' | 'pause' | 'resume' | 'status' | 'queue' | 'orders' | 'cancel_orders';

const CONTROLS: Array<[RegExp, Control]> = [
  // Before stop_all, which would otherwise take "stop all standing orders".
  [/^(cancel|stop|clear|end|drop)\s+(all\s+|your\s+|the\s+)?(standing\s+)?orders\b[\s.!]*$/i, 'cancel_orders'],
  [/^(stop|cancel|halt)\s+(all|everything)\b|^clear\s+(the\s+)?(queue|list)\b|^forget\s+everything\b/i, 'stop_all'],
  [/^(stop|cancel|halt|abort|never\s*mind|nevermind|forget\s+(it|that))\b[\s.!]*$/i, 'stop'],
  [/^(pause|wait|hold\s+on|hold\s+up)\b[\s.!]*$/i, 'pause'],
  [/^(resume|continue|carry\s+on|go\s+on|keep\s+going|unpause)\b[\s.!]*$/i, 'resume'],
  [/^(status|what\s+are\s+you\s+doing|what('?s| is)\s+up|what\s+are\s+you\s+up\s+to)\b[\s?.!]*$/i, 'status'],
  [/^(queue|what('?s| is)\s+next|list\s+(your\s+)?tasks|tasks)\b[\s?.!]*$/i, 'queue'],
  [/^((list\s+)?(your\s+)?(standing\s+)?orders|what\s+are\s+your\s+orders)\b[\s?.!]*$/i, 'orders'],
];

export function parseControl(text: string): Control | null {
  const t = text.trim();
  for (const [re, c] of CONTROLS) if (re.test(t)) return c;
  return null;
}

const STOP_WORDS = new Set(['me', 'my', 'the', 'that', 'it', 'this', 'to', 'a', 'an', 'and', 'please', 'now', 'all', 'for', 'of', 'on', 'with']);

/**
 * "stop guarding me", "quit following", "no more fuelling the furnace": the standing orders this names. A word
 * matches an order when its stem (guarding -> guard) appears in the order's text or in one of its steps. Returns
 * null when the text is not a targeted stop, so it goes to the LLM as an ordinary task.
 */
export function matchTargetedStop(text: string, orders: Array<Pick<StandingOrder, 'id' | 'text' | 'plan'>>): number[] | null {
  const m = text.trim().match(/^(?:stop|quit|cancel|end|no\s+more|don'?t\s+keep)\s+(.+?)[\s.!]*$/i);
  if (!m) return null;
  const stems = m[1]
    .toLowerCase()
    .split(/[^a-z_]+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
    .map((w) => w.replace(/(ing|ed|s)$/, '').replace(/(.)\1$/, '$1'))
    .filter((w) => w.length > 2);
  if (!stems.length) return null;
  const hits = orders.filter((o) => {
    const hay = `${o.text} ${o.plan.steps.map((s) => s.skill).join(' ')}`.toLowerCase();
    return stems.some((s) => hay.includes(s));
  });
  return hits.length ? hits.map((o) => o.id) : null;
}

/** Which night (or day) it is, so a `when` order runs once in each. Beds work from 12542 to 23459. */
export function periodKey(when: 'night' | 'day', timeOfDay: number, day: number): string | null {
  const night = timeOfDay >= 12542 && timeOfDay < 23460;
  if (when === 'night') return night ? `night ${day}` : null;
  return !night && timeOfDay < 12000 ? `day ${day}` : null;
}

/** Foods the bot never counts on: they hurt, teleport, or are worth saving. */
const NOT_FOOD = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chorus_fruit', 'suspicious_stew', 'golden_apple', 'enchanted_golden_apple']);

export function hasSafeFood(bot: Bot): boolean {
  const foods: any = (bot.registry as any)?.foodsByName ?? {};
  return bot.inventory.items().some((i: any) => foods[i.name] && !NOT_FOOD.has(i.name));
}

/** At or below this food level, with no food held, the companion goes to get some by itself. */
export const HUNGRY_AT = 8;
const HUNGER_RETRY_MS = 120000;

const MAX_CHAT = 240;
/** Failed runs in a row before a standing order is set aside and the owner told. */
const MAX_ORDER_FAILURES = 3;

type Current =
  | { kind: 'task'; item: TaskItem; abort: AbortController; lastStep?: string }
  | { kind: 'standing'; order: StandingOrder; abort: AbortController; lastStep?: string; preempted?: boolean }
  | { kind: 'recovery'; abort: AbortController; lastStep?: string }
  /** The bot's own errand (getting food when out of it). Any task from the owner sets it aside. */
  | { kind: 'duty'; name: string; abort: AbortController; lastStep?: string };

export class Companion {
  readonly history: TaskItem[] = [];
  readonly orders: StandingOrder[] = [];
  private readonly queue: TaskItem[] = [];
  private current: Current | null = null;
  private nextId = 1;
  private nextOrderId = 1;
  private stopped = false;
  private ordersPaused = false;
  private lastHungerAt = 0;
  private wake: (() => void) | null = null;
  private readonly onChat = (username: string, message: string) => this.handleChat(username, message);
  private deaths: DeathWatch;
  /** Between a disconnect and the next bot: nothing runs. */
  private offline = false;
  private readonly onRespawn = (rec: DeathRecord) => this.reportDeath(rec);
  private worker: Promise<void> | null = null;

  constructor(private readonly o: CompanionOptions) {
    this.deaths = watchDeaths(o.bot);
  }

  start(): void {
    this.o.bot.on('chat', this.onChat);
    this.deaths.on('respawn', this.onRespawn);
    this.worker = this.loop();
  }

  /**
   * The connection dropped: stop what is running (a task goes back to the front of the queue) and wait for rebind.
   * The queue, standing orders and history are kept.
   */
  detach(): void {
    if (this.offline) return;
    this.offline = true;
    this.o.bot.off('chat', this.onChat);
    this.deaths.off('respawn', this.onRespawn);
    const cur = this.current;
    if (cur?.kind === 'task') cur.item.requeue = true;
    if (cur?.kind === 'standing') cur.preempted = true;
    cur?.abort.abort(new Error('disconnected'));
    this.o.log('[companion] disconnected; waiting for the bot to come back');
  }

  /** Carries on with a new bot after a reconnect, keeping the queue, standing orders and history. */
  rebind(bot: Bot): void {
    this.detach();
    this.o.bot = bot;
    this.deaths = watchDeaths(bot);
    bot.on('chat', this.onChat);
    this.deaths.on('respawn', this.onRespawn);
    this.offline = false;
    this.o.log('[companion] reconnected; carrying on');
    this.wake?.();
  }

  /** Stops taking tasks, cancels the running one, and waits for the worker to finish. */
  async shutdown(): Promise<void> {
    this.stopped = true;
    this.o.bot.off('chat', this.onChat);
    this.deaths.off('respawn', this.onRespawn);
    this.current?.abort.abort(new Error('shutting down'));
    this.wake?.();
    await this.worker;
  }

  get idle(): boolean {
    return !this.current && !this.queue.some((t) => t.status === 'queued');
  }

  get activeOrders(): StandingOrder[] {
    return this.orders.filter((o) => o.status === 'active');
  }

  /** Adds a task as if an owner had said it (used by the console and tests). */
  submit(text: string, from: string): TaskItem {
    const item: TaskItem = { id: this.nextId++, text: text.trim(), from, receivedAt: Date.now(), status: 'queued' };
    this.queue.push(item);
    this.o.record?.({ kind: 'task_queued', id: item.id, text: item.text, from });
    const cur = this.current;
    if (cur?.kind === 'standing') {
      // A task from the owner goes first; the standing order is picked up again when the queue is empty.
      cur.preempted = true;
      cur.abort.abort(new Error('a new task came in'));
      this.say(`On it: ${item.text} (setting aside: ${cur.order.text})`);
    } else if (cur?.kind === 'duty') {
      cur.abort.abort(new Error('a new task came in'));
      this.say(`On it: ${item.text} (setting aside: ${cur.name})`);
    } else if (cur) this.say(`Queued (#${this.queue.filter((t) => t.status === 'queued').length} next): ${item.text}`);
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
    if (control) return this.control(control, username);
    const targeted = matchTargetedStop(text, this.activeOrders);
    if (targeted) return this.cancelOrders(targeted, `owner said "${text}"`);
    this.submit(text, username);
  }

  private cancelOrders(ids: number[], why: string): void {
    const gone: string[] = [];
    for (const order of this.orders) {
      if (!ids.includes(order.id) || order.status === 'cancelled') continue;
      order.status = 'cancelled';
      gone.push(order.text);
      this.o.record?.({ kind: 'order_cancelled', id: order.id, why });
      const cur = this.current;
      if (cur?.kind === 'standing' && cur.order.id === order.id) cur.abort.abort(new Error(why));
    }
    this.say(gone.length ? `Stopped standing order${gone.length > 1 ? 's' : ''}: ${gone.join('; ')}.` : 'No standing orders to stop.');
  }

  private ordersLine(): string {
    const active = this.activeOrders;
    return active.length ? ` Standing: ${active.map((o) => o.text).join('; ')}.` : '';
  }

  private control(c: Control, from: string): void {
    this.o.record?.({ kind: 'control', control: c, from });
    const cur = this.current;
    switch (c) {
      case 'stop':
        if (cur?.kind === 'standing') return this.cancelOrders([cur.order.id], 'owner said stop');
        if (cur?.kind === 'recovery') {
          cur.abort.abort(new Error('owner said stop'));
          return this.say('Stopped going back for my things.');
        }
        if (cur?.kind === 'duty') {
          cur.abort.abort(new Error('owner said stop'));
          this.lastHungerAt = Date.now();
          return this.say(`Stopped ${cur.name}.`);
        }
        if (!cur) return this.say(this.activeOrders.length ? `Nothing running right now.${this.ordersLine()} Say "cancel orders" to end them.` : 'Nothing to stop.');
        cur.item.status = 'cancelled';
        cur.abort.abort(new Error('owner said stop'));
        return this.say(`Stopped: ${cur.item.text}.${this.ordersLine()}`);
      case 'stop_all': {
        const dropped = this.queue.filter((t) => t.status === 'queued' || t.status === 'paused');
        for (const t of dropped) t.status = 'cancelled';
        const orders = this.activeOrders;
        for (const o of [...orders, ...this.orders.filter((x) => x.status === 'suspended')]) o.status = 'cancelled';
        if (cur?.kind === 'task') cur.item.status = 'cancelled';
        cur?.abort.abort(new Error('owner said stop all'));
        const was = cur?.kind === 'task' ? cur.item.text : cur?.kind === 'standing' ? cur.order.text : null;
        return this.say(`Stopped everything${was ? ` (was: ${was})` : ''}; cleared ${dropped.length} queued and ${orders.length} standing.`);
      }
      case 'cancel_orders': {
        const ids = this.orders.filter((o) => o.status !== 'cancelled').map((o) => o.id);
        return this.cancelOrders(ids, 'owner cancelled the standing orders');
      }
      case 'pause':
        if (cur?.kind === 'standing') {
          this.ordersPaused = true;
          cur.preempted = true;
          cur.abort.abort(new Error('owner said pause'));
          return this.say(`Paused the standing orders. Say "resume" to carry on.`);
        }
        if (!cur || cur.kind !== 'task') return this.say('Nothing to pause.');
        cur.item.status = 'paused';
        cur.abort.abort(new Error('owner said pause'));
        return this.say(`Paused: ${cur.item.text}. Say "resume" to carry on.`);
      case 'resume': {
        const paused = this.queue.find((t) => t.status === 'paused');
        if (!paused) {
          if (this.ordersPaused) {
            this.ordersPaused = false;
            this.wake?.();
            return this.say(`Resuming the standing orders.${this.ordersLine()}`);
          }
          const doing = cur?.kind === 'task' ? cur.item.text : cur?.kind === 'standing' ? cur.order.text : null;
          return this.say(doing ? `Already working on: ${doing}` : 'Nothing is paused.');
        }
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
        const tail = `${waiting ? ` ${waiting} queued.` : ''}${paused ? ` ${paused} paused.` : ''}${this.ordersLine()}${this.ordersPaused ? ' (standing orders paused)' : ''}`;
        if (!cur) return this.say(`Idle.${tail}`);
        if (cur.kind === 'recovery') return this.say(`Going back for my things after dying.${tail}`);
        if (cur.kind === 'duty') return this.say(`${cur.name[0].toUpperCase()}${cur.name.slice(1)} (my own errand).${tail}`);
        const label = cur.kind === 'task' ? cur.item.text : `standing order: ${cur.order.text}`;
        const since = cur.kind === 'task' ? cur.item.startedAt : undefined;
        const secs = since ? ` (${Math.round((Date.now() - since) / 1000)} s${cur.lastStep ? `, last: ${cur.lastStep}` : ''})` : '';
        return this.say(`Working on: ${label}${secs}.${tail}`);
      }
      case 'queue': {
        const items = this.queue.filter((t) => t.status === 'queued' || t.status === 'paused');
        const doing = cur?.kind === 'task' ? cur.item.text : null;
        if (!items.length) return this.say(doing ? `Only the current task: ${doing}.${this.ordersLine()}` : `The queue is empty.${this.ordersLine()}`);
        return this.say(items.map((t, i) => `${i + 1}. ${t.text}${t.status === 'paused' ? ' (paused)' : ''}`).join(' | ') + this.ordersLine());
      }
      case 'orders': {
        const list = this.orders.filter((o) => o.status !== 'cancelled');
        if (!list.length) return this.say('No standing orders.');
        return this.say(list.map((o, i) => `${i + 1}. ${o.text} (${o.status === 'suspended' ? 'stopped after failing' : o.untilStopped ? 'whenever free' : `ran ${o.runs}x`})`).join(' | '));
      }
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // The worker: tasks first, then recovery after a death, then any standing order that is due.

  private async loop(): Promise<void> {
    while (!this.stopped) {
      if (this.offline) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      // Dead, or just respawned and the slots not read yet: wait, so nothing starts before recovery can.
      const last = this.deaths.last;
      if (last && !last.recoveryTried && !last.itemsAfterRespawn && Date.now() - last.at < 30000) {
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      const pendingDeath = this.pendingRecovery();
      if (pendingDeath) {
        await this.recover(pendingDeath);
        continue;
      }
      const next = this.queue.find((t) => t.status === 'queued' && !(t.notBefore && t.notBefore > Date.now()));
      if (next) {
        this.queue.splice(this.queue.indexOf(next), 1);
        await this.runTask(next);
        continue;
      }
      if (this.hungerDue()) {
        await this.getFood();
        continue;
      }
      const order = this.ordersPaused ? null : this.dueOrder();
      if (order) {
        await this.runOrder(order);
        continue;
      }
      await new Promise<void>((r) => {
        this.wake = r;
        setTimeout(r, 1000);
      });
      this.wake = null;
    }
  }

  /** Hungry with nothing safe to eat, and not tried in the last two minutes. */
  private hungerDue(): boolean {
    const bot = this.o.bot;
    if (typeof bot.food !== 'number' || bot.food > HUNGRY_AT || !(bot.health > 0)) return false;
    if (Date.now() - this.lastHungerAt < HUNGER_RETRY_MS) return false;
    return !hasSafeFood(bot);
  }

  /** Code noticed the hunger; the LLM decides how to get food (hunt, harvest, a chest), since that depends on the place. */
  private async getFood(): Promise<void> {
    this.lastHungerAt = Date.now();
    const abort = new AbortController();
    const cur: Current = { kind: 'duty', name: 'getting food', abort };
    this.current = cur;
    const food = this.o.bot.food;
    this.say(`I'm hungry (food ${food}/20) and have nothing to eat; getting some food.`);
    this.o.record?.({ kind: 'duty_start', duty: 'food', food });
    try {
      const r = await (this.o.brain ?? runBrain)({
        bot: this.o.bot,
        task: 'Eat until your food bar is at least 16 of 20: get safe food (cooked meat, bread, baked potatoes, apples, carrots...) and eat it. The reflexes also eat held food by themselves when you are hungry. Then keep a few pieces.',
        registry: this.o.registry,
        llm: this.o.llm,
        signal: abort.signal,
        requirements: this.o.requirements,
        callBudget: Math.min(this.o.callBudget ?? 6, 6),
        record: this.o.record,
        trigger: `Code noticed that food is ${food}/20 and no safe food is held. This is your own errand, not a task from the owner; if the owner gives a task, it interrupts this one.`,
        log: (line) => {
          const m = line.match(/\[plan\] step \d+ -> (.*)$/);
          if (m) cur.lastStep = m[1].slice(0, 80);
          this.o.log(line);
        },
      });
      this.o.record?.({ kind: 'duty_end', duty: 'food', outcome: r.outcome, message: r.message });
      if (r.outcome === 'done') this.say(`Got food; food is ${this.o.bot.food}/20.`);
      else if (r.outcome !== 'cancelled') this.say(`I couldn't get food: ${r.message}`);
    } catch (err) {
      this.o.log(`[companion] getting food threw: ${(err as Error).message}`);
    } finally {
      this.current = null;
    }
  }

  private pendingRecovery(): DeathRecord | null {
    const rec = this.deaths.last;
    if (!rec || rec.recoveryTried || !rec.respawned || !rec.itemsAfterRespawn) return null;
    if (whyNotRecoverable(rec, this.o.bot)) {
      rec.recoveryTried = true;
      return null;
    }
    return rec;
  }

  private reportDeath(rec: DeathRecord): void {
    const why = whyNotRecoverable(rec, this.o.bot);
    this.o.record?.({ kind: 'death', pos: rec.pos, cause: rec.cause, items: rec.items });
    this.say(`I died${rec.cause ? ` (${rec.cause})` : ''} at ${Math.round(rec.pos.x)} ${Math.round(rec.pos.y)} ${Math.round(rec.pos.z)}. ${why ? `My things are lost: ${why}.` : 'Going back for my things.'}`);
  }

  private async recover(rec: DeathRecord): Promise<void> {
    const abort = new AbortController();
    this.current = { kind: 'recovery', abort };
    rec.recoveryTried = true;
    this.o.record?.({ kind: 'recovery_start', pos: rec.pos });
    try {
      const r = await runSkill(recoverItemsSkill, { bot: this.o.bot, signal: abort.signal, log: this.o.log }, {});
      this.o.record?.({ kind: 'recovery_end', status: r.status, message: r.message });
      if (r.status !== 'interrupted') this.say(r.status === 'done' ? r.message : `Went back for my things: ${r.message}`);
    } finally {
      this.current = null;
    }
  }

  /** The order to run now. Scheduled ones (every N minutes, each night) come before one that runs until stopped. */
  private dueOrder(scheduledOnly = false): StandingOrder | null {
    const now = Date.now();
    const time: any = (this.o.bot as any).time ?? {};
    const due = this.activeOrders.filter((order) => {
      if (order.nextAt > now || (scheduledOnly && order.untilStopped)) return false;
      if (!order.when) return true;
      const key = periodKey(order.when, Number(time.timeOfDay ?? 0), Number(time.day ?? 0));
      return Boolean(key) && key !== order.lastKey;
    });
    return due.find((o) => !o.untilStopped) ?? due[0] ?? null;
  }

  private async runOrder(order: StandingOrder): Promise<void> {
    const abort = new AbortController();
    const cur: Current = { kind: 'standing', order, abort };
    this.current = cur;
    const time: any = (this.o.bot as any).time ?? {};
    const key = order.when ? periodKey(order.when, Number(time.timeOfDay ?? 0), Number(time.day ?? 0)) : null;
    let died = false;
    const onDeath = () => {
      died = true;
      abort.abort(new Error('the bot died'));
    };
    this.deaths.on('death', onDeath);
    // An order that never ends by itself makes way when a scheduled one comes due, and picks up again after it.
    const yieldTimer = order.untilStopped
      ? setInterval(() => {
          if (this.dueOrder(true)) {
            cur.preempted = true;
            abort.abort(new Error('a scheduled standing order is due'));
          }
        }, 1000)
      : null;
    this.o.record?.({ kind: 'order_run', id: order.id, run: order.runs + 1 });
    this.o.log(`[companion] standing order #${order.id} run ${order.runs + 1}: ${order.text}`);
    let run;
    try {
      run = await runPlan(order.plan, this.o.registry, {
        bot: this.o.bot,
        signal: abort.signal,
        log: (line) => {
          const m = line.match(/\[plan\] step \d+ -> (.*)$/);
          if (m) cur.lastStep = m[1].slice(0, 80);
          this.o.log(line);
        },
      });
    } finally {
      this.deaths.off('death', onDeath);
      if (yieldTimer) clearInterval(yieldTimer);
      this.current = null;
    }
    const now = Date.now();
    this.o.record?.({ kind: 'order_run_end', id: order.id, outcome: run.outcome, message: run.message });
    if (order.status !== 'active') return; // cancelled while it ran
    if (cur.preempted || died || this.stopped) {
      // Set aside for a task, a pause, a death or shutdown: not a failure. Pick it up again as soon as it is free.
      order.nextAt = now;
      return;
    }
    if (run.outcome === 'completed') {
      order.runs++;
      order.failuresInRow = 0;
      order.lastMessage = run.message;
      if (key) order.lastKey = key;
      // A plan meant to run until stopped that ended anyway (the player went out of sight) is retried shortly.
      order.nextAt = now + (order.everyMs ?? (order.untilStopped ? 10000 : 60000));
      return;
    }
    // A guard or follow order whose player is out of sight is waiting, not broken: no repair, try again soon.
    const failedStep = run.steps.find((r) => r.result.status !== 'done');
    if (order.untilStopped && failedStep?.result.cause === 'not_found_nearby') {
      order.lastMessage = run.message;
      order.nextAt = now + 30000;
      return;
    }
    order.failuresInRow++;
    order.lastMessage = run.message;
    if (order.failuresInRow >= MAX_ORDER_FAILURES) {
      order.status = 'suspended';
      this.say(`Standing order "${order.text}" failed ${order.failuresInRow} times in a row (${run.message}); I've stopped it. Say it again to restart it.`);
      return;
    }
    if (order.failuresInRow === 1) this.say(`Standing order "${order.text}" hit a problem: ${run.message} Working out a fix.`);
    await this.repairOrder(order, run.message);
    order.nextAt = Date.now() + (order.everyMs ? Math.min(order.everyMs, 60000) : 15000 * order.failuresInRow);
  }

  /** Asks the LLM for a new plan for a standing order whose plan failed. Only on failure, never on a timer. */
  private async repairOrder(order: StandingOrder, failure: string): Promise<void> {
    const abort = new AbortController();
    this.current = { kind: 'standing', order, abort };
    try {
      const r = await (this.o.brain ?? runBrain)({
        bot: this.o.bot,
        task: order.text,
        owner: order.from,
        registry: this.o.registry,
        llm: this.o.llm,
        signal: abort.signal,
        requirements: this.o.requirements,
        callBudget: Math.min(this.o.callBudget ?? 4, 4),
        record: this.o.record,
        log: this.o.log,
        trigger: `This is a standing order you already accepted. Its plan was ${JSON.stringify(order.plan.steps)}, and the last run failed: ${failure} Send a corrected plan with "standing" set again (code will keep running it), or one-off steps that fix the cause. Keep to this order's own duty: do not gather, craft or build things it does not need. If the failure only means there was nothing to do this time, send the same plan again.`,
      });
      if (r.outcome === 'standing' && r.standing) {
        order.plan = r.standing.plan;
        order.untilStopped = r.standing.untilStopped;
        if (r.standing.everyMinutes) order.everyMs = r.standing.everyMinutes * 60000;
        this.o.log(`[companion] standing order #${order.id} has a new plan: ${order.plan.steps.map((s) => s.skill).join(' -> ')}`);
      } else if (r.outcome === 'gave_up') {
        order.status = 'suspended';
        this.say(`I can't keep doing "${order.text}": ${r.message}`);
      }
    } catch (err) {
      this.o.log(`[companion] repairing standing order #${order.id} threw: ${(err as Error).message}`);
    } finally {
      this.current = null;
    }
  }

  private addOrder(item: TaskItem, r: BrainResult): StandingOrder {
    const s = r.standing!;
    // The same order given again replaces the old one (and restarts one that was stopped after failing).
    for (const old of this.orders) if (old.status !== 'cancelled' && old.text.toLowerCase() === item.text.toLowerCase()) old.status = 'cancelled';
    const order: StandingOrder = {
      id: this.nextOrderId++,
      text: item.text,
      from: item.from,
      createdAt: Date.now(),
      plan: s.plan,
      everyMs: s.everyMinutes ? s.everyMinutes * 60000 : undefined,
      when: s.when,
      untilStopped: s.untilStopped,
      status: 'active',
      runs: 0,
      failuresInRow: 0,
      nextAt: Date.now(),
    };
    this.orders.push(order);
    this.o.record?.({ kind: 'order_added', id: order.id, text: order.text, plan: order.plan, everyMs: order.everyMs, when: order.when, untilStopped: order.untilStopped });
    return order;
  }

  private async runTask(item: TaskItem): Promise<void> {
    const abort = new AbortController();
    item.status = 'running';
    item.startedAt = Date.now();
    const cur: Current = { kind: 'task', item, abort };
    this.current = cur;
    this.o.record?.({ kind: 'task_start', id: item.id, text: item.text });
    let result: BrainResult | null = null;
    try {
      result = await (this.o.brain ?? runBrain)({
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
          if (m) cur.lastStep = m[1].slice(0, 80);
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
    if (item.requeue && status !== 'cancelled') {
      item.requeue = false;
      item.status = 'queued';
      this.queue.unshift(item);
      this.o.record?.({ kind: 'task_requeued', id: item.id, why: 'disconnected' });
      return;
    }
    if (result?.outcome === 'llm_error' && status !== 'cancelled' && status !== 'paused' && (item.llmRetries ?? 0) < LLM_RETRIES) {
      // An LLM outage should not lose the owner's task: wait and try again from the start.
      item.llmRetries = (item.llmRetries ?? 0) + 1;
      const wait = LLM_RETRY_MS * item.llmRetries;
      item.notBefore = Date.now() + wait;
      item.status = 'queued';
      this.queue.unshift(item);
      this.say(`I can't reach my LLM right now; I'll try "${item.text}" again in ${Math.round(wait / 1000)} s.`);
      this.o.record?.({ kind: 'task_retry', id: item.id, attempt: item.llmRetries, message: result.message });
      return;
    }
    if (status === 'paused') {
      // Keep it for "resume", ahead of anything queued later.
      this.queue.unshift(item);
    } else {
      if (status !== 'cancelled') {
        if (result?.outcome === 'standing' && result.standing) {
          const order = this.addOrder(item, result);
          item.orderId = order.id;
          item.status = 'done';
          const how = order.everyMs ? `every ${Math.round(order.everyMs / 6000) / 10} min` : order.when ? `each ${order.when}` : 'between other tasks';
          this.say(`Standing order: ${item.text}. I'll keep doing it ${how} until you say "stop" while I'm on it, or "cancel orders".`);
        } else {
          item.status = result?.outcome === 'done' || result?.outcome === 'answered' ? 'done' : 'failed';
          this.report(item, result);
        }
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
