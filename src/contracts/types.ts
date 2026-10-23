export type CoverageStatus =
  | 'NOT_RUN'
  | 'UNIT_ONLY'
  | 'MOCK_ONLY'
  | 'LIVE_PASS'
  | 'LIVE_FAIL'
  | 'INCONCLUSIVE'
  | 'BLOCKED'
  | 'NOT_IMPLEMENTED';

export interface ActionPreconditions {
  inventory: string[];
  toolTier: number | string | null;
  reachDistance: number | null;
  targetValidity: string;
  workstation: string | null;
  safetyChecks: string[];
  worldState: string[];
}

export interface ActionExpectedEffects {
  contractDescription: string;
  testCaseContract: string; // What "expected" means
  invariants: string[];     // explicit invariants/ranges for nondeterministic outcomes
  postconditions: string[];
}

export interface ActionActualVerification {
  definitionOfActual: string; // Server observation plus before/after state
  serverObserverEvents: string[]; // e.g. ["PLAYER_JOIN", "BLOCK_BREAK", "ITEM_PICKUP", "PERIODIC_SNAPSHOT", "CONTAINER_INTERACTION"]
  snapshotProperties: string[];  // e.g. ["position", "health", "food", "inventory", "heldItem"]
  verificationProcedure: string;
}

export interface ActionFailureCases {
  normalSuccessCase: string;
  meaningfulFailureCase: string;
  cancellationTimeoutCase: string;
}

export interface ActionTestSpecification {
  testSetupRequired: string;
  cleanupProcedure: string;
  expectedDurationLimitsMs: number;
  hazards: string[];
  reversibility: 'fully_reversible' | 'partially_reversible' | 'irreversible';
}

export interface EvidenceCoverage {
  unit: boolean;
  unitTestId?: string;
  mockedIntegration: boolean;
  mockedTestId?: string;
  liveServer: boolean;
  liveServerTestId?: string;
  independentOracle: boolean;
  oracleRunId?: string;
  status: CoverageStatus;
}

export interface ActionTraceMetadata {
  testIds: string[];
  actionIds: string[];
  traceIds: string[];
  artifactPaths: string[];
}

export interface InvalidParameterCase {
  params: Record<string, any>;
  expectedStatus: string;
  expectedReasonSnippet: string;
}

export interface ActionContract {
  id: string;
  name: string;
  category: string;
  sourceImplementation: {
    file: string;
    symbol: string;
  };
  parameterSchema: Record<string, any>;
  invalidParameterCases: InvalidParameterCase[];
  preconditions: ActionPreconditions;
  expectedEffects: ActionExpectedEffects;
  actualVerification: ActionActualVerification;
  failureCases: ActionFailureCases;
  testSpecification: ActionTestSpecification;
  evidenceCoverage: EvidenceCoverage;
  traceMetadata: ActionTraceMetadata;
}

export interface ContractManifest {
  manifestVersion: string;
  targetMinecraftVersion: string;
  targetProtocol: number;
  targetDataVersion: number;
  generatedAt: string;
  coverageRule: string;
  summary: {
    totalRegisteredActions: number;
    totalCompositeTechniques: number;
    totalReflexesAndSystemContracts: number;
    totalNotImplementedFeatures: number;
    coverageCounts: Record<CoverageStatus, number>;
  };
  registeredActions: Record<string, ActionContract>;
  compositeTechniques: Record<string, ActionContract>;
  systemAndReflexContracts: Record<string, ActionContract>;
  notImplementedContracts: Record<string, ActionContract>;
}
