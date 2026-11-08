/**
 * Live survival milestone runner.
 *
 * Usage: npm run milestone -- <1|2>
 *
 * Connects a ground-truth observer and the agent bot to the live server, issues the
 * milestone's owner goal, waits for the target item, then writes a JSON and Markdown
 * report to logs/survival/.
 *
 * Verification honesty: the pass checks read the agent's own client inventory, and the
 * observer log does not attribute block or pickup events to a player. Results are therefore
 * reported as SELF_REPORTED_PASS, never PASS, until an independent check exists. Every
 * operator command sent by the runner is recorded in the report.
 */
import fs from 'fs';
import path from 'path';
import mineflayer, { Bot } from 'mineflayer';
import { pathfinder } from 'mineflayer-pathfinder';
import { loadConfig } from '../src/config/index.js';
import { AgentLogger } from '../src/utils/logger.js';
import { MemoryManager } from '../src/memory/index.js';
import { SafetyManager } from '../src/safety/index.js';
import { createLLMProvider } from '../src/llm/index.js';
import { AgentController } from '../src/agent/loop.js';
import { parseAndValidateGoalSpec, getBotInventoryCounts } from '../src/agent/goals.js';
import { updatePathfinderMovements } from '../src/actions/techniques.js';
import { techniqueBuildVerifiedShelter } from '../src/actions/shelter.js';
import { VanillaGroundTruthObserver } from '../tools/vanilla-observer/index.js';
import { checkServerReachability } from '../src/runner/preflight.js';

type Inventory = Record<string, number>;
type BlockEvent = { block: string; position: any; time: string };
type Status = 'PASS' | 'SELF_REPORTED_PASS' | 'FAIL' | 'BLOCKED' | 'TIMEOUT';

interface RunContext {
  bot: Bot;
  initialInv: Inventory;
  finalInv: Inventory;
  deaths: number;
  relevantBreaks: BlockEvent[];
  shelter?: { status: string; blocksPlaced: number; expectedBlocks: number };
}

interface MilestoneDefinition {
  id: string;
  name: string;
  ownerGoal: string;
  extraGoals: string[];
  timeoutMs: number;
  runIdPrefix: string;
  memoryPrefix: string;
  targetItem: string;
  settleBeforeStartMs: number;
  /** Operator setup run before the goal. Every command goes through `send` and is reported. */
  prepare?: (bot: Bot, send: (cmd: string) => void) => Promise<{ teleported: boolean; inventoryGranted: boolean }>;
  buildShelterAfterTarget: boolean;
  isRelevantBreak: (block: string) => boolean;
  isRelevantPlace: (block: string) => boolean;
  /** Returns the postcondition values and, if not met, why. */
  evaluate: (ctx: RunContext) => { checks: Record<string, boolean | number>; failureReason?: string };
  successReason: string;
}

