/**
 * Authoritative game knowledge exported from the real server jar by scripts/export_game_data.ts.
 * Files live in data/vanilla/<version>/ and are loaded lazily on first use.
 */
import fs from 'fs';
import path from 'path';

export const VANILLA_VERSION = '1.21.6';

// Resolved from this file (not from AICRAFT_DATA_DIR), because this data is committed to the repo.
const VANILLA_DIR = path.resolve(__dirname, '..', '..', 'data', 'vanilla', VANILLA_VERSION);

export interface VanillaMeta {
  game_version: string;
  data_version: number | null;
  protocol_version: number | null;
  data_pack_version: number | null;
  server_jar_sha256: string;
  exported_at: string;
  java_major_version: number;
  blocks_trimmed: boolean;
  counts: Record<string, number>;
}

/** Raw recipe json as written by the game (type, ingredients, result, ...). */
export type RecipeJson = { type: string; [key: string]: any };
export type LootTableJson = { type?: string; pools?: any[]; [key: string]: any };
export type TagEntry = string | { id: string; required?: boolean };
export type TagJson = { replace?: boolean; values: TagEntry[] };

const cache = new Map<string, unknown>();

function load<T>(file: string): T {
  let value = cache.get(file) as T | undefined;
  if (value === undefined) {
    const full = path.join(VANILLA_DIR, file);
    if (!fs.existsSync(full)) {
      throw new Error(`Vanilla data file missing: ${full}. Run "npx tsx scripts/export_game_data.ts".`);
    }
    value = JSON.parse(fs.readFileSync(full, 'utf8')) as T;
    cache.set(file, value);
  }
  return value;
}

/** Recipes keyed by recipe id without namespace, e.g. "stick". */
export const getRecipes = (): Record<string, RecipeJson> => load('recipes.json');
/** Loot tables keyed by "<category>/<path>", e.g. "blocks/oak_log", "entities/zombie". */
export const getLootTables = (): Record<string, LootTableJson> => load('loot_tables.json');
/** Tags keyed by "<registry>/<tag_path>", e.g. "item/planks", "block/mineable/pickaxe". */
export const getTags = (): Record<string, TagJson> => load('tags.json');
/** Item registry from the game's items report, keyed by "minecraft:<name>" ({ protocol_id }). */
export const getItemRegistry = (): Record<string, { protocol_id: number }> => load('items.json');
export const getMeta = (): VanillaMeta => load('meta.json');

const withNamespace = (id: string) => (id.includes(':') ? id : `minecraft:${id}`);

/**
 * Expands a tag into a flat, de-duplicated list of namespaced ids, following nested "#tag" references.
 * Cycles are skipped, and missing tags expand to nothing. Accepts "planks" or "minecraft:planks".
 */
export function resolveTag(registry: string, tagName: string): string[] {
  const tags = getTags();
  const result = new Set<string>();
  const visiting = new Set<string>();

  const visit = (name: string) => {
    const key = `${registry}/${name.replace(/^#/, '').replace(/^minecraft:/, '')}`;
    if (visiting.has(key)) return;
    visiting.add(key);
    for (const entry of tags[key]?.values ?? []) {
      const id = typeof entry === 'string' ? entry : entry.id;
      if (id.startsWith('#')) visit(id);
      else result.add(withNamespace(id));
    }
  };

  visit(tagName);
  return [...result];
}
