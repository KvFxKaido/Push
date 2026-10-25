---
name: device
description: Build, install, and validate the Push Capacitor Android APK on a connected device, and read on-device logcat. Use when checking native/Capacitor/Kotlin behavior on the Moto G, or any on-device behavior the web tests can't prove.
allowed-tools: Bash, Read, Edit
user-invocable: true
proactive: false
---

# /device — APK build + on-device validation

Drives the physical Android device (Moto G, `adb`) for Push. Encodes the footguns
from the native-checkpoint device work so they don't bite again.

## FIRST: rebuild or just deploy? (the decision that wasted the most time)

The Capacitor shell loads its **frontend from the deployed Worker** (`server.url`
in `app/capacitor.config.ts` → `push.ishawnd.workers.dev`). So **what reaches the
device depends on where the change lives:**

| Change is in… | Reaches device via | APK rebuild? |
|---|---|---|
| Frontend (`app/src/**` TS/React) | deploy + reload | **No** |
| Worker (`app/worker.ts`, `app/src/worker/**`) | deploy + reload | **No** |
| Native plugin (`plugins/capacitor-native-git/**` Kotlin) | **APK** | **Yes** |
| `app/android/**`, `capacitor.config.ts` | **APK** | **Yes** |
| Build-time `VITE_*` flag | Workers Builds → Build Variables + redeploy | **No** (see below) |

If the change is frontend/Worker only: merge → Workers Builds deploys (~2 min) →
**force-stop + reopen** the app (below). No rebuild. If it touches native/Kotlin/
Capacitor: rebuild the APK.

`VITE_*` flags are inlined at `vite build` time, and the WebView loads the
*deployed* bundle — so a flag in `app/.env.local` + an APK rebuild does nothing
on its own. Either set it as a Workers Builds build variable and redeploy, or
for a temporary local test comment out `server.url`, then sync + install (and
revert afterwards — see Gotchas).

## Rebuild + install (native changes)

```bash
# Windows host (Android Studio + adb live there).
# JDK 21 is required — Capacitor 8 fails under the default Temurin 17 with
# "invalid source release: 21". Android Studio's bundled JBR is 21.
export JAVA_HOME="/c/Program Files/Android/Android Studio/jbr"
cd "$(git rev-parse --show-toplevel)/app" && pnpm run android:sync \n  && cd android && ./gradlew installDebug --console=plain
```

- **Always `android:sync` first** (build + `cap sync android`, same as CI). Gradle
  only packages the generated `capacitor.config.json` + web assets, which are
  gitignored — skipping sync installs a stale config, or no bundle at all on a
  fresh checkout.
- **Never pipe gradle through `| tail`** — it masks the exit code; a `BUILD FAILED`
  then reports exit 0 and looks like success. Read the file or grep `BUILD`.
- Run long builds with `run_in_background: true` (no `| tail` needed then).
- Only `:capacitor-native-git` Kotlin changed? `./gradlew :capacitor-native-git:testDebugUnitTest`
  runs the JVM unit tests fast (same JDK 21) before a full install.

## Logcat (read what the app actually did)

```bash
adb logcat -c                                  # clear
adb shell am force-stop com.push.app           # fresh WebView: pulls latest JS
                                               # from server.url AND drops the
                                               # stale CORS preflight cache
# then stream filtered, in the BACKGROUND:
adb logcat -v time | grep --line-buffered -iE "<event-regex>"
```

- JS `console.log(JSON.stringify(...))` lands under tag **`Capacitor/Console`**
  (logcat truncates lines at ~4 KB — don't trust a cut-off size).
- Native `android.util.Log` lands under your own tag.
- The Capacitor bridge trace (`To native (Capacitor plugin): … methodName: X`)
  shows which native plugin methods actually got called — gold for "did it even
  reach `commitDelta`?".

## Drive the app via the user

I can't tap the UI. State what the user should do in the app (make an edit, start
a run, hit Restore), wait for the debounce/action, then read the logcat capture.
Be specific about how many edits and why (e.g. "first edit seeds the base = full
capture; second is the delta").

## Gotchas

- **cwd drift:** a background command's `cd` leaks into the foreground Bash cwd.
  Anchor paths on `$(git rev-parse --show-toplevel)` or you'll get `app/app/...`
  doubling.
- **`run-as` on debug builds:** `adb shell run-as com.push.app` can read app-private
  storage (e.g. pull a checkpoint repo to inspect with host git) — useful for
  diagnosing without another rebuild.
- **Temp device-test edits** (commenting `server.url`, a flag-on `app/.env.local`)
  leave the device on a stale local bundle — revert them and rebuild a normal APK
  when done, or the phone stops following production.
- Device may drop USB after sleep; `adb devices` to confirm, re-plug if `(no device)`.
