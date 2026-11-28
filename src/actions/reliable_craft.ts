import type { Bot } from 'mineflayer';

/**
 * Crafting that cannot lose items.
 *
 * Why this exists (traced live on 2026-11-27, run_20261126_202257_stone_pickaxe/agent-logs/packets.ndjson):
 * Mineflayer's bot.craft sends its clicks back to back without waiting for the server. When a click carries
 * an out-of-date stateId, a 1.21.6 server applies it and then resends the whole inventory. Those resends land
 * in the middle of Mineflayer's click sequence and overwrite its picture of the grid and cursor, so its later
 * clicks are wrong: it takes the result before the grid is complete (an oak_button instead of sticks), puts
 * the wrong count back, or leaves items in the grid. Its grid clicks also wait up to 20 s for the result slot
 * to change, which never happens once the picture is wrong ("updateSlot:0 did not fire within 20000ms").
 *
 * This routine clicks one slot at a time, never waits on the result slot, lets the inventory settle after
 * every click, checks the bot's picture against the server's when anything looks off, verifies the result
 * slot holds the expected item before taking it, and always leaves the grid and cursor empty.
 */

const INVENTORY_PACKETS = new Set(['set_slot', 'window_items', 'set_cursor_item', 'set_player_inventory']);
const lastInventoryPacket = new WeakMap<Bot, number>();

function trackPackets(bot: Bot): void {
  if (lastInventoryPacket.has(bot)) return;
  lastInventoryPacket.set(bot, Date.now());
  (bot as any)._client.on('packet', (_data: unknown, meta: { name: string }) => {
    if (INVENTORY_PACKETS.has(meta.name)) lastInventoryPacket.set(bot, Date.now());
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits until no inventory packet has arrived for quietMs (at least one tick), or capMs passes. */
export async function settleInventory(bot: Bot, quietMs = 100, capMs = 3000): Promise<void> {
  trackPackets(bot);
  const start = Date.now();
  await sleep(50);
  while (Date.now() - (lastInventoryPacket.get(bot) ?? 0) < quietMs && Date.now() - start < capMs) {
    await sleep(25);
  }
}

/** Asks the server for the full state of the window and waits for it. */
export async function resyncWindow(bot: Bot, window: any): Promise<void> {
  const sync = (bot as any)._syncWindow;
  if (typeof sync === 'function') {
    await Promise.race([sync(window), sleep(3000)]);
  }
  await settleInventory(bot);
}

// One inventory job at a time. Crafting, equipping and tossing all move items through the cursor.
let inventoryChain: Promise<unknown> = Promise.resolve();
let inventoryJobs = 0;
/** True while an inventory job holds or waits for the lock. A caller that must not queue (a reflex) skips instead. */
export function inventoryLockBusy(): boolean {
  return inventoryJobs > 0;
}
export function withInventoryLock<T>(fn: () => Promise<T>): Promise<T> {
  inventoryJobs++;
  const run = inventoryChain.then(fn, fn);
  inventoryChain = run.then(
    () => {
      inventoryJobs--;
    },
    () => {
      inventoryJobs--;
    }
  );
  return run;
}

export class CraftError extends Error {
  constructor(
    message: string,
    readonly cause: 'missing_item' | 'missing_station' | 'inventory_full' | 'server_rejected' | 'interrupted' | 'invalid_args',
    readonly evidence: string[] = []
  ) {
    super(message);
  }
}

interface Layout {
  window: any;
  width: number;
  grid: number[];
  invStart: number;
  invEnd: number;
  openedTable: boolean;
}

function itemAt(window: any, slot: number): any {
  return window.slots?.[slot] ?? null;
}

function describe(window: any, slots: number[]): string {
  return slots.map((s) => `${s}:${itemAt(window, s) ? `${itemAt(window, s).name}x${itemAt(window, s).count}` : '-'}`).join(' ');
}

/** Clicks without ever waiting on Mineflayer's result-slot wait; the caller settles and verifies instead. */
async function click(bot: Bot, slot: number, button: number, mode: number): Promise<void> {
  const p = bot.clickWindow(slot, button, mode);
  p.catch(() => undefined);
  await Promise.race([p, sleep(1500)]);
  await settleInventory(bot);
}

async function openLayout(bot: Bot, table: any | null): Promise<Layout> {
  if (!table) {
    const inv: any = bot.inventory;
    return { window: inv, width: 2, grid: [1, 2, 3, 4], invStart: inv.inventoryStart ?? 9, invEnd: inv.inventoryEnd ?? 45, openedTable: false };
  }
  let window: any = bot.currentWindow;
  let openedTable = false;
  if (!window || typeof window.type !== 'string' || !window.type.startsWith('minecraft:crafting')) {
    if (window) bot.closeWindow(window);
    const opened = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new CraftError('The crafting table did not open within 5 s.', 'missing_station')), 5000);
      bot.once('windowOpen', (w: any) => {
        clearTimeout(timer);
        resolve(w);
      });
    });
    await bot.activateBlock(table);
    window = await opened;
    openedTable = true;
    await settleInventory(bot);
  }
  return { window, width: 3, grid: [1, 2, 3, 4, 5, 6, 7, 8, 9], invStart: window.inventoryStart ?? 10, invEnd: window.inventoryEnd ?? 46, openedTable };
}

