import { buildCampaignFamilies } from '../src/campaign/scenarios_builder.js';
import { allActions, actionMap } from '../src/actions/registry.js';
import { ACTION_NAME_ALIASES } from '../src/runner/runner.js';
import { actionContractManifest } from '../src/contracts/index.js';

console.log('=== AUDITING SCENARIO-TO-ACTION MAPPINGS ===');
console.log(`Registered Actions in Registry: ${allActions.length}`);
console.log(`Registered Actions in Manifest: ${Object.keys(actionContractManifest.registeredActions).length}`);
console.log(`Techniques in Manifest: ${Object.keys(actionContractManifest.compositeTechniques).length}`);
console.log(`Reflex/System in Manifest: ${Object.keys(actionContractManifest.systemAndReflexContracts).length}`);
console.log(`Not Implemented in Manifest: ${Object.keys(actionContractManifest.notImplementedContracts).length}`);

const suites = buildCampaignFamilies();
console.log(`\nTotal Family Suites: ${suites.length}`);
let totalScenarios = 0;
const missingTargetActions = new Map<string, string[]>();
const aliasedTargetActions = new Map<string, string>();
const validDirectActions = new Set<string>();

for (const s of suites) {
  totalScenarios += s.scenarios.length;
  for (const sc of s.scenarios) {
    const act = sc.targetAction;
    if (actionMap.has(act)) {
      validDirectActions.add(act);
    } else if (ACTION_NAME_ALIASES[act] && actionMap.has(ACTION_NAME_ALIASES[act])) {
      aliasedTargetActions.set(act, ACTION_NAME_ALIASES[act]);
    } else {
      if (!missingTargetActions.has(act)) {
        missingTargetActions.set(act, []);
      }
      missingTargetActions.get(act)!.push(`${s.id}:${sc.id}`);
    }
  }
}

console.log(`\nAll 58 Registered Actions:`, allActions.map((a) => a.name).sort());
console.log(`Valid Direct Actions Covered: ${validDirectActions.size}`);
console.log(`\nAliased Actions (${aliasedTargetActions.size}):`);
for (const [alias, canonical] of aliasedTargetActions.entries()) {
  console.log(`  - ${alias} -> ${canonical}`);
}

console.log(`\n=== RECORDED FAMILY EXECUTION FILES ===`);
import fs from 'fs';
import path from 'path';

const campDir = 'logs/integration/campaign';
const files = fs.readdirSync(campDir).filter((f) => f.startsWith('family_') && f.endsWith('.json')).sort();
for (const f of files) {
  const data = JSON.parse(fs.readFileSync(path.join(campDir, f), 'utf8'));
  console.log(`\n[${f}] ${data.familyName} (${data.actionsCovered.length} actions)`);
  console.log(`  Summary: PASS=${data.summary.passed}, FAIL=${data.summary.failed}, BLOCKED=${data.summary.blocked}, NOT_IMPL=${data.summary.notImplemented}`);
  for (const act of data.actionResults) {
    if (act.status === 'LIVE_PASS') {
      console.log(`    🟢 ${act.actionId}: scenariosRun=${act.scenariosRun}, passed=${act.scenariosPassed}, events=${act.observedServerEventsCount}`);
    } else if (act.status === 'LIVE_FAIL') {
      console.log(`    🔴 ${act.actionId}: scenariosRun=${act.scenariosRun}, divergence=${act.firstDivergence?.assertionName}`);
    }
  }
}



