# polycode

Orchestration layer for AI coding CLIs with enforced **plan → implement → independent review** workflow, budget/policy envelopes, and structured traces.

## What it does

`polycode` wraps AI coding CLIs (currently Claude Code) and adds three things they don't reliably provide on their own:

1. **Enforced workflow** — Every task runs through plan → implement → review, where the reviewer is provably isolated from the implementer's context (`--bare` mode, fresh session).
2. **Policy + budget envelope** — Per-role tool allowlists, path restrictions, bash default-deny, session-level budget caps with automatic kill.
3. **Structured traces** — Every turn (tokens, cost, tools used, outcome) logged to local SQLite for post-hoc inspection.

## Quick start

```bash
# Install dependencies
npm install

# Build
npm run build

# Plan only (dry run)
npx polycode plan "Refactor auth module" --dry-run

# Full plan-implement-review with $2 budget
npx polycode run "Refactor auth module" --budget-usd 2.00 --allow-dirty

# Review an existing diff
npx polycode review HEAD~1..HEAD

# Inspect a past session
npx polycode trace <session-id>
```

## CLI commands

| Command | Description |
|---------|-------------|
| `polycode run <task>` | Full plan→implement→review pipeline |
| `polycode plan <task>` | Planner only, emits plan.json |
| `polycode review <diff-ref>` | Independent reviewer on a git diff |
| `polycode trace <session-id>` | Pretty-print or export a session trace |
| `polycode replay <session-id>` | Re-run from stored plan/policy |
| `polycode eval <corpus-dir>` | Run the 2x2 eval harness (Week 4) |

### Key flags

- `--budget-usd <n>` — Override budget cap
- `--policy <file>` — Custom policy JSON
- `--allow-dirty` — Skip clean-git precondition
- `--enable-bash` — Enable Bash for implementer (requires `bash_enabled` in policy)
- `--dry-run` — Show what would happen without spawning CLIs
- `--model <id>` — Override model selection

## How it works

### Wrapper mode (v0)

polycode spawns `claude --print --output-format stream-json` as a subprocess. It does NOT broker tool calls or inspect raw model outputs. This is an honest limit documented in the [design spec](DESIGN.md).

### The review gate

The reviewer runs with `--bare` (no `CLAUDE.md`, no MCP servers, no hooks) and a fresh session ID. It sees only the diff and step description. This is the operational definition of "independent" and is the single most important implementation detail.

### Policy enforcement

| What | How |
|------|-----|
| Tool allowlists (per-role) | `--allowedTools` flag to Claude Code |
| Budget (per invocation) | `--max-budget-usd` flag |
| Budget (session rollup) | Orchestrator SIGTERM |
| Path restrictions | Post-hoc diff check with `realpath` canonicalization |
| Bash commands | Audit-only prefix matching (not prevention) |
| Review cycle cap | Orchestrator state (default: 2 cycles/step) |

### What is NOT enforced (honest gaps)

These are printed at every session start:

1. Tool-event authenticity — trusts Claude Code's self-reported tool calls
2. Bash exfiltration — side effects happen before diff check
3. Prompt injection via codebase content — not defended against
4. Network egress — blocked by config, not at OS/network level
5. Bash prefix allowlist — audit-only, not prevention

## Project structure

```
src/
  cli/              CLI entry points (cac)
  orchestrator/     Plan-implement-review state machine
  providers/        Claude Code adapter with version pinning
  policy/           Path validation, tool gating, policy translation
  trace/            SQLite schema + store
  errors.ts         Typed error matrix
  logger.ts         Structured logging (pino)
test/
  unit/             Unit tests (95 tests)
  regression/       Bare-isolation regression test
compat/
  claude-code-version.txt   Pinned CLI version
  stream-json-fixtures/     Recorded event streams
```

## Testing

```bash
npm test                              # All unit tests
npm run test:unit                     # Unit tests only
npm run test:regression               # Bare-isolation test (spawns real claude)
POLYCODE_SKIP_INTEGRATION=1 npm test  # Skip integration tests
```

## Known limitations

- v0 uses Claude Code only (single provider)
- `--max-turns` does not exist in Claude Code CLI; enforced at orchestrator level
- Eval harness is not yet implemented (Week 4)
- No TUI/web dashboard — CLI + structured logs only

## Hypotheses being tested

> **H1**: A fresh, independent reviewer session catches more defects per dollar than a single-session agent, using the same provider for both.

This is tested via a 2x2 eval (conditions A/B/C) on a seeded-defect corpus. If H1 fails, the product as designed is abandoned.

## License

MIT
