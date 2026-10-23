import { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { goals } from 'mineflayer-pathfinder';
import { ActionDef, ActionExecutionContext, ActionResult } from '../types/index.js';
import { distance3D } from '../utils/math.js';
import { updatePathfinderMovements, techniquePillarUp, techniqueBridge, isMatchingResourceBlock } from './techniques.js';
import { isActionContextActive } from '../agent/arbiter.js';
import { navigateWithBounds, evaluateCandidateTarget, navigationBlacklist } from './navigator.js';

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

      if (ctx.abortSignal?.aborted) {
        return { status: 'interrupted', reason: 'Goto cancelled before start.' };
      }

      let isHorizontalOnly = false;
      if (params.targetId) {
        if (params.targetId.startsWith('e')) {
          const ent = ctx.observation?.entities?.find((e) => e.id === params.targetId);
          if (ent) {
            targetPos = new Vec3(ent.position.x, ent.position.y, ent.position.z);
          } else {
            return { status: 'failed', reason: `Target entity ${params.targetId} not found (stale target).` };
          }
        } else {
          const block = bot.findBlock
            ? bot.findBlock({
                matching: (b) => b.name === params.targetId,
                maxDistance: ctx.config?.perception?.scanRadius || 16,
              })
            : null;
          if (block) {
            targetPos = block.position;
          } else {
            return { status: 'failed', reason: `Target block ${params.targetId} not found.` };
          }
        }
      } else if (params.x !== undefined && params.z !== undefined) {
        if (params.y !== undefined) {
          targetPos = new Vec3(params.x, params.y, params.z);
          isHorizontalOnly = false;
        } else {
          targetPos = new Vec3(params.x, bot.entity?.position?.y ?? 64, params.z);
          isHorizontalOnly = true;
        }
      }

      if (!targetPos) {
        return { status: 'failed', reason: 'Target position could not be resolved or found.' };
      }

      const dist = distance3D(bot.entity.position, targetPos);
      const maxAllowedDist = Math.max(32, (ctx.config?.perception?.scanRadius || 16) * 3);
      if (dist > maxAllowedDist) {
        return {
          status: 'failed',
          reason: `Target position too far away (${dist.toFixed(1)} blocks > max ${maxAllowedDist} blocks). Coordinates must be bounded.`,
        };
      }

      console.log(`[GOTO] Navigating to (${targetPos.x.toFixed(1)}, ${targetPos.y.toFixed(1)}, ${targetPos.z.toFixed(1)}) [dist: ${dist.toFixed(1)}m, range: ${range}m, goal: ${isHorizontalOnly ? 'GoalNearXZ' : 'GoalNear'}]...`);

      const navResult = await navigateWithBounds(
        bot,
        {
          target: targetPos,
          range,
          intent: isHorizontalOnly ? 'horizontal' : '3d',
          ...((params as any)?.verifyArrival !== undefined ? { verifyArrival: (params as any).verifyArrival } : {}),
        },
        ctx
      );

      if (navResult.success) {
        console.log(`[GOTO] Successfully arrived at (${targetPos.x.toFixed(1)}, ${targetPos.y.toFixed(1)}, ${targetPos.z.toFixed(1)})!`);
        return {
          status: 'success',
          reason: `Reached target at ${targetPos.x}, ${targetPos.y}, ${targetPos.z}`,
          details: { attempt: navResult.attempt },
        };
      }

      if (navResult.status === 'cancelled') {
        return {
          status: 'interrupted',
          reason: navResult.reason,
          details: { attempt: navResult.attempt },
        };
      }

      console.log(`[GOTO] Navigation failed: ${navResult.reason}`);
      return {
        status: 'failed',
        reason: navResult.reason,
        details: { failureKind: navResult.failureKind, attempt: navResult.attempt },
      };
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
      if (ctx.abortSignal?.aborted) {
        return { status: 'interrupted', reason: 'Follow cancelled before start.' };
      }
      const entInfo = ctx.observation.entities.find((e) => e.id === params.targetId || e.name === params.targetId);
      if (!entInfo) {
        return { status: 'failed', reason: `Entity ${params.targetId} not found.` };
      }
      const rawEntity = bot.entities[entInfo.rawId];
      if (!rawEntity) {
        return { status: 'failed', reason: `Entity ${entInfo.name} no longer in range.` };
      }

      const dist = params.distance || 3;
      if (Boolean((rawEntity as any).isInWater) && !Boolean((bot.entity as any)?.isInWater)) {
        return { status: 'failed', reason: 'Target entity entered water. Halting follow to prevent drowning.' };
      }
      let onAbort: (() => void) | null = null;
      try {
        updatePathfinderMovements(bot);
        const goal = new goals.GoalFollow(rawEntity, dist);
        if (ctx.abortSignal) {
          onAbort = () => {
            try {
              (bot as any).pathfinder?.stop();
              (bot as any).pathfinder?.setGoal(null);
            } catch {}
            bot.clearControlStates();
          };
          ctx.abortSignal.addEventListener('abort', onAbort, { once: true });
        }
        (bot as any).pathfinder.setGoal(goal, true);

        // Follow for a short duration while monitoring abort signal
        for (let t = 0; t < 10; t++) {
          if (ctx.abortSignal?.aborted) {
            return { status: 'interrupted', reason: 'Follow cancelled by preemption signal.' };
          }
          await new Promise((res) => setTimeout(res, 300));
        }

        return { status: 'success', reason: `Followed ${entInfo.name} successfully.` };
      } catch (err: any) {
        if (ctx.abortSignal?.aborted) {
          return { status: 'interrupted', reason: 'Follow cancelled by preemption signal.' };
        }
        return { status: 'failed', reason: `Follow failed: ${err.message}` };
      } finally {
        if (ctx.abortSignal && onAbort) {
          ctx.abortSignal.removeEventListener('abort', onAbort);
        }
        if (isActionContextActive(ctx)) {
          try {
            (bot as any).pathfinder?.setGoal(null);
            (bot as any).pathfinder?.stop();
          } catch {}
          bot.clearControlStates();
        }
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
      if (ctx.abortSignal?.aborted) {
        return { status: 'interrupted', reason: 'Flee cancelled before start.' };
      }
      const threat = ctx.observation.entities.find((e) => e.id === params.threatId) || ctx.observation.entities.find((e) => e.isHostile);
      if (!threat) {
        return { status: 'failed', reason: 'No threat found to flee from.' };
      }

      const threatPos = new Vec3(threat.position.x, threat.position.y, threat.position.z);
      const botPos = bot.entity.position;
      const rawFleeVec = botPos.minus(threatPos);
      const horizontalDist = Math.hypot(rawFleeVec.x, rawFleeVec.z) || 1;
      const fleeDist = params.distance || 10;
      const normX = rawFleeVec.x / horizontalDist;
      const normZ = rawFleeVec.z / horizontalDist;

      // Primary flee destination directly opposite threat, plus angled candidate escape paths (+60°, -60°)
      const angles = [0, Math.PI / 3, -Math.PI / 3];
      const candidateDests: Vec3[] = angles.map((angle) => {
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const rx = normX * cos - normZ * sin;
        const rz = normX * sin + normZ * cos;
        return new Vec3(botPos.x + rx * fleeDist, botPos.y, botPos.z + rz * fleeDist);
      }).filter((dest) => {
        if (!bot.blockAt) return true;
        const b = bot.blockAt(dest);
        const bg = bot.blockAt(dest.offset(0, -1, 0));
        const isWater = b?.name === 'water' || b?.name === 'flowing_water' || bg?.name === 'water' || bg?.name === 'flowing_water';
        return !isWater;
      });

      let onAbort: (() => void) | null = null;
      if (ctx.abortSignal) {
        onAbort = () => {
          try {
            (bot as any).pathfinder?.stop();
            (bot as any).pathfinder?.setGoal(null);
          } catch {}
          bot.clearControlStates();
        };
        ctx.abortSignal.addEventListener('abort', onAbort, { once: true });
      }

      try {
        updatePathfinderMovements(bot);
        bot.setControlState('sprint', true);

        for (let i = 0; i < candidateDests.length; i++) {
          if (ctx.abortSignal?.aborted || !isActionContextActive(ctx)) {
            return { status: 'interrupted', reason: 'Flee cancelled by preemption signal.' };
          }
          const destination = candidateDests[i];
          try {
            // Use GoalNearXZ so natural terrain slopes/elevation changes do not cause 50ms altitude lockout
            const goal = new goals.GoalNearXZ(destination.x, destination.z, 2);
            await (bot as any).pathfinder.goto(goal);
            return {
              status: 'success',
              reason: i === 0 ? 'Fled from threat to safe distance.' : 'Fled from threat via angled escape trajectory.',
            };
          } catch (err: any) {
            if (ctx.abortSignal?.aborted || !isActionContextActive(ctx)) {
              return { status: 'interrupted', reason: 'Flee cancelled by preemption signal.' };
            }
            ctx.logger?.debug?.(`Flee trajectory ${i} blocked (${err.message}). Trying alternate angle...`);
          }
        }
        return { status: 'failed', reason: 'All flee escape paths obstructed around current position.' };
      } finally {
        if (ctx.abortSignal && onAbort) {
          ctx.abortSignal.removeEventListener('abort', onAbort);
        }
        if (isActionContextActive(ctx)) {
          try {
            (bot as any).pathfinder?.stop();
          } catch {}
          bot.clearControlStates();
        }
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
    execute: async (bot: Bot, params: any, ctx: ActionExecutionContext): Promise<ActionResult> => {
      if (ctx.abortSignal?.aborted) {
        return { status: 'interrupted', reason: 'Move cancelled before start.' };
      }
      const dir = params.direction || 'forward';
      const duration = Math.min(Math.max(params.durationMs || 800, 200), 2500);

      try {
        bot.setControlState(dir, true);
        const interval = 50;
        const loops = Math.ceil(duration / interval);
        for (let i = 0; i < loops; i++) {
          if (ctx.abortSignal?.aborted) {
            return { status: 'interrupted', reason: 'Move cancelled by preemption signal.' };
          }
          if (Boolean((bot.entity as any)?.isInWater)) {
            return { status: 'failed', reason: 'Move halted: entered water hazard.' };
          }
          await new Promise((res) => setTimeout(res, interval));
        }
        return { status: 'success', reason: `Moved ${dir} for ${duration}ms.` };
      } finally {
        if (isActionContextActive(ctx)) {
          bot.setControlState(dir, false);
          bot.clearControlStates();
        }
      }
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
    execute: async (bot: Bot, params: any, ctx: ActionExecutionContext): Promise<ActionResult> => {
      const inWater = Boolean(
        (bot.entity as any)?.isInWater ||
        (bot as any).controlStates?.underwater ||
        ctx?.observation?.vitals?.movementState?.inWater ||
        (bot.blockAt && bot.entity?.position && ['water', 'flowing_water'].includes(bot.blockAt(bot.entity.position)?.name || ''))
      );
      if (!inWater) {
        return { status: 'failed', reason: 'Cannot swim up: bot is not in water.' };
      }
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
    description: 'Goal-directed exploration: searches for a specific target resource/feature (e.g. wood, stone, coal, iron, animal, shelter) or scans terrain in safe direction.',
    parameterSchema: {
      target: { type: 'string', description: 'Resource or feature to search for (e.g. wood, stone, coal, iron, animal, water, shelter)' },
      direction: { type: 'string', enum: ['north', 'south', 'east', 'west'], description: 'Optional direction preference' },
      distance: { type: 'number', description: 'Blocks to explore forward (default 16)' },
    },
    isAvailable: (bot, obs) => obs.vitals.isAlive && !obs.container.isOpen,
    getAvailableChoices: () => ({
      direction: ['north', 'south', 'east', 'west'],
      target: ['wood', 'stone', 'coal', 'iron', 'animal', 'shelter', 'water'],
    }),
    execute: async (bot: Bot, params: any, ctx: ActionExecutionContext): Promise<ActionResult> => {
      if (ctx.abortSignal?.aborted) {
        return { status: 'interrupted', reason: 'Explore cancelled before start.' };
      }

      const target = params.target?.toLowerCase();
      const dist = Math.min(params.distance || 16, 24);

      // 1. If target is specified, check if it's ALREADY visible nearby
      if (target) {
        if (target === 'wood' || target === 'log' || target === 'tree') {
          const tree = bot.findBlock ? bot.findBlock({ matching: (b) => b.name.includes('_log'), maxDistance: 48 }) : null;
          if (tree) {
            return {
              status: 'success',
              reason: `Discovered tree at (${tree.position.x}, ${tree.position.y}, ${tree.position.z})! Use chop_tree or collect_resource to gather wood.`,
            };
          }
        } else if (target === 'stone' || target === 'cobblestone') {
          const stone = bot.findBlock ? bot.findBlock({ matching: (b) => isMatchingResourceBlock(b.name, 'stone'), maxDistance: 48 }) : null;
          if (stone) {
            return {
              status: 'success',
              reason: `Discovered stone at (${stone.position.x}, ${stone.position.y}, ${stone.position.z})! Use collect_resource to mine cobblestone.`,
            };
          }
        } else if (target === 'coal') {
          const coal = bot.findBlock ? bot.findBlock({ matching: (b) => isMatchingResourceBlock(b.name, 'coal'), maxDistance: 48 }) : null;
          if (coal) {
            return {
              status: 'success',
              reason: `Discovered coal ore at (${coal.position.x}, ${coal.position.y}, ${coal.position.z})! Ready to mine.`,
            };
          }
        } else if (target === 'iron') {
          const iron = bot.findBlock ? bot.findBlock({ matching: (b) => isMatchingResourceBlock(b.name, 'iron'), maxDistance: 48 }) : null;
          if (iron) {
            return {
              status: 'success',
              reason: `Discovered iron ore at (${iron.position.x}, ${iron.position.y}, ${iron.position.z})! Ready to mine.`,
            };
          }
        } else if (target === 'animal' || target === 'food') {
          const foodMob = Object.values(bot.entities || {}).find(
            (e) => e && ['cow', 'sheep', 'pig', 'chicken'].includes(e.name || '')
          );
          if (foodMob) {
            return {
              status: 'success',
              reason: `Discovered ${foodMob.name} nearby at (${foodMob.position.x.toFixed(0)}, ${foodMob.position.y.toFixed(0)}, ${foodMob.position.z.toFixed(0)})!`,
            };
          }
        }
      }

      // 2. Select directions to try
      const allDirs = ['north', 'east', 'south', 'west'];
      let candidateDirs: string[];
      if (params.direction && allDirs.includes(params.direction)) {
        candidateDirs = [params.direction, ...allDirs.filter((d) => d !== params.direction)];
      } else {
        const yaw = bot.entity?.yaw ?? 0;
        let normYaw = yaw % (2 * Math.PI);
        if (normYaw < 0) normYaw += 2 * Math.PI;
        const deg = (normYaw * 180) / Math.PI;
        let facingDir = 'north';
        if (deg >= 45 && deg < 135) facingDir = 'west';
        else if (deg >= 135 && deg < 225) facingDir = 'south';
        else if (deg >= 225 && deg < 315) facingDir = 'east';
        candidateDirs = [facingDir, ...allDirs.filter((d) => d !== facingDir)];
      }

      let onAbort: (() => void) | null = null;
      if (ctx.abortSignal) {
        onAbort = () => {
          try {
            (bot as any).pathfinder?.stop();
            (bot as any).pathfinder?.setGoal(null);
          } catch {}
          bot.clearControlStates();
        };
        ctx.abortSignal.addEventListener('abort', onAbort, { once: true });
      }

      try {
        updatePathfinderMovements(bot);

        for (const currentDir of candidateDirs) {
          if (ctx.abortSignal?.aborted || !isActionContextActive(ctx)) {
            return { status: 'interrupted', reason: 'Explore cancelled by preemption signal.' };
          }

          const botPos = bot.entity.position;
          let targetPos = botPos.clone();
          if (currentDir === 'north') targetPos = targetPos.offset(0, 0, -dist);
          else if (currentDir === 'south') targetPos = targetPos.offset(0, 0, dist);
          else if (currentDir === 'east') targetPos = targetPos.offset(dist, 0, 0);
          else if (currentDir === 'west') targetPos = targetPos.offset(-dist, 0, 0);

          // Candidate evaluation using fresh observations, blacklist, and hazards
          const assessment = evaluateCandidateTarget(bot, targetPos, { intent: 'horizontal', allowWater: false });
          if (!assessment.valid) {
            console.log(`[EXPLORE] Direction ${currentDir} skipped: ${assessment.rejectionReason}`);
            ctx.logger?.debug?.(`Explore direction ${currentDir} skipped: ${assessment.rejectionReason}`);
            continue;
          }

          console.log(`[EXPLORE] Exploring ${currentDir} towards (${targetPos.x.toFixed(1)}, ${targetPos.z.toFixed(1)}) [${dist}m]...`);
          const navResult = await navigateWithBounds(
            bot,
            {
              target: targetPos,
              range: 3,
              intent: 'horizontal',
            },
            ctx
          );

          if (navResult.status === 'cancelled') {
            return { status: 'interrupted', reason: 'Explore cancelled by preemption signal.' };
          }

          if (navResult.success) {
            // Scan what was discovered in the new area
            const discovered: string[] = [];
            if (bot.findBlock) {
              const nearbyTrees = bot.findBlock({ matching: (b) => b.name.includes('_log'), maxDistance: 32 });
              if (nearbyTrees) discovered.push('trees');
              const nearbyStone = bot.findBlock({ matching: (b) => isMatchingResourceBlock(b.name, 'stone'), maxDistance: 32 });
              if (nearbyStone) discovered.push('stone');
              const nearbyCoal = bot.findBlock({ matching: (b) => isMatchingResourceBlock(b.name, 'coal'), maxDistance: 32 });
              if (nearbyCoal) discovered.push('coal ore');
              const nearbyIron = bot.findBlock({ matching: (b) => isMatchingResourceBlock(b.name, 'iron'), maxDistance: 32 });
              if (nearbyIron) discovered.push('iron ore');
            }

            const sightedMobs = Object.values(bot.entities || {})
              .filter((e) => e && ['cow', 'sheep', 'pig', 'chicken'].includes(e.name || ''))
              .map((e) => e.name);
            if (sightedMobs.length > 0) {
              discovered.push(`${Array.from(new Set(sightedMobs)).join('/')}`);
            }

            console.log(`[EXPLORE] Exploration ${currentDir} succeeded! Discovered: ${discovered.join(', ') || 'clear terrain'}.`);

            const rerouteNote =
              params.direction && currentDir !== params.direction
                ? ` (rerouted around blocked ${params.direction})`
                : '';
            const discoveryText = discovered.length > 0 ? ` Sighted nearby: ${discovered.join(', ')}.` : '';
            return {
              status: 'success',
              reason: `Explored ${dist} blocks ${currentDir}${rerouteNote}.${discoveryText}`,
            };
          } else {
            ctx.logger?.debug?.(`Explore direction ${currentDir} blocked (${navResult.reason}). Trying next direction...`);
          }
        }

        return { status: 'failed', reason: 'All exploration directions blocked around current position.' };
      } finally {
        if (ctx.abortSignal && onAbort) {
          ctx.abortSignal.removeEventListener('abort', onAbort);
        }
        if (isActionContextActive(ctx)) {
          try {
            (bot as any).pathfinder?.stop();
          } catch {}
          bot.clearControlStates();
        }
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
  {
    name: 'pillar_up',
    category: 'movement',
    description: 'Autonomous technique: Jump and place blocks beneath feet to reach a higher ledge, cliff, or tree canopy.',
    parameterSchema: {
      height: { type: 'number', description: 'Blocks to pillar up (1 to 8, default 3)' },
    },
    isAvailable: (bot, obs) => obs.vitals.isAlive && Object.keys(obs.inventory.placeableBlocks).length > 0,
    execute: async (bot: Bot, params: any, ctx: ActionExecutionContext): Promise<ActionResult> => {
      return techniquePillarUp(bot, params.height || 3, ctx.abortSignal, ctx.isCurrent);
    },
  },
  {
    name: 'bridge',
    category: 'movement',
    description: 'Autonomous technique: Crouch (sneak) to prevent falling and build a bridge across a cliff edge or chasm.',
    parameterSchema: {
      direction: { type: 'string', enum: ['forward', 'north', 'south', 'east', 'west'], default: 'forward' },
      distance: { type: 'number', description: 'Distance in blocks to bridge (1 to 12, default 4)' },
    },
    isAvailable: (bot, obs) => obs.vitals.isAlive && Object.keys(obs.inventory.placeableBlocks).length > 0,
    getAvailableChoices: () => ({ direction: ['forward', 'north', 'south', 'east', 'west'] }),
    execute: async (bot: Bot, params: any, ctx: ActionExecutionContext): Promise<ActionResult> => {
      return techniqueBridge(bot, params.direction || 'forward', params.distance || 4, ctx.abortSignal, ctx.isCurrent);
    },
  },
];
