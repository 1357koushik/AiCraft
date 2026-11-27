import { describe, it, expect } from 'vitest';
import { parseControl } from '../src/companion/companion.js';

describe('parseControl', () => {
  it('recognises control commands, with or without punctuation', () => {
    expect(parseControl('stop')).toBe('stop');
    expect(parseControl('Stop!')).toBe('stop');
    expect(parseControl('never mind')).toBe('stop');
    expect(parseControl('forget it')).toBe('stop');
    expect(parseControl('stop all')).toBe('stop_all');
    expect(parseControl('cancel everything')).toBe('stop_all');
    expect(parseControl('clear the queue')).toBe('stop_all');
    expect(parseControl('pause')).toBe('pause');
    expect(parseControl('hold on')).toBe('pause');
    expect(parseControl('resume')).toBe('resume');
    expect(parseControl('carry on')).toBe('resume');
    expect(parseControl('what are you doing?')).toBe('status');
    expect(parseControl('status')).toBe('status');
    expect(parseControl("what's next?")).toBe('queue');
  });

  it('leaves real tasks alone, even when they start with a control word', () => {
    for (const task of [
      'stop the zombies from reaching me',
      'wait for me at the bridge',
      'continue building the wall to the river',
      'get me 10 logs',
      'come here',
      'what do I need to craft a piston?',
      'status of the farm?',
      'pause the music',
    ]) {
      expect(parseControl(task), task).toBeNull();
    }
  });
});
