import { describe, it, expect } from 'vitest';
import { MemoryManager } from '../src/memory/index.js';

describe('Memory and Goal Management', () => {
  it('records and retrieves named locations and facts', () => {
    const memory = new MemoryManager('test_world', './data/test_memory');
    memory.rememberLocation('base', { x: 100, y: 70, z: -50 });
    memory.rememberFact('Creeper spotted near river');
    memory.setGoal('Build stone shelter', ['Collect cobblestone', 'Place foundation']);

    expect(memory.notes.namedLocations['base']).toEqual({ x: 100, y: 70, z: -50 });
    expect(memory.notes.facts).toContain('Creeper spotted near river');
    expect(memory.state.currentGoal).toBe('Build stone shelter');
    expect(memory.state.planSteps.length).toBe(2);
  });

  it('maintains rolling history within length limit', () => {
    const memory = new MemoryManager('test_world', './data/test_memory');
    for (let i = 1; i <= 15; i++) {
      memory.addHistoryRecord({
        step: i,
        summary: `Step ${i}`,
        action: 'wait',
        result: 'success',
        timestamp: Date.now(),
      }, 5);
    }

    expect(memory.rollingHistory.length).toBe(5);
    expect(memory.rollingHistory[memory.rollingHistory.length - 1].step).toBe(15);
  });
});
