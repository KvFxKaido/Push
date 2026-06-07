# PushGit Broker — Cross-Language RPC Seam

Status: Draft, added 2026-06-04. Strategy sketch only — no implementation commitment; needs a `ROADMAP.md` entry to graduate. Paired with [`opencode SDK Review.md`](opencode%20SDK%20Review.md) (Go-daemon-as-center-of-gravity, held out of scope by `push-runtime-v2.md`) and [`Sandbox Policy Seam.md`](Sandbox%20Policy%20Seam.md) (the host-side enforcement layer this would sit beside).

## What this is

A directional sketch for extracting Push's git read/write/policy core into a standalone **Go service** (working name `pushgit-broker`) that TypeScript talks to over a localhost RPC. It is the **narrowest** defensible first step toward "some of Push runs in Go" — chosen precisely because the seam it crosses **already exists in TypeScript** as an in-process interface, so this is "mirror a contract across the wire," not "carve a new boundary through live code."

It is explicitly **not** a proposal to rewrite `pushd`, the agent kernels, the provider streaming layer, or anything Cloudflare-Worker-native in Go. See the rationale section for why those are off the table.

## Why this is the right beachhead (and pushd is not)

The intuition that the *daemon* (`pushd`) is the natural Go beachhead is wrong on inspection: `cli/pushd.ts` is ~7.7k lines and **reuses the same engine as the CLI** — session lifecycle, approval gates, in-process delegation to Coder/Explorer/Reviewer with real streaming and tool execution. It is the agent runtime wearing a socket, not infrastructure sitting beside it. Porting it means porting `engine.ts`, `tools.ts`, the tool-dispatch kernel, and enough of `lib/`'s agent kernels to keep parity — the spine, not a limb.

The git layer is the opposite shape, and the codebase already proves it by having **factored the seam out in-process**:

- `lib/git/backend.ts` — `GitBackend`: typed, normalized git reads (`currentBranch` / `headSha` / `status`) + four sanctioned writes (`createBranch` / `switchBranch` / `commit` / `push`). Runs git through an injected argv-based `GitExec` port, so it is *already* transport-agnostic across web (`execInSandbox`) and CLI (`execFile('git', …)`).
- `lib/git/policy.ts` — `classifyGitCommand(command): GitDecision`: a **pure** function. Shell-tokenizes a command and returns a discriminated union (`passthrough` / `allow` / `route` / `block`) deciding whether a raw `git` invocation passes through, is routed to a typed branch tool, or is blocked (`no-local-merge`, `history-rewrite`). No I/O, no async, no Node idioms.
- `lib/git/push-git.ts` — `PushGit`: the facade the tool handlers compose over a `GitBackend`, adding the `PreCommitGate` seam.

Pure-function policy + an argv-port backend + a thin facade is the most Go-shaped, most network-separable, least agent-entangled cluster in the repo. A wrong call here costs one service; a wrong call in `pushd` costs the runtime.

## The fault line that makes this clean: deterministic vs. model-judged

The single most important design fact is **where the Auditor lives**. `PushGit.commit()` runs an injected `PreCommitGate` (`() => Promise<PreCommitVerdict>`) before committing; the handler builds that gate over the **Auditor**, which is an LLM call. `lib/git/` deliberately never imports `auditor-agent` — the gate is a closure passed in.

That existing discipline *is* the cross-language fault line:

| Concern | Nature | Home |
|---|---|---|
| `classifyGitCommand` policy oracle | Pure, deterministic | **Go broker** |
| reads (`status`/`branch`/`headSha`) | Deterministic subprocess | **Go broker** |
| sanctioned writes (branch/commit/push plumbing) | Deterministic subprocess | **Go broker** |
| Protect Main pre-hook | Deterministic, but needs session state (`isMainProtected`, `getCurrentBranch`) | **TS** (owns session) |
| `PreCommitGate` (Auditor) | LLM call, provider-locked, briefed | **TS** (stays orchestrator-side) |
| `branchSwitch` / `meta` routing, chat re-scoping | Orchestration | **TS** |

The broker owns everything deterministic. The model-judged gate and the session-stateful orchestration stay in TypeScript. Crucially, **the existing two-phase web flow already commits without an in-process gate** (`handlePrepareCommit` runs the Auditor at the *prepare* step, then the actual commit lands ungated) — so the broker committing without owning the Auditor is not a regression, it is the shipped shape. The broker exposes a commit RPC; the *decision* to call it stays behind the TS Auditor verdict.

