import { z } from 'zod';

export const KNOWN_ACTION_NAMES = [
  // Movement (13)
  'goto', 'follow', 'flee', 'move', 'jump', 'swim_up', 'sprint', 'sneak', 'look_at', 'explore', 'stop', 'pillar_up', 'bridge',
  // Mining & Building (13)
  'dig_block', 'mine_resource', 'chop_tree', 'collect_resource', 'place_block', 'collect_items', 'use_bucket', 'till', 'plant', 'harvest', 'mine_staircase', 'build_shelter', 'vacuum_drops',
  // Inventory & Crafting (14)
  'equip', 'select_hotbar', 'swap_hands', 'drop', 'eat', 'craft', 'craft_item', 'craft_pipeline', 'smelt_items', 'smelt_ore_pipeline', 'open_container', 'deposit', 'withdraw', 'close_container',
  // Combat (4)
  'attack', 'attack_nearest', 'shoot', 'block_with_shield',
  // World Interaction (6)
  'interact_block', 'interact_entity', 'sleep', 'wake', 'mount', 'dismount',
  // Meta (6)
  'chat', 'wait', 'remember', 'set_goal', 'respawn', 'run_command',
] as const;

export type KnownActionName = typeof KNOWN_ACTION_NAMES[number];

export const ACTION_ALLOWED_PARAMS: Record<KnownActionName, readonly string[]> = {
  goto: ['targetId', 'x', 'y', 'z', 'range'],
  follow: ['targetId', 'distance'],
  flee: ['threatId', 'distance'],
  move: ['direction', 'durationMs'],
  jump: [],
  swim_up: [],
  sprint: ['enabled'],
  sneak: ['enabled'],
  look_at: ['targetId', 'x', 'y', 'z'],
  explore: ['direction', 'distance', 'target'],
  stop: [],
  pillar_up: ['height'],
  bridge: ['direction', 'distance'],
  dig_block: ['blockType', 'x', 'y', 'z'],
  mine_resource: ['blockType', 'count'],
  chop_tree: ['logType', 'count'],
  collect_resource: ['resource', 'count'],
  place_block: ['item', 'referenceX', 'referenceY', 'referenceZ', 'face'],
  collect_items: [],
  use_bucket: ['action'],
  till: [],
  plant: ['seed'],
  harvest: [],
  mine_staircase: ['steps'],
  build_shelter: [],
  vacuum_drops: ['radius'],
  equip: ['item', 'destination'],
  select_hotbar: ['slot'],
  swap_hands: [],
  drop: ['item', 'count'],
  eat: ['item'],
  craft: ['item', 'count'],
  craft_item: ['item', 'count'],
  open_container: ['blockType'],
  close_container: [],
  deposit: ['item', 'count'],
  withdraw: ['item', 'count'],
  craft_pipeline: ['item'],
  smelt_items: ['itemToSmelt', 'item', 'oreName', 'count', 'fuelItem'],
  smelt_ore_pipeline: ['oreName', 'itemToSmelt', 'item', 'count'],
  attack: ['targetId'],
  attack_nearest: [],
  block_with_shield: ['durationMs'],
  shoot: ['targetId'],
  interact_block: ['blockType'],
  interact_entity: ['targetId'],
  sleep: [],
  wake: [],
  mount: ['targetId'],
  dismount: [],
  chat: ['message'],
  wait: ['seconds'],
  remember: ['locationName', 'x', 'y', 'z', 'fact', 'key', 'value'],
  set_goal: ['goal', 'planSteps'],
  respawn: [],
  run_command: ['command'],
};

