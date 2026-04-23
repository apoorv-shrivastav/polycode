# polycode eval — Pre-Registration

**Committed before the first eval run.**
**Do not modify after any eval results are generated. See §9.5.**

## Frozen prompts

### Condition B: Self-review prompt (same session as implementer)

```
Review the following code change for defects.
Look for: correctness issues, security vulnerabilities, missing error handling, edge cases.

\`\`\`diff
{diff}
\`\`\`

List any defects you find as JSON: { findings: [{ issue, path, severity }] }
If no defects, respond with { findings: [] }
```

### Condition C: Fresh independent reviewer prompt (--bare, new session)

```
Review the following code change for defects.
Look for: correctness issues, security vulnerabilities, missing error handling, edge cases.

\`\`\`diff
{diff}
\`\`\`

Output JSON: { step_id: 'eval', verdict: 'approve'|'request_changes'|'reject', findings: [{ severity, path, line, issue, suggestion }], tests_suggested: [], overall_notes: '' }
```

## Thresholds

### H1 (fresh same-provider reviewer catches more defects)

H1 is **supported** if ALL of:
1. **Aggregate C vs A**: Condition C defect-catch rate exceeds Condition A by ≥ 15 percentage points, with 95% CI excluding zero.
2. **Aggregate C vs B**: Condition C defect-catch rate exceeds Condition B by ≥ 5 percentage points, with 95% CI excluding zero.
3. **Stratified**: The C-over-A effect holds in ≥ 60% of individual codebases.

### H2 (different-provider reviewer, v0.5 only)

H2 is **supported** if:
- Condition D defect-catch rate exceeds Condition C by ≥ 5 percentage points at ≤ 1.3× the cost.
- Same stratification requirement (≥ 60% of codebases).

## Statistical method

Two-proportion z-test (Wald interval) for 95% confidence intervals on the difference between proportions.

## Corpus manifest

See `eval-corpus/manifest.json` for the exact set of defects and codebases.

Starter corpus: 10 defects across 2 codebases (calc, userstore).
Target corpus: 120 defects across 7-10 codebases.

### Defect categories represented
- Off-by-one (2)
- Null/undefined check miss (3)
- Input validation gap (2)
- Authorization escape (1)
- Business logic violation (1)
- Resource leak / mutation (1)

## Decision rule

- **If H1 passes**: Proceed to v1. Ship single-provider fresh-reviewer workflow.
- **If H1 fails**: Abandon the product as currently designed.
- **If ambiguous** (CIs straddle threshold): Enlarge the corpus before deciding. Do NOT move the threshold.
- **If H1 passes but H2 fails** (v0.5): Keep Codex as optional provider but deprioritize cross-provider work.

## Cost ceiling

- Maximum eval cost: $1500 (default)
- Orange-line warning at $1000
- On breach: abort, emit partial results labeled INCOMPLETE

## Reproducibility

- Every eval run produces a full trace in `eval/runs/<run-id>/`
- Results include session IDs linking to the trace DB
- Model ID, prompt, and policy are recorded per run
