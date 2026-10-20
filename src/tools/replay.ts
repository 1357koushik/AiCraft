import fs from 'fs';
import readline from 'readline';
import { loadConfig } from '../config/index.js';
import { AgentLogger } from '../utils/logger.js';
import { createLLMProvider } from '../llm/index.js';
import { buildSystemPrompt } from '../prompt/index.js';

export async function replayLogFile(filePath: string, targetProviderName?: string): Promise<void> {
  if (!fs.existsSync(filePath)) {
    console.error(`Log file not found: ${filePath}`);
    return;
  }

  const config = loadConfig();
  if (targetProviderName) {
    (config.llm as any).provider = targetProviderName;
  }

  const logger = new AgentLogger(config);
  const provider = createLLMProvider(config, logger);

  console.log(`\nReplaying log steps from ${filePath} using provider: ${provider.name}...\n`);

  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let stepCount = 0;
  let successfulDecisions = 0;
  let totalLatency = 0;

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      stepCount++;

      console.log(`--- [Step ${record.step || stepCount}] Original: "${record.decisionSummary}" (Goal: ${record.goal}) ---`);

      // Re-create prompt and evaluate
      const systemPrompt = buildSystemPrompt(config);
      const userPrompt = JSON.stringify({
        goal: record.goal,
        vitals: record.vitals,
        position: record.position,
      });

      const start = Date.now();
      const res = await provider.generateDecision({ systemPrompt, userPrompt });
      const latency = Date.now() - start;
      totalLatency += latency;

      if (res.decision) {
        successfulDecisions++;
        console.log(`  New Model Output: "${res.decision.decision_summary}"`);
        console.log(`  Action: ${JSON.stringify(res.decision.actions)} (${latency}ms)\n`);
      } else {
        console.log(`  New Model FAILED: ${res.error}\n`);
      }
    } catch (err: any) {
      console.error('Error processing replay line:', err.message);
    }
  }

  console.log('================ REPLAY METRICS ================');
  console.log(`Total Steps Tested:    ${stepCount}`);
  console.log(`Valid Decisions:       ${successfulDecisions} (${((successfulDecisions / (stepCount || 1)) * 100).toFixed(1)}%)`);
  console.log(`Average Latency:       ${(totalLatency / (stepCount || 1)).toFixed(0)}ms`);
  console.log('================================================\n');
}

if (process.argv[1] && process.argv[1].endsWith('replay.ts')) {
  const file = process.argv[2];
  const provider = process.argv[3];
  if (!file) {
    console.log('Usage: npx tsx src/tools/replay.ts <path-to-jsonl-log> [provider]');
    process.exit(1);
  }
  replayLogFile(file, provider);
}
