import type { SkillDefinition, SkillRegistry } from './contract.js';
import { craftSkill } from './craft.js';
import { useBlockSkill } from './use_block.js';
import { inspectContainerSkill } from './inspect_container.js';
import { chopTreeSkill } from './chop_tree.js';
import { collectDropsSkill } from './collect_drops.js';
import { mineSkill } from './mine.js';
import { goToSkill } from './go_to.js';
import { placeSkill } from './place.js';
import { equipSkill } from './equip.js';
import { eatSkill } from './eat.js';
import { storeSkill } from './store.js';
import { takeSkill } from './take.js';
import { useStationSkill } from './use_station.js';
import { comeToSkill } from './come_to.js';
import { followSkill } from './follow.js';
import { giveSkill } from './give.js';

/**
 * The skill catalogue: every skill the step-plan runner (and later the LLM) can call.
 * A skill is added here only once it passes its live test.
 */
export const ALL_SKILLS: SkillDefinition[] = [craftSkill, goToSkill, placeSkill, equipSkill, eatSkill, storeSkill, takeSkill, chopTreeSkill, mineSkill, collectDropsSkill, useStationSkill, useBlockSkill, inspectContainerSkill, comeToSkill, followSkill, giveSkill];

export function buildRegistry(skills: SkillDefinition[] = ALL_SKILLS): SkillRegistry {
  const registry: SkillRegistry = new Map();
  for (const s of skills) {
    if (registry.has(s.name)) throw new Error(`Duplicate skill name: ${s.name}`);
    registry.set(s.name, s);
  }
  return registry;
}

/** One line per skill, for the LLM's catalogue and for humans. */
export function describeSkills(registry: SkillRegistry): string {
  return [...registry.values()].map((s) => `- ${s.summary}`).join('\n');
}
