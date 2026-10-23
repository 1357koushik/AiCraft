import { Bot } from 'mineflayer';
import { Observation, ActionResult } from '../types/index.js';
import { ActionContract } from '../contracts/types.js';

export type ScenarioResultStatus = 'PASS' | 'FAIL' | 'INCONCLUSIVE' | 'BLOCKED' | 'NOT_RUN';

export type ScenarioPhase =
  | 'INIT'
  | 'SETUP'
  | 'PRECONDITION'
  | 'ACTION'
  | 'SETTLING'
  | 'ASSERTION'
  | 'CLEANUP'
  | 'TEARDOWN';

export interface ScenarioPhaseBudgets {
  setupTimeoutMs: number;
  actionTimeoutMs: number;
  settlingTimeoutMs: number;
  noProgressTimeoutMs: number;
}

export interface ProgressMilestone {
  timestamp: string;
  phase: ScenarioPhase;
  message: string;
  elapsedMs: number;
  details?: Record<string, any>;
}

export interface AssertionResult {
  name: string;
  passed: boolean;
  expected: any;
  actual: any;
  message: string;
}

export interface ServerObserverSnapshot {
  timestamp: string;
  dimension: string;
  playerName: string;
  position?: { x: number; y: number; z: number } | null;
  health?: number;
  food?: number;
  oxygen?: number;
  inventory?: Record<string, number>;
  heldItem?: string | null;
  onlinePlayers?: string[];
  rawSnapshot?: any;
}

export interface ObservedServerEvent {
  seq: number;
  timestamp: string;
  serverRunId: string;
  dimension: string;
  playerName?: string | null;
  eventType: string;
  coordinates?: { x: number; y: number; z: number } | null;
  blockId?: string | null;
  itemId?: string | null;
  amount?: number | null;
  details?: Record<string, any>;
}

export interface ScenarioReport {
  scenarioId: string;
  name: string;
  runId: string;
  targetMinecraftVersion: string;
  serverImplementation: string;
  worldId: string;
  playerIdentity: {
    username: string;
    uuid?: string;
  };
  observerIdentity: {
    username?: string;
    bridgePort: number;
    connected: boolean;
  };
  startTime: string;
  endTime: string;
  durationMs: number;
  status: ScenarioResultStatus;
  statusReason: string;

  // Phase Budgets
  phaseBudgets: ScenarioPhaseBudgets;

  // Preconditions & Snapshot
  preconditions: {
    checked: boolean;
    passed: boolean;
    reason?: string;
  };
  beforeSnapshot: ServerObserverSnapshot | null;

  // Action Submission
  actionSubmission: {
    actionName: string;
    params: Record<string, any>;
    actionId: string;
    goalId: string;
    traceId: string;
    contractId?: string;
  };

  // Execution Diagnostics
  agentReportedResult: ActionResult | null;
  commandAccepted: boolean;
  physicalCompleted: boolean;
  timedOut: boolean;
  cancelled: boolean;
  retriesCount: number;

  // Milestones & Observability
  progressMilestones: ProgressMilestone[];
  afterSnapshot: ServerObserverSnapshot | null;
  observedServerEvents: ObservedServerEvent[];

  // Invariants & Assertions
  expectedResult: {
    contractDescription: string;
    testCaseContract: string;
    invariants: string[];
    postconditions: string[];
  };
  actualResult: {
    definitionOfActual: string;
    observedEventsCount: number;
    finalCoordinates?: { x: number; y: number; z: number } | null;
    inventoryDeltas: Record<string, number>;
  };
  assertions: AssertionResult[];

  // Reproduction & Logs
  reproductionRecipe?: string;
  logPaths: {
    scenarioJsonReport: string;
    scenarioMarkdownReport: string;
    observerLog?: string;
  };
}

export interface FixtureOperator {
  executeCommand: (command: string) => Promise<{ ok: boolean; error?: string }>;
}

export interface ScenarioExecutionContext {
  bot: Bot;
  observerSnapshotHandler: () => Promise<ServerObserverSnapshot | null>;
  queryObserverEvents: (actionId: string) => Promise<ObservedServerEvent[]>;
  recordMilestone: (phase: ScenarioPhase, message: string, details?: any) => void;
  abortController: AbortController;
  runId: string;
  actionId: string;
  goalId: string;
  traceId: string;
  logger: any;
  config: any;
  fixtureOperator?: FixtureOperator;
  [key: string]: any;
}

export interface ScenarioDefinition {
  id: string;
  name: string;
  contractId: string;
  targetAction: string;
  params: Record<string, any>;
  phaseBudgets?: Partial<ScenarioPhaseBudgets>;
  setup?: (context: ScenarioExecutionContext) => Promise<void>;
  preconditionCheck: (context: ScenarioExecutionContext) => Promise<{ ok: boolean; reason?: string }>;
  assertions: (
    context: ScenarioExecutionContext,
    execResult: {
      agentResult: ActionResult | null;
      beforeSnapshot: ServerObserverSnapshot | null;
      afterSnapshot: ServerObserverSnapshot | null;
      events: ObservedServerEvent[];
      contract: ActionContract | null;
    }
  ) => Promise<AssertionResult[]>;
  cleanup?: (context: ScenarioExecutionContext) => Promise<void>;
}
