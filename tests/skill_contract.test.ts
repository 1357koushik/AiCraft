import { describe, it, expect, vi } from 'vitest';
import { Vec3 } from 'vec3';
import { z } from 'zod';
import {
  countInventory,
  diffCounts,
  totalCounts,
  runSkill,
  validatePlan,
  runPlan,
  ProgressWatchdog,
  type SkillDefinition,
  type SkillContext,
  type SkillOutcome,
  type SkillRegistry,
  type Precondition,
} from '../src/skills/contract.js';

// Pure-logic tests: the "bot" is a plain object, there is no game behind it.

type FakeItem = { name: string; count: number } | null;

interface FakeBot {
  inventory: { slots: FakeItem[]; selectedItem: FakeItem };
  currentWindow: any;
  entity: { position: Vec3 };
}

function makeBot(pos = new Vec3(0, 64, 0)): FakeBot {
  return {
    inventory: { slots: new Array(46).fill(null), selectedItem: null },
    currentWindow: null,
    entity: { position: pos },
  };
}

function makeCtx(bot: FakeBot, signal: AbortSignal = new AbortController().signal) {
  const log = vi.fn<(line: string) => void>();
  const ctx = { bot: bot as any, signal, log } as SkillContext;
  return { ctx, log };
}

const item = (name: string, count: number): FakeItem => ({ name, count });

function makeSkill(
  name: string,
  opts: {
    args?: z.ZodType<any>;
    check?: (...a: any[]) => Precondition | Promise<Precondition>;
    run?: (ctx: SkillContext, args: any) => Promise<SkillOutcome>;
  } = {},
) {
  const check = vi.fn(opts.check ?? (() => ({ ok: true }) as Precondition));
  const run = vi.fn(opts.run ?? (async () => ({ status: 'done', message: 'ok', evidence: [] }) as SkillOutcome));
  const def: SkillDefinition = {
    name,
    summary: `${name} summary`,
    args: opts.args ?? z.object({}).passthrough(),
    check: check as any,
    run: run as any,
  };
  return { def, check, run };
}

const doneOutcome = (extra: Partial<SkillOutcome> = {}): SkillOutcome => ({ status: 'done', message: 'ok', evidence: [], ...extra });

describe('countInventory', () => {
  it('counts slots 0-4 as parked and 5-45 as held', () => {
    const bot = makeBot();
    bot.inventory.slots[0] = item('crafting_result', 1);
    bot.inventory.slots[1] = item('oak_planks', 2);
    bot.inventory.slots[4] = item('oak_planks', 3);
    bot.inventory.slots[5] = item('iron_helmet', 1);
    bot.inventory.slots[9] = item('cobblestone', 10);
    bot.inventory.slots[9 + 1] = item('cobblestone', 5);
    bot.inventory.slots[45] = item('shield', 1);
    const c = countInventory(bot as any);
    expect(c.parked).toEqual({ crafting_result: 1, oak_planks: 5 });
    expect(c.held).toEqual({ iron_helmet: 1, cobblestone: 15, shield: 1 });
  });

  it('counts the cursor item as parked', () => {
    const bot = makeBot();
    bot.inventory.selectedItem = item('dirt', 7);
    const c = countInventory(bot as any);
    expect(c.parked).toEqual({ dirt: 7 });
    expect(c.held).toEqual({});
  });

  it('returns empty maps for an empty inventory', () => {
    expect(countInventory(makeBot() as any)).toEqual({ held: {}, parked: {} });
  });

  it('tolerates a bot without inventory slots', () => {
    expect(countInventory({ inventory: undefined, currentWindow: null } as any)).toEqual({ held: {}, parked: {} });
  });

  it('adds the grid of an open crafting-table window (slots 0-9) to parked', () => {
    const bot = makeBot();
    const win = { type: 'minecraft:crafting', slots: new Array(46).fill(null) as FakeItem[], selectedItem: null };
    win.slots[0] = item('stick', 4); // result
    win.slots[1] = item('oak_planks', 1);
    win.slots[9] = item('oak_planks', 1);
    win.slots[10] = item('cobblestone', 64); // window's copy of the player inventory: must not be counted
    bot.currentWindow = win;
    const c = countInventory(bot as any);
    expect(c.parked).toEqual({ stick: 4, oak_planks: 2 });
    expect(c.held).toEqual({});
  });

  it('does not double count a non-crafting window such as a chest', () => {
    const bot = makeBot();
    bot.inventory.slots[20] = item('cobblestone', 8);
    const chest = { type: 'minecraft:generic_9x3', slots: new Array(63).fill(null) as FakeItem[], selectedItem: null };
    chest.slots[0] = item('diamond', 3); // chest content, not the bot's
    chest.slots[5] = item('gold_ingot', 2);
    chest.slots[27] = item('cobblestone', 8); // mirror of the bot's own slot
    bot.currentWindow = chest;
    const c = countInventory(bot as any);
    expect(c.held).toEqual({ cobblestone: 8 });
    expect(c.parked).toEqual({});
  });

  it('counts the cursor of a non-crafting window as parked', () => {
    const bot = makeBot();
    bot.currentWindow = { type: 'minecraft:generic_9x3', slots: [], selectedItem: item('diamond', 2) };
    expect(countInventory(bot as any).parked).toEqual({ diamond: 2 });
  });

  it('ignores the window when it is the player inventory itself', () => {
    const bot = makeBot();
    bot.inventory.slots[1] = item('oak_planks', 2);
    bot.currentWindow = bot.inventory;
    expect(countInventory(bot as any).parked).toEqual({ oak_planks: 2 });
  });
});

