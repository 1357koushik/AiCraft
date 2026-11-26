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
