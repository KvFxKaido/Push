# T3 Code — Lessons for Push

Status: Reference (research snapshot, 2026-07-11)
Source: `pingdotgg/t3code` (TypeScript, MIT, ~13.5k stars, started 2026-02) —
`README.md`, `AGENTS.md`, `docs/architecture/` (overview, remote, providers,
runtime-modes, connection-runtime), `docs/cloud/` (Clerk/Connect auth),
`.plans/` (~30 numbered maintainability specs + `spec-contract-matrix.md`),
`apps/desktop/` (Electron: WSL/SSH/Tailscale backend managers, preview picker),
`apps/mobile/` (Expo/React Native + Swift native modules), `apps/server/src/`
(orchestration Layers, checkpointing, git, auth, mcp, cloud/relay) — cross-read
against Push's root `lib/` + `app/` + `cli/` runtime. **Read cold; I have not
run T3.** This doc is the repo-native rewrite of the earlier ChatGPT notes.

## Why this doc exists

T3 Code is Theo/ping.gg's **"minimal web GUI for coding agents."** That phrase
is the whole thesis: T3 wraps *other people's* agents — Codex `app-server`,
Claude Code, Cursor CLI, OpenCode — behind one neutral orchestration server and
renders them across desktop, mobile, and web. It never talks to a raw model
API and builds **zero** agent intelligence. The product *is* the harness.

Push made the inverse bet. Push builds its own governed kernel — Orchestrator /
Explorer / Coder / Reviewer / Auditor, its own model routing, its own sandbox —
and the harness exists to *govern* that kernel (push-time Auditor gate,
capability gating, per-turn side-effect budget, Protect Main). T3 wraps the
intelligence; Push **is** the intelligence and puts a gate in front of it.

So this is the cleanest strategic-fork comparison in the research series. Where
[crush](charmbracelet%20crush%20—%20Lessons%20for%20Push.md) was the CLI-product
comparison, [deepagents](LangChain%20deepagents%20—%20Lessons%20for%20Push.md)
the harness-library comparison, and [CodeWhale](CodeWhale%20—%20Lessons%20for%20Push.md)
the governed-orchestration comparison, **T3 is the "don't build the agent"
comparison** — the closest thing to a mirror-universe Push that chose breadth
of wrapped agents over depth of owned governance. Two teams reached nearly the
same *silhouette* (mobile + desktop/CLI + web collapsed into one conversation,
remote reach into your own machine, git checkpoints, quiescence receipts,
provider neutrality) from opposite starting points. That convergence is the
signal; the divergence is the lesson.

Same disclaimer as the prior reviews: this is a concept map, not a dependency
proposal. T3's load-bearing choices (Effect-TS end to end, Vite+/`vp`, Electron
backend-manager desktop, one-server-per-environment remoteness) sit exactly
where Push's plain-TS shared `lib/`, inline lead lane, and Capacitor shell sit.
The value is in a handful of mechanisms and one framing that are independently
reimplementable.

## Two framings that drive this doc

1. **Mobile is Push's main surface, and it's being dialed in first.** The
   Windows story is "wrap the web app" *later* — deliberately after mobile
   feel is right. T3 inverts that ordering (desktop-Electron-first, native
   mobile still WIP/undistributed), which makes it a useful ceiling-check on
   both surfaces without being a template for either.
2. **Push must not feel like a remote — not "a paper airplane thrown into
   wind."** This is the design north star T3 pressure-tests hardest, because
   T3 is *remote-by-construction*: its client always speaks WebSocket to a
   server that owns the runtime. Every T3 surface is, structurally, a remote
   control. Push's inline/lead-turn lanes deliberately collapse the lead
   *into* the surface so a turn is not thrown over a wall. Keeping that
   distinction sharp is the whole game (see takeaway 2).

## The map

State legend (shared with the series): ✅ have it (equal or deeper) · ◐ partial,
or a deliberate deferral · ⚠️ gap worth a look · ↔ deliberate divergence.

