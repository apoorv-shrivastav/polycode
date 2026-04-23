export { EvalRunner, type EvalRunnerOptions } from "./runner.js";
export type {
  EvalCondition,
  Defect,
  CorpusManifest,
  DefectRunResult,
  ConditionMetrics,
  ConditionComparison,
  ConfidenceInterval,
} from "./types.js";
export {
  computeConditionMetrics,
  compareConditions,
  proportionDifferenceCI,
  applyDecisionRule,
  resultsToCSV,
  formatSummaryReport,
} from "./metrics.js";
