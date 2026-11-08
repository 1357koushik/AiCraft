import os from 'os';
import path from 'path';
import { defineConfig } from 'vitest/config';

// Everything tests write (bot memory, step logs, diagnostics, reports) goes here, not into the repo.
const testOutput = path.join(os.tmpdir(), 'aicraft-tests');

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    env: {
      AICRAFT_TEST_OUTPUT: testOutput,
      AICRAFT_DATA_DIR: path.join(testOutput, 'data'),
      AICRAFT_LOG_DIR: path.join(testOutput, 'logs'),
    },
  },
});
