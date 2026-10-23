import { describe, it, expect, vi } from 'vitest';
import { Vec3 } from 'vec3';
import { SafetyManager, resolveAndValidateTarget } from '../src/safety/index.js';
import { loadConfig } from '../src/config/index.js';
import { metaActions } from '../src/actions/meta.js';
import { AgentController } from '../src/agent/loop.js';
import { AgentLogger } from '../src/utils/logger.js';
import { MemoryManager } from '../src/memory/index.js';

describe('Safety and Boundary System', () => {
  const config = loadConfig();
  const safety = new SafetyManager(config);

  const mockObservation: any = {
    position: { blockCoords: { x: 0, y: 64, z: 0 } },
    entities: [
      { id: 'e1', rawId: 10, name: 'OwnerPlayer', isOwner: true, type: 'player' },
      { id: 'e2', rawId: 20, name: 'zombie', isOwner: false, type: 'zombie', isHostile: true },
      { id: 'e3', rawId: 30, name: 'cat', isOwner: false, type: 'cat' },
    ],
  };

  it('strictly forbids attacking the owner', () => {
    const check = safety.validateActionSafety('attack', { targetId: 'e1' }, mockObservation);
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain('bot owner');
  });

  it('strictly forbids attacking protected animals/pets', () => {
    const check = safety.validateActionSafety('attack', { targetId: 'e3' }, mockObservation);
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain('protected');
  });

  it('allows attacking hostile mobs', () => {
    const check = safety.validateActionSafety('attack', { targetId: 'e2' }, mockObservation);
    expect(check.allowed).toBe(true);
  });

  it('rejects commands when allowCommandExecution is disabled', () => {
    const check = safety.validateActionSafety('run_command', { command: 'help' }, mockObservation);
    expect(check.allowed).toBe(false);
  });

  it('rejects command injection attempts with chaining, newlines, pipes, or shell characters', () => {
    const enabledConfig = loadConfig();
    enabledConfig.safety.allowCommandExecution = true;
    enabledConfig.safety.blockedActions = enabledConfig.safety.blockedActions.filter((a) => a !== 'run_command');
    enabledConfig.safety.commandAllowlist = ['help', 'list'];
    const activeSafety = new SafetyManager(enabledConfig);

    // Chaining with semicolon
    expect(activeSafety.validateActionSafety('run_command', { command: 'help; op hacker' }, mockObservation).allowed).toBe(false);
    // Newline injection
    expect(activeSafety.validateActionSafety('run_command', { command: 'help\nkill @a' }, mockObservation).allowed).toBe(false);
    // Pipe injection
    expect(activeSafety.validateActionSafety('run_command', { command: 'help | rm -rf /' }, mockObservation).allowed).toBe(false);
    // Subshell injection
    expect(activeSafety.validateActionSafety('run_command', { command: 'help $(whoami)' }, mockObservation).allowed).toBe(false);
    // Disallowed command
    expect(activeSafety.validateActionSafety('run_command', { command: 'op hacker' }, mockObservation).allowed).toBe(false);
    // Allowed clean command
    expect(activeSafety.validateActionSafety('run_command', { command: 'help' }, mockObservation).allowed).toBe(true);
  });

  it('rejects blocked actions in safety config', () => {
    const check = safety.validateActionSafety('use_tnt', {}, mockObservation);
    expect(check.allowed).toBe(false);
  });

  describe('resolveAndValidateTarget Invariants', () => {
    it('rejects targeting dead entities', () => {
      const mockBot: any = {
        entities: {
          20: { id: 20, name: 'zombie', type: 'zombie', health: 0, position: new Vec3(2, 64, 0), isValid: true },
        },
        entity: { position: new Vec3(0, 64, 0) },
      };

      const res = resolveAndValidateTarget(mockBot, 'e2', mockObservation, config, 4.5);
      expect(res.valid).toBe(false);
      expect(res.reason).toContain('is dead');
    });

    it('rejects targeting despawned / missing entities', () => {
      const mockBot: any = {
        entities: {},
        entity: { position: new Vec3(0, 64, 0) },
      };

      const res = resolveAndValidateTarget(mockBot, 'e2', mockObservation, config, 4.5);
      expect(res.valid).toBe(false);
      expect(res.reason).toContain('no longer loaded');
    });

    it('rejects target when server reuses the entity ID for a different entity type', () => {
      const mockBot: any = {
        entities: {
          20: { id: 20, name: 'villager', type: 'villager', health: 20, position: new Vec3(2, 64, 0), isValid: true },
        },
        entity: { position: new Vec3(0, 64, 0) },
      };

      // e2 was a zombie in observation, but ID 20 is now a villager
      const res = resolveAndValidateTarget(mockBot, 'e2', mockObservation, config, 4.5);
      expect(res.valid).toBe(false);
      expect(res.reason).toContain('ID mismatch');
    });

    it('rejects target when target has moved out of reach', () => {
      const mockBot: any = {
        entities: {
          20: { id: 20, name: 'zombie', type: 'zombie', health: 20, position: new Vec3(10, 64, 0), isValid: true },
        },
        entity: { position: new Vec3(0, 64, 0) },
      };

      const res = resolveAndValidateTarget(mockBot, 'e2', mockObservation, config, 4.5);
      expect(res.valid).toBe(false);
      expect(res.reason).toContain('out of reach');
    });

    it('validates and returns live entity when target is alive, matched, and within reach', () => {
      const mockZombie = { id: 20, name: 'zombie', type: 'zombie', health: 20, position: new Vec3(2, 64, 0), isValid: true };
      const mockBot: any = {
        entities: { 20: mockZombie },
        entity: { position: new Vec3(0, 64, 0) },
      };

      const res = resolveAndValidateTarget(mockBot, 'e2', mockObservation, config, 4.5);
      expect(res.valid).toBe(true);
      expect(res.rawEntity).toBe(mockZombie);
    });
  });

  describe('Chat and Command Authorization', () => {
    it('strictly forbids slash commands and control commands via the chat action', async () => {
      const chatAction = metaActions.find((a) => a.name === 'chat');
      expect(chatAction).toBeDefined();

      const mockBot: any = { chat: vi.fn() };

      const slashRes = await chatAction!.execute(mockBot, { message: '/op attacker' }, {} as any);
      expect(slashRes.status).toBe('failed');
      expect(slashRes.reason).toContain('Safety violation: Slash commands or control prefixes cannot be executed via public chat');
      expect(mockBot.chat).not.toHaveBeenCalled();

      const controlRes = await chatAction!.execute(mockBot, { message: '!attack off' }, {} as any);
      expect(controlRes.status).toBe('failed');
      expect(controlRes.reason).toContain('Safety violation: Slash commands or control prefixes cannot be executed via public chat');
      expect(mockBot.chat).not.toHaveBeenCalled();

      // Leading whitespace and unicode zero-width space bypass attempts
      const whitespaceSlash = await chatAction!.execute(mockBot, { message: '   /op hacker' }, {} as any);
      expect(whitespaceSlash.status).toBe('failed');
      expect(whitespaceSlash.reason).toContain('Safety violation');

      const zeroWidthSlash = await chatAction!.execute(mockBot, { message: '\u200B/op hacker' }, {} as any);
      expect(zeroWidthSlash.status).toBe('failed');
      expect(zeroWidthSlash.reason).toContain('Safety violation');

      const tabControl = await chatAction!.execute(mockBot, { message: '\t\uFEFF!stop' }, {} as any);
      expect(tabControl.status).toBe('failed');
      expect(tabControl.reason).toContain('Safety violation');
    });

    it('run_command action rejects control characters and null bytes', async () => {
      const runCmdAction = metaActions.find((a) => a.name === 'run_command');
      expect(runCmdAction).toBeDefined();

      const enabledConfig = loadConfig();
      enabledConfig.safety.allowCommandExecution = true;
      enabledConfig.safety.commandAllowlist = ['help'];

      const mockBot: any = { chat: vi.fn() };
      const ctx: any = { config: enabledConfig };

      const nullByteRes = await runCmdAction!.execute(mockBot, { command: 'help\u0000; op hacker' }, ctx);
      expect(nullByteRes.status).toBe('failed');
      expect(nullByteRes.reason).toContain('Command injection rejected');

      const newlineRes = await runCmdAction!.execute(mockBot, { command: 'help\r\nop hacker' }, ctx);
      expect(newlineRes.status).toBe('failed');
      expect(newlineRes.reason).toContain('Command injection rejected');
    });

    it('allows normal conversational chat messages', async () => {
      const chatAction = metaActions.find((a) => a.name === 'chat');
      const mockBot: any = { chat: vi.fn() };

      // Ensure lastChatTimestamp cooldown has passed
      await new Promise((res) => setTimeout(res, 1600));

      const res = await chatAction!.execute(mockBot, { message: 'Hello fellow miner!' }, {} as any);
      expect(res.status).toBe('success');
      expect(mockBot.chat).toHaveBeenCalledWith('Hello fellow miner!');
    });

    it('rejects owner commands sent by unauthorized players but executes them from owner even with whitespace', () => {
      const chatListeners: Function[] = [];
      const mockBot: any = {
        username: 'BotPlayer',
        on: vi.fn().mockImplementation((event: string, cb: Function) => {
          if (event === 'chat') chatListeners.push(cb);
        }),
        chat: vi.fn(),
        entity: { position: new Vec3(0, 64, 0) },
      };

      const testConfig = loadConfig();
      testConfig.agent.owners = ['LegitOwner'];
      const controller = new AgentController(
        mockBot,
        testConfig,
        new AgentLogger(testConfig),
        new MemoryManager('test_world', './data_test_safety'),
        new SafetyManager(testConfig),
        { generateDecision: vi.fn() } as any
      );

      expect(chatListeners.length).toBeGreaterThan(0);
      const onChat = chatListeners[0];

      // Untrusted player tries to issue owner command "!stop"
      onChat('RandomPlayer', '!stop');
      expect(mockBot.chat).not.toHaveBeenCalledWith('Pausing AI decision loop.');

      // Owner issues command with leading whitespace and unicode zero-width space
      onChat('LegitOwner', '  \u200B!pause');
      expect(mockBot.chat).toHaveBeenCalledWith('Pausing AI decision loop.');
    });

    it('delivers owner natural-language chat to pendingOwnerInstruction and prevents model decision from overwriting owner goal', async () => {
      const chatListeners: Function[] = [];
      const mockBot: any = {
        username: 'BotPlayer',
        on: vi.fn().mockImplementation((event: string, cb: Function) => {
          if (event === 'chat') chatListeners.push(cb);
        }),
        chat: vi.fn(),
        health: 20,
        food: 20,
        oxygenLevel: 20,
        isAlive: true,
        game: { gameMode: 'survival' },
        entity: { position: new Vec3(0, 64, 0), onGround: true },
        entities: {},
        inventory: { slots: [], items: () => [], emptySlotCount: () => 36 },
        registry: { blocksByName: {}, items: {}, itemsByName: {}, effects: {} },
        time: { timeOfDay: 1000, age: 24000 },
        blockAt: vi.fn().mockReturnValue({ name: 'grass_block', boundingBox: 'block' }),
        blockAtCursor: vi.fn().mockReturnValue(null),
        entityAtCursor: vi.fn().mockReturnValue(null),
        findBlock: vi.fn().mockReturnValue(null),
        recipesAll: vi.fn().mockReturnValue([]),
        recipesFor: vi.fn().mockReturnValue([]),
        setControlState: vi.fn(),
        clearControlStates: vi.fn(),
        pathfinder: { stop: vi.fn(), setGoal: vi.fn(), goto: vi.fn().mockResolvedValue(undefined) },
      };

      const testConfig = loadConfig();
      testConfig.agent.owners = ['LegitOwner'];
      const memory = new MemoryManager('test_world_owner_chat', './data_test_safety');
      const mockLLM = {
        name: 'MockLLM',
        generateDecision: vi.fn().mockResolvedValue({
          decision: {
            decision_summary: 'Ignoring owner instruction and doing random action',
            goal: 'Overwritten LLM Goal',
            actions: [{ action: 'wait', params: { seconds: 0.05 } }],
          },
          latencyMs: 10,
        }),
      };

      const controller = new AgentController(
        mockBot,
        testConfig,
        new AgentLogger(testConfig),
        memory,
        new SafetyManager(testConfig),
        mockLLM as any
      );

      const onChat = chatListeners[0];
      expect(onChat).toBeDefined();

      // 1. Untrusted player chat should NOT set pendingOwnerInstruction or change goal
      onChat('RandomPlayer', 'mine straight down');
      expect(memory.state.pendingOwnerInstruction).toBeUndefined();
      expect(memory.state.currentGoal).not.toBe('mine straight down');

      // 2. Owner natural-language chat MUST set pendingOwnerInstruction and set active goal
      onChat('LegitOwner', 'gather 16 oak logs');
      expect(memory.state.pendingOwnerInstruction).toBe('gather 16 oak logs');
      expect(memory.state.currentGoal).toBe('gather 16 oak logs');

      // 3. Run a step: LLM receives pendingOwnerInstruction, responds with different goal suggestion
      await (controller as any).step();

      // 4. Model decision MUST NOT overwrite the owner-specified goal
      expect(memory.state.currentGoal).toBe('gather 16 oak logs');
      // 5. pendingOwnerInstruction is cleared after being processed in this step
      expect(memory.state.pendingOwnerInstruction).toBeUndefined();
    });
  });
});
