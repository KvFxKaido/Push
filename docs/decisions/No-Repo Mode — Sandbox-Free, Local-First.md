# No-Repo Mode — Sandbox-Free, Local-First

Date: 2026-06-28
Status: **Draft** — proposed; no code yet. Owner: Push mobile/runtime.
Revised 2026-06-29: web *retires* no-repo (was a bare-chat probe); repo-mode device
durability is mapped onto the existing Native Checkpoint Store, so local mode's blocker
is the native file-CRUD bridge, not storage.
Tracking: [#1226](https://github.com/KvFxKaido/Push/issues/1226) (sequencing).

Related: [`Native Git Runtime Integration.md`](<Native Git Runtime Integration.md>) (Deferred —
the live-native-push path; its gates are *out of scope* here because no-repo never
pushes from native), [`Native Checkpoint Store.md`](<Native Checkpoint Store.md>)
(Current — the device-validated native git engine + `filesDir` storage this builds on).

## Motivation

No-repo mode began as **onboarding scaffolding**. Onboarding now runs through GitHub
auth, so the original reason for the mode is gone — keeping it as-is preserves a lane
whose purpose already died.

The shape that fits the app today is **local git for projects that may or may not go
to GitHub**. Writing projects are the clarifying case: prose needs **no execution**,
which deletes the single hardest blocker in the mobile-local arc (an on-device
toolchain). What's left is file editing + local git history + optional push — all of
which the native shell can already do or nearly do.

The cut is a full **retire on web**, not bare-chat retention. Two reasons the original
"keep bare chat as a probe" framing missed: (a) this is a sole-user deployment, so
*removal* is the cleaner signal — a gone surface announces itself immediately, where a
stripped-but-present one just lingers; (b) bare web chat would still route to the
foreground Orchestrator loop (`repoBranchReady === false`), so *removing* web no-repo —
together with the inline-delegation flag retirement — is what lets `runRoundLoop` be
deleted. No-repo survives **native-only** as local mode.

## Context — current state (grounded)

- **Mode vocabulary.** `WorkspaceMode = 'repo' | 'scratch' | 'chat' | 'local-pc' | 'relay'`
  (`app/src/types/index.ts:73`). `WorkspaceSession` is a tagged union of the same kinds
  (`types/index.ts:156-161`).
- **Where mode is set.** `useProjectInstructions.ts:206-249` branches `workspaceSession.kind`:
  - `chat` → `{ includeGitHubTools: false, mode: 'chat' }`, web_search only, **no sandbox**
    (`:212-221`).
  - `scratch` → `{ includeGitHubTools: false, mode: 'scratch' }`, **cloud sandbox**, no GitHub
    (`:222-231`).
  - repos present → `{ includeGitHubTools: true, mode: 'repo' }` (`:232-238`).
- **Routing.** No-repo workspaces (chat / scratch / local-pc) are never inline-eligible and
  fall through to the **foreground Orchestrator loop** (`delegation-mode-settings.ts:122-158`).
  Retiring web no-repo removes web's only no-repo→loop route; with the inline-delegation flag
  retired, the web Orchestrator loop (`runRoundLoop`) becomes deletable. Native local mode runs
  the native-inline transport, not the loop.
- **Tool-protocol selection.** `orchestrator.ts` branches on `workspaceContext.mode` — a chat
  block (`:371,396,436,482`) and `LOCAL_PC_TOOL_PROTOCOL` pushed for local-pc (`:502`),
  `SANDBOX` protocol otherwise.
- **`local-pc` is the precedent that matters.** It is a no-repo, `sandboxId: null` session whose
  `sandbox_*` tools (`exec` / `read_file` / `write_file` / `list_dir` / `diff`) are **rebound to
  the pushd daemon** instead of the cloud sandbox. It ships with its own
  `LOCAL_PC_TOOL_PROTOCOL` (`sandbox-tool-detection.ts:625`) and a "no `/workspace`, real host
  paths, NO GITHUB REPO bound, no commit/push/pr" context block
  (`workspace-context.ts:187-231`). It already honors "no cloud sandbox."
- **Native git.** `capacitor-native-git` exposes `clone` / `fetch` / `push` / `commit` /
  `createBranch` / `switchBranch` / `status` + checkpoint ops (`plugins/.../definitions.ts`),
  device-validated. The `app/src/lib/git-session.ts` selection seam (`sandbox` vs `native`)
  **shipped** but the native arm is **dormant** — nothing registers an on-device working copy
  (`app/src/lib/git-session.ts:95,104-116`). There is **no native file CRUD**
  (`read`/`write`/`list`) yet.

## The invariant we're completing

**"No-repo never touches the cloud sandbox."** This is already true for `chat` (no files),
`local-pc`, and `relay` — all `sandboxId: null`. **`scratch` is the lone violator**: the only
no-repo kind that spins a cloud sandbox. Removing scratch's sandbox doesn't introduce a new
rule; it makes an existing 3-of-4 invariant uniform.

## Decision

1. **Retire no-repo on web; collapse `{chat, scratch}` into one native-only umbrella.** The web
   composer becomes **repo-only** — no bare chat retained. The collapsed no-repo umbrella exists
   **native-only**, behind `isNativePlatform()`. Scratch's cloud sandbox is retired.
2. **File ops gate behind the native shell** — `isNativePlatform()` (the probe `git-session.ts`
   already uses) + a `VITE_NATIVE_*`-style flag (the checkpoint-store pattern). Off-native there is
   no no-repo mode at all; native shell → file ops on → local-first project.
3. **APK no-repo file ops = `local-pc`'s profile on the native transport.** Reuse the local-pc
   tool *contract* — the no-`/workspace` / no-remote context block and the `sandbox_*` tool
   surface — via a **native near-clone** of `LOCAL_PC_TOOL_PROTOCOL` (`NATIVE_TOOL_PROTOCOL`) with
   the **daemon-specific framing stripped**: its body opens "connected to a local pushd daemon"
   (`sandbox-tool-detection.ts:626`), which a native session has no concept of — reusing it
   verbatim would leak daemon framing and contradict the "keep native free of daemon assumptions"
   rule below. Bind the protocol to the **native plugin** (JGit + a new file-CRUD bridge) instead
   of the daemon socket. This is the `SandboxProvider`/backend-selection pattern a third time
   (cloud sandbox, pushd daemon, **native plugin**).
4. **Repo mode is unchanged here.** "Lean on local fs where possible on APK" is a *later*
   increment whose hard part is the **device↔sandbox coherence seam** (two live copies of the
   tree once execution forces a cloud round-trip). Explicitly **out of scope** for this doc —
   named so it isn't discovered at review time.

> **Repo-mode device durability is not new work here.** Capturing the cloud-sandbox tree to the
> device and restoring it is the **Native Checkpoint Store**
> ([`Native Checkpoint Store.md`](<Native Checkpoint Store.md>) — Current, `VITE_NATIVE_CHECKPOINTS`,
> device-validated 2026-06-23). Local mode **reuses its substrate** (`filesDir` storage + native git
> engine + durable-local security model), so local mode's blocker is the native **file-CRUD bridge**,
> not storage. The remaining checkpoint-store question is GA-ing its flag, not building it. That
> device backup is a *one-way mirror* (cloud canonical while alive; device copy for restore-after-
> loss) — distinct from, and far lighter than, the two-live-tree coherence seam deferred above.

### Why `local-pc` is the template, not a reason to invent a new runtime

The capability profile is **identical**: local filesystem, real paths, no `/workspace`, no
remote, no GitHub tools, `sandbox_*` rebound to a non-cloud backend. `local-pc` already paid for
the prompt / protocol / context-block work and its tests (`sandbox-tool-detection.test.ts:324`
pins "no `/workspace`" leakage). The APK mode **inherits** all of it. The only genuine delta is
**transport** — daemon socket → in-process native plugin.

### New `WorkspaceSession` kind — `'native'` (decided)

Add a **`kind: 'native'`** carrying an on-device binding (`dir` under `filesDir`),
`sandboxId: null`, mirroring `local-pc`'s contract. `WorkspaceMode` gains `'native'`.

**Decided: a distinct kind, not a `transport: 'native'` tag on `local-pc`.** The binding shapes
differ — local-pc carries a daemon `LocalPcBinding` + attach token + repo allowlist; native
carries only a dir — and a transport tag would drag those daemon assumptions (allowlist,
`PATH_OUTSIDE_WORKSPACE`, attach token) onto a path that has none. UI lists already branch on
`kind` (`RepoChatDrawer.tsx:205` separates local-pc; `workspace-chat-route-builders.ts:347` skips
local-pc/relay), so a new kind slots into the existing dispatch rather than overloading it. The
rule: **share the tool *contract* — a native near-clone of `LOCAL_PC_TOOL_PROTOCOL` with daemon
framing removed — and keep the *session kind* distinct.**

## Build ledger — reused vs. new

**Reused (already shipped / validated):**
- `git-session.ts` native arm + `isNativePlatform()` gate.
- `capacitor-native-git`: `clone` / `commit` / `branch` / `status` / `fetch` / `push`.
- The local-pc tool *contract* — the no-`/workspace`/no-remote context block + the `sandbox_*`
  tool vocabulary + its "no `/workspace`" leakage tests (`sandbox-tool-detection.test.ts:324`).
- Foreground Orchestrator-loop routing for no-repo (`delegation-mode-settings.ts`).
- The checkpoint store's native git engine, `filesDir` app-private storage, and durable-local
  security model (retention cap, `Clear all` purge, sensitivity marking).

**New (to build):**
- **Native file-CRUD bridge** — `readFile` / `writeFile` / `listDir` / `edit` / `diff` over the
  working-copy dir. Plain Kotlin file I/O (JGit only for `diff`). The plugin has **none** today;
  this is the Option-2 beachhead and what "seamlessly browse local files" requires.
- **Native `sandbox_*` execution path** — a backend selector at the tool-execution seam
  (`web-tool-execution-runtime.ts` / `sandbox-client.ts`) that targets the native bridge when the
  session kind is native, the way local-pc targets the daemon.
- **`NATIVE_TOOL_PROTOCOL`** — a near-clone of `LOCAL_PC_TOOL_PROTOCOL` with the daemon intro
  replaced by native-shell framing (no daemon, no attach token, no allowlist); same
  no-`/workspace`/no-remote contract. Keeps native prompts from misdescribing their transport.
- **`git init` lifecycle + working-copy registry** that flips the dormant `git-session.ts` arm
  (`:95`). The `Native Git Runtime Integration.md` "clone-on-session" increment, **simplified**:
  `git init`, no auth, no remote.
- **`WorkspaceSession` `'native'` kind + binding**, and the chat/scratch collapse below.
- **Capability-table axis** in `lib/capabilities.ts` for "file ops iff native," with
  **drift-detector coverage** (`cli/tests/protocol-drift.test.mjs` /
  `daemon-integration.test.mjs`) — the conditional must live in the table, not a hardcoded branch,
  or the prompt surface and tests go stale the first time the flag flips.

## Collapse touchpoints (the chat/scratch merge)

- `types/index.ts:73,156-161` — shrink `WorkspaceMode`; collapse the `chat`/`scratch` arms of
  `WorkspaceSession` (add `native`).
- `useProjectInstructions.ts:206-249` — replace the `chat` and `scratch` branches with one
  no-repo branch carrying a `fileOps: boolean` derived from the native probe.
- `orchestrator.ts:371,396,436,482,502` — fold the `chat` blocks into the no-repo path; select
  `LOCAL_PC_TOOL_PROTOCOL` for native file-ops sessions.
- `App.tsx:505-609`, `chat-management.ts:54` — routing/persistence branches on `mode === 'chat' |
  'scratch'`.
- `workspace-context.ts:255-315` (`buildSessionCapabilityBlock`) — the mode-conditional sandbox /
  workflow fields (note `writableRoot` already nulls for local-pc at `:280-282` — native follows
  the same rule).
- UI mode filters: `RepoChatDrawer.tsx`, `RepoLauncherPanel.tsx`, `ComposerDraftScreen.tsx`,
  `LauncherHomeContent.tsx`.

## Sequencing

1. **Web retire (pure refactor, no device).** Composer becomes repo-only; retire the scratch
   sandbox path; remove chat. Ships independently, fully CI-testable, reversible. *Unblocks
   deleting the web Orchestrator loop (with the inline-delegation flag retirement).*
2. **GA the Native Checkpoint Store** for repo-mode device durability. Already built +
   device-validated; the work is widening `VITE_NATIVE_CHECKPOINTS` toward default-on once
   confident — not a new build. Proves the shared `filesDir`/native-git substrate local mode reuses
   (the cheap-consumer validation of the keystone is *already done*).
3. **Native file-CRUD bridge + native `sandbox_*` execution path** (Kotlin + JS). The real long
   pole; storage already exists. Device-validate `read`/`write`/`list`/`edit`/`diff` on the Moto G.
4. **`git init` lifecycle + `'native'` session kind + flip the `git-session.ts` arm.** APK no-repo
   = local-first project, behind the `VITE_NATIVE_*` flag.
5. **Optional GitHub sync.** Push first (solo authors push, not pull — native `push` + token
   wiring already exist at `git-session.ts:53`). `git remote add` graduates a local project.

*Parallel/independent:* retire the inline-delegation flag → delete the web Orchestrator loop
(`runRoundLoop`), unblocked by step 1.

## Out of scope (deferred, not rejected)

- **Repo-mode local-fs lean on APK** — the device↔sandbox coherence seam (two *live* trees). Its
  own increment/doc. Distinct from the Native Checkpoint Store's device backup, which is a one-way
  mirror (cloud canonical while alive; device copy for restore-after-loss) — far lighter than two
  live peers.
- **On-device execution** — writing needs none; code does (the toolchain wall). Unbuilt.
- **Pull / merge on native local repos** — solo push dominates; the `merge`/`pull` primitive plus
  no-shell conflict UX are deferred (`fetch` exists; `merge` is unbridged JGit).
- **Native-as-live-push-to-GitHub gates** — the Deferred pushed-diff work. Only relevant if push
  leaves *from native*; routing push through a sandbox keeps the existing gates for free.
- **Web local projects** — the browser has no durable real filesystem; OPFS is not pursued. Local
  projects are APK/CLI-only by design (a conscious surface asymmetry — document, don't paper over).

## Status flip plan

Flip **Draft → Current** when sequencing steps 1–4 land and APK no-repo local mode is
device-validated on the Moto G. Note steps inline as they ship. Fold the durable parts into
[`Platform, Sessions, and Sandbox Decisions.md`](<Platform, Sessions, and Sandbox Decisions.md>)
when the arc stabilizes.