This avoids the trap that sinks most "extract a service" efforts: a synchronous callback from the service back into the host (Go broker → call back into TS to run the Auditor mid-commit). We don't need it. The gate runs in TS *before* the broker's commit RPC is ever called.

## Where the broker slots in

Because the in-process seam has two layers, there are two possible injection points. The sketch picks the **lower** one for v1:

```
            ┌─────────────────────── TypeScript (web Worker / CLI / pushd) ──────────────────────┐
            │                                                                                     │
  tool      │   PushGit facade ── PreCommitGate (Auditor, stays here) ── Protect Main pre-hook    │
  handlers  │        │                                                                            │
            │        ▼                                                                            │
            │   GitBackend  ◄── (v1 seam) createRemoteGitBackend()  ── RPC client ───┐            │
            │                                                                         │            │
            └─────────────────────────────────────────────────────────────────────  │  ──────────┘
                                                                                      │ NDJSON / localhost
            ┌──────────────────────────── Go (pushgit-broker) ────────────────────────▼──────────┐
            │   policy.Classify(cmd)      backend.Status() / Commit() / Push() / Branch()         │
            │        (port of classifyGitCommand)        (port of SandboxPlumbingBackend, argv)   │
            └─────────────────────────────────────────────────────────────────────────────────────┘
```

**v1 injection point: `GitBackend`.** Implement a TS `createRemoteGitBackend(client): GitBackend` whose methods are one-line RPC calls. `PushGit` construction is *unchanged* — it already takes `{ backend, preCommit }`, so you swap the backend and keep the facade, the gate wiring, and every handler exactly as-is. This is the minimal-blast-radius slot.