describe('diffCounts and totalCounts', () => {
  it('reports gains and losses and omits unchanged and zero entries', () => {
    const delta = diffCounts({ a: 5, b: 3, c: 2, gone: 4 }, { a: 8, b: 1, c: 2, fresh: 6 });
    expect(delta).toEqual({ a: 3, b: -2, gone: -4, fresh: 6 });
    expect('c' in delta).toBe(false);
  });

  it('returns an empty delta for identical maps', () => {
    expect(diffCounts({ a: 1 }, { a: 1 })).toEqual({});
    expect(diffCounts({}, {})).toEqual({});
  });

  it('does not mutate its inputs', () => {
    const before = { a: 1 };
    const after = { a: 2 };
    diffCounts(before, after);
    expect(before).toEqual({ a: 1 });
    expect(after).toEqual({ a: 2 });
  });

  it('totalCounts sums held and parked per item', () => {
    const held = { a: 2, b: 1 };
    const parked = { a: 3, c: 4 };
    expect(totalCounts({ held, parked })).toEqual({ a: 5, b: 1, c: 4 });
    expect(held).toEqual({ a: 2, b: 1 }); // not mutated
  });

  it('totalCounts of an empty inventory is empty', () => {
    expect(totalCounts({ held: {}, parked: {} })).toEqual({});
  });
});

