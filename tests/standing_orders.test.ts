import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import { Vec3 } from 'vec3';
import { z } from 'zod';
import { parseDecision, planRunsUntilStopped } from '../src/brain/decision.js';
import { buildRegistry } from '../src/skills/registry.js';
import type { SkillDefinition, StepPlan } from '../src/skills/contract.js';
import { Companion, matchTargetedStop, parseControl, periodKey } from '../src/companion/companion.js';
import type { BrainOptions, BrainResult } from '../src/brain/loop.js';
import { validateEvents } from '../src/harness/judged_run.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Skills for the tests: `tick` counts its runs; `stand` runs until cancelled unless given minutes. */
function makeRegistry() {
  const runs = { tick: 0, stand: 0, standAborted: 0, task: 0 };
  const tick: SkillDefinition = { name: 'tick', summary: 'tick', args: z.object({}), check: () => ({ ok: true }), run: async () => (runs.tick++, { status: 'done', message: 'ticked', evidence: [] }) };
  const task: SkillDefinition = {
    name: 'task',
    summary: 'task',
    args: z.object({ ms: z.number().default(50) }),
    check: () => ({ ok: true }),
    run: async (_ctx, a) => {
      await sleep(a.ms);
      runs.task++;
      return { status: 'done', message: 'task done', evidence: [] };
    },
  };
  const stand: SkillDefinition = {
    name: 'stand',
    summary: 'stand',
    args: z.object({ minutes: z.number().optional() }),
    untilStopped: (raw) => raw.minutes === undefined,
    check: () => ({ ok: true }),
    run: async (ctx) => {
      runs.stand++;
      while (!ctx.signal.aborted) await sleep(10);
      runs.standAborted++;
      return { status: 'done', message: 'stood until stopped', evidence: [] };
    },
  };
  return { registry: buildRegistry([tick, task, stand]), runs };
}

function fakeBot() {
  const bot: any = new EventEmitter();
  bot.username = 'dragonai';
  bot.said = [] as string[];
  bot.chat = (line: string) => bot.said.push(line);
  bot.inventory = { slots: new Array(46).fill(null), selectedItem: null, items: () => [] };
  bot.currentWindow = null;
  bot.entity = { position: new Vec3(0, 64, 0) };
  bot.health = 20;
  bot.game = { dimension: 'overworld' };
  bot.time = { timeOfDay: 1000, day: 3 };
  return bot;
}

const result = (outcome: BrainResult['outcome'], extra: Partial<BrainResult> = {}): BrainResult => ({ outcome, message: outcome, calls: 1, inputTokens: 0, outputTokens: 0, llmMs: 0, steps: [], notes: '', ...extra });

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(10);
  }
}

describe('standing orders in the decision', () => {
  const { registry } = makeRegistry();
  const items = new Set(['oak_log']);
  it('accepts a periodic or nightly order, or one whose step runs until stopped', () => {
    const a = parseDecision('{"steps":[{"skill":"tick"}],"standing":{"every_minutes":2}}', registry, items);
    expect(a.ok && a.decision.standing?.every_minutes).toBe(2);
    expect(parseDecision('{"steps":[{"skill":"tick"}],"standing":{"when":"night"}}', registry, items).ok).toBe(true);
    const c = parseDecision('{"steps":[{"skill":"stand"}],"standing":{}}', registry, items);
    expect(c.ok).toBe(true);
    if (c.ok) expect(planRunsUntilStopped(c.plan!, registry)).toBe(true);
  });
  it('rejects an order with no way to repeat, both triggers, or no steps', () => {
    expect(parseDecision('{"steps":[{"skill":"tick"}],"standing":{}}', registry, items).ok).toBe(false);
    expect(parseDecision('{"steps":[{"skill":"stand","args":{"minutes":1}}],"standing":{}}', registry, items).ok).toBe(false);
    expect(parseDecision('{"steps":[{"skill":"tick"}],"standing":{"every_minutes":1,"when":"night"}}', registry, items).ok).toBe(false);
    expect(parseDecision('{"answer":"hi","standing":{"every_minutes":1}}', registry, items).ok).toBe(false);
    expect(parseDecision('{"steps":[{"skill":"tick"}],"standing":{"every_minutes":0}}', registry, items).ok).toBe(false);
  });
});

