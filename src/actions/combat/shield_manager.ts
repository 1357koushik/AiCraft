import { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';

/**
 * Checks if a shield is currently equipped in the bot's off-hand slot (slot 45).
 */
export function isShieldEquipped(bot: Bot): boolean {
  if (!bot || !bot.inventory) return false;
  const offHandItem = (bot as any).supportFeature?.('offHand') ? bot.inventory.slots[45] : null;
  return Boolean(offHandItem && offHandItem.name === 'shield');
}

/**
 * Ensures a shield from inventory is equipped into the bot's off-hand slot.
 */
export async function ensureShieldInOffHand(bot: Bot): Promise<boolean> {
  if (isShieldEquipped(bot)) return true;
  if (!bot.inventory || !bot.equip) return false;

  const shield = bot.inventory.items().find((i) => i.name === 'shield');
  if (!shield) return false;

  try {
    await bot.equip(shield, 'off-hand');
    return isShieldEquipped(bot);
  } catch {
    return false;
  }
}

/**
 * Raises the off-hand shield and faces an incoming threat or target.
 * Holds the shield active for durationMs (or until aborted).
 */
export async function raiseShieldAgainst(
  bot: Bot,
  threat: { position: Vec3 } | null,
  durationMs: number = 1000,
  abortSignal?: AbortSignal,
  isCurrent?: () => boolean
): Promise<boolean> {
  if (abortSignal?.aborted || (isCurrent && !isCurrent())) return false;

  const equipped = await ensureShieldInOffHand(bot);
  if (!equipped) return false;

  // Aim towards the threat
  if (threat && bot.lookAt) {
    try {
      await bot.lookAt(threat.position.offset(0, 1.2, 0), true);
    } catch {}
  }

  try {
    bot.activateItem(true); // true = off-hand (shield)
  } catch {
    return false;
  }

  const interval = 50;
  const steps = Math.ceil(durationMs / interval);

  try {
    for (let i = 0; i < steps; i++) {
      if (abortSignal?.aborted || (isCurrent && !isCurrent())) {
        return false;
      }
      await new Promise((res) => setTimeout(res, interval));
    }
    return true;
  } finally {
    try {
      bot.deactivateItem();
    } catch {}
  }
}