describe('runSkill', () => {
  it('fails with invalid_args when the schema rejects, without running', async () => {
    const { def, check, run } = makeSkill('craft', { args: z.object({ item: z.string(), count: z.number().int().positive() }) });
    const { ctx } = makeCtx(makeBot());
    const r = await runSkill(def, ctx, { item: 'stick', count: -1 });
    expect(r.status).toBe('failed');
    expect(r.cause).toBe('invalid_args');
    expect(r.message).toContain('craft');
    expect(r.message).toContain('count');
    expect(r.inventoryDelta).toEqual({});
    expect(check).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('treats undefined/null raw args as an empty object', async () => {
    const { def, run } = makeSkill('noargs', { args: z.object({}) });
    const { ctx } = makeCtx(makeBot());
    expect((await runSkill(def, ctx, undefined)).status).toBe('done');
    expect((await runSkill(def, ctx, null)).status).toBe('done');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('passes the parsed (defaulted) args to check and run', async () => {
    const { def, check, run } = makeSkill('d', { args: z.object({ n: z.number().default(3) }) });
    const { ctx } = makeCtx(makeBot());
    await runSkill(def, ctx, {});
    expect(check.mock.calls[0][1]).toEqual({ n: 3 });
    expect(run.mock.calls[0][1]).toEqual({ n: 3 });
  });

  it('returns interrupted when the signal is already aborted, without check or run', async () => {
    const ac = new AbortController();
    ac.abort();
    const { def, check, run } = makeSkill('s');
    const { ctx } = makeCtx(makeBot(), ac.signal);
    const r = await runSkill(def, ctx, {});
    expect(r.status).toBe('interrupted');
    expect(r.cause).toBe('interrupted');
    expect(check).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('validates args before looking at the signal', async () => {
    const ac = new AbortController();
    ac.abort();
    const { def } = makeSkill('s', { args: z.object({ x: z.number() }) });
    const { ctx } = makeCtx(makeBot(), ac.signal);
    expect((await runSkill(def, ctx, {})).cause).toBe('invalid_args');
  });

  it('turns a failed precondition into a failed result with its cause, message and fix', async () => {
    const { def, run } = makeSkill('mine', {
      check: () => ({ ok: false, cause: 'missing_tool', message: 'no pickaxe', fix: 'craft a wooden pickaxe' }),
    });
    const { ctx } = makeCtx(makeBot());
    const r = await runSkill(def, ctx, {});
    expect(r.status).toBe('failed');
    expect(r.cause).toBe('missing_tool');
    expect(r.message).toBe('no pickaxe');
    expect(r.fix).toBe('craft a wooden pickaxe');
    expect(run).not.toHaveBeenCalled();
  });

  it('omits fix when the precondition gave none', async () => {
    const { def } = makeSkill('mine', { check: () => ({ ok: false, cause: 'blocked', message: 'in the way' }) });
    const { ctx } = makeCtx(makeBot());
    const r = await runSkill(def, ctx, {});
    expect(r.cause).toBe('blocked');
    expect('fix' in r).toBe(false);
  });

  it('supports an async check', async () => {
    const { def, run } = makeSkill('a', { check: async () => ({ ok: false, cause: 'missing_item', message: 'none' }) });
    const { ctx } = makeCtx(makeBot());
    expect((await runSkill(def, ctx, {})).cause).toBe('missing_item');
    expect(run).not.toHaveBeenCalled();
  });

  it('maps a throwing check() to cause unknown and does not run', async () => {
    const { def, run } = makeSkill('c', {
      check: () => {
        throw new Error('boom');
      },
    });
    const { ctx } = makeCtx(makeBot());
    const r = await runSkill(def, ctx, {});
    expect(r.status).toBe('failed');
    expect(r.cause).toBe('unknown');
    expect(r.message).toContain('boom');
    expect(run).not.toHaveBeenCalled();
  });

  it('maps a rejecting async check() to cause unknown', async () => {
    const { def } = makeSkill('c', { check: async () => Promise.reject(new Error('async boom')) });
    const { ctx } = makeCtx(makeBot());
    const r = await runSkill(def, ctx, {});
    expect(r.cause).toBe('unknown');
    expect(r.message).toContain('async boom');
  });

  it('maps a throwing run() to failed/unknown', async () => {
    const { def } = makeSkill('r', {
      run: async () => {
        throw new Error('exploded');
      },
    });
    const { ctx } = makeCtx(makeBot());
    const r = await runSkill(def, ctx, {});
    expect(r.status).toBe('failed');
    expect(r.cause).toBe('unknown');
    expect(r.message).toContain('exploded');
    expect(r.evidence).toEqual([]);
  });

  it('maps a throwing run() to interrupted when the signal was aborted meanwhile', async () => {
    const ac = new AbortController();
    const { def } = makeSkill('r', {
      run: async () => {
        ac.abort();
        throw new Error('aborted mid-way');
      },
    });
    const { ctx } = makeCtx(makeBot(), ac.signal);
    const r = await runSkill(def, ctx, {});
    expect(r.status).toBe('interrupted');
    expect(r.cause).toBe('interrupted');
    expect(r.message).toContain('aborted mid-way');
  });

  it('still measures inventory change when run() throws', async () => {
    const bot = makeBot();
    const { def } = makeSkill('r', {
      run: async (ctx) => {
        (ctx.bot as any).inventory.slots[10] = item('dirt', 2);
        throw new Error('late failure');
      },
    });
    const { ctx } = makeCtx(bot);
    const r = await runSkill(def, ctx, {});
    expect(r.status).toBe('failed');
    expect(r.inventoryDelta).toEqual({ dirt: 2 });
  });

  it('returns a done result with message and evidence passed through', async () => {
    const { def } = makeSkill('ok', { run: async () => doneOutcome({ message: 'did it', evidence: ['x 0 -> 1'] }) });
    const { ctx } = makeCtx(makeBot());
    const r = await runSkill(def, ctx, {});
    expect(r.status).toBe('done');
    expect(r.cause).toBeUndefined();
    expect(r.message).toBe('did it');
    expect(r.evidence).toEqual(['x 0 -> 1']);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('does not alias the skill outcome evidence array', async () => {
    const ev = ['a'];
    const { def } = makeSkill('ok', { run: async () => doneOutcome({ evidence: ev }) });
    const { ctx } = makeCtx(makeBot());
    const r = await runSkill(def, ctx, {});
    r.evidence.push('b');
    expect(ev).toEqual(['a']);
  });

  it('measures inventoryDelta from the bot, overriding the skill claim', async () => {
    const bot = makeBot();
    bot.inventory.slots[9] = item('oak_planks', 10);
    const { def } = makeSkill('claimer', {
      run: async (ctx) => {
        (ctx.bot as any).inventory.slots[9] = item('oak_planks', 14); // really +4
        return doneOutcome({ inventoryDelta: { oak_planks: 5, diamond: 64 } });
      },
    });
    const { ctx } = makeCtx(bot);
    const r = await runSkill(def, ctx, {});
    expect(r.inventoryDelta).toEqual({ oak_planks: 4 });
  });

  it('reports losses as negative deltas and omits unchanged items', async () => {
    const bot = makeBot();
    bot.inventory.slots[9] = item('oak_planks', 4);
    bot.inventory.slots[10] = item('cobblestone', 9);
    const { def } = makeSkill('use', {
      run: async (ctx) => {
        (ctx.bot as any).inventory.slots[9] = null;
        (ctx.bot as any).inventory.slots[11] = item('stick', 4);
        return doneOutcome();
      },
    });
    const { ctx } = makeCtx(bot);
    const r = await runSkill(def, ctx, {});
    expect(r.inventoryDelta).toEqual({ oak_planks: -4, stick: 4 });
  });

  it('reports an empty delta when the skill claims items but nothing changed', async () => {
    const { def } = makeSkill('liar', { run: async () => doneOutcome({ inventoryDelta: { diamond: 3 } }) });
    const { ctx } = makeCtx(makeBot());
    expect((await runSkill(def, ctx, {})).inventoryDelta).toEqual({});
  });

  it.each(['failed', 'partial', 'interrupted'] as const)('gives status %s with no cause the cause unknown', async (status) => {
    const { def } = makeSkill('nc', { run: async () => ({ status, message: 'm', evidence: [] }) });
    const { ctx } = makeCtx(makeBot());
    const r = await runSkill(def, ctx, {});
    expect(r.status).toBe(status);
    expect(r.cause).toBe('unknown');
  });

  it('keeps a cause the skill supplied', async () => {
    const { def } = makeSkill('wc', { run: async () => ({ status: 'failed', cause: 'unreachable', message: 'm', evidence: [] }) });
    const { ctx } = makeCtx(makeBot());
    expect((await runSkill(def, ctx, {})).cause).toBe('unreachable');
  });

  it('does not add a cause to a clean done result', async () => {
    const { def } = makeSkill('d');
    const { ctx } = makeCtx(makeBot());
    expect((await runSkill(def, ctx, {})).cause).toBeUndefined();
  });

  describe('items stranded in grid or on cursor', () => {
    it('turns done into partial/server_rejected with an evidence line (grid)', async () => {
      const bot = makeBot();
      const { def } = makeSkill('sloppy', {
        run: async (ctx) => {
          (ctx.bot as any).inventory.slots[2] = item('oak_planks', 3);
          return doneOutcome({ message: 'crafted' });
        },
      });
      const { ctx } = makeCtx(bot);
      const r = await runSkill(def, ctx, {});
      expect(r.status).toBe('partial');
      expect(r.cause).toBe('server_rejected');
      expect(r.message).toContain('crafted');
      expect(r.message).toContain('crafting grid or on the cursor');
      expect(r.evidence.some((e) => e.includes('oak_planks x3'))).toBe(true);
    });

    it('catches items left on the cursor', async () => {
      const bot = makeBot();
      const { def } = makeSkill('sloppy', {
        run: async (ctx) => {
          (ctx.bot as any).inventory.selectedItem = item('dirt', 1);
          return doneOutcome();
        },
      });
      const { ctx } = makeCtx(bot);
      const r = await runSkill(def, ctx, {});
      expect(r.status).toBe('partial');
      expect(r.cause).toBe('server_rejected');
      expect(r.evidence.join('\n')).toContain('dirt x1');
    });

    it('catches items left in an open crafting window grid', async () => {
      const bot = makeBot();
      const win = { type: 'minecraft:crafting', slots: new Array(46).fill(null) as FakeItem[], selectedItem: null };
      bot.currentWindow = win;
      const { def } = makeSkill('sloppy', {
        run: async () => {
          win.slots[5] = item('cobblestone', 2);
          return doneOutcome();
        },
      });
      const { ctx } = makeCtx(bot);
      const r = await runSkill(def, ctx, {});
      expect(r.status).toBe('partial');
      expect(r.evidence.join('\n')).toContain('cobblestone x2');
    });

    it('lists every stranded item in the evidence line', async () => {
      const bot = makeBot();
      const { def } = makeSkill('sloppy', {
        run: async (ctx) => {
          (ctx.bot as any).inventory.slots[1] = item('oak_planks', 2);
          (ctx.bot as any).inventory.selectedItem = item('stick', 1);
          return doneOutcome();
        },
      });
      const { ctx } = makeCtx(bot);
      const r = await runSkill(def, ctx, {});
      const line = r.evidence.find((e) => e.startsWith('left in crafting grid'))!;
      expect(line).toContain('oak_planks x2');
      expect(line).toContain('stick x1');
    });

    it('does not count items that were already parked before the skill ran', async () => {
      const bot = makeBot();
      bot.inventory.slots[1] = item('oak_planks', 3);
      bot.inventory.selectedItem = item('dirt', 1);
      const { def } = makeSkill('clean', { run: async () => doneOutcome() });
      const { ctx } = makeCtx(bot);
      const r = await runSkill(def, ctx, {});
      expect(r.status).toBe('done');
      expect(r.cause).toBeUndefined();
      expect(r.evidence).toEqual([]);
    });

    it('only flags the growth when parked items existed before', async () => {
      const bot = makeBot();
      bot.inventory.slots[1] = item('oak_planks', 3);
      const { def } = makeSkill('grow', {
        run: async (ctx) => {
          (ctx.bot as any).inventory.slots[1] = item('oak_planks', 5);
          return doneOutcome();
        },
      });
      const { ctx } = makeCtx(bot);
      const r = await runSkill(def, ctx, {});
      expect(r.status).toBe('partial');
      expect(r.evidence.join('\n')).toContain('oak_planks x2');
    });

    it('does not flag a skill that cleared parked items', async () => {
      const bot = makeBot();
      bot.inventory.slots[1] = item('oak_planks', 3);
      const { def } = makeSkill('tidy', {
        run: async (ctx) => {
          (ctx.bot as any).inventory.slots[1] = null;
          (ctx.bot as any).inventory.slots[12] = item('oak_planks', 3);
          return doneOutcome();
        },
      });
      const { ctx } = makeCtx(bot);
      const r = await runSkill(def, ctx, {});
      expect(r.status).toBe('done');
      expect(r.inventoryDelta).toEqual({ oak_planks: 3 });
    });

    it('adds the evidence but keeps the status when the skill already failed', async () => {
      const bot = makeBot();
      const { def } = makeSkill('failing', {
        run: async (ctx) => {
          (ctx.bot as any).inventory.slots[3] = item('stick', 2);
          return { status: 'failed', cause: 'blocked', message: 'nope', evidence: [] } as SkillOutcome;
        },
      });
      const { ctx } = makeCtx(bot);
      const r = await runSkill(def, ctx, {});
      expect(r.status).toBe('failed');
      expect(r.cause).toBe('blocked');
      expect(r.evidence.join('\n')).toContain('stick x2');
    });

    it('does not report parked items as lost or gained in inventoryDelta', async () => {
      // 4 planks move from held into the grid: held loses them, and the stranded evidence explains where they went.
      const bot = makeBot();
      bot.inventory.slots[9] = item('oak_planks', 4);
      const { def } = makeSkill('move', {
        run: async (ctx) => {
          (ctx.bot as any).inventory.slots[9] = null;
          (ctx.bot as any).inventory.slots[1] = item('oak_planks', 4);
          return doneOutcome();
        },
      });
      const { ctx } = makeCtx(bot);
      const r = await runSkill(def, ctx, {});
      expect(r.inventoryDelta).toEqual({ oak_planks: -4 });
      expect(r.status).toBe('partial');
    });
  });

  describe('distanceMoved', () => {
    it('is the straight-line distance between start and end position', async () => {
      const bot = makeBot(new Vec3(0, 64, 0));
      const { def } = makeSkill('walk', {
        run: async (ctx) => {
          // Wander off first; only the end points count.
          (ctx.bot as any).entity.position = new Vec3(100, 64, 100);
          (ctx.bot as any).entity.position = new Vec3(3, 64, 4);
          return doneOutcome();
        },
      });
      const { ctx } = makeCtx(bot);
      const r = await runSkill(def, ctx, {});
      expect(r.distanceMoved).toBe(5);
    });

    it('is 0 when the bot did not move', async () => {
      const { def } = makeSkill('still');
      const { ctx } = makeCtx(makeBot());
      expect((await runSkill(def, ctx, {})).distanceMoved).toBe(0);
    });

    it('works when the skill moves the position vector in place', async () => {
      const bot = makeBot(new Vec3(1, 2, 3));
      const { def } = makeSkill('mutate', {
        run: async (ctx) => {
          (ctx.bot as any).entity.position.x += 6;
          (ctx.bot as any).entity.position.y += 8;
          return doneOutcome();
        },
      });
      const { ctx } = makeCtx(bot);
      expect((await runSkill(def, ctx, {})).distanceMoved).toBe(10); // start was cloned
    });

    it('rounds to two decimals', async () => {
      const bot = makeBot(new Vec3(0, 0, 0));
      const { def } = makeSkill('step', {
        run: async (ctx) => {
          (ctx.bot as any).entity.position = new Vec3(1, 1, 1);
          return doneOutcome();
        },
      });
      const { ctx } = makeCtx(bot);
      expect((await runSkill(def, ctx, {})).distanceMoved).toBe(1.73);
    });

    it('is absent when the bot has no position', async () => {
      const bot: any = makeBot();
      bot.entity = undefined;
      const { def } = makeSkill('nopos');
      const { ctx } = makeCtx(bot);
      expect('distanceMoved' in (await runSkill(def, ctx, {}))).toBe(false);
    });

    it('is also reported for a failed run', async () => {
      const bot = makeBot(new Vec3(0, 0, 0));
      const { def } = makeSkill('walkfail', {
        run: async (ctx) => {
          (ctx.bot as any).entity.position = new Vec3(0, 0, 7);
          throw new Error('tripped');
        },
      });
      const { ctx } = makeCtx(bot);
      const r = await runSkill(def, ctx, {});
      expect(r.status).toBe('failed');
      expect(r.distanceMoved).toBe(7);
    });
  });
});

describe('validatePlan', () => {
  const registry = (): SkillRegistry => {
    const reg: SkillRegistry = new Map();
    reg.set('craft', makeSkill('craft', { args: z.object({ item: z.string(), count: z.number().int().positive().default(1) }) }).def);
    reg.set('wait', makeSkill('wait').def);
    return reg;
  };

  it('accepts a valid plan and returns the parsed data with defaults applied', () => {
    const v = validatePlan({ notes: 'n', steps: [{ skill: 'craft', args: { item: 'stick' } }, { skill: 'wait' }] }, registry());
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.plan.notes).toBe('n');
    expect(v.plan.steps).toHaveLength(2);
    expect(v.plan.steps[1].args).toEqual({}); // default applied by StepSchema
  });

  it('keeps done_when opaque', () => {
    const v = validatePlan({ steps: [{ skill: 'wait' }], done_when: { have: { stick: 4 } } }, registry());
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.plan.done_when).toEqual({ have: { stick: 4 } });
  });

  it('rejects an unknown skill and names the step index', () => {
    const v = validatePlan({ steps: [{ skill: 'wait' }, { skill: 'teleport' }] }, registry());
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.errors).toHaveLength(1);
    expect(v.errors[0]).toContain('steps.1');
    expect(v.errors[0]).toContain('unknown skill "teleport"');
  });

  it('rejects bad args for a known skill and names the step index and skill', () => {
    const v = validatePlan({ steps: [{ skill: 'wait' }, { skill: 'wait' }, { skill: 'craft', args: { item: 5 } }] }, registry());
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.errors.some((e) => e.includes('steps.2') && e.includes('craft') && e.includes('item'))).toBe(true);
  });

  it('collects errors from several steps', () => {
    const v = validatePlan({ steps: [{ skill: 'nope' }, { skill: 'craft', args: {} }, { skill: 'wait' }] }, registry());
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.errors.some((e) => e.includes('steps.0'))).toBe(true);
    expect(v.errors.some((e) => e.includes('steps.1'))).toBe(true);
    expect(v.errors.some((e) => e.includes('steps.2'))).toBe(false);
  });

  it('rejects an empty steps array', () => {
    const v = validatePlan({ steps: [] }, registry());
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.errors[0]).toContain('steps');
  });

  it('rejects more than 40 steps but accepts exactly 40', () => {
    const steps = (n: number) => Array.from({ length: n }, () => ({ skill: 'wait' }));
    expect(validatePlan({ steps: steps(40) }, registry()).ok).toBe(true);
    const v = validatePlan({ steps: steps(41) }, registry());
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors[0]).toContain('steps');
  });

  it('rejects structurally wrong plans', () => {
    for (const raw of [null, undefined, 'plan', 42, {}, { steps: 'x' }, { steps: [{}] }, { steps: [{ skill: '' }] }]) {
      expect(validatePlan(raw, registry()).ok).toBe(false);
    }
  });
});

describe('runPlan', () => {
  function setup(skills: ReturnType<typeof makeSkill>[]) {
    const reg: SkillRegistry = new Map();
    for (const s of skills) reg.set(s.def.name, s.def);
    return reg;
  }

  it('completes all steps and records each result in order', async () => {
    const a = makeSkill('a');
    const b = makeSkill('b');
    const { ctx } = makeCtx(makeBot());
    const r = await runPlan({ steps: [{ skill: 'a' }, { skill: 'b', args: { x: 1 } }, { skill: 'a' }] }, setup([a, b]), ctx);
    expect(r.outcome).toBe('completed');
    expect(r.stoppedAt).toBeUndefined();
    expect(r.steps.map((s) => s.index)).toEqual([0, 1, 2]);
    expect(r.steps.map((s) => s.step.skill)).toEqual(['a', 'b', 'a']);
    expect(r.steps.every((s) => s.result.status === 'done')).toBe(true);
    expect(r.message).toContain('3');
    expect(a.run).toHaveBeenCalledTimes(2);
    expect(b.run).toHaveBeenCalledTimes(1);
    expect(b.run.mock.calls[0][1]).toEqual({ x: 1 });
  });

  it('stops at the first step that is not done and does not run later steps', async () => {
    const ok = makeSkill('ok');
    const bad = makeSkill('bad', { run: async () => ({ status: 'failed', cause: 'blocked', message: 'stuck here', evidence: [] }) });
    const later = makeSkill('later');
    const { ctx } = makeCtx(makeBot());
    const r = await runPlan({ steps: [{ skill: 'ok' }, { skill: 'bad' }, { skill: 'later' }] }, setup([ok, bad, later]), ctx);
    expect(r.outcome).toBe('stopped');
    expect(r.stoppedAt).toBe(1);
    expect(r.steps).toHaveLength(2);
    expect(r.steps[1].result.cause).toBe('blocked');
    expect(r.message).toContain('step 2');
    expect(r.message).toContain('bad');
    expect(r.message).toContain('stuck here');
    expect(later.check).not.toHaveBeenCalled();
    expect(later.run).not.toHaveBeenCalled();
  });

  it.each(['partial', 'interrupted'] as const)('also stops on a %s step', async (status) => {
    const mid = makeSkill('mid', { run: async () => ({ status, message: 'm', evidence: [] }) });
    const last = makeSkill('last');
    const { ctx } = makeCtx(makeBot());
    const r = await runPlan({ steps: [{ skill: 'mid' }, { skill: 'last' }] }, setup([mid, last]), ctx);
    expect(r.outcome).toBe('stopped');
    expect(r.stoppedAt).toBe(0);
    expect(last.run).not.toHaveBeenCalled();
  });

  it('stops when a step precondition fails at the time the step is reached', async () => {
    let haveTool = true;
    const first = makeSkill('first', {
      run: async () => {
        haveTool = false; // the first step makes the second one's precondition false
        return doneOutcome();
      },
    });
    const second = makeSkill('second', {
      check: () => (haveTool ? { ok: true } : { ok: false, cause: 'missing_tool', message: 'tool gone', fix: 'craft one' }),
    });
    const { ctx } = makeCtx(makeBot());
    const r = await runPlan({ steps: [{ skill: 'first' }, { skill: 'second' }] }, setup([first, second]), ctx);
    expect(r.outcome).toBe('stopped');
    expect(r.stoppedAt).toBe(1);
    expect(r.steps[1].result.cause).toBe('missing_tool');
    expect(r.steps[1].result.fix).toBe('craft one');
    expect(second.run).not.toHaveBeenCalled();
  });

  it('returns invalid without running anything for a bad plan', async () => {
    const a = makeSkill('a');
    const { ctx, log } = makeCtx(makeBot());
    const r = await runPlan({ steps: [{ skill: 'a' }, { skill: 'missing' }] }, setup([a]), ctx);
    expect(r.outcome).toBe('invalid');
    expect(r.steps).toEqual([]);
    expect(r.stoppedAt).toBeUndefined();
    expect(r.message).toContain('steps.1');
    expect(a.check).not.toHaveBeenCalled();
    expect(a.run).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('returns invalid for a non-plan value', async () => {
    const { ctx } = makeCtx(makeBot());
    const r = await runPlan('rm -rf', new Map(), ctx);
    expect(r.outcome).toBe('invalid');
  });

  it('stops before the next step when the signal is aborted between steps', async () => {
    const ac = new AbortController();
    const first = makeSkill('first', {
      run: async () => {
        ac.abort(); // cancelled while the first step finishes normally
        return doneOutcome();
      },
    });
    const second = makeSkill('second');
    const { ctx } = makeCtx(makeBot(), ac.signal);
    const r = await runPlan({ steps: [{ skill: 'first' }, { skill: 'second' }] }, setup([first, second]), ctx);
    expect(r.outcome).toBe('stopped');
    expect(r.stoppedAt).toBe(1);
    expect(r.steps).toHaveLength(1);
    expect(r.message).toContain('cancelled');
    expect(r.message).toContain('step 2');
    expect(second.check).not.toHaveBeenCalled();
    expect(second.run).not.toHaveBeenCalled();
  });

  it('stops at step 0 without running when the signal is aborted from the start', async () => {
    const ac = new AbortController();
    ac.abort();
    const a = makeSkill('a');
    const { ctx } = makeCtx(makeBot(), ac.signal);
    const r = await runPlan({ steps: [{ skill: 'a' }] }, setup([a]), ctx);
    expect(r.outcome).toBe('stopped');
    expect(r.stoppedAt).toBe(0);
    expect(r.steps).toEqual([]);
    expect(a.run).not.toHaveBeenCalled();
  });

  it('logs each step start and result through ctx.log', async () => {
    const ok = makeSkill('ok', { run: async () => doneOutcome({ message: 'fine' }) });
    const bad = makeSkill('bad', { run: async () => ({ status: 'failed', cause: 'unreachable', message: 'no path', evidence: [] }) });
    const { ctx, log } = makeCtx(makeBot());
    await runPlan({ steps: [{ skill: 'ok', args: { n: 2 } }, { skill: 'bad' }] }, setup([ok, bad]), ctx);
    const lines = log.mock.calls.map((c) => c[0]);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('step 1/2');
    expect(lines[0]).toContain('ok');
    expect(lines[0]).toContain('{"n":2}');
    expect(lines[1]).toContain('step 1 -> done');
    expect(lines[1]).toContain('fine');
    expect(lines[2]).toContain('step 2/2');
    expect(lines[3]).toContain('step 2 -> failed (unreachable)');
    expect(lines[3]).toContain('no path');
  });

  it('feeds the parsed default args from the plan to the skill', async () => {
    const a = makeSkill('a', { args: z.object({ n: z.number().default(7) }) });
    const { ctx } = makeCtx(makeBot());
    await runPlan({ steps: [{ skill: 'a' }] }, setup([a]), ctx);
    expect(a.run.mock.calls[0][1]).toEqual({ n: 7 });
  });
});

describe('ProgressWatchdog', () => {
  function clock(start = 1000) {
    let t = start;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  }

  it('is not stuck right after creation', () => {
    const c = clock();
    const w = new ProgressWatchdog(500, 10, true, c.now);
    expect(w.stuck).toBe(false);
    expect(w.stalledForMs).toBe(0);
  });

  it('becomes stuck only once the window has been exceeded', () => {
    const c = clock();
    const w = new ProgressWatchdog(500, 10, true, c.now);
    c.advance(500);
    expect(w.stuck).toBe(false); // exactly the window is not yet stuck
    c.advance(1);
    expect(w.stuck).toBe(true);
    expect(w.stalledForMs).toBe(501);
  });

  it('improvement resets the timer and report returns true', () => {
    const c = clock();
    const w = new ProgressWatchdog(500, 10, true, c.now);
    c.advance(400);
    expect(w.report(8)).toBe(true);
    expect(w.stalledForMs).toBe(0);
    c.advance(400);
    expect(w.stuck).toBe(false);
    c.advance(101);
    expect(w.stuck).toBe(true);
  });

  it('no improvement does not reset the timer (same or worse values)', () => {
    const c = clock();
    const w = new ProgressWatchdog(500, 10, true, c.now);
    c.advance(300);
    expect(w.report(10)).toBe(false); // equal
    expect(w.report(12)).toBe(false); // worse
    c.advance(300);
    expect(w.stuck).toBe(true);
    expect(w.stalledForMs).toBe(600);
  });

  it('compares against the best so far, not the last value', () => {
    const c = clock();
    const w = new ProgressWatchdog(500, 10, true, c.now);
    expect(w.report(4)).toBe(true);
    expect(w.report(7)).toBe(false); // worse than 4 even though better than the start
    expect(w.report(4)).toBe(false);
    expect(w.report(3)).toBe(true);
  });

  it('touch() counts as progress', () => {
    const c = clock();
    const w = new ProgressWatchdog(500, 10, true, c.now);
    c.advance(450);
    w.touch();
    c.advance(450);
    expect(w.stuck).toBe(false);
    expect(w.stalledForMs).toBe(450);
    c.advance(100);
    expect(w.stuck).toBe(true);
  });

  it('touch() does not change the best value', () => {
    const c = clock();
    const w = new ProgressWatchdog(500, 10, true, c.now);
    w.touch();
    expect(w.report(10)).toBe(false);
    expect(w.report(9)).toBe(true);
  });

  it('lowerIsBetter=false treats increases as improvement', () => {
    const c = clock();
    const w = new ProgressWatchdog(500, 2, false, c.now);
    c.advance(400);
    expect(w.report(1)).toBe(false); // lower is worse here
    expect(w.report(2)).toBe(false); // equal
    expect(w.report(3)).toBe(true);
    expect(w.stalledForMs).toBe(0);
    c.advance(501);
    expect(w.stuck).toBe(true);
    expect(w.report(2)).toBe(false); // best is 3
    expect(w.report(4)).toBe(true);
    expect(w.stuck).toBe(false);
  });

  it('defaults to lowerIsBetter and Date.now', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(10_000);
      const w = new ProgressWatchdog(100, 5);
      expect(w.report(4)).toBe(true);
      vi.setSystemTime(10_050);
      expect(w.stuck).toBe(false);
      vi.setSystemTime(10_101);
      expect(w.stuck).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
