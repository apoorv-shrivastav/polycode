# polycode Sanity Check Results

**Date:** 2026-04-22
**Decision: GO**

## Checklist

### 1. Can Claude Code run non-interactively?
**YES.** `claude --print --output-format stream-json --verbose` works reliably. Tested with v2.1.117.

### 2. Does --bare prevent CLAUDE.md loading?
**YES.** Verified by seeding a poisoned CLAUDE.md and confirming the reviewer output was not affected. Regression test written (`test/regression/bare-isolation.test.ts`).

### 3. Does stream-json output include tool events?
**YES.** Tool uses appear as `assistant` events with `tool_use` content blocks. Tool results appear as `tool` events. Format documented in `compat/stream-json-fixtures/`.

### 4. Does --max-budget-usd work?
**YES.** Claude Code respects the budget flag and emits `result.subtype = "error_max_budget_usd"` when exceeded. Verified with $0.05 budget.

### 5. Can we parse the result event for cost/token data?
**YES.** `result.modelUsage` contains per-model breakdowns with `inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`, and `costUSD`.

### 6. Is the fresh-session reviewer meaningfully different from self-review?
**PLAUSIBLE.** The reviewer gets `--bare` (no project context, no MCP, no hooks) and a fresh `--session-id`. It sees only the diff and the review rubric. Whether this produces materially different review quality is what the eval will test.

### 7. Is wrapper mode honest about its gaps?
**YES.** Five gaps documented in §8.1 and printed verbatim at session start. No false claims of enforcement.

## Notes

- `--max-turns` does not exist in Claude Code CLI. Enforced at orchestrator level.
- Actual flag is `--append-system-prompt`, not `--system-prompt-append` as some docs state.
- Version pinned to 2.1.117; mismatch aborts unless env override set.

## Conclusion

The foundation is sound for testing H1. Proceed with v0 build.
