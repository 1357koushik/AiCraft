import { RconClient } from './rcon.js';
import { parseDataGetReply, SnbtValue } from './snbt.js';
import { shortId, statCriterion } from './files.js';

/** A player's state as the server sees it, read over RCON. */
export interface PlayerSnapshot {
  name: string;
  online: boolean;
  /** Item counts across inventory and equipment (armor, offhand), keyed by short id ("stone_pickaxe"). */
  items: Record<string, number>;
  /** What is worn or held, from the `equipment` compound: slot (head, chest, legs, feet, offhand, mainhand) -> short item id. */
  equipment?: Record<string, string>;
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

/** Slot -> short item id from the `equipment` compound (1.21.5+); empty slots are left out. */
export function parseEquipment(equipment: SnbtValue | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (equipment && typeof equipment === 'object' && !Array.isArray(equipment)) {
    for (const [slot, entry] of Object.entries(equipment)) {
      if (entry && typeof entry === 'object' && !Array.isArray(entry) && typeof (entry as any).id === 'string') out[slot] = shortId((entry as any).id);
    }
  }
  return out;
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
      equipment: parseEquipment(equipment),
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

// ---------------------------------------------------------------------------------------------
// World checks: blocks, regions and containers. All read-only queries; none of them changes the
// world or prints to the server log, so they never count as assistance.
// ---------------------------------------------------------------------------------------------

export class ProbeError extends Error {}

/** True if the block at x y z matches `spec`: a block id, optionally with states ("oak_stairs[facing=north]"), or a tag ("#minecraft:logs"). */
export async function testBlock(rcon: RconClient, x: number, y: number, z: number, spec: string): Promise<boolean> {
  const block = spec.startsWith('#') || spec.includes(':') ? spec : `minecraft:${spec}`;
  const reply = await rcon.command(`execute if block ${Math.floor(x)} ${Math.floor(y)} ${Math.floor(z)} ${block}`);
  if (/Test passed/i.test(reply)) return true;
  if (/Test failed/i.test(reply)) return false;
  throw new ProbeError(`Block check for ${spec} at ${x} ${y} ${z} failed: ${reply.trim() || '(no reply)'}`);
}

/** Largest region the oracle will check block by block. */
export const MAX_REGION_VOLUME = 32768;

/** Counts blocks in the box (inclusive corners) that match `spec`, and the box's volume. */
export async function countRegion(
  rcon: RconClient,
  from: [number, number, number],
  to: [number, number, number],
  spec: string
): Promise<{ matching: number; volume: number }> {
  const lo = [0, 1, 2].map((i) => Math.floor(Math.min(from[i], to[i])));
  const hi = [0, 1, 2].map((i) => Math.floor(Math.max(from[i], to[i])));
  const volume = (hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1);
  if (volume > MAX_REGION_VOLUME) throw new ProbeError(`Region of ${volume} blocks is larger than the ${MAX_REGION_VOLUME} the oracle checks.`);
  let matching = 0;
  for (let x = lo[0]; x <= hi[0]; x++) {
    for (let y = lo[1]; y <= hi[1]; y++) {
      for (let z = lo[2]; z <= hi[2]; z++) {
        if (await testBlock(rcon, x, y, z, spec)) matching++;
      }
    }
  }
  return { matching, volume };
}

/** Item counts in a container block (chest, barrel, furnace...), or null if there is no container there. */
export async function containerItems(rcon: RconClient, x: number, y: number, z: number): Promise<Record<string, number> | null> {
  const at = `${Math.floor(x)} ${Math.floor(y)} ${Math.floor(z)}`;
  const reply = await rcon.command(`data get block ${at} Items`);
  if (/not a block entity|Found no elements matching/i.test(reply)) {
    // A container that exists but is empty has no Items list.
    const exists = await rcon.command(`data get block ${at}`);
    return /has the following block data/i.test(exists) ? {} : null;
  }
  const items = parseDataGetReply(reply);
  if (items === null) throw new ProbeError(`Could not read container at ${at}: ${reply.trim()}`);
  return countItems(items, null);
}
