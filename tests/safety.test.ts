import { describe, it, expect } from 'vitest';
import { SafetyManager } from '../src/safety/index.js';
import { loadConfig } from '../src/config/index.js';

describe('Safety and Boundary System', () => {
  const config = loadConfig();
  const safety = new SafetyManager(config);

  const mockObservation: any = {
    position: { blockCoords: { x: 0, y: 64, z: 0 } },
    entities: [
      { id: 'e1', name: 'OwnerPlayer', isOwner: true, type: 'player' },
      { id: 'e2', name: 'zombie', isOwner: false, type: 'zombie', isHostile: true },
      { id: 'e3', name: 'cat', isOwner: false, type: 'cat' },
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

  it('rejects blocked actions in safety config', () => {
    const check = safety.validateActionSafety('use_tnt', {}, mockObservation);
    expect(check.allowed).toBe(false);
  });
});
