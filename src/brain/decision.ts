import { z } from 'zod';
import { StepSchema, SkillRegistry, validatePlan, StepPlan } from '../skills/contract.js';

/**
 * What the LLM sends back at each decision point (ROADMAP.md section 4): a short list of steps, or a
 * question for the owner, or giving up, plus its own running notes for the task. Data only, never code.
 */

const Coord = z.number().finite();
export const DoneWhenSchema = z
  .object({
    /** Item counts the bot must hold, e.g. { "stone_pickaxe": ">=1" }. */
    // A bare number is accepted: 0 means "exactly none", any other number means "at least that many".
    inventory: z
      .record(z.union([z.string().regex(/^(>=|<=|==|=|>|<)?\s*\d+$/), z.number().int().min(0).transform((n) => (n === 0 ? '==0' : `>=${n}`))]))
      .optional(),
    /** Blocks that must be at these spots ("air" for a cleared spot). */
    blocks: z.array(z.object({ x: Coord, y: Coord, z: Coord, block: z.string().min(1) }).strict()).max(256).optional(),
    /** The bot must be within `range` blocks of this point. */
    near: z.object({ x: Coord, y: Coord, z: Coord, range: z.number().positive().max(64).default(2) }).strict().optional(),
  })
  .strict()
  .refine((d) => Boolean(d.inventory && Object.keys(d.inventory).length) || Boolean(d.blocks?.length) || Boolean(d.near), {
    message: 'done_when needs at least one of inventory, blocks or near',
  });
export type DoneWhen = z.infer<typeof DoneWhenSchema>;

export const DecisionSchema = z
  .object({
    notes: z.string().max(1200).default(''),
    steps: z.array(StepSchema).max(12).default([]),
    done_when: DoneWhenSchema.optional(),
    ask_owner: z.string().max(300).optional(),
    /** The reply to a question that needs no action ("how do I make a piston?", "how many logs do you have?"). */
    answer: z.string().max(1200).optional(),
    give_up: z.string().max(300).optional(),
  })
  .strict();
export type Decision = z.infer<typeof DecisionSchema>;

export type ParsedDecision =
  | { ok: true; decision: Decision; plan: StepPlan | null }
  | { ok: false; error: string };

/** Pulls the first JSON object out of a model reply (models sometimes wrap it in prose or code fences). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  if (start < 0) throw new Error('no JSON object in the reply');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return JSON.parse(body.slice(start, i + 1));
  }
  throw new Error('unterminated JSON object in the reply');
}

/**
 * Models often write a step's arguments next to "skill" instead of inside "args"
 * ({"skill":"craft","item":"stick","count":4}). Fold such keys into args; nothing is invented, and the
 * skill's own schema still validates them.
 */
function normalizeSteps(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as any).steps)) return raw;
  const steps = (raw as any).steps.map((step: any) => {
    if (!step || typeof step !== 'object' || typeof step.skill !== 'string') return step;
    const { skill, args, ...rest } = step;
    const merged: Record<string, unknown> = { ...(args && typeof args === 'object' ? args : {}), ...rest };
    // A list of {name, count} pairs where a {name: count} map is meant: same information, other shape.
    for (const [k, v] of Object.entries(merged)) {
      if (Array.isArray(v) && v.length && v.every((e) => e && typeof e === 'object' && typeof e.name === 'string' && typeof e.count === 'number')) {
        merged[k] = Object.fromEntries(v.map((e: any) => [e.name.replace(/^minecraft:/, ''), e.count]));
      }
    }
    return { skill, args: merged };
  });
  return { ...(raw as any), steps };
}

/** Parses and validates a reply against the schema and the skill catalogue. */
export function parseDecision(text: string, registry: SkillRegistry, knownItems: Set<string>): ParsedDecision {
  let raw: unknown;
  try {
    raw = extractJson(text);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  const parsed = DecisionSchema.safeParse(normalizeSteps(raw));
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.') || 'reply'}: ${i.message}`).join('; ') };
  const d = parsed.data;
  const choices = [d.steps.length > 0, Boolean(d.ask_owner), Boolean(d.give_up), Boolean(d.answer)].filter(Boolean).length;
  if (choices !== 1) return { ok: false, error: 'send exactly one of: a non-empty "steps" list, "answer", "ask_owner", or "give_up"' };
  for (const item of Object.keys(d.done_when?.inventory ?? {})) {
    if (!knownItems.has(item.replace(/^minecraft:/, ''))) return { ok: false, error: `done_when names an unknown item "${item}"` };
  }
  if (!d.steps.length) return { ok: true, decision: d, plan: null };
  const v = validatePlan({ steps: d.steps, notes: d.notes }, registry);
  if (!v.ok) return { ok: false, error: v.errors.join('; ') };
  return { ok: true, decision: d, plan: v.plan };
}
