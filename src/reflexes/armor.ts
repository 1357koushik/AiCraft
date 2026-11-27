import type { Bot } from 'mineflayer';
import { body } from './body.js';
import { equipItem, EquipSlot } from '../skills/equip.js';
import type { ReflexEvent } from './guard.js';

/**
 * Armor upkeep: code only, no LLM. Every few seconds, when no reflex holds the body and no window is open, put on
 * the best armor piece held for each empty or weaker slot, and a shield into an empty off hand. Each equip goes
 * through equipItem (one settled click sequence under the inventory lock) and is read back from the slot.
 *
 * Never: take off an elytra worn in the torso slot, replace a head item that is not a helmet (a worn pumpkin or
 * skull was put there on purpose), or put on a carved pumpkin (it only counts as armor in the list of helmets).
 * Nothing is swapped during a fight, a flee or while eating, because those hold the body.
 */

/**
 * Armor points (defense) and toughness per piece, from the 1.21 wiki. minecraft-data 1.21.6 has no armor values on
 * its items (only durability), so this is a hand table; a unit test pins it. Score = defense*10 + toughness, so
 * netherite (toughness 3) beats diamond (2) at equal defense, and a tie-break of 0.1 per step down the material list
 * (netherite > diamond > iron > chainmail > golden > leather) separates chainmail from golden.
 */
const MATERIALS: Record<string, { helmet: number; chestplate: number; leggings: number; boots: number; toughness: number }> = {
  netherite: { helmet: 3, chestplate: 8, leggings: 6, boots: 3, toughness: 3 },
  diamond: { helmet: 3, chestplate: 8, leggings: 6, boots: 3, toughness: 2 },
  iron: { helmet: 2, chestplate: 6, leggings: 5, boots: 2, toughness: 0 },
  chainmail: { helmet: 2, chestplate: 5, leggings: 4, boots: 1, toughness: 0 },
  golden: { helmet: 2, chestplate: 5, leggings: 3, boots: 1, toughness: 0 },
  leather: { helmet: 1, chestplate: 3, leggings: 2, boots: 1, toughness: 0 },
};

export type ArmorSlot = 'head' | 'torso' | 'legs' | 'feet';
const SLOTS: Array<{ slot: ArmorSlot; kind: 'helmet' | 'chestplate' | 'leggings' | 'boots'; index: number }> = [
  { slot: 'head', kind: 'helmet', index: 5 },
  { slot: 'torso', kind: 'chestplate', index: 6 },
  { slot: 'legs', kind: 'leggings', index: 7 },
  { slot: 'feet', kind: 'boots', index: 8 },
];

/** How good an armor item is for its slot; null when it is not an armor piece (or is a pumpkin, skull, elytra). */
export function armorScore(name: string | undefined, kind: 'helmet' | 'chestplate' | 'leggings' | 'boots'): number | null {
  if (!name) return null;
  if (kind === 'helmet' && name === 'turtle_helmet') return 2 * 10 + 0.25; // the same defense as chainmail or golden; its worth is the water-breathing, not the points
  const m = name.match(/^([a-z]+)_(helmet|chestplate|leggings|boots)$/);
  if (!m || m[2] !== kind) return null;
  const mat = MATERIALS[m[1]];
  if (!mat) return null;
  return mat[kind] * 10 + mat.toughness + (Object.keys(MATERIALS).length - Object.keys(MATERIALS).indexOf(m[1])) / 10;
}

export interface Upgrade {
  slot: ArmorSlot;
  item: string;
  /** What is worn there now, if anything. */
  replaces?: string;
}

/** Pure decision: which piece (if any) to put on in each armor slot, given what is held and what is worn. */
export function planArmorUpgrades(held: string[], worn: Record<ArmorSlot, string | undefined>): Upgrade[] {
  const out: Upgrade[] = [];
  for (const { slot, kind } of SLOTS) {
    const now = worn[slot];
    if (slot === 'torso' && now === 'elytra') continue; // never take off an elytra
    const nowScore = armorScore(now, kind);
    if (now && nowScore === null) continue; // something else is worn there on purpose (pumpkin, skull, ...)
    let best: { name: string; score: number } | null = null;
    for (const name of held) {
      const s = armorScore(name, kind);
      if (s !== null && (!best || s > best.score)) best = { name, score: s };
    }
    if (best && (nowScore === null || best.score > nowScore)) out.push({ slot, item: best.name, ...(now ? { replaces: now } : {}) });
  }
  return out;
}

const CHECK_MS = 3000;

function inventoryOnly(bot: Bot): boolean {
  const w: any = bot.currentWindow;
  return !w || w === (bot.inventory as any);
}

/** One upkeep pass. Returns what it put on and what it failed to. Exported for tests and for one-off calls. */
export async function armorUpkeepOnce(bot: Bot, log: (line: string) => void = () => undefined): Promise<{ done: string[]; failed: string[] }> {
  const result = { done: [] as string[], failed: [] as string[] };
  const quiet = () => !body.reflexActive && inventoryOnly(bot) && Boolean(bot.entity);
  if (!quiet()) return result;
  const slots: any[] = (bot.inventory as any).slots ?? [];
  const held = bot.inventory.items().filter((i: any) => i.slot > 8 && i.slot < 45).map((i: any) => i.name);
  const worn = { head: slots[5]?.name, torso: slots[6]?.name, legs: slots[7]?.name, feet: slots[8]?.name } as Record<ArmorSlot, string | undefined>;
  const jobs: Array<{ slot: EquipSlot; item: string; text: string }> = planArmorUpgrades(held, worn).map((u) => ({ slot: u.slot, item: u.item, text: `${u.item}${u.replaces ? ` over ${u.replaces}` : ''}` }));
  if (!slots[45] && held.includes('shield')) jobs.push({ slot: 'off-hand', item: 'shield', text: 'shield' });
  for (const job of jobs) {
    if (!quiet()) break; // a reflex or a window appeared: stop swapping
    const err = await equipItem(bot, job.item, job.slot);
    if (err) {
      log(`[armor] could not put on ${job.text}: ${err}`);
      result.failed.push(job.text);
    } else {
      log(`[armor] put on ${job.text}`);
      result.done.push(job.text);
    }
  }
  return result;
}

/** After a failed equip, wait this long before trying again, so a stuck slot does not spam the server. */
const RETRY_AFTER_FAIL_MS = 30000;

/** Starts armor upkeep on this bot. Returns a function that stops it. */
export function installArmorUpkeep(bot: Bot, onEvent: (e: ReflexEvent) => void = () => undefined): () => void {
  let busy = false;
  let stopped = false;
  let pausedUntil = 0;
  const timer = setInterval(async () => {
    if (busy || stopped || Date.now() < pausedUntil) return;
    busy = true;
    try {
      const r = await armorUpkeepOnce(bot, (line) => {
        if (line.includes('could not')) onEvent({ reflex: 'armor', detail: line });
      });
      for (const d of r.done) onEvent({ reflex: 'armor', detail: `put on ${d}` });
      if (r.failed.length) pausedUntil = Date.now() + RETRY_AFTER_FAIL_MS;
    } catch (err) {
      onEvent({ reflex: 'armor', detail: `error: ${(err as Error).message}` });
      pausedUntil = Date.now() + RETRY_AFTER_FAIL_MS;
    } finally {
      busy = false;
    }
  }, CHECK_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
