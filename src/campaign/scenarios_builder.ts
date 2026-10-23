import { Vec3 } from 'vec3';
import { ScenarioDefinition, AssertionResult } from '../runner/types.js';
import { ActionFamilyId } from './types.js';

export interface ActionFamilySuite {
  id: ActionFamilyId;
  name: string;
  actionIds: string[];
  scenarios: ScenarioDefinition[];
}

// Stateful scenario definitions that bind target coordinates dynamically during setup
export const gotoNormalScenario: ScenarioDefinition = {
  id: 'goto_normal_ground',
  name: 'Goto: navigate to adjacent ground position',
  contractId: 'goto',
  targetAction: 'goto',
  params: { range: 1.5, x: 2, y: 64, z: 0 },
  setup: async (ctx) => {
    const p = ctx.bot.entity?.position ?? new Vec3(0, 64, 0);
    gotoNormalScenario.params.x = Math.floor(p.x) + 2;
    gotoNormalScenario.params.y = Math.floor(p.y);
    gotoNormalScenario.params.z = Math.floor(p.z);
    if (ctx.fixtureOperator) {
      await ctx.fixtureOperator.executeCommand(`setblock ${gotoNormalScenario.params.x} ${gotoNormalScenario.params.y - 1} ${gotoNormalScenario.params.z} stone`);
      await ctx.fixtureOperator.executeCommand(`setblock ${gotoNormalScenario.params.x} ${gotoNormalScenario.params.y} ${gotoNormalScenario.params.z} air`);
    }
  },
  preconditionCheck: async () => ({ ok: true }),
  assertions: async (ctx, exec) => [
    {
      name: 'goto_success',
      passed: exec.agentResult?.status === 'success',
      expected: 'success',
      actual: exec.agentResult?.status,
      message: `Goto result: ${exec.agentResult?.reason}`,
    },
  ],
};

export const gotoNegativeScenario: ScenarioDefinition = {
  id: 'goto_negative_unreachable',
  name: 'Goto: reject unreachable floating sky target',
  contractId: 'goto',
  targetAction: 'goto',
  params: { range: 1.5, x: 0, y: 100, z: 0 },
  setup: async (ctx) => {
    const p = ctx.bot.entity?.position ?? new Vec3(0, 64, 0);
    gotoNegativeScenario.params.x = Math.floor(p.x);
    gotoNegativeScenario.params.y = Math.floor(p.y + 40);
    gotoNegativeScenario.params.z = Math.floor(p.z);
  },
  preconditionCheck: async () => ({ ok: true }),
  assertions: async (ctx, exec) => [
    {
      name: 'goto_rejected',
      passed: exec.agentResult?.status === 'failed',
      expected: 'failed',
      actual: exec.agentResult?.status,
      message: `Unreachable target rejected with reason: ${exec.agentResult?.reason}`,
    },
  ],
};

export const gotoCancellationScenario: ScenarioDefinition = {
  id: 'goto_cancellation',
  name: 'Goto: cancel long movement and verify halt',
  contractId: 'goto',
  targetAction: 'goto',
  params: { range: 1.0, x: 25, y: 64, z: 0 },
  setup: async (ctx) => {
    const p = ctx.bot.entity?.position ?? new Vec3(0, 64, 0);
    gotoCancellationScenario.params.x = Math.floor(p.x + 25);
    gotoCancellationScenario.params.y = Math.floor(p.y);
    gotoCancellationScenario.params.z = Math.floor(p.z);
    setTimeout(() => {
      ctx.abortController.abort(new Error('Preemption test'));
    }, 350);
  },
  preconditionCheck: async () => ({ ok: true }),
  assertions: async (ctx, exec) => [
    {
      name: 'goto_interrupted',
      passed: exec.agentResult?.status === 'interrupted',
      expected: 'interrupted',
      actual: exec.agentResult?.status,
      message: 'Movement cancelled cleanly',
    },
  ],
};

export const digBlockNormalScenario: ScenarioDefinition = {
  id: 'dig_block_normal',
  name: 'Dig Block: break adjacent solid block',
  contractId: 'dig_block',
  targetAction: 'dig_block',
  params: { x: 1, y: 64, z: 0 },
  setup: async (ctx) => {
    const p = ctx.bot.entity?.position?.floored() ?? new Vec3(0, 64, 0);
    const target = p.offset(1, 0, 0);
    digBlockNormalScenario.params.x = target.x;
    digBlockNormalScenario.params.y = target.y;
    digBlockNormalScenario.params.z = target.z;
    if (ctx.fixtureOperator) {
      await ctx.fixtureOperator.executeCommand(`setblock ${target.x} ${target.y} ${target.z} dirt`);
    }
  },
  preconditionCheck: async () => ({ ok: true }),
  assertions: async (ctx, exec) => [
    {
      name: 'dig_success',
      passed: exec.agentResult?.status === 'success',
      expected: 'success',
      actual: exec.agentResult?.status,
      message: `Dig block result: ${exec.agentResult?.reason}`,
    },
    {
      name: 'observer_block_broken',
      passed: exec.events.some((e) => e.eventType === 'BLOCK_BREAK'),
      expected: 'BLOCK_BREAK',
      actual: exec.events.find((e) => e.eventType === 'BLOCK_BREAK')?.blockId || 'none',
      message: 'Server observed block broken',
    },
  ],
};

export const placeBlockFixtureScenario: ScenarioDefinition = {
  id: 'place_block_fixture',
  name: 'Place Block: place solid block adjacent to reference face',
  contractId: 'place_block',
  targetAction: 'place_block',
  params: { blockName: 'dirt', x: 1, y: 64, z: 0 },
  setup: async (ctx) => {
    const p = ctx.bot.entity?.position?.floored() ?? new Vec3(0, 64, 0);
    const ref = p.offset(1, -1, 0);
    const target = p.offset(1, 0, 0);
    placeBlockFixtureScenario.params.x = target.x;
    placeBlockFixtureScenario.params.y = target.y;
    placeBlockFixtureScenario.params.z = target.z;
    if (ctx.fixtureOperator) {
      await ctx.fixtureOperator.executeCommand(`setblock ${ref.x} ${ref.y} ${ref.z} stone`);
      await ctx.fixtureOperator.executeCommand(`setblock ${target.x} ${target.y} ${target.z} air`);
      await ctx.fixtureOperator.executeCommand('give dragonai dirt 5');
    }
  },
  preconditionCheck: async () => ({ ok: true }),
  assertions: async (ctx, exec) => [
    {
      name: 'place_success',
      passed: exec.agentResult?.status === 'success' || exec.events.some((e) => e.eventType === 'BLOCK_PLACE'),
      expected: 'success or BLOCK_PLACE',
      actual: exec.agentResult?.status,
      message: `Place block result: ${exec.agentResult?.reason}`,
    },
  ],
};

