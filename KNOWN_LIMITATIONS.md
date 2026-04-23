# polycode v0.1 — Known Limitations

## Wrapper mode gaps (printed at every session start)

1. **Tool-event authenticity**: polycode trusts Claude Code's self-reported tool calls. There is no independent verification. A compromised or buggy CLI could misreport what tools were used.

2. **Bash exfiltration**: When Bash is enabled, a command that exfiltrates data, deletes files outside the repo, or contacts the network completes before the diff check runs. The revert undoes git-tracked changes only, not side effects. **Mitigation**: Bash is disabled by default and requires two explicit opt-ins (policy + CLI flag).

3. **Prompt injection via codebase content**: A file the implementer reads can contain instructions that influence its behavior. polycode does not scan for or defend against this. **Mitigation**: Reviewer isolation (--bare) plus human approval on final accept.

4. **Network egress**: MCP servers are disabled via --bare for the reviewer, and WebFetch/WebSearch are blocked by tool allowlist config. However, this is not enforced at the OS or network level. A determined model could potentially use other channels.

5. **Bash prefix allowlist is audit-only**: Claude Code accepts or denies Bash as a whole tool; per-command filtering is checked post-hoc. This is defense-in-depth, not prevention.

## Operational limitations

- **Single provider**: v0 supports Claude Code only. Cross-provider review (Condition D) is deferred to v0.5.
- **No `--max-turns` in Claude Code**: The CLI does not support `--max-turns`. Turn limits are enforced at the orchestrator level by tracking stream-json events.
- **Eval corpus is a starter set**: The current corpus has 10 defects across 2 codebases. The target for statistically meaningful results is 120 defects across 7-10 codebases.
- **No TUI/dashboard**: Output is CLI + structured logs + SQLite traces. No web UI.
- **Non-interactive by default**: Sessions that need human input require `--interactive` explicitly.
- **Replay reproduces orchestration, not model outputs**: Replaying a session re-runs the same sequence of spawns and policy checks, but the model may produce different outputs.

## What v2 (controlled-execution mode) would fix

Controlled-execution mode calls the Anthropic API directly with an in-process tool broker. This closes gaps 1, 2, and 5 by:
- Running all tool calls through polycode's code (not the CLI's)
- Enforcing path and command allowlists before execution, not after
- Recording signed events for attestation
