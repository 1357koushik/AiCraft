import type { Bot } from 'mineflayer';
import { SkillRegistry, StepRecord } from '../skills/contract.js';
import { describeSkills } from '../skills/registry.js';
import type { DoneWhen } from './decision.js';

/**
 * The decision brief (ROADMAP.md section 5): what the LLM is shown at each decision point.
 * The stable part (rules, reply format, skill catalogue) never changes within a task, so providers can cache it;
 * the changing part is small and worked out by code.
 */

export interface BriefState {
  task: string;
  doneWhen?: DoneWhen;
  trigger: string;
  notes: string;
  lastSteps: StepRecord[];
  journal: string[];
  callsUsed: number;
  callBudget: number;
}

export interface RequirementsSource {
  missingFor(item: string, count: number, have: Record<string, number>): { lines: string[] };
  craftableNow(have: Record<string, number>, opts?: { hasTable?: boolean; goal?: string }): { item: string; times: number; makes: number }[];
}

export function systemPrompt(registry: SkillRegistry): string {
  return `You control a Minecraft 1.21.6 survival bot through skills. You decide the next steps; code carries them out exactly and reports what really happened.

Reply with ONE JSON object and nothing else:
{"notes": "<your running notes for this task: sub-goals, what is done, what you plan next; under 600 characters>",
 "steps": [{"skill": "<name>", "args": {...}}, ...],     // 1 to 12 steps, run in order
 "done_when": {...}                                       // on your first reply (you may tighten it later): how code can tell the task is finished
}
done_when uses any of: "inventory": {"<item>": ">=N"} (counts held), "blocks": [{"x":..,"y":..,"z":..,"block":"cobblestone"}] (use "air" for a cleared spot; add states when they matter, e.g. "lever[powered=true]", "oak_door[open=true]"), "near": {"x":..,"y":..,"z":..,"range":2} (where the bot must end up).
done_when must describe the result the owner asked for, not a step on the way to it, and must not already be true before you act. If you cannot know an amount yet (what a chest holds), look first with inspect_container, or set what you know and send a stricter done_when later.
For a done_when count of zero use "==0".
Example of one step: {"skill": "craft", "args": {"item": "stick", "count": 4}}. Arguments always go inside "args".
or {"notes": "...", "answer": "<your reply>"} when the task is only a question (use the inventory, state and recipes shown below; never guess game facts),
or {"notes": "...", "ask_owner": "<one short question>"} only when the request is ambiguous and you need the owner to choose,
or {"notes": "...", "give_up": "<why it cannot be done>"} when it is impossible in survival (no commands, no creative), even if you could explain it.

Rules:
- Plan several steps ahead when the next steps are clear; you are asked again when the plan finishes, when a step fails or partly succeeds, or when something serious happens. Each step's preconditions are checked when it is reached, so a plan that goes stale stops safely.
- Use only the skills listed below, with real item and block ids (no "minecraft:" prefix needed). Item tags like "#planks" or "#logs" mean any member.
- Counts are how many MORE you want, not totals.
- When a step fails, read its cause and fix before choosing what to do next. Never repeat a step that failed with the same cause unless something relevant changed.
- craft walks to a crafting table within 32 blocks, or places one from your inventory, by itself: never add a separate place step for a table. If no table is near and none is held, craft one first (4 planks).
- Only use place with coordinates you have seen to be free (air) in NEARBY or from a step result; never guess.
- Items do not appear by themselves: gather or craft each ingredient first. Read the MISSING section; it is worked out from the game's own recipes.
- Only code decides whether the task is done, from done_when.

Skills:
${describeSkills(registry)}

Failure causes: missing_item, missing_tool, missing_station, not_found_nearby, unreachable, blocked, too_dangerous, interrupted, no_progress, inventory_full, invalid_args, server_rejected, unknown.`;
}

function inventoryCounts(bot: Bot): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of bot.inventory.items()) out[it.name] = (out[it.name] ?? 0) + it.count;
  return out;
}

const NEARBY_KINDS: Array<{ label: string; match: (name: string) => boolean }> = [
  { label: 'logs', match: (n) => n.endsWith('_log') || n.endsWith('_stem') },
  { label: 'stone', match: (n) => n === 'stone' || n === 'cobblestone' || n === 'deepslate' },
  { label: 'coal_ore', match: (n) => n.endsWith('coal_ore') },
  { label: 'iron_ore', match: (n) => n.endsWith('iron_ore') },
  { label: 'copper_ore', match: (n) => n.endsWith('copper_ore') },
  { label: 'gold_ore', match: (n) => n.endsWith('gold_ore') },
  { label: 'diamond_ore', match: (n) => n.endsWith('diamond_ore') },
  { label: 'sand', match: (n) => n === 'sand' },
  { label: 'water', match: (n) => n === 'water' },
  { label: 'lava', match: (n) => n === 'lava' },
  { label: 'crafting_table', match: (n) => n === 'crafting_table' },
  { label: 'furnace', match: (n) => n === 'furnace' || n === 'blast_furnace' || n === 'smoker' },
  { label: 'chest', match: (n) => n === 'chest' || n === 'barrel' },
];

function direction(dx: number, dz: number): string {
  const a = (Math.atan2(dz, dx) * 180) / Math.PI;
  const dirs = ['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east'];
  return dirs[Math.round(((a + 360) % 360) / 45) % 8];
}

