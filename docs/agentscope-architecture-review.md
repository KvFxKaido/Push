# AgentScope Architecture Review

Comparative analysis of [agentscope-ai/agentscope](https://github.com/agentscope-ai/agentscope) against Push's architecture. Focused on what's actually worth borrowing vs. what's noise.

## What AgentScope Actually Is

A Python 3.10+ multi-agent framework from Alibaba's SysML team (~21.6k stars). Core abstraction: ReAct agents with tool calling, coordinated via message hubs or pipelines, with pluggable memory/session/model backends.

**Key modules**: `agent/`, `pipeline/`, `memory/`, `session/`, `model/`, `tool/`, `tracing/`, `mcp/`, `a2a/`, `realtime/`

The framework is async-first, uses abstract base classes for extension points, and keeps orchestration patterns un-opinionated (sequential, fanout, hub-based — all just `await agent(msg)` chains).

## Architecture Comparison

### Routing & Dispatch

| | AgentScope | Push |
|---|---|---|
| **Pattern** | `sequential_pipeline`, `FanoutPipeline`, `MsgHub` — all direct async calls | `tool-dispatch.ts` with read-only parallelization + single trailing mutation rule |
| **Sophistication** | Basic: structured-output or tool-call routing between agents | Higher: turn policies per role, drift detection, empty-completion guards, mutation ordering |
| **Provider routing** | None — model is configured per agent | Hybrid: chat lock + role inheritance + reviewer sticky + auditor fallback |

**Verdict**: Push's dispatch is more sophisticated. AgentScope's routing is workflow control flow, not provider/session routing. Nothing to borrow here.

### Sandbox & Execution

| | AgentScope | Push |
|---|---|---|
| **Isolation** | OS subprocess with timeout (Python/Shell) | Modal containers with HTTP API boundary |
| **Concurrency control** | Timeout only | `workspace_revision` monotonic counter for optimistic concurrency |
| **Capabilities** | Python exec, shell exec | File ops, exec, git ops, diff, search, symbols, references |
| **Safety** | Timeout + temp dir cleanup | Auditor pre-commit gate + workspace revision checks |

**Verdict**: Push's sandbox is significantly more mature. AgentScope's subprocess execution is fine for a framework but isn't production isolation. The one useful idea: AgentScope defines multiple sandbox *classes* (Docker, gVisor, BoxLite, mobile). If Push ever needs to swap Modal for another backend, extracting a `SandboxProvider` interface from `sandbox-client.ts` would be worth doing.

### State & Session Management

| | AgentScope | Push |
|---|---|---|
| **Model** | `StateModule` recursive serialization — serialize agent objects, reconstruct per request | Conversation-as-state — IndexedDB (web), `events.jsonl` (CLI) |
| **Backends** | JSON files, Redis, SQLAlchemy | IndexedDB + localStorage (web), filesystem with 0o600 perms (CLI) |
| **Session identity** | `session_id` + `user_id` | `sess_{timestamp}_{hex}` with branch scoping |
| **Resume** | Load state dict → reconstruct agent | Checkpoint markers + crash recovery via `run.json` |

**Verdict**: Different problems, different solutions. AgentScope serializes Python objects because Python agents are stateful long-lived objects. Push's agents are functional (messages in, tool calls out) — the conversation *is* the state. Push's approach is better for mobile/web where process lifecycle is unpredictable. Don't adopt StateModule patterns.

### Tracing & Observability

| | AgentScope | Push |
|---|---|---|
| **Standard** | OpenTelemetry with OTLP HTTP exporter, BatchSpanProcessor | Ad-hoc in-memory metrics + `X-Push-Request-Id` propagation |
| **Scope** | Agent reply spans, tool execution spans, formatter spans | Context compression metrics, tool call failure metrics, edit metrics |
| **Export** | Jaeger, Datadog, Phoenix, Langfuse, AgentScope Studio | None (in-memory only) |

**Verdict**: This is the clearest gap in Push. AgentScope's OTel integration is real and clean. Push already propagates request IDs through Worker → Provider → Sandbox — that's the hard part. Adding OTel spans on top would give structured observability without inventing bespoke formats.

### Agent Architecture

| | AgentScope | Push |
|---|---|---|
| **Agent model** | Generic base class, extend via subclass. ReAct is one implementation. | 5 locked roles with fixed responsibilities and dedicated turn policies |
| **Composition** | Wire agents together however you want | Delegation protocol with structured envelopes (task, intent, deliverable, criteria) |
| **Safety** | No built-in safety gate | Auditor role: binary SAFE/UNSAFE pre-commit verdict |
| **Read-only enforcement** | None | Explorer mutation blocklist in turn policy |

**Verdict**: Push's role system is purpose-built for a coding agent product. AgentScope's is purpose-built for a general framework. Different design goals, neither is wrong.

## Recommendations

### Borrow

#### 1. OpenTelemetry Tracing (High value, medium effort)

Replace in-memory metrics (`context-metrics.ts`, `tool-call-metrics.ts`, `edit-metrics.ts`) with OTel spans. Push already has the hard prerequisite — request ID propagation across the full stack.

**Concrete approach**:
- Add `@opentelemetry/api` + `@opentelemetry/sdk-trace-web` (or `-node` for CLI)
- Wrap key boundaries: model calls, tool dispatch, sandbox requests, delegation
- Export via OTLP to any compatible backend
- Keep `X-Push-Request-Id` as the trace/span correlation ID

**What this unlocks**: Latency flamegraphs across the full Orchestrator → Coder → Sandbox chain. Tool failure rates with real context. Provider comparison data.

#### 2. Sandbox Provider Interface (Low effort, future-proofing)

Extract a `SandboxProvider` interface from `sandbox-client.ts`:

```typescript
interface SandboxProvider {
  create(config: SandboxConfig): Promise<SandboxSession>
  exec(session: SandboxSession, command: string, opts?: ExecOpts): Promise<ExecResult>
  readFile(session: SandboxSession, path: string): Promise<FileReadResult>
  writeFile(session: SandboxSession, path: string, content: string): Promise<void>
  getDiff(session: SandboxSession): Promise<DiffResult>
  cleanup(session: SandboxSession): Promise<void>
}
```

Current `sandbox-client.ts` becomes `ModalSandboxProvider`. No behavior change, just makes the coupling explicit and swappable.

#### 3. Server-Side Agent Loop Pattern (Design only, no code yet)

AgentScope Runtime's "request → load state → run agent → persist → respond" shape is the right model if Push ever needs server-driven orchestration (background tasks, mobile battery optimization, webhook-triggered runs). Worth keeping in mind for the daemon/pushd direction.

### Skip

| Idea | Why |
|---|---|
| StateModule / object serialization | Push agents are functional, not stateful objects |
| Adapter pattern for framework interop | Push is a product, not a framework |
| Pipeline/workflow abstractions | Turn policies are more rigorous for Push's needs |
| A2A protocol | No federation use case |
| Memory system (working + long-term) | Push's context management (summarize > drop, pin first message) is better tuned |
| RL / finetuning integration | Different problem space |
| MsgHub multi-agent broadcast | Push's delegation protocol with structured envelopes is more controlled |

## Summary

AgentScope is a well-factored general-purpose Python agent framework. The overlap with Push is smaller than it appears — Push is a product with specific execution semantics, not a framework trying to support arbitrary agent patterns.

**One clear win**: OTel tracing.
**One good hygiene move**: Sandbox interface extraction.
**One design pattern to file away**: Server-side agent loop for future pushd work.
**Everything else**: Either already present in Push (often in a more sophisticated form) or doesn't fit the architecture.
