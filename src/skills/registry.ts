import type { SkillDefinition, SkillRegistry } from './contract.js';
import { craftSkill } from './craft.js';

/**
 * The skill catalogue: every skill the step-plan runner (and later the LLM) can call.
 * A skill is added here only once it passes its live test.
 */
export const ALL_SKILLS: SkillDefinition[] = [craftSkill];

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