| T3 mechanism | Push equivalent | State |
|---|---|---|
| **Wraps external agents, builds none** — server shells into `codex app-server` over JSON-RPC/stdio; Claude/Cursor/OpenCode via what reads as ACP (`acp-mock-agent.ts`, `cursor-acp-model-mismatch-probe.ts`). No raw model API, no own kernel. | Own governed kernel (roles + model routing + sandbox); Auditor gate, capability gating, side-effect budget, Protect Main. Enforcement *requires* owning the loop. | ↔ The fork. Defensible both ways; see takeaway 1. |
| **Remote architecture as a first-class model** — `ExecutionEnvironment` (one server) / `KnownEnvironment` (client-local saved reach) / `AccessEndpoint` + `AdvertisedEndpoint` (concrete routes, treated as *hints* until a connection proves them) / pluggable **endpoint providers** (Tailscale first). Crucially: **access** (how a client reaches a server) is separated from **launch** (how a server comes to exist). | Remote sessions grown as *sessions*: web drives local `pushd` over loopback WS (#507–509), Universal Session Bearer (#717/#720/#719), addressable session verbs (#722–728). No clean environment/access/launch split. | ◐ Borrow the model, not the transport. See takeaway 3. |
| **Quiescence receipts + `RuntimeReceiptBus` + `DrainableWorker`** — server emits typed receipts when async milestones finish (checkpoint captured, diff finalized, *turn fully quiescent*); tests and orchestration **wait on receipts, never poll** git/projections/timers. | Just landed a terminal turn-quiescence receipt (#1410 / `d7c6b63a`). Symmetric-structured-logs + Gate-at-Push receipts exist per-branch, not as a general bus. | ◐ Converging independently; generalize to a receipt bus. Highest-value borrow. See takeaway 4. |
| **Native mobile, for real** — Expo/RN with custom native modules: Swift composer editor (`t3-composer-editor`), native markdown text (Nitro), home-screen widget, native/JS diff-highlighter toggle. Dev-client only, not yet distributed. | APK is a thin Capacitor shell loading the prod origin (`push-apk-loads-prod-origin`); mobile-feel via web (#1412 M3 state layers + haptics; [Mobile-Feel Spec Map](Mobile-Feel%20Spec%20Map%20-%20Material%203%20+%20Apple%20HIG.md)). | ◐ Deferral is defensible; T3 = the native ceiling for the *main* surface. See takeaway 5. |
| **Checkpoint-per-turn git model** — `CheckpointReactor` captures a git checkpoint on turn start/complete; `CheckpointStore` + `CheckpointDiffQuery` back an undo/diff surface; diff finalization is a receipt. | Snapshot store + Gate-at-Push (silent local commit → `prepare_push` audits cumulative diff) + per-commit Auditor on CLI. Checkpoints are governance artifacts, not an undo timeline. | ✅ Have it, different intent. Borrowable: checkpoint-as-undo primitive. See takeaway 6. |
| **In-app preview + element picker** — desktop `BrowserSession` renders the app under development; `PickPreload`/`PickedElementPayload` let you click an element and hand it to the agent; `PreviewAutomationBroker` + an MCP preview toolkit expose it as tools. | Playwright *recipes* for live-app screenshots (`push-live-app-screenshot`), not an in-product preview/pick surface. | ⚠️ Gap; genuinely interesting on mobile (tap element → agent context). See takeaway 6. |
| **ACP as the provider-neutral seam** — one protocol to drive Claude/Cursor/Codex-class agents. | Codex-as-tool keyhole (`mcp__codex__codex`, `/codex`); MCP is CLI-scoped by design. | ◐ Optional synthesis: "adopter mode" — drive an external agent as a *governed* Coder backend. See takeaway 7. |
| **Runtime modes** — global toggle: Full access (`approvalPolicy: never`, `sandboxMode: danger-full-access`) vs Supervised (`on-request` + `workspace-write`, in-app approvals). | Approval modes + capability gating + Protect Main + typed branch tools + git policy (`lib/git/policy.ts`). | ✅ Deeper and governed; nothing to borrow, worth noting the convergence. |
| **WebSocket auth as first-class env access** — Clerk + DPoP tokens + pairing grants; remote doc insists the WS auth token become part of the environment access model, "not an incidental query-parameter convention"; hosted pairing puts the token in the URL **hash**, never the query. | GitHub-identity session gate (#776), Universal Session Bearer, encrypted secrets tier (#890). | ✅ Have the analog; steal the *hardening notes* for the remote track (hash-not-query, auth-required-for-public). See takeaway 3. |
| **`.plans/` numbered spec-first culture** — ~30 numbered maintainability plans, a `spec-contract-matrix.md`, per-PR remediation checklists. | `docs/decisions/` with a Status lifecycle + this research series. | ✅ Parallel discipline; theirs is more granular/numbered. Cosmetic. |
| **Electron backend-manager desktop** — Windows/mac/Linux app whose main process manages WSL/SSH/Tailscale backends and spawns/forwards to servers. | Windows plan = wrap the web app (thin webview), *after* mobile. Local reach today = CLI/`pushd`. | ↔ Intentionally lighter. Don't grow a backend-manager; see takeaway 8. |
| **Effect-TS end to end + Vite+/`vp` + vendored `.repos/`** — services, typed errors, DI, Schema, `DrainableWorker`, all on Effect; build via Theo-ecosystem `vp`; reference deps vendored read-only under `.repos/`. | Plain TS, shared `lib/` + per-surface coordinators; npm/vite/wrangler; no vendoring. | ↔ Steal patterns, not the framework. See takeaway 8. |

## 1. The fork: you can't govern what you don't own

T3's bet is that frontier agents are commoditizing and the durable value is the
multi-surface, remote-reach, git-aware *harness* around them. 13.5k stars in
five months says the market finds that valuable. It is not an obviously wrong
bet.

But it structurally forecloses the one thing Push sells: **enforcement.** T3
cannot put an Auditor between the model and `git push`, because it doesn't sit
there — it hands the turn to Claude Code's opaque loop and renders what comes
back. Push's "build our own kernel" tax buys exactly one thing T3 can never
have: the ability to *guarantee* "this agent cannot push to main without
passing the gate." That is a narrower, more defensible promise than "wraps
every agent," and it is the honest answer to "why not just wrap Claude Code
like T3 does."

The uncomfortable corollary — worth an occasional audit — is that **every place
Push builds its own kernel but isn't using it to enforce something is paying the
tax without buying the good.** If a role or a code path exists but imposes no
gate, no capability filter, no budget, no policy, that's the spot where the
wrap-it-like-T3 argument actually has teeth. The governance thesis is the moat;
kernel-for-its-own-sake is just cost.

## 2. "Don't feel like a remote" is an architecture decision, not a polish pass

T3 is the best available proof of the failure mode Push is trying to avoid.
*Every* T3 surface is a WebSocket client talking to a server that owns the
runtime — the model is literally "one T3 server per `ExecutionEnvironment`,
client speaks WebSocket to it." That is a clean architecture, and it is also
precisely the shape that risks feeling like a remote: latency between tap and
effect, reconnect states as first-class UI (`connecting → open → reconnecting →
closed`), turns thrown over a wall and awaited.

Push's insurance against the paper-airplane feel is the **inline / lead-turn
lanes**: the lead runs the coder kernel *in the surface* (in-browser for web
inline, #892/#893; in-process for the TUI lead-turn), so the common path is not
a remote at all — it's local execution the user is inside of. The CLI/daemon and
the eventual Windows wrapper give the lead *more reach* (real filesystem, real
shell, persistent daemon) — **not a different interaction model**
(`docs/decisions/Agent Runtime Decisions.md` §10).

The lesson from T3 is to hold that line deliberately:

- **Keep inline/lead-turn the default; keep detached/remote an explicit,
  labeled tool** — the reverse of T3, where remote is the substrate and
  everything inherits its feel.
- When Push *does* go remote (mobile → local box, mobile → future Windows
  wrapper), **borrow T3's honesty about endpoints**: an advertised route is a
  *hint* until a real connection proves it; show the actual reachability state
  (loopback / LAN / tunnel), don't pretend a saved URL is a live connection.
  That's the "honest surfaces / visibility over convenience" instinct expressed
  as connection UX — the opposite of throwing the airplane and hoping.
- **Reconnect is a feature, not an error state.** T3 models it first-class
  (queue outbound while disconnected, flush on reconnect, `replayLatest` on
  subscribe). A mobile-main product that backgrounds constantly needs this to
  not feel like a dropped remote. This is the single most portable UX mechanic
  in the repo.

## 3. Steal the remote *model* (access vs launch), not the transport

`docs/architecture/remote.md` is T3's strongest artifact and it is ahead of
where Push's remote-sessions track is written down. Its core discipline:
**express remoteness at the connection layer, never by forking the runtime**,
and **separate two concerns Push currently tangles**:

- **Launch** — how a server comes to exist: pre-existing, desktop-managed SSH
  spawn, or client-published tunnel. (T3 explicitly borrows Zed's *launch
  discipline* — probing, session dirs with pid/log, reconnect-friendly
  launchers — while rejecting Zed's custom proxy transport.)
- **Access** — how a client reaches it: direct `ws`/`wss`, tunnel/relay,
  Tailscale-discovered endpoint, or SSH-forwarded local port. The same
  environment can have many `AccessEndpoint`s; only the path changes.

For Push this maps directly onto "mobile reaches my local WSL box" and the
future "mobile reaches my Windows machine." The payoff of writing it T3's way:
the CLI/`pushd`, the web inline lane, and the Windows wrapper stop drifting into
three different remote stories. Reconcile the existing remote-sessions memory
(`push-remote-sessions-track`, `push-anthropic-remote-control-comparison`)
against this doc and lift the vocabulary — `ExecutionEnvironment` /
`KnownEnvironment` / `AccessEndpoint` / endpoint-providers — even if the
implementation stays loopback-WS + bearer for now.

Hardening notes to lift verbatim: **auth token in the URL hash, never the
query** (so a hosted pairing page origin never receives it); **authenticated
access required for any publicly reachable environment** (no security by
obscurity); and **persist endpoint overrides by stable *kind*** (e.g. "the LAN
endpoint," "the Tailscale MagicDNS endpoint") **not by raw URL**, because the
address changes when the network does.

## 4. Generalize #1410 into a receipt bus with drainable workers

Push and T3 independently arrived at the same idea in the same week: a **turn
becoming fully quiescent is a typed event you can wait on.** T3 has already
generalized it and it's worth copying the generalization, not just the one
receipt:

- A **`RuntimeReceiptBus`**: every meaningful async milestone (checkpoint
  captured, diff finalized, command reacted, turn quiescent) emits a typed
  receipt on one bus.
- **`DrainableWorker`**: every background reactor is a queue-backed worker
  exposing `drain()`, so tests and orchestration wait for genuine idle instead
  of polling git state, projections, or timers.

This lands squarely on two of Push's recurring defect classes from the PR
self-review list: **`await` in a loop** (a naked `await` on a
resolve-on-success promise becomes impossible when completion is an observable
receipt with a terminal path) and **silent return paths** (a milestone that
must emit a receipt can't quietly no-op into "still in progress"). It also gives
the app/worker background jobs (coder job DO, resume path) a uniform,
deterministic settle signal instead of the current per-branch structured-log
pairs. #1410 is the first tile; the bus is the floor.

## 5. Native mobile is the ceiling for the surface that matters most

Mobile is Push's main surface and it's currently a Capacitor shell loading the
prod origin — a sane, cheap choice that #1412's M3 state layers + haptic
vocabulary push about as far as the *web* can go. T3 is the existence proof of
what lives above that ceiling: a **Swift composer editor**, **native markdown
rendering** (Nitro), **native diff highlighting** (with a JS fallback toggle),
and a **home-screen widget** — the things that make an input box feel like the
OS wrote it rather than a webview approximating it.

Two honest takeaways, no recommendation to act now:

- The Capacitor deferral is right *until a specific interaction proves the web
  ceiling* — and on a chat-first product the composer/editor and the diff
  viewer are the two most likely proof points. T3 built native modules for
  exactly those two. If Push ever hits "the composer feels like a webview," T3
  shows the escape hatch is a single Expo native module, not a rewrite.
- T3 also shows the cost: an Expo dev-client pipeline, EAS build matrix, Swift +
  Kotlin lint toolchains (SwiftLint/ktlint/detekt), and native modules that are
  *still WIP and undistributed* five months in. Native feel is real work;
  "dial mobile in first" via the web ceiling before paying it is the defensible
  ordering.

## 6. Two smaller borrows: checkpoint-as-undo and preview element-pick

- **Checkpoint-as-undo.** T3's `CheckpointReactor` captures a git checkpoint on
  *every* turn boundary and backs a diff/undo surface off it. Push already
  snapshots and audits, but as *governance* artifacts, not a user-facing "step
  back one turn" timeline. On mobile especially, "undo the last turn" as a
  first-class gesture (backed by the snapshot you already take) is a high-trust,
  paper-airplane-antidote affordance — it makes the surface feel like something
  you can safely poke, not a one-way throw.
- **Preview element-pick.** T3's desktop renders the app-under-development and
  lets you click an element to hand it to the agent (`PickPreload` →
  `PickedElementPayload`, brokered over MCP). Push has the Playwright *plumbing*
  (`push-live-app-screenshot`) but no in-product pick. "Tap the thing on screen
  → the agent gets the element/context" is a natural mobile gesture and a strong
  differentiator for a chat-native coding tool. Filed as interesting, not
  urgent.

## 7. Optional synthesis: adopter mode over ACP

Push does not have to choose the fork in takeaway 1 globally. The one place the
wrap-an-external-agent bet composes with Push's thesis is as a **governed Coder
backend**: let Push drive Claude Code or Codex *through its own gates* — Auditor
at push, capability filter, side-effect budget — on the CLI surface, where
ungoverned MCP reach is already the accepted trust model. ACP (the
Zed-originated Agent Client Protocol T3 appears to standardize on — *Inference*,
from the `acp-*` probe scripts; `providers.md` still lists only Codex as
implemented, so their own breadth may lag the README's four-provider claim) is
the wire you'd speak. Push already has the keyhole version via the Codex MCP
integration. This is the move T3's architecture *cannot* make in reverse: it can
never wrap Push's governance around its wrapped agents. Push can have both bets —
own the enforcement layer, borrow the model quality — if it ever wants the
breadth without surrendering the gate.

## 8. What not to follow

- **Effect-TS end to end.** T3 bet the whole codebase on Effect, and it is
  load-bearing for their determinism story. Do not read "their async is
  deterministic *because* Effect" and conclude Push needs Effect — Push needs
  *receipts + drainable workers* (takeaway 4), which are plain-TS patterns.
  Steal the mechanism, not the framework. A wholesale Effect conversion would be
  a total rewrite with no governance payoff.
- **Electron backend-manager desktop.** T3's desktop is a heavy main process
  managing WSL/SSH/Tailscale and spawning servers. Push's Windows plan — wrap
  the web app in a thin webview, *after* mobile — is intentionally lighter and
  matches the "same lead, more reach" model. The one thing to carry over is the
  *reconnect/endpoint honesty* from takeaway 2/3, not the backend-manager
  surface area. A Windows wrapper that manages backends is how you accidentally
  build the remote-feeling thing you set out to avoid.
- **Vite+/`vp` and vendored `.repos/`.** Theo-ecosystem-specific; not Push's
  problem.

## Bottom line

T3 is the strongest external validation that Push's *shape* is right — two teams
reached the same silhouette from opposite directions. That should raise
confidence in the silhouette and *lower* confidence that any single feature is a
moat. The divergence is the real lesson: T3 optimized for **breadth of agents
behind a beautiful harness** and will feel more capable sooner (it inherits
every model gain for free); Push optimized for **depth of governance over a
runtime it owns** and is the only one of the two that can honestly promise the
gate holds.

The framing to keep from this read: T3 is *remote-by-construction*, and its own
best doc is a manual for making a remote not feel bad. Push's advantage is that
its default lane isn't a remote at all. Protect that — keep inline/lead-turn the
default, make reconnect and endpoint-honesty first-class the day mobile reaches
a local box, and the product stays a thing you're *inside of*, not a paper
airplane you throw into the wind.

Two open questions before fully trusting this read: (1) how much of T3's
multi-provider support is *live* vs aspirational — `providers.md` still says
"Codex is the only implemented provider," contradicting the README's four; and
(2) whether the remote architecture is shipped or still on paper — the doc
labels itself "architecture-first," so likely the latter.
