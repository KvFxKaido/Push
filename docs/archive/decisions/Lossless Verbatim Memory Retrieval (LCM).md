# Lossless Verbatim Memory Retrieval (LCM)

Status: Current for Phases 0–2 + follow-through part a — web Coder (delegated) +
Deep-Reviewer memory routing (shipped 2026-06-01). Phase 3 (verbatim log) shipped
2026-06-21 — `lib/verbatim-log.ts` kernel, CLI file backend, write-path stamping,
and read-path resolution through `memory_expand`. Only the Worker durable backend
remains deferred (no Worker-side store, same as background coder-job memory).
Origin: [Context Memory and Retrieval Architecture](Context%20Memory%20and%20Retrieval%20Architecture.md) (the layer this extends), external reference: Ehrlich & Blackman, "LCM: Lossless Context Management", Voltropy PBC, arXiv 2605.04050 (Feb 2026)

## TL;DR

Push already stores typed memory records and ranks/packs them into bounded prompt
sections. What it cannot do is let an agent pull back the **exact original text** of
a decision or finding after it has been compressed out of the active window. This
doc records that gap, ships the deterministic `lib/` kernel for verbatim retrieval
(`expandMemoryRecords` / `grepMemory`), and scopes the two remaining phases —
surfacing `detail` in the packer, and exposing a model-facing `memory_expand` /
`memory_grep` tool — without taking on an external dependency.

## Why This Exists

A Reddit/r/LangChain thread surfaced **Lossless Context Management (LCM)** — a real
technique from a real paper (Voltropy, arXiv 2605.04050; their agent "Volt" beats
Claude Code on the OOLONG long-context eval from 32K→1M tokens). The core idea:

1. **Immutable store** — every message/tool-result persisted verbatim, never mutated.
2. **Deterministic compression** — old context folded into a hierarchical DAG of
   summaries by the *engine*, not by asking the model to invent a memory strategy.
3. **Retrieval tools** (`lcm_grep` / `lcm_describe` / `lcm_expand`) so the model can
   recall the exact text of an old decision on demand.

The thesis — "stop letting the model manage its own memory" — aligns with Push's
[behavior-lives-in-code](../../../CLAUDE.md) principle, and points 1–2 substantially
overlap with what [`Context Memory and Retrieval Architecture.md`](Context%20Memory%20and%20Retrieval%20Architecture.md)
already shipped (typed records, deterministic scoring, freshness invalidation).
Point 3 is the gap.

> Sourcing caveat: the thread told readers to `pip install openlcm`. No PyPI package
> by that name resolved during investigation; the real implementations are npm
> (`@martian-engineering/lossless-claw`) and GitHub repos. We are **not** adopting an
> unverified package — the kernel below is ours. The paper is the reference; the
> package is not a dependency. (Config/dependency caution per the PR self-review pass.)

## Current State vs LCM

| LCM component | Push today | Status |
|---|---|---|
| Immutable verbatim log of every message/tool-result | Records are *synthesized from structured outcomes*, not extracted from raw history. `detail` is capped at 2000 chars on write (`lib/context-memory.ts:25`) and re-truncated to 800 on persistence (`lib/memory-persistence-policy.ts:9`). No append-only message log. | **Partial / lossy** |
| Deterministic, engine-driven compression | Summaries are orchestrator/engine-written; retrieval scoring is deterministic (`lib/context-memory-retrieval.ts:116`). | **Ahead** |
| Hierarchy of summaries (DAG) | `derivedFrom` is an invalidation-cascade edge, not a summarization tree. Compression is freshness-based (`fresh`/`stale`/`expired`), not summary-of-summary. | **Different shape** |
| Model pulls exact original on demand | None. Memory is read **only by the orchestrator, only at delegation boundaries** (`cli/task-graph-memory.ts`), spliced into a static `knownContext` block. No mid-turn retrieval, no tool path for the agent. | **Absent (now: kernel exists)** |

### The two concrete gaps