export function validateActionParams(
  actionName: string,
  params: Record<string, any>
): { valid: boolean; reason?: string } {
  if (!KNOWN_ACTION_NAMES.includes(actionName as KnownActionName)) {
    return { valid: false, reason: `Unknown action name '${actionName}'.` };
  }

  const allowedKeys = ACTION_ALLOWED_PARAMS[actionName as KnownActionName] || [];
  for (const k of Object.keys(params)) {
    if (!allowedKeys.includes(k)) {
      return {
        valid: false,
        reason: `Unexpected parameter '${k}' for action '${actionName}'. Permitted parameters: [${allowedKeys.join(', ')}]`,
      };
    }
  }

  // Numerical parameters validation
  for (const [k, val] of Object.entries(params)) {
    if (typeof val === 'number') {
      if (!Number.isFinite(val) || Number.isNaN(val)) {
        return { valid: false, reason: `Parameter '${k}' must be a finite number (received ${val}).` };
      }
    }
  }

  // Bounds for counts, durations, distances, steps, radii
  const positiveKeys = ['range', 'distance', 'durationMs', 'count', 'height', 'steps', 'radius', 'seconds'];
  for (const k of positiveKeys) {
    if (k in params) {
      const val = params[k];
      if (typeof val !== 'number' || val <= 0) {
        return { valid: false, reason: `Parameter '${k}' must be a positive number greater than 0.` };
      }
    }
  }

  // Slot bounds
  if ('slot' in params) {
    const slot = params.slot;
    if (!Number.isInteger(slot) || slot < 0 || slot > 8) {
      return { valid: false, reason: `Hotbar slot must be an integer between 0 and 8.` };
    }
  }

  // Coordinate bounds
  for (const k of ['x', 'referenceX', 'z', 'referenceZ']) {
    if (k in params) {
      const v = params[k];
      if (typeof v !== 'number' || v < -30000000 || v > 30000000) {
        return { valid: false, reason: `Coordinate '${k}' outside Minecraft world bounds.` };
      }
    }
  }
  for (const k of ['y', 'referenceY']) {
    if (k in params) {
      const v = params[k];
      if (typeof v !== 'number' || v < -64 || v > 320) {
        return { valid: false, reason: `Coordinate '${k}' outside Minecraft height bounds (-64 to 320).` };
      }
    }
  }

  // String non-empty checks
  const stringKeys = ['item', 'targetId', 'threatId', 'command', 'goal', 'blockType', 'logType', 'seed', 'locationName', 'message'];
  for (const k of stringKeys) {
    if (k in params) {
      const v = params[k];
      if (typeof v !== 'string' || v.trim().length === 0) {
        return { valid: false, reason: `Parameter '${k}' must be a non-empty string.` };
      }
    }
  }

  // Enum checks
  if (actionName === 'move' && 'direction' in params) {
    if (!['forward', 'back', 'left', 'right'].includes(params.direction)) {
      return { valid: false, reason: `Invalid move direction '${params.direction}'.` };
    }
  }
  if (actionName === 'bridge' && 'direction' in params) {
    if (!['north', 'south', 'east', 'west', 'forward'].includes(params.direction)) {
      return { valid: false, reason: `Invalid bridge direction '${params.direction}'.` };
    }
  }
  if (actionName === 'explore' && 'direction' in params) {
    if (!['north', 'south', 'east', 'west'].includes(params.direction)) {
      return { valid: false, reason: `Invalid explore direction '${params.direction}'.` };
    }
  }
  if (actionName === 'equip' && 'destination' in params) {
    if (!['hand', 'off-hand', 'head', 'torso', 'legs', 'feet'].includes(params.destination)) {
      return { valid: false, reason: `Invalid equip destination '${params.destination}'.` };
    }
  }
  if (actionName === 'use_bucket' && 'action' in params) {
    if (!['scoop', 'place'].includes(params.action)) {
      return { valid: false, reason: `Invalid bucket action '${params.action}'.` };
    }
  }
  if ((actionName === 'sprint' || actionName === 'sneak') && 'enabled' in params) {
    if (typeof params.enabled !== 'boolean') {
      return { valid: false, reason: `Parameter 'enabled' for ${actionName} must be a boolean.` };
    }
  }

  return { valid: true };
}

export const ActionItemSchema = z
  .object({
    action: z.string().refine((val) => (KNOWN_ACTION_NAMES as readonly string[]).includes(val), {
      message: 'Invalid action name. Must be one of the registered actions in the action catalog.',
    }),
    params: z.record(z.any()).default({}),
  })
  .strict()
  .superRefine((val, ctx) => {
    const res = validateActionParams(val.action, val.params || {});
    if (!res.valid) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: res.reason || 'Invalid action parameters',
        path: ['params'],
      });
    }
  });

export const LLMResponseSchema = z
  .object({
    decision_summary: z.string().min(1, 'decision_summary must be a non-empty string'),
    goal: z.string().min(1, 'goal must be a non-empty string'),
    actions: z
      .array(ActionItemSchema)
      .min(1, 'actions must contain at least 1 action')
      .max(5, 'actions cannot exceed 5 actions per step'),
    memory: z
      .object({
        note: z.string().optional(),
        namedLocation: z
          .object({
            name: z.string().min(1),
            position: z
              .object({
                x: z.number(),
                y: z.number(),
                z: z.number(),
              })
              .strict(),
          })
          .strict()
          .optional(),
        dangerZone: z
          .object({
            name: z.string().min(1),
            position: z
              .object({
                x: z.number(),
                y: z.number(),
                z: z.number(),
              })
              .strict(),
            radius: z.number().positive(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    say: z.string().nullable().optional(),
  })
  .strict();

export type ValidatedLLMResponse = z.infer<typeof LLMResponseSchema>;

export const LLMJsonSchemaObject = {
  type: 'object',
  properties: {
    decision_summary: { type: 'string' },
    goal: { type: 'string' },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: KNOWN_ACTION_NAMES },
          params: { type: 'object' },
        },
        required: ['action', 'params'],
        additionalProperties: false,
      },
      minItems: 1,
      maxItems: 5,
    },
    memory: {
      type: 'object',
      properties: {
        note: { type: 'string' },
        namedLocation: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            position: {
              type: 'object',
              properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
              required: ['x', 'y', 'z'],
              additionalProperties: false,
            },
          },
          required: ['name', 'position'],
          additionalProperties: false,
        },
        dangerZone: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            position: {
              type: 'object',
              properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
              required: ['x', 'y', 'z'],
              additionalProperties: false,
            },
            radius: { type: 'number' },
          },
          required: ['name', 'position', 'radius'],
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    say: { type: ['string', 'null'] },
  },
  required: ['decision_summary', 'goal', 'actions'],
  additionalProperties: false,
};
