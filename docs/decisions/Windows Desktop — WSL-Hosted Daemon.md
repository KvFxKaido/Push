# Windows Desktop — WSL-Hosted Daemon (Option B)

Date: 2026-06-21
Status: **Draft** — design agreed (Option B; "WSL required" accepted). Validating
with B-WSLg before building the native shell; implementation still needs an owner
commitment. Owner: Push CLI/desktop.
Progress: the Electron shell's Capacitor wiring has landed as the scaffolding path
for Phase 2's "Electron Windows shell" — `@capawesome/capacitor-electron` dep +
`electron:setup`/`sync`/`open`/`run` scripts + `ensure-capacitor-electron.mjs` guard
+ docs. First scaffold walked end-to-end 2026-07-18 (Windows box): bootstrap,
sync, and launch all work. **Load mode is bundled, not remote-hosted** — the
runtime ignores `server.url` (verified against plugin source + live launch) and
serves the synced `dist/` at `capacitor-electron://localhost/`; remote load only
via `CAPACITOR_ELECTRON_DEV_SERVER_URL`, which is dev-server mode with relaxed
CSP (escape hatch, not the shipping loader — a first-class remote mode is an
upstream feature request). `app/electron/` is committed source as of 2026-07-19
(PR #1541, mirroring `app/android/`): platform config + `main.ts` + its own
lockfile tracked, regenerated halves gitignored, and the shell's build proven
self-contained (tsc passes with the repo workspace's `node_modules` absent).
The WSL direct-loopback daemon client (below) is untouched — that, not the
shell scaffold, is what moves this doc past Draft.

## Problem

We want to ship Push as a Windows desktop app eventually. Every surface targets
the same single conversational lead, and the value of the desktop app (over the
web PWA, which already runs in a window) is **local reach** — the agent operating
on the user's real machine, which is exactly what `pushd` provides today.

But `pushd` is Unix-shaped in three places that don't translate to native
Windows:

1. **File permissions.** Tokens / relay creds / allowlist / audit log are written
   `0600`/`0700`; `chmod` is a no-op on Windows (secrecy would have to lean on
   profile-dir ACLs instead).
2. **Shell / exec.** The daemon's whole job is running real local commands; on
   native Windows the shell is cmd/PowerShell, not bash — quoting and path
   handling diverge (e.g. a `node -e '…'` command breaks under cmd.exe).
3. **(Already solved) transport.** `pushd` already speaks Unix domain socket on
   POSIX and a Windows named pipe (`getSocketPath()` branches; named-pipe path at
   `cli/pushd.ts`), so the IPC layer is not the problem.

The question is how to give the Windows desktop app local reach without owning
the shell-portability problem forever.

## Decision

**Option B: run `pushd` inside WSL, with a thin Windows GUI as a client.** "WSL
required" for the desktop target is accepted.

The daemon runs on Linux (in the user's WSL), where Unix sockets, `0600`, and
bash all work natively — so problems #1 and #2 *disappear* rather than getting
ported. The Windows GUI is a client of the WSL daemon.

**Rejected — Option A (native Windows daemon):** port `pushd` to run as a native
Windows process. Transport is already there, but it would own shell-quoting and
ACL portability **forever**, and the shell seam never fully closes. Not worth it
when the daemon's job is running dev commands and WSL is where dev commands are
sane on Windows.

## Key enabler — the bridge is already built

`pushd` already runs a **loopback-only TCP WebSocket server** (`127.0.0.1`,
ephemeral or env-pinned port, Bearer-token auth on every upgrade —
`cli/pushd-ws.ts`), the same transport the TUI and (via relay) the phone use.
WSL2 forwards `localhost:<port>` from Windows into a WSL2 loopback listener, so a
Windows process can reach the WSL daemon at `ws://localhost:<port>` with a device
token **with no new transport code**. Pairing/auth (device + attach tokens,
origin check) already exists.

Net: the daemon barely changes. The work is the Windows shell + WSL glue, not
porting `pushd`.

## Phasing

### Phase 1 — B-WSLg (validate; days)

Ship the existing Electron-wrappable `app/` as a **Linux** build, launch it
inside WSL, and render it on the Windows desktop via **WSLg**. GUI and daemon
both live in WSL → Unix socket as today, **zero** new transport/glue. Purpose: a
fast end-to-end proof that the whole stack (daemon + GUI + sandbox/relay) works
as a desktop window before investing in the native shell.

Tradeoff accepted for Phase 1: it's a Linux-app-on-Windows feel, depends on WSLg
specifically, and distributes/updates from the Linux side. That's fine for
validation.

### Phase 2 — B-native (product; weeks)

A native Windows Electron shell loading the same `app/` PWA, talking to the WSL
daemon over `ws://localhost:<port>`. Native window / installer / auto-update.

New work (none of it is porting the daemon):

- **Electron Windows shell** — owns the window, installer, update; loads `app/`.
- **WSL daemon lifecycle from Windows** — on launch, ensure `pushd` is up in the
  chosen distro (`wsl.exe -d <distro> -- …`) and discover its `port` + device
  token (they live in `~/.push/run/` *inside* WSL; read via `\\wsl$\<distro>\…`,
  `wsl.exe cat`, or a small pairing handshake).
- **App ws client: direct-loopback mode** — connect to `ws://localhost:<port>`
  instead of the Worker relay. The TUI already does direct loopback, so the
  pattern exists; this exposes it to the web client.
- **First-run UX** — distro selection, start the daemon, mint/read the token
  (largely the existing pairing flow, same-machine).

## Consequences

- **Repos live in the WSL filesystem.** The daemon's reach is WSL-native paths
  (`~/projects/…`, fast); Windows drives are reachable via `/mnt/c` but hit the
  WSL2 cross-filesystem perf cliff. The GUI should surface WSL-resident repos as
  the first-class thing and steer users away from `C:\…`.
- **WSL is a hard dependency** of the desktop product (accepted).
- **Native-Windows `pushd` is explicitly NOT a product target.** The remaining
  native-Windows `test:cli` failures — `pushd` daemon allowlist path semantics,
  `sandbox_exec` cwd representation, the eval-harness shell-quoting — are
  deprioritized; they only matter for a native-Windows daemon we've decided not
  to build. Run the `pushd` suite in WSL/Linux.
- **The CLI-on-native-Windows fixes from 2026-06-21 still stand.** The Windows
  portability fixes shipped that day (atomic-rename `EPERM` retry, CRLF-tolerant
  skill parsing, POSIX-normalized file-reference + backup paths) remain valuable
  for someone running the *plain `push` CLI* in cmd/PowerShell without the GUI —
  but they are not load-bearing for the WSL-hosted desktop product.

## Open questions

- **Discovery/lifecycle handshake** for Phase 2: exact mechanism for the Windows
  app to learn the WSL daemon's port + token (filesystem read vs `wsl.exe` vs
  pairing).
- **Distro selection** when the user has more than one WSL distro.
- **Does Electron main host any coordinator**, or stay a pure client of the WSL
  daemon? (Lean: pure client.)
- **Update/distribution split** in Phase 2 (Windows-side app update vs the WSL
  daemon's own versioning).

## Related

- [`Agent Runtime Decisions.md`](<Agent Runtime Decisions.md>) §10 — single
  conversational lead; CLI/daemon as that lead "with more reach."
- [`CLI Worktree Sandbox.md`](<CLI Worktree Sandbox.md>) — the local lead's
  isolation model.
- [`Platform, Sessions, and Sandbox Decisions.md`](<Platform, Sessions, and Sandbox Decisions.md>)
  — relay, device/attach tokens, transport seams the desktop client reuses.
