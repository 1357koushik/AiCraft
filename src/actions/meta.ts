import { Bot } from 'mineflayer';
import { ActionDef, ActionExecutionContext, ActionResult } from '../types/index.js';
import { parsePlanStep } from '../memory/index.js';

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
      const raw = String(params.message || '');
      // Strip leading whitespace, unicode zero-width spaces, and control characters to prevent command bypass
      const sanitized = raw.replace(/^[\s\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]+/, '');
      if (sanitized.startsWith('/') || sanitized.startsWith('!')) {
        return {
          status: 'failed',
          reason: 'Safety violation: Slash commands or control prefixes cannot be executed via public chat. Use run_command if authorized.',
        };
      }

      const message = raw.trim().slice(0, 200);
      if (!message) {
        return { status: 'failed', reason: 'Empty chat message.' };
      }

      const now = Date.now();
      if (now - lastChatTimestamp < 1500) {
        return { status: 'failed', reason: 'Chat rate limit: please wait 1.5s between messages.' };
      }
      lastChatTimestamp = now;

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
    execute: async (bot: Bot, params: any, ctx?: ActionExecutionContext): Promise<ActionResult> => {
      if (ctx?.abortSignal?.aborted || (ctx?.isCurrent && !ctx.isCurrent())) {
        return { status: 'interrupted', reason: 'Wait cancelled before start.' };
      }
      const sec = Math.min(Math.max(params.seconds || 2, 0.5), 10);
      const ms = sec * 1000;

      let timer: NodeJS.Timeout | null = null;
      let onAbort: (() => void) | null = null;

      try {
        await new Promise<void>((resolve, reject) => {
          timer = setTimeout(resolve, ms);
          if (ctx?.abortSignal) {
            onAbort = () => {
              if (timer) clearTimeout(timer);
              reject(new Error('Wait interrupted by cancellation signal.'));
            };
            if (ctx.abortSignal.aborted) {
              onAbort();
            } else {
              ctx.abortSignal.addEventListener('abort', onAbort, { once: true });
            }
          }
        });
        return { status: 'success', reason: `Waited for ${sec}s.` };
      } catch (err: any) {
        return { status: 'interrupted', reason: err.message || 'Wait interrupted.' };
      } finally {
        if (timer) clearTimeout(timer);
        if (ctx?.abortSignal && onAbort) {
          ctx.abortSignal.removeEventListener('abort', onAbort);
        }
      }
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

      if (params.key && params.value) {
        ctx.observation.memory.facts.push(`${params.key}: ${params.value}`);
        return { status: 'success', reason: `Remembered key-value: "${params.key}: ${params.value}".` };
      }

      return { status: 'failed', reason: 'Nothing to remember (provide locationName, fact, or key/value).' };
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
      const goalStr = typeof params.goal === 'string' ? params.goal.trim() : null;
      if (params.goal !== undefined && (!goalStr || goalStr.length === 0)) {
        return { status: 'failed', reason: 'Invalid goal: goal string cannot be empty or whitespace-only.' };
      }
      const hasValidSteps = Array.isArray(params.planSteps) && params.planSteps.length > 0;
      if (!goalStr && !hasValidSteps) {
        return { status: 'failed', reason: 'Invalid parameters: must provide non-empty goal or non-empty planSteps.' };
      }
      if (params.planSteps !== undefined && !Array.isArray(params.planSteps)) {
        return { status: 'failed', reason: 'Invalid planSteps: must be an array of strings.' };
      }

      if (goalStr && ctx?.observation?.agentState) {
        ctx.observation.agentState.currentGoal = goalStr;
      }
      if (Array.isArray(params.planSteps) && ctx?.observation?.agentState) {
        ctx.observation.agentState.planSteps = params.planSteps.map((s: any) => parsePlanStep(s));
      }

      const current = ctx?.observation?.agentState?.currentGoal || goalStr || '';
      const stepCount = ctx?.observation?.agentState?.planSteps?.length || (Array.isArray(params.planSteps) ? params.planSteps.length : 0);
      return { status: 'success', reason: `Updated goal to: "${current}" with ${stepCount} step(s).` };
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

      const rawCmd = String(params.command || '');
      const sanitized = rawCmd.replace(/^[\s\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]+/, '');
      if (!sanitized) {
        return { status: 'failed', reason: 'Empty command string.' };
      }

      // Reject shell operators, command chaining, redirection, control characters, null bytes
      if (/[\n\r\u0000-\u001F\u007F-\u009F;&|`$><\\]/.test(rawCmd)) {
        return {
          status: 'failed',
          reason: 'Command injection rejected: control characters, chaining, pipes, or shell operators are forbidden.',
        };
      }

      const cmd = sanitized.replace(/^\//, '').trim();
      const tokens = cmd.split(/\s+/);
      const baseCmd = tokens[0]?.toLowerCase();
      const allowlist = ctx.config.safety.commandAllowlist.map((c: string) => c.toLowerCase());

      if (!baseCmd || !allowlist.includes(baseCmd)) {
        return { status: 'failed', reason: `Command '${baseCmd}' is not permitted by command allowlist.` };
      }

      // Strictly execute as in-game Minecraft chat command (/cmd), NEVER as OS shell
      bot.chat(`/${cmd}`);
      return { status: 'success', reason: `Executed in-game command: /${cmd}` };
    },
  },
];