describe('chat parsing for orders', () => {
  it('knows the order controls', () => {
    expect(parseControl('cancel orders')).toBe('cancel_orders');
    expect(parseControl('stop all standing orders')).toBe('cancel_orders');
    expect(parseControl('orders?')).toBe('orders');
    expect(parseControl('what are your orders')).toBe('orders');
    expect(parseControl('stop')).toBe('stop');
    expect(parseControl('stop all')).toBe('stop_all');
  });
  it('matches a targeted stop to the order it names, and leaves other text alone', () => {
    const plan = (skill: string): StepPlan => ({ steps: [{ skill, args: {} }], notes: '' });
    const orders = [
      { id: 1, text: 'always guard me', plan: plan('guard') },
      { id: 2, text: 'keep the furnace fuelled', plan: plan('use_station') },
    ];
    expect(matchTargetedStop('stop guarding me', orders)).toEqual([1]);
    expect(matchTargetedStop('no more fuelling the furnace', orders)).toEqual([2]);
    expect(matchTargetedStop('stop following me', orders)).toBeNull();
    expect(matchTargetedStop('get me 3 logs', orders)).toBeNull();
    expect(matchTargetedStop('stop it', orders)).toBeNull();
  });
  it('tells nights and days apart, once per period', () => {
    expect(periodKey('night', 13000, 4)).toBe('night 4');
    expect(periodKey('night', 23000, 4)).toBe('night 4');
    expect(periodKey('night', 6000, 4)).toBeNull();
    expect(periodKey('day', 1000, 5)).toBe('day 5');
    expect(periodKey('day', 13000, 5)).toBeNull();
  });
});

describe('the companion keeps standing orders', () => {
  it('asks the LLM once, then repeats the plan by code, and a new task goes first', async () => {
    const { registry, runs } = makeRegistry();
    const bot = fakeBot();
    const calls: string[] = [];
    const brain = async (o: BrainOptions): Promise<BrainResult> => {
      calls.push(o.task);
      if (o.task === 'always stand by me') return result('standing', { standing: { plan: { steps: [{ skill: 'stand', args: {} }], notes: '' }, untilStopped: true } });
      // An ordinary task: run its plan for real so it takes time.
      const { runPlan } = await import('../src/skills/contract.js');
      await runPlan({ steps: [{ skill: 'task', args: { ms: 80 } }] }, o.registry, { bot: o.bot, signal: o.signal, log: () => undefined });
      return result('done');
    };
    const c = new Companion({ bot, owners: ['Owner'], registry, llm: {} as any, log: () => undefined, brain });
    c.start();
    bot.emit('chat', 'Owner', 'always stand by me');
    await until(() => runs.stand === 1);
    expect(c.activeOrders).toHaveLength(1);
    expect(bot.said.some((s: string) => /Standing order: always stand by me/.test(s))).toBe(true);

    // A task from the owner sets the order aside, runs, and the order picks up again by itself.
    bot.emit('chat', 'Owner', 'do a task');
    await until(() => runs.task === 1 && runs.stand === 2);
    expect(runs.standAborted).toBe(1);
    expect(calls).toEqual(['always stand by me', 'do a task']);

    // "stop" while the order runs ends the order.
    bot.emit('chat', 'Owner', 'stop');
    await until(() => runs.standAborted === 2);
    expect(c.activeOrders).toHaveLength(0);
    await sleep(100);
    expect(runs.stand).toBe(2);
    await c.shutdown();
  });

  it('runs a periodic order again after its period, and a targeted stop cancels it', async () => {
    const { registry, runs } = makeRegistry();
    const bot = fakeBot();
    let calls = 0;
    const brain = async (): Promise<BrainResult> => {
      calls++;
      return result('standing', { standing: { plan: { steps: [{ skill: 'tick', args: {} }], notes: '' }, everyMinutes: 0.5, untilStopped: false } });
    };
    const c = new Companion({ bot, owners: ['Owner'], registry, llm: {} as any, log: () => undefined, brain });
    c.start();
    bot.emit('chat', 'Owner', 'keep ticking');
    await until(() => runs.tick === 1);
    const order = c.activeOrders[0];
    expect(order.runs).toBe(1);
    // Pretend the period passed.
    order.nextAt = Date.now();
    c['wake']?.();
    await until(() => runs.tick === 2, 3000);
    expect(calls).toBe(1);
    bot.emit('chat', 'Owner', 'stop ticking');
    expect(c.activeOrders).toHaveLength(0);
    await c.shutdown();
  });

  it('a nightly order runs once per night', async () => {
    const { registry, runs } = makeRegistry();
    const bot = fakeBot();
    bot.time = { timeOfDay: 6000, day: 3 };
    const brain = async (): Promise<BrainResult> => result('standing', { standing: { plan: { steps: [{ skill: 'tick', args: {} }], notes: '' }, when: 'night', untilStopped: false } });
    const c = new Companion({ bot, owners: ['Owner'], registry, llm: {} as any, log: () => undefined, brain });
    c.start();
    bot.emit('chat', 'Owner', 'every night tick');
    await until(() => c.activeOrders.length === 1);
    await sleep(150);
    expect(runs.tick).toBe(0);
    bot.time = { timeOfDay: 13000, day: 3 };
    c.activeOrders[0].nextAt = 0;
    c['wake']?.();
    await until(() => runs.tick === 1);
    c.activeOrders[0].nextAt = 0;
    c['wake']?.();
    await sleep(200);
    expect(runs.tick).toBe(1);
    bot.time = { timeOfDay: 13000, day: 4 };
    c.activeOrders[0].nextAt = 0;
    c['wake']?.();
    await until(() => runs.tick === 2);
    await c.shutdown();
  });

  it('sets an order aside after repeated failures and says so', async () => {
    const fail: SkillDefinition = { name: 'tick', summary: 'tick', args: z.object({}), check: () => ({ ok: true }), run: async () => ({ status: 'failed', cause: 'blocked', message: 'no furnace', evidence: [] }) };
    const registry = buildRegistry([fail]);
    const bot = fakeBot();
    let calls = 0;
    const brain = async (o: BrainOptions): Promise<BrainResult> => {
      calls++;
      return result('standing', { standing: { plan: { steps: [{ skill: 'tick', args: {} }], notes: '' }, everyMinutes: 1, untilStopped: false } });
    };
    const c = new Companion({ bot, owners: ['Owner'], registry, llm: {} as any, log: () => undefined, brain });
    c.start();
    bot.emit('chat', 'Owner', 'keep the furnace fuelled');
    for (let i = 0; i < 6 && c.orders[0]?.status !== 'suspended'; i++) {
      await until(() => c.orders.length === 1);
      c.orders[0].nextAt = 0;
      c['wake']?.();
      await sleep(80);
    }
    await until(() => c.orders[0].status === 'suspended');
    expect(bot.said.some((s: string) => /failed 3 times in a row/.test(s))).toBe(true);
    // One call to set it up, then one repair call after each of the first two failures.
    expect(calls).toBe(3);
    await c.shutdown();
  });
});

