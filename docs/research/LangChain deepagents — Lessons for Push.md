# LangChain deepagents — Lessons for Push

Status: Reference (research snapshot, 2026-07-02)
Source: `langchain-ai/deepagents` (v0.6.x, ~25k stars) — README, `graph.py`
assembly, and the `middleware/` package (`summarization.py`,
`_message_eviction.py`, `subagents.py`, `filesystem.py`, `skills.py`),
cross-read against Push's `lib/` runtime.

## Why this doc exists

deepagents is LangChain's "batteries-included agent harness": a LangGraph
agent assembled from a middleware stack that bundles a `write_todos` planning
tool, subagent delegation with isolated context, a pluggable-backend
filesystem, conversation summarization, tool-output offloading, skills,
memory, shell, and prompt caching. It is the most popular open artifact of
the same design space Push's `lib/` runtime occupies, so it's worth the same
treatment the AI SDK got in
[`Push as an Agent SDK — AI SDK Feature Map.md`](Push%20as%20an%20Agent%20SDK%20—%20AI%20SDK%20Feature%20Map.md):
map their surface onto ours, name what validates Push's theses, and extract
the handful of mechanisms genuinely worth borrowing.

Same disclaimer as that doc: this is a *concept* map, not a dependency
proposal. Adopting deepagents (or LangGraph) would replace the provider seam
and the governed tool protocol — the load-bearing layers. The value is in
their context-engineering mechanics, which are independently reimplementable.

## The map

