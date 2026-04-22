/**
 * Typed error matrix per §6.3.
 * Every failure mode gets a specific class with a remediation message.
 * Users see actionable guidance, not stack traces.
 */

export class PolycodeError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly exitCode: number,
    public readonly remediation: string
  ) {
    super(message);
    this.name = "PolycodeError";
  }
}

/** claude binary not found on $PATH or version mismatch. */
export class BinaryMissing extends PolycodeError {
  constructor(detail: string) {
    super(
      `Claude Code binary not available: ${detail}`,
      "BINARY_MISSING",
      127,
      "Install Claude Code: npm install -g @anthropic-ai/claude-code\n" +
        "Or set POLYCODE_ALLOW_CC_VERSION_MISMATCH=1 to bypass version check."
    );
    this.name = "BinaryMissing";
  }
}

/** Claude Code reports auth failure in its JSON result. */
export class AuthExpired extends PolycodeError {
  constructor() {
    super(
      "Claude Code authentication has expired or is invalid.",
      "AUTH_EXPIRED",
      4,
      "Run `claude login` to re-authenticate, then retry."
    );
    this.name = "AuthExpired";
  }
}

/** Claude Code reports rate limiting, either pre-start or mid-session. */
export class RateLimited extends PolycodeError {
  public readonly retryAfterSeconds: number | null;

  constructor(retryAfterSeconds: number | null = null, midSession = false) {
    const when = midSession ? "mid-session" : "at start";
    const retryHint = retryAfterSeconds
      ? `Retry after ${retryAfterSeconds} seconds.`
      : "Wait and retry.";
    super(
      `Rate limited by Claude Code (${when}).`,
      "RATE_LIMITED",
      midSession ? 0 : 5, // 0 = handled via pause/resume
      retryHint
    );
    this.name = "RateLimited";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Session interrupted mid-step — rate limit, SIGINT, or other recoverable failure.
 * State has been persisted for resume.
 */
export class MidSessionInterrupt extends PolycodeError {
  public readonly sessionId: string;
  public readonly lastCompletedStep: string | null;
  public readonly patchFile: string | null;

  constructor(opts: {
    sessionId: string;
    lastCompletedStep: string | null;
    patchFile: string | null;
    reason: string;
  }) {
    super(
      `Session interrupted: ${opts.reason}`,
      "MID_SESSION_INTERRUPT",
      7,
      `Resume with: polycode run --session ${opts.sessionId}`
    );
    this.name = "MidSessionInterrupt";
    this.sessionId = opts.sessionId;
    this.lastCompletedStep = opts.lastCompletedStep;
    this.patchFile = opts.patchFile;
  }
}

/** Diff or plan escapes the policy's allowed_paths, or a tool is disallowed. */
export class PolicyViolation extends PolycodeError {
  public readonly violationType: "path_escape" | "tool_disallowed" | "bash_violation";
  public readonly detail: string;

  constructor(violationType: "path_escape" | "tool_disallowed" | "bash_violation", detail: string) {
    super(
      `Policy violation (${violationType}): ${detail}`,
      "POLICY_VIOLATION",
      3,
      violationType === "path_escape"
        ? "The change modifies files outside the policy's allowed_paths. It has been reverted."
        : violationType === "tool_disallowed"
          ? "A disallowed tool was used. Check policy.allowed_tools_by_role."
          : "A bash command outside the allowed prefixes was executed. This is audit-logged."
    );
    this.name = "PolicyViolation";
    this.violationType = violationType;
    this.detail = detail;
  }
}

/** Session budget exhausted (session-rollup, not just one invocation). */
export class BudgetKill extends PolycodeError {
  public readonly budgetUsdCap: number;
  public readonly budgetUsdUsed: number;

  constructor(cap: number, used: number) {
    super(
      `Session budget exhausted: $${used.toFixed(4)} used of $${cap.toFixed(2)} cap.`,
      "BUDGET_KILL",
      4,
      `Resume with a higher budget: polycode run --session <id> --budget-usd <amount>`
    );
    this.name = "BudgetKill";
    this.budgetUsdCap = cap;
    this.budgetUsdUsed = used;
  }
}

/** Unknown stream-json event type — per Appendix A rule 3, fail loudly. */
export class ToolEventUnknown extends PolycodeError {
  public readonly eventType: string;
  public readonly rawSnippet: string;

  constructor(eventType: string, rawSnippet: string) {
    super(
      `Unknown Claude Code stream-json event type: "${eventType}".`,
      "TOOL_EVENT_UNKNOWN",
      8,
      "This event type is not in polycode's mapping. File an issue with the raw snippet below.\n" +
        `Raw: ${rawSnippet.slice(0, 300)}`
    );
    this.name = "ToolEventUnknown";
    this.eventType = eventType;
    this.rawSnippet = rawSnippet;
  }
}

/** Git working tree is dirty and --allow-dirty was not set. */
export class DirtyWorkTree extends PolycodeError {
  constructor() {
    super(
      "Git working tree has uncommitted changes.",
      "DIRTY_WORKTREE",
      9,
      "Commit or stash your changes, or pass --allow-dirty to proceed."
    );
    this.name = "DirtyWorkTree";
  }
}

/** Review cycle cap exceeded — implementer and reviewer diverged. */
export class ReviewDivergence extends PolycodeError {
  public readonly stepId: string;
  public readonly cycleCount: number;

  constructor(stepId: string, cycleCount: number) {
    super(
      `Review cycle cap reached for step ${stepId} after ${cycleCount} cycles.`,
      "REVIEW_DIVERGENCE",
      6,
      "The reviewer and implementer could not converge. The step has been reverted."
    );
    this.name = "ReviewDivergence";
    this.stepId = stepId;
    this.cycleCount = cycleCount;
  }
}
