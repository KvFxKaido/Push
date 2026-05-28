# Subprocess Env Scrubbing

Date: 2026-05-28
Status: Current, shipped 2026-05-28 in PR #662
Owner: Push
Related: `cli/env-scrub.ts`, `cli/config-store.ts`, `docs/security/SECURITY_AUDIT.md`

## Problem

`applyConfigToEnv()` in `cli/config-store.ts` hydrates `process.env` with provider credentials from `~/.push/config.json` at CLI startup so the runtime can read `PUSH_ANTHROPIC_API_KEY`, `PUSH_OPENAI_API_KEY`, `GITHUB_TOKEN`, and similar without re-loading the config file on every call. That's correct for the CLI process itself — but the model can emit `sandbox_exec { command: "env" }` (or `printenv`, or any equivalent shell builtin), and before this change the spawned subprocess inherited the full env. Every key the daemon held was readable by the model.

The blast radius is the union of: provider API keys, GitHub PATs, and anything the user sourced into their shell before launching `push`. None of these belong in tool output the model can serialize back into the transcript or pipe into a request body.

## Decision

Default-deny allowlist enforced at every model-invoked subprocess `spawn` / `execFile` site in the CLI. The model never sees the daemon's full env.

`scrubEnv()` in `cli/env-scrub.ts` produces a filtered `NodeJS.ProcessEnv` from `process.env` (or a caller-supplied source). Only keys that match the curated allowlist — or a documented user extension — pass through. Everything else is dropped.

## Why default-deny

The alternative ("default-allow with a denylist of known-secret prefixes") fails open the moment a new credential schema lands. A user pasting `OPENROUTER_API_KEY` into their shell would leak it through the next `sandbox_exec` until someone remembered to add `OPENROUTER_*` to the denylist. Default-deny inverts the burden: new toolchains need a one-line allowlist addition the first time they break, but no credential leak is silent.

The cost is real — every common toolchain env var has to be enumerated up front, and the allowlist needs to track the platform matrix (POSIX shells, Windows shells, Node, Python, Go, Rust, Java, Android, Docker client config). That cost is paid once at module-write time; the leak alternative would cost forever.

## What's on the allowlist

The curated set lives in `DEFAULT_ALLOW_KEYS` + `DEFAULT_ALLOW_PREFIXES` in `cli/env-scrub.ts`. Categories:

- **POSIX shell + runtime**: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `PWD`, `OLDPWD`, `LANG`, `LANGUAGE`, `TERM`, `TZ`, `TMPDIR`, `DISPLAY`, `XAUTHORITY`, `WAYLAND_DISPLAY`.
- **Windows shell + runtime**: `USERNAME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `PROGRAMDATA`, `PROGRAMFILES`, `PROGRAMW6432`, `PROGRAMFILES(X86)`, `SYSTEMROOT`, `SYSTEMDRIVE`, `COMSPEC`, `COMPUTERNAME`, `WINDIR`, `TEMP`, `TMP`, `PATHEXT`.
- **Terminal capabilities**: `COLORTERM`, `TERM_PROGRAM`, `COLUMNS`, `LINES`, `FORCE_COLOR`, `NO_COLOR` (build-tool output formatting depends on these).
- **CI signal**: `CI` (test runners gate on it).
- **Toolchains**: Node (`NODE_ENV`, `NODE_OPTIONS`, `NODE_PATH`, `NODE_NO_WARNINGS`), Python (`PYTHONPATH`, `PYTHONUNBUFFERED`, `PYTHONDONTWRITEBYTECODE`, `VIRTUAL_ENV`, `PIPENV_ACTIVE`), Go (`GOPATH`, `GOROOT`, `GOCACHE`, `GOMODCACHE`), `JAVA_HOME`, `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `CARGO_HOME`, `RUSTUP_HOME`.
- **Docker client config**: `DOCKER_HOST`, `DOCKER_CONFIG`, `DOCKER_TLS_VERIFY`, `DOCKER_CERT_PATH` (the container itself doesn't inherit our env, but the client process does).
- **Prefix matches**: `LC_*` (locale), `npm_config_*`, `NPM_CONFIG_*`, `BUN_*`.

### Platform normalization

On Windows the OS treats env-var names as case-insensitive (`Path` and `PATH` are the same variable) and Node surfaces whatever spelling the OS gave it — commonly mixed case (`Path`, `SystemRoot`, `ComSpec`, `ProgramFiles`, `ProgramW6432`, `ProgramFiles(x86)`). When `platform === 'win32'`, matching is case-insensitive against the canonical uppercase allowlist; output keys keep the source's original casing so the spawned shell still recognises them. Without this normalization, `cmd.exe` / `powershell` / anything under Program Files would fail to launch from a `sandbox_exec` subprocess on Windows.

## Extension and escape hatches

Three layers, in order of precedence:

1. **Per-call extension** — `scrubEnv({ extraAllow, extraAllowPrefixes })` for caller-specific additions (none today; reserved for future tools that need a curated extra slice).
2. **Per-user extension** — `PUSH_SCRUB_ALLOW` env var, comma-separated. A trailing `*` is a prefix match (`FOO_*` allows every `FOO_…`). Also writable via `config.scrub.allow` in `~/.push/config.json` so the value persists across daemon restarts.
3. **Full bypass** — `PUSH_SCRUB_DISABLED=1` (or `=true`) returns the source env unfiltered. Documented as an escape hatch for debugging or for power users on trusted machines who explicitly accept the leak surface. Not the recommended setting.

## Where it's wired

`scrubEnv()` is called at every model-invoked subprocess site in the CLI:

- `cli/tools.ts:686` — the inline-mode `sandbox_exec` Docker spawn.
- `cli/tools.ts:1824` — the inline-mode `sandbox_exec` `execFile` path.
- `cli/cli.ts:262` — `push run`'s validation-check runner.
- `cli/pushd.ts:4234` — the daemon's `sandbox_exec` handler (the primary surface, since daemon-attached is the steady state for the TUI).

There is **no** equivalent wiring on the web app side: the web surface runs `sandbox_exec` against the sandbox provider (Cloudflare Sandbox or Modal), which gets a fresh container env at boot rather than inheriting the Worker's env. The scrubbing is a CLI-shell concern by construction.

## Non-goals

- **Not** a credential rotator. Scrubbing prevents leak via subprocess inheritance; it does nothing about provider keys already in the Worker's KV, in the CLI config file, or in the daemon's process memory.
- **Not** a model-output filter. If the user pastes a secret into the chat and the model echoes it back, scrubbing is irrelevant. That's a separate redaction problem.
- **Not** a sandbox-side concern. The Cloudflare and Modal sandboxes already isolate at the container boundary; their inherited env is the container image's, not the daemon's.
- **Not** retroactive on tools that don't go through these four call sites. If a future CLI surface spawns a subprocess for the model without routing through `scrubEnv()`, that surface re-opens the leak — the policy lives in the call sites, not in a wrapper around `spawn` itself. Adding a lint rule that flags raw `spawn` / `execFile` calls in `cli/` would be a natural follow-up.

## Test surface

`cli/tests/env-scrub.test.mjs` (~285 lines) covers:

- Default allowlist enumeration (every category listed above is tested for pass-through).
- Default-deny behavior (provider keys, GitHub tokens, arbitrary user-named vars all dropped).
- `PUSH_SCRUB_ALLOW` parsing (commas, whitespace, trailing-`*` prefixes).
- `PUSH_SCRUB_DISABLED=1` bypass.
- Platform normalization (Windows case-insensitive matching, POSIX exact matching).
- Output-key casing preservation on Windows (matched case-insensitively but emitted with source casing).
