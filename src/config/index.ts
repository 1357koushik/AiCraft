import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import dotenv from 'dotenv';
import { z } from 'zod';

// Load .env if present
dotenv.config();

export const ConfigSchema = z.object({
  server: z.object({
    host: z.string().default('127.0.0.1'),
    port: z.number().int().default(25565),
    version: z.string().default('1.21.6'),
    username: z.string().default('AIAgentBot'),
    auth: z.enum(['offline', 'microsoft']).default('offline'),
    autoReconnect: z.boolean().default(true),
    reconnectMaxAttempts: z.number().int().default(10),
    reconnectBaseDelayMs: z.number().int().default(3000),
    reconnectMaxDelayMs: z.number().int().default(30000),
  }),
  llm: z.object({
    provider: z.enum(['lmstudio', 'openai', 'anthropic', 'mock']).default('lmstudio'),
    baseUrl: z.string().default('http://127.0.0.1:1234/v1'),
    model: z.string().default('default'),
    apiKeyEnv: z.string().default('OPENAI_API_KEY'),
    temperature: z.number().min(0).max(2).default(0.3),
    maxTokens: z.number().int().default(1024),
    timeoutMs: z.number().int().default(45000),
    jsonMode: z.boolean().default(true),
    allowCloudFallback: z.boolean().default(false),
    fallbackProvider: z.string().nullable().default(null),
  }),
  agent: z.object({
    maxActionsPerStep: z.number().int().min(1).max(5).default(1),
    historyLength: z.number().int().min(1).max(30).default(8),
    heartbeatIntervalMs: z.number().int().default(1000),
    handedness: z.enum(['right', 'left']).default('right'),
    owners: z.array(z.string()).default(['OwnerPlayer']),
    friends: z.array(z.string()).default([]),
    requestTimeoutMs: z.number().int().default(30000),
    maxRetriesOnMalformedJson: z.number().int().default(2),
    stepMode: z.boolean().default(false),
  }),
  perception: z.object({
    visibilityMode: z.enum(['surround', 'forward-cone']).default('surround'),
    scanRadius: z.number().int().min(4).max(32).default(16),
    entityRadius: z.number().int().min(4).max(64).default(20),
    localMapSize: z.number().int().min(3).max(17).default(9),
    localMapHeightBelow: z.number().int().default(2),
    localMapHeightAbove: z.number().int().default(3),
    tokenBudget: z.number().int().default(2000),
  }),
  safety: z.object({
    protectedNames: z.array(z.string()).default(['OwnerPlayer']),
    protectedEntities: z.array(z.string()).default(['player', 'wolf', 'cat', 'horse', 'iron_golem']),
    blockedActions: z.array(z.string()).default(['run_command', 'use_lava', 'use_tnt']),
    allowCommandExecution: z.boolean().default(false),
    commandAllowlist: z.array(z.string()).default(['help', 'list']),
    reflexes: z.object({
      emergencyFlee: z.boolean().default(true),
      fleeHealthThreshold: z.number().default(6.0),
      autoEat: z.boolean().default(true),
      eatFoodThreshold: z.number().default(14.0),
      escapeLavaWater: z.boolean().default(true),
      avoidMiningStraightDown: z.boolean().default(true),
      autoAttackHostiles: z.boolean().default(true),
      autoAttackRadius: z.number().default(3.8),
      autoShieldBlock: z.boolean().default(true),
    }),
    dangerZones: z.array(
      z.object({
        name: z.string(),
        x: z.number(),
        y: z.number(),
        z: z.number(),
        radius: z.number(),
      })
    ).default([]),
  }),
  logging: z.object({
    level: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
    folder: z.string().default('./logs'),
    fullPromptResponseCapture: z.boolean().default(false),
    redactSecrets: z.boolean().default(true),
    enablePrismarineViewer: z.boolean().default(false),
    viewerPort: z.number().int().default(3000),
  }),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(configPath?: string): AppConfig {
  const resolvedPath = configPath || path.resolve(process.cwd(), 'config', 'config.yaml');
  let parsedYaml: any = {};

  if (fs.existsSync(resolvedPath)) {
    const fileContent = fs.readFileSync(resolvedPath, 'utf-8');
    parsedYaml = yaml.parse(fileContent) || {};
  }

  // Override username or auth from env if set
  if (process.env.MC_USERNAME) {
    parsedYaml.server = parsedYaml.server || {};
    parsedYaml.server.username = process.env.MC_USERNAME;
  }
  if (process.env.MC_AUTH) {
    parsedYaml.server = parsedYaml.server || {};
    parsedYaml.server.auth = process.env.MC_AUTH;
  }
  if (process.env.VIEWER_PORT) {
    parsedYaml.logging = parsedYaml.logging || {};
    parsedYaml.logging.viewerPort = parseInt(process.env.VIEWER_PORT, 10);
  }

  const result = ConfigSchema.safeParse(parsedYaml);
  if (!result.success) {
    console.error('Configuration validation error:', result.error.format());
    throw new Error('Invalid configuration');
  }

  return result.data;
}
