# Platform, Sessions, and Sandbox Decisions

Status: **Current**
Reviewed: 2026-06-07

This is the live decision surface for Push's platform, auth, sessions, sandbox,
remote-control, provider, and GitHub integration choices. Archived source notes
live in [`../archive/decisions/`](../archive/decisions/README.md).

## Operating Contracts

### 1. GitHub is the web identity anchor

The production web app gates `/api/*` with the GitHub-backed Push session. The
old `X-Push-Deployment-Token` gate is retired. GitHub App installation tokens
are the default repo-auth path; PAT is an escape hatch, not the normal user
experience.

The device/relay bearer is a separate, legitimate custom auth layer because it
authorizes access to a daemon session, not web identity.

Source notes:
[`Auth Rework`](<../archive/decisions/Auth Rework — GitHub as the Single Identity Anchor.md>),
[`GitHub Token Storage`](<../archive/decisions/GitHub Token Storage — localStorage vs httpOnly Cookies.md>).

### 2. Every daemon session has a bearer

Daemon sessions carry an attach token from birth. Tokenless attach is not the
normal path. Addressable session verbs sit above that bearer layer: cancel,
summarize, revert, unrevert, children, and child-session fetches should use a
small canonical vocabulary rather than one-off shell affordances.

Status:
- Universal bearer shipped.
- Addressable verbs shipped for the current daemon/TUI surface.
- Open: continue tightening auth coverage for any sessionful verb paths that
  predate the bearer model.

Source notes:
[`Universal Session Bearer`](<../archive/decisions/Universal Session Bearer.md>),
[`Addressable Session Verbs`](<../archive/decisions/Addressable Session Verbs.md>),
[`Remote Session Status Packet`](<../archive/decisions/Remote Session Status Packet.md>).

### 3. Remote sessions route through pushd plus Worker relay

`pushd` remains the local execution host. The Worker/Durable Object relay
forwards runtime envelopes and should not become a second runtime. Desktop
wrapper work is packaging/pairing polish, not a separate execution model.

The daemon shell now mounts the standard workspace shell. Remaining remote work
should avoid rebuilding parallel UI chrome.

Source notes:
[`Remote Sessions via pushd Relay`](<../archive/decisions/Remote Sessions via pushd Relay.md>),
[`Remote Control Surface Audit`](<../archive/decisions/Remote Control Surface Audit — TUI and Daemon Exposure.md>).

### 4. SandboxProvider is the platform seam

Modal and Cloudflare sandboxes sit behind `SandboxProvider`. Provider selection
is environment-driven. Cloudflare is the sibling path for Workers-native
execution; Modal remains useful where its capabilities are still stronger.

Sandbox policy is enforced at the provider/tool boundary where possible, with
native provider enforcement deferred until there is a consumer.

Source notes:
[`Cloudflare Sandbox Provider Design`](<../archive/decisions/Cloudflare Sandbox Provider Design.md>),
[`Modal Sandbox Snapshots Design`](<../archive/decisions/Modal Sandbox Snapshots Design.md>),
[`Sandbox Policy Seam`](<../archive/decisions/Sandbox Policy Seam.md>).

### 5. Snapshots are best-effort warm reattach, not a guarantee

The scratchpad durability bar is "fail loudly, never silently," not "never lose
work." Auto-branch-on-commit is the universal commit flow. The open platform
question is where uncommitted scratchpad deltas live before graduation: remote
snapshot, device-local, or hybrid.

Current owner workflow favors remote-snapshot-primary with per-device slots
because Android plus WSL continuity matters.

Source notes:
[`Main as Scratchpad`](<../archive/decisions/Main as Scratchpad — Branch on Graduation.md>),
[`Scratchpad Durable Storage`](<../archive/decisions/Scratchpad Durable Storage — Remote vs Phone-Local.md>),
[`Cloudflare Native Backup Migration`](<../archive/decisions/Cloudflare Native Backup Migration.md>),
[`Cloudflare Artifacts`](<../archive/decisions/Cloudflare Artifacts.md>).

### 6. Long-running sandbox commands need a detached path

Buffered `exec()` remains fine for small commands. Long-running commands should
use detached background execution with resumable cursor logs when the provider
supports it, and transparently fall back when it does not.

Source note:
[`Background Execution`](<../archive/decisions/Background Execution — Detached Process and Resumable Cursor Logs.md>).

### 7. Model-invoked subprocesses are env-scrubbed by default

CLI subprocesses launched through model-invoked paths use a default-deny env
allowlist. Web sandbox isolation happens at the container/provider boundary.

Source note:
[`Subprocess Env Scrubbing`](<../archive/decisions/Subprocess Env Scrubbing.md>).

### 8. Provider observability is shared, provider routing is not

Cloudflare AI Gateway is useful for providers it supports. Workers Analytics
Engine covers the broader provider-call surface, including providers outside
the Gateway catalog. Provider/model selection remains owned by chat lock and
role/runtime context, not by the observability layer.

Source notes:
[`Cloudflare AI Gateway Integration`](<../archive/decisions/Cloudflare AI Gateway Integration.md>),
[`Provider Observability via Analytics Engine`](<../archive/decisions/Provider Observability via Analytics Engine.md>).

