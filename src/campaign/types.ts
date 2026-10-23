import { CoverageStatus } from '../contracts/types.js';
import type { CampaignProvenance } from './provenance.js';

export type ActionFamilyId =
  | 'family_01_meta_goal'
  | 'family_02_parsing_schema'
  | 'family_03_movement_nav'
  | 'family_04_world_interaction'
  | 'family_05_harvesting_pickup'
  | 'family_06_mining_staircase'
  | 'family_07_building_shelter'
  | 'family_08_agriculture_land'
  | 'family_09_inventory_equip'
  | 'family_10_crafting_recipes'
  | 'family_11_furnace_smelting'
  | 'family_12_containers_storage'
  | 'family_13_food_nutrition'
  | 'family_14_combat_defense'
  | 'family_15_survival_reflexes'
  | 'family_16_lifecycle_memory'
  | 'family_17_not_implemented';

export interface ActionDivergence {
  scenarioId: string;
  assertionName: string;
  expected: any;
  actual: any;
  evidence: string;
  probableRootCause: string;
  reproductionRecipe: string;
}

export interface ActionEvidenceRow {
  actionId: string;
  canonicalName: string;
  familyId: ActionFamilyId;
  category: string;
  isMacro: boolean;
  status: CoverageStatus;
  scenariosRun: number;
  scenariosPassed: number;
  normalScenarioId?: string;
  negativeScenarioId?: string;
  cancellationScenarioId?: string;
  firstDivergence?: ActionDivergence;
  observedServerEventsCount: number;
  notes?: string;
}

export interface FamilyExecutionReport {
  familyId: ActionFamilyId;
  familyName: string;
  startTime: string;
  endTime: string;
  durationMs: number;
  actionsCovered: string[];
  actionResults: ActionEvidenceRow[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    inconclusive: number;
    blocked: number;
    notImplemented: number;
  };
}

export interface DefectSummary {
  rank: number;
  actionId: string;
  category: string;
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  title: string;
  assertionFailure: string;
  expectedVsActual: string;
  observedEvidence: string;
  probableRootCause: string;
  reproductionRecipe: string;
}

export interface CampaignSummaryReport {
  campaignId: string;
  minecraftVersion: string;
  serverImplementation: string;
  worldId: string;
  startTime: string;
  endTime: string;
  totalDurationMs: number;
  totalActionsEvaluated: number;
  overallActionCoveragePercentage: number;
  familySummaries: Record<string, FamilyExecutionReport>;
  perActionMatrix: Record<string, ActionEvidenceRow>;
  topRankedDefects: DefectSummary[];
  liveTestGaps: string[];
  provenance?: CampaignProvenance;
  diagnostics: {
    totalRetries: number;
    botDeaths: number;
    llmCallsCount: number;
    stuckActionsCount: number;
    cleanupFailuresCount: number;
  };
  artifacts: {
    summaryJson: string;
    summaryMarkdown: string;
    familyReports: string[];
  };
}
