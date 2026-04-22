# polycode — Agent Conventions (v0.2)

These rules are non-negotiable for any agent (human or AI) working on this codebase.
Derived from DESIGN.md Appendix A. Must stay in sync.

## Rules

1. **Never expand v0 scope.** If it's not in §3–§9, file an issue, don't add it.
2. **Honor wrapper-mode honesty.** Never write code or log messages that claim to enforce something the wrapper cannot actually enforce. A log message is not enforcement.
3. **Do not paper over CLI instabilities.** Unknown stream-json event types fail loudly. Add a mapping only after a human confirms the event's meaning and records a fixture.
4. **Pin Claude Code.** Never auto-update. Bumping the pin is a PR with re-recorded fixtures and a visible diff. Version pinned in `compat/claude-code-version.txt`.
5. **Bash is off by default, everywhere.** Enabling it requires `bash_enabled: true` in policy AND `--enable-bash` CLI flag. Planner and reviewer roles NEVER receive Bash regardless of any flag.
6. **Validate paths by canonicalization, not string matching.** `path.resolve` + `fs.realpathSync.native` + prefix check. String-prefix comparisons are not safe. See `src/policy/validate-paths.ts`.
7. **Tests over examples.** Every feature ships with unit + integration tests. `test/regression/bare-isolation.test.ts` in particular must never be skipped in CI.
8. **The eval is sacred.** Do not modify the corpus, metrics, or pre-registered thresholds without a human-approved, committed justification. Do not soften a decision rule after seeing results.
9. **No secrets in code, traces, or logs.** Redact all API keys and auth headers at the logger layer (pino formatter) before serialization.
10. **Deterministic where possible.** Injectable clocks for ULIDs. Reproducible tests.
11. **Fail fast on vendor surprise.** If a Claude Code flag has changed behavior, stop and surface the discrepancy with quoted `claude --help` output. Do not guess.
12. **Keep `AGENTS.md` in sync with DESIGN.md Appendix A.** This is the canonical project conventions file for future agents.

## Architecture

- **Tech stack:** TypeScript on Node 20+, ESM modules
- **CLI framework:** `cac`
- **Logging:** `pino` — structured JSON to stderr, human summary to stdout
- **Provider adapters:** `src/providers/` — v0 ships only `claude-code.ts`
- **Trace store:** SQLite via `better-sqlite3` with WAL mode at `.poly/trace.db`
- **Plans:** Written to `.poly/plans/<session_id>.json`
- **Policy:** Per-role tool allowlists (§4.2), bash default-off, canonicalized path validation (§7.5)
- **Errors:** Typed error matrix in `src/errors.ts` — every failure mode has a code, exit code, and remediation

## Known CLI flag discrepancies

- `--max-turns` does not exist in Claude Code CLI (v2.1.117). Specified in §6.4/§8.2 as "CC-native" but enforced at orchestrator level.
- The spec says `--system-prompt-append`; actual flag is `--append-system-prompt`.

## Key v0.2 changes from v0

- `allowed_tools` → `allowed_tools_by_role` (per-role tool allowlists)
- Bash is default-deny; double-gated by policy + CLI flag
- `max_review_cycles_per_step` caps reviewer/implementer ping-pong (default: 2)
- Path validation uses `path.resolve` + `fs.realpathSync.native` + prefix check
- `denied_paths` expanded to include `**/id_*` and `**/.ssh/**`
- 5 honest gaps printed at session start (was 3), including bash exfiltration and prompt injection
- `estimated_cost_usd` removed from plan steps
- Typed error matrix with specific remediation messages
- Version pinning: adapter checks `claude --version` against `compat/claude-code-version.txt`
- SQLite sessions table includes `cc_version`; turns include `step_id` and `review_cycle`
