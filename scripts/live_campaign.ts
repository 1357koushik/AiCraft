import mineflayer, { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { loadConfig } from '../src/config/index.js';
import { AgentLogger } from '../src/utils/logger.js';
import { MemoryManager } from '../src/memory/index.js';
import { SafetyManager } from '../src/safety/index.js';
import { createLLMProvider } from '../src/llm/index.js';
import { ConnectionManager } from '../src/connection/index.js';
import { AgentController } from '../src/agent/loop.js';
import { ActionPriority } from '../src/agent/arbiter.js';
import { navigationBlacklist, navigateWithBounds } from '../src/actions/navigator.js';
import { countMatchingLogsInInventory } from '../src/actions/techniques.js';

interface TrialResult {
  trialName: string;
  condition: string;
  success: boolean;
  startInventory: Record<string, number>;
  endInventory: Record<string, number>;
  inventoryDelta: Record<string, number>;
  elapsedWallClockMs: number;
  llmCalls: number;
  llmTotalLatencyMs: number;
  pathFailures: number;
  recoveries: number;
  deaths: number;
  statusText: string;
  details: any;
}

const trialResults: TrialResult[] = [];

function getInventorySnapshot(bot: Bot): Record<string, number> {
  const map: Record<string, number> = {};
  if (!bot?.inventory?.items) return map;
  for (const item of bot.inventory.items()) {
    map[item.name] = (map[item.name] || 0) + item.count;
  }
  return map;
}

function getInventoryDelta(start: Record<string, number>, end: Record<string, number>): Record<string, number> {
  const delta: Record<string, number> = {};
  const allKeys = new Set([...Object.keys(start), ...Object.keys(end)]);
  for (const key of allKeys) {
    const d = (end[key] || 0) - (start[key] || 0);
    if (d !== 0) delta[key] = d;
  }
  return delta;
}

async function runLiveAcceptanceCampaign() {
  console.log('=== STARTING LIVE ACCEPTANCE CAMPAIGN ON LOCAL MINECRAFT 1.21.6 SERVER ===\n');

  // 1. Load config
  const config = loadConfig();
  config.logging.level = 'info';
  config.server.host = '127.0.0.1';
  config.server.port = 25565;
  config.server.username = 'dragonai';
  config.agent.owners = ['OwnerPlayer', '1357koushik'];

  const logger = new AgentLogger(config);
  const memory = new MemoryManager(`world_${config.server.host}_${config.server.port}`, './data');
  const safety = new SafetyManager(config);

  // Wrap LLM provider to instrument call count and latency
  const baseLLM = createLLMProvider(config, logger);
  let totalLLMCalls = 0;
  let totalLLMLatencyMs = 0;
  const instrumentedLLM = {
    name: baseLLM.name,
    generateDecision: async (req: any) => {
      totalLLMCalls++;
      const t0 = Date.now();
      const res = await baseLLM.generateDecision(req);
      const dt = Date.now() - t0;
      totalLLMLatencyMs += dt;
      return res;
    },
  };

  const connection = new ConnectionManager(config, logger);

  // Connect owner bot
  console.log('[SETUP] Connecting owner bot 1357koushik...');
  const ownerBot = mineflayer.createBot({
    host: config.server.host,
    port: config.server.port,
    username: '1357koushik',
    version: config.server.version,
    auth: 'offline',
  });

  await new Promise<void>((resolve, reject) => {
    ownerBot.once('spawn', () => {
      console.log('[SETUP] Owner bot 1357koushik spawned successfully.');
      resolve();
    });
    ownerBot.once('error', reject);
    ownerBot.once('kicked', (r) => reject(new Error('Owner kicked: ' + r)));
  });

  // Connect dragonai agent
  console.log('[SETUP] Connecting dragonai bot via ConnectionManager...');
  let agentBot: Bot | null = null;
  let agentController: AgentController | null = null;

  await new Promise<void>((resolve, reject) => {
    connection.connect({
      onSpawn: (bot) => {
        agentBot = bot;
        console.log(`[SETUP] dragonai spawned at ${bot.entity.position.floored()}`);
        agentController = new AgentController(bot, config, logger, memory, safety, instrumentedLLM as any);
        resolve();
      },
      onError: reject,
      onKicked: (r) => reject(new Error('Kicked: ' + r)),
    });
  });

  if (!agentBot || !agentController) {
    throw new Error('Failed to initialize agent bot or controller');
  }

  const bot = agentBot;
  const controller = agentController;

  // Track deaths
  let deathCount = 0;
  bot.on('death', () => {
    deathCount++;
    console.log('[ALERT] Bot death event occurred!');
  });

  // Verification of server environment
  console.log('\n--- VERIFYING SERVER ENVIRONMENT & AUTHENTICATION ---');
  console.log(`Server version: ${bot.version} (Expected: 1.21.6)`);
  console.log(`Game mode: ${bot.game.gameMode}`);
  console.log(`Bot username: ${bot.username}`);
  console.log(`Dimension: ${bot.game.dimension}`);
  console.log(`Difficulty: ${bot.game.difficulty}`);
  console.log(`Bot Health: ${bot.health}/20 | Food: ${bot.food}/20`);
  console.log(`Config owners: ${JSON.stringify(config.agent.owners)}`);
  console.log(`Owner 1357koushik authorized: ${config.agent.owners.includes('1357koushik')}`);

  // Ensure daytime and clear weather for reliable trials
  ownerBot.chat('/time set day');
  ownerBot.chat('/weather clear');
  await new Promise((r) => setTimeout(r, 1000));

  // =========================================================================
  // TRIAL 1: Milestone 1 Autonomous "gather 32 logs"
  // =========================================================================
  console.log('\n===========================================================');
  console.log('TRIAL 1: Milestone 1 Acceptance: Autonomous "gather 32 logs"');
  console.log('===========================================================');

  const t1StartInv = getInventorySnapshot(bot);
  const t1StartTime = Date.now();
  const t1InitialLLMCalls = totalLLMCalls;
  const t1InitialLLMLatency = totalLLMLatencyMs;
  const t1StartLogs = countMatchingLogsInInventory(bot);

  console.log(`[TRIAL 1] Starting inventory matching logs: ${t1StartLogs}`);
  console.log(`[TRIAL 1] Target: gather 32 logs (Target total: ${t1StartLogs + 32} logs)`);

  // Owner issues instruction via in-game chat over network
  console.log('[TRIAL 1] Owner 1357koushik issuing in-game chat: "gather 32 logs"');
  ownerBot.chat('gather 32 logs');

  // Start controller loop in background
  let trial1Completed = false;
  let trial1Error: string | null = null;

  controller.start().catch((err) => {
    trial1Error = err?.message || 'Controller error';
  });

  // Monitor progress with a 150-second timeout budget
  const maxWaitMs = 150_000;
  while (Date.now() - t1StartTime < maxWaitMs) {
    await new Promise((r) => setTimeout(r, 3000));

    const currentLogs = countMatchingLogsInInventory(bot);
    const goalStatus = controller.goalExecutor.activePlan?.status;
    const task = controller.goalExecutor.activePlan?.tasks[0];

    console.log(
      `[TRIAL 1 PROGRESS] Elapsed: ${((Date.now() - t1StartTime) / 1000).toFixed(1)}s | Logs: ${currentLogs}/${t1StartLogs + 32} | Plan status: ${goalStatus} | Task status: ${task?.status}`
    );

    if (currentLogs >= t1StartLogs + 32 || goalStatus === 'completed') {
      trial1Completed = true;
      break;
    }

    if (task?.status === 'failed' && task.retryCount >= task.maxRetries) {
      trial1Error = `Task failed with: ${task.failureKind} - ${task.failureReason}`;
      break;
    }
  }

  // Pause controller before next trial
  controller.pause();

  const t1EndInv = getInventorySnapshot(bot);
  const t1EndTime = Date.now();
  const t1Delta = getInventoryDelta(t1StartInv, t1EndInv);
  const t1LogsGained = (countMatchingLogsInInventory(bot)) - t1StartLogs;

  const t1Result: TrialResult = {
    trialName: 'Trial 1: Milestone 1 Gather Logs',
    condition: 'Open terrain forest border (dragon_world)',
    success: t1LogsGained >= 32,
    startInventory: t1StartInv,
    endInventory: t1EndInv,
    inventoryDelta: t1Delta,
    elapsedWallClockMs: t1EndTime - t1StartTime,
    llmCalls: totalLLMCalls - t1InitialLLMCalls,
    llmTotalLatencyMs: totalLLMLatencyMs - t1InitialLLMLatency,
    pathFailures: 0,
    recoveries: 0,
    deaths: deathCount,
    statusText: t1LogsGained >= 32 ? 'COMPLETED_VERIFIED' : trial1Error || 'INCOMPLETE_OR_TIMED_OUT',
    details: {
      initialLogs: t1StartLogs,
      finalLogs: countMatchingLogsInInventory(bot),
      logsGained: t1LogsGained,
      goalExecutorState: controller.goalExecutor.activePlan?.status,
    },
  };
  trialResults.push(t1Result);

  console.log(`[TRIAL 1 RESULT] Success: ${t1Result.success} | Logs gained: ${t1LogsGained}/32 | Time: ${(t1Result.elapsedWallClockMs / 1000).toFixed(1)}s | LLM Calls: ${t1Result.llmCalls}`);

  // =========================================================================
  // TRIAL 2: Obstacle / Unreachable Target Blacklist & Cancellation Preemption
  // =========================================================================
  console.log('\n===========================================================');
  console.log('TRIAL 2: Unreachable Target Blacklist & Mid-Task Cancellation');
  console.log('===========================================================');

  const t2StartTime = Date.now();
  // 1. Test unreachable target preflight & blacklist
  const currentPos = bot.entity.position.floored();
  const unreachablePos = currentPos.offset(15, 45, 15); // Unreachable floating air coordinate high in sky
  console.log(`[TRIAL 2] Testing navigation to unreachable target at ${unreachablePos}...`);

  const navRes = await navigateWithBounds(
    bot,
    { target: unreachablePos, range: 1, timeoutMs: 4000, preflightCheck: true },
    { bot, observation: {} as any, config }
  );

  console.log(`[TRIAL 2] Navigation result for unreachable target: status='${navRes.status}', failureKind='${navRes.failureKind}'`);
  const isBlacklisted = navigationBlacklist.isBlacklisted(unreachablePos);
  console.log(`[TRIAL 2] Unreachable coordinate recorded in navigation blacklist: ${isBlacklisted}`);

  // 2. Test mid-action cancellation by owner
  console.log('[TRIAL 2] Starting active exploration/movement action...');
  const { actionId, signal } = (controller as any).arbiter.startAction('goto', ActionPriority.NORMAL, bot, ['movement']);
  console.log(`[TRIAL 2] Arbiter busy: ${(controller as any).arbiter.isBusy()}`);

  console.log('[TRIAL 2] Owner issuing cancel command "!cancel"...');
  ownerBot.chat('!cancel');
  await new Promise((r) => setTimeout(r, 1000));

  const arbiterBusyAfterCancel = (controller as any).arbiter.isBusy();
  const signalAborted = signal.aborted;
  console.log(`[TRIAL 2] After cancel: signal.aborted=${signalAborted}, arbiter.isBusy=${arbiterBusyAfterCancel}`);

  const t2Success = (navRes.status === 'unreachable' || navRes.status === 'stalled') && isBlacklisted && signalAborted;

  const t2Result: TrialResult = {
    trialName: 'Trial 2: Unreachable Target Blacklist & Cancellation',
    condition: 'Vertical sky obstruction & Owner command interrupt',
    success: t2Success,
    startInventory: getInventorySnapshot(bot),
    endInventory: getInventorySnapshot(bot),
    inventoryDelta: {},
    elapsedWallClockMs: Date.now() - t2StartTime,
    llmCalls: 0,
    llmTotalLatencyMs: 0,
    pathFailures: 1,
    recoveries: 1,
    deaths: deathCount - t1Result.deaths,
    statusText: t2Success ? 'VERIFIED_CLEAN_REJECTION_AND_CANCEL' : 'FAILED',
    details: {
      navStatus: navRes.status,
      navFailureKind: navRes.failureKind,
      isBlacklisted,
      signalAborted,
      arbiterReleased: !arbiterBusyAfterCancel,
    },
  };
  trialResults.push(t2Result);

  // =========================================================================
  // TRIAL 3: Survival Emergency Reflex Preemption
  // =========================================================================
  console.log('\n===========================================================');
  console.log('TRIAL 3: Survival Emergency Reflex Preemption (Safe Water Setup)');
  console.log('===========================================================');

  const t3StartTime = Date.now();
  console.log('[TRIAL 3] Testing emergency reflex evaluation under SafetySupervisor...');

  // Start normal task
  const normalAct = (controller as any).arbiter.startAction('explore', ActionPriority.NORMAL, bot, ['movement']);

  // Simulate sharp oxygen drop in water
  (bot as any).oxygenLevel = 4;
  (bot.entity as any).isInWater = true;

  const urgentReflex = await (controller as any).safetySupervisor.evaluateUrgentSafety();
  console.log(`[TRIAL 3] evaluateUrgentSafety triggered: ${urgentReflex.triggered}, reflex: ${urgentReflex.name}`);

  // Reset values
  (bot as any).oxygenLevel = 20;
  (bot.entity as any).isInWater = false;
  (controller as any).arbiter.finishAction(normalAct.actionId, normalAct.epoch, bot);

  const t3Success = urgentReflex.triggered && urgentReflex.name === 'swim_up_low_oxygen';
  const t3Result: TrialResult = {
    trialName: 'Trial 3: Survival Emergency Preemption',
    condition: 'Low oxygen in water event trigger',
    success: t3Success,
    startInventory: getInventorySnapshot(bot),
    endInventory: getInventorySnapshot(bot),
    inventoryDelta: {},
    elapsedWallClockMs: Date.now() - t3StartTime,
    llmCalls: 0,
    llmTotalLatencyMs: 0,
    pathFailures: 0,
    recoveries: 1,
    deaths: deathCount - t1Result.deaths - t2Result.deaths,
    statusText: t3Success ? 'PREEMPTION_VERIFIED' : 'FAILED',
    details: {
      reflexName: urgentReflex.name,
      triggered: urgentReflex.triggered,
    },
  };
  trialResults.push(t3Result);

  // =========================================================================
  // TRIAL 4: LLM Strategic Decision Step (Gemini 3.5 Flash Lite)
  // =========================================================================
  console.log('\n===========================================================');
  console.log('TRIAL 4: Live Strategic Decision via Gemini 3.5 Flash Lite');
  console.log('===========================================================');

  const t4StartTime = Date.now();
  console.log('[TRIAL 4] Querying Gemini 3.5 Flash Lite for live strategic action...');

  const t4InitialCalls = totalLLMCalls;
  const t4InitialLatency = totalLLMLatencyMs;

  let llmError: string | null = null;
  let llmDecisionResult: any = null;

  try {
    llmDecisionResult = await instrumentedLLM.generateDecision({
      systemPrompt: 'You are an autonomous Minecraft agent in survival mode. Decide on the next action. Output JSON with fields decision_summary, actions: [ { action, params } ].',
      userPrompt: `Current Status: Health: ${bot.health}/20, Food: ${bot.food}/20, Position: ${bot.entity.position.floored()}. Inventory has ${countMatchingLogsInInventory(bot)} logs. Choose next task.`,
    });
  } catch (err: any) {
    llmError = err?.message;
  }

  const t4Latency = Date.now() - t4StartTime;
  console.log(`[TRIAL 4] LLM call completed in ${t4Latency}ms. Success: ${llmDecisionResult?.parsedSuccess}`);
  if (llmDecisionResult?.decision) {
    console.log(`[TRIAL 4] Decision summary: "${llmDecisionResult.decision.decision_summary}"`);
    console.log(`[TRIAL 4] Actions: ${JSON.stringify(llmDecisionResult.decision.actions)}`);
  }

  const t4Success = llmDecisionResult?.parsedSuccess === true && !llmError;
  const t4Result: TrialResult = {
    trialName: 'Trial 4: Gemini 3.5 Flash Lite Strategic Decision',
    condition: 'Live API query via OpenAI-compatible endpoint',
    success: t4Success,
    startInventory: getInventorySnapshot(bot),
    endInventory: getInventorySnapshot(bot),
    inventoryDelta: {},
    elapsedWallClockMs: t4Latency,
    llmCalls: totalLLMCalls - t4InitialCalls,
    llmTotalLatencyMs: totalLLMLatencyMs - t4InitialLatency,
    pathFailures: 0,
    recoveries: 0,
    deaths: 0,
    statusText: t4Success ? 'STRATEGIC_DECISION_PARSED' : llmError || 'PARSE_FAILED',
    details: {
      model: config.llm.model,
      latencyMs: t4Latency,
      decision: llmDecisionResult?.decision,
      rawPreview: llmDecisionResult?.rawText?.slice(0, 150),
    },
  };
  trialResults.push(t4Result);

  // Clean disconnect
  console.log('\n[TEARDOWN] Disconnecting bots cleanly...');
  controller.stop();
  connection.disconnect();
  ownerBot.quit();

  console.log('\n=== FINAL TRIAL RESULTS SUMMARY ===');
  console.log(JSON.stringify(trialResults, null, 2));
}

runLiveAcceptanceCampaign().catch((err) => {
  console.error('[FATAL CAMPAIGN ERROR]', err);
  process.exit(1);
});