/** Puts whatever is on the cursor into the inventory part of the window. */
async function stowCursor(bot: Bot, L: Layout): Promise<void> {
  const held = L.window.selectedItem;
  if (!held) return;
  let target = -1;
  for (let i = L.invStart; i < L.invEnd; i++) {
    const it = itemAt(L.window, i);
    if (it && it.type === held.type && it.count < (it.stackSize ?? 64)) {
      target = i;
      break;
    }
  }
  if (target < 0) {
    for (let i = L.invStart; i < L.invEnd; i++) {
      if (!itemAt(L.window, i)) {
        target = i;
        break;
      }
    }
  }
  if (target < 0) throw new CraftError(`No room in the inventory for ${held.name} x${held.count}.`, 'inventory_full');
  await click(bot, target, 0, 0);
  // A partial stack merge can leave the rest on the cursor; place it again.
  if (L.window.selectedItem) await stowCursor(bot, L);
}

/** Empties the grid and the cursor into the inventory, then confirms with the server. */
async function clearGrid(bot: Bot, L: Layout): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    await resyncWindow(bot, L.window);
    await stowCursor(bot, L);
    for (const s of L.grid) {
      if (itemAt(L.window, s)) await click(bot, s, 0, 1); // shift-click back into the inventory
    }
    await resyncWindow(bot, L.window);
    if (!L.window.selectedItem && L.grid.every((s) => !itemAt(L.window, s))) return;
  }
  throw new CraftError(`Could not empty the crafting grid: ${describe(L.window, L.grid)}, cursor ${L.window.selectedItem?.name ?? '-'}.`, 'server_rejected');
}

interface Placement {
  slot: number;
  id: number;
}

function placementsFor(recipe: any, width: number): Placement[] {
  const out: Placement[] = [];
  if (recipe.inShape) {
    const rows: any[][] = recipe.inShape;
    if (rows.length > width || rows.some((r) => r.length > width)) {
      throw new CraftError(`Recipe needs a ${rows.length}x${Math.max(...rows.map((r) => r.length))} grid; only ${width}x${width} available.`, 'missing_station');
    }
    rows.forEach((row, y) =>
      row.forEach((ing, x) => {
        const id = typeof ing === 'number' ? ing : ing?.id;
        if (id != null && id !== -1) out.push({ slot: 1 + x + width * y, id });
      })
    );
  } else if (recipe.ingredients) {
    let next = 1;
    for (const ing of recipe.ingredients) {
      const id = typeof ing === 'number' ? ing : ing?.id;
      if (id == null || id === -1) continue;
      if (next > width * width) throw new CraftError('Too many ingredients for the grid.', 'invalid_args');
      out.push({ slot: next++, id });
    }
  }
  if (!out.length) throw new CraftError('Recipe has no ingredients.', 'invalid_args');
  return out;
}

