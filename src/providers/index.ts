export type { ProviderAdapter, ProviderCapabilities, RunOptions } from "./adapter.js";
export { ClaudeCodeAdapter } from "./claude-code.js";
export { CodexAdapter } from "./codex.js";
export { GeminiAdapter } from "./gemini.js";
export { loadPricingTable, computeCostFromTokens } from "./pricing.js";

import type { ProviderAdapter } from "./adapter.js";
import { ClaudeCodeAdapter } from "./claude-code.js";
import { CodexAdapter } from "./codex.js";
import { GeminiAdapter } from "./gemini.js";

export type ProviderName = "claude-code" | "codex" | "gemini";

/**
 * Create a provider adapter by name.
 * Returns null for unknown providers.
 */
export function createAdapter(name: ProviderName): ProviderAdapter {
  switch (name) {
    case "claude-code":
      return new ClaudeCodeAdapter();
    case "codex":
      return new CodexAdapter();
    case "gemini":
      return new GeminiAdapter();
    default:
      throw new Error(`Unknown provider: ${name}`);
  }
}
