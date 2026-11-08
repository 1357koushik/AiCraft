import os from 'os';
import path from 'path';

/** Folder outside the repo for files tests create (set in vitest.config.ts). */
export function testOutputPath(...parts: string[]): string {
  return path.join(process.env.AICRAFT_TEST_OUTPUT || path.join(os.tmpdir(), 'aicraft-tests'), ...parts);
}
