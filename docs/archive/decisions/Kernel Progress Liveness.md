# Kernel Progress Liveness

Date: 2026-06-02
Status: **Draft**
Owner: Push

## Why this is its own note

This is independent of the [Coder Delegation Collapse](Coder%20Delegation%20Collapse%20%E2%80%94%20Component%20Audit.md)
track. The hangs that make autonomous runs painful do **not** live in the
delegation wrapper, and they are **not** fixed by collapsing it — they live in
the kernel-execution and sandbox layers, and they survive whether the work is
delegated or run inline by the lead agent.

The `CoderJob` DO test suite confirmed the *durability* layer is well
instrumented: SSE heartbeats, a wall-clock alarm, bounded resumes, and loud
structured failures on every eviction-recovery branch. The gap is narrower and
more specific:

> **Heartbeat is transport liveness, not work progress.**

A kernel stuck on a non-terminating `await` (a provider stream that stalls, a
sandbox call that ignores its abort signal) keeps emitting SSE heartbeats while
making zero forward progress. Nothing distinguishes "thinking" from "wedged"
until the 60-minute wall-clock alarm fires. On an unattended/backgrounded run
that 60 minutes is the *entire* user-visible failure signal — which is exactly
the worst case, because the run is unattended precisely when you can't watch it.

## Plan

1. **Per-step progress timestamps.** Record a monotonic "last forward progress"
   timestamp updated on real work events (round boundary, tool dispatch, tool
   result, token received), distinct from the transport heartbeat. Progress
   liveness = time since last *work* event, not time since last *byte*.

2. **Detect long naked awaits.** Wrap the awaits that can stall (provider stream
   iteration, sandbox exec/read) in a watchdog that fires a structured warning
   when an await exceeds a per-operation soft deadline — well below the 60-minute
   wall-clock backstop — so a wedge surfaces in minutes, not at the hour mark.

3. **Enforce abort propagation.** Audit that the run's `AbortSignal` actually
   reaches and cancels (a) provider stream iteration and (b) every sandbox call,
   so a deadline/cancel terminates the operation instead of being a naked await
   that only resolves on success. (See the CLAUDE.md PR self-review note on
   `await`-in-a-loop and fire-and-forget promises — same failure shape.)

4. **Distinguish stall classes in logs.** A stall is not one thing. Emit distinct
   structured events for:
   - **provider stall** — stream open but no tokens past the soft deadline;
   - **sandbox stall** — an exec/read in flight past its soft deadline;
   - **cold-start stall** — sandbox not yet ready / first-call provisioning
     (expected-slow, should be classified as such and not alarmed like a wedge).

   These pair semantically (`*_stall_detected` ↔ `*_stall_cleared`) per the
   symmetric-structured-logs rule, so ops can tell *which* layer hung.

## Candidate adjacent fix (verify first)

The client-side idle-hibernation timer (`useSandbox.ts:248`, 8-min, keyed on
`msSinceLastSandboxCall()`) may hibernate the sandbox out from under a running
*background* job if the job's server-side sandbox calls don't reset the
client-side timer — forcing the job through `SandboxUnreachableError` →
`resumeFromCheckpoint` churn. (Inference — not yet confirmed; benign on a locked
phone since mobile suspends the timer, but it would bite the awake-but-idle
case.) Worth confirming as part of the sandbox-stall classification work, since
it would otherwise masquerade as a sandbox stall.

## Out of scope

No change to the durability layer (checkpoints, replay, resume caps, wall-clock
alarm) — this *adds* a finer-grained progress signal beneath the existing
transport heartbeat and backstop, it does not replace them.
