# opencode SDK Review

Status: Reference, added 2026-05-30 — comparative review, no implementation commitment (graduation needs a `ROADMAP.md` entry)
Origin: [Web and CLI Runtime Contract](Web%20and%20CLI%20Runtime%20Contract.md), [Remote Sessions via pushd Relay](Remote%20Sessions%20via%20pushd%20Relay.md), [push-runtime-v2](push-runtime-v2.md)

Comparative analysis of the [opencode Go SDK](https://github.com/anomalyco/opencode-sdk-go) and the opencode server contract it wraps, against Push's runtime/protocol surface. This is a contract-shape review, not a feature wishlist — opencode's deployment model (a local `opencode serve` daemon as the center of gravity) is **not** a fit for Push's Cloudflare-Worker + remote-sandbox + multi-surface design, so the borrows here are about the *contract*, not the topology.

## What opencode's SDK Actually Is

opencode runs a **headless server** (`opencode serve`) that exposes a full REST + SSE API. The TUI, the web client, *and* the language SDKs (Go, JS, Python) are all clients of that one HTTP contract. The Go SDK is **Stainless-generated from an OpenAPI spec** — nobody hand-writes the types. Its shape:

- **`Session`** as the primary resource with a rich lifecycle: `New`/`List`/`Get`/`Update`/`Delete`, plus `abort`, `init`, `children`, `revert`/`unrevert`, `share`/`unshare`, `summarize`, `prompt`, `command`, `shell`, and `permissions/{permissionID}/respond`.
- A typed message **"parts" model**: `TextPart`, `ReasoningPart`, `ToolPart`, `AgentPart`, `FilePart`, `StepStartPart`/`StepFinishPart`, with explicit `ToolStatePending` → `ToolStateRunning` → `ToolStateCompleted` → `ToolStateError`.
- **One unified event stream**: `GET /event` (SSE via `packages/ssestream`) carries *all* events — not a per-provider stream.
- **`Find` / `File` / `Config` / `Agent` / `Command` / `Project` / `Path`** as flat read resources.
- **`TUI` remote control**: `append-prompt`, `submit-prompt`, `execute-command`, `show-toast`, `open-models`, … the terminal UI is drivable over HTTP.
- Forward-compat by construction: value-type response fields + an `ExtraFields` map + `.IsMissing()`/`.IsNull()` accessors. The `Field[T]` request wrapper distinguishes omitted from zero-valued.

## Where Push Stands Today

Push's programmatic surface is **deliberately internal**. The Cloudflare Worker (`app/worker.ts`) exposes `/api/{provider}/chat` (model proxying), `/api/sandbox/*`, artifacts/library, and GitHub-app routes — but **no session REST API**. Sessions exist two incompatible ways: the CLI daemon's NDJSON-over-Unix-socket (`cli/daemon-client.ts`, `cli/session-store.ts`) and browser-local React state on web.

What Push *does* have, and what makes this review actionable rather than aspirational, is a real wire contract already factored into `lib/`:

- **A version-pinned envelope.** `PROTOCOL_VERSION = 'push.runtime.v1'` (`lib/protocol-schema.ts:73`). Envelope shape `{ v, kind, sessionId, runId?, seq, ts, type, payload }`, defined canonically by `SessionEvent` in `cli/session-store.ts` and validated by `validateEventEnvelope` (`lib/protocol-schema.ts:144`).
- **Hand-rolled, zero-dep validators**, permissive about extra fields by design (the same forward-compat instinct as opencode's `ExtraFields`). `RunEventInput` in `lib/runtime-contract.ts` is the source of truth for event shapes; `SCHEMA_VALIDATED_EVENT_TYPES` (`lib/protocol-schema.ts:1039`) pins ~25 of them.
- **Drift detectors as the contract guard.** `cli/tests/protocol-drift.test.mjs`, `cli/tests/protocol-schema.test.mjs`, and `cli/tests/daemon-integration.test.mjs` re-extract literals from the contract source so any new variant breaks both surfaces' tests in lockstep. This is the AGENTS.md "one source of truth per vocabulary + drift-detector test in the same PR" guardrail.
- **Seq-based replay.** The relay already buffers events and replays from a client-supplied `lastSeq` (`RelayAttachEnvelope.lastSeq`, `lib/protocol-schema.ts:1155`; ring buffer in `app/src/worker/relay-routes.ts`).
- **A precedent for extending — not forking — the vocabulary.** The relay-control envelopes (`relay_attach`, `relay_phone_allow`, …) reuse `v: 'push.runtime.v1'` rather than inventing a second relay vocabulary, per the Remote Sessions doc's explicit implementation rule.

So Push is not missing a *contract*. It is missing a **published, language-agnostic description of the contract it already enforces in TypeScript**, and a single front door to consume it.

## Architecture Comparison

### Contract description

| | opencode | Push |
|---|---|---|
| **Source of truth** | OpenAPI spec → Stainless-generated SDKs | TypeScript validators in `lib/protocol-schema.ts` + `RunEventInput` union |
| **Drift protection** | Regeneration from spec | Literal-extraction drift tests (`cli/tests/protocol-*.test.mjs`) |
| **Forward-compat** | `ExtraFields` map, value-type fields | "permissive about extra fields" validators (same instinct) |
| **Multi-language clients** | Free (Go/JS/Python from one spec) | None — contract is TS-only, not consumable off-surface |

**Verdict**: Push's drift tests solve the *same* problem Stainless solves by construction, but only for in-repo TS consumers. A canonical machine-readable spec (OpenAPI for the request/response handlers, JSON-Schema for the `push.runtime.v1` event envelope + payload union) would turn the drift tests into spec-conformance checks and unlock generated clients without committing to opencode's server topology. This is the one borrow with no architectural downside.

### Session as an addressable resource

| | opencode | Push |
|---|---|---|
| **Lifecycle verbs** | `abort`, `init`, `revert`/`unrevert`, `summarize`, `share`, `children` | branch ops (`create_branch`/`switch_branch`), compaction, coder checkpoints — all *internal*, not addressable verbs |
| **Sub-agents** | `GET /session/{id}/children` — delegated runs are child sessions | `DelegationOutcome` payload (`lib/runtime-contract.ts`) — not an addressable session |
| **Rollback** | `revert`/`unrevert` as session verbs | coder checkpoint/resume inside `app/src/worker/coder-job-do.ts` — internal DO state |
| **Compaction** | `summarize` verb | `context.compaction` event + tiers (`lib/compaction-tiers.ts`) — internal |

**Verdict**: Several things Push already does informally map cleanly onto opencode's session verbs. `children` ≈ Push's subagent delegation (worth modeling delegated Coder/Explorer runs as addressable child sessions rather than opaque outcome payloads); `revert`/`unrevert` ≈ the coder checkpoint machinery; `summarize` ≈ compaction. None of these need adopting today, but they're the natural verb vocabulary if/when a session API is ever exposed — worth pinning the names now to avoid a third spelling later.

### Permissions as a request/respond resource

| | opencode | Push |
|---|---|---|
| **Shape** | `POST /session/{id}/permissions/{permissionID}` → `respond()` | `approval_required` / `approval_received` events (`lib/protocol-schema.ts:857,902`) + per-surface approval UX |
| **Identity** | `permissionID` round-trips request → response | `approvalId` already round-trips request → decision |
| **Surfaces** | One HTTP round-trip, any client | Modal/sheet on web, socket-RPC prompt on CLI (intentionally divergent UX per the Runtime Contract doc) |

**Verdict**: Push **already has** the request/respond shape — `approval_required` carries `approvalId` + `options[]`, `approval_received` carries the matching `approvalId` + `decision`. opencode formalizes it as an addressable resource; Push models it as a paired event. The Push shape is fine and the divergent approval *UX* is an explicit decision (Runtime Contract doc, "Approval UX may diverge"). No change needed — noting it because it's a case where Push is *ahead*, and any future spec should treat the approval pair as a first-class request/response, not just two more broadcast events.

### Unified event stream

| | opencode | Push |
|---|---|---|
| **Endpoint** | One `GET /event` SSE for everything | Three paths: provider SSE (`lib/openai-sse-pump.ts`), daemon NDJSON broadcast, relay ring-buffer |
| **Replay** | (n/a in the read model) | `lastSeq` replay already implemented in the relay |
| **Public** | Yes, the SDK's primary stream | No — events broadcast to socket/WS clients, never an HTTP stream |

**Verdict**: Push has the *hard* parts opencode's stream lacks — monotonic `seq`, `ts`, and gap-aware replay — but they're locked inside the experimental relay DO and not unified with the provider SSE path. If a public stream is ever wanted, the existing `push.runtime.v1` envelope + `lastSeq` is already the right primitive; the work is consolidation and exposure, not design.

### The message "parts" model

| | opencode | Push |
|---|---|---|
| **Message shape** | Typed parts (`TextPart`, `ToolPart`, `ReasoningPart`, …) with explicit `ToolState*` lifecycle | Run events (`tool.execution_start`/`_complete`) track tool lifecycle; the *message* is not a typed part list |
| **Reconstruction** | Replay parts → rebuild transcript deterministically | Reconstruct from event stream + surface-local state |

**Verdict**: opencode's `ToolStatePending/Running/Completed/Error` as first-class message parts makes transcript reconstruction and resume trivial — directly relevant to Push's coder-job checkpoint/resume path (`app/src/worker/coder-job-do.ts`). Push's equivalent lifecycle lives in *events*, not in the persisted message. This is the borrow most likely to pay off if the resumable-sessions surface grows, but it's the heaviest to adopt and shouldn't be chased speculatively.

## What's Worth Borrowing

1. **Publish a machine-readable description of `push.runtime.v1`.** A JSON-Schema for the event envelope + payload union (and, secondarily, an OpenAPI doc for the Worker's existing handlers). This is additive, topology-neutral, and converts the drift tests from "TS matches TS" into "runtime matches spec." Highest leverage, lowest risk.
2. **Pin the session-verb and child-session vocabulary now**, even if unimplemented — `abort`/`revert`/`summarize`/`children` — so a future session API doesn't invent a third spelling for things Push already does internally.
3. **Treat the approval pair as a first-class request/response in any spec**, not two unrelated broadcast events — Push is already shaped for this (`approvalId` round-trip).

## What's Not Worth Borrowing

- **The headless-server topology.** opencode's `serve` daemon as the single center of gravity is exactly the "Web-as-daemon-client" Phase 7 that `push-runtime-v2.md` and the Runtime Contract doc explicitly hold out of scope. Push's two-binding kernel pattern (kernel in `lib/`, shell DI in `app/` and `cli/`) is load-bearing architecture, not a transition artifact. Don't flatten it to match opencode's flat client/server split.
- **Stainless itself / SDK-as-product.** Generating and publishing Go/Python clients is premature — Push has no external API consumers. The *spec* is the deliverable; generated clients are a downstream option, not a goal.
- **`TUI` remote-control endpoints as a model.** Push's Local PC / relay pairing already carries control intent over the WS envelope; a parallel HTTP `/tui/*` surface would be a second control plane, not a simplification.
- **Flat session list as the session model.** Push's branch-as-session-target model (one active branch = commit/push/diff/chat target) is richer than opencode's flat `Session.List()`. Adopting opencode's model would *lose* information.

## Suggested Priority

1. **JSON-Schema for the `push.runtime.v1` envelope + the `SCHEMA_VALIDATED_EVENT_TYPES` payloads**, emitted from (or checked against) `lib/protocol-schema.ts`. Wire it into the existing protocol-drift suite so the schema and the validators can't diverge. This is the concrete "smallest useful step" — it commits to nothing beyond writing down what the runtime already enforces.
2. Pin the session-verb vocabulary (doc-only) so future work has one spelling.
3. Defer the parts-model and any session REST API until a consumer (resumable-sessions growth, a third surface, an external client) actually forces it — capture the shape here so the decision is cheap when the trigger arrives.

## References

opencode:
- [anomalyco/opencode-sdk-go](https://github.com/anomalyco/opencode-sdk-go) — `api.md` (resource/endpoint list), `README.md` (client usage, `ssestream`, `Field[T]`/`ExtraFields`)
- Session resource: `/session` + `/session/{id}/{abort,init,children,revert,unrevert,share,summarize,prompt,command,shell,permissions/{id}}`
- Event stream: `GET /event`

Push counterparts:
- `lib/protocol-schema.ts` — `PROTOCOL_VERSION`, `validateEventEnvelope`, `SCHEMA_VALIDATED_EVENT_TYPES`, relay envelopes, `lastSeq` replay primitive
- `lib/runtime-contract.ts` — `RunEventInput` union (event source of truth), `DelegationOutcome`, `TaskGraphNode`
- `cli/session-store.ts` — `SessionEvent` envelope definition, session/run id formats
- `cli/daemon-client.ts` — NDJSON request/response/event client (internal)
- `app/src/worker/relay-routes.ts` — ring-buffer replay
- `cli/tests/protocol-drift.test.mjs`, `cli/tests/protocol-schema.test.mjs`, `cli/tests/daemon-integration.test.mjs` — drift guards
- [Web and CLI Runtime Contract](Web%20and%20CLI%20Runtime%20Contract.md) — "same brain, different shells"; Phase 7 out of scope
</content>
</invoke>
