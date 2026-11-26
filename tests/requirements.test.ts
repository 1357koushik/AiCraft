import { describe, expect, it } from 'vitest';
import { craftableNow, missingFor, waysToGet } from '../src/brain/requirements.js';
import type { Need } from '../src/brain/requirements.js';

type Way = Need['how'][number];
const kinds = (item: string) => waysToGet(item).map((w) => w.kind);
const find = <K extends Way['kind']>(item: string, kind: K) => waysToGet(item).find((w) => w.kind === kind) as Extract<Way, { kind: K }> | undefined;
const need = (m: ReturnType<typeof missingFor>, item: string) => m.needs.find((n) => n.item === item);

describe('requirements from real game data', () => {
  it('stone_pickaxe from nothing needs cobblestone, sticks and a crafting table', () => {
    const m = missingFor('stone_pickaxe', 1, {});
    expect(m.ready).toBe(false);
    expect(m.stationNeeded).toBe('crafting_table');
    expect(need(m, 'cobblestone')).toMatchObject({ count: 3, have: 0 });
    expect(need(m, 'stick')).toMatchObject({ count: 2, have: 0 });
    expect(need(m, 'crafting_table')).toMatchObject({ count: 1, have: 0 });
    // cobblestone is mined from stone, with the weakest pickaxe
    const mine = need(m, 'cobblestone')!.how.find((h) => h.kind === 'mine') as Extract<Way, { kind: 'mine' }>;
    expect(mine.blocks).toContain('stone');
    expect(mine.tool).toBe('pickaxe');
    expect(mine.minTool).toBe('wooden_pickaxe');
    // sticks come from planks
    expect(need(m, 'stick')!.how[0]).toMatchObject({ kind: 'craft', station: 'inventory', makes: 4 });
    expect(m.lines.join(' ')).toMatch(/3 cobblestone/);
    expect(m.lines.join(' ').length).toBeLessThan(700);
  });

  it('stone_pickaxe with 4 oak_planks: sticks are craftable from held planks, but not the table as well', () => {
    const m = missingFor('stone_pickaxe', 1, { oak_planks: 4 });
    expect(m.ready).toBe(false);
    expect(m.stationNeeded).toBe('crafting_table');
    expect(need(m, 'cobblestone')!.have).toBe(0);
    const sticks = m.lines.find((l) => l.includes('stick'))!;
    expect(sticks).toContain('2 stick');
    expect(sticks).toContain('have 4');
    expect(m.lines.length).toBe(3);
  });

  it('stone_pickaxe is ready when everything including the table is held', () => {
    const m = missingFor('stone_pickaxe', 1, { cobblestone: 3, stick: 2, crafting_table: 1 });
    expect(m.ready).toBe(true);
    expect(m.stationNeeded).toBeUndefined();
  });

  it('wooden_pickaxe with 3 birch_planks and 2 sticks counts the tag but needs a table', () => {
    const m = missingFor('wooden_pickaxe', 1, { birch_planks: 3, stick: 2 });
    expect(m.stationNeeded).toBe('crafting_table');
    expect(m.ready).toBe(false); // the 3 planks are spent, so a table cannot also be made
    expect(need(m, 'birch_planks')).toMatchObject({ count: 3, have: 3 });
    expect(need(m, 'stick')).toMatchObject({ count: 2, have: 2 });
    // no input line is missing; only the table is
    expect(m.lines.some((l) => l.includes('stick'))).toBe(false);
    expect(m.lines.some((l) => l.includes('crafting table'))).toBe(true);
  });

  it('wooden_pickaxe is ready when the table can still be made from spare planks', () => {
    const m = missingFor('wooden_pickaxe', 1, { birch_planks: 7, stick: 2 });
    expect(m.stationNeeded).toBe('crafting_table');
    expect(m.ready).toBe(true);
  });

  it('iron_ingot is smelted from raw_iron, and raw_iron is mined from iron ore with a stone pickaxe', () => {
    const smelt = waysToGet('iron_ingot').filter((w) => w.kind === 'smelt') as Extract<Way, { kind: 'smelt' }>[];
    expect(smelt.some((w) => w.input === 'raw_iron' && w.station === 'furnace' && w.cookTicks === 200)).toBe(true);
    expect(smelt.some((w) => w.input === 'raw_iron' && w.station === 'blast_furnace' && w.cookTicks === 100)).toBe(true);
    // smelting is ranked ahead of the compacting recipes (blocks, nuggets)
    const order = waysToGet('iron_ingot');
    expect(order.findIndex((w) => w.kind === 'smelt')).toBeLessThan(order.findIndex((w) => w.kind === 'craft'));

    const mine = find('raw_iron', 'mine')!;
    expect(mine.blocks).toEqual(expect.arrayContaining(['iron_ore', 'deepslate_iron_ore']));
    expect(mine.tool).toBe('pickaxe');
    expect(mine.minTool).toBe('stone_pickaxe');

    const m = missingFor('iron_ingot', 1, { furnace: 1, coal: 1 });
    expect(m.ready).toBe(false);
    expect(need(m, 'raw_iron')).toMatchObject({ count: 1, have: 0 });
    expect(m.stationNeeded).toBeUndefined();
    expect(missingFor('iron_ingot', 2, { raw_iron: 2, furnace: 1, coal: 1 }).ready).toBe(true);
    expect(missingFor('iron_ingot', 2, { raw_iron: 2, furnace: 1 }).ready).toBe(false); // no fuel
  });

  it('raw_iron reports whether a good enough pickaxe is held', () => {
    expect(missingFor('raw_iron', 1, { wooden_pickaxe: 1 }).ready).toBe(false);
    expect(missingFor('raw_iron', 1, { stone_pickaxe: 1 }).ready).toBe(true);
    expect(missingFor('raw_iron', 1, { diamond_pickaxe: 1 }).ready).toBe(true);
  });

  it('bread is crafted from three wheat', () => {
    const craft = find('bread', 'craft')!;
    expect(craft.inputs).toEqual([{ item: 'wheat', count: 3 }]);
    expect(missingFor('bread', 1, { wheat: 3, crafting_table: 1 }).ready).toBe(true);
    const lack = missingFor('bread', 1, { wheat: 1, crafting_table: 1 });
    expect(need(lack, 'wheat')).toMatchObject({ count: 3, have: 1 });
    expect(lack.lines[0]).toContain('2 wheat');
  });

  it('cooked_beef is smelted, smoked or campfire-cooked from beef, and beef drops from cows', () => {
    const smelt = waysToGet('cooked_beef').filter((w) => w.kind === 'smelt') as Extract<Way, { kind: 'smelt' }>[];
    expect(smelt.map((w) => w.station).sort()).toEqual(['campfire', 'furnace', 'smoker']);
    expect(smelt.every((w) => w.input === 'beef')).toBe(true);
    expect(smelt.find((w) => w.station === 'furnace')!.cookTicks).toBe(200);
    expect(smelt.find((w) => w.station === 'smoker')!.cookTicks).toBe(100);
    expect(smelt.find((w) => w.station === 'campfire')!.cookTicks).toBe(600);
    expect(find('beef', 'drop')!.entities).toContain('cow');
    // holding a smoker or a campfire instead of a furnace picks that station
    expect(missingFor('cooked_beef', 1, { beef: 1, smoker: 1, coal: 1 }).ready).toBe(true);
    expect(missingFor('cooked_beef', 1, { beef: 1, campfire: 1 }).ready).toBe(true);
    expect(missingFor('cooked_beef', 1, { beef: 1 }).stationNeeded).toBe('furnace');
  });

  it('ender_eye needs ender_pearl and blaze_powder; pearls drop from endermen and come from piglin bartering', () => {
    const craft = find('ender_eye', 'craft')!;
    expect(craft.inputs.map((i) => i.item).sort()).toEqual(['blaze_powder', 'ender_pearl']);
    expect(craft.station).toBe('inventory');
    expect(find('ender_pearl', 'drop')!.entities).toContain('enderman');
    expect(find('ender_pearl', 'loot')!.tables).toContain('gameplay/piglin_bartering');
    expect(kinds('ender_pearl')).not.toContain('craft');
    const m = missingFor('ender_eye', 1, { ender_pearl: 1 });
    expect(m.ready).toBe(false);
    expect(need(m, 'blaze_powder')).toMatchObject({ count: 1, have: 0 });
    expect(missingFor('ender_eye', 1, { ender_pearl: 1, blaze_powder: 1 }).ready).toBe(true);
  });

  it('torch takes coal or charcoal plus a stick', () => {
    const craft = find('torch', 'craft')!;
    const fuel = craft.inputs.find((i) => i.options)!;
    expect(fuel.options).toEqual(expect.arrayContaining(['coal', 'charcoal']));
    expect(craft.inputs.some((i) => i.item === 'stick')).toBe(true);
    expect(missingFor('torch', 1, { charcoal: 1, stick: 1 }).ready).toBe(true);
    expect(missingFor('torch', 1, { charcoal: 1 }).ready).toBe(false);
    // charcoal itself is smelted from logs
    expect((find('charcoal', 'smelt') as any).options).toContain('oak_log');
  });

  it('diamond is mined with an iron pickaxe or better, ahead of crafting it from its block', () => {
    const mine = find('diamond', 'mine')!;
    expect(mine.minTool).toBe('iron_pickaxe');
    expect(kinds('diamond').indexOf('mine')).toBeLessThan(kinds('diamond').indexOf('craft'));
  });

  it('craftableNow with 4 oak_logs makes planks', () => {
    const list = craftableNow({ oak_log: 4 });
    expect(list.find((e) => e.item === 'oak_planks')).toMatchObject({ times: 4, makes: 4 });
    expect(list.find((e) => e.item === 'crafting_table')).toBeUndefined();
  });

  it('craftableNow with planks, sticks and a table lists the basics first', () => {
    const list = craftableNow({ oak_planks: 12, stick: 4 }, { hasTable: true });
    const names = list.map((e) => e.item);
    expect(names).toEqual(expect.arrayContaining(['crafting_table', 'stick', 'wooden_pickaxe', 'wooden_axe', 'wooden_sword', 'wooden_shovel', 'wooden_hoe', 'chest']));
    expect(list.length).toBeLessThanOrEqual(40);
    expect(list.find((e) => e.item === 'stick')).toMatchObject({ times: 6, makes: 4 });
    expect(list.find((e) => e.item === 'wooden_pickaxe')!.times).toBe(2); // 3 planks + 2 sticks each: sticks allow 2
    // without a table only 2x2 recipes appear
    const noTable = craftableNow({ oak_planks: 12, stick: 4 }).map((e) => e.item);
    expect(noTable).toContain('crafting_table');
    expect(noTable).not.toContain('wooden_pickaxe');
  });

  it('craftableNow puts inputs of the goal first', () => {
    const list = craftableNow({ oak_planks: 12 }, { hasTable: true, goal: 'wooden_pickaxe' });
    expect(list.slice(0, 3).map((e) => e.item)).toEqual(expect.arrayContaining(['stick', 'crafting_table']));
  });

  it('unknown items have no ways', () => {
    expect(waysToGet('not_an_item')).toEqual([]);
    expect(missingFor('not_an_item', 1, {}).ready).toBe(false);
  });
});
