import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { extractJson, parseDecision } from '../src/brain/decision.js';
import { buildRegistry } from '../src/skills/registry.js';
import type { SkillDefinition } from '../src/skills/contract.js';

// A tiny catalogue: only the argument schemas matter to the parser.
const fake = (name: string, args: z.ZodTypeAny): SkillDefinition => ({ name, summary: name, args, check: () => ({ ok: true }), run: async () => ({ status: 'done', message: '', evidence: [] }) });
const registry = buildRegistry([
  fake('craft', z.object({ item: z.string(), count: z.number().int().min(1).default(1) })),
  fake('mine', z.object({ block: z.string(), count: z.number().int().min(1) })),
]);
const items = new Set(['stone_pickaxe', 'oak_log', 'cobblestone']);

describe('extractJson', () => {
  it('finds the object inside prose and code fences', () => {
    expect(extractJson('Sure!\n```json\n{"a": {"b": "}"}}\n```\nDone')).toEqual({ a: { b: '}' } });
    expect(extractJson('reply: {"x": 1} trailing')).toEqual({ x: 1 });
  });
  it('throws on no object or an unterminated one', () => {
    expect(() => extractJson('no json here')).toThrow();
    expect(() => extractJson('{"a": 1')).toThrow();
  });
});

describe('parseDecision', () => {
  it('accepts a valid step plan with done_when', () => {
    const r = parseDecision(JSON.stringify({ notes: 'wood first', steps: [{ skill: 'mine', args: { block: 'stone', count: 3 } }], done_when: { inventory: { stone_pickaxe: '>=1' } } }), registry, items);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan?.steps).toHaveLength(1);
      expect(r.decision.done_when?.inventory?.stone_pickaxe).toBe('>=1');
    }
  });
  it('applies argument defaults through the skill schema', () => {
    const r = parseDecision('{"steps":[{"skill":"craft","args":{"item":"stick"}}]}', registry, items);
    expect(r.ok).toBe(true);
  });
  it('rejects unknown skills and bad arguments, naming the step', () => {
    const a = parseDecision('{"steps":[{"skill":"fly","args":{}}]}', registry, items);
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.error).toMatch(/steps\.0.*unknown skill "fly"/);
    const b = parseDecision('{"steps":[{"skill":"mine","args":{"block":"stone","count":0}}]}', registry, items);
    expect(b.ok).toBe(false);
  });
  it('requires exactly one of steps, ask_owner or give_up', () => {
    expect(parseDecision('{"notes":"x"}', registry, items).ok).toBe(false);
    expect(parseDecision('{"ask_owner":"which one?","give_up":"no"}', registry, items).ok).toBe(false);
    const ask = parseDecision('{"ask_owner":"which chest?"}', registry, items);
    expect(ask.ok && ask.plan === null).toBe(true);
  });
  it('rejects a done_when naming an item that does not exist, and unknown fields', () => {
    expect(parseDecision('{"steps":[{"skill":"craft","args":{"item":"x"}}],"done_when":{"inventory":{"unobtainium":">=1"}}}', registry, items).ok).toBe(false);
    expect(parseDecision('{"steps":[{"skill":"craft","args":{"item":"x"}}],"code":"bot.chat()"}', registry, items).ok).toBe(false);
  });
  it('rejects more than 12 steps', () => {
    const steps = Array.from({ length: 13 }, () => ({ skill: 'craft', args: { item: 'stick' } }));
    expect(parseDecision(JSON.stringify({ steps }), registry, items).ok).toBe(false);
  });
});

describe('step normalisation', () => {
  it('folds arguments written next to "skill" into args', () => {
    const r = parseDecision('{"steps":[{"skill":"mine","block":"stone","count":3},{"skill":"craft","args":{"item":"stick"},"count":4}]}', registry, items);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan?.steps[0].args).toEqual({ block: 'stone', count: 3 });
      expect(r.plan?.steps[1].args).toEqual({ item: 'stick', count: 4 });
    }
  });
});

describe('lenient shapes the models send', () => {
  it('turns a list of {name, count} into a map', () => {
    const reg = buildRegistry([fake('store', z.object({ x: z.number(), y: z.number(), z: z.number(), items: z.record(z.number()) }))]);
    const r = parseDecision('{"steps":[{"skill":"store","args":{"x":1,"y":2,"z":3,"items":[{"name":"minecraft:cobblestone","count":10}]}}]}', reg, items);
    expect(r.ok && r.plan?.steps[0].args.items).toEqual({ cobblestone: 10 });
  });
  it('accepts numbers in done_when inventory: 0 means none, n means at least n', () => {
    const r = parseDecision('{"steps":[{"skill":"craft","args":{"item":"x"}}],"done_when":{"inventory":{"cobblestone":0,"oak_log":4}}}', registry, items);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.decision.done_when?.inventory).toEqual({ cobblestone: '==0', oak_log: '>=4' });
  });
});

describe('done_when on vitals and the clock', () => {
  it('accepts food_at_least and time_of_day, and isDone reads them from the bot', async () => {
    const { isDone } = await import('../src/brain/loop.js');
    const r = parseDecision('{"steps":[{"skill":"craft","args":{"item":"x"}}],"done_when":{"time_of_day":"<2000"}}', registry, items);
    expect(r.ok).toBe(true);
    expect(parseDecision('{"steps":[{"skill":"craft","args":{"item":"x"}}],"done_when":{"time_of_day":"soon"}}', registry, items).ok).toBe(false);
    expect(parseDecision('{"steps":[{"skill":"craft","args":{"item":"x"}}],"done_when":{"food_at_least":21}}', registry, items).ok).toBe(false);
    const bot: any = { time: { timeOfDay: 13000 }, food: 5 };
    expect(isDone(bot, { time_of_day: '<2000' } as any)).toBe(false);
    bot.time.timeOfDay = 80;
    expect(isDone(bot, { time_of_day: '<2000' } as any)).toBe(true);
    expect(isDone(bot, { food_at_least: 14 } as any)).toBe(false);
    bot.food = 18;
    expect(isDone(bot, { food_at_least: 14 } as any)).toBe(true);
  });
});
