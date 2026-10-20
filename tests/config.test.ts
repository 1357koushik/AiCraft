import { describe, it, expect } from 'vitest';
import { ConfigSchema, loadConfig } from '../src/config/index.js';

describe('Configuration System', () => {
  it('loads valid default configuration', () => {
    const config = loadConfig();
    expect(config.server.version).toBe('1.21.6');
    expect(config.server.port).toBe(25565);
    expect(config.server.auth).toBe('offline');
    expect(config.agent.maxActionsPerStep).toBe(1);
    expect(config.safety.blockedActions).toContain('run_command');
  });

  it('validates schema and rejects invalid values', () => {
    const invalidConfig = {
      server: { port: -1 },
      llm: { temperature: 5 }, // max is 2
    };
    const result = ConfigSchema.safeParse(invalidConfig);
    expect(result.success).toBe(false);
  });
});
