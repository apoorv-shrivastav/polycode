/**
 * SQLite schema DDL for the polycode trace store.
 * Per §4.1 — WAL mode, ULIDs, integer Unix-ms timestamps.
 */
export const SCHEMA_DDL = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,
  task            TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  closed_at       INTEGER,
  mode            TEXT NOT NULL,
  policy_json     TEXT NOT NULL,
  budget_usd_cap  REAL NOT NULL,
  budget_usd_used REAL NOT NULL DEFAULT 0,
  outcome         TEXT,
  cc_version      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS turns (
  id                 TEXT PRIMARY KEY,
  session_id         TEXT NOT NULL REFERENCES sessions(id),
  role               TEXT NOT NULL,
  ordinal            INTEGER NOT NULL,
  step_id            TEXT,
  review_cycle       INTEGER NOT NULL DEFAULT 0,
  provider           TEXT NOT NULL,
  model              TEXT NOT NULL,
  provider_session   TEXT,
  started_at         INTEGER NOT NULL,
  ended_at           INTEGER,
  input_tokens       INTEGER,
  output_tokens      INTEGER,
  cache_read_tokens  INTEGER,
  cache_write_tokens INTEGER,
  cost_usd           REAL,
  num_turns          INTEGER,
  is_error           INTEGER,
  exit_reason        TEXT,
  raw_result_json    TEXT
);

CREATE TABLE IF NOT EXISTS tool_events (
  id             TEXT PRIMARY KEY,
  turn_id        TEXT NOT NULL REFERENCES turns(id),
  tool_name      TEXT NOT NULL,
  args_json      TEXT,
  result_summary TEXT,
  path           TEXT,
  in_scope       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS outcomes (
  session_id      TEXT PRIMARY KEY REFERENCES sessions(id),
  tests_passed    INTEGER,
  user_accept     INTEGER,
  defects_caught  INTEGER,
  false_positives INTEGER,
  notes           TEXT
);

CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_events_turn ON tool_events(turn_id);
`;
