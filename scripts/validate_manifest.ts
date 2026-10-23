import fs from 'fs';
import path from 'path';
import { allActions } from '../src/actions/registry.js';
import {
  actionContractManifest,
  validateManifestRules,
  ActionContract,
  CoverageStatus,
} from '../src/contracts/index.js';

function validateManifest(): void {
  console.log('================================================================');
  console.log('   ACTION CONTRACT & EVIDENCE MANIFEST VALIDATION               ');
  console.log('================================================================');

  const manifest = actionContractManifest;
  const liveActions = allActions;
  const errors: string[] = [];
  const warnings: string[] = [];

  console.log(`- Manifest Version: ${manifest.manifestVersion}`);
  console.log(`- Target Version: Minecraft Java ${manifest.targetMinecraftVersion} (Protocol ${manifest.targetProtocol})`);
  console.log(`- Registered Actions in Live Registry: ${liveActions.length}`);
  console.log(`- Registered Actions in Manifest: ${Object.keys(manifest.registeredActions).length}`);
  console.log(`- Composite Techniques in Manifest: ${Object.keys(manifest.compositeTechniques).length}`);
  console.log(`- System & Reflex Contracts: ${Object.keys(manifest.systemAndReflexContracts).length}`);
  console.log(`- Explicitly Not Implemented: ${Object.keys(manifest.notImplementedContracts).length}`);

  // 1. Check parity between live registry and manifest
  const liveNames = new Set(liveActions.map((a) => a.name));
  const manifestNames = new Set(Object.keys(manifest.registeredActions));

  for (const name of liveNames) {
    if (!manifestNames.has(name)) {
      errors.push(`Missing Contract: Action '${name}' is registered in live registry but absent from contract manifest.`);
    }
  }

  for (const name of manifestNames) {
    if (!liveNames.has(name)) {
      errors.push(`Orphan Contract: Contract '${name}' exists in manifest but is not registered in live registry.`);
    }
  }

  // 2. Validate all contracts for required fields and explicit evidence status
  const allContracts: ActionContract[] = [
    ...Object.values(manifest.registeredActions),
    ...Object.values(manifest.compositeTechniques),
    ...Object.values(manifest.systemAndReflexContracts),
    ...Object.values(manifest.notImplementedContracts),
  ];

  const validStatuses: CoverageStatus[] = [
    'NOT_RUN',
    'UNIT_ONLY',
    'MOCK_ONLY',
    'LIVE_PASS',
    'LIVE_FAIL',
    'INCONCLUSIVE',
    'BLOCKED',
    'NOT_IMPLEMENTED',
  ];

  const statusCounts: Record<string, number> = {};

  for (const c of allContracts) {
    const st = c.evidenceCoverage?.status;
    statusCounts[st] = (statusCounts[st] || 0) + 1;

    if (!st || !validStatuses.includes(st)) {
      errors.push(`Invalid Status: Contract '${c.id}' has undefined or invalid evidenceCoverage status '${st}'.`);
    }

    if (!c.preconditions || !c.expectedEffects || !c.actualVerification) {
      errors.push(`Incomplete Contract: Contract '${c.id}' missing required specification sections.`);
    }

    if (c.category === 'not_implemented' && st !== 'NOT_IMPLEMENTED') {
      errors.push(`Contract '${c.id}' is categorized as not_implemented but has status '${st}' instead of 'NOT_IMPLEMENTED'.`);
    }
  }

  // 3. Validate coverage rule (no LIVE_PASS without real server and observer)
  const ruleCheck = validateManifestRules(manifest);
  if (!ruleCheck.valid) {
    errors.push(...ruleCheck.errors);
  }

  console.log('\n--- Status Distribution ---');
  for (const [st, count] of Object.entries(statusCounts)) {
    console.log(`  ${st.padEnd(16)}: ${count}`);
  }

  if (warnings.length > 0) {
    console.log('\n--- Warnings ---');
    warnings.forEach((w) => console.warn(`[WARN] ${w}`));
  }

  if (errors.length > 0) {
    console.error('\n================================================================');
    console.error(`   MANIFEST VALIDATION FAILED (${errors.length} error(s))`);
    console.error('================================================================');
    errors.forEach((e) => console.error(`[ERROR] ${e}`));
    process.exit(1);
  }

  const dataDir = path.resolve(process.cwd(), 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  fs.writeFileSync(path.join(dataDir, 'action_contract_manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  console.log('\n================================================================');
  console.log('   MANIFEST VALIDATION PASSED (100% Contract & Evidence Parity) ');
  console.log('================================================================\n');
}

validateManifest();