### 9. Automated PR review is shipped v1, not fully operational everywhere

Webhook-triggered PR review has a shipped v1 path: receiver, Durable Object,
dedupe/coalescing, read-only review history, rerun/cancel, and optional
Checks-API gating. Operational rollout still depends on the DO migration and
GitHub App permissions in the target environment.

Source note:
[`Webhook-Triggered PR Review`](<../archive/decisions/Webhook-Triggered PR Review.md>).

### 10. Git seams stay narrow until proven

The safest cross-language experiment is a narrow Git policy/read/write broker,
not a pushd rewrite. Any TS/Go split needs golden fixtures and drift tests
before production routing.

Repo mirror remains a product-facing sync feature, not a GitSync replacement.

Source notes:
[`PushGit Broker`](<../archive/decisions/PushGit Broker — Cross-Language RPC Seam.md>),
[`Repo Mirror Design`](<../archive/decisions/Repo Mirror Design.md>).

### 11. Settings unify behind GitHub identity

Web info/settings move from per-browser `localStorage` into a
server-authoritative document keyed by the GitHub identity — one KV doc behind
the `/api/*` session gate, last-write-wins, generalizing the existing
`pr-review-config` round-trip (which today uses a *global* key; the general doc
keys by GitHub user id). The APK inherits this for free (it loads the prod origin
via `server.url`, see #1). CLI is deferred, but the doc is identity-keyed from
day one so it joins additively rather than via migration.

Tiered: non-secret **preferences** migrate first; provider secrets wait on the
auth enforce-flip (#1); auth tokens, model caches, and composer drafts stay
device-local; scratchpad/todo content, session state, and context-memory are
separate concerns (scratchpad/todo reassigned to the session-continuity track —
see Status). The
motivating payoff is reviewer visibility/control from any device, which falls out
once reviewer config lives in the shared doc.

Status:
- Shipped (MVP): the identity-keyed settings document + `GET/PUT /api/settings`
  behind the session gate, the shared client store (sync cache + write-through +
  boot reconcile), the autonomous-reviewer config fold (`reviewer.autonomous.*`),
  and the non-secret preference hooks — appearance (chat-mode / per-repo /
  daemon), protect-main (global + per-repo), show-tool-activity, last-used
  models, user profile, and the in-app advisory reviewer picks
  (`reviewer.advisory.*`).
- Deferred (still in scope): the provider-secrets tier — waits on
  `PUSH_SESSION_GATE_ENFORCE` (#1).
- Reassigned (out of settings scope): scratchpad/todo content. They were
  mis-bucketed as "settings" — they are *content/context*, not preferences, and
  pay off only next to the conversation that produced them. Two distinct things
  hid under one name: (a) **UI scratchpad notes + todo** are repo-scoped working
  artifacts that belong with chat/session continuity (the north-star track),
  implemented there or not at all — syncing them alone is low ROI and incurs the
  LWW data-loss risk on actively-edited content for little gain; (b) the
  **"main as scratchpad" uncommitted code** is a git/sandbox substrate (#5 /
  branch-on-commit), never a KV-doc concern. The settings doc stays
  preferences-only.

Design note:
[`Settings Unification`](<../runbooks/Settings Unification — GitHub-Identity-Keyed Config.md>).

## Active Platform Work

1. Apply/verify webhook PR-review production migration and permissions.
2. Hydrate clients from `get_session_snapshot` where it replaces replay glue.
3. Decide scratchpad storage substrate for PWA/APK/local surfaces — the
   uncommitted-code side rides #5 (main-as-scratchpad / branch-on-commit); the
   UI scratchpad-notes + todo side rides chat/session continuity. Out of
   settings-unification scope (#11).
4. Promote Cloudflare native backup migration when the current snapshot ceiling
   becomes painful or adjacent CF work makes it cheap.
5. Finish provider support for detached background execution where it improves
   real workflows.
6. Tighten any remaining daemon session-verb auth gaps.
7. Keep Git/RPC broker work behind parity harnesses until the cross-language tax
   is measured.

## Archived Context Worth Knowing

Platform/research source notes:
[`AgentScope Architecture Review`](<../archive/decisions/AgentScope Architecture Review.md>),
[`Vercel Open Agents Review`](<../archive/decisions/Vercel Open Agents Review.md>),
[`OpenAI Agents SDK Evolution Review`](<../archive/decisions/OpenAI Agents SDK Evolution Review.md>),
[`Oh My OpenAgent Review`](<../archive/decisions/Oh My OpenAgent Review.md>),
[`Multi-Agent Orchestration Research`](<../archive/decisions/Multi-Agent Orchestration Research — open-multi-agent.md>).

Legacy shipped references:
[`Agent Experience Wishlist`](<../archive/decisions/Agent Experience Wishlist.md>),
[`Resumable Sessions Design`](<../archive/decisions/Resumable Sessions Design.md>),
[`Hashline System Review`](<../archive/decisions/Hashline System Review.md>),
[`Coder Bypass of WebToolExecutionRuntime`](<../archive/decisions/Coder Bypass of WebToolExecutionRuntime.md>).
