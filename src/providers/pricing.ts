import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../logger.js";

interface PricingTable {
  fetched_at: string;
  source: string;
  models: Record<string, { input_per_million: number; output_per_million: number }>;
}

const STALE_DAYS = 60;

/**
 * Load a pricing table from compat/ and warn if stale (>60 days).
 * Per rule A15: cost-table drift is tracked.
 */
export function loadPricingTable(filename: string): PricingTable {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const path = join(thisDir, "..", "..", "compat", filename);
  const raw = JSON.parse(readFileSync(path, "utf-8")) as PricingTable;

  const fetchedAt = new Date(raw.fetched_at);
  const ageMs = Date.now() - fetchedAt.getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);

  if (ageDays > STALE_DAYS) {
    logger.warn(
      { file: filename, fetchedAt: raw.fetched_at, ageDays: Math.round(ageDays) },
      `Pricing table is stale (>${STALE_DAYS} days). Update ${filename} from ${raw.source}`
    );
  }

  return raw;
}

/**
 * Compute cost in USD from token counts and a pricing table.
 * Falls back to the most expensive model in the table if the model is unknown.
 */
export function computeCostFromTokens(
  table: PricingTable,
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  let pricing = table.models[model];

  if (!pricing) {
    // Try partial match (e.g., "codex-1-mini" matches "codex-1")
    for (const [key, val] of Object.entries(table.models)) {
      if (model.startsWith(key) || key.startsWith(model)) {
        pricing = val;
        break;
      }
    }
  }

  if (!pricing) {
    // Fall back to most expensive model (conservative estimate)
    const entries = Object.values(table.models);
    pricing = entries.reduce((max, p) =>
      p.output_per_million > max.output_per_million ? p : max
    , entries[0]);
    logger.warn({ model, fallback: pricing }, `Unknown model "${model}", using most expensive pricing`);
  }

  return (
    (inputTokens / 1_000_000) * pricing.input_per_million +
    (outputTokens / 1_000_000) * pricing.output_per_million
  );
}
