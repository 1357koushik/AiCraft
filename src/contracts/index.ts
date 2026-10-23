import fs from 'fs';
import path from 'path';
import { ActionContract, ContractManifest, CoverageStatus } from './types.js';
import { movementContracts } from './movement_contracts.js';
import { miningContracts } from './mining_contracts.js';
import { inventoryContracts } from './inventory_contracts.js';
import { combatWorldMetaContracts } from './combat_world_meta_contracts.js';
import { techniqueContracts } from './technique_contracts.js';
import { reflexAndSystemContracts } from './system_contracts.js';

export * from './types.js';
export { movementContracts } from './movement_contracts.js';
export { miningContracts } from './mining_contracts.js';
export { inventoryContracts } from './inventory_contracts.js';
export { combatWorldMetaContracts } from './combat_world_meta_contracts.js';
export { techniqueContracts } from './technique_contracts.js';
export { reflexAndSystemContracts } from './system_contracts.js';

// Combine all 56 registered actions
export const allRegisteredActionContracts: Record<string, ActionContract> = {
  ...movementContracts,
  ...miningContracts,
  ...inventoryContracts,
  ...combatWorldMetaContracts,
};

// Split system vs not-implemented
export const activeSystemAndReflexContracts: Record<string, ActionContract> = {};
export const notImplementedContracts: Record<string, ActionContract> = {};

for (const [key, contract] of Object.entries(reflexAndSystemContracts)) {
  if (contract.evidenceCoverage.status === 'NOT_IMPLEMENTED') {
    notImplementedContracts[key] = contract;
  } else {
    activeSystemAndReflexContracts[key] = contract;
  }
}

export function buildContractManifest(): ContractManifest {
  const allContracts: ActionContract[] = [
    ...Object.values(allRegisteredActionContracts),
    ...Object.values(techniqueContracts),
    ...Object.values(activeSystemAndReflexContracts),
    ...Object.values(notImplementedContracts),
  ];

  const coverageCounts: Record<CoverageStatus, number> = {
    NOT_RUN: 0,
    UNIT_ONLY: 0,
    MOCK_ONLY: 0,
    LIVE_PASS: 0,
    LIVE_FAIL: 0,
    INCONCLUSIVE: 0,
    BLOCKED: 0,
    NOT_IMPLEMENTED: 0,
  };

  for (const c of allContracts) {
    const st = c.evidenceCoverage.status;
    coverageCounts[st] = (coverageCounts[st] || 0) + 1;
  }

  return {
    manifestVersion: '1.0.0',
    targetMinecraftVersion: '1.21.6',
    targetProtocol: 771,
    targetDataVersion: 4435,
    generatedAt: new Date().toISOString(),
    coverageRule:
      'No action or technique may be designated as LIVE_PASS unless it ran against the real target server and its postconditions were independently confirmed against server-observer evidence (e.g. NDJSON observer log). Self-reported bot success is never an independent oracle.',
    summary: {
      totalRegisteredActions: Object.keys(allRegisteredActionContracts).length,
      totalCompositeTechniques: Object.keys(techniqueContracts).length,
      totalReflexesAndSystemContracts: Object.keys(activeSystemAndReflexContracts).length,
      totalNotImplementedFeatures: Object.keys(notImplementedContracts).length,
      coverageCounts,
    },
    registeredActions: allRegisteredActionContracts,
    compositeTechniques: techniqueContracts,
    systemAndReflexContracts: activeSystemAndReflexContracts,
    notImplementedContracts,
  };
}

export const actionContractManifest: ContractManifest = buildContractManifest();
export const ACTION_CONTRACT_MANIFEST: ContractManifest = actionContractManifest;

/**
 * Validates that no contract violates the strict ground-truth coverage rule.
 */
export function validateManifestRules(manifest: ContractManifest): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  const checkContract = (c: ActionContract) => {
    if (c.evidenceCoverage.status === 'LIVE_PASS') {
      if (!c.evidenceCoverage.liveServer || !c.evidenceCoverage.independentOracle) {
        errors.push(
          `Contract '${c.id}' has status LIVE_PASS but does not satisfy liveServer (is: ${c.evidenceCoverage.liveServer}) and independentOracle (is: ${c.evidenceCoverage.independentOracle}).`
        );
      }
    }
  };

  Object.values(manifest.registeredActions).forEach(checkContract);
  Object.values(manifest.compositeTechniques).forEach(checkContract);
  Object.values(manifest.systemAndReflexContracts).forEach(checkContract);
  Object.values(manifest.notImplementedContracts).forEach(checkContract);

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Saves manifest to data/action_contract_manifest.json
 */
export function saveManifestJson(targetPath: string = 'data/action_contract_manifest.json'): string {
  const fullPath = path.resolve(process.cwd(), targetPath);
  const dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const json = JSON.stringify(actionContractManifest, null, 2);
  fs.writeFileSync(fullPath, json, 'utf8');
  return fullPath;
}
