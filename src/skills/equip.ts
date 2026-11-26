import { z } from 'zod';
import type { Bot } from 'mineflayer';
import { settleInventory, resyncWindow, withInventoryLock } from '../actions/reliable_craft.js';
import { Precondition, SkillDefinition, SkillOutcome } from './contract.js';

/**
 * equip: put one item in the hand, off hand or an armor slot, then read the slot back to prove it is there.
 * `equipItem` is exported so place and eat can put what they need in the hand.
 */

const SLOTS = ['hand', 'off-hand', 'head', 'torso', 'legs', 'feet'] as const;
export type EquipSlot = (typeof SLOTS)[number];

const Args = z.object({
  item: z.string().min(1).transform((s) => s.replace(/^minecraft:/, '')),
  slot: z.enum(SLOTS).default('hand'),
});
type EquipArgs = z.infer<typeof Args>;

const SLOT_INDEX: Record<Exclude<EquipSlot, 'hand'>, number> = { head: 5, torso: 6, legs: 7, feet: 8, 'off-hand': 45 };

function fitsSlot(name: string, slot: EquipSlot): boolean {
  switch (slot) {
    case 'head':
      return /_helmet$|^carved_pumpkin$|_head$|_skull$/.test(name);
    case 'torso':
      return /_chestplate$|^elytra$/.test(name);
    case 'legs':
      return /_leggings$/.test(name);
    case 'feet':
      return /_boots$/.test(name);
    default:
      return true;
  }
}

function inSlot(bot: Bot, slot: EquipSlot): any {
  if (slot === 'hand') return bot.heldItem ?? null;
  return (bot.inventory as any).slots?.[SLOT_INDEX[slot]] ?? null;
}

/** Counts the item everywhere the bot owns it, armor and off hand included. */
function owned(bot: Bot, name: string): number {
  return (bot.inventory as any).slots.reduce((a: number, it: any, i: number) => (it && it.name === name && i > 4 ? a + it.count : a), 0);
}

/** Puts anything left on the cursor into a free inventory slot. */
async function clearCursor(bot: Bot): Promise<void> {
  const inv: any = bot.inventory;
  if (!inv.selectedItem) return;
  const held = inv.selectedItem;
  for (let i = 9; i < 45; i++) {
    const it = inv.slots[i];
    if (!it || (it.type === held.type && it.count < (it.stackSize ?? 64))) {
      await Promise.race([bot.clickWindow(i, 0, 0).catch(() => undefined), new Promise((r) => setTimeout(r, 1500))]);
      await settleInventory(bot);
      if (!inv.selectedItem) return;
    }
  }
}

/**
 * Equips `name` into `slot` and verifies it. Returns an error string, or null when the item is there.
 * Runs inside the inventory lock; do not call it from within another locked section.
 */
export async function equipItem(bot: Bot, name: string, slot: EquipSlot): Promise<string | null> {
  return withInventoryLock(async () => {
    await settleInventory(bot);
    if (bot.currentWindow) {
      bot.closeWindow(bot.currentWindow);
      await settleInventory(bot);
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      if (inSlot(bot, slot)?.name === name) return null;
      const item = bot.inventory.items().find((i: any) => i.name === name && i.slot > 4 && i.slot < 45);
      if (!item) return `${name} is not in a bag or hotbar slot.`;
      try {
        await Promise.race([bot.equip(item, slot as any), new Promise((_, rej) => setTimeout(() => rej(new Error('equip timed out after 6 s')), 6000))]);
      } catch (err) {
        if (attempt === 1) {
          await clearCursor(bot);
          return `bot.equip failed: ${(err as Error).message}`;
        }
      }
      await settleInventory(bot);
      if (inSlot(bot, slot)?.name === name) break;
      await resyncWindow(bot, bot.inventory);
    }
    await clearCursor(bot);
    const now = inSlot(bot, slot);
    return now?.name === name ? null : `${slot} holds ${now ? now.name : 'nothing'} instead of ${name}.`;
  });
}

function evaluate(bot: Bot, args: EquipArgs): Precondition {
  if (!bot.registry.itemsByName[args.item]) return { ok: false, cause: 'invalid_args', message: `There is no item called "${args.item}".` };
  if (!fitsSlot(args.item, args.slot)) {
    return { ok: false, cause: 'invalid_args', message: `${args.item} cannot be worn in the ${args.slot} slot.`, fix: 'choose the slot that matches the armor piece' };
  }
  if (owned(bot, args.item) < 1 && inSlot(bot, args.slot)?.name !== args.item) {
    return { ok: false, cause: 'missing_item', message: `No ${args.item} in the inventory.`, fix: `get a ${args.item}` };
  }
  return { ok: true };
}

export const equipSkill: SkillDefinition<EquipArgs> = {
  name: 'equip',
  summary: 'equip {item, slot?="hand"}: put an item from the inventory into the hand, off-hand, head, torso, legs or feet slot.',
  args: Args,
  check(ctx, args) {
    return evaluate(ctx.bot, args);
  },
  async run(ctx, args): Promise<SkillOutcome> {
    const bot = ctx.bot;
    const evidence: string[] = [];
    const bad = evaluate(bot, args);
    if (!bad.ok) return { status: 'failed', cause: bad.cause, message: bad.message, fix: bad.fix, evidence };
    const was = inSlot(bot, args.slot);
    evidence.push(`${args.slot} before: ${was ? was.name : 'empty'}`);
    if (ctx.signal.aborted) return { status: 'interrupted', cause: 'interrupted', message: 'Cancelled before equipping.', evidence };
    const err = await equipItem(bot, args.item, args.slot);
    const now = inSlot(bot, args.slot);
    evidence.push(`${args.slot} after: ${now ? now.name : 'empty'}`);
    if (!err) return { status: 'done', message: `${args.item} is in the ${args.slot} slot.`, evidence };
    return { status: 'failed', cause: 'server_rejected', message: `Could not equip ${args.item}: ${err}`, evidence };
  },
};
