# Native Git Runtime Integration

Date: 2026-06-21
Status: **Current** (2026-07-08) — live native push resumed for #1352 slice 3.
Increment 2's code path is now implemented: `computePushedDiff` / push-destination
resolution run over `PushedDiffSource`, the native plugin exposes `revParse` /
`mergeBase` / `logPatch`, and native `PushGit` composes the same Protect Main,
secret-scan, and Auditor gates as sandbox. Device validation of JGit `logPatch`
output is still required before treating native push as fully proven live.
Owner: Push mobile/git.

## Context

The Android shell runs git on-device through JGit (the `capacitor-native-git`
plugin), exposed to TypeScript as `NativeGitBackend` — a third `GitBackend`
implementation alongside the web/CLI `SandboxPlumbingBackend`. The work of making
that backend *live* (not just built-and-tested) is staged as increments:

1. **Selection seam** — *shipped* (PR #1069, `ef1c046c`). `app/src/lib/git-session.ts`
   maps a session to its `GitBackend` via a tagged `GitSessionBinding`
   (`sandbox` → id, `native` → dir). The native arm is **dormant**: it only
   resolves once an on-device working copy is registered, which nothing does yet.
2. **Pushed-diff source + gate unification** — *this doc's active decision*.
3. **Clone-on-session lifecycle** — registers the on-device working copy, flipping
   the dormant arm live.
4. **Private-repo auth + local-working-copy UX.**

A constraint discovered during increment 1 (Codex P2 on PR #1069) reordered the
ladder: **increment 2 is a prerequisite for going live, not a later nicety.**
The seam routes *reads* to the active backend, but every *write* (commit/push/
branch gate) still goes through `createSandboxPushGit`. If increment 3 flipped
native live before 2 landed, a native session would read from the device clone
while its push gates scanned the sandbox — reads and writes split across
backends. So the gate path must be unified onto the active backend *before* the
clone lifecycle makes native real.

## Problem

The pre-push gates — secret scan, Protect Main, Auditor-at-push — are already
backend-agnostic: `makeSecretScanPrePushGate` / `makeAuditorPrePushGate` take a
`getDiff: () => Promise<string | null>` closure, and `makeProtectMainPrePushGate`
takes `getCurrentBranch` (which `NativeGitBackend` already implements). The entire
gate stack composes over native **the moment a native `getDiff` exists.**

The blocker is producing that diff. The gates inspect what `git push` will
actually upload — the **per-commit patch series** (`git log -p base..ref`), not a
working-tree preview and not the net tree diff (a secret added then removed across
commits is invisible to `git diff base..ref` but is still uploaded with the
earlier commit). `computePushedDiff` (`lib/git/pushed-diff.ts`) computes this
*uncapped* through the `GitExec` argv port, with a security-critical base
resolution:

1. `<remote>/<destination-branch>` if it exists, else
2. the merge-base with `<remote>/HEAD` (a new branch with no remote counterpart), else
3. **no baseline → scan the ref's whole history** (fail-safe: a fresh/empty remote
   scans everything rather than fail-open).

This logic carries a trail of hard-won fixes (the per-commit-not-net-tree Codex
P1; the fail-safe-on-no-baseline rule). It must not be duplicated.

The native backend has **no `GitExec` argv port** — by deliberate design
(`definitions.ts`): JGit has no command-line parser, so the plugin exposes typed
methods, not `git <args>`. So `computePushedDiff(execInSandbox-style-exec)` has
nothing to bind to on-device. `computePushedDiff` needs only four git operations:
`symbolic-ref HEAD`, `rev-parse --verify <ref>`, `merge-base a b`, and
`log -p <range>`.

## Decision

**Option E — refactor `computePushedDiff` / `resolvePushDestination` onto a typed
`PushedDiffSource` port** (a four-method interface), with two adapters:

- `pushedDiffSourceFromGitExec(exec)` — wraps the existing argv path, preserving
  web-sandbox and CLI behavior byte-for-byte (the existing tests are the safety net).
- `pushedDiffSourceFromNativePlugin(plugin, dir)` — typed JGit calls.

The base-resolution algorithm stays **once** in `computePushedDiff` over the port.
JGit only provides dumb primitives. This matches the existing `status` → porcelain
precedent (JGit emits CLI-format text; TypeScript owns the logic and reuses the
canonical parser) and the repo's cross-surface rule: one source of truth per
vocabulary, with a drift-detector test.

### Why not the alternatives

- **Option A — one fat JGit method** `pushedDiff(dir, remote, ref)` that does the
  whole base resolution + `log -p` in Kotlin and returns the text. Minimal TS and
  one bridge call, but it **duplicates the security-critical base-resolution
  algorithm in Kotlin**. The next time the TS algorithm gains an edge-case fix,
  the mobile gate silently keeps the old behavior — and "old behavior" for this
  code can mean fail-open. For security-critical logic, a second source of truth
  is a regression vector, not a convenience. Rejected.
- **Option F — a TS `GitExec` shim over the plugin** that pattern-matches the four
  argv shapes `computePushedDiff` emits and dispatches to typed JGit primitives.
  Zero refactor of the algorithm, but it reintroduces exactly the argv-parsing the
  typed plugin design rejected, in a brittle form (fragile to any change in the
  emitted argv). Rejected.

Option E costs a refactor of load-bearing code, but the `fromGitExec` adapter plus
the existing `pushed-diff.test.ts` keep that change behavior-preserving and
verifiable without a device.

## The `PushedDiffSource` port

The four operations `computePushedDiff` + `resolvePushDestination` require:

| Method | Replaces argv | Native (JGit) |
|---|---|---|
| `currentBranch()` | `symbolic-ref --short HEAD` | exists today |
| `verifyRef(ref)` → sha \| null | `rev-parse --verify --quiet <ref>` | new primitive `revParse` |
| `mergeBase(a, b)` → sha \| null | `merge-base a b` | new primitive `mergeBase` |
| `logPatch(range)` → string \| null | `log -p --no-color <range>` | new primitive `logPatch` (RevWalk + DiffFormatter) |

`logPatch` is where byte-compatibility is a *bargain, not a guarantee*: JGit's
`DiffFormatter` emits unified-diff text very close to `git diff` but not
guaranteed identical (context, hunk headers, rename detection, binary handling
may differ). The gates tolerate this — secret scan needs the added (`+`) content
lines present; the Auditor reads the diff as an LLM. This is the same bargain the
`status` → porcelain decision already accepted. It is the one thing that **must be
device-validated** before native gating is relied on.

## Increment 2 decomposition

- **2a — the port (pure TS, no device) — shipped 2026-07-08.** Define `PushedDiffSource`; refactor
  `computePushedDiff` and `resolvePushDestination` onto it; ship
  `pushedDiffSourceFromGitExec`; keep all web/CLI/push-plan/auditor-gate tests
  green; add port + algorithm-over-fake-source tests. This is the keystone and is
  fully testable in CI without a device.
- **2c — gate-composition unification (pure TS) — shipped 2026-07-08.** Promote the gate-composition
  block out of `createSandboxPushGit` into a shared builder; grow
  `createNativePushGit` to accept `secretScan` / `protectMain` / `auditAtPush` +
  a native `getDiff`. (Does not depend on 2b — it composes over whatever `getDiff`
  it is handed.)
- **2b — native primitives (Kotlin + device) — code shipped 2026-07-08; device validation pending.** Add `revParse`, `mergeBase`,
  `logPatch` to `JGitEngine` + plugin definitions + web stub; ship
  `pushedDiffSourceFromNativePlugin`. **Device-validate** that
  `logPatch` output is acceptable to the secret-scan gate before the path is
  trusted. This is the only part that needs the physical phone.

Likely lands as 2–3 PRs (2a alone; 2b+2c together, or each separately).

## Out of scope

`computePushPlan` (`lib/git/push-plan.ts`) — the ref-only push plan with
force-with-lease via `ls-remote` — is the web `prepare_push` tool's divergence /
lease protection, separate from the gate stack. Mobile push-divergence handling is
a later push-tool increment, not part of gate unification.

## Status flip plan

Flip this doc's status as increments land: note 2a/2b/2c shipped inline; promote
from **Draft** to **Current** when increment 2 is complete and the native gate path
is device-validated. When the whole native-git arc stabilizes, fold the durable
parts into [`Platform, Sessions, and Sandbox Decisions.md`](<Platform, Sessions, and Sandbox Decisions.md>)
(which owns git/RPC seams) and mark this **Merged into** that doc.