async function craftOnce(bot: Bot, recipe: any, L: Layout, signal?: AbortSignal): Promise<void> {
  const evidence: string[] = [];
  const reg: any = (bot as any).registry;
  const nameOf = (id: number) => reg?.items?.[id]?.name ?? `item#${id}`;

  // Start from a known, empty grid.
  if (L.window.selectedItem || L.grid.some((s) => itemAt(L.window, s))) await clearGrid(bot, L);

  for (const p of placementsFor(recipe, L.width)) {
    if (signal?.aborted) throw new CraftError('Crafting was cancelled.', 'interrupted');
    const held = L.window.selectedItem;
    if (!held || held.type !== p.id) {
      if (held) await stowCursor(bot, L);
      let src = -1;
      for (let i = L.invStart; i < L.invEnd; i++) {
        if (itemAt(L.window, i)?.type === p.id) {
          src = i;
          break;
        }
      }
      if (src < 0) throw new CraftError(`Missing ${nameOf(p.id)} for this recipe.`, 'missing_item');
      await click(bot, src, 0, 0); // pick up the stack
    }
    const before = itemAt(L.window, p.slot);
    await click(bot, p.slot, 1, 0); // place one
    const after = itemAt(L.window, p.slot);
    if (!after || after.type !== p.id || (before && after.count !== before.count + 1)) {
      await resyncWindow(bot, L.window);
      const real = itemAt(L.window, p.slot);
      if (!real || real.type !== p.id) {
        evidence.push(`slot ${p.slot} after placing: ${real ? `${real.name}x${real.count}` : 'empty'}`);
        await clearGrid(bot, L);
        throw new CraftError(`The server did not accept ${nameOf(p.id)} into grid slot ${p.slot}.`, 'server_rejected', evidence);
      }
    }
  }
  await stowCursor(bot, L);

  // Only take the result once the server shows exactly what the recipe makes.
  const wantId: number = recipe.result?.id;
  const wantCount: number = recipe.result?.count ?? 1;
  let result = itemAt(L.window, 0);
  if (!result || result.type !== wantId || result.count < wantCount) {
    await resyncWindow(bot, L.window);
    result = itemAt(L.window, 0);
  }
  if (!result || result.type !== wantId || result.count < wantCount) {
    evidence.push(`grid ${describe(L.window, L.grid)}; result ${result ? `${result.name}x${result.count}` : 'empty'}`);
    await clearGrid(bot, L);
    throw new CraftError(`The grid did not produce ${nameOf(wantId)} x${wantCount} (it showed ${result ? `${result.name} x${result.count}` : 'nothing'}).`, 'server_rejected', evidence);
  }
  await click(bot, 0, 0, 0); // take the result onto the cursor
  if (!L.window.selectedItem) await resyncWindow(bot, L.window);
  await stowCursor(bot, L);

  // Recipes with leftovers (a bucket, a bottle) leave them in the grid; move them out too.
  if (L.grid.some((s) => itemAt(L.window, s)) || L.window.selectedItem) await clearGrid(bot, L);
}

/**
 * Crafts `recipe` `times` times with `table` (a crafting_table block) or the 2x2 inventory grid.
 * Throws CraftError with a cause from the skill contract's list; never leaves items in the grid or on the cursor.
 */
export async function craftReliably(bot: Bot, recipe: any, times: number, table: any | null, signal?: AbortSignal): Promise<void> {
  return withInventoryLock(async () => {
    trackPackets(bot);
    await settleInventory(bot);
    const L = await openLayout(bot, table);
    try {
      for (let i = 0; i < times; i++) {
        if (signal?.aborted) throw new CraftError('Crafting was cancelled.', 'interrupted');
        await craftOnce(bot, recipe, L, signal);
      }
    } catch (err) {
      // Whatever happened, do not strand items in the grid or on the cursor.
      try {
        await clearGrid(bot, L);
      } catch {
        // Reported by the original error below.
      }
      throw err;
    } finally {
      if (L.openedTable && bot.currentWindow) {
        bot.closeWindow(bot.currentWindow);
        await settleInventory(bot);
      }
    }
  });
}

const heldCount = (bot: Bot, type: number) => bot.inventory.items().filter((i) => i.type === type).reduce((a, i) => a + i.count, 0);

/**
 * Drops exactly `count` of an item from the player inventory, one settled click at a time (the drop key: mode 4,
 * button 1 for a whole stack, button 0 for one item). bot.toss sends a cursor pick-up, several outside clicks
 * and a put-back all at once with one stateId, and the server applied only some of them (traced live on
 * 2026-11-27, brain_20261127_060114_companion_chat_bring_logs_s7: 5 meant, 2 arrived). Checks the count after
 * every click against a resync, so the number it returns is what really left the inventory. Call it under
 * withInventoryLock.
 */
export async function dropReliably(bot: Bot, type: number, count: number, signal?: AbortSignal): Promise<number> {
  trackPackets(bot);
  if (bot.currentWindow) {
    bot.closeWindow(bot.currentWindow);
    await settleInventory(bot);
  }
  const inv: any = bot.inventory;
  const start = heldCount(bot, type);
  let stuck = 0;
  while (start - heldCount(bot, type) < count && !signal?.aborted) {
    const remaining = count - (start - heldCount(bot, type));
    let slot = -1;
    let best: any = null;
    for (let i = inv.inventoryStart ?? 9; i < (inv.inventoryEnd ?? 45); i++) {
      const it = inv.slots[i];
      if (!it || it.type !== type) continue;
      // Prefer a stack that fits in what is left, so a whole-stack drop can be used.
      if (!best || (it.count <= remaining && (best.count > remaining || it.count > best.count))) {
        best = it;
        slot = i;
      }
    }
    if (slot < 0) break;
    const before = heldCount(bot, type);
    await click(bot, slot, best.count <= remaining ? 1 : 0, 4);
    if (heldCount(bot, type) >= before) {
      // The click did not take, or the picture is stale: ask the server.
      await resyncWindow(bot, inv);
      if (heldCount(bot, type) >= before && ++stuck >= 3) break;
    } else stuck = 0;
  }
  await resyncWindow(bot, inv);
  return start - heldCount(bot, type);
}
