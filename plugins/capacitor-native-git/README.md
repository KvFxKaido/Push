# capacitor-native-git

On-device git for the Push Android shell — a typed Capacitor plugin backed by
[JGit](https://www.eclipse.org/jgit/). It is the native engine behind
`NativeGitBackend` (`app/src/lib/native-git-backend.ts`); everything above it
(the `PushGit` gates, the working-copy serialization lock) is the same shared
machinery the web and CLI surfaces use.

> **Status: Phase 2, device-build-pending.** The Kotlin/JGit code here is
> written to convention but has **not** been compiled or run — the dev/CI
> container is headless Linux with no Android SDK. Build and verify it on a
> machine with Android Studio. See "Build & verify" below. Design + phases:
> [`docs/runbooks/Local Git on Mobile — Native JGit Provider.md`](../../docs/runbooks/Local%20Git%20on%20Mobile%20%E2%80%94%20Native%20JGit%20Provider.md).

## Layout

```
android/                     Kotlin Capacitor plugin (the engine)
  build.gradle               AGP/Kotlin + JGit dependency (+ desugaring)
  src/main/AndroidManifest.xml
  src/main/java/com/push/nativegit/
    NativeGitPlugin.kt        @CapacitorPlugin bridge: arg-parse, threading, JSObject shaping
    JGitEngine.kt             the JGit operations (clone/status/commit/push/…)
src/                          TS contract + registerPlugin (for standalone consumers)
```

The web app already declares the JS side (`app/src/lib/native-git/plugin.ts`
calls `registerPlugin('NativeGit')`), so it binds to the Kotlin plugin **by
name** — it does not import this package's JS. This package's `src/` is the
publishable mirror; once it is installed, dedupe by having the app import
`NativeGitPlugin` from here (drop `app/src/lib/native-git/definitions.ts`).

## Install into the app

```bash
# from app/
npm install ../plugins/capacitor-native-git   # adds the file: dependency
npm run android:sync                            # cap sync picks up the Android module
```

`cap sync` reads this package's `capacitor.android.src` and wires the Gradle
module into `app/android/` (which is gitignored/regenerated — that's fine, the
plugin is an npm dependency, so it re-links on every sync).

## Build & verify (on a device / emulator)

```bash
cd app && npm run android:sync && cd android && ./gradlew installDebug
```

Confirm at build time:

- **JGit version / Java level.** `org.eclipse.jgit:6.10.x` needs Java 11+ and
  `java.time`; `build.gradle` enables core-library desugaring for that on
  `minSdk < 26`. If you target an older toolchain, pin JGit `5.13.x` (the last
  Java 8 line) instead.
- **First end-to-end check (the thin proof):** clone a small repo, read
  `status`/`currentBranch`, make a commit, and push with a GitHub token —
  exercising `NativeGitBackend` → this plugin end-to-end.

## Not yet covered (later phases)

- SSH auth (keys/agent) — Phase 2 is HTTPS-token only.
- Pull-with-rebase, conflict resolution, multi-remote — Phase 4.
- On-device exec (running tests) — out of scope; exec-bearing flows stay on the
  sandbox.
