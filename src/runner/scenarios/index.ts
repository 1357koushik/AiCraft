import { breakLogScenario } from './break_log.js';
import { unreachableTargetScenario } from './unreachable_target.js';
import { cancelMovementScenario } from './cancel_movement.js';
import { ScenarioDefinition } from '../types.js';

export const VERTICAL_DEMO_SCENARIOS: ScenarioDefinition[] = [
  breakLogScenario,
  unreachableTargetScenario,
  cancelMovementScenario,
];

export { breakLogScenario, unreachableTargetScenario, cancelMovementScenario };
