import { z } from 'zod';

export const ActionItemSchema = z.object({
  action: z.string(),
  params: z.record(z.any()).default({}),
});

export const LLMResponseSchema = z.object({
  decision_summary: z.string().describe('One brief explanation of the selected action and evidence'),
  goal: z.string().describe('Current high-level goal'),
  actions: z.array(ActionItemSchema).min(1).max(5).describe('Array of actions to execute in order'),
  memory: z
    .object({
      note: z.string().optional(),
      namedLocation: z
        .object({
          name: z.string(),
          position: z.object({ x: z.number(), y: z.number(), z: z.number() }),
        })
        .optional(),
      dangerZone: z
        .object({
          name: z.string(),
          position: z.object({ x: z.number(), y: z.number(), z: z.number() }),
          radius: z.number(),
        })
        .optional(),
    })
    .optional(),
  say: z.string().nullable().optional().describe('Optional in-game chat message, or null'),
});

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
          action: { type: 'string' },
          params: { type: 'object' },
        },
        required: ['action', 'params'],
      },
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
            },
          },
          required: ['name', 'position'],
        },
      },
    },
    say: { type: ['string', 'null'] },
  },
  required: ['decision_summary', 'goal', 'actions'],
};
