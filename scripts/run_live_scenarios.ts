import mineflayer, { Bot } from 'mineflayer';
import { pathfinder } from 'mineflayer-pathfinder';
import fs from 'fs';
import path from 'path';
import { loadConfig } from '../src/config/index.js';
import { updatePathfinderMovements } from '../src/actions/techniques.js';
import { VanillaGroundTruthObserver } from '../tools/vanilla-observer/index.js';
import {
  IntegrationScenarioRunner,
  VanillaBridgeClient,
  breakLogScenario,
  unreachableTargetScenario,
  cancelMovementScenario,
  ScenarioReport,
} from '../src/runner/index.js';

async function main() {
  console.log('================================================================');
  console.log('   STARTING GROUND-TRUTH INTEGRATION SCENARIOS EXECUTION        ');
  console.log('================================================================');

  const config = loadConfig();
  const serverHost = config.server.host || '127.0.0.1';
  const serverPort = config.server.port || 25565;
  const bridgePort = 25580;
  const runId = `live_run_${Date.now()}`;

  // Pre-flight check: Probe target Minecraft server TCP reachability
  console.log(`[Preflight] Probing target server reachability at ${serverHost}:${serverPort}...`);
  const { checkServerReachability } = await import('../src/runner/preflight.js');
  const probe = await checkServerReachability(serverHost, serverPort, 2000);
  if (!probe.reachable) {
    console.error('\n================================================================');
    console.error('   [LIVE TEST BLOCKED]');
    console.error(`   Target Minecraft server is NOT REACHABLE at ${serverHost}:${serverPort}.`);
    console.error(`   Probe error: ${probe.error}`);
    console.error('   Live tests require an active instrumented Minecraft 1.21.6 server.');
    console.error('   Mocks will NOT be substituted. Failing immediately as BLOCKED.');
    console.error('================================================================\n');
    process.exit(2);
  }
  console.log(`[Preflight] Target Minecraft server is ONLINE and responding.`);

  // 1. Start Server-Side Ground-Truth Observer
  console.log(`\n[Observer] Initializing VanillaGroundTruthObserver (spectator: 1357koushik, bridge: ${bridgePort})...`);
  const observer = new VanillaGroundTruthObserver({
    serverHost,
    serverPort,
    observerUsername: '1357koushik',
    runId,
    logDir: 'logs/integration',
    bridgePort,
    snapshotIntervalMs: 500,
    logger: console,
  });

  try {
    await observer.start();
    console.log('[Observer] Ground-truth observer started and spectator connected.');
  } catch (err: any) {
    console.error('\n================================================================');
    console.error('   [LIVE TEST BLOCKED]');
    console.error(`   Spectator ground-truth observer failed to connect: ${err.message}`);
    console.error('   Live tests require the ground-truth spectator observer to be online.');
    console.error('   Mocks will NOT be substituted. Failing immediately as BLOCKED.');
    console.error('================================================================\n');
    process.exit(2);
  }

  // 2. Connect Agent Bot Under Test
  console.log(`\n[AgentBot] Connecting agent bot to ${serverHost}:${serverPort} as 'dragonai'...`);
  const agentBot: Bot = await new Promise((resolve, reject) => {
    const bot = mineflayer.createBot({
      host: serverHost,
      port: serverPort,
      username: 'dragonai',
      version: '1.21.6',
      auth: 'offline',
    });

    bot.loadPlugin(pathfinder);

    bot.once('spawn', () => {
      console.log(`[AgentBot] Connected and spawned at ${bot.entity?.position?.floored()} in dimension '${bot.game?.dimension}'.`);
      const movements = updatePathfinderMovements(bot);
      (bot as any).pathfinder.setMovements(movements);
      resolve(bot);
    });

    bot.on('error', (err) => {
      console.error(`[AgentBot] Connection error: ${err.message}`);
      reject(err);
    });

    bot.on('kicked', (reason) => {
      console.error(`[AgentBot] Bot kicked: ${JSON.stringify(reason)}`);
      reject(new Error(`Kicked: ${JSON.stringify(reason)}`));
    });
  });

  // Short delay to allow entity synchronization between spectator and bot
  await new Promise((r) => setTimeout(r, 1500));

  // 3. Initialize Scenario Runner
  const bridgeClient = new VanillaBridgeClient({
    host: '127.0.0.1',
    port: bridgePort,
    logDir: 'logs/integration',
  });

  const runner = new IntegrationScenarioRunner({
    config,
    bridgeClient,
    reportsDir: 'logs/integration/scenarios',
    logger: console,
  });

  const reports: ScenarioReport[] = [];

  try {
    // SCENARIO 1: Break and collect one accessible log
    console.log('\n================================================================');
    console.log('   SCENARIO 1: Break and collect one accessible log             ');
    console.log('================================================================');
    const report1 = await runner.runScenario(breakLogScenario, agentBot);
    reports.push(report1);
    console.log(`\n>>> SCENARIO 1 STATUS: ${report1.status} (${report1.statusReason})`);
    console.log(`>>> JSON Report: ${report1.logPaths.scenarioJsonReport}`);
    console.log(`>>> Markdown Report: ${report1.logPaths.scenarioMarkdownReport}`);

    await new Promise((r) => setTimeout(r, 1000));

    // SCENARIO 2: Reject an unreachable floating target without repeated attempts
    console.log('\n================================================================');
    console.log('   SCENARIO 2: Reject unreachable target without repeated attempts');
    console.log('================================================================');
    const report2 = await runner.runScenario(unreachableTargetScenario, agentBot);
    reports.push(report2);
    console.log(`\n>>> SCENARIO 2 STATUS: ${report2.status} (${report2.statusReason})`);
    console.log(`>>> JSON Report: ${report2.logPaths.scenarioJsonReport}`);
    console.log(`>>> Markdown Report: ${report2.logPaths.scenarioMarkdownReport}`);

    await new Promise((r) => setTimeout(r, 1000));

    // SCENARIO 3: Cancel long movement and verify no superseded side effects
    console.log('\n================================================================');
    console.log('   SCENARIO 3: Cancel movement and verify no superseded side effects');
    console.log('================================================================');
    const report3 = await runner.runScenario(cancelMovementScenario, agentBot);
    reports.push(report3);
    console.log(`\n>>> SCENARIO 3 STATUS: ${report3.status} (${report3.statusReason})`);
    console.log(`>>> JSON Report: ${report3.logPaths.scenarioJsonReport}`);
    console.log(`>>> Markdown Report: ${report3.logPaths.scenarioMarkdownReport}`);
  } catch (err: any) {
    console.error(`\n[Execution Error] Scenario run threw error: ${err.message}`, err);
  } finally {
    console.log('\n[Teardown] Disconnecting agent bot and stopping ground-truth observer...');
    try {
      agentBot.quit();
    } catch {}

    try {
      await observer.stop();
    } catch {}

    console.log('================================================================');
    console.log('   SCENARIO EXECUTION SUMMARY                                   ');
    console.log('================================================================');
    for (const rep of reports) {
      console.log(`- [${rep.status}] ${rep.name} (${rep.scenarioId}) - ${rep.statusReason}`);
    }
  }
}

main().catch((err) => {
  console.error('Fatal execution error:', err);
  process.exit(1);
});