| deepagents feature | Push equivalent | State |
|---|---|---|
| **`write_todos`** (TodoListMiddleware) — flat todo list, re-injected each turn | `todo_write`/`todo_read`/`todo_clear` (`lib/todo-tools.ts`), `[TODO]` block per turn — same Claude Code convention, plus caps and one-`in_progress` enforcement | ✅ Have it. Push additionally has the dependency-aware DAG (`plan_tasks` → `lib/task-graph.ts`) with goal-alignment validation (`addresses`), cascade failure, and the Todo-Enforcer retry loop — deepagents has no graph equivalent. |
| **`task` tool / SubAgentMiddleware** — declarative subagents, isolated context, inherit parent tools/permissions unless overridden; default general-purpose subagent auto-added | `delegate_coder` / `delegate_explorer`, role kernels (`lib/coder-agent.ts`, `lib/explorer-agent.ts`), handoff via `buildDelegationBrief` (`lib/delegation-brief.ts`), structured `DelegationOutcome` back | ✅ Have it, different shape. Push's brief is *curated* (goal, addresses, capabilities, acceptance checks) where deepagents passes a bare task string; Push's return contract is typed and distilled forward into later tasks' `knownContext`. Roles are locked by design, not free-form. |
| **AsyncSubAgentMiddleware** — background subagent execution | Background coder jobs (`app/src/worker/coder-job-do.ts`) with checkpoint/resume | ✅ Have it, deeper (durable, resumable). |
| **FilesystemMiddleware + pluggable backends** (StateBackend virtual FS / local / sandbox / store) — `ls`, `read_file`, `write_file`, `edit_file`, `glob`, `grep` | `lib/sandbox-provider.ts` (CF/Modal), real sandbox FS + hashline edits; CLI has the real machine | ✅ Have it, deeper on execution. One idea Push lacks: a *virtual* scratch FS in conversation state that exists before/without a sandbox — deepagents leans on it for skills, memory, and offloading. See takeaway 2. |
| **Tool-result eviction** — oversized tool results written to `{prefix}/{tool_call_id}` on the FS; placeholder keeps a head+tail preview and tells the model to `read_file` with offset/limit | `lib/tool-output-reducers.ts` (command-aware reduction) + verbatim retain (`lib/verbatim-retain.ts` / `verbatim-log.ts`) with `memory_expand refs=[…]` recall | ✅ Have it (LCM Phase 3). Differences worth stealing: their placeholder carries a **head+tail preview**, and retrieval is **incremental** (offset/limit) through a tool the model already uses. `memory_expand` is all-or-nothing recall via a bespoke tool. See takeaway 3. |
| **SummarizationMiddleware** — fraction-of-window trigger (0.85/keep 0.10); evicted messages appended to `/conversation_history/{thread_id}.md`; the summary embeds that path so the model can re-read its own past | Sync heuristic compaction (`lib/message-context-manager.ts`) + async LLM compaction (`lib/llm-compaction.ts`, Memento-style handoff summary), lossless (`visibleToModel: false`, durable transcript preserved) | ◐ Push keeps the raw history but the **model has no recall path to it** — compacted spans are auditable by humans, not reopenable by the agent. deepagents closes that loop. See takeaway 1. |
| **Pre-summarization clipping** — before compacting, clip large tool *arguments* in old messages (e.g. stale `write_file` bodies) at a lower threshold; often reclaims enough to skip summarization entirely | Reducers act on tool *outputs* at ingestion; nothing revisits old tool **arguments** | ⚠️ Gap, cheap win. A stale `write_file`/`edit` body deep in history is pure dead weight — the file state is in the sandbox. See takeaway 4. |
| **`ContextOverflowError` fallback** — if the provider throws overflow despite predictions, summarize immediately and retry the call | Push predicts (token estimation in `manageContext`) but a provider-side overflow error surfaces as a failed turn | ⚠️ Gap, hardening. Reactive catch → compact → retry is a complementary backstop to prediction. See takeaway 5. |
| **Inline-media offloading** — base64 `data:` URLs in history are extracted, hashed, stored on the backend, replaced with `<image url="…"/>` tags; the summary prompt is told to preserve refs, not describe pixels | No equivalent in the compaction path | ◐ Low urgency (Push conversations are code-heavy, not image-heavy), but the failure mode — base64 blobs surviving into a compaction prompt — is real once screenshots/artifacts enter chats. |
| **SkillsMiddleware** — skills live on the FS backend, loaded on demand | `cli/skill-loader.ts` (`.push/skills`, `.claude/commands`), lazy prompt-body loading, capability/platform gating. **CLI-only**; no web loader | ◐ Known gap (also flagged in the AI SDK map). deepagents' framing suggests the natural web implementation: read `.push/skills/*.md` from the repo sandbox once it's warm — the backend already exists. |
| **AnthropicPromptCachingMiddleware** (+ Bedrock variant) — unconditional, no-ops on other providers | `EPHEMERAL_CACHE_CONTROL` + rolling breakpoints (`lib/provider-contract.ts`, `anthropic-bridge.ts`); the whole context transformer is append-only *for* prefix stability | ✅ Have it, deeper — cache stability is a design invariant of the pipeline, not a bolt-on middleware. |
| **PatchToolCallsMiddleware** — repair malformed tool calls | JSON repair in `lib/tool-dispatch.ts` + reasoning-channel recovery nudges (`lib/tool-call-recovery.ts`) | ✅ Have it. |
| **Permissions → interrupts** — declarative filesystem permission rules auto-generate human-approval interrupt configs per tool | `lib/approval-gates.ts` + capability ledger + Auditor delivery gates | ✅ Have it, deeper (fail-closed delivery gates, per-turn side-effect budget). Their one nice pattern: approval config *derived from* the permission declaration rather than maintained in parallel. |
| **Middleware stack + harness profiles** — user middleware inserted mid-stack; profiles exclude tools/middleware; FS + subagent middleware protected | Seam-based composition: DI injection slots in role kernels, `createToolDispatcher` factory, `ToolExecutionRuntime` adapter, tool hooks | ✅ Deliberate divergence. Middleware-as-API is a framework's need (users extend without forking). Push is a product; seams stay internal. Confirms rather than changes the AI SDK map's gap #2 (no single named facade). |
| **Trust-the-LLM security model** — enforce at the tool/sandbox boundary, never via model self-restraint | "Behavior lives in code, not prompts" ([`CLAUDE.md`](../../CLAUDE.md)), git policy blocks, remote-mutation blocks, Gate-at-Push | ✅ Same thesis, independently arrived at. Validation, not news. |

## What's worth borrowing (ranked)

