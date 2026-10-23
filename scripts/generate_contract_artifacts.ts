import fs from 'fs';
import path from 'path';
import { allActions } from '../src/actions/registry.js';
import {
  actionContractManifest,
  saveManifestJson,
  validateManifestRules,
  ActionContract,
} from '../src/contracts/index.js';

function generateMarkdownReport(): string {
  const m = actionContractManifest;
  const s = m.summary;

  let md = `# Machine-Readable Action Contract & Ground-Truth Coverage Manifest

> **Target Minecraft Version**: Java ${m.targetMinecraftVersion} (Protocol: ${m.targetProtocol}, Data Version: ${m.targetDataVersion})  
> **Manifest Version**: ${m.manifestVersion}  
> **Generated Timestamp**: ${m.generatedAt}  
> **Source Registry**: \`src/actions/registry.ts\` (${allActions.length} live actions registered)

---

## 1. Ground-Truth Coverage Rule

> [!IMPORTANT]
> **Strict Independent Oracle Rule**:
> **No action or composite technique may be designated as \`LIVE_PASS\` unless it has run against the real target server AND its expected postconditions were independently confirmed against server-observer evidence (e.g. structured NDJSON ground-truth event stream).**  
> A bot-reported internal \`{ status: "success" }\` return is **NOT** an independent oracle and cannot confer \`LIVE_PASS\` status.

---

## 2. Summary Statistics

| Metric | Count | Description |
| :--- | :---: | :--- |
| **Live Registered Actions** | **${s.totalRegisteredActions}** | Total distinct actions currently registered in \`allActions\` in \`src/actions/registry.ts\`. |
| **Composite Techniques / Macros** | **${s.totalCompositeTechniques}** | Multi-step autonomous techniques (felling trees, vein extraction, shelter building, navigation, etc.). |
| **System & Survival Reflexes** | **${s.totalReflexesAndSystemContracts}** | Critical survival reflexes (drowning, lava, flee, auto-eat), parser normalizer, lifecycle reconnect, arbiter. |
| **Unimplemented Features** | **${s.totalNotImplementedFeatures}** | Explicitly marked as \`NOT_IMPLEMENTED\` (furnace smelting, water-bucket clutch, brewing, enchanting, nether portal, end dragon). |
| **Total Contracts Documented** | **${
    s.totalRegisteredActions +
    s.totalCompositeTechniques +
    s.totalReflexesAndSystemContracts +
    s.totalNotImplementedFeatures
  }** | Comprehensive contract coverage across all actions and subsystems. |

### Current Coverage Status Breakdown

| Status | Count | Meaning |
| :--- | :---: | :--- |
| \`UNIT_ONLY\` | **${s.coverageCounts.UNIT_ONLY}** | Verified by unit tests; mocked or isolated execution. |
| \`MOCK_ONLY\` | **${s.coverageCounts.MOCK_ONLY}** | Verified via mocked integration scenarios. |
| \`LIVE_PASS\` | **${s.coverageCounts.LIVE_PASS}** | Verified against real server with independent ground-truth observer confirmation (\`lifecycle_reconnect\` via \`scripts/verify_observer_live.ts\`). |
| \`LIVE_FAIL\` | **${s.coverageCounts.LIVE_FAIL}** | Failed during live server oracle verification. |
| \`NOT_RUN\` | **${s.coverageCounts.NOT_RUN}** | Code exists but live test has not yet run with observer. |
| \`BLOCKED\` | **${s.coverageCounts.BLOCKED}** | Blocked by missing dependency or prerequisite. |
| \`NOT_IMPLEMENTED\` | **${s.coverageCounts.NOT_IMPLEMENTED}** | Feature is absent from codebase; marked explicitly to avoid false claims. |

---

## 3. "Expected" vs "Actual" Verification Contract Definitions

For each action contract:
1. **"Expected" (Test-Case Contract)**:
   - Explicit definition of what success entails (e.g. Euclidean distance within range, inventory count increase, block converted to air, window opened).
   - For nondeterministic outcomes (e.g. tree log counts varying with tree species, drop rates varying with tool enchantments), **explicit invariants and bounded ranges** (e.g. \`delta >= 1\`, \`Y_final === Y_initial + height\`) are used rather than hardcoded coordinates or exact counts.
2. **"Actual" (Ground-Truth Observation)**:
   - Derived exclusively from independent server observations:
     - Structured NDJSON events: \`BLOCK_BREAK\`, \`BLOCK_PLACE\`, \`ITEM_PICKUP\`, \`PLAYER_JOIN\`, \`CHAT_MESSAGE\`.
     - Periodic vital snapshots: \`position\`, \`health\`, \`food\`, \`oxygen\`, \`heldItem\`, \`inventory\`, \`movementState\`.
     - Before/after differential state analysis.

---

## 4. Master Action & Technique Contract Registry

### A. Registered Movement Actions (13 Actions)

| Action Name | Source | Preconditions | Expected Contract & Invariants | Actual Oracle Verification | Status |
| :--- | :--- | :--- | :--- | :--- | :---: |
`;

  const renderTableRows = (contracts: Record<string, ActionContract>) => {
    let rows = '';
    for (const c of Object.values(contracts)) {
      rows += `| \`${c.name}\` | \`${c.sourceImplementation.symbol}\` | ${c.preconditions.safetyChecks.join(
        '; '
      ) || 'Bot alive'} | ${c.expectedEffects.testCaseContract} | ${c.actualVerification.serverObserverEvents.join(
        ', '
      ) || 'Snapshot'} | **\`${c.evidenceCoverage.status}\`** |\n`;
    }
    return rows;
  };

  md += renderTableRows(m.registeredActions);

  md += `
---

### B. Composite Techniques & Internal Macros (14 Techniques)

| Technique Name | Source Implementation | Preconditions & Workstations | Expected Effects & Invariants | Actual Oracle Events | Status |
| :--- | :--- | :--- | :--- | :--- | :---: |
`;

  md += renderTableRows(m.compositeTechniques);

  md += `
---

### C. Survival Reflexes & System Contracts (8 Subsystems)

| Subsystem Contract | Source File | Preconditions / Trigger | Expected Behavior | Actual Verification | Status |
| :--- | :--- | :--- | :--- | :--- | :---: |
`;

  md += renderTableRows(m.systemAndReflexContracts);

  md += `
---

### D. Unimplemented Features (Explicitly Documented as NOT_IMPLEMENTED)

| Feature | Intended Function | Status | Reason & Policy |
| :--- | :--- | :---: | :--- |
`;

  for (const c of Object.values(m.notImplementedContracts)) {
    md += `| \`${c.name}\` | ${c.expectedEffects.contractDescription} | **\`${c.evidenceCoverage.status}\`** | Feature absent or explicitly deferred by survival policy. |\n`;
  }

  md += `
---

## 5. Automated Validation & Coverage Assertion

The manifest is validated against the actual codebase via \`tests/action_manifest.test.ts\`:
- **100% Registry Alignment**: Every action in \`src/actions/registry.ts\` must have a contract in the manifest, and every registered action contract in the manifest must exist in the live registry.
- **Strict Coverage Rule**: No contract can have \`LIVE_PASS\` unless \`liveServer === true\` and \`independentOracle === true\`.
- **Schema Completeness**: All parameters, preconditions, invalid cases, expected effects, actual verification procedures, and failure cases are non-empty.

---

## 6. Artifact Files Generated

- **Machine-Readable JSON**: \`data/action_contract_manifest.json\`
- **Human-Readable Report**: \`ACTION_CONTRACT_COVERAGE_REPORT.md\`
- **Automated Validation Suite**: \`tests/action_manifest.test.ts\`
`;

  return md;
}

