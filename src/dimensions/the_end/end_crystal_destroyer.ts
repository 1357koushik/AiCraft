import { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { ActionResult, ActionExecutionContext } from '../../types/index.js';
import { isAlive } from '../../safety/index.js';
import { isActionContextActive } from '../../agent/arbiter.js';
import { techniquePillarUp } from '../../actions/techniques.js';

/**
 * Finds all active End Crystal entities on the obsidian pillars.
 */
export function findRemainingEndCrystals(bot: Bot): any[] {
  if (!bot.entities) return [];
  const crystals: any[] = [];
  for (const id of Object.keys(bot.entities)) {
    const ent = bot.entities[id];
    if (ent && isAlive(ent) && ent.name === 'end_crystal') {
      crystals.push(ent);
    }
  }
  return crystals;
}

/**
 * Destroys an open (uncaged) End Crystal from distance using a bow and arrow.
 */
export async function techniqueDestroyCrystalWithBow(
  bot: Bot,
  crystal: any,
  ctx: ActionExecutionContext
): Promise<ActionResult> {
  if (!isActionContextActive(ctx)) {
    return { status: 'interrupted', reason: 'Crystal sniping cancelled.' };
  }

  const bow = bot.inventory?.items().find((i) => i.name === 'bow' || i.name === 'crossbow');
  const arrow = bot.inventory?.items().find((i) => i.name === 'arrow');

  if (!bow || !arrow) {
    return {
      status: 'failed',
      reason: 'No bow or arrows in inventory to snipe End Crystal.',
    };
  }

  try {
    if (bot.equip) {
      await bot.equip(bow, 'hand');
    }

    // Aim slightly above crystal center to account for gravitational arrow drop
    const dist = bot.entity.position.distanceTo(crystal.position);
    const yOffset = Math.min(dist * 0.08, 4.0); // Ballistic elevation compensation
    const targetAim = crystal.position.offset(0, yOffset, 0);

    if (bot.lookAt) {
      await bot.lookAt(targetAim, true);
    }

    if (bot.activateItem) {
      bot.activateItem();
      // Full bow charge (~1200ms)
      await new Promise((res) => setTimeout(res, 1200));
      bot.deactivateItem();
    }

    await new Promise((res) => setTimeout(res, 300));

    return {
      status: 'success',
      reason: `Sniped End Crystal at (${crystal.position.x}, ${crystal.position.y}, ${crystal.position.z}) with bow.`,
    };
  } catch (err: any) {
    return {
      status: 'failed',
      reason: `Failed sniping End Crystal: ${err.message}`,
    };
  }
}

/**
 * Climbs caged obsidian pillar, digs iron bars, and strikes crystal.
 */
export async function techniqueClimbAndDestroyCagedCrystal(
  bot: Bot,
  pillarBase: Vec3,
  pillarHeight: number = 20,
  ctx: ActionExecutionContext
): Promise<ActionResult> {
  if (!isActionContextActive(ctx)) {
    return { status: 'interrupted', reason: 'Pillar climbing cancelled.' };
  }

  // 1. Pillar up to top of obsidian pillar
  ctx.logger?.info?.(`[END_CRYSTAL] Pillaring up ${pillarHeight} blocks to caged crystal...`);
  await techniquePillarUp(bot, Math.min(pillarHeight, 12), ctx.abortSignal, ctx.isCurrent);

  // 2. Dig through iron bar cage
  if (bot.findBlock) {
    const ironBars = bot.findBlock({ matching: (b: any) => b.name === 'iron_bars', maxDistance: 4 });
    if (ironBars && bot.dig) {
      try {
        await bot.dig(ironBars);
      } catch {}
    }
  }

  // 3. Strike crystal
  const crystals = findRemainingEndCrystals(bot);
  if (crystals.length > 0) {
    const nearby = crystals[0];
    if (bot.lookAt) await bot.lookAt(nearby.position, true);
    if (bot.attack) bot.attack(nearby);
  }

  return {
    status: 'success',
    reason: 'Destroyed caged End Crystal atop obsidian pillar.',
  };
}
