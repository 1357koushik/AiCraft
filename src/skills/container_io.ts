import type { Bot } from 'mineflayer';
import { resyncWindow, settleInventory } from '../actions/reliable_craft.js';
import type { FailureCause } from './contract.js';

/**
 * Shared by store and take: opening a chest, barrel or shulker box and moving exact item counts through it.
 *
 * One slot per click with settling after each, the same discipline as reliable_craft: Mineflayer pipelines
 * window clicks, and a stale stateId makes a 1.21.6 server resend the whole inventory mid-sequence. Every
 * transfer is verified by reading the destination slot afterwards, and the cursor is always emptied.
 * Callers must hold the inventory lock (withInventoryLock).
 */

export const CONTAINER_RE = /^(chest|trapped_chest|barrel|ender_chest|shulker_box|[a-z_]+_shulker_box)$/;

export class ContainerError extends Error {
  constructor(message: string, readonly cause: FailureCause, readonly fix?: string) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function click(bot: Bot, slot: number, button: number, mode = 0): Promise<void> {
  const p = bot.clickWindow(slot, button, mode);
  p.catch(() => undefined);
  await Promise.race([p, sleep(1500)]);
  await settleInventory(bot);
}

const at = (win: any, i: number): any => win.slots?.[i] ?? null;
const stackOf = (bot: Bot, it: any): number => it.stackSize ?? (bot.registry as any).items?.[it.type]?.stackSize ?? 64;

/** Opens the container block and waits for its window. Throws ContainerError. */
export async function openContainer(bot: Bot, block: any): Promise<any> {
  if (bot.currentWindow) {
    bot.closeWindow(bot.currentWindow);
    await settleInventory(bot);
  }
  const opened = new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => {
      bot.removeListener('windowOpen', onOpen);
      reject(new ContainerError(`${block.name} at ${block.position} did not open within 5 s (something may sit on top of it, or it is locked).`, 'blocked', 'clear the block above the container'));
    }, 5000);
    const onOpen = (w: any) => {
      clearTimeout(timer);
      resolve(w);
    };
    bot.once('windowOpen', onOpen);
  });
  opened.catch(() => undefined);
  bot.setControlState('sneak', false);
  await bot.activateBlock(block).catch(() => undefined);
  const win = await opened;
  await settleInventory(bot);
  return win;
}

/** Closes the window, first putting anything on the cursor back, then settles. */
export async function closeContainer(bot: Bot, win: any): Promise<void> {
  try {
    await stowCursor(bot, win);
  } catch {
    // Reported by the caller's own verification.
  }
  if (bot.currentWindow === win) bot.closeWindow(win);
  await settleInventory(bot);
}

async function stowCursor(bot: Bot, win: any): Promise<void> {
  for (let n = 0; n < 4 && win.selectedItem; n++) {
    const held = win.selectedItem;
    const ranges: [number, number][] = [[win.inventoryStart, win.inventoryEnd], [0, win.inventoryStart]];
    let target = -1;
    for (const [a, b] of ranges) {
      for (let i = a; i < b && target < 0; i++) {
        const it = at(win, i);
        if (it && it.type === held.type && it.count < stackOf(bot, it)) target = i;
      }
      for (let i = a; i < b && target < 0; i++) if (!at(win, i)) target = i;
    }
    if (target < 0) throw new ContainerError(`No free slot for ${held.name} on the cursor.`, 'inventory_full');
    await click(bot, target, 0);
  }
}

/** Counts per item name in a slot range of the window. */
export function countRange(win: any, from: number, to: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (let i = from; i < to; i++) {
    const it = at(win, i);
    if (it) out[it.name] = (out[it.name] ?? 0) + it.count;
  }
  return out;
}

/** Moves exactly `k` items from slot `src` to slot `dst` (same window). Returns how many arrived. */
async function moveBetween(bot: Bot, win: any, src: number, dst: number, k: number): Promise<number> {
  const srcItem = at(win, src);
  const before = at(win, dst)?.count ?? 0;
  const n: number = srcItem.count;
  await click(bot, src, 0); // pick up the whole stack
  if (!win.selectedItem || win.selectedItem.count !== n) await resyncWindow(bot, win);
  if (k >= n) {
    await click(bot, dst, 0);
  } else if (k <= n - k) {
    for (let i = 0; i < k; i++) await click(bot, dst, 1); // right click places one
    await click(bot, src, 0); // put the rest back
  } else {
    for (let i = 0; i < n - k; i++) await click(bot, src, 1); // put the surplus back one by one
    await click(bot, dst, 0); // place what is left on the cursor
  }
  if (win.selectedItem) await stowCursor(bot, win);
  let arrived = (at(win, dst)?.count ?? 0) - before;
  if (arrived !== k) {
    await resyncWindow(bot, win);
    if (win.selectedItem) await stowCursor(bot, win);
    arrived = (at(win, dst)?.count ?? 0) - before;
  }
  return arrived;
}

export interface MoveResult {
  moved: number;
  /** Why it stopped short: no room at the destination, not enough at the source, or the server undid clicks. */
  short?: 'no_room' | 'not_enough' | 'rejected';
}

/**
 * Moves `need` of `name` into the container (`dir` 'in') or out of it ('out').
 * The container side is slots [0, inventoryStart); the player side is [inventoryStart, inventoryEnd).
 */
export async function moveItems(bot: Bot, win: any, name: string, need: number, dir: 'in' | 'out', signal?: AbortSignal): Promise<MoveResult> {
  const cont: [number, number] = [0, win.inventoryStart];
  const mine: [number, number] = [win.inventoryStart, win.inventoryEnd];
  const [from, to] = dir === 'in' ? [mine, cont] : [cont, mine];
  let moved = 0;
  let stalls = 0;
  while (moved < need) {
    if (signal?.aborted) return { moved, short: undefined };
    // Source: the smallest stack first so partial stacks are cleared out before full ones are split.
    let src = -1;
    for (let i = from[0]; i < from[1]; i++) {
      const it = at(win, i);
      if (it && it.name === name && (src < 0 || it.count < at(win, src).count)) src = i;
    }
    if (src < 0) return { moved, short: 'not_enough' };
    const item = at(win, src);
    // Destination: top up a partial stack of the same item, else an empty slot.
    let dst = -1;
    let room = 0;
    for (let i = to[0]; i < to[1]; i++) {
      const it = at(win, i);
      if (it && it.name === name && it.count < stackOf(bot, it)) {
        dst = i;
        room = stackOf(bot, it) - it.count;
        break;
      }
    }
    if (dst < 0) {
      for (let i = to[0]; i < to[1]; i++) {
        if (!at(win, i)) {
          dst = i;
          room = stackOf(bot, item);
          break;
        }
      }
    }
    if (dst < 0) return { moved, short: 'no_room' };
    const k = Math.min(item.count, need - moved, room);
    const arrived = await moveBetween(bot, win, src, dst, k);
    if (arrived <= 0) {
      if (++stalls >= 2) return { moved, short: 'rejected' };
      continue;
    }
    moved += arrived;
    if (arrived !== k) stalls++;
    if (stalls >= 3) return { moved, short: 'rejected' };
  }
  return { moved };
}
