import { describe, it, expect, vi } from 'vitest';
import { Vec3 } from 'vec3';
import { SafetyManager, resolveAndValidateTarget } from '../src/safety/index.js';
import { loadConfig } from '../src/config/index.js';

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
});
