# Rerank Before Prompt Packing

Status: Draft spike, added 2026-04-14
Origin: [Context Memory and Retrieval Architecture](Context%20Memory%20and%20Retrieval%20Architecture.md), r/ollama CPU SLM agent post (2026-04)

## Context

The Context Memory and Retrieval Architecture doc (shipped Phases 1–4, Phase 5 partial) gave Push a typed memory store, deterministic retrieval, freshness-aware invalidation, and sectioned prompt packing. Retrieval today is essentially:

1. Collect candidate memory records scoped to repo/branch/chat.
2. Apply deterministic filters (type, freshness, task-graph scope).
3. Pack the survivors into bounded sectioned blocks until the section budget is exhausted.

That is already a big step up from a rolling transcript. But the selection step between "candidates" and "packed" is still mostly shape-based (type, freshness, scope) rather than semantic-quality-based. Once retrieval has the right shape, we still pack roughly the first N records that fit.

The external CPU-SLM writeup's most transferable architectural claim was not "use a small model" — it was **"rerank first, then pack a smaller, higher-quality context."** The cost of the rerank pass is paid back many times over in inference savings, and the quality of packed context goes up. Push is nowhere near CPU-bound inference, but the second half of that argument — smaller, higher-quality packs — is still directly useful:

- Frontier-model cost scales with prompt tokens.
- Sonnet/Opus attention quality degrades on noisy context, especially for surgical roles like Coder and Auditor.
- Delegation briefs are the single hottest context surface in the system, and they're constructed per-task.

## Proposal

Add an optional rerank stage between deterministic retrieval and sectioned packing, scoped initially to delegation briefs (Coder and Explorer) and the Auditor pre-commit gate.

### Pipeline Shape (target)

```
candidate records
    │
    ▼
deterministic filter  (already shipped)
    │
    ▼
rerank                (new, this doc)
    │
    ▼
sectioned pack        (already shipped)
    │
    ▼
delegation brief / auditor prompt
```

### Rerank Strategy

The rerank step takes:

- a **query** — for a delegation, the task description plus acceptance criteria; for the Auditor, the patchset summary plus the commit message
- the **candidate records** surviving deterministic filtering
- a **budget** — the final number of records the packer should consider, typically much smaller than the candidate set

It returns the candidates re-ordered by relevance to the query. The packer then walks the re-ordered list instead of the deterministic order.

Two strategies worth trying, in order:

1. **Cheap lexical rerank.** BM25 or similar over record text against the query. Zero external dependency, zero latency cost, works offline, runs in both web and CLI. Probably captures most of the easy wins for Push's current memory shapes.
2. **Cross-encoder rerank.** A hosted small-model call (Haiku 4.5, or whatever the active backend's cheapest option is) asked to score each candidate against the query and return an order. Higher quality, nonzero latency, only worth it where deterministic + lexical rerank are clearly insufficient.

Lexical rerank is the v1 target. Cross-encoder rerank is the growth path, not the starting point.

### Scope of the First Pass

- **In scope:** delegation briefs for Coder and Explorer; Auditor pre-commit prompt.
- **Out of scope for v1:** Orchestrator memory retrieval, Reviewer advisory diff context, Coder working memory (which is already curated by the Coder itself), live chat context.

Starting with delegation and Auditor keeps the blast radius small and targets the two surfaces where a tighter, less noisy pack most obviously improves outcomes.

## Integration Points

- `lib/context-memory.ts` (retrieval) — expose an optional rerank hook between filter and return.
- `app/src/lib/role-context.ts` (delegation brief formatter) — opt into rerank for Coder/Explorer briefs.
- `app/src/lib/auditor-agent.ts` — opt into rerank when assembling the patchset-scoped memory block.
- Shared `lib/` so CLI gets the same behavior without a second implementation.

The rerank interface should be a plain function `(query, records, budget) => records` with no I/O assumptions; strategies plug in behind it. That way the lexical path is synchronous and the cross-encoder path can be async without forcing the whole pipeline async-first.

## Measurement

Without measurement this is just vibes. The spike ships with:

- A counter of candidate records in vs. records packed, per call site.
- A `rerank.strategy` trace event tagging each pack with the strategy used (`none`, `lexical`, `cross_encoder`).
- A follow-up comparison of delegation outcomes (Coder acceptance rate, Auditor SAFE rate, task-graph success rate) before and after rerank is enabled by default.

Any rerank strategy that can't demonstrate a measurable improvement on at least one of those axes should not be shipped as default-on.

## Risks and Open Questions

- **Rerank is a correctness-sensitive step.** A bad ranker can actively hurt by pushing the right record out of the final pack. Defaults matter: the deterministic filter order remains the fallback if the reranker returns nothing or errors.
- **Lexical rerank may be too shallow for structured memory records.** Typed records carry a lot of non-lexical signal (kind, origin, file association). The rerank function may need to weight those alongside raw text similarity.
- **Cost shape for the cross-encoder path.** A delegation brief with, say, 30 candidate records and a Haiku-class cross-encoder is a real token spend. The spike should confirm it's actually cheaper than the equivalent extra Coder/Auditor input tokens before enabling it by default.
- **Interaction with freshness invalidation.** If a freshness-invalidated record is lexically similar to the query, it should still be excluded. The rerank must run after invalidation, not replace it.
- **Does the Orchestrator benefit?** Unclear. The Orchestrator sees a lot of general-purpose context that is hard to rank against a short user turn. Likely not worth the first pass.

## Acceptance Criteria

1. Rerank hook lands in `lib/context-memory.ts` with a lexical default strategy and typed interface for swap-in strategies.
2. Delegation brief formatter and Auditor prompt both consume rerank; each has a targeted unit test.
3. Trace events tag each pack with the rerank strategy used and are validated by the CLI protocol schema harness.
4. Follow-up measurement note captures pack-size delta and delegation-outcome delta across at least a few hundred real runs.
5. Feature gate exists so rerank can be disabled at runtime without a redeploy.

## Decision (pending)

This doc is a draft spike, not a shipped decision. Promote it to a real decision only once the lexical rerank pass has been measured and the delegation-outcome delta is understood. Until then, Context Memory and Retrieval Architecture remains the canonical reference and the pipeline behaves as it does today.
