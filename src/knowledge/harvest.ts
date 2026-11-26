/**
 * Pure (bot-free) knowledge about breaking blocks and what loot tables yield, shared by the `mine` skill and
 * the requirements calculator. Extracted from src/skills/mine.ts without changing behaviour:
 * tool type comes from block/mineable/<tool> tags, weak materials from block/incorrect_for_<material>_tool tags,
 * drops from the loot table (ignoring silk touch), and "needs a tool at all" from minecraft-data's harvestTools.
 */
import minecraftData from 'minecraft-data';
import { VANILLA_VERSION, getLootTables, resolveTag } from './vanilla.js';

export const stripNamespace = (s: string) => s.replace(/^minecraft:/, '');

export const TOOL_TYPES = ['pickaxe', 'axe', 'shovel', 'hoe'] as const;
export type ToolType = (typeof TOOL_TYPES)[number];
/** Weakest first. The tag names use "wooden" and "gold"; the item names use "wooden" and "golden". */
export const MATERIALS = [
  { item: 'wooden', tag: 'wooden' },
  { item: 'golden', tag: 'gold' },
  { item: 'stone', tag: 'stone' },
  { item: 'iron', tag: 'iron' },
  { item: 'diamond', tag: 'diamond' },
  { item: 'netherite', tag: 'netherite' },
] as const;
/** Order to suggest a tool in a "fix": by tier, skipping gold (same tier as wood but not a natural first tool). */
export const SUGGEST_ORDER = ['wooden', 'stone', 'iron', 'diamond', 'netherite'];

export interface ToolPlan {
  /** Tool type that mines this block fastest, or null when the block has no tool tag (dirt-like by hand, e.g. glass). */
  type: ToolType | null;
  /** True when the block drops nothing without a correct tool and tier. */
  requiresTool: boolean;
  /** Item names that work, weakest tier first. Empty when requiresTool is false and any tool is fine. */
  workingTools: string[];
  /** Item names the block drops without silk touch. */
  drops: string[];
}

let tagSets: Map<string, Set<string>> | null = null;
export function blockTagSet(tag: string): Set<string> {
  if (!tagSets) tagSets = new Map();
  let s = tagSets.get(tag);
  if (!s) {
    s = new Set(resolveTag('block', tag).map(stripNamespace));
    tagSets.set(tag, s);
  }
  return s;
}

const needsSilk = (conditions: any[] | undefined) => (conditions ?? []).some((c) => JSON.stringify(c).includes('silk_touch'));

/**
 * Item names a loot table can yield, ignoring entries that need silk touch. `table` is a key like "blocks/stone".
 * With followRefs, entries that reference another loot table (fishing, sheep wool, chests) are expanded too.
 */
export function lootTableItems(table: string, opts: { followRefs?: boolean } = {}): string[] {
  const tables = getLootTables();
  const out = new Set<string>();
  const seen = new Set<string>();
  const walk = (entry: any, silk: boolean) => {
    const s = silk || needsSilk(entry.conditions);
    if (entry.type === 'minecraft:item' && entry.name && !s) out.add(stripNamespace(entry.name));
    if (opts.followRefs && entry.type === 'minecraft:loot_table' && !s) {
      if (typeof entry.value === 'string') visit(stripNamespace(entry.value));
      else if (entry.value && typeof entry.value === 'object') visitTable(entry.value);
    }
    for (const child of entry.children ?? []) walk(child, s);
  };
  const visitTable = (t: any) => {
    for (const pool of t?.pools ?? []) {
      const poolSilk = needsSilk(pool.conditions);
      for (const entry of pool.entries ?? []) walk(entry, poolSilk);
    }
  };
  const visit = (key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    visitTable((tables as any)[key]);
  };
  visit(table);
  return [...out];
}

/** Collects the item names a block's loot table can yield when mined without silk touch. */
export function lootDrops(blockName: string): string[] {
  return lootTableItems(`blocks/${blockName}`);
}

/** Does minecraft-data say this block drops nothing without a suitable tool? (bot-free equivalent of registry harvestTools) */
let mcData: ReturnType<typeof minecraftData> | null = null;
export function blockRequiresTool(blockName: string): boolean {
  if (!mcData) mcData = minecraftData(VANILLA_VERSION);
  return Boolean((mcData as any).blocksByName[blockName]?.harvestTools);
}

export function toolPlanFor(blockName: string, requiresTool: boolean): ToolPlan {
  const type = TOOL_TYPES.find((t) => blockTagSet(`mineable/${t}`).has(blockName)) ?? null;
  const workingTools: string[] = [];
  if (type) {
    for (const m of MATERIALS) {
      if (!blockTagSet(`incorrect_for_${m.tag}_tool`).has(blockName)) workingTools.push(`${m.item}_${type}`);
    }
  }
  return { type, requiresTool, workingTools, drops: lootDrops(blockName) };
}

export function minimumTool(plan: ToolPlan): string | null {
  for (const m of SUGGEST_ORDER) {
    const t = plan.workingTools.find((w) => w.startsWith(`${m}_`));
    if (t) return t;
  }
  return plan.workingTools[0] ?? null;
}