(The higher seam — moving `PushGit` itself, or `classifyGitCommand`, wholesale into Go and having TS call a `commit`/`classify` RPC — is a later step, only after v1 proves the wire tax is tolerable. The policy oracle is the easiest single thing to *additionally* mirror, because it's pure; see "proving slices.")

## Transport

Reuse the shape `pushd` already speaks: **NDJSON request/response, one JSON object per line, over a Unix domain socket** (Windows named pipe), localhost-only. No new transport vocabulary, no HTTP server to harden, no port to allowlist. The broker is a child process the host spawns and owns (lifecycle, not a separately-deployed service) — same posture as the Modal sandbox being a remote, but inverted: this runs *next to* the host.

Framing mirrors the daemon's existing protocol so the drift-detector and audit-logging patterns transfer.

### Wire contract (v1)

Every request carries a `cwd` (the workspace root the broker runs git in) and an `id` for response correlation. Mutating calls carry `mutates: true` so the host can map it to its workspace-revision bump on the response (the broker does not own that cache; it just echoes the hint).

```jsonc
// → request
{ "id": "r1", "op": "status", "cwd": "/work/repo" }
{ "id": "r2", "op": "classify", "cmd": "git checkout feature/foo" }
{ "id": "r3", "op": "createBranch", "cwd": "/work/repo", "name": "feat/x", "from": "main", "mutates": true }
{ "id": "r4", "op": "commit", "cwd": "/work/repo", "message": "...", "addArgs": ["-A", "--", ".", ":!.push"], "mutates": true }
{ "id": "r5", "op": "push", "cwd": "/work/repo", "setUpstream": true, "remote": "origin", "ref": "HEAD", "mutates": true }

// ← response (reads)
{ "id": "r1", "ok": true, "status": { "statusLine": "main...origin/main [ahead 1]", "entries": [ ... ], "staged": 1, "unstaged": 0 } }

// ← response (policy oracle — the GitDecision union, verbatim)
{ "id": "r2", "ok": true, "decision": { "kind": "route", "to": "switch_branch", "args": { "branch": "feature/foo" }, "label": "git checkout <branch>" } }

// ← response (writes — the GitWriteResult shape)
{ "id": "r4", "ok": true, "write": { "ok": true, "exitCode": 0, "stdout": "[feat/x abc123] ...", "stderr": "", "error": null }, "mutated": true }

// ← response (transport/exec error — NEVER reject; mirror GitExec's resolve-not-throw contract)
{ "id": "r3", "ok": true, "write": { "ok": false, "exitCode": 128, "stdout": "", "stderr": "fatal: ...", "error": "sandbox-unreachable" } }
```

Two invariants ported from the existing contract, both load-bearing:

1. **Resolve, never reject.** `GitExec` adapters convert *both* command failure (non-zero exit) and transport error into a `GitExecResult` rather than throwing. The broker does the same: a git failure is `ok:true` at the RPC layer with `write.ok:false` inside; only a malformed-request / broker-internal fault is an RPC-level `ok:false`. This keeps the TS `GitBackend` methods returning `null`-on-failure instead of throwing at call sites, exactly as today.
2. **Validation stays a caller concern.** `GitBackend` passes ref/branch/path args through as-is and documents that callers MUST validate (e.g. `isInvalidGitRef`, leading-`-` flag-injection) before calling — the layer shell-escapes argv but does not judge ref *semantics*. The broker keeps that boundary: it argv-escapes (no shell), but the host validates ref semantics before the RPC. Don't let the language boundary tempt a silent re-home of validation.

## Go service surface

A direct port of the two pure/portable units. Signatures mirror the TS so the drift test can pin them.

```go
package pushgit

// Port of classifyGitCommand — pure, no I/O. The discriminated union becomes
// a tagged struct (Kind + the variant-specific fields), serialized to the
// exact GitDecision JSON shape above.
type Decision struct {
    Kind   string            `json:"kind"`             // "passthrough" | "allow" | "route" | "block"
    Family string            `json:"family,omitempty"` // read family / allow family
    To     string            `json:"to,omitempty"`     // route target
    Args   map[string]string `json:"args,omitempty"`
    Reason string            `json:"reason,omitempty"` // block reason
    Label  string            `json:"label,omitempty"`
}
func Classify(cmd string) Decision

// Port of SandboxPlumbingBackend, argv-based. Exec is the injected port —
// os/exec.CommandContext("git", args...) for local; a forwarding adapter for
// a remote workspace. Resolve-not-throw: returns ExecResult, never error, for
// git-level failures.
type ExecResult struct {
    Stdout   string `json:"stdout"`
    Stderr   string `json:"stderr"`
    ExitCode int    `json:"exitCode"`
    Err      string `json:"error,omitempty"`
}
type Exec func(ctx context.Context, args []string, mutates bool) ExecResult

type Backend struct{ exec Exec }
func (b *Backend) CurrentBranch(ctx context.Context) (string, bool)        // bool = present (vs detached/err → null)
func (b *Backend) HeadSha(ctx context.Context, short bool) (string, bool)
func (b *Backend) Status(ctx context.Context) (*StatusInfo, bool)
func (b *Backend) CreateBranch(ctx context.Context, name, from string) ExecResult
func (b *Backend) SwitchBranch(ctx context.Context, branch string) ExecResult // incl. depth-1 fetch fallback
func (b *Backend) Commit(ctx context.Context, message string, addArgs []string) ExecResult
func (b *Backend) Push(ctx context.Context, setUpstream bool, remote, ref string) ExecResult
```

The non-obvious behaviors that MUST port byte-for-byte (they have tests on the TS side and are the whole reason the layer is normalized):

- `currentBranch` uses `branch --show-current` (not `rev-parse --abbrev-ref`) so an **unborn branch** in a fresh repo keeps its name and detached HEAD returns null.
- `switchBranch` does the **depth-1 fetch fallback** for shallow clones before reporting failure.
- `classify`'s carve-outs: `git checkout -- <path>` and two-positional `git checkout HEAD <path>` are file-restore **allows**; ref expressions (`HEAD~1`, `main^`, `branch@{upstream}`) pass through as `mutate`; a single bare positional **routes** to `switch_branch`; `-b`/`-c` route to `create_branch`; command-substitution operands (`$(...)`, backticks) route with an empty branch (dynamic operand can't be trusted).

## What stays in TypeScript (and why)

