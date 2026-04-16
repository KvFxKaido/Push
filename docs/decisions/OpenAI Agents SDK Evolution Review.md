# OpenAI Agents SDK Evolution Review

**Date:** 2026-04-16
**Source:** [The next evolution of the Agents SDK | OpenAI](https://openai.com/index/the-next-evolution-of-the-agents-sdk/) (Apr 15, 2026)
**Related:** `External Resource Review — Harness Engineering and Ralph Loop.md`, `Vercel Open Agents Review.md`, `Modal Sandbox Snapshots Design.md`, `Copilot SDK Research.md`
**Status:** Comparative research reference. No headline new adoption targets — this update validates work already in-flight and confirms the industry is converging on the same architecture Push uses.

---

## 1. What changed

OpenAI's Apr 15 2026 announcement adds two major capabilities to the open-source Agents SDK (`openai-agents-python`):

1. **Native sandbox execution** — first-party sandbox integration with a provider-agnostic abstraction layer.
2. **Model-native harness** — the control plane around the model now ships as a composable runtime with configurable memory, approvals, tracing, handoffs, resume/rehydration, and file system tools baked in.

Python first; TypeScript planned but not shipped.

## 2. Architecture — harness / sandbox separation

The core architectural claim: **the harness and the sandbox are separate layers that can run on the same machine or independently.**

| Layer | Owns | Push analog |
|---|---|---|
| **Harness** (control plane) | Agent loop, model calls, tool routing, handoffs, approvals, tracing, recovery, run state | Worker + client-side journal + role system (Orchestrator/Explorer/Coder/Reviewer/Auditor) |
| **Sandbox** (compute plane) | Files, commands, packages, artifacts, isolation | Modal containers (`sandbox/app.py`) |

This is exactly Push's three-layer topology (Web → Agent workflow → Sandbox VM) confirmed by an independent team. The harness runs outside the sandbox and interacts with it through tool calls — same shape as our agent-outside-sandbox model documented in `docs/architecture.md`.

**Verdict:** Validates our architecture. No change needed.

## 3. New features — detail and Push mapping

### 3.1 Manifest abstraction

A `Manifest` object describes the workspace portably: files to seed, environment variables, dependencies. The manifest is provider-agnostic — the same manifest works against any sandbox backend.

```python
from agents.sandbox import Manifest, SandboxAgent, SandboxRunConfig
from agents.sandbox.entries import File
from agents.sandbox.capabilities import Shell

manifest = Manifest(entries=[File(path="main.py", content="...")])
agent = SandboxAgent(name="coder", model="gpt-5", capabilities=[Shell()])
```

**Push status:** We don't have a formal manifest abstraction. Our sandbox init is imperative — `sandbox/app.py:create()` clones a repo, probes the environment, and writes tokens. The workspace shape is implicit in the create flow, not declared as a portable object.

**Worth adopting?** Medium priority. A manifest-like declaration would help if we ever add a second sandbox provider (e.g., Cloudflare Workers for lighter workloads). Not urgent while Modal is the only backend. If we implement the `SandboxProvider` interface recommended in `AgentScope Architecture Review.md`, the manifest becomes the natural input to `SandboxProvider.create()`.

### 3.2 Multi-provider sandbox support

The SDK integrates with: **Blaxel, Cloudflare, Daytona, E2B, Modal, Runloop, Vercel**. Developers choose their sandbox backend; the harness doesn't care.

Also supports mounting external storage: **AWS S3, Google Cloud Storage, Azure Blob Storage, Cloudflare R2**.

**Push status:** Modal-only today. The `AgentScope Architecture Review.md` already recommended extracting a `SandboxProvider` interface to decouple sandbox management from the Modal-specific code in `sandbox/app.py`. This OpenAI release confirms the industry is moving toward provider-agnostic sandbox abstractions.

**Worth adopting?** Already planned via the SandboxProvider extraction. This validates the direction but doesn't change our roadmap.

### 3.3 Snapshotting and rehydration

Built-in support for snapshotting a container's filesystem and spinning it back up later in the same state. Enables durable, long-running agents that survive process restarts and environment changes.

**Push status:** This is literally the `Modal Sandbox Snapshots Design.md` we wrote two days ago. Same problem (container dies after timeout, resume pays full clone-and-warm cost), same solution (filesystem snapshots keyed by workspace identity), same non-goals (no process memory capture). Phase 0 spike is in progress.

**Worth adopting?** Already in-flight. The OpenAI release confirms this is table stakes for production agent platforms, which increases confidence in the design. No design changes needed — our approach is compatible since Modal is one of their listed providers.

### 3.4 Approvals / human-in-the-loop

When a tool call requires approval, the SDK pauses the run, returns interruptions, and lets you resume from the same `RunState`. The model decides an action is needed; the harness pauses until the user approves or rejects.

**Push status:** We have this at two levels:
- **Tool-level:** `app/src/lib/tool-dispatch.ts` gates destructive tools (git push, file delete) behind user confirmation.
- **Role-level:** Auditor acts as a pre-commit approval gate.
- **Resumable:** `Resumable Sessions Design.md` handles mid-turn interruption and replay.

**Worth adopting?** Already covered. Our implementation is more sophisticated (role-based gating, not just tool-level).

### 3.5 Durable execution integrations (Temporal, Restate)

The SDK offers first-party integrations with **Temporal** and **Restate** for durable orchestration — surviving long waits, retries, and process restarts.

**Push status:** We identified this gap in `Vercel Open Agents Review.md` §5.4 as "server-side durable runs / stream reconnection." Our current approach is client-side checkpoints via the run journal, which is fragile on mobile Safari. The Vercel review recommended building this on Cloudflare Workflows / Durable Objects rather than adopting a third-party orchestrator.

**Worth adopting?** The *pattern* matters; the specific integrations (Temporal/Restate) don't — they'd add infrastructure dependencies we don't need. Our plan to build durability on Cloudflare primitives (already in our stack) is the right call. This validates the priority but doesn't change the approach.

### 3.6 Configurable memory

The harness includes configurable memory for agents — the ability to persist and retrieve context across turns and sessions.

**Push status:** `Context Memory and Retrieval Architecture.md` covers this. We have session-scoped context (conversation history + journal) and cross-session context (CLAUDE.md, repo-level docs). The gap is structured retrieval (embedding-based lookup across prior sessions), which is on the roadmap but not yet built.

**Worth adopting?** Already planned. Monitor OpenAI's specific implementation when the Python SDK ships to see if their memory abstraction offers patterns worth stealing.

### 3.7 Enhanced tracing

Built-in tracing collects LLM generations, tool calls, handoffs, guardrails, and custom events. Feeds into OpenAI's evaluation, fine-tuning, and distillation pipeline.

**Push status:** We have correlation-context tracing (`CorrelationContext Contract.md`) and the run journal captures tool calls, but we don't have structured trace export for external analysis. The `AgentScope Architecture Review.md` recommended adopting OpenTelemetry tracing patterns.

**Worth adopting?** The OpenTelemetry direction from the AgentScope review is the right abstraction — vendor-neutral rather than OpenAI-specific. This validates the priority of structured tracing but we should build on OTel, not OpenAI's format.

## 4. What's genuinely new vs. already covered

| Feature | Already in Push? | Already planned? | New signal? |
|---|---|---|---|
| Harness/sandbox separation | Yes | — | Validates architecture |
| Manifest abstraction | No | Partially (SandboxProvider interface) | Confirms direction |
| Multi-provider sandboxes | No (Modal only) | Yes (SandboxProvider extraction) | Confirms direction |
| Snapshotting/rehydration | No | Yes (Modal Snapshots Design, Phase 0) | Confirms priority |
| Approvals/HITL | Yes | — | No new signal |
| Durable execution | No | Yes (Cloudflare-native, Vercel review §5.4) | Confirms priority |
| Configurable memory | Partial | Yes (Context Memory arch doc) | Minor |
| Structured tracing | Partial | Yes (OTel direction) | Confirms priority |

## 5. Actionable takeaways

**No new work items.** This release validates decisions already made:

1. **Modal Sandbox Snapshots** (Phase 0 spike) — confirmed as industry table stakes. Increase confidence, don't change design. The fact that Modal is one of OpenAI's listed providers means the snapshot API we're exploring is the same one they've validated.

2. **SandboxProvider interface extraction** — the manifest/provider abstraction in the OpenAI SDK is exactly the shape recommended in `AgentScope Architecture Review.md`. When we extract the interface, model `Manifest` as the input type to `SandboxProvider.create()`.

3. **Server-side durability on Cloudflare** — confirmed as important by OpenAI's Temporal/Restate integrations. Stay on the Cloudflare-native path (Durable Objects / Workflows) per the Vercel review recommendation. Don't adopt Temporal/Restate.

4. **OpenTelemetry tracing** — confirmed by OpenAI's tracing investment. Build on OTel, not their vendor-specific format.

**One thing to watch:** The `SandboxAgent` + `Manifest` + `SandboxRunConfig` API shape is clean and worth studying when the Python SDK stabilizes. If our SandboxProvider extraction hasn't started by then, use their API as a reference for the interface design.

## 6. Bottom line

This is a "the industry is converging on where we already are" release. The harness/sandbox separation, snapshotting, durable execution, and provider-agnostic sandbox abstraction are all things Push either already has or has actively designed. The main value of this announcement is external validation — it increases confidence in the Modal Snapshots design, the SandboxProvider extraction, and the Cloudflare durability plan. No course corrections needed.