const MILESTONES: Record<string, MilestoneDefinition> = {
  '1': {
    id: 'milestone_01_wood_tools',
    name: 'Phase 1: Spawn Assessment, First Wood & Crafting Station',
    ownerGoal: 'craft a wooden pickaxe',
    extraGoals: [],
    timeoutMs: 180000,
    runIdPrefix: 'survival_run',
    memoryPrefix: 'survival',
    targetItem: 'wooden_pickaxe',
    settleBeforeStartMs: 1500,
    buildShelterAfterTarget: false,
    isRelevantBreak: (b) => b.includes('log') || b.includes('wood'),
    isRelevantPlace: (b) => b === 'crafting_table' || b === 'furnace',
    evaluate: ({ finalInv, relevantBreaks }) => {
      const hasWoodenPickaxe = (finalInv['wooden_pickaxe'] || 0) >= 1;
      const checks = {
        hasWoodenPickaxe,
        woodenPickaxeCount: finalInv['wooden_pickaxe'] || 0,
        hasCraftingStationOrPlanks:
          (finalInv['crafting_table'] || 0) >= 1 || Object.keys(finalInv).some((k) => k.endsWith('_planks')),
        logBreaksObserved: relevantBreaks.length > 0,
      };
      const failureReason = !relevantBreaks.length
        ? 'Observer did not record any log block breaks.'
        : !hasWoodenPickaxe
        ? 'Wooden pickaxe not in final inventory.'
        : undefined;
      return { checks, failureReason };
    },
    successReason:
      'Wooden pickaxe in agent inventory and log breaks seen by the observer. Not independently attributed to the bot.',
  },
  '2': {
    id: 'milestone_02_stone_age',
    name: 'Phase 2: Stone Age, Cobblestone Mining & Base Shelter',
    ownerGoal: 'craft a stone pickaxe',
    extraGoals: ['build survival shelter'],
    timeoutMs: 240000,
    runIdPrefix: 'survival_m2_run',
    memoryPrefix: 'survival_m2',
    targetItem: 'stone_pickaxe',
    settleBeforeStartMs: 2000,
    prepare: async (bot, send) => {
      console.log('[Observer] Setting daylight, clearing weather and mobs...');
      send('/gamerule doDaylightCycle false');
      send('/time set 6000');
      send('/weather clear');
      send('/kill @e[type=!player]');
      await sleep(800);

      const inv = getBotInventoryCounts(bot);
      if ((inv['wooden_pickaxe'] || 0) >= 1 && (inv['birch_planks'] || 0) >= 4) {
        return { teleported: false, inventoryGranted: false };
      }
      // Recreate the Milestone 1 end state with commands; the report marks this as granted.
      console.log('[Observer] Granting Milestone 1 end-state inventory to dragonai...');
      send('/tp dragonai 28 67 -52');
      await sleep(500);
      send('/clear dragonai');
      await sleep(300);
      send('/give dragonai wooden_pickaxe 1');
      send('/give dragonai birch_planks 8');
      send('/give dragonai stick 4');
      send('/give dragonai birch_log 5');
      await sleep(1200);
      return { teleported: true, inventoryGranted: true };
    },
    buildShelterAfterTarget: true,
    isRelevantBreak: (b) => b === 'stone' || b === 'cobblestone' || b === 'deepslate',
    isRelevantPlace: () => true,
    evaluate: ({ initialInv, finalInv, relevantBreaks, shelter }) => {
      const hasStonePickaxe = (finalInv['stone_pickaxe'] || 0) >= 1;
      const blocksPlaced = shelter?.blocksPlaced ?? 0;
      const expected = shelter?.expectedBlocks ?? 23;
      const shelterEnclosed = shelter?.status === 'success' && blocksPlaced >= expected;
      const checks = {
        hasStonePickaxe,
        stonePickaxeCount: finalInv['stone_pickaxe'] || 0,
        cobblestoneMinedObserved:
          relevantBreaks.length > 0 || (finalInv['cobblestone'] || 0) > (initialInv['cobblestone'] || 0),
        shelterBlocksPlaced: blocksPlaced,
        shelterExpectedBlocks: expected,
        shelterEnclosed,
      };
      const failureReason = !hasStonePickaxe
        ? 'Stone pickaxe not in final inventory.'
        : !shelterEnclosed
        ? `Shelter incomplete (${blocksPlaced}/${expected} blocks, enclosure not verified).`
        : undefined;
      return { checks, failureReason };
    },
    successReason:
      'Stone pickaxe crafted and shelter enclosure verified according to the agent client. Not independently verified by the observer.',
  },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmtPos = (p: any) => `(${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})`;

function readObserverEvents(logPath: string): any[] {
  try {
    if (!fs.existsSync(logPath)) return [];
    return fs
      .readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch (err) {
    console.warn('[Observer] Failed to read event log file:', err);
    return [];
  }
}

async function connectAgentBot(host: string, port: number): Promise<Bot> {
  return new Promise<Bot>((resolve, reject) => {
    const bot = mineflayer.createBot({ host, port, username: 'dragonai', version: '1.21.6', auth: 'offline' });
    bot.loadPlugin(pathfinder);
    bot.once('spawn', () => {
      console.log(`[Agent] Spawned at ${bot.entity?.position?.floored()} in '${bot.game?.dimension}'.`);
      (bot as any).pathfinder.setMovements(updatePathfinderMovements(bot));
      resolve(bot);
    });
    bot.on('error', reject);
    bot.on('kicked', (reason) => reject(new Error(`Kicked: ${JSON.stringify(reason)}`)));
  });
}

async function runMilestone(m: MilestoneDefinition) {
  const startWallClock = Date.now();
  const startTime = new Date().toISOString();
  console.log(`=== RUNNING SURVIVAL MILESTONE: ${m.id} — ${m.name} ===`);

  const config = loadConfig();
  const serverHost = config.server.host || '127.0.0.1';
  const serverPort = config.server.port || 25565;
  const runId = `${m.runIdPrefix}_${Date.now()}`;

  // 1. Preflight
  const probe = await checkServerReachability(serverHost, serverPort, 3000);
  if (!probe.reachable) {
    console.error(`[Preflight] Server not reachable at ${serverHost}:${serverPort}. Aborting.`);
    process.exit(2);
  }

  // 2. Observer
  const logsDir = path.resolve(process.cwd(), 'logs/survival');
  fs.mkdirSync(logsDir, { recursive: true });
  const observer = new VanillaGroundTruthObserver({
    serverHost,
    serverPort,
    observerUsername: '1357koushik',
    runId,
    logDir: 'logs/survival',
    bridgePort: 25580,
    snapshotIntervalMs: 500,
    logger: console,
  });
  await observer.start();
  await sleep(1200);

  // 3. Agent bot
  let agentBot: Bot;
  try {
    agentBot = await connectAgentBot(serverHost, serverPort);
  } catch (err: any) {
    console.error(`[Agent] Failed to connect agent bot: ${err.message}`);
    await observer.stop();
    process.exit(1);
  }
  await sleep(m.settleBeforeStartMs);

  // 4. Optional operator setup (all commands recorded)
  const operatorCommandsUsed: string[] = [];
  const send = (cmd: string) => {
    operatorCommandsUsed.push(cmd);
    observer.observerBot?.chat(cmd);
  };
  const setup = m.prepare ? await m.prepare(agentBot, send) : { teleported: false, inventoryGranted: false };

  // 5. Entry conditions
  const initialInv = getBotInventoryCounts(agentBot);
  const initialPos = agentBot.entity?.position ? { ...agentBot.entity.position } : { x: 0, y: 0, z: 0 };
  const initialVitals = {
    health: agentBot.health ?? 20,
    food: agentBot.food ?? 20,
    oxygen: (agentBot as any).oxygenLevel ?? 20,
    position: initialPos,
  };
  console.log(`[Entry] Inventory: ${JSON.stringify(initialInv)} | Pos: ${fmtPos(initialPos)} | Commands: ${operatorCommandsUsed.length}`);

  // 6. Controller + owner goal
  const logger = new AgentLogger(config);
  const memory = new MemoryManager(`${m.memoryPrefix}_${Date.now()}`);
  const controller = new AgentController(agentBot, config, logger, memory, new SafetyManager(config), createLLMProvider(config, logger));
  controller.start().catch((err) => console.error(`[Agent Loop] Controller error: ${err.message}`));

  console.log(`[Owner] Issuing goal: "${m.ownerGoal}"`);
  const goalSpec = parseAndValidateGoalSpec(m.ownerGoal, initialInv, true);
  if (!goalSpec) {
    console.error('[Owner] Failed to parse owner goal spec.');
    controller.stop();
    agentBot.quit();
    await observer.stop();
    process.exit(1);
  }
  const goalSetResult = controller.goalExecutor.setGoal(goalSpec, initialInv);
  console.log(`[Goal Executor] Accepted: ${goalSetResult.accepted} (tasks: ${controller.goalExecutor.activePlan?.tasks.length})`);

  const tasksExecuted: Array<{ id: string; action: string; status: string; failureReason?: string }> = [];
  let deaths = 0;
  agentBot.on('death', () => {
    deaths++;
    console.warn(`[EVENT:DEATH] Agent died (total: ${deaths})`);
  });

  // 7. Wait for the target item
  const pollIntervalMs = 500;
  let elapsedMs = 0;
  let targetReached = false;
  while (elapsedMs < m.timeoutMs) {
    await sleep(pollIntervalMs);
    elapsedMs = Date.now() - startWallClock;
    const count = getBotInventoryCounts(agentBot)[m.targetItem] || 0;

    if (elapsedMs % 5000 < pollIntervalMs) {
      const pos = agentBot.entity?.position;
      console.log(`[Watchdog +${Math.round(elapsedMs / 1000)}s] ${m.targetItem}: ${count} | HP: ${agentBot.health}${pos ? ' | Pos: ' + fmtPos(pos) : ''}`);
      for (const task of controller.goalExecutor.activePlan?.tasks || []) {
        if (!tasksExecuted.some((t) => t.id === task.id && t.status === task.status)) {
          tasksExecuted.push({ id: task.id, action: task.actionName, status: task.status, failureReason: task.failureReason });
        }
      }
    }
    if (count >= 1) {
      console.log(`[Progress] ${m.targetItem} in inventory at +${Math.round(elapsedMs / 1000)}s.`);
      targetReached = true;
      break;
    }
    if (deaths > 0) break;
  }

  // 8. Optional shelter step
  let shelter: RunContext['shelter'];
  if (m.buildShelterAfterTarget && targetReached && deaths === 0) {
    console.log('[Owner] Issuing goal: "build survival shelter"');
    controller.pause();
    await sleep(1000);
    try {
      const result = await techniqueBuildVerifiedShelter(agentBot, {}, { bot: agentBot });
      const build = (result.details as any)?.buildResult;
      shelter = { status: result.status, blocksPlaced: build?.blocksPlaced ?? 0, expectedBlocks: build?.expectedBlocks ?? 23 };
      console.log(`[Shelter] ${result.status}: ${result.reason}`);
      tasksExecuted.push({ id: 'task_build_shelter', action: 'build_shelter', status: result.status, failureReason: result.reason });
    } catch (err: any) {
      console.warn(`[Shelter] Exception: ${err.message}`);
    }
  }

  await sleep(2000);

  // 9. Final state + observer evidence
  const finalInv = getBotInventoryCounts(agentBot);
  const finalPos = agentBot.entity?.position ? { ...agentBot.entity.position } : { x: 0, y: 0, z: 0 };
  const finalVitals = { health: agentBot.health ?? 0, food: agentBot.food ?? 0, oxygen: (agentBot as any).oxygenLevel ?? 20, position: finalPos };
  const inventoryDeltas: Inventory = {};
  for (const [k, v] of Object.entries(finalInv)) inventoryDeltas[k] = v - (initialInv[k] || 0);

  const events = readObserverEvents(observer.logWriter.activeFilePath);
  const toBlockEvents = (type: string, field: 'oldBlock' | 'newBlock'): BlockEvent[] =>
    events
      .filter((e) => e.eventType === type)
      .map((e) => ({ block: e.blockId || e.details?.[field], position: e.coordinates, time: e.timestamp }));
  const relevantBreaks = toBlockEvents('BLOCK_BREAK', 'oldBlock').filter((b) => b.block && m.isRelevantBreak(b.block));
  const relevantPlaces = toBlockEvents('BLOCK_PLACE', 'newBlock').filter((b) => b.block && m.isRelevantPlace(b.block));
  const itemPickups = events.filter((e) => e.eventType === 'ITEM_PICKUP').map((e) => ({ entityId: e.details?.entityId, time: e.timestamp }));

  // 10. Verdict (self-reported; see header comment)
  const alive = agentBot.health > 0;
  const { checks, failureReason } = m.evaluate({ bot: agentBot, initialInv, finalInv, deaths, relevantBreaks, shelter });
  const selfReportedPostconditionsMet = alive && deaths === 0 && !failureReason;
  const independentOracleVerified = false;
  const status: Status = independentOracleVerified
    ? 'PASS'
    : selfReportedPostconditionsMet
    ? 'SELF_REPORTED_PASS'
    : !targetReached && elapsedMs >= m.timeoutMs && deaths === 0
    ? 'TIMEOUT'
    : 'FAIL';
  const statusReason = selfReportedPostconditionsMet
    ? m.successReason
    : deaths > 0
    ? 'Bot died during the run.'
    : failureReason || 'Timed out before completion.';

  const report = {
    milestoneId: m.id,
    milestoneName: m.name,
    runId,
    worldId: 'survival_disposable_m1',
    serverImplementation: 'Vanilla 1.21.6',
    targetMinecraftVersion: '1.21.6',
    startTime,
    endTime: new Date().toISOString(),
    durationMs: Date.now() - startWallClock,
    entryConditions: {
      naturalSpawn: !setup.teleported,
      initialInventoryEmpty: Object.keys(initialInv).length === 0,
      inventoryGrantedByCommand: setup.inventoryGranted,
      noCheatsUsed: operatorCommandsUsed.length === 0,
      operatorCommandsUsed,
      initialVitals,
      initialInventory: initialInv,
    },
    ownerGoals: [m.ownerGoal, ...m.extraGoals],
    execution: { status, statusReason, tasksExecuted, deaths },
    finalState: { isAlive: alive, finalVitals, finalInventory: finalInv, inventoryDeltas },
    observerEvidence: {
      note: 'Observer events are not attributed to a player.',
      totalEventsCaptured: events.length,
      relevantBlockBreakEvents: relevantBreaks,
      relevantBlockPlaceEvents: relevantPlaces,
      itemPickupEvents: itemPickups,
    },
    postconditions: {
      ...checks,
      selfReportedPostconditionsMet,
      independentOracleVerified,
      verificationSource: 'agent client inventory and routine return values (self-reported); observer events unattributed',
    },
  };

  // 11. Write report
  const jsonPath = path.join(logsDir, `${m.id}.json`);
  const mdPath = path.join(logsDir, `${m.id}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(mdPath, renderMarkdown(report), 'utf8');
  console.log(`=== ${m.id} VERDICT: ${status} — report: ${mdPath} ===`);

  controller.stop();
  agentBot.quit();
  await observer.stop();
  process.exit(status === 'PASS' || status === 'SELF_REPORTED_PASS' ? 0 : 1);
}

function renderMarkdown(r: any): string {
  const e = r.entryConditions;
  const statusBadge =
    r.execution.status === 'PASS'
      ? '🟢 **PASS**'
      : r.execution.status === 'SELF_REPORTED_PASS'
      ? '🟡 **SELF_REPORTED_PASS** (not independently verified)'
      : `🔴 **${r.execution.status}**`;
  const items = new Set([...Object.keys(e.initialInventory), ...Object.keys(r.finalState.finalInventory)]);
  const invRows = [...items]
    .map((item) => {
      const before = e.initialInventory[item] || 0;
      const after = r.finalState.finalInventory[item] || 0;
      const d = after - before;
      return `| \`${item}\` | ${before} | ${after} | ${d >= 0 ? '+' : ''}${d} |`;
    })
    .join('\n');
  const blockList = (list: BlockEvent[]) =>
    list.slice(0, 10).map((b) => `  - \`${b.block}\` at \`(${b.position?.x}, ${b.position?.y}, ${b.position?.z})\` at \`${b.time}\``).join('\n');
  const checks = Object.entries(r.postconditions)
    .map(([k, v]) => `- **${k}**: \`${v}\``)
    .join('\n');

  return `# Milestone Report: ${r.milestoneName}

## 1. Summary
- **Milestone ID**: \`${r.milestoneId}\` (run \`${r.runId}\`)
- **Status**: ${statusBadge}
- **Reason**: ${r.execution.statusReason}
- **Duration**: \`${r.durationMs}ms\` (${r.startTime} -> ${r.endTime})
- **Operator Commands Used**: **${e.operatorCommandsUsed.length}**${e.operatorCommandsUsed.length ? ' (' + e.operatorCommandsUsed.map((c: string) => '`' + c + '`').join(', ') + ')' : ''}

## 2. Entry Conditions
| Metric | Value | Note |
| :--- | :--- | :--- |
| Initial Inventory | \`${JSON.stringify(e.initialInventory)}\` | ${e.inventoryGrantedByCommand ? '⚠️ Granted by /give' : e.initialInventoryEmpty ? 'Empty' : 'Carried over'} |
| Initial Position | \`${fmtPos(e.initialVitals.position)}\` | ${e.naturalSpawn ? 'No /tp issued' : '⚠️ Set by /tp'} |
| Initial Health / Food | \`${e.initialVitals.health}/20\` / \`${e.initialVitals.food}/20\` | |

## 3. Goals & Tasks
${r.ownerGoals.map((g: string, i: number) => `${i + 1}. \`"${g}"\``).join('\n')}

