import { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { goals } from 'mineflayer-pathfinder';
import { ActionDef, ActionExecutionContext, ActionResult } from '../types/index.js';
import { distance3D } from '../utils/math.js';

export const movementActions: ActionDef[] = [
  {
    name: 'goto',
    category: 'movement',
    description: 'Walk or pathfind to a target entity, notable block, or bounded coordinates.',
    parameterSchema: {
      targetId: { type: 'string', description: 'Entity ID (e.g. e1) or notable block name' },
      x: { type: 'number', description: 'Optional target X coordinate' },
      y: { type: 'number', description: 'Optional target Y coordinate' },
      z: { type: 'number', description: 'Optional target Z coordinate' },
      range: { type: 'number', description: 'Stopping distance (default 1.5 blocks)' },
    },
    isAvailable: (bot, obs) => {
      return obs.vitals.isAlive && !obs.vitals.movementState.isSleeping && !obs.vitals.movementState.isRiding && !obs.container.isOpen;
    },
    getAvailableChoices: (bot, obs) => {
      const targets: string[] = [];
      obs.entities.forEach((e) => targets.push(e.id));
      obs.blocks.notableBlocks.forEach((b) => targets.push(b.name));
      return { targetId: targets };
    },
    execute: async (bot: Bot, params: any, ctx: ActionExecutionContext): Promise<ActionResult> => {
      const range = params.range || 1.5;
      let targetPos: Vec3 | null = null;

      if (params.targetId) {
        if (params.targetId.startsWith('e')) {
          const ent = ctx.observation.entities.find((e) => e.id === params.targetId);
          if (ent) {
            targetPos = new Vec3(ent.position.x, ent.position.y, ent.position.z);
          }
        } else {
          const block = bot.findBlock({
            matching: (b) => b.name === params.targetId,
            maxDistance: ctx.config.perception.scanRadius || 16,
          });
          if (block) targetPos = block.position;
        }
      } else if (params.x !== undefined && params.y !== undefined && params.z !== undefined) {
        targetPos = new Vec3(params.x, params.y, params.z);
      }

      if (!targetPos) {
        return { status: 'failed', reason: 'Target position could not be resolved or found.' };
      }

      const dist = distance3D(bot.entity.position, targetPos);
      if (dist <= range) {
        return { status: 'success', reason: `Already within range (${dist.toFixed(1)} blocks).` };
      }

      try {
        const goal = new goals.GoalNear(targetPos.x, targetPos.y, targetPos.z, range);
        await (bot as any).pathfinder.goto(goal);
        return { status: 'success', reason: `Reached target at ${targetPos.x}, ${targetPos.y}, ${targetPos.z}` };
      } catch (err: any) {
        return { status: 'failed', reason: `Pathfinding failed: ${err.message || 'path unreachable'}` };
      }
    },
  },
  {
    name: 'follow',
    category: 'movement',
    description: 'Follow a player or entity within a specified distance.',
    parameterSchema: {
      targetId: { type: 'string', description: 'Target entity ID (e.g. e1) or player name' },
      distance: { type: 'number', description: 'Follow distance (default 3 blocks)' },
    },
    isAvailable: (bot, obs) => {
      return obs.vitals.isAlive && obs.entities.length > 0 && !obs.container.isOpen;
    },
    getAvailableChoices: (bot, obs) => {
      return { targetId: obs.entities.map((e) => e.id) };
    },
    execute: async (bot: Bot, params: any, ctx: ActionExecutionContext): Promise<ActionResult> => {
      const entInfo = ctx.observation.entities.find((e) => e.id === params.targetId || e.name === params.targetId);
      if (!entInfo) {
        return { status: 'failed', reason: `Entity ${params.targetId} not found.` };
      }
      const rawEntity = bot.entities[entInfo.rawId];
      if (!rawEntity) {
        return { status: 'failed', reason: `Entity ${entInfo.name} no longer in range.` };
      }

      const dist = params.distance || 3;
      try {
        const goal = new goals.GoalFollow(rawEntity, dist);
        // Follow for a short duration (up to 5 seconds)
        (bot as any).pathfinder.setGoal(goal, true);
        await new Promise((res) => setTimeout(res, 3000));
        (bot as any).pathfinder.setGoal(null);
        return { status: 'success', reason: `Followed ${entInfo.name} successfully.` };
      } catch (err: any) {
        return { status: 'failed', reason: `Follow failed: ${err.message}` };
      }
    },
  },
  {
    name: 'flee',
    category: 'movement',
    description: 'Run away from a hostile mob or threat position.',
    parameterSchema: {
      threatId: { type: 'string', description: 'Entity ID to flee from' },
      distance: { type: 'number', description: 'Distance to put between bot and threat' },
    },
    isAvailable: (bot, obs) => {
      return obs.vitals.isAlive && obs.entities.some((e) => e.isHostile);
    },
    getAvailableChoices: (bot, obs) => {
      return { threatId: obs.entities.filter((e) => e.isHostile).map((e) => e.id) };
    },
    execute: async (bot: Bot, params: any, ctx: ActionExecutionContext): Promise<ActionResult> => {
      const threat = ctx.observation.entities.find((e) => e.id === params.threatId) || ctx.observation.entities.find((e) => e.isHostile);
      if (!threat) {
        return { status: 'failed', reason: 'No threat found to flee from.' };
      }

      const threatPos = new Vec3(threat.position.x, threat.position.y, threat.position.z);
      const botPos = bot.entity.position;
      const fleeVec = botPos.minus(threatPos).normalize().scaled(params.distance || 10);
      const destination = botPos.plus(fleeVec);

      try {
        bot.setControlState('sprint', true);
        const goal = new goals.GoalNear(destination.x, destination.y, destination.z, 2);
        await (bot as any).pathfinder.goto(goal);
        bot.setControlState('sprint', false);
        return { status: 'success', reason: `Fled from threat to safe distance.` };
      } catch (err: any) {
        bot.setControlState('sprint', false);
        return { status: 'failed', reason: `Flee path obstructed: ${err.message}` };
      }
    },
  },
  {
    name: 'move',
    category: 'movement',
    description: 'Walk in a basic direction for a short duration (0.5 - 2s).',
    parameterSchema: {
      direction: { type: 'string', enum: ['forward', 'back', 'left', 'right'] },
      durationMs: { type: 'number', description: 'Duration in milliseconds (500 to 2000)' },
    },
    isAvailable: (bot, obs) => obs.vitals.isAlive && !obs.vitals.movementState.isSleeping && !obs.container.isOpen,
    getAvailableChoices: () => ({ direction: ['forward', 'back', 'left', 'right'] }),
    execute: async (bot: Bot, params: any): Promise<ActionResult> => {
      const dir = params.direction || 'forward';
      const duration = Math.min(Math.max(params.durationMs || 800, 200), 2500);

      bot.setControlState(dir, true);
      await new Promise((res) => setTimeout(res, duration));
      bot.setControlState(dir, false);
      return { status: 'success', reason: `Moved ${dir} for ${duration}ms.` };
    },
  },
  {
    name: 'jump',
    category: 'movement',
    description: 'Perform a single jump.',
    parameterSchema: {},
    isAvailable: (bot, obs) => obs.vitals.isAlive && (obs.vitals.movementState.onGround || obs.vitals.movementState.inWater),
    execute: async (bot: Bot): Promise<ActionResult> => {
      bot.setControlState('jump', true);
      await new Promise((res) => setTimeout(res, 350));
      bot.setControlState('jump', false);
      return { status: 'success', reason: 'Jumped.' };
    },
  },
  {
    name: 'swim_up',
    category: 'movement',
    description: 'Swim towards the water surface to breathe air.',
    parameterSchema: {},
    isAvailable: (bot, obs) => obs.vitals.movementState.inWater,
    execute: async (bot: Bot): Promise<ActionResult> => {
      bot.setControlState('jump', true);
      await new Promise((res) => setTimeout(res, 1200));
      bot.setControlState('jump', false);
      return { status: 'success', reason: 'Swam upward toward air.' };
    },
  },
  {
    name: 'sprint',
    category: 'movement',
    description: 'Toggle sprint on or off.',
    parameterSchema: {
      enabled: { type: 'boolean' },
    },
    isAvailable: (bot, obs) => obs.vitals.isAlive && obs.vitals.food > 6,
    execute: async (bot: Bot, params: any): Promise<ActionResult> => {
      const on = Boolean(params.enabled);
      bot.setControlState('sprint', on);
      return { status: 'success', reason: `Sprint set to ${on}.` };
    },
  },
  {
    name: 'sneak',
    category: 'movement',
    description: 'Toggle sneaking (crouch) on or off.',
    parameterSchema: {
      enabled: { type: 'boolean' },
    },
    isAvailable: (bot, obs) => obs.vitals.isAlive && !obs.vitals.movementState.isSleeping,
    execute: async (bot: Bot, params: any): Promise<ActionResult> => {
      const on = Boolean(params.enabled);
      bot.setControlState('sneak', on);
      return { status: 'success', reason: `Sneak set to ${on}.` };
    },
  },
  {
    name: 'look_at',
    category: 'movement',
    description: 'Look at a specific entity, block, or position.',
    parameterSchema: {
      targetId: { type: 'string' },
      x: { type: 'number' },
      y: { type: 'number' },
      z: { type: 'number' },
    },
    isAvailable: (bot, obs) => obs.vitals.isAlive && !obs.vitals.movementState.isSleeping,
    execute: async (bot: Bot, params: any, ctx: ActionExecutionContext): Promise<ActionResult> => {
      let lookPos: Vec3 | null = null;
      if (params.targetId) {
        const ent = ctx.observation.entities.find((e) => e.id === params.targetId);
        if (ent) lookPos = new Vec3(ent.position.x, ent.position.y + 1, ent.position.z);
      } else if (params.x !== undefined && params.y !== undefined && params.z !== undefined) {
        lookPos = new Vec3(params.x, params.y, params.z);
      }

      if (!lookPos) return { status: 'failed', reason: 'Look target position not resolved.' };

      await bot.lookAt(lookPos, true);
      return { status: 'success', reason: `Looking at ${lookPos.x}, ${lookPos.y}, ${lookPos.z}.` };
    },
  },
  {
    name: 'explore',
    category: 'movement',
    description: 'Walk in a chosen cardinal direction to explore terrain.',
    parameterSchema: {
      direction: { type: 'string', enum: ['north', 'south', 'east', 'west'] },
      distance: { type: 'number', description: 'Blocks to explore forward (default 12)' },
    },
    isAvailable: (bot, obs) => obs.vitals.isAlive && !obs.container.isOpen,
    getAvailableChoices: () => ({ direction: ['north', 'south', 'east', 'west'] }),
    execute: async (bot: Bot, params: any): Promise<ActionResult> => {
      const dir = params.direction || 'north';
      const dist = Math.min(params.distance || 12, 20);

      const botPos = bot.entity.position;
      let target = botPos.clone();
      if (dir === 'north') target = target.offset(0, 0, -dist);
      else if (dir === 'south') target = target.offset(0, 0, dist);
      else if (dir === 'east') target = target.offset(dist, 0, 0);
      else if (dir === 'west') target = target.offset(-dist, 0, 0);

      try {
        const goal = new goals.GoalNear(target.x, target.y, target.z, 2);
        await (bot as any).pathfinder.goto(goal);
        return { status: 'success', reason: `Explored ${dist} blocks ${dir}.` };
      } catch (err: any) {
        return { status: 'failed', reason: `Exploration path blocked: ${err.message}` };
      }
    },
  },
  {
    name: 'stop',
    category: 'movement',
    description: 'Stop all active pathfinding and movement controls immediately.',
    parameterSchema: {},
    isAvailable: () => true,
    execute: async (bot: Bot): Promise<ActionResult> => {
      try {
        (bot as any).pathfinder.stop();
      } catch {}
      bot.clearControlStates();
      return { status: 'success', reason: 'Stopped all movement.' };
    },
  },
];
