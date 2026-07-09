# TUI Decomposition — Testability Seam and Daemon Session Controller

Date: 2026-05-31 (Phase 0 shipped 2026-06-01; Phase 1 shipped 2026-07-09)
Status: **Current** — Phases 0–1 shipped (`cli/tui-daemon-session.ts` is the
`DaemonSessionController`; the #740 characterization suite survived the cut
unchanged and `cli/tests/tui-daemon-session-controller.test.mjs` adds
disconnect→backoff-reconnect coverage). Phase 2 (command-handler module)
remains optional — reassess only if `tui.ts` is still unwieldy. Issue #1369.
Owner: Push

Sketch for decomposing the `runTUI` monolith. Came out of PR #740 (TUI addressable
session verbs), where a reviewer asked to extract the new verb handlers out of the
closure. That extraction was declined *as a piecemeal move* — this doc is the
"do it properly" plan it pointed at. Companion to
[`Remote Control Surface Audit — TUI and Daemon Exposure.md`](Remote%20Control%20Surface%20Audit%20%E2%80%94%20TUI%20and%20Daemon%20Exposure.md).

## The problem, precisely

`cli/tui.ts` `runTUI()` is a ~6,500-line async closure. Crucially, the *leaf*
concerns are already extracted into `cli/tui-*` modules — rendering
(`tui-renderer`, `tui-render-frame`, `tui-framers`, `tui-transcript-window`,
`tui-widgets`), input parsing (`tui-input`, `tui-modal-input`, `tui-completer`),
daemon helpers (`tui-daemon-reconnect`, `-errors`, `-handshake`), and display
(`tui-theme`, `-spinner`, `-status`, `-delegation-events`, `-copy`, `-fuzzy`,
`-approval-pane`). What remains inline in the closure is **orchestration**:

- ~11 command handlers (`handleSlashCommand` + `handle*Command`)
- the **daemon-session lifecycle** — `daemonClient` / `daemonSessionId` /
  `daemonAttachToken` are read/written across **~90 sites**, assigned at **12**
  (connect, reconnect backoff, attach, start, send, teardown, remote-pairing)
- the run loop, approval flow, and the IO wiring

Two consequences:

