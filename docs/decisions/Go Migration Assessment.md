# Go Migration Assessment

Date: 2026-07-03
Status: **Reference** — recommendation is **do not migrate any Push surface to
Go**; the underlying want ("all-in-one feel", no separate Windows daemon) is a
packaging problem, solved by shipping the existing TypeScript CLI as a Bun
single-executable binary. The enabling changes shipped on
`claude/push-go-migration-strategy-mvkkys`. Owner: Push CLI.

## Context

The proposal under evaluation (sourced from an external LLM consult): keep the
web/Workers side in TypeScript but rewrite the daemon/CLI/relay as a "Go
island" — `pushd` first — for single-binary distribution, concurrency, and
low-drama deployment. The real motivation, surfaced during evaluation, was
narrower: one artifact per platform, Windows included, without maintaining a
separate daemon build.

## Why not Go

- **The daemon is the runtime, not a transport shim.** The CLI surface imports
  **73 distinct modules from root `lib/`** — provider contract, SSE pump,
  tool dispatch/parsing/recovery, git policy, context memory, role kernels,
  capability tables. A Go `pushd` doesn't extract a skeleton; it forks the
  shared runtime that "cross-surface semantics live once in `lib/`" exists to
  prevent forking. Every tool-protocol change, provider quirk, and budget rule
  would ship twice, drift-guarded only by hand.
- **Safety seams don't survive reimplementation.** `lib/git/policy.ts`
  (blocked checkout/switch forms, remote-mutation blocks, fail-closed Auditor
  gates) is security-relevant command parsing. A second implementation is the
  gate-one-path-forget-the-sibling asymmetry the PR self-review checklist
  exists to catch — at codebase scale.
- **It moves against tracked convergence.** The TUI/daemon is slated to
  converge onto the web `inline` lane (Agent Runtime Decisions §10). A Go
  rewrite freezes the daemon on the diverged model in a language that can't
  consume the convergence work.
- **The Go wins don't apply.** The workload is IO-bound (SSE, subprocess
  supervision, file watching) — no CPU-parallel core for goroutines. The
  Windows named-pipe transport already existed in `pushd.ts`.

## What shipped instead

`bun build --compile --no-compile-autoload-dotenv cli/cli.ts` now produces a
self-contained `push` binary (daemon included) and cross-compiles to
`bun-windows-x64` / `bun-darwin-arm64` / `bun-linux-arm64` from one host. The
dotenv flag is load-bearing: without it the compiled binary auto-loads `.env`
/ `.env.local` from cwd into its own `process.env` — ahead of
`applyConfigToEnv()` and the `env-scrub` allowlist — so any repo the user
cd's into could inject provider keys or `PUSH_*` flags (verified on Bun
1.3.11). Config comes from `~/.push/config.json` only. Two runtime fixes were
required, plus CI:

1. **Entry guard** (`cli/cli.ts` `isDirectRun`): single-executable builds embed
   the bundle at a virtual path the `cli.<ext>` regex can't see;
   `import.meta.main` is the authoritative signal there and is undefined under
   tsx imports, so test imports stay inert.
2. **Daemon spawn detection**: compiled builds have no sibling `pushd.<ext>`
   on disk, so `daemon start` re-execs the binary with an internal
   `daemon __run` action that runs `pushd`'s exported `main()` in-process.
   Platform trap encoded in the code comments: Bun's embedded-bundle root is
   extensionless on Linux (`/$bunfs/root/<name>`) but keeps `.mjs` on Windows
   (`B:\~BUN\root\cli.mjs`) — detection must check the resolved path exists on
   disk, not the extension. Both spawn branches emit symmetric structured logs
   (`pushd_spawn_mode_script` ↔ `pushd_spawn_mode_self_exec`).
3. **CI** (`ci.yml` `cli-binary` job): compile + help/daemon-lifecycle smoke on
   a ubuntu + windows matrix (the failure mode is a binary that exits 0 doing
   nothing — invisible to every other job), cross-compile build checks, and
   artifact upload on manual runs. Bun is pinned; bump deliberately.

## Known limits

- Binaries are ~60–115 MB (embedded Bun runtime). A Go binary would be ~15 MB;
  accepted as the cost of zero runtime fork.
- `@huggingface/transformers` (local embeddings, native ONNX) cannot embed; it
  resolves from `node_modules` at runtime when present, else the existing
  optional-dependency fallback applies.
- The smoke covers help + daemon lifecycle; TUI and live provider runs are
  validated manually, not in CI.