- **The Auditor `PreCommitGate`.** LLM call, provider-locked, briefed, defaults-to-UNSAFE-on-error. Lives where the orchestration and provider lock live. Runs *before* the broker commit RPC.
- **Protect Main pre-hook.** Deterministic logic, but its inputs (`isMainProtected`, `defaultBranch`, `getCurrentBranch`) are session/UI state the host owns. Could *consult* the broker for `currentBranch`, but the policy decision stays host-side. (Fail-safe semantics — unknown branch ⇒ treat as on-main ⇒ block — must not regress.)
- **`branchSwitch` / `meta.branchCreated` routing + chat re-scoping.** The `BranchSwitchPayload` (`kind: 'forked' | 'switched' | 'merged'`) drives UI/chat routing; the broker reports *git reality*, the host decides *conversation consequence* — same split `validateActiveBranch` already encodes (verify, don't enforce).
- **`isDestructiveCommand` approval gating.** Tied to approval-mode + the host's `ask_user` surface. The *classification* could move to the broker later; the *gate* (what to do with a destructive verdict) is host UX.

## Honest cost ledger

The cons the strategy discussion named, made concrete to this slice:

- **A new language frontier from zero.** No `go.mod`, no `.go` files exist today. Even this narrow slice means a Go toolchain in CI, a second test runner, and cross-language muscle the team doesn't have yet. This slice is deliberately small *so that cost is paid against a few hundred lines, not 18k.*
- **A drift detector becomes mandatory, not optional.** Per the repo's "one source of truth per vocabulary" rule, the `GitDecision` union and the wire ops now have a TS definition and a Go definition. That needs a pinning test in the same PR (extend the `cli/tests/protocol-drift.test.mjs` strict-schema approach; the broker's JSON shapes get golden fixtures both sides assert against). Without it, the two `GitDecision`s silently diverge the first time someone adds a `block` reason on one side.
- **Two `classifyGitCommand`s until one is retired.** v1 keeps the TS `classifyGitCommand` (the `sandbox_exec` git-guard pre-hook still needs a synchronous, in-process answer — you will not RPC on every exec). So the Go port is *additive* for the policy oracle until/unless the guard path is willing to go async. The drift test is what keeps them honest. This is the single biggest "is it worth it" question and the proving slice is designed to expose it early.
- **Debugging across the boundary.** A git write that misbehaves is now two-process. The NDJSON-over-socket choice (vs. anything fancier) keeps it `socat`-inspectable and mirrors the daemon's existing audit-log story.

## Proving slices (in order)

Each slice is independently revertible and answers one risk before the next is attempted.

1. **`classify` only, additive, behind a flag.** Stand up the broker exposing just `op: "classify"`. Wire a TS `createRemoteGitBackend` is *not* needed yet — instead add a parity harness that feeds the existing `policy.test.ts` corpus to *both* the TS `classifyGitCommand` and the Go `Classify` and asserts identical `GitDecision` JSON. **This is the cheapest possible test of the cross-language contract + drift tooling**, touching zero production call paths. If maintaining this parity is already annoying at ~40 test cases, stop here — it will be agony at `pushd` scale, and you've learned it for a few hundred lines.
2. **Reads through the broker, CLI-only.** Implement `createRemoteGitBackend` for the three reads; route the CLI's `PushGit` reads through it behind `PUSH_GITBROKER=1`. Reads are idempotent and null-on-failure, so a broker fault degrades visibly, not destructively. Measures real round-trip cost and the resolve-not-throw contract end-to-end.
3. **Writes through the broker, CLI-only.** Add branch/commit/push. The Auditor gate still runs in TS before `commit`. This is the first slice that mutates a repo through Go; gate it hard, keep the local backend one env-var away.
4. **Decision: promote or shelve.** Only here do you ask whether the web/Worker side should ever talk to the broker (it can't spawn a local child process the way the CLI can — it would need the broker reachable as a sidecar, which is a materially bigger commitment) and whether the synchronous `sandbox_exec` git-guard is worth making async to retire the duplicate `classify`. If slices 1–3 were friction-heavy, shelve with the parity harness left as documentation of *why*.

## Open questions

- **Web/Worker reach.** The CLI can spawn-and-own a local Go child; the Cloudflare Worker cannot. Does the broker ever serve the web surface, or is it CLI/`pushd`/Local-PC only? (Leaning: CLI + Local-PC daemon only — the web side keeps the TS `GitBackend` over `execInSandbox`. That means the broker is a *local-execution* optimization, not a universal runtime move, which further bounds the ambition. Honest framing: this makes the broker valuable exactly where Push is most infrastructure-like and irrelevant where it's most Worker-native — consistent with "Go for bones, TS for skin.")
- **Synchronous guard vs. async RPC.** `sandbox_exec`'s git guard wants a synchronous classify. Keep the TS oracle forever as the in-process fast path and treat Go's `Classify` as the daemon-RPC path only? (Leaning yes — duplication policed by the parity test is cheaper than making a hot, synchronous guard path do IPC.)
- **Does this earn the right to more Go?** The explicit purpose of the slice is to price the cross-language tax *before* anyone proposes a Go `pushd`. A positive result is "the seam is tolerable"; it is **not** "now rewrite the daemon." That remains gated by the agent-kernel entanglement called out up top.

## Non-goals

- Rewriting `pushd`, `engine.ts`, `tools.ts`, the tool-dispatch kernel, or the agent role kernels in Go.
- Touching the provider streaming layer (`openai-sse-pump.ts`, the PushStream contract) — mid-stabilized, JS/Python-first provider churn, stays TS.
- Anything Cloudflare-Worker / Durable-Object native.
- Replacing the Modal Python sandbox.
- A separately-deployed network service. The broker is a host-spawned local child, lifecycle-owned by the host, localhost-only.
