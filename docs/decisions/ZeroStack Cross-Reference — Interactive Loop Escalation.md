# ZeroStack Cross-Reference — Interactive Loop Escalation

Status: Draft, added 2026-06-04. Comparative cross-reference, not a ROADMAP commitment. Companion to [`Loop Detection — Near-Duplicate Layer.md`](Loop%20Detection%20—%20Near-Duplicate%20Layer.md), which owns Push's existing loop machinery.

Records a pattern-mining pass over [ZeroStack](https://github.com/gi-dellav/zerostack) (`gi-dellav/zerostack`, v1.4.5 — a ~17k-LOC Rust coding agent on the `rig` framework). Most of what looked borrowable on a README read turned out to be **already shipped in Push, and more thoroughly**. This doc records that honestly, isolates the **one rung Push's loop ladder is actually missing**, and notes two secondary observations plus the anti-patterns not to copy.

## TL;DR

ZeroStack runs a *doom-loop* check inside its **permission checker** (`src/permission/checker.rs`): when a `(tool, input)` pair repeats 3+ times within the last 16 calls, it escalates `AllowedWithCoaching → Ask → Denied`. The `Ask` rung is the interesting part — it routes a detected loop **to the human** for a decision.

Push's ladder (`lib/loop-detection.ts`, `evaluateLoopState`) is `none → warn → block → compact → abort`. Every non-`none` rung either **steers the model** (warn/block/compact inject a `[LOOP_*]` note and skip the batch) or **kills the run** (abort). **No rung pulls in the human.** On an interactive surface (web chat, TUI) a stuck run goes straight from autonomous steering to silent termination, when a human is sitting right there who could redirect it in one sentence.

**The borrow:** a surface-conditional rung that, on interactive surfaces, escalates a persistent loop to the existing approval request/respond path (`approvalId`) — "I've tried this N times without progress; redirect me or stop me?" — *before* `abort`. `abort` stays the terminal rung for autonomous/headless contexts (Coder delegation, `push run`, relayed remote runs) where no human is attached.

## What ZeroStack has that Push already shipped (no-ops)

Calibration, so this doc doesn't re-litigate solved problems:

| ZeroStack feature | Push equivalent | Verdict |
|---|---|---|
| Doom-loop on exact `(tool, input)` repeat | exact-match breakers in `MutationFailureTracker` (per-args failure budget, consecutive-call streak, delegation-outcome streak) + always-on abort | **already have** |
| Graduated `coach → ask → deny` | `none → warn → block → compact → abort` ladder in `evaluateLoopState` | **already have** (deeper — Push adds a compaction rung) |
| Named permission tiers (restrictive/readonly/guarded/standard/yolo) | approval modes + Auditor SAFE/UNSAFE gate + Protect Main | **already have**, different axis (Push gates the *commit*, not just the call) |
| `AllowedWithCoaching` (execute the Nth repeat, then nudge) | Push's `warn` **skips** and steers instead | **consciously rejected** — see `Loop Detection` refinement note: "once the ladder fires the model has already written N near-identical versions; executing one more is the waste we're stopping" |

The bulk of ZeroStack's loop story is parity with the Pi-forge borrow Push landed 2026-05-25/05-29. Do not re-build it.

## The genuine delta: an interactive escalation rung

Push's ladder is **fully autonomous by construction**. That was the right default — it has to work for the headless Coder loop and `push run` where no human is present. But it means the *interactive* surfaces inherit a posture built for autonomy: a model thrashing in the web chat or TUI gets steered a few times and then the run is aborted with `TOOL_LOOP_DETECTED`, with no point at which the present human is asked "do you want to take over?"

ZeroStack's `Ask` verdict is the missing shape. Adapted to Push:

- **New level, surface-conditional, sits between `compact` and `abort`.** Working name `escalate` (or fold it into the existing levels as an `action` variant — see Open Questions). On a surface with a live approval channel, a loop that survives `compact` raises an **approval prompt** instead of advancing straight to `abort`.
- **Reuses existing plumbing, adds no new vocabulary.** Push already has the request/respond approval pair (`approvalId`) and the `[LOOP_*]` steering copy in `buildLoopSteeringText`. The rung is: emit an approval request carrying the loop verdict's `reasons` + the offending path/tool, and the prior tool-result tail; on "continue" reset the windows like `compact` does; on "stop" take the existing `abort` path; on timeout/no-channel fall through to `abort` (the current behavior — strictly a superset).
- **Surface gate, not a new flag.** Interactive (web round loop, TUI) → `escalate`. Autonomous (`lib/coder-agent.ts`, `push run`, relayed `pushd` runs with no attached client) → keep going straight to `abort`. The selector is "is there a live approval channel for this run," which the approval layer already knows — not a new config knob.

Why this is worth a rung rather than a prompt line: per CLAUDE.md, *behavior lives in code, not prompts*. "Ask the user when you're stuck" is exactly the kind of thing a non-cooperating model won't do on its own — it has to be a runtime escalation, wired to the same enforcement point as the rest of the ladder (`evaluateLoopState`'s consumers), not a request in the system prompt.