describe('the companion gets food by itself', () => {
  it('starts a food errand when hungry with nothing to eat, and a task from the owner sets it aside', async () => {
    const { registry } = makeRegistry();
    const bot = fakeBot();
    bot.food = 5;
    bot.registry = { foodsByName: { bread: {}, rotten_flesh: {} } };
    bot.inventory.items = () => [{ name: 'rotten_flesh', count: 3 }];
    const tasks: string[] = [];
    const brain = async (o: BrainOptions): Promise<BrainResult> => {
      tasks.push(o.task);
      if (o.task.startsWith('Eat until your food bar')) {
        while (!o.signal.aborted) await sleep(10);
        return result('cancelled');
      }
      return result('done');
    };
    const c = new Companion({ bot, owners: ['Owner'], registry, llm: {} as any, log: () => undefined, brain });
    c.start();
    await until(() => tasks.length === 1);
    expect(bot.said.some((s: string) => /I'm hungry \(food 5\/20\)/.test(s))).toBe(true);
    bot.emit('chat', 'Owner', 'come here');
    await until(() => tasks.length === 2);
    expect(tasks[1]).toBe('come here');
    expect(bot.said.some((s: string) => /setting aside: getting food/.test(s))).toBe(true);
    // Not tried again straight away.
    await sleep(150);
    expect(tasks).toHaveLength(2);
    await c.shutdown();
  });

  it('does not run the errand while food is held', async () => {
    const { registry } = makeRegistry();
    const bot = fakeBot();
    bot.food = 5;
    bot.registry = { foodsByName: { bread: {} } };
    bot.inventory.items = () => [{ name: 'bread', count: 1 }];
    let calls = 0;
    const c = new Companion({ bot, owners: ['Owner'], registry, llm: {} as any, log: () => undefined, brain: async () => (calls++, result('done')) });
    c.start();
    await sleep(150);
    expect(calls).toBe(0);
    await c.shutdown();
  });
});

describe('world events in task files', () => {
  it('accepts timed commands and rejects bad ones', () => {
    expect(validateEvents(undefined)).toEqual([]);
    expect(validateEvents([{ at: 20, command: 'kill dragonai' }])).toEqual([{ at: 20, command: 'kill dragonai' }]);
    expect(() => validateEvents([{ at: -1, command: 'x' }])).toThrow();
    expect(() => validateEvents([{ at: 5, command: '/kill dragonai' }])).toThrow();
    expect(() => validateEvents([{ at: 5, command: 'x', extra: 1 }])).toThrow();
    expect(() => validateEvents({ at: 5 })).toThrow();
  });
});
