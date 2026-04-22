import Database from "better-sqlite3";
import { newId } from "../ids.js";
import { SCHEMA_DDL } from "./schema.js";
import type { Policy } from "../models/policy.js";
import type {
  SessionMode,
  SessionOutcome,
  Role,
  ExitReason,
  NormalizedToolEvent,
} from "../models/events.js";

export interface SessionRow {
  id: string;
  task: string;
  created_at: number;
  closed_at: number | null;
  mode: string;
  policy_json: string;
  budget_usd_cap: number;
  budget_usd_used: number;
  outcome: string | null;
  cc_version: string;
}

export interface TurnRow {
  id: string;
  session_id: string;
  role: string;
  ordinal: number;
  step_id: string | null;
  review_cycle: number;
  provider: string;
  model: string;
  provider_session: string | null;
  started_at: number;
  ended_at: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cost_usd: number | null;
  num_turns: number | null;
  is_error: number | null;
  exit_reason: string | null;
  raw_result_json: string | null;
}

export interface ToolEventRow {
  id: string;
  turn_id: string;
  tool_name: string;
  args_json: string | null;
  result_summary: string | null;
  path: string | null;
  in_scope: number;
}

export interface OutcomeRow {
  session_id: string;
  tests_passed: number | null;
  user_accept: number | null;
  defects_caught: number | null;
  false_positives: number | null;
  notes: string | null;
}

export class TraceStore {
  readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA_DDL);
  }

  close(): void {
    this.db.close();
  }

  // --- Sessions ---

  createSession(opts: {
    task: string;
    mode: SessionMode;
    policy: Policy;
    budgetUsdCap: number;
    ccVersion: string;
  }): string {
    const id = newId();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO sessions (id, task, created_at, mode, policy_json, budget_usd_cap, cc_version)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, opts.task, now, opts.mode, JSON.stringify(opts.policy), opts.budgetUsdCap, opts.ccVersion);
    return id;
  }

  getSession(id: string): SessionRow | undefined {
    return this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as
      | SessionRow
      | undefined;
  }

  updateSessionBudget(sessionId: string, budgetUsdUsed: number): void {
    this.db
      .prepare("UPDATE sessions SET budget_usd_used = ? WHERE id = ?")
      .run(budgetUsdUsed, sessionId);
  }

  closeSession(sessionId: string, outcome: SessionOutcome): void {
    this.db
      .prepare("UPDATE sessions SET closed_at = ?, outcome = ? WHERE id = ?")
      .run(Date.now(), outcome, sessionId);
  }

  listSessions(limit = 20): SessionRow[] {
    return this.db
      .prepare("SELECT * FROM sessions ORDER BY created_at DESC LIMIT ?")
      .all(limit) as SessionRow[];
  }

  // --- Turns ---

  createTurn(opts: {
    sessionId: string;
    role: Role;
    ordinal: number;
    stepId?: string;
    reviewCycle?: number;
    provider: string;
    model: string;
  }): string {
    const id = newId();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO turns (id, session_id, role, ordinal, step_id, review_cycle, provider, model, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        opts.sessionId,
        opts.role,
        opts.ordinal,
        opts.stepId ?? null,
        opts.reviewCycle ?? 0,
        opts.provider,
        opts.model,
        now
      );
    return id;
  }

  completeTurn(
    turnId: string,
    data: {
      providerSession: string | null;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      costUsd: number;
      numTurns: number;
      isError: boolean;
      exitReason: ExitReason;
      rawResultJson: string;
    }
  ): void {
    this.db
      .prepare(
        `UPDATE turns SET
           ended_at = ?, provider_session = ?,
           input_tokens = ?, output_tokens = ?,
           cache_read_tokens = ?, cache_write_tokens = ?,
           cost_usd = ?, num_turns = ?,
           is_error = ?, exit_reason = ?, raw_result_json = ?
         WHERE id = ?`
      )
      .run(
        Date.now(),
        data.providerSession,
        data.inputTokens,
        data.outputTokens,
        data.cacheReadTokens,
        data.cacheWriteTokens,
        data.costUsd,
        data.numTurns,
        data.isError ? 1 : 0,
        data.exitReason,
        data.rawResultJson,
        turnId
      );
  }

  getTurnsForSession(sessionId: string): TurnRow[] {
    return this.db
      .prepare("SELECT * FROM turns WHERE session_id = ? ORDER BY ordinal")
      .all(sessionId) as TurnRow[];
  }

  // --- Tool Events ---

  recordToolEvent(
    turnId: string,
    event: NormalizedToolEvent,
    inScope: boolean
  ): string {
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO tool_events (id, turn_id, tool_name, args_json, result_summary, path, in_scope)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        turnId,
        event.toolName,
        event.argsJson,
        event.resultSummary,
        event.path,
        inScope ? 1 : 0
      );
    return id;
  }

  getToolEventsForTurn(turnId: string): ToolEventRow[] {
    return this.db
      .prepare("SELECT * FROM tool_events WHERE turn_id = ?")
      .all(turnId) as ToolEventRow[];
  }

  // --- Outcomes ---

  recordOutcome(opts: {
    sessionId: string;
    testsPassed?: boolean;
    userAccept?: boolean;
    defectsCaught?: number;
    falsePositives?: number;
    notes?: string;
  }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO outcomes (session_id, tests_passed, user_accept, defects_caught, false_positives, notes)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        opts.sessionId,
        opts.testsPassed === undefined ? null : opts.testsPassed ? 1 : 0,
        opts.userAccept === undefined ? null : opts.userAccept ? 1 : 0,
        opts.defectsCaught ?? null,
        opts.falsePositives ?? null,
        opts.notes ?? null
      );
  }

  getOutcome(sessionId: string): OutcomeRow | undefined {
    return this.db.prepare("SELECT * FROM outcomes WHERE session_id = ?").get(sessionId) as
      | OutcomeRow
      | undefined;
  }
}
