import { Bot } from 'mineflayer';
import { ActionDef, ActionExecutionContext, ActionResult } from '../types/index.js';

let lastChatTimestamp = 0;

export const metaActions: ActionDef[] = [
  {
    name: 'chat',
    category: 'meta',
    description: 'Send a message in in-game public chat (rate limited).',
    parameterSchema: {
      message: { type: 'string', description: 'Chat text to send' },
    },
    isAvailable: () => true,
    execute: async (bot: Bot, params: any): Promise<ActionResult> => {
      const now = Date.now();
      if (now - lastChatTimestamp < 1500) {
        return { status: 'failed', reason: 'Chat rate limit: please wait 1.5s between messages.' };
      }
      lastChatTimestamp = now;

      const message = String(params.message || '').slice(0, 200);
      bot.chat(message);
      return { status: 'success', reason: `Chatted: "${message}"` };
    },
  },
  {
    name: 'wait',
    category: 'meta',
    description: 'Wait / idle for a duration of seconds (up to 10s, interruptible).',
    parameterSchema: {
      seconds: { type: 'number', minimum: 1, maximum: 10 },
    },
    isAvailable: () => true,
    execute: async (bot: Bot, params: any): Promise<ActionResult> => {
      const sec = Math.min(Math.max(params.seconds || 2, 0.5), 10);
      await new Promise((res) => setTimeout(res, sec * 1000));
      return { status: 'success', reason: `Waited for ${sec}s.` };
    },
  },
  {
    name: 'remember',
    category: 'meta',
    description: 'Store a memory note or named location in persistent world memory.',
    parameterSchema: {
      locationName: { type: 'string' },
      x: { type: 'number' },
      y: { type: 'number' },
      z: { type: 'number' },
      fact: { type: 'string' },
    },
    isAvailable: () => true,
    execute: async (bot: Bot, params: any, ctx: ActionExecutionContext): Promise<ActionResult> => {
      if (params.locationName) {
        const x = params.x ?? bot.entity.position.x;
        const y = params.y ?? bot.entity.position.y;
        const z = params.z ?? bot.entity.position.z;
        ctx.observation.memory.namedLocations[params.locationName] = {
          x: Math.round(x),
          y: Math.round(y),
          z: Math.round(z),
        };
        return { status: 'success', reason: `Remembered location '${params.locationName}' at ${Math.round(x)}, ${Math.round(y)}, ${Math.round(z)}.` };
      }

      if (params.fact) {
        ctx.observation.memory.facts.push(params.fact);
        return { status: 'success', reason: `Remembered fact: "${params.fact}".` };
      }

      return { status: 'failed', reason: 'Nothing to remember (provide locationName or fact).' };
    },
  },
  {
    name: 'set_goal',
    category: 'meta',
    description: 'Update the high-level goal and plan steps.',
    parameterSchema: {
      goal: { type: 'string' },
      planSteps: { type: 'array', items: { type: 'string' } },
    },
    isAvailable: () => true,
    execute: async (bot: Bot, params: any, ctx: ActionExecutionContext): Promise<ActionResult> => {
      if (params.goal) {
        ctx.observation.agentState.currentGoal = params.goal;
      }
      if (Array.isArray(params.planSteps)) {
        ctx.observation.agentState.planSteps = params.planSteps.map((s: any) => ({ step: String(s), completed: false }));
      }
      return { status: 'success', reason: `Updated goal to: "${ctx.observation.agentState.currentGoal}" with ${ctx.observation.agentState.planSteps.length} step(s).` };
    },
  },
  {
    name: 'respawn',
    category: 'meta',
    description: 'Trigger respawn after dying.',
    parameterSchema: {},
    isAvailable: (bot, obs) => !obs.vitals.isAlive,
    execute: async (bot: Bot): Promise<ActionResult> => {
      try {
        bot.respawn();
        return { status: 'success', reason: 'Respawned bot.' };
      } catch (err: any) {
        return { status: 'failed', reason: `Respawn failed: ${err.message}` };
      }
    },
  },
  {
    name: 'run_command',
    category: 'meta',
    description: 'Execute a server command (disabled by default, strictly checked against allowlist).',
    parameterSchema: {
      command: { type: 'string' },
    },
    isAvailable: (bot, obs, ctx) => {
      return Boolean(ctx.config.safety.allowCommandExecution);
    },
    execute: async (bot: Bot, params: any, ctx: ActionExecutionContext): Promise<ActionResult> => {
      if (!ctx.config.safety.allowCommandExecution) {
        return { status: 'failed', reason: 'Safety violation: Command execution is disabled in config.' };
      }

      const cmd = String(params.command || '').trim().replace(/^\//, '');
      const baseCmd = cmd.split(' ')[0];
      if (!ctx.config.safety.commandAllowlist.includes(baseCmd)) {
        return { status: 'failed', reason: `Command '${baseCmd}' is not in the allowlist.` };
      }

      bot.chat(`/${cmd}`);
      return { status: 'success', reason: `Executed command: /${cmd}` };
    },
  },
];
