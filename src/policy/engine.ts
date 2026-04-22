import type { Policy } from "../models/policy.js";
import type { Role } from "../models/events.js";

/**
 * Honest gaps printed at session start per §8.1.
 * Verbatim from spec — do not paraphrase.
 */
export const WRAPPER_MODE_GAPS = `polycode v0 runs in WRAPPER MODE. The following are NOT enforced:
 1. Tool-event authenticity: the adapter trusts Claude Code's
    self-reported tool calls. Verification is audit-only.
 2. Bash exfiltration: a Bash invocation that exfiltrates data,
    deletes files outside the repo, or contacts the network
    completes BEFORE the diff is checked. Revert undoes git
    changes only, not side effects. Bash is DEFAULT-DISABLED.
 3. Prompt injection via codebase content: a file the
    implementer reads can contain instructions that influence
    its behavior. We do not defend against this. Mitigation is
    reviewer isolation plus human approval on final accept.
 4. Network egress: we disable MCP via --bare on reviewer, but
    built-in tools like WebFetch and WebSearch are blocked by
    allowed_tools config, not at the OS or network level.
 5. Bash prefix allowlist is audit-only: Claude Code accepts
    or denies Bash as a unit; per-command filtering is
    post-hoc. Treat this as defense in depth, not defense.
Controlled-execution mode (v2) closes gaps 1, 2, and 5.`;

/**
 * Translate a Policy object + role into CLI flags for Claude Code.
 * Per §8.2 policy-to-flag mapping.
 *
 * Bash is NEVER given to planner or reviewer, regardless of policy.
 * Bash for implementer requires bash_enabled=true AND --enable-bash CLI flag.
 */
export function policyToClaudeFlags(
  policy: Policy,
  role: Role,
  opts?: { enableBash?: boolean }
): string[] {
  const flags: string[] = [];

  // Budget — per-invocation; session rollup is orchestrator's job
  flags.push("--max-budget-usd", String(policy.budget_usd));

  // Per-role tool allowlist
  const roleTools = [...policy.allowed_tools_by_role[role]];

  // Bash gating per §4.2:
  // - Planner and reviewer NEVER get Bash regardless of policy
  // - Implementer gets Bash only if bash_enabled=true AND --enable-bash CLI flag
  if (
    role === "implementer" &&
    policy.bash_enabled &&
    opts?.enableBash &&
    policy.allowed_bash_prefixes.length > 0
  ) {
    roleTools.push("Bash");
  }

  if (roleTools.length > 0) {
    flags.push("--allowedTools", roleTools.join(","));
  }

  // Reviewer is always bare (independent, no CLAUDE.md, no MCP, no hooks)
  if (role === "reviewer") {
    flags.push("--bare");
  }

  // Network: block WebFetch and WebSearch for all roles in deny mode
  if (policy.network.mode === "deny") {
    flags.push("--disallowedTools", "WebFetch,WebSearch");
  }

  return flags;
}

/**
 * Check whether a file path falls within the policy's allowed_paths.
 * NOTE: For security-critical checks, use validate-paths.ts with canonicalization.
 * This function is for quick audit-level checks only (e.g., tool event logging).
 */
export function isPathInAllowlist(filePath: string, policy: Policy): boolean {
  // Check denied_paths first — they take priority
  for (const pattern of policy.denied_paths) {
    if (globMatch(filePath, pattern)) {
      return false;
    }
  }
  // Then check allowed_paths
  for (const pattern of policy.allowed_paths) {
    if (globMatch(filePath, pattern)) {
      return true;
    }
  }
  return false;
}

/** Inline glob match to avoid circular import with validate-paths.ts */
function globMatch(filePath: string, pattern: string): boolean {
  const regex = globToRegex(pattern);
  return regex.test(filePath);
}

function globToRegex(pattern: string): RegExp {
  let regexStr = "^";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          regexStr += "(?:.+/)?";
          i += 3;
        } else {
          regexStr += ".*";
          i += 2;
        }
      } else {
        regexStr += "[^/]*";
        i++;
      }
    } else if (c === "?") {
      regexStr += "[^/]";
      i++;
    } else if (c === ".") {
      regexStr += "\\.";
      i++;
    } else {
      regexStr += c;
      i++;
    }
  }
  regexStr += "$";
  return new RegExp(regexStr);
}

/**
 * Check a bash command against allowed_bash_prefixes.
 * Audit-only in v0 — this does NOT prevent execution, only flags it.
 * Per §8.1 gap 5.
 */
export function isBashCommandAllowed(command: string, policy: Policy): boolean {
  if (!policy.bash_enabled) return false;
  const trimmed = command.trim();
  return policy.allowed_bash_prefixes.some((prefix) => {
    // Match prefix followed by end-of-string, space, or common separator
    // to prevent "npm test" matching "npm test-rogue-script"
    if (trimmed === prefix) return true;
    if (trimmed.startsWith(prefix + " ")) return true;
    if (trimmed.startsWith(prefix + "\t")) return true;
    return false;
  });
}

/**
 * Redact known secret env var patterns from a string.
 * Per Appendix A rule 9.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(
      /(ANTHROPIC_API_KEY|OPENAI_API_KEY|API_KEY|SECRET_KEY|AUTH_TOKEN|PASSWORD)=\S+/gi,
      "$1=[REDACTED]"
    )
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/Authorization:\s*\S+(\s+\S+)?/gi, "Authorization: [REDACTED]");
}
