import fs from 'fs';
import path from 'path';

/**
 * Readers for the per-player files the server writes into the world folder.
 * They are only current after `save-all` (or a clean stop).
 */

export interface AdvancementRecord {
  done: boolean;
  criteria: Record<string, string>;
}

function readJson(filePath: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/** Strips the default namespace: "minecraft:story/root" -> "story/root". */
export function shortId(id: string): string {
  return id.startsWith('minecraft:') ? id.slice('minecraft:'.length) : id;
}

export function readAdvancements(worldDir: string, uuid: string): Record<string, AdvancementRecord> {
  const raw = readJson(path.join(worldDir, 'advancements', `${uuid}.json`));
  const out: Record<string, AdvancementRecord> = {};
  if (!raw) return out;
  for (const [id, value] of Object.entries<any>(raw)) {
    if (id === 'DataVersion' || typeof value !== 'object') continue;
    out[shortId(id)] = { done: Boolean(value.done), criteria: value.criteria ?? {} };
  }
  return out;
}

/** Flattens a stats file to keys like "crafted:stone_pickaxe" or "custom:jump". */
export function readStats(worldDir: string, uuid: string): Record<string, number> {
  const raw = readJson(path.join(worldDir, 'stats', `${uuid}.json`));
  const out: Record<string, number> = {};
  if (!raw?.stats) return out;
  for (const [type, entries] of Object.entries<any>(raw.stats)) {
    for (const [id, count] of Object.entries<any>(entries)) {
      out[`${shortId(type)}:${shortId(id)}`] = Number(count);
    }
  }
  return out;
}

export function diffStats(before: Record<string, number>, after: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(after)) {
    const delta = value - (before[key] ?? 0);
    if (delta !== 0) out[key] = delta;
  }
  return out;
}

/** Scoreboard criterion for a stat key: "crafted:stone_pickaxe" -> "minecraft.crafted:minecraft.stone_pickaxe". */
export function statCriterion(statKey: string): string {
  const [type, id] = statKey.split(':');
  if (!type || !id) throw new Error(`Stat key must look like "type:id", got "${statKey}"`);
  return `minecraft.${type}:minecraft.${id}`;
}
