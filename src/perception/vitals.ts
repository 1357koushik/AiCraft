import { Bot } from 'mineflayer';
import { VitalsState } from '../types/index.js';

export function extractVitals(bot: Bot): VitalsState {
  const entity = bot.entity;
  const health = bot.health ?? 20;
  const food = bot.food ?? 20;
  const saturation = bot.foodSaturation ?? 5;
  const oxygen = bot.oxygenLevel ?? 20;

  // Derive armor points from equipment if available
  let armorPoints = 0;
  let armorToughness = 0;
  if (bot.inventory) {
    const armorSlots = [bot.inventory.slots[5], bot.inventory.slots[6], bot.inventory.slots[7], bot.inventory.slots[8]];
    for (const item of armorSlots) {
      if (item && item.name) {
        if (item.name.includes('leather')) armorPoints += 1.5;
        else if (item.name.includes('chainmail') || item.name.includes('golden')) armorPoints += 3;
        else if (item.name.includes('iron')) armorPoints += 3.75;
        else if (item.name.includes('diamond')) {
          armorPoints += 5;
          armorToughness += 2;
        } else if (item.name.includes('netherite')) {
          armorPoints += 5;
          armorToughness += 3;
        }
      }
    }
  }

  const isAlive = (bot as any).isAlive ?? (health > 0);
  const gameMode = bot.game?.gameMode || 'survival';
  const onGround = Boolean(entity?.onGround);
  const inWater = Boolean((bot.entity as any)?.isInWater || (bot as any).controlStates?.underwater);
  const inLava = Boolean((bot.entity as any)?.isInLava);

  return {
    health: Math.round(health * 10) / 10,
    maxHealth: 20,
    food: Math.round(food * 10) / 10,
    saturation: Math.round(saturation * 10) / 10,
    oxygen,
    underwater: inWater,
    armor: Math.round(armorPoints),
    armorToughness,
    experienceLevel: bot.experience?.level ?? 0,
    experienceProgress: bot.experience?.progress ?? 0,
    isAlive,
    gameMode,
    isBurning: Boolean((entity as any)?.metadata?.[0] & 0x01), // burning bit flag or status
    isFreezing: Boolean((entity as any)?.isFreezing),
    movementState: {
      onGround,
      inWater,
      inLava,
      isClimbing: false,
      isSwimming: inWater && Boolean(entity?.velocity?.y && entity.velocity.y > 0),
      isFalling: !onGround && !inWater && !inLava && (entity?.velocity?.y || 0) < -0.1,
      fallDistance: (entity as any)?.fallDistance || 0,
      isSleeping: Boolean(bot.isSleeping),
      isRiding: Boolean((entity as any)?.vehicle),
      isSprinting: Boolean((bot as any).controlStates?.sprint),
      isSneaking: Boolean((bot as any).controlStates?.sneak),
    },
    itemUseState: {
      usingItem: Boolean((bot as any).usingSelectedItem),
      itemTime: (bot as any).itemUseDuration || 0,
    },
    attackCooldownReady: true, // Mineflayer default ready check
  };
}
