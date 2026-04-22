import type { Policy } from "../models/policy.js";
import type { Role, NormalizedTurn, NormalizedToolEvent, RunResult } from "../models/events.js";

export interface ProviderCapabilities {
  supportsBudgetFlag: boolean;
  supportsToolAllowlist: boolean;
  supportsBareMode: boolean;
  supportsResume: boolean;
  supportsJsonStream: boolean;
  supportsModelOverride: boolean;
}

export interface RunOptions {
  role: Role;
  prompt: string;
  policy: Policy;
  model?: string;
  bare?: boolean;
  sessionId?: string;
  addDirs?: string[];
  enableBash?: boolean;
  onTurn: (turn: NormalizedTurn) => void;
  onToolEvent: (evt: NormalizedToolEvent) => void;
}

export interface ProviderAdapter {
  readonly id: string;
  readonly pinnedVersion: string;
  readonly capabilities: ProviderCapabilities;

  /** Verify that the installed CLI matches the pinned version. */
  checkVersion(): Promise<void>;

  run(opts: RunOptions): Promise<RunResult>;
}
