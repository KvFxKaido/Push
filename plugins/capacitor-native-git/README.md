# capacitor-native-git

On-device git for the Push Android shell — a typed Capacitor plugin backed by
[JGit](https://www.eclipse.org/jgit/). It is the native engine behind
`NativeGitBackend` (`app/src/lib/native-git-backend.ts`); everything above it
(the `PushGit` gates, the working-copy serialization lock) is the same shared
machinery the web and CLI surfaces use.

> **Status: installed in the Android shell and device-built.** The general
> native live-push path is still dormant, but this plugin now backs the flagged
> APK-local checkpoint store (`VITE_NATIVE_CHECKPOINTS`), with capture validated
> on a Moto G. Kotlin/JGit changes still need Android Studio or an Android SDK
> runner to verify. Design + phases:
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
publishable mirror; future cleanup can dedupe by having the app import
`NativeGitPlugin` from here and dropping `app/src/lib/native-git/definitions.ts`.

## App integration

```bash
# from app/
pnpm install          # refreshes the file:../plugins/capacitor-native-git dependency when needed
pnpm run android:sync # builds the SPA and syncs web assets + plugin registration
```

The app already declares this package as `file:../plugins/capacitor-native-git`.
`cap sync` reads this package's `capacitor.android.src` and wires the Gradle
module into the committed `app/android/` project; regenerated web assets and
Capacitor plugin metadata stay ignored by `app/android/.gitignore`.

## Build & verify (on a device / emulator)

```bash
cd app && pnpm run android:sync && cd android && ./gradlew installDebug
```

Confirm at build time:

- **JGit version / Java level.** `org.eclipse.jgit:6.10.x` needs Java 11+ and
  `java.time`; `build.gradle` enables core-library desugaring for that on
  `minSdk < 26`. If you target an older toolchain, pin JGit `5.13.x` (the last
  Java 8 line) instead.
- **Checkpoint path:** build with `VITE_NATIVE_CHECKPOINTS=1`, make a workspace
  edit in the APK, and confirm `native_checkpoint_captured` plus a listed
  checkpoint. Restore remains the device-validation follow-up before this
  graduates beyond the experimental flag.
- **Live git path:** clone a small repo, read `status`/`currentBranch`, make a
  commit, and push with a GitHub token before enabling native live-push UX.

## Not yet covered (later phases)

- SSH auth (keys/agent) — Phase 2 is HTTPS-token only.
- Pull-with-rebase, conflict resolution, multi-remote — Phase 4.
- On-device exec (running tests) — out of scope; exec-bearing flows stay on the
  sandbox.
