# polycode eval — Pre-Registration v0.5 (Condition D)

**Committed before the first Condition D eval run.**
**Do not modify after any D-condition results are generated. See v0.5 addendum §6.2.**

## Gate

This pre-registration is only actionable if:
1. `eval/RESULTS-v0.1.md` shows H1 SUPPORTED
2. Stratified requirement held (≥60% of codebases)
3. No open critical bugs on `polycode run`

## Shared reviewer rubric (provider-neutral)

Per v0.5 §6.2: the rubric body is identical across Condition C and Condition D.
Do NOT retune per provider. Only output-format scaffolding may vary.

```
Review the following code change for defects.
Look for: correctness issues, security vulnerabilities, missing error handling, edge cases.

\`\`\`diff
{diff}
\`\`\`

Output JSON: { step_id: 'eval', verdict: 'approve'|'request_changes'|'reject', findings: [{ severity, path, line, issue, suggestion }], tests_suggested: [], overall_notes: '' }
```

## Conditions tested

- **D3**: implementer=Claude Code, reviewer=Codex (--ignore-user-config --ignore-rules --ephemeral)
- **D5**: implementer=Claude Code, reviewer=Gemini (HOME-redirection isolation)

Compared against **Condition C** from v0 (implementer=CC, reviewer=CC --bare).

## Thresholds (H2)

H2 is **supported** if, for each of D3 and D5 independently:
1. Defect-catch rate exceeds Condition C by ≥ 5 percentage points, 95% CI excluding zero
2. Cost per caught defect ≤ 1.3× Condition C's cost per caught defect
3. Stratified: effect appears in ≥ 60% of codebases

**H2 partially supported** if one passes and the other does not.
**H2 not supported** if neither passes.

## Decision rule

- H2 passes: proceed to v1 with multi-provider reviewer as default
- H2 partially passes: ship the passing provider, deprioritize the other
- H2 fails: retain adapters as user-selectable, stop investing in cross-provider as default

## Corpus

Same corpus as v0 eval. See `eval-corpus/manifest.json`.

## Cost ceiling

- Maximum: $3000 (v0.5 addendum §6.4)
- Orange line: $2000
- On breach: abort with INCOMPLETE label