async function main() {
  console.log('=== Step 1: Validating Manifest against Live Action Registry ===');
  const manifestActionNames = Object.keys(actionContractManifest.registeredActions).sort();
  const liveActionNames = allActions.map((a) => a.name).sort();

  console.log(`Live registry action count: ${liveActionNames.length}`);
  console.log(`Manifest registered action count: ${manifestActionNames.length}`);

  const missingInManifest = liveActionNames.filter((name) => !manifestActionNames.includes(name));
  const orphanInManifest = manifestActionNames.filter((name) => !liveActionNames.includes(name));

  if (missingInManifest.length > 0) {
    throw new Error(`Actions missing in contract manifest: ${missingInManifest.join(', ')}`);
  }
  if (orphanInManifest.length > 0) {
    throw new Error(`Orphan actions in manifest not in registry: ${orphanInManifest.join(', ')}`);
  }
  console.log('[SUCCESS] 100% 1-to-1 parity between live registry and contract manifest!');

  console.log('=== Step 2: Validating Strict Coverage Rule ===');
  const ruleCheck = validateManifestRules(actionContractManifest);
  if (!ruleCheck.valid) {
    throw new Error(`Coverage rule violation:\n${ruleCheck.errors.join('\n')}`);
  }
  console.log('[SUCCESS] Strict coverage rule passed! No unauthorized LIVE_PASS claims.');

  console.log('=== Step 3: Exporting data/action_contract_manifest.json ===');
  const jsonPath = saveManifestJson('data/action_contract_manifest.json');
  console.log(`Saved JSON manifest to: ${jsonPath} (${fs.statSync(jsonPath).size} bytes)`);

  console.log('=== Step 4: Generating ACTION_CONTRACT_COVERAGE_REPORT.md ===');
  const md = generateMarkdownReport();
  const reportPath = path.resolve(process.cwd(), 'ACTION_CONTRACT_COVERAGE_REPORT.md');
  fs.writeFileSync(reportPath, md, 'utf8');
  console.log(`Saved human-readable report to: ${reportPath} (${fs.statSync(reportPath).size} bytes)`);

  console.log('\n[COMPLETE] All action contract artifacts generated successfully!');
}

main().catch((err) => {
  console.error('[ERROR] Generation failed:', err);
  process.exit(1);
});