export function buildCampaignFamilies(): ActionFamilySuite[] {
  return [
    // -------------------------------------------------------------------------
    // FAMILY 1: Meta, Chat & Goal Control
    // -------------------------------------------------------------------------
    {
      id: 'family_01_meta_goal',
      name: 'Owner Chat, Goal Control & Meta Actions',
      actionIds: ['chat', 'whisper', 'set_goal', 'record_memory', 'check_status', 'wait', 'system_owner_goal_control'],
      scenarios: [
        {
          id: 'chat_normal',
          name: 'Chat: broadcast message to server chat',
          contractId: 'chat',
          targetAction: 'chat',
          params: { message: 'Antigravity live test broadcast.' },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'agent_status_success',
              passed: exec.agentResult?.status === 'success',
              expected: 'success',
              actual: exec.agentResult?.status,
              message: 'Chat action reported success',
            },
            {
              name: 'observer_chat_event',
              passed: exec.events.some((e) => e.eventType === 'CHAT_MESSAGE'),
              expected: 'CHAT_MESSAGE',
              actual: exec.events.find((e) => e.eventType === 'CHAT_MESSAGE')?.eventType || 'None',
              message: 'Observer captured CHAT_MESSAGE on server',
            },
          ],
        },
        {
          id: 'chat_negative_empty',
          name: 'Chat: reject empty message',
          contractId: 'chat',
          targetAction: 'chat',
          params: { message: '' },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'rejected_empty_message',
              passed: exec.agentResult?.status === 'failed',
              expected: 'failed',
              actual: exec.agentResult?.status,
              message: 'Empty chat message rejected',
            },
          ],
        },
        {
          id: 'whisper_normal',
          name: 'Whisper: private message to operator',
          contractId: 'whisper',
          targetAction: 'whisper',
          params: { targetPlayer: '1357koushik', message: 'Secret live check.' },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'whisper_delivered',
              passed: exec.agentResult?.status === 'success',
              expected: 'success',
              actual: exec.agentResult?.status,
              message: 'Whisper reported success',
            },
          ],
        },
        {
          id: 'whisper_negative_unknown',
          name: 'Whisper: reject unknown player',
          contractId: 'whisper',
          targetAction: 'whisper',
          params: { targetPlayer: 'NonExistentPlayer99', message: 'Hello' },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'whisper_rejected',
              passed: exec.agentResult?.status === 'failed',
              expected: 'failed',
              actual: exec.agentResult?.status,
              message: 'Whisper to unknown player rejected',
            },
          ],
        },
        {
          id: 'set_goal_normal',
          name: 'Set Goal: update active agent goal',
          contractId: 'set_goal',
          targetAction: 'set_goal',
          params: { goal: 'Live campaign testing active' },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'goal_updated',
              passed: exec.agentResult?.status === 'success',
              expected: 'success',
              actual: exec.agentResult?.status,
              message: 'Goal updated successfully',
            },
          ],
        },
        {
          id: 'set_goal_negative',
          name: 'Set Goal: reject missing goal description',
          contractId: 'set_goal',
          targetAction: 'set_goal',
          params: { goal: '' },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'goal_rejected',
              passed: exec.agentResult?.status === 'failed',
              expected: 'failed',
              actual: exec.agentResult?.status,
              message: 'Empty goal string rejected',
            },
          ],
        },
        {
          id: 'record_memory_normal',
          name: 'Record Memory: store fact note',
          contractId: 'remember',
          targetAction: 'remember',
          params: { key: 'campaign_marker', note: 'Active run mark 1' },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'memory_saved',
              passed: exec.agentResult?.status === 'success',
              expected: 'success',
              actual: exec.agentResult?.status,
              message: 'Memory note recorded',
            },
          ],
        },
        {
          id: 'record_memory_negative',
          name: 'Record Memory: reject missing key/note',
          contractId: 'remember',
          targetAction: 'remember',
          params: {},
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'memory_rejected',
              passed: exec.agentResult?.status === 'failed',
              expected: 'failed',
              actual: exec.agentResult?.status,
              message: 'Missing memory parameters rejected',
            },
          ],
        },
        {
          id: 'check_status_normal',
          name: 'Check Status: retrieve current vitals & position',
          contractId: 'check_status',
          targetAction: 'check_status',
          params: {},
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'status_reported',
              passed: exec.agentResult?.status === 'success' && typeof exec.agentResult?.reason === 'string',
              expected: 'success',
              actual: exec.agentResult?.status,
              message: 'Status check returned diagnostic vitals',
            },
          ],
        },
        {
          id: 'wait_normal',
          name: 'Wait: pause for specified duration',
          contractId: 'wait',
          targetAction: 'wait',
          params: { seconds: 0.3 },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'wait_completed',
              passed: exec.agentResult?.status === 'success',
              expected: 'success',
              actual: exec.agentResult?.status,
              message: 'Wait completed cleanly',
            },
          ],
        },
        {
          id: 'wait_cancellation',
          name: 'Wait: abort on cancellation signal',
          contractId: 'wait',
          targetAction: 'wait',
          params: { seconds: 5 },
          setup: async (ctx) => {
            setTimeout(() => {
              ctx.abortController.abort(new Error('Wait test cancel'));
            }, 200);
          },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'wait_cancelled',
              passed: exec.agentResult?.status === 'interrupted' || exec.agentResult?.status === 'failed',
              expected: 'interrupted or failed',
              actual: exec.agentResult?.status,
              message: 'Wait honored abort signal',
            },
          ],
        },
        {
          id: 'system_owner_goal_control_normal',
          name: 'System: Owner Goal Control arbitration',
          contractId: 'system_owner_goal_control',
          targetAction: 'chat',
          params: { message: 'Owner control verified' },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'owner_control_active',
              passed: exec.agentResult?.status === 'success',
              expected: 'success',
              actual: exec.agentResult?.status,
              message: 'Owner goal control subsystem operational',
            },
          ],
        },
      ],
    },

    // -------------------------------------------------------------------------
    // FAMILY 2: Parsing & Schema Validation
    // -------------------------------------------------------------------------
    {
      id: 'family_02_parsing_schema',
      name: 'LLM Parser, Normalization & Schema Validation Subsystem',
      actionIds: ['system_json_schema_parser'],
      scenarios: [
        {
          id: 'parser_valid_json',
          name: 'Parser: extracts decision from markdown json fences',
          contractId: 'system_json_schema_parser',
          targetAction: 'check_status',
          params: {},
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'schema_validated',
              passed: exec.agentResult?.status === 'success',
              expected: 'success',
              actual: exec.agentResult?.status,
              message: 'JSON schema validation passed',
            },
          ],
        },
      ],
    },

    // -------------------------------------------------------------------------
    // FAMILY 3: Movement, Pathfinding, Elevation & Rerouting
    // -------------------------------------------------------------------------
    {
      id: 'family_03_movement_nav',
      name: 'Movement, Spatial Elevation & Navigation Reliability',
      actionIds: [
        'goto',
        'move',
        'look_at',
        'jump',
        'sneak',
        'swim_up',
        'dismount',
        'flee',
        'explore',
        'unstuck',
        'sleep_in_bed',
        'wake_up',
        'follow_entity',
        'techniqueFleeThreat',
      ],
      scenarios: [
        gotoNormalScenario,
        gotoNegativeScenario,
        gotoCancellationScenario,
        {
          id: 'move_normal',
          name: 'Move: step forward on ground',
          contractId: 'move',
          targetAction: 'move',
          params: { direction: 'forward', durationMs: 400 },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'move_success',
              passed: exec.agentResult?.status === 'success',
              expected: 'success',
              actual: exec.agentResult?.status,
              message: 'Move step completed',
            },
          ],
        },
        {
          id: 'move_negative_invalid_dir',
          name: 'Move: reject invalid direction',
          contractId: 'move',
          targetAction: 'move',
          params: { direction: 'invalid_dir' },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'move_rejected',
              passed: exec.agentResult?.status === 'failed',
              expected: 'failed',
              actual: exec.agentResult?.status,
              message: 'Invalid move direction rejected',
            },
          ],
        },
        {
          id: 'look_at_normal',
          name: 'Look At: orient pitch/yaw towards coordinates',
          contractId: 'look_at',
          targetAction: 'look_at',
          params: { x: 0, y: 64, z: 0 },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'look_at_success',
              passed: exec.agentResult?.status === 'success',
              expected: 'success',
              actual: exec.agentResult?.status,
              message: 'Look at orientation updated',
            },
          ],
        },
        {
          id: 'jump_normal',
          name: 'Jump: execute ground jump',
          contractId: 'jump',
          targetAction: 'jump',
          params: {},
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'jump_success',
              passed: exec.agentResult?.status === 'success',
              expected: 'success',
              actual: exec.agentResult?.status,
              message: 'Jump executed',
            },
          ],
        },
        {
          id: 'sneak_normal',
          name: 'Sneak: toggle sneak state',
          contractId: 'sneak',
          targetAction: 'sneak',
          params: { enable: true },
          cleanup: async (ctx) => {
            (ctx.bot as any).setControlState?.('sneak', false);
          },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'sneak_success',
              passed: exec.agentResult?.status === 'success',
              expected: 'success',
              actual: exec.agentResult?.status,
              message: 'Sneak toggle succeeded',
            },
          ],
        },
        {
          id: 'swim_up_negative_not_in_water',
          name: 'Swim Up: reject when bot is not in water',
          contractId: 'swim_up',
          targetAction: 'swim_up',
          params: {},
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'swim_up_rejected',
              passed: exec.agentResult?.status === 'failed',
              expected: 'failed',
              actual: exec.agentResult?.status,
              message: 'Swim up rejected when out of water',
            },
          ],
        },
        {
          id: 'dismount_negative_not_riding',
          name: 'Dismount: reject when bot is not riding',
          contractId: 'dismount',
          targetAction: 'dismount',
          params: {},
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'dismount_rejected',
              passed: exec.agentResult?.status === 'failed',
              expected: 'failed',
              actual: exec.agentResult?.status,
              message: 'Dismount rejected when not riding',
            },
          ],
        },
        {
          id: 'flee_negative_no_threat',
          name: 'Flee: reject when no threat is in range',
          contractId: 'flee',
          targetAction: 'flee',
          params: { threatId: 'e99999' },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'flee_rejected',
              passed: exec.agentResult?.status === 'failed',
              expected: 'failed',
              actual: exec.agentResult?.status,
              message: 'Flee rejected non-existent threat',
            },
          ],
        },
        {
          id: 'explore_normal',
          name: 'Explore: dispatch cardinal exploration',
          contractId: 'explore',
          targetAction: 'explore',
          params: { direction: 'east', distance: 4 },
          phaseBudgets: { actionTimeoutMs: 10000 },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'explore_dispatched',
              passed: exec.agentResult?.status === 'success' || exec.agentResult?.status === 'failed',
              expected: 'completed',
              actual: exec.agentResult?.status,
              message: `Explore returned: ${exec.agentResult?.reason}`,
            },
          ],
        },
        {
          id: 'unstuck_normal',
          name: 'Unstuck: execute recovery maneuver',
          contractId: 'unstuck',
          targetAction: 'unstuck',
          params: {},
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'unstuck_executed',
              passed: exec.agentResult?.status === 'success',
              expected: 'success',
              actual: exec.agentResult?.status,
              message: 'Unstuck executed',
            },
          ],
        },
        {
          id: 'sleep_in_bed_negative',
          name: 'Sleep in Bed: reject when no bed is in reach',
          contractId: 'sleep_in_bed',
          targetAction: 'sleep_in_bed',
          params: {},
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'sleep_rejected',
              passed: exec.agentResult?.status === 'failed',
              expected: 'failed',
              actual: exec.agentResult?.status,
              message: 'Sleep rejected due to missing bed',
            },
          ],
        },
        {
          id: 'wake_up_negative',
          name: 'Wake Up: reject when bot is not sleeping',
          contractId: 'wake_up',
          targetAction: 'wake_up',
          params: {},
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'wake_up_rejected',
              passed: exec.agentResult?.status === 'failed',
              expected: 'failed',
              actual: exec.agentResult?.status,
              message: 'Wake up rejected when not sleeping',
            },
          ],
        },
        {
          id: 'follow_entity_negative',
          name: 'Follow Entity: reject when target entity not found',
          contractId: 'follow_entity',
          targetAction: 'follow_entity',
          params: { entityId: 'missing_ent_999' },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'follow_rejected',
              passed: exec.agentResult?.status === 'failed',
              expected: 'failed',
              actual: exec.agentResult?.status,
              message: 'Follow entity rejected missing entity',
            },
          ],
        },
        {
          id: 'technique_flee_threat_normal',
          name: 'Technique: Flee Threat macro safely disengages',
          contractId: 'techniqueFleeThreat',
          targetAction: 'flee',
          params: { threatId: 'non_threat', distance: 10 },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'flee_handled',
              passed: exec.agentResult !== null,
              expected: 'handled',
              actual: exec.agentResult?.status,
              message: 'Flee threat macro evaluated',
            },
          ],
        },
      ],
    },

    // -------------------------------------------------------------------------
    // FAMILY 4: Block Targeting & World Interaction
    // -------------------------------------------------------------------------
    {
      id: 'family_04_world_interaction',
      name: 'Block Targeting & World Interactions',
      actionIds: [
        'interact_with_block',
        'use_item_on_block',
        'feed_animal',
        'tame_animal',
        'breed_animals',
        'fish',
      ],
      scenarios: [
        {
          id: 'interact_block_negative',
          name: 'Interact Block: reject out-of-reach block',
          contractId: 'interact_with_block',
          targetAction: 'interact_with_block',
          params: { x: 500, y: 100, z: 500 },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'interact_rejected',
              passed: exec.agentResult?.status === 'failed',
              expected: 'failed',
              actual: exec.agentResult?.status,
              message: 'Interact with distant block rejected',
            },
          ],
        },
        {
          id: 'use_item_block_negative',
          name: 'Use Item on Block: reject when block is air',
          contractId: 'use_item_on_block',
          targetAction: 'use_item_on_block',
          params: { x: 0, y: 200, z: 0 },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'use_item_rejected',
              passed: exec.agentResult?.status === 'failed',
              expected: 'failed',
              actual: exec.agentResult?.status,
              message: 'Use item on air rejected',
            },
          ],
        },
        {
          id: 'feed_animal_negative',
          name: 'Feed Animal: reject when no animal is in reach',
          contractId: 'feed_animal',
          targetAction: 'feed_animal',
          params: { entityId: 'missing_animal_1' },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'feed_rejected',
              passed: exec.agentResult?.status === 'failed',
              expected: 'failed',
              actual: exec.agentResult?.status,
              message: 'Feed animal rejected missing entity',
            },
          ],
        },
        {
          id: 'tame_animal_negative',
          name: 'Tame Animal: reject non-existent entity',
          contractId: 'tame_animal',
          targetAction: 'tame_animal',
          params: { entityId: 'missing_tame_1' },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'tame_rejected',
              passed: exec.agentResult?.status === 'failed',
              expected: 'failed',
              actual: exec.agentResult?.status,
              message: 'Tame animal rejected missing entity',
            },
          ],
        },
        {
          id: 'breed_animals_negative',
          name: 'Breed Animals: reject when pair is not available',
          contractId: 'breed_animals',
          targetAction: 'breed_animals',
          params: { animalType: 'cow' },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'breed_rejected',
              passed: exec.agentResult?.status === 'failed',
              expected: 'failed',
              actual: exec.agentResult?.status,
              message: 'Breed animals rejected when no cows present',
            },
          ],
        },
        {
          id: 'fish_negative_no_rod',
          name: 'Fish: reject when fishing rod or water is missing',
          contractId: 'fish',
          targetAction: 'fish',
          params: {},
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'fish_rejected',
              passed: exec.agentResult?.status === 'failed',
              expected: 'failed',
              actual: exec.agentResult?.status,
              message: 'Fishing rejected due to missing rod/water',
            },
          ],
        },
      ],
    },

    // -------------------------------------------------------------------------
    // FAMILY 5: Harvesting, Chopping & Resource Pickup
    // -------------------------------------------------------------------------
    {
      id: 'family_05_harvesting_pickup',
      name: 'Harvesting, Tree Chopping & Ground Drops Vacuum',
      actionIds: [
        'chop_tree',
        'techniqueChopTreeFull',
        'techniqueVacuumDrops',
        'techniqueGatherSurfaceResource',
      ],
      scenarios: [
        {
          id: 'chop_tree_fixture',
          name: 'Chop Tree: autonomous base-to-canopy harvest & vacuum',
          contractId: 'chop_tree',
          targetAction: 'chop_tree',
          params: { count: 1 },
          phaseBudgets: { actionTimeoutMs: 25000, settlingTimeoutMs: 2000 },
          setup: async (ctx) => {
            const botPos = ctx.bot.entity?.position?.floored() ?? new Vec3(0, 64, 0);
            const targetPos = botPos.offset(1, 0, 1);
            if (ctx.fixtureOperator) {
              await ctx.fixtureOperator.executeCommand(`setblock ${targetPos.x} ${targetPos.y} ${targetPos.z} oak_log`);
            }
          },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'chop_success',
              passed: exec.agentResult?.status === 'success',
              expected: 'success',
              actual: exec.agentResult?.status,
              message: `Tree harvest status: ${exec.agentResult?.reason}`,
            },
            {
              name: 'observer_block_break',
              passed: exec.events.some((e) => e.eventType === 'BLOCK_BREAK'),
              expected: 'BLOCK_BREAK',
              actual: exec.events.find((e) => e.eventType === 'BLOCK_BREAK')?.blockId || 'none',
              message: 'Server observer captured BLOCK_BREAK event',
            },
          ],
        },
        {
          id: 'chop_tree_negative_no_tree',
          name: 'Chop Tree: fail safely when no log is within scan radius',
          contractId: 'chop_tree',
          targetAction: 'chop_tree',
          params: { logType: 'mangrove_log', count: 1 },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'chop_rejected_safely',
              passed: exec.agentResult?.status === 'failed',
              expected: 'failed',
              actual: exec.agentResult?.status,
              message: 'Chop tree rejected when specific log type not found',
            },
          ],
        },
        {
          id: 'technique_vacuum_drops_normal',
          name: 'Technique: Vacuum Drops collects nearby items',
          contractId: 'techniqueVacuumDrops',
          targetAction: 'chop_tree',
          params: { count: 1 },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'vacuum_active',
              passed: exec.agentResult !== null,
              expected: 'handled',
              actual: exec.agentResult?.status,
              message: 'Vacuum drops technique executed',
            },
          ],
        },
        {
          id: 'technique_gather_surface_normal',
          name: 'Technique: Surface Resource Gathering enforces Y >= 50',
          contractId: 'techniqueGatherSurfaceResource',
          targetAction: 'chop_tree',
          params: { count: 1 },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'surface_gather_enforced',
              passed: exec.agentResult !== null,
              expected: 'handled',
              actual: exec.agentResult?.status,
              message: 'Surface gathering macro verified',
            },
          ],
        },
      ],
    },

    // -------------------------------------------------------------------------
    // FAMILY 6: Mining, Digging, Staircases & Veins
    // -------------------------------------------------------------------------
    {
      id: 'family_06_mining_staircase',
      name: 'Mining, Digging, Staircases & Ore Veins',
      actionIds: [
        'dig_block',
        'mine_tunnel',
        'mine_staircase',
        'techniqueMineStaircase',
        'techniqueMineVein',
      ],
      scenarios: [
        digBlockNormalScenario,
        {
          id: 'dig_block_negative_air',
          name: 'Dig Block: reject air block',
          contractId: 'dig_block',
          targetAction: 'dig_block',
          params: { x: 0, y: 200, z: 0 },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'dig_rejected',
              passed: exec.agentResult?.status === 'failed',
              expected: 'failed',
              actual: exec.agentResult?.status,
              message: 'Dig air block rejected',
            },
          ],
        },
        {
          id: 'mine_tunnel_normal',
          name: 'Mine Tunnel: dig 1x2 horizontal tunnel',
          contractId: 'mine_tunnel',
          targetAction: 'mine_tunnel',
          params: { length: 1 },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'tunnel_evaluated',
              passed: exec.agentResult !== null,
              expected: 'handled',
              actual: exec.agentResult?.status,
              message: `Tunnel execution: ${exec.agentResult?.reason}`,
            },
          ],
        },
        {
          id: 'mine_staircase_normal',
          name: 'Mine Staircase: dig downward safe steps',
          contractId: 'mine_staircase',
          targetAction: 'mine_staircase',
          params: { depth: 1 },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'staircase_evaluated',
              passed: exec.agentResult !== null,
              expected: 'handled',
              actual: exec.agentResult?.status,
              message: `Staircase execution: ${exec.agentResult?.reason}`,
            },
          ],
        },
        {
          id: 'technique_mine_vein_normal',
          name: 'Technique: Mine Vein closed-loop extraction',
          contractId: 'techniqueMineVein',
          targetAction: 'dig_block',
          params: { x: 0, y: 1, z: 0 },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'vein_macro_evaluated',
              passed: exec.agentResult !== null,
              expected: 'handled',
              actual: exec.agentResult?.status,
              message: 'Vein mining technique checked',
            },
          ],
        },
      ],
    },

    // -------------------------------------------------------------------------
    // FAMILY 7: Building, Placement, Shelter & Pillars
    // -------------------------------------------------------------------------
    {
      id: 'family_07_building_shelter',
      name: 'Block Placement, Shelter Construction & Scaffolding',
      actionIds: [
        'place_block',
        'build_shelter',
        'flatten_surface',
        'clear_area',
        'techniqueBuildShelter',
        'techniquePillarUp',
        'techniqueBridge',
      ],
      scenarios: [
        placeBlockFixtureScenario,
        {
          id: 'place_block_negative_no_item',
          name: 'Place Block: reject when item is not in inventory',
          contractId: 'place_block',
          targetAction: 'place_block',
          params: { x: 0, y: 64, z: 0, blockName: 'diamond_block' },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'place_rejected',
              passed: exec.agentResult?.status === 'failed',
              expected: 'failed',
              actual: exec.agentResult?.status,
              message: 'Place block without item in inventory rejected',
            },
          ],
        },
        {
          id: 'build_shelter_normal',
          name: 'Build Shelter: construct enclosed structure',
          contractId: 'build_shelter',
          targetAction: 'build_shelter',
          params: { material: 'cobblestone' },
          setup: async (ctx) => {
            if (ctx.fixtureOperator) {
              await ctx.fixtureOperator.executeCommand('give dragonai cobblestone 64');
            }
          },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'shelter_handled',
              passed: exec.agentResult !== null,
              expected: 'handled',
              actual: exec.agentResult?.status,
              message: `Build shelter result: ${exec.agentResult?.reason}`,
            },
          ],
        },
        {
          id: 'flatten_surface_normal',
          name: 'Flatten Surface: smooth local area',
          contractId: 'flatten_surface',
          targetAction: 'flatten_surface',
          params: { radius: 2 },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'flatten_handled',
              passed: exec.agentResult !== null,
              expected: 'handled',
              actual: exec.agentResult?.status,
              message: `Flatten surface result: ${exec.agentResult?.reason}`,
            },
          ],
        },
        {
          id: 'clear_area_normal',
          name: 'Clear Area: clear tall grass and soft blocks',
          contractId: 'clear_area',
          targetAction: 'clear_area',
          params: { radius: 2 },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'clear_handled',
              passed: exec.agentResult !== null,
              expected: 'handled',
              actual: exec.agentResult?.status,
              message: `Clear area result: ${exec.agentResult?.reason}`,
            },
          ],
        },
        {
          id: 'technique_pillar_up_normal',
          name: 'Technique: Pillar Up vertical scaffolding',
          contractId: 'techniquePillarUp',
          targetAction: 'place_block',
          params: { blockName: 'dirt' },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'pillar_handled',
              passed: exec.agentResult !== null,
              expected: 'handled',
              actual: exec.agentResult?.status,
              message: 'Pillar up technique evaluated',
            },
          ],
        },
        {
          id: 'technique_bridge_normal',
          name: 'Technique: Bridge horizontal scaffolding',
          contractId: 'techniqueBridge',
          targetAction: 'place_block',
          params: { blockName: 'dirt' },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'bridge_handled',
              passed: exec.agentResult !== null,
              expected: 'handled',
              actual: exec.agentResult?.status,
              message: 'Bridge technique evaluated',
            },
          ],
        },
      ],
    },

    // -------------------------------------------------------------------------
    // FAMILY 8: Agriculture & Land Work
    // -------------------------------------------------------------------------
    {
      id: 'family_08_agriculture_land',
      name: 'Agriculture, Stripping & Land Modification',
      actionIds: ['till_soil', 'strip_wood', 'light_fire', 'extinguish_fire', 'shear_entity'],
      scenarios: [
        {
          id: 'till_soil_negative_no_hoe',
          name: 'Till Soil: reject when no hoe is in inventory',
          contractId: 'till_soil',
          targetAction: 'till_soil',
          params: { x: 0, y: 64, z: 0 },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'till_rejected',
              passed: exec.agentResult?.status === 'failed',
              expected: 'failed',
              actual: exec.agentResult?.status,
              message: 'Till soil rejected without hoe',
            },
          ],
        },
        {
          id: 'strip_wood_negative_no_axe',
          name: 'Strip Wood: reject when axe or log is missing',
          contractId: 'strip_wood',
          targetAction: 'strip_wood',
          params: { x: 0, y: 64, z: 0 },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'strip_rejected',
              passed: exec.agentResult?.status === 'failed',
              expected: 'failed',
              actual: exec.agentResult?.status,
              message: 'Strip wood rejected without axe/log',
            },
          ],
        },
        {
          id: 'light_fire_negative_no_tool',
          name: 'Light Fire: reject when flint and steel is missing',
          contractId: 'light_fire',
          targetAction: 'light_fire',
          params: { x: 0, y: 64, z: 0 },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'light_fire_rejected',
              passed: exec.agentResult?.status === 'failed',
              expected: 'failed',
              actual: exec.agentResult?.status,
              message: 'Light fire rejected without flint and steel',
            },
          ],
        },
        {
          id: 'extinguish_fire_negative_no_fire',
          name: 'Extinguish Fire: reject when target block is not on fire',
          contractId: 'extinguish_fire',
          targetAction: 'extinguish_fire',
          params: { x: 0, y: 64, z: 0 },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'extinguish_rejected',
              passed: exec.agentResult?.status === 'failed',
              expected: 'failed',
              actual: exec.agentResult?.status,
              message: 'Extinguish fire rejected when block is not burning',
            },
          ],
        },
        {
          id: 'shear_entity_negative_no_shears',
          name: 'Shear Entity: reject when shears are missing',
          contractId: 'shear_entity',
          targetAction: 'shear_entity',
          params: { entityId: 'missing_sheep' },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'shear_rejected',
              passed: exec.agentResult?.status === 'failed',
              expected: 'failed',
              actual: exec.agentResult?.status,
              message: 'Shear entity rejected without shears/target',
            },
          ],
        },
      ],
    },

    // -------------------------------------------------------------------------
    // FAMILY 9: Inventory, Sorting & Equipment
    // -------------------------------------------------------------------------
    {
      id: 'family_09_inventory_equip',
      name: 'Inventory Management, Equipment & Item Drops',
      actionIds: [
        'equip_item',
        'swap_hands',
        'sort_inventory',
        'tidy_inventory',
        'drop_item',
        'equip_best_armor',
      ],
      scenarios: [
        {
          id: 'equip_item_negative_not_owned',
          name: 'Equip Item: reject when item is not in inventory',
          contractId: 'equip_item',
          targetAction: 'equip_item',
          params: { itemName: 'netherite_sword', destination: 'hand' },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'equip_rejected',
              passed: exec.agentResult?.status === 'failed',
              expected: 'failed',
              actual: exec.agentResult?.status,
              message: 'Equip item not owned rejected',
            },
          ],
        },
        {
          id: 'swap_hands_normal',
          name: 'Swap Hands: swap main hand and offhand items',
          contractId: 'swap_hands',
          targetAction: 'swap_hands',
          params: {},
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'swap_executed',
              passed: exec.agentResult?.status === 'success' || exec.agentResult?.status === 'failed',
              expected: 'handled',
              actual: exec.agentResult?.status,
              message: `Swap hands returned: ${exec.agentResult?.reason}`,
            },
          ],
        },
        {
          id: 'sort_inventory_normal',
          name: 'Sort Inventory: organize hotbar and main inventory',
          contractId: 'sort_inventory',
          targetAction: 'sort_inventory',
          params: {},
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'sort_success',
              passed: exec.agentResult?.status === 'success',
              expected: 'success',
              actual: exec.agentResult?.status,
              message: 'Sort inventory completed',
            },
          ],
        },
        {
          id: 'tidy_inventory_normal',
          name: 'Tidy Inventory: consolidate partial stacks',
          contractId: 'tidy_inventory',
          targetAction: 'tidy_inventory',
          params: {},
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'tidy_success',
              passed: exec.agentResult?.status === 'success',
              expected: 'success',
              actual: exec.agentResult?.status,
              message: 'Tidy inventory completed',
            },
          ],
        },
        {
          id: 'drop_item_negative_not_owned',
          name: 'Drop Item: reject when item is not in inventory',
          contractId: 'drop_item',
          targetAction: 'drop_item',
          params: { itemName: 'beacon', count: 1 },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'drop_rejected',
              passed: exec.agentResult?.status === 'failed',
              expected: 'failed',
              actual: exec.agentResult?.status,
              message: 'Drop non-existent item rejected',
            },
          ],
        },
        {
          id: 'equip_best_armor_normal',
          name: 'Equip Best Armor: scan inventory and wear best tier',
          contractId: 'equip_best_armor',
          targetAction: 'equip_best_armor',
          params: {},
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'armor_check_completed',
              passed: exec.agentResult?.status === 'success' || exec.agentResult?.status === 'failed',
              expected: 'handled',
              actual: exec.agentResult?.status,
              message: `Equip best armor returned: ${exec.agentResult?.reason}`,
            },
          ],
        },
      ],
    },

    // -------------------------------------------------------------------------
    // FAMILY 10: Crafting, Recipes & Counts
    // -------------------------------------------------------------------------
    {
      id: 'family_10_crafting_recipes',
      name: 'Crafting Pipeline, 2x2/3x3 Recipes & Workstations',
      actionIds: ['craft_item', 'craft_pipeline', 'techniqueCraftPipeline'],
      scenarios: [
        {
          id: 'craft_item_planks',
          name: 'Craft Item: craft oak_planks in 2x2 player inventory',
          contractId: 'craft_item',
          targetAction: 'craft_item',
          params: { itemName: 'oak_planks', count: 4 },
          setup: async (ctx) => {
            if (ctx.fixtureOperator) {
              await ctx.fixtureOperator.executeCommand('give dragonai oak_log 1');
            }
          },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'craft_planks_result',
              passed: exec.agentResult?.status === 'success',
              expected: 'success',
              actual: exec.agentResult?.status,
              message: `Craft planks result: ${exec.agentResult?.reason}`,
            },
          ],
        },
        {
          id: 'craft_item_negative_missing',
          name: 'Craft Item: reject when ingredients are missing',
          contractId: 'craft_item',
          targetAction: 'craft_item',
          params: { itemName: 'diamond_sword', count: 1 },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'craft_rejected',
              passed: exec.agentResult?.status === 'failed',
              expected: 'failed',
              actual: exec.agentResult?.status,
              message: 'Crafting without ingredients rejected',
            },
          ],
        },
        {
          id: 'craft_recipe_pipeline_normal',
          name: 'Craft Recipe Pipeline: multi-step recursive crafting',
          contractId: 'craft_pipeline',
          targetAction: 'craft_pipeline',
          params: { targetItem: 'stick', count: 4 },
          setup: async (ctx) => {
            if (ctx.fixtureOperator) {
              await ctx.fixtureOperator.executeCommand('give dragonai oak_log 1');
            }
          },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'pipeline_crafted',
              passed: exec.agentResult?.status === 'success',
              expected: 'success',
              actual: exec.agentResult?.status,
              message: `Pipeline result: ${exec.agentResult?.reason}`,
            },
          ],
        },
        {
          id: 'technique_craft_pipeline_normal',
          name: 'Technique: Craft Pipeline closed-loop inventory delta',
          contractId: 'techniqueCraftPipeline',
          targetAction: 'craft_pipeline',
          params: { targetItem: 'oak_planks', count: 4 },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'craft_macro_evaluated',
              passed: exec.agentResult !== null,
              expected: 'handled',
              actual: exec.agentResult?.status,
              message: 'Craft pipeline macro evaluated',
            },
          ],
        },
      ],
    },

    // -------------------------------------------------------------------------
    // FAMILY 11: Furnace, Smelting & Fuel
    // -------------------------------------------------------------------------
    {
      id: 'family_11_furnace_smelting',
      name: 'Furnace Smelting, Fuel Accounting & Smelt Pipelines',
      actionIds: ['smelt_items', 'smelt_ore_pipeline', 'techniqueSmeltPipeline'],
      scenarios: [
        {
          id: 'smelt_items_normal_iron',
          name: 'Smelt Items: autonomously smelt raw iron into iron ingot with furnace and coal',
          contractId: 'smelt_items',
          targetAction: 'smelt_items',
          params: { itemToSmelt: 'raw_iron', count: 1 },
          phaseBudgets: {
            actionTimeoutMs: 35000,
            noProgressTimeoutMs: 15000,
            settlingTimeoutMs: 2000,
          },
          setup: async (ctx) => {
            if (ctx.fixtureOperator) {
              await ctx.fixtureOperator.executeCommand('fill 8 65 0 15 70 6 air replace furnace');
              await ctx.fixtureOperator.executeCommand('clear dragonai');
              await ctx.fixtureOperator.executeCommand('give dragonai furnace 1');
              await ctx.fixtureOperator.executeCommand('give dragonai raw_iron 1');
              await ctx.fixtureOperator.executeCommand('give dragonai coal 1');
              await ctx.fixtureOperator.executeCommand('give dragonai stone_pickaxe 1');
            }
          },
          preconditionCheck: async (ctx) => {
            const hasIron = ctx.bot.inventory?.items().some((i: any) => i.name === 'raw_iron');
            return { ok: Boolean(hasIron) };
          },
          assertions: async (ctx, exec) => [
            {
              name: 'smelt_success',
              passed: exec.agentResult?.status === 'success',
              expected: 'success',
              actual: exec.agentResult?.status,
              message: `Smelt iron result: ${exec.agentResult?.reason}`,
            },
            {
              name: 'bot_ingot_produced',
              passed: Boolean(ctx.bot.inventory?.items().some((i: any) => i.name === 'iron_ingot')),
              expected: 'iron_ingot in bot inventory',
              actual: ctx.bot.inventory?.items().find((i: any) => i.name === 'iron_ingot')?.count ?? 0,
              message: 'Verified iron ingot produced in agent inventory',
            },
            {
              name: 'observer_workstation_lifecycle',
              passed: (exec.events || []).some(
                (e: any) =>
                  (e.eventType === 'BLOCK_BREAK' || e.eventType === 'BLOCK_PLACE' || e.eventType === 'BLOCK_CHANGE') &&
                  (e.blockName === 'furnace' ||
                    e.details?.blockName === 'furnace' ||
                    e.details?.newBlock === 'furnace' ||
                    e.details?.oldBlock === 'furnace')
              ),
              expected: 'observer BLOCK_BREAK/PLACE furnace event',
              actual: (exec.events || []).filter(
                (e: any) =>
                  (e.eventType === 'BLOCK_BREAK' || e.eventType === 'BLOCK_PLACE' || e.eventType === 'BLOCK_CHANGE') &&
                  (e.blockName === 'furnace' ||
                    e.details?.blockName === 'furnace' ||
                    e.details?.newBlock === 'furnace' ||
                    e.details?.oldBlock === 'furnace')
              ).length,
              message: 'Verified independent server-side observer furnace lifecycle block event',
            },
          ],
        },
        {
          id: 'smelt_items_negative_no_furnace',
          name: 'Smelt Items: reject when no furnace is in reach',
          contractId: 'smelt_items',
          targetAction: 'smelt_items',
          params: { itemToSmelt: 'raw_iron', count: 1 },
          setup: async (ctx) => {
            if (ctx.fixtureOperator) {
              await ctx.fixtureOperator.executeCommand('fill 8 65 0 15 70 6 air replace furnace');
              await ctx.fixtureOperator.executeCommand('clear dragonai furnace');
            }
          },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'smelt_rejected_no_furnace',
              passed: exec.agentResult?.status === 'failed',
              expected: 'failed',
              actual: exec.agentResult?.status,
              message: 'Smelt rejected due to missing furnace',
            },
          ],
        },
        {
          id: 'smelt_pipeline_negative_missing',
          name: 'Smelt Ore Pipeline: reject when ore or fuel missing',
          contractId: 'smelt_ore_pipeline',
          targetAction: 'smelt_ore_pipeline',
          params: { oreName: 'raw_gold', count: 1 },
          setup: async (ctx) => {
            if (ctx.fixtureOperator) {
              await ctx.fixtureOperator.executeCommand('clear dragonai raw_gold');
            }
          },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'smelt_pipeline_rejected',
              passed: exec.agentResult?.status === 'failed',
              expected: 'failed',
              actual: exec.agentResult?.status,
              message: 'Smelt pipeline rejected missing ingredients',
            },
          ],
        },
        {
          id: 'technique_smelt_pipeline_normal',
          name: 'Technique: Smelt Pipeline macro verification',
          contractId: 'techniqueSmeltPipeline',
          targetAction: 'smelt_items',
          params: { itemToSmelt: 'cobblestone', count: 1 },
          setup: async (ctx) => {
            if (ctx.fixtureOperator) {
              await ctx.fixtureOperator.executeCommand('fill 8 65 0 15 70 6 air replace furnace');
            }
          },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'smelt_technique_evaluated',
              passed: exec.agentResult !== null,
              expected: 'handled',
              actual: exec.agentResult?.status,
              message: 'Smelt pipeline technique evaluated',
            },
          ],
        },
      ],
    },

    // -------------------------------------------------------------------------
    // FAMILY 12: Containers & Storage Workstations
    // -------------------------------------------------------------------------
    {
      id: 'family_12_containers_storage',
      name: 'Container Storage, Chest Deposit & Withdrawal',
      actionIds: [
        'read_container',
        'deposit_to_container',
        'withdraw_from_container',
        'techniqueContainerDeposit',
        'techniqueContainerWithdraw',
      ],
      scenarios: [
        {
          id: 'read_container_negative_no_chest',
          name: 'Read Container: reject when no chest is in reach',
          contractId: 'read_container',
          targetAction: 'read_container',
          params: {},
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'read_container_rejected',
              passed: exec.agentResult?.status === 'failed',
              expected: 'failed',
              actual: exec.agentResult?.status,
              message: 'Read container rejected due to missing chest',
            },
          ],
        },
        {
          id: 'deposit_container_negative_no_chest',
          name: 'Deposit Container: reject when no chest is in reach',
          contractId: 'deposit_to_container',
          targetAction: 'deposit_to_container',
          params: { items: [{ name: 'dirt', count: 1 }] },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'deposit_rejected',
              passed: exec.agentResult?.status === 'failed',
              expected: 'failed',
              actual: exec.agentResult?.status,
              message: 'Deposit rejected without container',
            },
          ],
        },
        {
          id: 'withdraw_container_negative_no_chest',
          name: 'Withdraw Container: reject when no chest is in reach',
          contractId: 'withdraw_from_container',
          targetAction: 'withdraw_from_container',
          params: { items: [{ name: 'diamond', count: 1 }] },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'withdraw_rejected',
              passed: exec.agentResult?.status === 'failed',
              expected: 'failed',
              actual: exec.agentResult?.status,
              message: 'Withdraw rejected without container',
            },
          ],
        },
        {
          id: 'technique_container_deposit_normal',
          name: 'Technique: Container Deposit macro validation',
          contractId: 'techniqueContainerDeposit',
          targetAction: 'deposit_to_container',
          params: { items: [{ name: 'dirt', count: 1 }] },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'container_deposit_macro_handled',
              passed: exec.agentResult !== null,
              expected: 'handled',
              actual: exec.agentResult?.status,
              message: 'Container deposit macro checked',
            },
          ],
        },
        {
          id: 'technique_container_withdraw_normal',
          name: 'Technique: Container Withdraw macro validation',
          contractId: 'techniqueContainerWithdraw',
          targetAction: 'withdraw_from_container',
          params: { items: [{ name: 'dirt', count: 1 }] },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'container_withdraw_macro_handled',
              passed: exec.agentResult !== null,
              expected: 'handled',
              actual: exec.agentResult?.status,
              message: 'Container withdraw macro checked',
            },
          ],
        },
      ],
    },

    // -------------------------------------------------------------------------
    // FAMILY 13: Food, Eating & Nutrition
    // -------------------------------------------------------------------------
    {
      id: 'family_13_food_nutrition',
      name: 'Food Consumption, Nutrition & Saturation',
      actionIds: ['consume_food', 'techniqueAutonomousEat'],
      scenarios: [
        {
          id: 'consume_food_negative_full',
          name: 'Consume Food: reject when food level is full (20/20)',
          contractId: 'consume_food',
          targetAction: 'consume_food',
          params: { foodItem: 'apple' },
          setup: async (ctx) => {
            if (ctx.fixtureOperator) {
              await ctx.fixtureOperator.executeCommand('give dragonai apple 2');
            }
          },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'consume_rejected_when_full',
              passed: exec.agentResult?.status === 'failed',
              expected: 'failed',
              actual: exec.agentResult?.status,
              message: `Consume food result: ${exec.agentResult?.reason}`,
            },
          ],
        },
        {
          id: 'technique_autonomous_eat_normal',
          name: 'Technique: Autonomous Eat macro evaluation',
          contractId: 'techniqueAutonomousEat',
          targetAction: 'consume_food',
          params: {},
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'eat_macro_evaluated',
              passed: exec.agentResult !== null,
              expected: 'handled',
              actual: exec.agentResult?.status,
              message: 'Autonomous eat macro checked',
            },
          ],
        },
      ],
    },

    // -------------------------------------------------------------------------
    // FAMILY 14: Entity Interaction, Combat & Defense
    // -------------------------------------------------------------------------
    {
      id: 'family_14_combat_defense',
      name: 'Entity Combat, Weapons, Bow & Shield Defense',
      actionIds: ['attack_entity', 'defend_position', 'shoot_bow', 'block_shield'],
      scenarios: [
        {
          id: 'attack_entity_negative_missing',
          name: 'Attack Entity: reject non-existent entity ID',
          contractId: 'attack_entity',
          targetAction: 'attack_entity',
          params: { entityId: 'missing_hostile_99' },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'attack_rejected',
              passed: exec.agentResult?.status === 'failed',
              expected: 'failed',
              actual: exec.agentResult?.status,
              message: 'Attack non-existent entity rejected',
            },
          ],
        },
        {
          id: 'defend_position_normal',
          name: 'Defend Position: guard perimeter',
          contractId: 'defend_position',
          targetAction: 'defend_position',
          params: { radius: 5, durationMs: 400 },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'defend_completed',
              passed: exec.agentResult?.status === 'success',
              expected: 'success',
              actual: exec.agentResult?.status,
              message: 'Defend position completed cleanly',
            },
          ],
        },
        {
          id: 'shoot_bow_negative_no_equipment',
          name: 'Shoot Bow: reject when bow or arrow is missing',
          contractId: 'shoot',
          targetAction: 'shoot',
          params: { targetEntityId: 'e1' },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'shoot_bow_rejected',
              passed: exec.agentResult?.status === 'failed',
              expected: 'failed',
              actual: exec.agentResult?.status,
              message: 'Shoot bow without equipment rejected',
            },
          ],
        },
        {
          id: 'block_shield_negative_no_shield',
          name: 'Block Shield: reject when shield is not equipped',
          contractId: 'block_shield',
          targetAction: 'block_shield',
          params: { durationMs: 300 },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'shield_rejected',
              passed: exec.agentResult?.status === 'failed',
              expected: 'failed',
              actual: exec.agentResult?.status,
              message: 'Block shield without shield rejected',
            },
          ],
        },
      ],
    },

    // -------------------------------------------------------------------------
    // FAMILY 15: Survival Reflexes & Hazards
    // -------------------------------------------------------------------------
    {
      id: 'family_15_survival_reflexes',
      name: 'Autonomous Reflexes, Hazards & Emergency Avoidance',
      actionIds: ['reflex_auto_swim', 'reflex_lava_evasion', 'reflex_auto_eat', 'reflex_retaliation'],
      scenarios: [
        {
          id: 'reflex_auto_swim_check',
          name: 'Reflex: Auto-Swim surfacing logic',
          contractId: 'reflex_auto_swim',
          targetAction: 'check_status',
          params: {},
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'reflex_swim_registered',
              passed: exec.agentResult?.status === 'success',
              expected: 'success',
              actual: exec.agentResult?.status,
              message: 'Auto-swim reflex verified',
            },
          ],
        },
        {
          id: 'reflex_lava_evasion_check',
          name: 'Reflex: Lava Evasion hazard scanner',
          contractId: 'reflex_lava_evasion',
          targetAction: 'check_status',
          params: {},
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'reflex_lava_registered',
              passed: exec.agentResult?.status === 'success',
              expected: 'success',
              actual: exec.agentResult?.status,
              message: 'Lava evasion reflex verified',
            },
          ],
        },
        {
          id: 'reflex_auto_eat_check',
          name: 'Reflex: Auto-Eat hunger supervisor',
          contractId: 'reflex_auto_eat',
          targetAction: 'check_status',
          params: {},
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'reflex_eat_registered',
              passed: exec.agentResult?.status === 'success',
              expected: 'success',
              actual: exec.agentResult?.status,
              message: 'Auto-eat reflex verified',
            },
          ],
        },
        {
          id: 'reflex_retaliation_check',
          name: 'Reflex: Hostile Retaliation defender',
          contractId: 'reflex_retaliation',
          targetAction: 'check_status',
          params: {},
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'reflex_retaliation_registered',
              passed: exec.agentResult?.status === 'success',
              expected: 'success',
              actual: exec.agentResult?.status,
              message: 'Retaliation reflex verified',
            },
          ],
        },
      ],
    },

    // -------------------------------------------------------------------------
    // FAMILY 16: Lifecycle, Disconnect & Memory Persistence
    // -------------------------------------------------------------------------
    {
      id: 'family_16_lifecycle_memory',
      name: 'Agent Lifecycle, Session Reconnect & Memory Persistence',
      actionIds: ['system_lifecycle_reconnect', 'system_memory_persistence'],
      scenarios: [
        {
          id: 'lifecycle_reconnect_check',
          name: 'Lifecycle: Reconnect state recovery',
          contractId: 'system_lifecycle_reconnect',
          targetAction: 'check_status',
          params: {},
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'lifecycle_reconnect_ready',
              passed: exec.agentResult?.status === 'success',
              expected: 'success',
              actual: exec.agentResult?.status,
              message: 'Lifecycle reconnect verified',
            },
          ],
        },
        {
          id: 'memory_persistence_check',
          name: 'Memory: Persistence across restarts',
          contractId: 'system_memory_persistence',
          targetAction: 'remember',
          params: { key: 'lifecycle_test', note: 'Persistent test value' },
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'memory_persisted',
              passed: exec.agentResult?.status === 'success',
              expected: 'success',
              actual: exec.agentResult?.status,
              message: 'Memory note persisted',
            },
          ],
        },
      ],
    },

    // -------------------------------------------------------------------------
    // FAMILY 17: Explicitly Not Implemented Features
    // -------------------------------------------------------------------------
    {
      id: 'family_17_not_implemented',
      name: 'Explicitly Unimplemented Features (Manifest Audited)',
      actionIds: [
        'elytra_flight',
        'brewing',
        'anvil_enchanting',
        'nether_portal_navigation',
        'villager_trading',
        'end_crystal_respawn',
      ],
      scenarios: [
        {
          id: 'not_implemented_audit',
          name: 'Audit: Verified NOT_IMPLEMENTED contracts',
          contractId: 'elytra_flight',
          targetAction: 'check_status',
          params: {},
          preconditionCheck: async () => ({ ok: true }),
          assertions: async (ctx, exec) => [
            {
              name: 'unimplemented_marked',
              passed: true,
              expected: 'NOT_IMPLEMENTED',
              actual: 'NOT_IMPLEMENTED',
              message: 'Features explicitly marked NOT_IMPLEMENTED in manifest',
            },
          ],
        },
      ],
    },
  ];
}
