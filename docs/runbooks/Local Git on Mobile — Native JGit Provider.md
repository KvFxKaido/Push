# Local Git on Mobile — Native JGit Provider

Date: 2026-06-22
Status: **Draft / in progress** — thin-proof slice landing; not yet roadmap-promoted.
Owner: Push

Folds the local-git experience (the GitSync daily loop — clone, browse, diff,
stage, commit, push, pull) into the Capacitor Android shell, so Push on mobile
gains a real on-device working copy instead of only driving a remote sandbox.
This is the "CLI-grade local reach, on the phone" direction: the same typed
git layer the web and CLI already use, backed on Android by a native engine.

## Why this shape

- **The seam already exists.** `lib/sandbox-provider.ts` is explicitly "remote
  *or local*", and a `'local'` sandbox provider notion is already live for the
  CLI (`PUSH_LOCAL_SANDBOX`, `pushd`'s default). The mobile local-git layer is
  the same idea with the local provider backed by **Capacitor native plugins**
  rather than Node. `app/src/lib/api-url.ts` already carries the
  `isNativePlatform()` detection seam.
- **The typed git layer is reusable as-is.** `GitBackend` (typed reads +
  sanctioned writes), `PushGit` (Auditor / secret-scan / Protect-Main gates),
  and the per-working-copy serialization lock (`lib/git/repo-lock.ts`) all sit
  above the transport. A new `GitBackend` implementation inherits every one of
  them unchanged.

## Decisions

1. **Engine: JGit** (pure Java/Kotlin), not libgit2-via-JNI. The shell is
   Capacitor/Kotlin, so JGit needs no NDK build or JNI bridge and ships full
   clone/fetch/pull/commit/push/merge with HTTPS + SSH. (GitSync uses git2-rs
   only because it is Flutter/Rust.)
2. **Typed plugin contract, not an argv `GitExec`.** The web/CLI adapters back
   the shared `SandboxPlumbingBackend` with a `GitExec` (argv → a real `git`).
   The phone has no `git` binary, and JGit has no CLI parser, so an argv port
   would mean re-deriving structured intent inside Kotlin. Instead the
   `NativeGit` plugin exposes **typed methods** and the TS side implements
   `GitBackend` directly (`NativeGitBackend`) — typed end-to-end. The one
   git-text exception is `status`, which returns porcelain v1 so the TS side
   reuses the canonical `parseGitStatusInfo` and can never drift.
3. **Reuse the lock + gates.** `NativeGitBackend` keys the working-copy lock on
   the on-device clone directory via the shared `createWorkingCopyLock`
   (extracted from `SandboxPlumbingBackend` so both backends share one
   implementation). `PushGit` wraps gate + write the same way, so a pre-push
   Auditor/secret-scan gate is atomic against a concurrent local commit.
4. **Transient auth.** Network ops take a GitHub token per call (injected from
   Push's existing token management); the plugin never persists credentials,
   mirroring the web transport boundary.

## Layering

```
PushGit (gates)  ── unchanged
   └─ NativeGitBackend implements GitBackend         app/src/lib/native-git-backend.ts
        ├─ createWorkingCopyLock(dir)  (shared lock) lib/git/backend.ts
        └─ NativeGitPlugin (typed bridge)            app/src/lib/native-git/definitions.ts
             └─ NativeGit Capacitor plugin → JGit    plugins/… (Kotlin, Phase 2)
```

`NativeGitBackend` takes the plugin as a constructor dependency and imports no
Capacitor — so it unit-tests against a mock. `native-git/plugin.ts` (the
`registerPlugin` call + a rejecting web stub) and `native-git/index.ts` (the
`createNativeGitBackend` / `createNativePushGit` factories) are the only
Capacitor-touching, native-client-only modules.

## Phases

- **Phase 1 (this slice — TS foundation):** typed `NativeGitPlugin` contract,
  `NativeGitBackend`, factories, plugin registration, and tests. Verified in
  vitest with a mock plugin. ✅
- **Phase 2 (native engine):** the `NativeGit` Capacitor plugin package —
  Kotlin `@CapacitorPlugin`, JGit dependency, the typed methods, HTTPS auth via
  `UsernamePasswordCredentialsProvider` (token), clone/fetch/push. Built and
  run on a device.
- **Phase 3 (shell + routing):** switch the Android config off the pure remote
  WebView for the local-repo surface, route file read/edit/list to the device
  filesystem for a local clone, and select the native backend when
  `isNativePlatform()`.
- **Phase 4 (GitSync-parity UX):** diff/history views, conflict resolution,
  pull-with-rebase, multi-remote.

## Verification

- **Phase 1 is verifiable in CI** (vitest over `NativeGitBackend` with a mock
  plugin; `lib/git` suites cover the shared lock refactor).
- **Phases 2+ need an Android build environment** (`npm run android:sync &&
  cd android && ./gradlew installDebug`). The Kotlin/JGit engine cannot be
  compiled or run in the headless Linux CI/dev container — on-device runs are
  the handoff for those phases.

## Open questions

- **Where the clone lives** on-device (app-private storage vs. SAF/user-chosen
  dir, as GitSync supports) and how it survives reinstalls.
- **Exec on device.** Running tests/commands locally (the Auditor's
  verification step) has no general toolchain on Android; the local provider
  may stay git+filesystem only, with exec-bearing flows still routed to the
  sandbox. Deferred.
- **SSH auth** (keys/agent) beyond the HTTPS-token path of Phase 2.
