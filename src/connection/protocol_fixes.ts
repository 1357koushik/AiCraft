import type { Bot } from 'mineflayer';

/**
 * Corrections for Mineflayer 4.39 on Minecraft 1.21.6, applied at the packet layer so node_modules stays
 * untouched. Each one is switched on only when the server's own protocol table shows the case it fixes.
 *
 * entity_action ids: Mineflayer picks numeric ids by checking a feature flag (entityActionUsesStringMapper)
 * that minecraft-data 3.117 does not define, so on 1.21.6 it sends the old ids:
 *   start sprinting 3 -> read by 1.21.6 as start_riding_jump   (should be 1)
 *   stop sprinting  4 -> read as stop_riding_jump               (should be 2)
 *   wake (bed)      2 -> read as stop_sprinting                 (should be 0)
 *   start elytra    8 -> not a valid id                         (should be 6)
 * Evidence: the server's stats show 0 cm sprinted in every run although the pathfinder sprints
 * (runtime/server/plan_*_move_place/stats, 2026-11-27). Found by docs/ACTION_AUDIT.md.
 */

const LEGACY_TO_NAME: Record<number, string> = {
  2: 'stop_sleeping',
  3: 'start_sprinting',
  4: 'stop_sprinting',
  8: 'start_fall_flying',
};

function entityActionMappings(bot: Bot): Record<string, string> | null {
  try {
    const types: any = (bot as any).registry?.protocol?.play?.toServer?.types;
    const container = types?.packet_entity_action;
    const fields: any[] = container?.[1] ?? [];
    const actionField = fields.find((f) => f.name === 'actionId');
    const mapper = actionField?.type;
    if (Array.isArray(mapper) && mapper[0] === 'mapper') return mapper[1].mappings ?? null;
  } catch {
    // Unknown protocol layout: leave packets alone.
  }
  return null;
}

/**
 * Item enchantments: on 1.21.6, prismarine-item's `enchants` getter returns the raw component, an object
 * `{ enchantments: [{ id, level }] }`, instead of the list `[{ name, lvl }]` that Mineflayer's digTime loops
 * over. With an enchanted tool in hand, bot.dig throws ("enchantments is not iterable"). The getter is patched
 * once per item class, the first time an item of that class is seen.
 */
const patchedPrototypes = new WeakSet<object>();
function patchEnchantsGetter(bot: Bot, item: any): void {
  if (!item) return;
  const proto = Object.getPrototypeOf(item);
  if (!proto || patchedPrototypes.has(proto)) return;
  let owner: any = proto;
  let desc: PropertyDescriptor | undefined;
  while (owner && !(desc = Object.getOwnPropertyDescriptor(owner, 'enchants'))) owner = Object.getPrototypeOf(owner);
  patchedPrototypes.add(proto);
  if (!desc?.get) return;
  const original = desc.get;
  const byId = new Map<number, string>(Object.values((bot as any).registry?.enchantments ?? {}).map((e: any) => [e.id, e.name]));
  Object.defineProperty(owner, 'enchants', {
    configurable: true,
    enumerable: desc.enumerable,
    get(this: any) {
      const value = original.call(this);
      if (value && !Array.isArray(value) && Array.isArray(value.enchantments)) {
        return value.enchantments.map((e: any) => ({ name: byId.get(e.id) ?? null, lvl: e.level ?? e.lvl ?? 0 }));
      }
      return value;
    },
  });
}

/** Installs the corrections on this bot's connection. Returns the names of the fixes that were applied. */
export function applyProtocolFixes(bot: Bot): string[] {
  const applied: string[] = [];
  const mappings = entityActionMappings(bot);
  // Only the 1.21.2+ layout (0 = stop_sleeping) is the one Mineflayer gets wrong.
  if (mappings && mappings['0'] === 'stop_sleeping' && !(bot as any).supportFeature?.('entityActionUsesStringMapper')) {
    const nameToId = new Map(Object.entries(mappings).map(([id, name]) => [name, Number(id)]));
    const client: any = (bot as any)._client;
    const write = client.write.bind(client);
    client.write = (name: string, params: any) => {
      if (name === 'entity_action' && typeof params?.actionId === 'number' && params.actionId in LEGACY_TO_NAME) {
        const fixed = nameToId.get(LEGACY_TO_NAME[params.actionId]);
        if (fixed !== undefined) params = { ...params, actionId: fixed };
      }
      return write(name, params);
    };
    applied.push('entity_action ids');
  }
  // Patch the item class as soon as the first item shows up in any window.
  const onSlot = (_slot: number, _old: any, item: any) => patchEnchantsGetter(bot, item);
  bot.once('spawn', () => {
    bot.inventory.on('updateSlot', onSlot);
    for (const it of bot.inventory.slots) patchEnchantsGetter(bot, it);
  });
  bot.on('windowOpen', (w: any) => w.on?.('updateSlot', onSlot));
  applied.push('enchants list');
  return applied;
}