1. **The packer never surfaced `detail`.** `lib/context-memory-packing.ts` formatted
   each record as a ≤220-char slice of `record.summary` (`PER_RECORD_SUMMARY_CAP`)
   and never read `record.detail`. So the fuller text we already store and pay to
   persist was **write-only** from the model's runtime perspective — despite the
   existing decision doc specifying "summaries by default, `detail` only when the
   record is top-ranked and still fits the section budget"
   ([Context Memory and Retrieval Architecture.md](Context%20Memory%20and%20Retrieval%20Architecture.md),
   "Prompt Packing Model"). **Closed in Phase 1 (below).**

2. **No model-facing retrieval tool.** The tool registry (`lib/tool-registry.ts`)
   has no `memory` source; `lib/capabilities.ts` has no memory capability. An agent
   that saw a 220-char summary cannot ask for the rest.

## What This Doc Ships (Phase 0 — kernel)

`lib/context-memory-expand.ts` — the deterministic, side-effect-free retrieval
kernel, exported from `lib/context-memory.ts` and unit-tested
(`lib/context-memory-expand.test.ts`, 12 cases). It is the function an eventual tool
or packer change calls; kept in `lib/` so web and CLI share one definition
(new-feature checklist #1).

- `expandMemoryRecords({ ids, scope?, includeExpired? })` → returns each record's
  **verbatim** `summary` + `detail` (free of the packer's 220-char cap), in
  requested order, de-duplicated. Unknown / out-of-scope / expired ids come back in
  `missing` rather than throwing — so a caller can log a symmetric hit/miss.
- `grepMemory({ repoFullName, pattern, branch?, kinds?, limit?, ... })` → substring
  search (case-insensitive, **not regex** — the pattern is model-supplied and regex
  is a ReDoS seam) across summary/detail/tags/label/files/symbols, newest-first,
  with `scanned` + `truncated` for observability.

Scope matching mirrors `scoreRecord`'s soft-match semantics (a dimension only
excludes when both sides name it and differ). Stale records are included in grep by
default (recent-but-superseded decisions are often exactly what you want); expired
are excluded unless asked for.

The kernel is intentionally pure — like `context-memory-retrieval.ts`, it does **not**
log. Structured logging is a requirement of the *tool-exposure* phase (below), at the
dispatch call-site, so unit tests and the packer stay quiet.

## Remaining Phases

### Phase 1 — surface `detail` in the packer (closes the documented gap) — SHIPPED 2026-06-01

`lib/context-memory-packing.ts` now spends remaining section budget on the top-ranked
record's `detail`, exactly as the parent doc specified. Shipped behind the opt-in
`MemoryPackOptions.includeTopDetail` flag (`detailCap` default 600 chars), with a
summary-only fallback when detail would overflow the section budget so a record is
never dropped for carrying detail. **Off by default** — existing delegation-brief
sizes are unchanged until a caller opts in.

Two policy decisions worth pinning (both surfaced in PR #749 review):

- **Strict top-ranked eligibility.** Only the section's single highest-ranked record
  (rank index 0) may carry detail. If that record lacks `detail` or doesn't fit, no
  lower-ranked record inherits the slot — the contract is unambiguous rather than
  "best available record with detail".
- **Whitespace-preserving truncation.** `detail` is capped via `truncateDetail`, which
  preserves newlines/indentation (unlike `truncateSummary`'s `\s+`→space collapse), so
  command output / diffs / stack traces stay structurally readable. Each physical line
  is emitted as its own packed line to keep char-budget accounting exact.

Covered by six cases in `app/src/lib/context-memory-packing.test.ts` (default-off,
top-ranked-only, top-lacks-detail-no-inherit, whitespace-preservation, custom-cap,
overflow-fallback). The parent doc's "Prompt Packing Model" note is flipped to shipped.

**First consumer wired (2026-06-01):** the **Auditor** opts in on **both surfaces**,
via a single shared override `AUDITOR_MEMORY_PACK_OVERRIDES` (`includeTopDetail` +
`detailCap` `AUDITOR_MEMORY_DETAIL_CAP` = 400) in `lib/role-memory-budgets.ts`:

- Web: `app/src/lib/role-memory-context.ts` applies it on the Auditor's
  runtime-context and completion-evaluation paths.
- CLI: `cli/auditor-gate-memory.ts` (`buildAuditorGateRuntimeContext`) feeds the
  commit gate (`makeAuditorPreCommitGate`), which previously passed an empty runtime
  context — the CLI Auditor now sees the same typed memory the web one does.

The Auditor's SAFE/UNSAFE gate benefits most from the verbatim verification output
(`check.output`) and decision rationale stored in `detail`. Reviewer/Explorer/Coder
stay summary-only for now (breadth over depth). Retrieval is best-effort on both
surfaces — any failure degrades to no context, never blocking the audit/commit.

Measured impact: because the retrieved-memory block is already capped by
`ROLE_MEMORY_SECTION_BUDGETS` (facts 600 / taskMemory 700 / verification 500 /
stale 250 = 2050 chars total), enabling detail can only spend more of that existing
allocation — it never raises the prompt ceiling, and the packer falls back to
summary-only when detail would overflow a section. The visible tradeoff is a richer
top record vs. fewer summary records in the same section. Characterization tests in
`app/src/lib/context-memory-packing.test.ts` assert both (detail surfaced, and every
section stays ≤ its budget).

Remaining follow-through (separate, needs a `ROADMAP.md` entry): decide whether
Coder/Explorer delegation briefs should also opt in once the Auditor's behavior is
observed in production.

### Phase 2 — model-facing `memory_expand` / `memory_grep` tool — SHIPPED 2026-06-01

Read-only tools the model can call mid-turn — the real LCM escape hatch. Landed in one
cross-surface PR:

- **Canonical spec:** new `memory` source + `memory_grep` / `memory_expand` in
  `lib/tool-registry.ts`; `memory:read` capability in `lib/capabilities.ts`, granted to
  **all five roles**.
- **Shared executor:** `lib/memory-tool-exec.ts` (`runMemoryGrep` / `runMemoryExpand`)
  wraps the kernels, formats output, validates model args, and is the single
  integration point both surfaces call.
- **Both surfaces:** web detection (`app/src/lib/memory-tools.ts`) → `tool-dispatch.ts`
  (union/cascade/arg-normalize) → `web-tool-execution-runtime.ts` `case 'memory'`; CLI
  `cli/tools.ts` (`READ_ONLY_TOOLS` + dispatch + protocol doc). Read-only flag means
  they auto-group in the parallel-read batch.
- **Scope is injected from session context, never model args** — repo/branch/chat on
  web, repo/branch via `resolveWorkspaceIdentity` on CLI — so a model can't reach
  another repo's memory. Model args are only `pattern`/`kinds`/`limit` and `ids`.
- **ids exposed in the packer:** `context-memory-packing.ts` now leads each record
  line with `[mem_…]`, so any role seeing a retrieved-memory block can `memory_expand`
  directly (the chosen design for getting ids to the model).
- **Symmetric structured logs:** `memory_grep_hit` ↔ `memory_grep_empty`,
  `memory_expand_hit` ↔ `memory_expand_miss`.
- **Prompt advertising** is matched to executor support (no advertised-but-denied tools):
  web Orchestrator + Explorer (#751), and the CLI Orchestrator + Coder (via
  `TOOL_PROTOCOL`) + Explorer + Deep-Reviewer (via `READ_ONLY_TOOL_PROTOCOL`) — all
  backed by `cli/tools.ts`'s memory-capable `executeToolCall`. The **web Coder** and
  **web Deep-Reviewer** are now wired too (2026-06-01, follow-through part a):
  `buildCoderToolExec` accepts a `memory` source via an injected scope-bound
  `executeMemory`. The **delegated** web Coder threads repo/branch/chat scope through
  the delegation envelope (from both orchestrator handlers); the Deep-Reviewer (whose
  `WebToolExecutionRuntime` exec already routed `memory`) advertises it when a repo
  scope is present. The web Coder still runs `allowedRepo: ''` for GitHub tools by
  design — the threaded scope is memory READ-scope only. The **background coder-job**
  (Worker/DO) is *deliberately not wired*: `getDefaultMemoryStore()` is an in-memory
  singleton populated per-runtime, and a fresh DO isolate starts empty (nothing
  populates it the way the browser session does), so advertising there would be a
  non-functional tool surface — deferred until a Worker-side persistent store exists.
  Advertising is gated to match executor support on every surface. The Auditor is
  single-shot (no tool loop) so it is never advertised — it consumes memory via the
  injected retrieved-memory block (#750). Capability is granted to all five roles and
  the packer surfaces `[mem_…]` ids in every role's memory block regardless. The
  web-executor wiring is ROADMAP-tracked ("LCM follow-through").
- Tests: `lib/memory-tool-exec.test.ts`, `app/src/lib/memory-tools.test.ts`, packer
  id-exposure assertion; drift test (`daemon-integration.test.mjs`) passes with the new
  advertised==callable tools.

### Phase 3 — true verbatim immutable log (the "lossless" part) — SHIPPED 2026-06-21 (Worker backend deferred)

Today `detail` is synthesized and capped (2000 on write `lib/context-memory.ts:45`,
800 on persist `lib/memory-persistence-policy.ts:9`), so even Phases 1–2 return
lossy-ish text for long outputs. Real losslessness needs an append-only raw store.
With Phases 1–2 in production the retrieval seam has earned its keep, so Phase 3 is
now being built — kernel first, wiring after.

**Design.** The verbatim log is a *separate* store from the typed-record store, not
a bigger `detail`. The typed store stays small, ranked, packed, and
freshness-expired; the verbatim log is large, **append-only, never mutated** (the
only mutation is age-based pruning of whole entries), and **content-addressed** so
identical outputs dedup and the same handle can be carried by both a typed
`MemoryRecord` and a reduced tool result. A record points at its full text via the
additive optional `MemoryRecord.verbatimRef` (`lib/runtime-contract.ts`) — the
record stays self-describing when the ref is absent.

This is the missing backing store for **two** consumers, which is why it pays for
itself: (a) lossless `memory_expand`, and (b) the "keep the raw stdout/stderr for the
UI card / session store" half that `lib/tool-output-reducers.ts` already promises but
has nowhere durable to put — a reduced exec result can stamp a `verbatimRef` and the
model can expand it back to the full original.

**Kernel — SHIPPED 2026-06-21.** `lib/verbatim-log.ts` defines the cross-surface
contract (`VerbatimLog`) plus the in-memory backend (default + tests), mirroring the
`ContextMemoryStore` shape (every method `T | Promise<T>`; `getDefaultVerbatimLog` /
`setDefaultVerbatimLog` swap pair). Scope is `repoFullName + branch (+ chatId)` with
the same soft-match semantics as retrieval (new-feature checklist #1). Hashing is
dependency-free FNV-1a + byte length — `lib/` is bundled for the browser and the
Worker where `node:crypto` is unavailable — and `append` is **collision-safe by
construction**: it verifies stored text on a ref hit and probes a disambiguated ref
on a genuine collision, so a hash collision can never return the wrong verbatim text
(the one failure mode a lossless store cannot tolerate). Pure, log-free kernel
(symmetric logs belong at the wiring call-site, per the parent doc); 8 cases in
`lib/verbatim-log.test.ts`.

**Wiring — SHIPPED 2026-06-21.**

1. **CLI file backend** — `cli/verbatim-log-file-store.ts` mirrors
   `cli/context-memory-file-store.ts` (shared `assertSafePathSegment` — now
   exported from the typed store so the traversal guard has one canonical copy —
   serialize-chain, atomic-rewrite) at `<baseDir>/<repo>/<branch>.verbatim.jsonl`
   (default `~/.push/verbatim`, `PUSH_VERBATIM_DIR` override). **Append-only**: no
   `update`/`remove` of historical entries; only `pruneOlderThan` drops whole aged
   entries. Wired through `setDefaultVerbatimLog` in `cli/cli.ts` + `cli/pushd.ts`
   next to `setDefaultMemoryStore`. 7 characterization cases in
   `cli/tests/verbatim-log-file-store.test.mjs`.
2. **Write path** — `persistRecord` (create → stamp → write) in
   `lib/context-memory.ts` stamps `verbatimRef` when `detail` exceeds the cap; all
   four write helpers route through it. Highest-value capture is the Coder's
   `verification_result` (`check.output`, the verbose test/typecheck log the
   Auditor most wants verbatim). Best-effort like `enrichEmbeddings` — a log
   failure degrades to a capped record, never blocks the write — with symmetric
   `verbatim_stamped` ↔ `verbatim_stamp_failed` (stderr, per the CLI stdout rule).
3. **Read path** — `expandMemoryRecords` resolves `verbatimRef` against an
   injected `verbatimLog`, returning the full original (`verbatim: true`); a
   pruned/absent/unreadable entry degrades to the capped detail (the call-site
   logs `verbatim_expand_unresolved`). `memory_expand` (`lib/memory-tool-exec.ts`)
   wires the process log and renders verbatim detail at a far larger cap (12k) with
   an explicit truncation marker + ref.
4. **Reducer raw retention + recall — SHIPPED 2026-06-21.** The "keep the raw
   output" half: when `sandbox_exec` output is reduced, `lib/verbatim-retain.ts`
   stores the full unreduced output (sanitized on web, since recall re-enters the
   model) and the result gets a recall marker. `memory_expand` now accepts verbatim
   `refs` alongside record `ids`, reading the log directly with a cross-repo scope
   guard (`verbatimScopeMatches`). Wired at the CLI exec sites (`cli/tools.ts`, scope
   from `resolveWorkspaceIdentity`) and the web `sandbox_exec` handler
   (`app/src/lib/sandbox-tools.ts`, scope threaded via `SandboxExecutionOptions.memoryScope`).
   Tool registry / protocol docs / web detection updated; drift tests green.
5. **Worker durable backend** — the **only** remaining piece, tracked in **#1063**.
   Deferred because it has no live consumer until a Worker-side durable *typed*-memory
   store exists (the DO doesn't write memory; web writes are browser-side in-memory),
   and it needs a new KV namespace provisioned. The `lib/` contract is live, so the
   Worker implements `VerbatimLog` when that store lands; until then web uses the
   in-memory default (session-lived, same as the typed store there).

Coverage: `lib/verbatim-log.test.ts` (kernel), verbatim resolution +
degrade-on-throw in `lib/context-memory-expand.test.ts`, write-path stamping in
`app/src/lib/context-memory.test.ts`, file backend in
`cli/tests/verbatim-log-file-store.test.mjs`, reducer retention in
`lib/verbatim-retain.test.ts`, and `memory_expand` refs (recall + scope guard) in
`lib/memory-tool-exec.test.ts`. App + CLI typecheck green; full CLI suite (2714)
green including the protocol/daemon drift pins.

## Non-Goals

- Embedding / vector search (the existing doc's non-goal stands).
- A hierarchical summary DAG — Push's freshness model is a deliberate different shape.
- Adopting `openlcm` or any third-party LCM package as a dependency.
- Letting the model *write* memory via tools — retrieval is read-only; the write path
  stays engine-owned (the LCM thesis).

## Recommendation

Land Phase 1 (cheap, closes a documented gap, low blast radius) before Phase 2 (the
tool, higher-value but a cross-surface change with a drift-test obligation). Treat
Phase 3 as conditional on Phases 1–2 demonstrating that verbatim recall changes agent
behavior on long sessions.