${r.execution.tasksExecuted.map((t: any) => `- \`${t.id}\` (${t.action}): **${t.status}**${t.failureReason ? ' - ' + t.failureReason : ''}`).join('\n')}

## 4. Final State
| Item | Before | After | Delta |
| :--- | :---: | :---: | :---: |
${invRows}

- **Final Health / Food**: \`${r.finalState.finalVitals.health}/20\` / \`${r.finalState.finalVitals.food}/20\` | Alive: \`${r.finalState.isAlive}\`
- **Final Position**: \`${fmtPos(r.finalState.finalVitals.position)}\`
- **Deaths**: \`${r.execution.deaths}\`

## 5. Observer Log Evidence (events are not attributed to a player)
- **Total Events**: \`${r.observerEvidence.totalEventsCaptured}\`
- **Relevant Block Breaks**: \`${r.observerEvidence.relevantBlockBreakEvents.length}\`
${blockList(r.observerEvidence.relevantBlockBreakEvents)}
- **Relevant Block Places**: \`${r.observerEvidence.relevantBlockPlaceEvents.length}\`
${blockList(r.observerEvidence.relevantBlockPlaceEvents)}
- **Item Pickups**: \`${r.observerEvidence.itemPickupEvents.length}\`

## 6. Postconditions
${checks}
`;
}

const arg = process.argv[2];
const milestone = MILESTONES[arg];
if (!milestone) {
  console.error(`Usage: npm run milestone -- <${Object.keys(MILESTONES).join('|')}>`);
  process.exit(2);
}
runMilestone(milestone).catch((err) => {
  console.error(`Fatal error during ${milestone.id}:`, err);
  process.exit(1);
});
