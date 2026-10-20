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

export interface RecentEventsState {
  damageTaken: { amount: number; source: string; timeAgoMs: number }[];
  healthRegained: number;
  itemsPickedUp: { name: string; count: number }[];
  itemsBroken: string[];
  blocksBroken: string[];
  blocksPlaced: string[];
  mobsKilled: string[];
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

export interface MemoryNotes {
  namedLocations: Record<string, { x: number; y: number; z: number }>;
  facts: string[];
  dangerZones: { name: string; x: number; y: number; z: number; radius: number }[];
  completedGoals: string[];
}

export interface AgentInternalState {
  currentGoal: string;
  planSteps: { step: string; completed: boolean }[];
  stepNumber: number;
  stuckCounter: number;
  timeSinceLastProgressSeconds: number;
  pendingOwnerInstruction?: string;
  activeActionName?: string;
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
