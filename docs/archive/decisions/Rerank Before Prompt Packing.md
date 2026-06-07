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

The relevant call sites today are:

- **Retrieved-memory construction (web)** — `app/src/lib/context-memory.ts` already exposes `buildRetrievedMemoryKnownContext`, which is the function that turns deterministic retrieval output into the string block fed into delegation briefs. This is the natural home for the rerank hook on the delegation path.
- **Role-memory assembly (web)** — `app/src/lib/role-memory-context.ts` is where retrieved-memory blocks are actually built per role. It owns `buildAuditorEvaluationMemoryBlock` (around `role-memory-context.ts:124`) as well as the equivalent helpers for other role prompts. This is the second call site that needs to opt into rerank.
- **Auditor runtime (shared)** — `lib/auditor-agent.ts` receives the memory block through the injected `resolveEvaluationMemoryBlock` callback; the app shim at `app/src/lib/auditor-agent.ts:118` wires `buildAuditorEvaluationMemoryBlock` in. The shared module itself does not need to change: rerank lives behind the callback.
- **Delegation brief formatter** — `app/src/lib/role-context.ts` is a thin re-export shim over `@push/lib/delegation-brief` and simply passes `envelope.knownContext` through. It is not where retrieved memory is packed, so it is **not** a rerank integration point. The work happens upstream, before `knownContext` is set on the envelope.

**CLI parity note.** The memory-assembly call sites above (`context-memory.ts`, `role-memory-context.ts`, and the `buildAuditorEvaluationMemoryBlock` wiring) currently live under `app/src/lib/`, not shared `lib/`. This spike therefore ships rerank **web-first by construction**. True CLI parity requires either (a) lifting the relevant memory-assembly helpers into shared `lib/` as part of the selective shared-runtime tranche, or (b) re-implementing the rerank hook on whatever CLI-side memory path exists today. Pick one and call it out in the measurement follow-up — do not leave it ambiguous.

### Rerank Function Shape

The rerank interface is a plain async function:

```ts
type Rerank = (
  query: string,
  records: MemoryRecord[],
  budget: number,
) => Promise<MemoryRecord[]>;
```

Strategies plug in behind this type. The lexical strategy is effectively synchronous and resolves immediately; the cross-encoder strategy performs a real provider call. Returning `Promise` uniformly avoids a sync/async split at the call site and keeps the pipeline from collapsing into sync-over-async anti-patterns when a strategy does I/O.

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
