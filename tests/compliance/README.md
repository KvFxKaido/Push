# Provider Compliance Suite

## What This Tests

This suite verifies that a model **obeys Push's execution contract** — nothing more, nothing less.

It tests:
- Streaming discipline
- Tool-call schema validity
- Error recovery behavior
- Multi-round coherence
- Delegation integrity
- Loop safety

It does **NOT** test:
- Intelligence or reasoning quality
- Code generation capability
- Creativity or helpfulness
- General knowledge

A model that passes is **protocol-compliant**. It may still be dumb. That's a separate problem.

## Why This Exists

Push's harness is fragile. A provider that silently drops chunks, mangles JSON, or spirals on errors doesn't just give bad answers — it breaks execution.

This suite is a gate. If a provider fails, it doesn't merge. No subjective debate. No "seems fine."

## How to Run

```bash
# Local development (pretty output)
npx tsx scripts/run-provider-compliance.ts --provider kimi

# CI mode (JSON output)
npx tsx scripts/run-provider-compliance.ts --provider anthropic --json
```

## Test Overview

| Test | What It Verifies |
|------|------------------|
| Streaming Integrity | Long responses complete without dropped chunks |
| Tool Call Schema | Exactly one valid tool call, no chatter |
| Truncated Recovery | Model self-corrects in one retry |
| Multi-Round Coherence | 3-step task completes in ≤4 rounds |
| Delegation Signal | Orchestrator emits `delegate_coder` correctly |
| Sandbox Execution | Coder writes file, returns result |
| Event Stream Clean | Tool events separate from text chunks |

See `SPEC.md` for detailed test definitions.

## Adding New Tests

1. Define the behavior you're protecting in `SPEC.md`
2. Add test implementation to `runner.ts`
3. Update this README's test table
4. Verify all current providers still pass

## Boundary

> Passing this suite guarantees protocol obedience, not intelligence.

If a provider passes but generates bad code, that's a model quality problem — not a compliance problem. File a separate issue.

---

## Current Compliance Status

| Provider | Status | Last Tested |
|----------|--------|-------------|
| Kimi K2.5 | ✅ Eligible | (not yet run) |
| Mistral | ✅ Eligible | (not yet run) |
| OpenRouter (Claude) | ✅ Eligible | (not yet run) |

(Update this table as you run tests.)
