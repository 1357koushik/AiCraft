import path from 'path';

/**
 * Root folders for runtime output. Override with AICRAFT_DATA_DIR / AICRAFT_LOG_DIR
 * (the test config points them at a temp folder so tests never write into the repo).
 */
export function dataDir(...parts: string[]): string {
  return path.join(process.env.AICRAFT_DATA_DIR || './data', ...parts);
}

export function logDir(...parts: string[]): string {
  return path.join(process.env.AICRAFT_LOG_DIR || './logs', ...parts);
}
