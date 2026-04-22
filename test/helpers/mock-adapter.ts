/**
 * Mock adapter for integration testing.
 * Returns configurable responses without spawning real claude.
 * Supports per-role response scripting and side-effect callbacks
 * for simulating file edits during implementation.
 */
import type { ProviderAdapter, ProviderCapabilities, RunOptions } from "../../src/providers/adapter.js";
import type { NormalizedTurn, RunResult, Role } from "../../src/models/events.js";

export interface MockResponse {
  textOutput: string;
  costUsd?: number;
  numTurns?: number;
  isError?: boolean;
  exitReason?: "ok" | "budget_kill" | "cli_error";
  /** Side effect to run during the mock call (e.g., write files for implementer). */
  sideEffect?: () => void;
  /** Tool events to emit. */
  toolEvents?: Array<{ toolName: string; path?: string; argsJson?: string; resultSummary?: string }>;
}

export interface MockScript {
  /** Responses keyed by role. For multiple calls to the same role, provide an array. */
  planner?: MockResponse | MockResponse[];
  implementer?: MockResponse | MockResponse[];
  reviewer?: MockResponse | MockResponse[];
}

export class MockAdapter implements ProviderAdapter {
  readonly id = "mock";
  readonly pinnedVersion = "mock-1.0.0";
  readonly capabilities: ProviderCapabilities = {
    supportsBudgetFlag: true,
    supportsToolAllowlist: true,
    supportsBareMode: true,
    supportsResume: true,
    supportsJsonStream: true,
    supportsModelOverride: true,
  };

  private callCounts: Record<Role, number> = { planner: 0, implementer: 0, reviewer: 0 };
  /** Every call made to run(), for assertions. */
  readonly calls: Array<{ role: Role; prompt: string; bare?: boolean; enableBash?: boolean }> = [];

  constructor(private script: MockScript) {}

  async checkVersion(): Promise<void> {
    // No-op for mock
  }

  async run(opts: RunOptions): Promise<RunResult> {
    const { role } = opts;
    this.calls.push({ role, prompt: opts.prompt, bare: opts.bare, enableBash: opts.enableBash });

    const responses = this.script[role];
    if (!responses) {
      throw new Error(`MockAdapter: no response scripted for role "${role}"`);
    }

    const callIndex = this.callCounts[role]++;
    const response = Array.isArray(responses)
      ? responses[callIndex] ?? responses[responses.length - 1]
      : responses;

    // Execute side effects (e.g., writing files to simulate implementer)
    if (response.sideEffect) {
      response.sideEffect();
    }

    // Emit tool events
    if (response.toolEvents) {
      for (const te of response.toolEvents) {
        opts.onToolEvent({
          toolName: te.toolName,
          argsJson: te.argsJson ?? null,
          resultSummary: te.resultSummary ?? null,
          path: te.path ?? null,
        });
      }
    }

    const turn: NormalizedTurn = {
      provider: "mock",
      model: "mock-model",
      providerSession: `mock-session-${callIndex}`,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: response.costUsd ?? 0.01,
      numTurns: response.numTurns ?? 1,
      isError: response.isError ?? false,
      exitReason: response.exitReason ?? "ok",
      rawResultJson: JSON.stringify({ mock: true }),
    };

    opts.onTurn(turn);

    return {
      turn,
      textOutput: response.textOutput,
    };
  }
}
