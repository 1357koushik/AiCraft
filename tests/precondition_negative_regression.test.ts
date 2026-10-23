import { describe, it, expect, vi } from 'vitest';
import { movementActions } from '../src/actions/movement.js';
import { worldInteractionActions } from '../src/actions/world_interaction.js';
import { metaActions } from '../src/actions/meta.js';
import { ActionExecutionContext } from '../src/types/index.js';

describe('Regression: Precondition Enforcement for Negative Scenarios (swim_up, dismount, set_goal)', () => {
  const createMockCtx = (bot: any): ActionExecutionContext => ({
    bot,
    observation: {
      agentState: { currentGoal: 'idle', planSteps: [] },
      vitals: { movementState: { inWater: false, isRiding: false } },
    } as any,
  });

  describe('set_goal input validation', () => {
    it('rejects empty goal string with failed status', async () => {
      const mockBot: any = {};
      const ctx = createMockCtx(mockBot);
      const setGoal = metaActions.find((a) => a.name === 'set_goal')!;

      const result = await setGoal.execute(mockBot, { goal: '' }, ctx);

      expect(result.status).toBe('failed');
      expect(result.reason).toContain('goal string cannot be empty or whitespace-only');
      expect(ctx.observation.agentState.currentGoal).toBe('idle');
    });

    it('rejects whitespace-only goal string with failed status', async () => {
      const mockBot: any = {};
      const ctx = createMockCtx(mockBot);
      const setGoal = metaActions.find((a) => a.name === 'set_goal')!;

      const result = await setGoal.execute(mockBot, { goal: '     ' }, ctx);

      expect(result.status).toBe('failed');
      expect(result.reason).toContain('goal string cannot be empty or whitespace-only');
      expect(ctx.observation.agentState.currentGoal).toBe('idle');
    });

    it('rejects empty parameters when neither goal nor planSteps provided', async () => {
      const mockBot: any = {};
      const ctx = createMockCtx(mockBot);
      const setGoal = metaActions.find((a) => a.name === 'set_goal')!;

      const result = await setGoal.execute(mockBot, {}, ctx);

      expect(result.status).toBe('failed');
      expect(result.reason).toContain('must provide non-empty goal or non-empty planSteps');
    });

    it('successfully accepts valid goal string and updates agent state', async () => {
      const mockBot: any = {};
      const ctx = createMockCtx(mockBot);
      const setGoal = metaActions.find((a) => a.name === 'set_goal')!;

      const result = await setGoal.execute(mockBot, { goal: 'gather 32 logs' }, ctx);

      expect(result.status).toBe('success');
      expect(result.reason).toContain('gather 32 logs');
      expect(ctx.observation.agentState.currentGoal).toBe('gather 32 logs');
    });

    it('successfully accepts plan steps array and parses steps', async () => {
      const mockBot: any = {};
      const ctx = createMockCtx(mockBot);
      const setGoal = metaActions.find((a) => a.name === 'set_goal')!;

      const result = await setGoal.execute(
        mockBot,
        { goal: 'craft pickaxe', planSteps: ['gather 3 logs', 'craft planks', 'craft wooden_pickaxe'] },
        ctx
      );

      expect(result.status).toBe('success');
      expect(ctx.observation.agentState.currentGoal).toBe('craft pickaxe');
      expect(ctx.observation.agentState.planSteps.length).toBe(3);
    });
  });

  describe('swim_up negative & positive preconditions', () => {
    it('returns failed status when bot is not in water', async () => {
      const mockBot: any = {
        entity: { isInWater: false },
        setControlState: vi.fn(),
      };
      const swimUp = movementActions.find((a) => a.name === 'swim_up')!;

      const result = await swimUp.execute(mockBot, {}, createMockCtx(mockBot));

      expect(result.status).toBe('failed');
      expect(result.reason).toContain('Cannot swim up: bot is not in water');
      expect(mockBot.setControlState).not.toHaveBeenCalled();
    });

    it('returns success status and swims up when bot is in water', async () => {
      const mockBot: any = {
        entity: { isInWater: true },
        setControlState: vi.fn(),
      };
      const swimUp = movementActions.find((a) => a.name === 'swim_up')!;

      // We use fake timers or wait for the jump pulse
      vi.useFakeTimers();
      const promise = swimUp.execute(mockBot, {}, createMockCtx(mockBot));
      vi.advanceTimersByTime(1300);
      const result = await promise;
      vi.useRealTimers();

      expect(result.status).toBe('success');
      expect(result.reason).toContain('Swam upward toward air');
      expect(mockBot.setControlState).toHaveBeenCalledWith('jump', true);
      expect(mockBot.setControlState).toHaveBeenCalledWith('jump', false);
    });
  });

  describe('dismount negative & positive preconditions', () => {
    it('returns failed status when bot is not riding any vehicle', async () => {
      const mockBot: any = {
        vehicle: null,
        entity: { vehicle: null },
        dismount: vi.fn().mockResolvedValue(undefined),
      };
      const dismount = worldInteractionActions.find((a) => a.name === 'dismount')!;

      const result = await dismount.execute(mockBot, {}, createMockCtx(mockBot));

      expect(result.status).toBe('failed');
      expect(result.reason).toContain('Cannot dismount: bot is not riding any vehicle');
      expect(mockBot.dismount).not.toHaveBeenCalled();
    });

    it('returns success status and calls dismount when bot is riding a vehicle', async () => {
      const mockBot: any = {
        vehicle: { id: 99, name: 'boat' },
        entity: { vehicle: { id: 99, name: 'boat' } },
        dismount: vi.fn().mockResolvedValue(undefined),
      };
      const dismount = worldInteractionActions.find((a) => a.name === 'dismount')!;

      const result = await dismount.execute(mockBot, {}, createMockCtx(mockBot));

      expect(result.status).toBe('success');
      expect(result.reason).toContain('Dismounted from vehicle');
      expect(mockBot.dismount).toHaveBeenCalled();
    });
  });
});