### Why not just lower the `abort` threshold?

`abort` is terminal and lossy — it discards the run. The interactive rung is the opposite: it's a *recovery* opportunity that keeps the run alive under human direction. Lowering `abort` makes Push give up *sooner*; adding `escalate` makes it give up *less* on interactive surfaces while staying exactly as decisive on autonomous ones.

## Secondary observations

1. **Loop detection as a permission dimension (uniform per-tool coverage).** ZeroStack runs the repeat check *inside* `permission/checker.rs`, so it covers **every** tool (Bash, read, grep, find_files, list_dir, edit, write) through one 16-call window. Push's coverage is split: exact-match breakers cover all calls, but the *similarity* layer only observes `writeTargetOf` (write/edit targets). Read-side near-duplicate loops (re-grepping the same pattern with cosmetically different args, paraphrased `find_files` each round) aren't caught by similarity — only by the exact-match consecutive-call streak, which a paraphrasing model slips. **Modest gap**; worth noting against the `Loop Detection` doc's existing "pending" list rather than acting on standalone. Measurement first (does it actually happen with frontier models?), consistent with that doc's Open Question #3.

2. **CWD-scoped reads as a default.** ZeroStack's `Standard` mode allows unmatched reads **only inside CWD**. Push's read path (`sandbox_read_file`) leans on the sandbox/container boundary and approval modes rather than a path jail on reads specifically. Whether a model can read outside the workspace root in the default mode is worth a deliberate trace — but it belongs with the `Sandbox Policy Seam.md` enforcement work, not here, and it's a separate concern from loops.

## Anti-patterns — explicitly do not adopt

- **Fail-open sandbox.** `src/sandbox.rs`: if the requested backend (`bwrap`/`zerobox`) isn't installed, ZeroStack *warns and runs the command unsandboxed*. A sandbox that fails open is the highest-risk failure mode for a sandbox — a user who believes they're isolated isn't. Push's posture is the opposite (host-side git guard in `Sandbox Policy Seam.md`, container isolation that doesn't silently degrade) and should stay that way. Recorded as a contrast, not a borrow.
- **Allow-then-coach.** ZeroStack's `AllowedWithCoaching` executes the offending repeat before nudging. Push deliberately made `warn` skip-and-steer instead; don't regress it.
- **Raw-regex rule bypass.** `src/permission/pattern.rs` carefully escapes glob metacharacters but lets `is_regex: true` rules through unescaped, and `**` → `.*` crosses `/` boundaries. Only exploitable via the user's own config (footgun, not vuln), but a reminder that Push's pattern/allowlist seams should escape symmetrically and trace both a denied and an allowed path (CLAUDE.md "Auth / allowlist seams").

## Open Questions

1. **New `LoopLevel` or new `action` on existing levels?** `LoopLevel` is currently `'none' | 'warn' | 'block' | 'compact' | 'abort'`. The interactive rung could be a sixth level (`'escalate'`) or an orthogonal `action: 'ask'` that any level can carry when a channel is present. Leaning orthogonal — the *escalation* is a property of the surface, not a new point on the severity axis — but that touches the `LoopVerdict` shape and its drift pins (`cli/tests/loop-detection-drift.test.mjs`), so it needs the same one-canonical-definition-plus-drift-test discipline as the original.
2. **Does the approval channel know "is a human attached" cleanly?** The surface gate depends on the approval layer being able to answer "is there a live request/respond client for this run" without a race (a relayed `pushd` session may have an *intermittently* attached client). If that signal isn't crisp, the safe default is `abort` (current behavior) — the rung should only *upgrade* the outcome when a channel is provably live.
3. **Coder delegation: never, or escalate-to-orchestrator?** A headless Coder has no human, so `abort` is right. But it *does* have a parent orchestrator. A future variant could escalate a stuck Coder loop to the orchestrator (a "delegation returned: looping" outcome) rather than just aborting — but Push already has `isRepeatedDelegationFailure` for the orchestrator side, so this is likely redundant. Note and move on unless measurement shows orchestrators don't notice looping coders.

## Next step

No implementation commitment. If this graduates, the cheapest proving slice is the interactive rung on **one** surface (TUI is simplest — single-process, the approval channel is unambiguous) behind the existing `PUSH_LOOP_DETECTION` flag, measured against the current straight-to-`abort` behavior before touching the web round loop or the `LoopVerdict` shape. Needs a `ROADMAP.md` entry to become work.