function nearby(bot: Bot): string[] {
  const out: string[] = [];
  const me = bot.entity.position;
  const reg: any = bot.registry;
  for (const kind of NEARBY_KINDS) {
    const ids = Object.values(reg.blocksByName as Record<string, any>).filter((b) => kind.match(b.name)).map((b) => b.id);
    if (!ids.length) continue;
    const found = bot.findBlocks({ matching: ids, maxDistance: 32, count: 64 });
    if (!found.length) continue;
    const nearest = found[0];
    const d = nearest.distanceTo(me);
    const dy = Math.round(nearest.y - me.y);
    out.push(`${kind.label}: ${found.length >= 64 ? '64+' : found.length} within 32, nearest ${d.toFixed(0)} blocks ${direction(nearest.x - me.x, nearest.z - me.z)}${dy ? `, ${dy > 0 ? `${dy} up` : `${-dy} down`}` : ''}`);
  }
  const mobs: Record<string, number> = {};
  for (const e of Object.values(bot.entities)) {
    if (e === bot.entity || !e.position || e.position.distanceTo(me) > 16) continue;
    const kind = String(e.type);
    if (kind === 'hostile' || kind === 'animal' || kind === 'player' || kind === 'mob') mobs[e.name ?? kind] = (mobs[e.name ?? kind] ?? 0) + 1;
  }
  const mobText = Object.entries(mobs).map(([k, v]) => `${k} x${v}`).join(', ');
  if (mobText) out.push(`creatures within 16: ${mobText}`);
  return out;
}

function stepLine(r: StepRecord): string {
  const res = r.result;
  const delta = Object.entries(res.inventoryDelta).map(([k, v]) => `${v > 0 ? '+' : ''}${v} ${k}`).join(', ');
  return `${r.step.skill} ${JSON.stringify(r.step.args)} -> ${res.status}${res.cause ? ` (${res.cause})` : ''}: ${res.message}${res.fix ? ` Fix: ${res.fix}.` : ''}${delta ? ` [${delta}]` : ''}`;
}

export function userBrief(bot: Bot, s: BriefState, req?: RequirementsSource): string {
  const have = inventoryCounts(bot);
  const lines: string[] = [];
  lines.push(`TASK: ${s.task}`);
  if (s.doneWhen) {
    const parts: string[] = [];
    if (s.doneWhen.inventory) parts.push(`inventory ${Object.entries(s.doneWhen.inventory).map(([item, expr]) => `${item} ${expr} (have ${have[item.replace(/^minecraft:/, '')] ?? 0})`).join(', ')}`);
    if (s.doneWhen.blocks?.length) parts.push(`blocks ${s.doneWhen.blocks.map((b) => `${b.block} at ${b.x} ${b.y} ${b.z} (now ${bot.blockAt(bot.entity.position.floored().set(Math.floor(b.x), Math.floor(b.y), Math.floor(b.z)))?.name ?? 'unknown'})`).join(', ')}`);
    if (s.doneWhen.near) parts.push(`within ${s.doneWhen.near.range} of ${s.doneWhen.near.x} ${s.doneWhen.near.y} ${s.doneWhen.near.z} (now ${bot.entity.position.distanceTo(bot.entity.position.clone().set(s.doneWhen.near.x, s.doneWhen.near.y, s.doneWhen.near.z)).toFixed(1)} away)`);
    lines.push(`DONE WHEN: ${parts.join('; ')}`);
  } else {
    lines.push('DONE WHEN: not set yet; include "done_when" in this reply.');
  }
  lines.push(`WHY YOU ARE ASKED: ${s.trigger}`);
  lines.push(`YOUR NOTES: ${s.notes || '(none yet)'}`);
  if (s.lastSteps.length) lines.push('LAST STEPS:', ...s.lastSteps.slice(-8).map((r) => `- ${stepLine(r)}`));
  const pos = bot.entity.position;
  const time = bot.time?.timeOfDay ?? 0;
  lines.push(
    `STATE: health ${Math.round(bot.health)}/20, food ${bot.food}/20, at ${pos.x.toFixed(0)} ${pos.y.toFixed(0)} ${pos.z.toFixed(0)} in ${bot.game?.dimension ?? '?'}, ${time < 12500 || time > 23000 ? 'day' : 'night'} (time ${time}), holding ${bot.heldItem?.name ?? 'nothing'}`
  );
  const inv = Object.entries(have).map(([k, v]) => `${k} x${v}`).join(', ');
  lines.push(`INVENTORY: ${inv || 'empty'}`);
  if (req && s.doneWhen?.inventory) {
    for (const [item, expr] of Object.entries(s.doneWhen.inventory)) {
      const id = item.replace(/^minecraft:/, '');
      const target = parseInt(expr.replace(/[^\d]/g, ''), 10) || 1;
      const more = Math.max(0, target - (have[id] ?? 0));
      if (more > 0) {
        try {
          const m = req.missingFor(id, more, have);
          if (m.lines.length) lines.push(`MISSING for ${more} ${id}:`, ...m.lines.map((l) => `- ${l}`));
        } catch {
          // The calculator could not expand this item; the LLM still sees the inventory.
        }
      }
    }
    try {
      const hasTable = Boolean(bot.findBlock({ matching: (b: any) => b.name === 'crafting_table', maxDistance: 32 })) || (have.crafting_table ?? 0) > 0;
      const goal = Object.keys(s.doneWhen.inventory)[0]?.replace(/^minecraft:/, '');
      const craftable = req.craftableNow(have, { hasTable, goal }).slice(0, 12);
      if (craftable.length) lines.push(`CRAFTABLE NOW: ${craftable.map((c) => `${c.item} (x${c.makes * c.times})`).join(', ')}`);
    } catch {
      // ignore
    }
  }
  const near = nearby(bot);
  if (near.length) lines.push('NEARBY:', ...near.map((l) => `- ${l}`));
  if (s.journal.length) lines.push('ALREADY TRIED FOR THIS TASK:', ...s.journal.slice(-10).map((l) => `- ${l}`));
  lines.push(`BUDGET: decision ${s.callsUsed + 1} of ${s.callBudget}.`);
  return lines.join('\n');
}
