import { z } from 'zod';

export const KNOWN_ACTION_NAMES = [
  // Movement (13)
  'goto', 'follow', 'flee', 'move', 'jump', 'swim_up', 'sprint', 'sneak', 'look_at', 'explore', 'stop', 'pillar_up', 'bridge',
  // Mining & Building (12)
  'dig_block', 'mine_resource', 'chop_tree', 'place_block', 'collect_items', 'use_bucket', 'till', 'plant', 'harvest', 'mine_staircase', 'build_shelter', 'vacuum_drops',
  // Inventory & Crafting (11)
  'equip', 'select_hotbar', 'swap_hands', 'drop', 'eat', 'craft', 'craft_pipeline', 'open_container', 'deposit', 'withdraw', 'close_container',
  // Combat (4)
  'attack', 'attack_nearest', 'shoot', 'block_with_shield',
  // World Interaction (6)
  'interact_block', 'interact_entity', 'sleep', 'wake', 'mount', 'dismount',
  // Meta (6)
  'chat', 'wait', 'remember', 'set_goal', 'respawn', 'run_command',
] as const;

export type KnownActionName = typeof KNOWN_ACTION_NAMES[number];

export const ActionItemSchema = z
  .object({
    action: z.string().refine((val) => (KNOWN_ACTION_NAMES as readonly string[]).includes(val), {
      message: 'Invalid action name. Must be one of the registered actions in the action catalog.',
    }),
    params: z.record(z.any()).default({}),
  })
  .strict();

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
