import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import yaml from 'yaml';

export interface ServerPropertiesEvaluation {
  difficulty: string;
  onlineMode: boolean;
  pvp: boolean;
  allowFlight: boolean;
  viewDistance: number;
  simulationDistance: number;
  spawnProtection: number;
  pauseWhenEmptySeconds: number;
  rawProperties: Record<string, string>;
  invalidatingDifferences: string[];
}

export interface GitFingerprint {
  commitHash: string;
  branch: string;
  isDirty: boolean;
  workingTreeFingerprint: string;
}

export interface RedactedConfigProvenance {
  configPath: string;
  redactedConfigHash: string;
  redactedSummary: Record<string, any>;
}

export interface CampaignProvenance {
  campaignId: string;
  timestamp: string;
  minecraftVersion: string;
  serverImplementation: string;
  git: GitFingerprint;
  config: RedactedConfigProvenance;
  serverProperties: ServerPropertiesEvaluation;
  scenarioCount: number;
  familyCount: number;
}

/**
 * Extracts Git commit hash, branch, and working-tree dirty status/fingerprint.
 */
export function getBotGitFingerprint(): GitFingerprint {
  try {
    const commitHash = execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const porcelain = execSync('git status --porcelain', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const isDirty = porcelain.trim().length > 0;
    const workingTreeFingerprint = crypto.createHash('sha256').update(porcelain).digest('hex').substring(0, 16);

    return {
      commitHash,
      branch,
      isDirty,
      workingTreeFingerprint,
    };
  } catch {
    return {
      commitHash: 'unknown',
      branch: 'unknown',
      isDirty: false,
      workingTreeFingerprint: 'none',
    };
  }
}

/**
 * Recursively redacts sensitive keys from configuration objects.
 */
function redactObject(obj: any): any {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(redactObject);

  const clean: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (/token|password|secret|key|auth|api/i.test(k)) {
      clean[k] = '[REDACTED]';
    } else if (typeof v === 'object') {
      clean[k] = redactObject(v);
    } else {
      clean[k] = v;
    }
  }
  return clean;
}

/**
 * Computes SHA-256 hash of configuration with all secrets redacted.
 */
export function getRedactedConfigProvenance(configFilePath: string = 'config/config.yaml'): RedactedConfigProvenance {
  const fullPath = path.resolve(process.cwd(), configFilePath);
  if (!fs.existsSync(fullPath)) {
    return {
      configPath: configFilePath,
      redactedConfigHash: 'missing',
      redactedSummary: {},
    };
  }

  try {
    const rawContent = fs.readFileSync(fullPath, 'utf8');
    const parsed = yaml.parse(rawContent) || {};
    const redacted = redactObject(parsed);
    const jsonStr = JSON.stringify(redacted, Object.keys(redacted).sort(), 2);
    const hash = crypto.createHash('sha256').update(jsonStr).digest('hex').substring(0, 16);

    return {
      configPath: configFilePath,
      redactedConfigHash: hash,
      redactedSummary: redacted,
    };
  } catch {
    return {
      configPath: configFilePath,
      redactedConfigHash: 'error_reading',
      redactedSummary: {},
    };
  }
}

/**
 * Evaluates server/server.properties and flags server configuration differences
 * that could invalidate live test results.
 */
export function evaluateServerProperties(propertiesPath: string = 'server/server.properties'): ServerPropertiesEvaluation {
  const fullPath = path.resolve(process.cwd(), propertiesPath);
  const rawProperties: Record<string, string> = {};
  const invalidatingDifferences: string[] = [];

  if (fs.existsSync(fullPath)) {
    const lines = fs.readFileSync(fullPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx !== -1) {
        const k = trimmed.substring(0, eqIdx).trim();
        const v = trimmed.substring(eqIdx + 1).trim();
        rawProperties[k] = v;
      }
    }
  }

  const onlineMode = rawProperties['online-mode'] === 'true';
  const difficulty = rawProperties['difficulty'] || 'normal';
  const pvp = rawProperties['pvp'] !== 'false';
  const allowFlight = rawProperties['allow-flight'] === 'true';
  const viewDistance = parseInt(rawProperties['view-distance'] || '8', 10);
  const simulationDistance = parseInt(rawProperties['simulation-distance'] || '6', 10);
  const spawnProtection = parseInt(rawProperties['spawn-protection'] || '0', 10);
  const pauseWhenEmptySeconds = parseInt(rawProperties['pause-when-empty-seconds'] || '60', 10);

  // Identify configuration differences that could invalidate results:
  if (onlineMode) {
    invalidatingDifferences.push('online-mode=true: Offline test bots will fail authentication.');
  }
  if (spawnProtection > 0) {
    invalidatingDifferences.push(`spawn-protection=${spawnProtection}: Non-OP test bot cannot break/place blocks near spawn (0,0).`);
  }
  if (difficulty === 'peaceful') {
    invalidatingDifferences.push('difficulty=peaceful: Suppresses hostiles and hunger depletion, invalidating combat/hunger tests.');
  }
  if (!allowFlight) {
    invalidatingDifferences.push('allow-flight=false: Server may kick bot for flying during rapid pillar jumps or fall recovery.');
  }
  if (viewDistance < 6) {
    invalidatingDifferences.push(`view-distance=${viewDistance}: View distance below 6 chunks causes premature unloaded-chunk errors.`);
  }

  return {
    difficulty,
    onlineMode,
    pvp,
    allowFlight,
    viewDistance,
    simulationDistance,
    spawnProtection,
    pauseWhenEmptySeconds,
    rawProperties,
    invalidatingDifferences,
  };
}

/**
 * Builds complete campaign provenance metadata.
 */
export function buildCampaignProvenance(
  campaignId: string,
  familyCount: number,
  scenarioCount: number
): CampaignProvenance {
  return {
    campaignId,
    timestamp: new Date().toISOString(),
    minecraftVersion: '1.21.6',
    serverImplementation: 'Vanilla 1.21.6 (Observer sidecar instrumented)',
    git: getBotGitFingerprint(),
    config: getRedactedConfigProvenance(),
    serverProperties: evaluateServerProperties(),
    scenarioCount,
    familyCount,
  };
}

/**
 * Manages per-run artifact storage and enforces log retention limits.
 */
export function managePerRunArtifacts(
  campaignDir: string,
  campaignId: string,
  maxRetainedRuns: number = 10
): { runDir: string; prunedRuns: string[] } {
  const runsRoot = path.join(campaignDir, 'runs');
  const runDir = path.join(runsRoot, campaignId);

  if (!fs.existsSync(runDir)) {
    fs.mkdirSync(runDir, { recursive: true });
  }

  // Prune oldest runs exceeding maxRetainedRuns
  const prunedRuns: string[] = [];
  try {
    const existingRuns = fs.readdirSync(runsRoot)
      .map((name) => ({
        name,
        dirPath: path.join(runsRoot, name),
        stat: fs.statSync(path.join(runsRoot, name)),
      }))
      .filter((e) => e.stat.isDirectory())
      .sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);

    while (existingRuns.length > maxRetainedRuns) {
      const oldest = existingRuns.shift();
      if (oldest && oldest.name !== campaignId) {
        fs.rmSync(oldest.dirPath, { recursive: true, force: true });
        prunedRuns.push(oldest.name);
      }
    }
  } catch {}

  return { runDir, prunedRuns };
}