1. **A model-facing recall path for compacted history.** deepagents' summary
   message embeds `/conversation_history/{thread_id}.md`; the agent can reopen
   its own evicted past with `read_file`. Push keeps the compacted span in the
   durable transcript (`visibleToModel: false`) — lossless for *audit*, but
   not model-readable: the compaction path never appends the span to the
   verbatim log (its only appenders today are reduced tool outputs via
   `lib/verbatim-retain.ts` and oversized memory details in
   `lib/context-memory.ts`), so there is no `memory_expand` ref to hand the
   model. The follow-up is to persist the span into a model-readable store at
   compaction time — appending to the verbatim log and embedding the returned
   ref in the compaction summary is the natural fit — or to expose an explicit
   read path over the durable transcript. Still the cheapest meaningful
   upgrade here, because LCM already built the log, the ref scheme, and the
   recall tool; only the compaction-time append and the summary affordance
   are missing.

2. **Retrieval through existing file tools, incrementally.** Their evicted
   tool results are plain files read back with `offset`/`limit` — no bespoke
   recall tool, no all-or-nothing expansion. `memory_expand` re-injects entire
   verbatim entries; a multi-thousand-line build log recalled whole defeats
   the reduction that evicted it. Either teach `memory_expand` range
   parameters or (CLI/daemon, where a real FS exists) write large evictions
   to a scratch path and let `read_file` do the paging.

3. **Head+tail preview in eviction placeholders.** Five lines from each end
   plus a truncation marker lets the model decide *whether* recall is worth
   it without paying for it. Push's command-aware reducers already keep the
   informative parts for known commands; the preview pattern is the fallback
   for the unknown-command path where reduction is blunter.

4. **Pre-compaction clipping of stale tool arguments.** Old `write_file` /
   hashline-edit bodies deep in the transcript duplicate state that lives in
   the sandbox. Clipping them at a lower threshold *before* triggering full
   compaction often avoids the compaction (and the cache-prefix invalidation
   it costs) entirely. Fits naturally as a pre-pass in
   `lib/message-context-manager.ts`, subject to the same append-only purity
   rules as the rest of `lib/context-transformer.ts`.

5. **Reactive overflow fallback.** Catch the provider's context-overflow
   error, compact, retry the same call — instead of surfacing a failed turn
   when token estimation undershoots (estimation *will* undershoot on
   providers with unpublished tokenizers). Pairs with, doesn't replace, the
   predictive path.

6. **Web-surface skills via the sandbox backend.** Not a new gap, but
   deepagents' "skills are just files on the backend" framing points at the
   minimal implementation: the web surface already re-reads project
   instructions from the sandbox once warm; `.push/skills/*.md` can ride the
   same path with `cli/skill-loader.ts`'s parser promoted to `lib/`.

## What not to borrow

- **The middleware architecture itself.** It exists so third parties can
  extend the harness without forking — a framework requirement Push doesn't
  have. Push's seams (kernel DI slots, dispatcher factory, runtime adapter)
  are internal and should stay that way until the SDK-facade question (AI SDK
  map, gap #2) is decided on its own merits.
- **The virtual FS as a general mechanism.** deepagents needs a state-backed
  fake filesystem because many deployments have no real one. Push always has
  a real sandbox or a real machine; the only borrowable slice is using it as
  the eviction/offload target (takeaways 1–2), not as a tool surface.
- **Anything as a dependency.** LangGraph sits exactly where
  `lib/provider-contract.ts`, the tool protocol, and the round loop sit.
  Same conclusion as every prior harness review.

## Where Push is already ahead

Same shape as the AI SDK comparison — deepagents is a library that trusts its
caller; Push is a governed runtime:

- **Delivery governance**: Gate-at-Push, fail-closed Auditor gates, Protect
  Main, per-turn side-effect budget, git/remote-mutation policy blocks.
  deepagents' equivalent is `interrupt_on` (ask a human) — consent, not
  governance.
- **Planning depth**: their `write_todos` is Push's `todo_write`; there is no
  analog to the validated task graph (goal-alignment rejection, cascade
  failure, completion-retry enforcement).
- **Delegation contract**: typed `DelegationOutcome` with checks/evidence/
  missing-requirements, distilled forward into dependent tasks — vs. a
  subagent's final string.
- **Text-dispatch protocol**: deepagents requires native tool calling; Push's
  fenced-JSON path plus native calls keeps non-native models first-class.
- **Cache discipline**: prefix stability as a pipeline invariant
  (append-only transformer, small-win passthrough in reducers) vs. a
  cache-control middleware at the tail of the stack.
