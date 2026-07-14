# Platform, Sessions, and Sandbox Decisions

Status: **Current**
Reviewed: 2026-06-17

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

**Auto-back (shipped, web/cloud).** Snapshots are device-local and bounded by a
~50-min reconnect window. The durable, portable layer above them is **auto-back**:
while a repo sandbox is live, the working tree is continuously mirrored to a
pushed `draft/auto/<branch>` ref on origin (debounce-after-edits + flush on
tab-hide). Non-switching capture (throwaway index + `commit-tree` off HEAD, never
moves HEAD) → secret-scanned, *non*-Protect-Main draft push. The mutation signal
is client-side at tool dispatch (not the sandbox `workspace_revision`, which
self-loops and is 0 on Cloudflare). On a fresh sandbox that wasn't
snapshot-restored, an **offer-to-restore** banner surfaces a newer backup; apply
is gated on `backup-parent == HEAD` (so it restores exactly the WIP and never
reverts intervening commits) and pins the detected sha (no TOCTOU). This is the
write-side complement to §11's read-tier (reads off GitHub) — together they make
the sandbox disposable compute attached to a pushed branch. Shipped: #980 / #981
/ #983; follow-ups #982. Design provenance:
[`Pushed Branch as Source of Truth — Gate at Push`](<Pushed Branch as Source of Truth — Gate at Push.md>).

Source notes:
[`Main as Scratchpad`](<../archive/decisions/Main as Scratchpad — Branch on Graduation.md>),
[`Scratchpad Durable Storage`](<../archive/decisions/Scratchpad Durable Storage — Remote vs Phone-Local.md>),
[`Cloudflare Native Backup Migration`](<../archive/decisions/Cloudflare Native Backup Migration.md>),
[`Cloudflare Artifacts`](<../archive/decisions/Cloudflare Artifacts.md>).

### 6. Long-running sandbox commands need a detached path

Buffered `exec()` remains fine for small commands. Long-running commands should
use detached background execution with resumable cursor logs when the provider
supports it, and transparently fall back when it does not.

Mechanism shipped in PR #789 (routes + provider wiring +
`lib/detached-exec-runner.ts` + the verification `npm install` as first
consumer). Agent `sandbox_exec` adoption **shipped in PR #863**
(2026-06-09): always-detached on capable backends with buffered exec as
the 404-only capability fallback, `terminalReason` provenance on every
runner result, Stop wired to server-side interrupt, and a
double-execution guard on ambiguous start failures. The live-tail UI
shipped in PR #867 (2026-06-10): the agent status bar streams the latest
output line of a running `sandbox_exec` via `app/src/lib/exec-progress.ts`.

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

### 9a. The reviewer verifies from CI check runs, not its own sandbox

**Status: Draft** — design agreed, not implemented.

The reviewer currently re-runs `typecheck` and the repo's `# test:` command inside
its own sandbox. It should instead **read the check runs GitHub already produced for
the head SHA it is reviewing**.

**Why the sandbox path cannot work here.** CI has already run those exact commands,
on that exact commit, on real hardware, with a warm dependency cache, in ~90s. The
reviewer then provisions a `standard` container (½ vCPU / 4 GiB) and runs them again:
a full monorepo `pnpm install` (600s setup deadline) followed by a 3,248-test suite
(480s verifier deadline) that takes ~5 minutes on a 16-core machine. `Dockerfile.sandbox`
already records that this container class gets OOM-killed by repo test suites. We are
asking the box to do something it cannot do, and then reading the corpse as flakiness.

