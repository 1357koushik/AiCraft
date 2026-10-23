import { CampaignOrchestrator } from '../src/campaign/orchestrator.js';
import { VanillaGroundTruthObserver } from '../tools/vanilla-observer/index.js';
import { loadConfig } from '../src/config/index.js';

async function main() {
  const config = loadConfig();
  const serverHost = config.server.host || '127.0.0.1';
  const serverPort = config.server.port || 25565;
  const bridgePort = 25580;
  const runId = `campaign_run_${Date.now()}`;

  console.log('================================================================');
  console.log('   LAUNCHING COMPREHENSIVE LIVE ACTION-COVERAGE CAMPAIGN        ');
  console.log('================================================================');

  // Pre-flight check: Probe target Minecraft server TCP reachability
  console.log(`[Preflight] Probing target server reachability at ${serverHost}:${serverPort}...`);
  const { checkServerReachability } = await import('../src/runner/preflight.js');
  const probe = await checkServerReachability(serverHost, serverPort, 2000);
  if (!probe.reachable) {
    console.error('\n================================================================');
    console.error('   [LIVE CAMPAIGN BLOCKED]');
    console.error(`   Target Minecraft server is NOT REACHABLE at ${serverHost}:${serverPort}.`);
    console.error(`   Probe error: ${probe.error}`);
    console.error('   Live campaign requires an active instrumented Minecraft 1.21.6 server.');
    console.error('   Mocks will NOT be substituted. Failing immediately as BLOCKED.');
    console.error('================================================================\n');
    process.exit(2);
  }
  console.log(`[Preflight] Target Minecraft server is ONLINE and responding.`);

  console.log(`[Observer] Starting VanillaGroundTruthObserver (spectator: 1357koushik, bridge: ${bridgePort})...`);

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
    console.error(`[Observer] Failed to start ground-truth observer: ${err.message}`);
    process.exit(1);
  }

  const orchestrator = new CampaignOrchestrator({ config, observer });
  const familyFilter = process.argv[2];
  if (familyFilter) {
    console.log(`[Campaign] Filtering execution to family matching: '${familyFilter}'`);
  }
  const summary = await orchestrator.executeCampaign(observer, familyFilter);

  console.log('\n================================================================');
  console.log('   CAMPAIGN EXECUTION COMPLETE                                  ');
  console.log('================================================================');
  console.log(`Overall Action Coverage: ${summary.overallActionCoveragePercentage}% (${summary.totalActionsEvaluated} evaluated)`);
  console.log(`Campaign Summary Report (JSON): ${summary.artifacts.summaryJson}`);
  console.log(`Campaign Summary Report (MD): ${summary.artifacts.summaryMarkdown}`);
  console.log(`Top Defects Count: ${summary.topRankedDefects.length}`);
}

main().catch((err) => {
  console.error('Fatal Campaign Execution Error:', err);
  process.exit(1);
});
