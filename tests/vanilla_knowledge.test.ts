import { describe, expect, it } from 'vitest';
import { getItemRegistry, getLootTables, getMeta, getRecipes, getTags, resolveTag } from '../src/knowledge/vanilla.js';

describe('vanilla game knowledge', () => {
  it('meta counts match the loaded files', () => {
    const meta = getMeta();
    expect(meta.game_version).toBe('1.21.6');
    expect(Object.keys(getRecipes()).length).toBe(meta.counts.recipes);
    expect(Object.keys(getLootTables()).length).toBe(meta.counts.loot_tables);
    expect(Object.keys(getTags()).length).toBe(meta.counts.tags);
    expect(Object.keys(getItemRegistry()).length).toBe(meta.counts.items);
    expect(meta.counts.recipes).toBe(1407);
    expect(meta.counts.loot_tables).toBe(1246);
  });

  it('resolves item tags', () => {
    const planks = resolveTag('item', 'planks');
    expect(planks).toContain('minecraft:oak_planks');
    expect(planks).toContain('minecraft:warped_planks');
  });

  it('expands nested tags, with and without namespace', () => {
    const tags = getTags();
    expect(tags['item/logs'].values.some((v) => typeof v === 'string' && v.startsWith('#'))).toBe(true);
    const logs = resolveTag('item', 'logs');
    expect(logs).toContain('minecraft:oak_log');
    expect(logs).toContain('minecraft:crimson_stem');
    expect(logs.some((id) => id.startsWith('#'))).toBe(false);
    expect(resolveTag('item', 'minecraft:logs')).toEqual(logs);
    expect(resolveTag('block', 'mineable/pickaxe')).toContain('minecraft:stone');
    expect(resolveTag('item', 'no_such_tag')).toEqual([]);
  });

  it('has the stick recipe using the planks tag', () => {
    const stick = getRecipes()['stick'];
    expect(stick).toBeDefined();
    expect(JSON.stringify(stick)).toContain('#minecraft:planks');
    expect(stick.result.id).toBe('minecraft:stick');
  });

  it('has the oak_log block loot table', () => {
    expect(getLootTables()['blocks/oak_log']).toBeDefined();
  });
});
