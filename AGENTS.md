# polycode — Agent Conventions (v0.5)

These rules are non-negotiable for any agent (human or AI) working on this codebase.
Derived from DESIGN.md Appendix A + v0.5 addendum §8. Must stay in sync.

## Rules

1. **Never expand scope beyond the current version gate.** v0 scope is §3–§9. v0.5 scope is the v0.5 addendum. File an issue for anything else.
2. **Honor wrapper-mode honesty.** Never write code or log messages that claim to enforce something the wrapper cannot actually enforce.
3. **Do not paper over CLI instabilities.** Unknown stream-json/JSONL event types fail loudly. Add a mapping only after a human confirms the event's meaning and records a fixture.
4. **Pin all provider CLIs.** Never auto-update. Bumping a pin is a PR with re-recorded fixtures and a visible diff. Versions pinned in `compat/*-version.txt`.
5. **Bash is off by default, everywhere.** Enabling it requires `bash_enabled: true` in policy AND `--enable-bash` CLI flag. Planner and reviewer roles NEVER receive Bash regardless of any flag.
6. **Validate paths by canonicalization, not string matching.** `path.resolve` + `fs.realpathSync.native` + prefix check.
7. **Tests over examples.** Every feature ships with unit + integration tests. Isolation regression tests (`bare-isolation.test.ts` and per-provider equivalents) must never be skipped in CI.
8. **The eval is sacred.** Do not modify the corpus, metrics, or pre-registered thresholds without a human-approved, committed justification. Do not soften a decision rule after seeing results.
9. **No secrets in code, traces, or logs.** Redact all API keys and auth headers at the logger layer before serialization.
10. **Deterministic where possible.** Injectable clocks for ULIDs. Reproducible tests.
11. **Fail fast on vendor surprise — per provider.** If any of CC, Codex, or Gemini changes a pinned flag's semantics, surface it and stop. Do not paper over differences by silently migrating to a replacement flag.
12. **Keep `AGENTS.md` in sync with the spec appendices.** This is the canonical project conventions file for future agents.
13. **Never retune the eval rubric per provider.** The reviewer rubric text is provider-neutral. Per-provider output-scaffolding (JSON schema vs. plain text) is permitted; rubric-body changes are not.
14. **`--yolo`, `danger-full-access`, and equivalent flags are forbidden.** The adapter rejects invocations containing them at construction time, regardless of user config or policy.
15. **Cost-table drift is tracked.** `compat/*-pricing.json` files carry a `fetched_at` timestamp and a source link. Stale tables (>60 days) produce a warning at session start.

## Architecture

- **Tech stack:** TypeScript on Node 20+, ESM modules
- **CLI framework:** `cac`
- **Logging:** `pino` — structured JSON to stderr, human summary to stdout
- **Provider adapters:** `src/providers/` — claude-code.ts, codex.ts, gemini.ts
- **Provider registry:** `createAdapter(name)` in `src/providers/index.ts`
- **Trace store:** SQLite via `better-sqlite3` with WAL mode at `.poly/trace.db`
- **Plans:** Written to `.poly/plans/<session_id>.json`
- **Policy:** Per-role tool allowlists, bash default-off, canonicalized path validation
- **Errors:** Typed error matrix in `src/errors.ts`
- **Eval:** 2×2+D runner in `src/eval/`, pre-registration in `eval/`

## Provider isolation matrix

| Provider    | Reviewer isolation                                              | Version pin file              |
|-------------|----------------------------------------------------------------|-------------------------------|
| Claude Code | `--bare` (skips CLAUDE.md, MCP, hooks)                         | `compat/claude-code-version.txt` |
| Codex       | `--ignore-user-config --ignore-rules --ephemeral` + isolated workdir | `compat/codex-version.txt` |
| Gemini      | HOME env redirection + clean workdir (no native --bare)        | `compat/gemini-version.txt`  |

## Known CLI flag discrepancies

- `--max-turns` does not exist in Claude Code CLI. Enforced at orchestrator level.
- `--append-system-prompt` is the correct CC flag (not `--system-prompt-append`).
- Codex has no `--max-budget-usd`. Cost enforcement via orchestrator token-count rollup.
- Gemini has no `--bare` equivalent. Isolation via HOME redirection per §5.3.
