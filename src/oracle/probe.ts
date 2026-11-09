import { RconClient } from './rcon.js';
import { parseDataGetReply, SnbtValue } from './snbt.js';
import { shortId, statCriterion } from './files.js';

/** A player's state as the server sees it, read over RCON. */
export interface PlayerSnapshot {
  name: string;
  online: boolean;
  /** Item counts across inventory and equipment (armor, offhand), keyed by short id ("stone_pickaxe"). */
  items: Record<string, number>;
  pos?: [number, number, number];
  dimension?: string;
  health?: number;
  food?: number;
}

function addItem(items: Record<string, number>, entry: any): void {
  if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string') return;
  const id = shortId(entry.id);
  const count = typeof entry.count === 'number' ? entry.count : 1;
  items[id] = (items[id] ?? 0) + count;
}

/** Counts items from the `Inventory` list and the `equipment` compound (1.21.5+ stores armor and offhand there). */
export function countItems(inventory: SnbtValue | null, equipment: SnbtValue | null): Record<string, number> {
  const items: Record<string, number> = {};
  if (Array.isArray(inventory)) for (const entry of inventory) addItem(items, entry);
  if (equipment && typeof equipment === 'object' && !Array.isArray(equipment)) {
    for (const entry of Object.values(equipment)) addItem(items, entry);
  }
  return items;
}

async function dataGet(rcon: RconClient, name: string, path: string): Promise<SnbtValue | null> {
  const reply = await rcon.command(`data get entity ${name} ${path}`);
  if (/No entity was found/i.test(reply)) throw new OfflineError(name);
  if (/Found no elements matching/i.test(reply)) return null;
  return parseDataGetReply(reply);
}

class OfflineError extends Error {
  constructor(name: string) {
    super(`${name} is not online`);
  }
}

export async function snapshotPlayer(rcon: RconClient, name: string): Promise<PlayerSnapshot> {
  try {
    const inventory = await dataGet(rcon, name, 'Inventory');
    const equipment = await dataGet(rcon, name, 'equipment');
    const pos = await dataGet(rcon, name, 'Pos');
    const dimension = await dataGet(rcon, name, 'Dimension');
    const health = await dataGet(rcon, name, 'Health');
    const food = await dataGet(rcon, name, 'foodLevel');
    return {
      name,
      online: true,
      items: countItems(inventory, equipment),
      pos: Array.isArray(pos) ? (pos.map(Number) as [number, number, number]) : undefined,
      dimension: typeof dimension === 'string' ? dimension : undefined,
      health: typeof health === 'number' ? health : undefined,
      food: typeof food === 'number' ? food : undefined,
    };
  } catch (err) {
    if (err instanceof OfflineError) return { name, online: false, items: {} };
    throw err;
  }
}

/** Live advancement check through a target selector. Only works while the player is online. */
export async function hasAdvancement(rcon: RconClient, name: string, advancementId: string): Promise<boolean> {
  const id = advancementId.includes(':') ? advancementId : `minecraft:${advancementId}`;
  const reply = await rcon.command(`execute if entity @a[name=${name},advancements={${id}=true}]`);
  return /Test passed/.test(reply);
}

/** Creates a scoreboard objective that counts a stat from now on. Returns the objective name. */
export async function trackStat(rcon: RconClient, index: number, statKey: string): Promise<string> {
  const objective = `bo_s${index}`;
  const reply = await rcon.command(`scoreboard objectives add ${objective} ${statCriterion(statKey)}`);
  if (!/Created new objective|already exists/i.test(reply)) {
    throw new Error(`Could not track stat ${statKey}: ${reply}`);
  }
  return objective;
}

export async function readScore(rcon: RconClient, name: string, objective: string): Promise<number> {
  const reply = await rcon.command(`scoreboard players get ${name} ${objective}`);
  const match = reply.match(/ has (-?\d+) \[/);
  return match ? parseInt(match[1], 10) : 0;
}

export async function onlinePlayers(rcon: RconClient): Promise<string[]> {
  const reply = await rcon.command('list');
  const match = reply.match(/online:\s*(.*)$/);
  if (!match || !match[1].trim()) return [];
  return match[1].split(',').map((s) => s.trim()).filter(Boolean);
}