Observed consequence (PR #1467, the first review after the setup gate was fixed):

```
typecheck: did not complete (start-unconfirmed): sandbox exec-start failed: Sandbox not found or expired
tests:     did not complete (lost-contact): sandbox exec-status failed: Auth check failed
```

Both are the same fact — the container is gone — surfaced through two different
seams. (The second is also a status misclassification: the owner-token probe reads
the token from *inside* the container, so an unreachable container reports as an
auth/config failure. A dead box is not a bad token.)

**The design.** `ReviewVerification` sources from `GET /repos/{repo}/commits/{sha}/check-runs`:

- The DO already mints installation tokens, so no new auth surface.
- `pass` / `fail` come from the check-run conclusions for the head SHA.
- CI still in flight → poll to a deadline, then `blocked` (reason: "CI has not
  completed for this SHA"). The `blocked` state (§ verification record) already
  models exactly this: invoked, and the environment did not produce a verdict.
- Repo has no CI → `unavailable`, same as today's no-test-command case.
- The sandbox stays available for **inspection** (read/search), which is what it is
  actually good at in a review, and can degrade to the GitHub contents API.

**The reviewer MUST exclude its own check run, or it deadlocks on itself.** (Codex,
PR #1469 — caught in the design, before a line was written.) `runReview` calls
`createInProgressReviewCheckRun` BEFORE the executor starts, so `Push review` is
itself a check run on the head SHA, sitting `in_progress` for the entire review.
Verified live against this PR's own SHA:

```
Workers Builds: push  |  app=cloudflare-workers-and-pages  |  status=completed
Push review           |  app=push-agent (id=2801157)       |  status=in_progress
```

A verifier that waits for "all check runs on this SHA" would wait for ITSELF, block to
the deadline, and report `blocked` — on every review that publishes a visible check,
i.e. the normal case. The failure would look exactly like the sandbox failure this
decision exists to fix, which is how it would have survived a review cycle.

Filter by the **check-run id we created** (exact), and defensively by **owning app id**
(a rerun or superseded attempt can leave a second `push-agent` check on the same SHA).
Never filter by NAME alone — `REVIEW_CHECK_NAME` is user-visible text and a repo can
mint a check run that collides with it.

**Which checks count is a second open question, and it is not "all of them".** The
record has `typecheck` and `tests` fields; CI has arbitrary check names ("Format,
Typecheck, Test (cli)", "Lint, Test, Build (app)", "Workers Builds: push"). Mapping
names to verifier slots is brittle. The recommendation: stop pretending the record is
per-verifier and source ONE aggregate verdict from the non-self check runs (all
completed and none failed → `pass`; any failure → `fail`), because "did the head SHA's
checks pass" is exactly the fact the check run reports and exactly the gate the change
merges on. That is a change to `ReviewVerification`'s shape and should be decided
before implementation, not discovered during it.

**This makes the verification claim stronger, not weaker.** CI is the gate the change
merges on. A reviewer that says "tests pass" because *the gate you merge on* passed is
making a better-evidenced claim than one reporting a half-vCPU container's opinion.

**The tradeoff we are accepting, stated plainly.** Sandbox verification runs commands
resolved from the **base ref's** AGENTS.md — deliberately trusted input. CI check runs
for a same-repo PR are produced by the **head ref's** workflow, which the PR author can
edit. So this moves the reviewer's verification from author-proof to author-influenced.
We accept it because (a) the reviewer is advisory, not a merge gate, (b) the human sees
the same check runs, and (c) an author who can weaken CI has already defeated the
merge gate, so the reviewer was never the thing standing in the way. If that ever stops
being true, gate on workflows resolved at the base ref rather than reverting to a
container we cannot feed.

**Not in scope:** removing the sandbox. It is the web surface's entire execution
capability — no local machine, no shell, no build. Deleting it removes "terminal" and
"CI" from the stack Push claims to collapse, on the surface where that claim matters
most. This decision removes the sandbox from the *review verification* path only.

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

### 12. Cloudflare Agents SDK is not adopted for the worker DOs

The `agents` package (`Agent` base class, `this.schedule()`, durable-execution
fibers) was evaluated for the existing worker Durable Objects — `CoderJob`,
`RunHost`, `PrReviewJob`. **Decision: do not retrofit.** Push already uses the
Cloudflare primitives the SDK sits on (Workers, Durable Objects, the
`@cloudflare/sandbox` container DO, SQLite-in-DO, alarms, WebSockets); the SDK's
scheduling, durable-resume, and state-persistence value-adds are things these
DOs have already built with better testability and portability than the SDK
gives back.

The blockers are concrete: the SDK's scheduler and fibers are reachable only by
subclassing `Agent`, which (a) pulls `partyserver` + `cloudflare:workers`,
fighting `coder-job-do.ts`'s deliberate choice not to extend even the
`DurableObject` base; (b) commandeers the DO `alarm()` handler, which in these
DOs is doing irreplaceable multiplexed / state-machine work whose decisions
already live as pure, unit-tested functions in `lib/run-host-adoption`; and
(c) couples worker-layer logic to Cloudflare, against the `SandboxProvider`
neutrality seam (#4). The `AIChatAgent` chat loop collides with Push's own
`lib/` tool/runtime contract and can't run on CLI/Android.

Revisit only for a greenfield Cloudflare-only surface (no `lib/`-neutrality or
CLI/Android requirement), or if server-pushed browser state sync / large MCP
client fan-out become product requirements. None holds today.

Status: **Current** — evaluated 2026-06-17, not adopted.

Research note:
[`Cloudflare Agents SDK Evaluation`](<../research/Cloudflare Agents SDK Evaluation.md>).

### 13. Provider failover is round-scoped and lock-respecting

**Status: Current** (adopted 2026-06-21). Prompted by a review of
[QuantumNous/new-api](https://github.com/QuantumNous/new-api), a Go LLM gateway
whose core value-add is weighted multi-channel routing with automatic failover.
Push has the inverse: one provider/model is **locked** per chat (#8 — routing is
owned by chat lock and role context, not the observability layer), so a single
transient upstream failure (a gateway 5xx, a 429, an expired key) kills the whole
turn even when other configured providers could have served it. The existing
recovery is **same-provider only**: `shouldRetryStreamRound` in
`app/src/lib/stream-error.ts` re-attempts a transient failure up to
`STREAM_RETRY_MAX`, then surfaces the error. There is no cross-provider step.

The decision: add failover as a **round-scoped, lock-respecting** extension —
not a new routing model.

- **Round-scoped, not re-locking.** Failover rescues the *current* round by
  trying an alternate provider; it does **not** mutate the chat lock. The lock
  encodes user intent plus capability guarantees (notably Anthropic
  signed-reasoning round-trip), so permanently swapping the user's chosen
  provider on one blip is surprising. If the primary stays down, each subsequent
  round re-tries it first (cheap if it recovered) and fails over again. Promoting
  failover to a sticky re-lock is a deliberate future step, not v1.

- **Error classification drives the action, not message text.** Reuse the
  structured `ProviderStreamError` fields (`retryable`, `status`) — never
  `.message` (the HTTP-status anti-pattern in CLAUDE.md / REVIEW.md). Two
  distinct predicates:
  - *retry-same-worthy* = transient (5xx / 429 / 408 / 425 / stall) — the same
    provider may recover.
  - *failover-worthy* = transient **or** provider-specific deterministic failures
    a different provider could survive: **401/403** (the failing key is
    per-provider) and **404** (model absent on this provider). **Excluded:
    400/422** — a malformed request fails identically everywhere, so failing
    over just burns a second provider's quota to reproduce the error.

- **The output guard is also the safety seam.** Failover only fires before any
  assistant-visible output streamed this round (the same `hasOutput` guard the
  same-provider retry uses). This is load-bearing twice over: it prevents
  duplicated/rewritten visible text, *and* it sidesteps the reasoning-block
  compatibility hazard — a failover round has emitted no signed thinking yet, so
  there is nothing provider-incompatible to strand.

- **Candidate selection is capability-aware and lives at the call site.** The
  decision kernel is pure (`lib/provider-failover.ts`,
  `decideStreamFailover`): it takes a pre-extracted `StreamErrorClassification`
  and a **pre-filtered, ordered candidate list**. The caller — which has the
  message history — resolves candidates to providers that are (a) configured
  (have a key) and (b) compatible with the conversation's reasoning-block
  requirements. The open hazard wiring must respect: a history containing
  Anthropic signed reasoning blocks must not fail over to an OpenAI-shaped
  provider that can't echo them back. Until that filter is precise, the
  conservative default is "fail over only among providers sharing the locked
  provider's stream shape."

- **Symmetric structured logs.** Each branch emits one line — `stream_round_retry`
  (same-provider), `stream_failover` (with `from`/`to`), `stream_recovery_exhausted`
  (with `triedCount`).

Current implementation:
- The pure decision kernel + unit tests (`lib/provider-failover.ts`).
- Web wiring in `app/src/hooks/chat-stream-round.ts`, with the capability-aware
  candidate resolver `resolveFailoverCandidates` + `PROVIDER_STREAM_SHAPE` in
  `orchestrator-provider-routing.ts`. The reasoning-block hazard is closed
  structurally: `anthropic` is alone in its wire-shape bucket, so a chat carrying
  Anthropic signed reasoning blocks has no same-shape candidate and never fails
  over. The same-provider retry decision moved into the kernel
  (`shouldRetryStreamRound` was deleted) so there is one source of truth.
  - **Transport-aware isolation.** Static provider→shape keying isn't enough:
    `zen` (Zen Go MiniMax/Qwen) and `vertex` (Claude) route through the
    Anthropic bridge *per model*. The resolver isolates any locked route where
    `routesThroughAnthropicBridge(locked, model)` holds — returning no
    candidates — so a model-dependent Anthropic route can't fail over to a
    provider that can't replay its signed reasoning. Candidate routes are also
    checked with their configured model, so a non-Anthropic lock can't fail over
    into a model-dependent Anthropic target. That predicate is now shared
    one-source-of-truth with `orchestrator.ts`'s reasoning-block gate.
  - **Failover order ≠ initial-pick order.** Candidate ordering uses a
    dedicated `FAILOVER_PROVIDER_ORDER` that includes every real provider
    (azure/bedrock/vertex too), unlike `PROVIDER_FALLBACK_ORDER` which omits the
    experimental trio for initial selection — otherwise an OpenAI-locked chat
    whose only backup key is Azure would get no candidate.
- A user-facing toggle defaulting **off**, in the unified settings doc
  (`SETTINGS_KEYS.providerFailover`, surfaced in the Settings UI on both the web
  and daemon surfaces). The round loop reads it synchronously via `getSetting`;
  with failover off the candidate list is empty and the kernel collapses to the
  prior same-provider-retry behavior.
- CLI wiring in `cli/lead-turn.ts`: the stream handed to the shared
  `runCoderAgent` kernel is wrapped in a per-round retry/failover generator, so
  failover lands without kernel changes. Candidates come from
  `resolveCliFailoverCandidates` (`cli/provider.ts`) — same wire-shape rule,
  same anthropic/gemini isolation (both are single-member buckets in the CLI
  registry). Gated by the `PUSH_PROVIDER_FAILOVER` env flag (default off);
  retry/failover transitions surface as `warning` events
  (`PROVIDER_RETRY` / `PROVIDER_FAILOVER`).

Remaining: consider promoting round-scoped failover to a sticky re-lock once
validated in real use; a shared CLI/web failover-enabled signal if the CLI ever
adopts the synced settings doc.

## Active Platform Work

1. Apply/verify webhook PR-review production migration and permissions.
2. Hydrate clients from `get_session_snapshot` where it replaces replay glue.
3. Decide scratchpad storage substrate for PWA/APK/local surfaces — the
   uncommitted-code side rides #5 (main-as-scratchpad / branch-on-commit); the
   UI scratchpad-notes + todo side rides chat/session continuity. Out of
   settings-unification scope (#11).
4. Promote Cloudflare native backup migration when the current snapshot ceiling
   becomes painful or adjacent CF work makes it cheap.
5. ~~Finish provider support for detached background execution where it
   improves real workflows~~ — agent `sandbox_exec` adoption shipped in PR
   #863 (2026-06-09) and the live-tail UI in PR #867 (2026-06-10);
   remaining: Modal-side routes if Modal ever returns to primary duty.
6. Tighten any remaining daemon session-verb auth gaps.
7. Keep Git/RPC broker work behind parity harnesses until the cross-language tax
   is measured.
8. **Do not shop for a new sandbox provider until the flakiness is attributed.**
   The instinct to replace the backend keeps recurring; the evidence does not yet
   support it, and we have a documented history of misattributing our own bugs to it:
   - #1270 — "sandbox dies after ~2 min idle" was a CLIENT-side false positive
     (ephemeral-disk token loss). `sleepAfter` was an hour. We blamed the backend and
     the bug was ours.
   - 2026-07-14 — "the container keeps dying mid-review" appeared the moment the
     reviewer's setup gate started doing real work (#1457). We are running a monorepo
     install plus a 3,248-test suite on ½ vCPU / 4 GiB, a container class
     `Dockerfile.sandbox` already documents as OOM-killed by repo test suites. Not
     obviously the backend's fault. See §9a.
   - #1391 — control-plane hangs (`startProcess`/`getProcess` at minute scale) ARE
     genuinely upstream. One real upstream bug is not a migration case.

   `SandboxProvider` exists precisely so this can be settled with evidence rather than
   vibes: run the same workload on `PUSH_SANDBOX_PROVIDER=modal` and compare. That is a
   day of measurement against a migration. Attribute first, then shop — if at all.

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
