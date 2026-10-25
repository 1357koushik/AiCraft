import { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';

export type Dimension = 'overworld' | 'the_nether' | 'the_end';
export type DayPhase = 'day' | 'dusk' | 'night' | 'dawn';
export type Facing = 'north' | 'east' | 'south' | 'west' | 'up' | 'down';
export type ActionResultStatus = 'success' | 'failed' | 'interrupted';

export interface VitalsState {
  health: number;
  maxHealth: number;
  food: number;
  saturation: number;
  oxygen: number;
  underwater: boolean;
  armor: number;
  armorToughness: number;
  experienceLevel: number;
  experienceProgress: number;
  isAlive: boolean;
  gameMode: string;
  isBurning: boolean;
  isFreezing: boolean;
  movementState: {
    onGround: boolean;
    inWater: boolean;
    inLava: boolean;
    isClimbing: boolean;
    isSwimming: boolean;
    isFalling: boolean;
    fallDistance: number;
    isSleeping: boolean;
    isRiding: boolean;
    isSprinting: boolean;
    isSneaking: boolean;
  };
  itemUseState: {
    usingItem: boolean;
    itemTime?: number;
  };
  attackCooldownReady: boolean;
}

export interface PositionState {
  x: number;
  y: number;
  z: number;
  blockCoords: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
  yaw: number;
  pitch: number;
  facing: Facing;
  dimension: Dimension;
  biome: string;
  depthContext: {
    skyExposed: boolean;
    isUnderground: boolean;
    altitudeAboveSeaLevel: number;
  };
  spawnOrBed?: { x: number; y: number; z: number };
  lastDeath?: { x: number; y: number; z: number };
  distanceToHome?: number;
}

export interface EnvironmentState {
  timeOfDay: number;
  worldAge: number;
  dayPhase: DayPhase;
  dayCount: number;
  moonPhase: number;
  weather: 'clear' | 'rain' | 'thunder';
  lightLevelAtFeet: { block: number; sky: number; total: number };
  openSky: boolean;
  difficulty: string;
  ping: number;
}

export interface StatusEffectInfo {
  name: string;
  level: number;
  durationSeconds: number | 'unknown';
  description?: string;
}

export interface InventoryItemInfo {
  slot: number;
  name: string;
  count: number;
  durabilityUsed?: number;
  maxDurability?: number;
  customName?: string;
}

export interface ToolSummary {
  bestPickaxe: string | null;
  bestAxe: string | null;
  bestShovel: string | null;
  bestSword: string | null;
  bestHoe: string | null;
  hasShield: boolean;
  lowDurabilityWarnings: string[];
}

export interface FoodItemInfo {
  name: string;
  count: number;
  foodPoints: number;
  saturation: number;
}

export interface InventoryState {
  mainHand: InventoryItemInfo | null;
  offHand: InventoryItemInfo | null;
  selectedSlot: number;
  hotbar: (InventoryItemInfo | null)[];
  mainInventory: (InventoryItemInfo | null)[];
  armor: {
    head: InventoryItemInfo | null;
    chest: InventoryItemInfo | null;
    legs: InventoryItemInfo | null;
    feet: InventoryItemInfo | null;
  };
  aggregates: {
    totalItemCounts: Record<string, number>;
    freeSlots: number;
  };
  toolSummary: ToolSummary;
  foodList: FoodItemInfo[];
  placeableBlocks: Record<string, number>;
  craftableNow: string[];
  heldItemHint: string;
}

export interface CrosshairInfo {
  block: {
    name: string;
    position: { x: number; y: number; z: number };
    distance: number;
    face: string;
    harvestable: boolean;
    digTimeEstSeconds: number;
    properties: Record<string, any>;
  } | null;
  entity: {
    id: string;
    rawId: number;
    type: string;
    name: string;
    distance: number;
  } | null;
}

export interface BlockWalkability {
  north: 'free' | 'blocked' | 'step_up' | 'drop' | 'water' | 'lava';
  south: 'free' | 'blocked' | 'step_up' | 'drop' | 'water' | 'lava';
  east: 'free' | 'blocked' | 'step_up' | 'drop' | 'water' | 'lava';
  west: 'free' | 'blocked' | 'step_up' | 'drop' | 'water' | 'lava';
}

export interface HazardInfo {
  type: 'lava' | 'fire' | 'cactus' | 'sweet_berry_bush' | 'magma' | 'cobweb' | 'powder_snow' | 'drop' | 'void';
  position: { x: number; y: number; z: number };
  distance: number;
}

export interface NotableBlockInfo {
  type: string;
  name: string;
  count: number;
  nearestDistance: number;
  nearestPosition: { x: number; y: number; z: number };
  direction: string;
}

export interface ImmediateBlocksInfo {
  belowFeet: string;
  atFeet: string;
  atEyeLevel: string;
  directlyAhead: string;
  aboveHead: string;
}

export interface LocalMapInfo {
  grid: string[][];
  ascii: string;
  legend: Record<string, string>;
  size: number;
  origin: { x: number; y: number; z: number };
}

export interface BlocksState {
  immediate: ImmediateBlocksInfo;
  walkability: BlockWalkability;
  hazards: HazardInfo[];
  notableBlocks: NotableBlockInfo[];
  localMap: LocalMapInfo;
}

export interface EntityInfo {
  id: string; // e.g. "e1", "e2"
  rawId: number;
  type: string;
  name: string;
  distance: number;
  relativePos: { x: number; y: number; z: number };
  position: { x: number; y: number; z: number };
  isOwner: boolean;
  isHostile: boolean;
  isPassive: boolean;
  isItem: boolean;
  itemCount?: number;
  lineOfSight: boolean;
  health: number | 'unknown';
}

export type PlanTaskType = 'gather' | 'craft' | 'smelt' | 'kill' | 'explore' | 'build' | 'generic';
export type PlanStepStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface PlanStepRequirement {
  item: string;
  count: number;
}

export interface PlanStep {
  step: string;
  completed: boolean;
  type?: PlanTaskType;
  targetItem?: string;
  targetCount?: number;
  currentCount?: number;
  status?: PlanStepStatus;
  requirements?: PlanStepRequirement[];
  prerequisites?: string[];
}

export interface RecentEventsState {
  damageTaken: { amount: number; source: string; timeAgoMs: number }[];
  healthRegained: number;
  itemsPickedUp: { name: string; count: number }[];
  itemsBroken: string[];
  blocksBroken: string[];
  blocksPlaced: string[];
  mobsKilled: string[];
  nearbyEntityDeaths: string[];
  deathRespawn: boolean;
  chatMessages: { sender: string; message: string; isOwner: boolean }[];
  reflexFired?: string;
  lastActionResult?: { action: string; status: ActionResultStatus; reason: string };
}

export interface ContainerState {
  isOpen: boolean;
  type: string | null;
  title?: string;
  slotsCount: number;
  items: (InventoryItemInfo | null)[];
  furnace?: {
    progress: number;
    fuel: number;
  };
}

export interface ExploredRegionRecord {
  chunkX: number;
  chunkZ: number;
  dimension: string;
  lastVisitedAt: number;
  visitCount: number;
}

export interface KnownLocationRecord {
  id: string;
  name: string;
  type: 'base' | 'chest' | 'barrel' | 'crafting_table' | 'furnace' | 'shelter' | 'waypoint';
  position: { x: number; y: number; z: number };
  dimension: string;
  observedAt: number;
  provenance: 'direct_observation' | 'event';
  metadata?: Record<string, any>;
}

export interface ResourceObservationRecord {
  id: string;
  resourceType: string;
  position: { x: number; y: number; z: number };
  dimension: string;
  observedAt: number;
  expiresAt: number;
  confidence: number;
  provenance: 'direct_observation' | 'event';
}

export interface FailedTargetMemoryRecord {
  position: { x: number; y: number; z: number };
  reason: string;
  failureKind: string;
  failedAt: number;
  expiresAt: number;
}

export interface GoalOutcomeRecord {
  goalId: string;
  description: string;
  outcome: 'success' | 'failed' | 'cancelled';
  completedAt: number;
  durationMs: number;
  evidence: string;
}

export interface StrategyRankingRecord {
  skill: string;
  variant: string;
  successCount: number;
  failureCount: number;
  totalDurationMs: number;
  lastUsedAt: number;
  score: number;
}

export interface MemoryNotes {
  namedLocations: Record<string, { x: number; y: number; z: number }>;
  facts: string[];
  dangerZones: { name: string; x: number; y: number; z: number; radius: number }[];
  completedGoals: string[];
  exploredRegions?: ExploredRegionRecord[];
  knownLocations?: KnownLocationRecord[];
  resourceObservations?: ResourceObservationRecord[];
  failedTargets?: FailedTargetMemoryRecord[];
  goalOutcomes?: GoalOutcomeRecord[];
  strategyRankings?: Record<string, StrategyRankingRecord>;
}

export interface AgentInternalState {
  currentGoal: string;
  planSteps: PlanStep[];
  stepNumber: number;
  stuckCounter: number;
  timeSinceLastProgressSeconds: number;
  pendingOwnerInstruction?: string;
  activeActionName?: string;
  isOwnerGoal?: boolean;
}

export interface Observation {
  version: string;
  timestamp: number;
  vitals: VitalsState;
  position: PositionState;
  environment: EnvironmentState;
  statusEffects: StatusEffectInfo[];
  inventory: InventoryState;
  crosshair: CrosshairInfo;
  blocks: BlocksState;
  entities: EntityInfo[];
  recentEvents: RecentEventsState;
  container: ContainerState;
  agentState: AgentInternalState;
  memory: MemoryNotes;
  derived: {
    availableActions: AvailableActionCatalogItem[];
  };
}

export interface AvailableActionCatalogItem {
  action: string;
  category: string;
  description: string;
  parameters: Record<string, any>;
  availableChoices?: Record<string, any[]>;
}

export interface ActionResult {
  status: ActionResultStatus;
  reason: string;
  details?: Record<string, any>;
}

export interface ActionExecutionContext {
  bot: Bot;
  observation: Observation;
  abortSignal?: AbortSignal;
  logger: any;
  config: any;
  actionId?: string;
  epoch?: number;
  isCurrent?: () => boolean;
}

export interface ActionDef {
  name: string;
  category: 'movement' | 'mining_building' | 'inventory_crafting' | 'combat' | 'world_interaction' | 'meta';
  description: string;
  parameterSchema: Record<string, any>;
  isAvailable: (bot: Bot, observation: Observation, context: ActionExecutionContext) => boolean;
  getAvailableChoices?: (bot: Bot, observation: Observation, context: ActionExecutionContext) => Record<string, any[]>;
  execute: (bot: Bot, params: any, context: ActionExecutionContext) => Promise<ActionResult>;
}

export interface LLMDecision {
  decision_summary: string;
  goal: string;
  actions: { action: string; params: Record<string, any> }[];
  memory?: {
    note?: string;
    namedLocation?: { name: string; position: { x: number; y: number; z: number } };
    dangerZone?: { name: string; position: { x: number; y: number; z: number }; radius: number };
  };
  say?: string | null;
}

export interface LLMRequest {
  systemPrompt: string;
  userPrompt: string;
  jsonSchema?: Record<string, any>;
}

export interface LLMResponseResult {
  rawText: string;
  decision?: LLMDecision;
  tokenUsage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  latencyMs: number;
  error?: string;
}

export interface ILLMProvider {
  name: string;
  generateDecision(request: LLMRequest): Promise<LLMResponseResult>;
}

// ---------------------------------------------------------------------------
// Phase 2: World State, Event Reducer & Fact Provenance Types (Layer 1)
// ---------------------------------------------------------------------------

export type FactProvenance = 'event' | 'scan' | 'inference' | 'memory';

export interface ObservedFact<T> {
  value: T;
  observedAt: number;
  expiresAt: number;
  confidence: number;
  source: FactProvenance;
  metadata?: Record<string, any>;
}

export interface CachedBlockFact {
  name: string;
  position: { x: number; y: number; z: number };
  boundingBox?: string;
  hardness?: number;
  diggable?: boolean;
}

export interface CachedEntityFact {
  id: number;
  uuid?: string;
  name: string;
  type: string;
  position: { x: number; y: number; z: number };
  velocity?: { x: number; y: number; z: number };
  height?: number;
  width?: number;
  health?: number;
  isAlive: boolean;
  isHostile: boolean;
  isPlayer: boolean;
  username?: string;
}

export interface CachedInventoryFact {
  heldItem: string | null;
  quickBarSlot: number;
  itemCounts: Record<string, number>;
  freeSlots: number;
  windowOpen: boolean;
  windowType: string | null;
  windowId: number | null;
}

export interface CachedChunkFact {
  chunkX: number;
  chunkZ: number;
  loadedAt: number;
  isLoaded: boolean;
}

export interface TargetValidationResult {
  valid: boolean;
  reason?: string;
  fact?: ObservedFact<any>;
}

// ---------------------------------------------------------------------------
// Phase 2: Goals, Task Graph, & Execution Monitor Types (Layer 4)
// ---------------------------------------------------------------------------

export type GoalKind =
  | 'have'
  | 'have_tool'
  | 'reach'
  | 'explore'
  | 'build'
  | 'survive_until'
  | 'kill'
  | 'custom'
  | 'idle';

export interface GoalSpecBase {
  id: string;
  kind: GoalKind;
  isOwnerGoal: boolean;
  createdAt: number;
  rawInstruction?: string;
}

export interface HaveGoalSpec extends GoalSpecBase {
  kind: 'have';
  item: string;
  count: number;
  mode: 'absolute' | 'additional';
  baselineCount: number;
}

export interface HaveToolGoalSpec extends GoalSpecBase {
  kind: 'have_tool';
  tool: string;
  tier?: string;
}

export interface ReachGoalSpec extends GoalSpecBase {
  kind: 'reach';
  target: { x: number; y: number; z: number };
  tolerance?: number;
}

export interface ExploreGoalSpec extends GoalSpecBase {
  kind: 'explore';
  query?: string;
  budgetSeconds?: number;
}

export interface KillGoalSpec extends GoalSpecBase {
  kind: 'kill';
  entityType: string;
  count: number;
}

export interface CustomGoalSpec extends GoalSpecBase {
  kind: 'custom';
  description: string;
}

export interface IdleGoalSpec extends GoalSpecBase {
  kind: 'idle';
  reason?: string;
}

export type GoalSpec =
  | HaveGoalSpec
  | HaveToolGoalSpec
  | ReachGoalSpec
  | ExploreGoalSpec
  | KillGoalSpec
  | CustomGoalSpec
  | IdleGoalSpec;

export type TaskStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'satisfied'
  | 'succeeded'
  | 'blocked'
  | 'failed'
  | 'interrupted'
  | 'cancelled';

export type FailureKind =
  | 'TARGET_NOT_OBSERVED'
  | 'TARGET_STALE'
  | 'PATH_UNREACHABLE'
  | 'PATH_STOPPED'
  | 'PATH_TIMEOUT'
  | 'NO_PROGRESS'
  | 'POSTCONDITION_FAILED'
  | 'RETRY_BUDGET_EXHAUSTED'
  | 'PREREQUISITE_FAILED'
  | 'CANCELLED'
  | 'UNKNOWN';

export interface TaskBaseline {
  inventoryCounts: Record<string, number>;
  position?: { x: number; y: number; z: number };
  time: number;
}

export interface TaskNode {
  id: string;
  type: string;
  actionName: string;
  params: Record<string, any>;
  prerequisites: string[];
  status: TaskStatus;
  retryCount: number;
  maxRetries: number;
  budgetMs?: number;
  startedAt?: number;
  completedAt?: number;
  failureReason?: string;
  failureKind?: FailureKind;
  evidence: string[];
  checkpoints?: Record<string, any>;
  postcondition?: (bot: any, baseline: TaskBaseline) => Promise<boolean> | boolean;
}

export interface TaskPlan {
  goalId: string;
  tasks: TaskNode[];
  createdAt: number;
  status: 'active' | 'completed' | 'failed' | 'cancelled';
}

export interface TaskExecutionResult {
  taskId: string;
  status: TaskStatus;
  failureKind?: FailureKind;
  failureReason?: string;
  evidence: string[];
  durationMs: number;
}

export interface OperatorContract {
  id: string;
  name: string;
  actionName: string;
  producedItems: Array<{ item: string; count: number }>;
  requiredTools?: Array<{ toolType: string; minTier: number }>;
  consumedItems: Array<{ item: string; count: number }>;
  workstation?: 'crafting_table' | 'furnace' | 'smoker' | 'blast_furnace' | 'brewing_stand';
  defaultParams?: Record<string, any>;
  estimatedDurationMs?: number;
}

export interface PlanStepNode {
  id: string;
  operatorId: string;
  actionName: string;
  params: Record<string, any>;
  prerequisites: string[];
  status: TaskStatus;
}

export interface GoalCondition {
  item?: string;
  count?: number;
  tool?: string;
  minTier?: number;
  position?: { x: number; y: number; z: number; tolerance?: number };
}

export interface HazardSignal {
  type: 'FREE_FALL' | 'SUFFOCATION' | 'EXPLOSION_IMMINENT' | 'LAVA_IMMERSED';
  severity: 'WARNING' | 'CRITICAL' | 'FATAL';
  sourceEntity?: any;
  sourceBlock?: Vec3;
  recommendedAction: 'CLUTCH_WATER' | 'DIG_OUT' | 'SHIELD_DEPLOY' | 'SPRINT_RETREAT';
  details?: string;
}


