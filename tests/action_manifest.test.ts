import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { allActions } from '../src/actions/registry.js';
import {
  actionContractManifest,
  validateManifestRules,
  ContractManifest,
  ActionContract,
} from '../src/contracts/index.js';

describe('Machine-Readable Action Contract & Coverage Manifest', () => {
  it('has valid top-level metadata targeting Minecraft Java 1.21.6', () => {
    expect(actionContractManifest.manifestVersion).toBe('1.0.0');
    expect(actionContractManifest.targetMinecraftVersion).toBe('1.21.6');
    expect(actionContractManifest.targetProtocol).toBe(771);
    expect(actionContractManifest.targetDataVersion).toBe(4435);
    expect(actionContractManifest.coverageRule).toContain('No action or technique may be designated as LIVE_PASS');
  });

  it('verifies 100% 1-to-1 parity between live action registry and contract manifest', () => {
    const liveNames = allActions.map((a) => a.name).sort();
    const manifestNames = Object.keys(actionContractManifest.registeredActions).sort();

    // Check count
    expect(manifestNames.length).toBe(liveNames.length);

    // Check each live action has a contract
    for (const action of allActions) {
      expect(
        actionContractManifest.registeredActions[action.name],
        `Action '${action.name}' from live registry is missing from contract manifest!`
      ).toBeDefined();
    }

    // Check no orphan contracts exist
    for (const name of manifestNames) {
      const existsInRegistry = allActions.some((a) => a.name === name);
      expect(
        existsInRegistry,
        `Contract '${name}' in manifest does not exist in live action registry!`
      ).toBe(true);
    }
  });

  it('enforces the strict ground-truth coverage rule (no LIVE_PASS without real server + observer oracle)', () => {
    const checkRule = validateManifestRules(actionContractManifest);
    expect(checkRule.valid, `Coverage rule violations:\n${checkRule.errors.join('\n')}`).toBe(true);

    const allContracts: ActionContract[] = [
      ...Object.values(actionContractManifest.registeredActions),
      ...Object.values(actionContractManifest.compositeTechniques),
      ...Object.values(actionContractManifest.systemAndReflexContracts),
      ...Object.values(actionContractManifest.notImplementedContracts),
    ];

    for (const contract of allContracts) {
      const cov = contract.evidenceCoverage;
      if (cov.status === 'LIVE_PASS') {
        expect(cov.liveServer).toBe(true);
        expect(cov.independentOracle).toBe(true);
        expect(cov.oracleRunId).toBeDefined();
      }

      if (contract.category === 'not_implemented') {
        expect(cov.status).toBe('NOT_IMPLEMENTED');
      }

      const validStatuses = [
        'NOT_RUN',
        'UNIT_ONLY',
        'MOCK_ONLY',
        'LIVE_PASS',
        'LIVE_FAIL',
        'BLOCKED',
        'NOT_IMPLEMENTED',
      ];
      expect(validStatuses).toContain(cov.status);
    }
  });

  it('verifies contract schema completeness and required specification fields for all registered actions', () => {
    for (const [name, contract] of Object.entries(actionContractManifest.registeredActions)) {
      expect(contract.id).toBe(`action:${name}`);
      expect(contract.name).toBe(name);
      expect(contract.sourceImplementation.file).toBeDefined();
      expect(contract.sourceImplementation.symbol).toBeDefined();

      // Preconditions
      expect(contract.preconditions).toBeDefined();
      expect(Array.isArray(contract.preconditions.safetyChecks)).toBe(true);
      expect(contract.preconditions.targetValidity).toBeDefined();

      // Expected Effects
      expect(contract.expectedEffects).toBeDefined();
      expect(contract.expectedEffects.testCaseContract.length).toBeGreaterThan(0);
      expect(Array.isArray(contract.expectedEffects.invariants)).toBe(true);
      expect(contract.expectedEffects.invariants.length).toBeGreaterThan(0);

      // Actual Verification
      expect(contract.actualVerification).toBeDefined();
      expect(contract.actualVerification.definitionOfActual.length).toBeGreaterThan(0);
      expect(Array.isArray(contract.actualVerification.serverObserverEvents)).toBe(true);
      expect(contract.actualVerification.verificationProcedure.length).toBeGreaterThan(0);

      // Failure Cases
      expect(contract.failureCases).toBeDefined();
      expect(contract.failureCases.normalSuccessCase.length).toBeGreaterThan(0);
      expect(contract.failureCases.meaningfulFailureCase.length).toBeGreaterThan(0);
      expect(contract.failureCases.cancellationTimeoutCase.length).toBeGreaterThan(0);

      // Test Spec
      expect(contract.testSpecification).toBeDefined();
      expect(contract.testSpecification.expectedDurationLimitsMs).toBeGreaterThan(0);
      expect(['fully_reversible', 'partially_reversible', 'irreversible']).toContain(
        contract.testSpecification.reversibility
      );

      // Evidence
      expect(contract.evidenceCoverage).toBeDefined();

      // Trace Metadata
      expect(contract.traceMetadata).toBeDefined();
      expect(Array.isArray(contract.traceMetadata.testIds)).toBe(true);
      expect(Array.isArray(contract.traceMetadata.actionIds)).toBe(true);
    }
  });

  it('verifies that composite techniques are separately defined with full contracts', () => {
    const techniques = Object.values(actionContractManifest.compositeTechniques);
    expect(techniques.length).toBe(14);

    const techniqueNames = techniques.map((t) => t.name);
    expect(techniqueNames).toContain('techniqueChopTreeFull');
    expect(techniqueNames).toContain('techniqueMineOreVein');
    expect(techniqueNames).toContain('techniqueBuildVerifiedShelter');
    expect(techniqueNames).toContain('navigateWithBounds');
    expect(techniqueNames).toContain('techniqueCraftPipeline');
    expect(techniqueNames).toContain('withWorkstation');
  });

  it('verifies that not-implemented features are explicitly marked as NOT_IMPLEMENTED', () => {
    const notImpl = Object.values(actionContractManifest.notImplementedContracts);
    expect(notImpl.length).toBe(6);

    const notImplNames = notImpl.map((n) => n.name);
    expect(notImplNames).toContain('smelt');
    expect(notImplNames).toContain('water_bucket_clutch');
    expect(notImplNames).toContain('brew_potion');
    expect(notImplNames).toContain('enchant_item');
    expect(notImplNames).toContain('build_nether_portal');
    expect(notImplNames).toContain('defeat_ender_dragon');

    for (const item of notImpl) {
      expect(item.evidenceCoverage.status).toBe('NOT_IMPLEMENTED');
    }
  });

  it('verifies that data/action_contract_manifest.json is valid and synchronizes with manifest', () => {
    const jsonPath = path.resolve(process.cwd(), 'data/action_contract_manifest.json');
    if (fs.existsSync(jsonPath)) {
      const raw = fs.readFileSync(jsonPath, 'utf8');
      const parsed: ContractManifest = JSON.parse(raw);

      expect(parsed.manifestVersion).toBe('1.0.0');
      expect(parsed.summary.totalRegisteredActions).toBe(
        Object.keys(actionContractManifest.registeredActions).length
      );
      expect(parsed.summary.totalCompositeTechniques).toBe(
        Object.keys(actionContractManifest.compositeTechniques).length
      );
    }
  });
});