1. **Untestable.** `runTUI` grabs `process.stdin`/`process.stdout` directly (raw
   mode, `data`/`resize` listeners) — there is no headless entry. `options` today
   is config-only (`sessionId`/`provider`/`model`/`cwd`/`maxRounds`); no IO or
   dependency injection. So every behavior in the closure — including the new
   daemon verbs — is verifiable only by manually driving a live terminal (which is
   exactly what we did for #740, via the terminal MCP).
2. **No home for cohesive state.** The daemon-session state has no owner; it's
   12 scattered assignments and ~90 reads. Any new daemon verb (or surface) has to
   reach into that ambient state, which is why the #740 handlers landed inline.

This isn't *new* debt — `tui.ts` has always followed an inline-handler convention
(no `max-lines` guard, unlike the web's `useChat.ts`). But it's the thing blocking
both safe refactoring and real unit coverage.

## Goal & ordering

**Testability seam first, then the controller.** Decomposing a 6,500-line
interactive file with zero automated coverage is flying blind — so the net comes
before the cut. The verbs land in a real home as a *byproduct* of Phase 1, not as
the goal.

```
Phase 0  IO/dep injection + headless test driver + characterization tests   ← net
Phase 1  Extract DaemonSessionController (owns state + lifecycle + verbs)    ← payoff
Phase 2  (optional) Command-handler module                                   ← polish
```

### Phase 0 — Testability seam (highest value, lowest risk) — ✅ shipped 2026-06-01

**What landed** (matches the plan below):

- `cli/tui-io.ts` — a `TuiIo` seam (stdin/stdout/stderr + signal/exit hooks).
  `runTUI` routes all 37 `process.*` references through `options.io`, defaulting
  to `createDefaultTuiIo()` (identical prod behavior). The renderer's frame
  flush (`createScreenBuffer` in `cli/tui-renderer.ts`) takes an injectable
  output sink so headless frames don't spew ANSI into the test/TAP stream.
- `options.deps` — injectable `tryConnect` (daemon-client factory) + `loadConfig`
  / `listSessions`, so a harness supplies a stub client (no socket/spawn) and a
  deterministic startup (no disk, no resume modal). **Scope note:** only the
  bootstrap `listSessions` is routed through `deps`; the resume-modal session
  ops (delete/rename, mid-closure) still use bare imports. That's intentional
  for Phase 0 (the verb tests never open the modal) — those call sites are
  Phase-1 grafting points, surfaced here rather than left implicit.
- Two test-only hooks: `options.onState` (live `tuiState`/`composer` access) and
  `options.onInputReady` (fires after the `data` listener is wired — polling the
  earlier "Connected" status raced registration and dropped keystrokes).
- `cli/tests/tui-driver.mjs` — the headless harness (fake stdin, capture stdout,
  stub daemon client recording every `request()`).
- `cli/tests/tui-session-verbs.test.mjs` — characterization tests pinning the
  #740 verbs via the real input→dispatch→send path: `/revert n`→`session_revert
  {turns}`, `/unrevert`→`session_unrevert`, `/children`→`list_children
  {includeEventDerived:true}`, `/compact`→`session_summarize {preserveTurns:6}`,
  and a `NOTHING_TO_UNREVERT` rejection rendering as a **status, not an error**.

Verified: full CLI suite green (+6), cross-surface typecheck clean, and a live
terminal-MCP smoke of the real (prod io-default) TUI — startup render,
interactive `/children` dispatch, clean Ctrl+D teardown.

**The cut:** thread IO + injectable dependencies through the existing `options`
param instead of reaching for `process.*` and constructing collaborators inline.

- Add `options.io = { stdin, stdout, isTTY, setRawMode }` defaulting to `process.*`,
  and `options.deps = { connectDaemon, loadConfig, … }` for the few hard-to-fake
  collaborators (notably the daemon client factory). Production call sites
  (`cli/cli.ts:3464`, `:3673`) pass nothing and behave identically.
- Build a `cli/tests/tui-driver.mjs` harness: a fake stdin (`EventEmitter`) to feed
  keystrokes/lines, a capture stdout, and accessors over `tuiState.transcript` to
  assert what rendered. Inject a **stub daemon client** that records the
  `{type, payload}` of every `request()` and returns canned envelopes.
- **Characterization tests** pin current behavior so Phase 1 is provably
  behavior-preserving. First targets: the #740 verbs — assert `/revert 3` sends
  `session_revert {turns:3}`, `/unrevert` → `session_unrevert`, `/children` →
  `list_children {includeEventDerived:true}`, `/compact` (daemon) →
  `session_summarize`, and that a rejected `NOTHING_TO_UNREVERT` renders as a
  status not an error. **This retroactively closes the "no automated test" gap we
  consciously punted in #740** — and unlike a formatter unit test, it exercises the
  real dispatch→send path, so it *would* catch a wiring regression.

**Stop-early value:** Phase 0 alone is a standalone win — headless TUI tests +
coverage of the verbs — even if Phases 1–2 never happen.

**Risk:** low. Additive (new optional params + a test file); no production path
changes when `options.io`/`options.deps` are omitted.

### Phase 1 — DaemonSessionController (the structural payoff) — ✅ shipped 2026-07-09

**What landed** (matches the plan below, with the boundary sharpened in
implementation): `cli/tui-daemon-session.ts` owns the trio plus the
connection-scoped state that had to move with it — reconnect backoff +
timer, the once-only autostart guard, the hello build stamp, the
per-connection event-seq cursor (`noteSeenSeq`), and the unknown-event warn
registry. `runTUI` holds one `const daemon = createDaemonSession({ …hooks })`;
the ~100 ambient reads collapsed to `daemon.*` and the scattered assignments
became controller-internal transitions. Deliberately NOT moved: the spawn
machinery and stale-runtime self-heal (they decide *whether* to connect —
injected as hooks, with the socket-close hook owning the respawn-vs-reconnect
branch), `daemonActiveRunId` (run-loop state), and every hydration/approval/
snapshot reaction (TUI render state). The verb methods are typed
(`SessionRevertPayload` etc. — the audit #7 ride-along). Phase 0's flagged
grafting points landed too: the resume-modal `listSessions`/`deleteSession`
calls now route through `options.deps`. Verified: the #740 characterization
suite passed unchanged, a new headless suite covers socket-close →
disconnect UI → 1s-backoff reconnect → verb recovery
(`cli/tests/tui-daemon-session-controller.test.mjs`), and the source guards
in `tui-session-snapshot-source.test.mjs` / `session-bearer-grace.test.mjs`
now pin both halves of the split close path.

**The cut (original plan):** extract `cli/tui-daemon-session.ts` owning the
daemon-session state and lifecycle. It holds `client` / `sessionId` /
`attachToken` privately and exposes:

- lifecycle: `connect()`, `attachOrStart()`, `ensureReady()`, reconnect wiring
  (folding in `tui-daemon-reconnect` usage), teardown
- transport: `sendVerb(type, payload)` (the bearer-attaching helper), `client`
  accessor, `onEvent` passthrough
- the verb methods: `revert(n)`, `unrevert()`, `summarize(turns)`,
  `listChildren()` / `getChild(id)` — pure logic returning data; the TUI keeps the
  transcript-rendering side

`runTUI` holds one `const daemon = createDaemonSession({ deps, onEvent })`. The ~90
ambient reads collapse to `daemon.*`; the 12 scattered assignments become internal
state transitions with one owner — the genuine ownership/seam win the new-feature
checklist ("name the coordinator's home first") asks for.

**Ride-along:** finding #7 from the audit doc (typed transcript-event payloads)
fits naturally here — the controller's verb methods are the typed boundary.

**Risk:** medium-high — it touches the connect/reconnect/send/teardown/pairing
machinery (~90 sites). **Only viable with Phase 0's net in place.** Land it as one
focused PR, re-verify live (terminal MCP) against the Phase 0 characterization
suite.

### Phase 2 — Command-handler module (optional polish)

With daemon state behind the controller, the remaining `handle*Command` functions
mostly touch `tuiState` / `scheduler` / `addTranscriptEntry` / `daemon`, so they
become cleanly extractable into `cli/tui-commands.ts` taking a small context. Do
this **only if the file is still unwieldy** after Phase 1 — and wholesale (all
handlers), never piecemeal, to preserve consistency. Lowest priority.

## What this is *not*

- Not a `lib/` promotion. These are TUI-shell-specific (they touch `tuiState` /
  rendering); per `CLAUDE.md` "shell-specific coordinators stay local." The shared
  contract is the daemon *verbs*, which already live daemon-side. Home is `cli/`.
- Not urgent. `tui.ts` isn't on fire; this earns its place as a deliberate track,
  not a reflexive cleanup. Single-user blast radius makes the risk tolerable *when*
  the net exists, but it competes with product levers like audit finding #2
  (local-daemon PR delivery).

## Cross-references

- [`Remote Control Surface Audit — TUI and Daemon Exposure.md`](Remote%20Control%20Surface%20Audit%20%E2%80%94%20TUI%20and%20Daemon%20Exposure.md)
  — the audit this track descends from; finding #7 (typed payloads) rides Phase 1.
- PR #740 — shipped the verbs inline; the reviewer extraction note is the seed.
- Root `CLAUDE.md` — "shell-specific coordinators local"; new-feature checklist
  ("name the coordinator's home first").
