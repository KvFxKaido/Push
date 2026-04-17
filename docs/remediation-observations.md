# Remediation Observations

Lightweight observation log per [Architecture Remediation Plan §Lightweight observation log](decisions/Architecture%20Remediation%20Plan%20%E2%80%94%20Defusing%20the%20Big%20Four.md). One line per real session. Three green entries on a given extraction discharges the evaluation step and unblocks the next one.

Format: `date, session purpose, "<tools> fine" or "hit X"`.

---

## 2026-04-17 — CLI delegation spike (Gap 3 Step 1): wiring landed, end-to-end deferred

**Session purpose:** Ship the headless orchestrator spike per *CLI Runtime Parity* Gap 3 Step 1. Motivation: the plan's evaluation gate ("real coding sessions on real work") is deadlocked behind CLI usability for the solo-dev operator — without delegation, real CLI sessions do not accumulate, which means the observation log never populates, which means no extraction is ever unblocked by its own terms. Fixing that rung was prerequisite to using this log.

**What shipped (landed on branch `claude/continue-doc-updates-PYCQc`):**

- `lib/planner-core.ts` (new): extracted pure planner logic from `app/src/lib/planner-agent.ts` with an injectable `PlannerStreamFn`. The prompt, JSON schema, parsing, and brief-formatting live once in shared `lib/`. Both web and CLI adapters wrap their own provider abstraction.
- `app/src/lib/planner-agent.ts` (refactor): now a thin adapter — resolves web provider/model, wraps web's `streamFn` to the core's shape, calls `runPlannerCore`. Behavior-preserving; the 2 existing tests pass unchanged.
- `cli/delegation-entry.ts` (new): `runDelegatedHeadless()` — builds a CLI-side `PlannerStreamFn` over `streamCompletion`, calls `runPlannerCore` to produce a `PlannerFeatureList`, converts to `TaskGraphNode[]`, constructs a `CorrelationContext` with `surface='cli'` + `sessionId`/`runId`/`taskGraphId`/`executionId`, and runs the graph in-process through `lib/task-graph.executeTaskGraph`.
- `cli/cli.ts`: `--delegate` flag added to `KNOWN_OPTIONS` and `parseArgs` spec; headless branch in `runHeadless` dynamically imports `delegation-entry` when set.

**Spike scope calls documented in the source:**

- **In-process graph execution, not pushd RPC.** The doc's line 248 says "submit through the existing `handleSubmitTaskGraph` RPC." For a headless single-process invocation, the RPC's load-bearing responsibilities (attach-token validation, event broadcasting to attached clients) are ceremony. Calling `executeTaskGraph` directly removes it. Promoting to RPC is a separate step when the daemon + attach-client stack matters.
- **Minimum-viable executor.** Each task node runs the existing CLI `runAssistantLoop` on a scoped per-node messages buffer with the node's task plus enriched context from prior nodes. This is *not* the role-kernel (Explorer/Coder) executor used by `cli/pushd.ts:runExplorerForTaskGraph`. The spike measures the scope-shrinking hypothesis (narrow per-node prompts vs. one kitchen-sink prompt), not the role-kernel-specialization hypothesis. If the scope-shrinking effect alone produces a small-model delta, role-kernel specialization becomes an obvious follow-up; if it doesn't, we have a result that narrows the search.
- **CorrelationContext minimum threading.** Graph-level context constructed at entry; extended per-node with `taskId` before each executor call; used in session-event payloads and `onProgress` stderr tags. Not yet propagated into tracing spans — the CLI tracing spine is Step 3 territory. The landed shape means no new correlation plumbing has to be invented for the next pass.
- **Fail-open.** Planner returning `null` (model refused, timed out, produced unparseable output) falls through to the non-delegated `runAssistantLoop` path. A delegation-specific failure does not block the user's task.

**Validation performed tonight:**

- CLI typecheck: `npm run typecheck` → clean (exit 0).
- CLI test suite: `npm run test:cli` → 1046/1046 pass.
- Web planner tests: `npx vitest run app/src/lib/planner-agent.test.ts` → 2/2 pass (refactor preserved external signature).
- Flag smoke test: `./push run --delegate --task "..."` parses without "unknown flag" warning; `--weird-flag` still warns as expected.
- Delegation path dynamic-import smoke test: `PUSH_OPENROUTER_API_KEY=fake ./push run --delegate --provider openrouter --model "anthropic/claude-haiku-4.5" --task "print hello world" --json` successfully loaded `delegation-entry.ts`, called `runPlannerCore`, dispatched through `streamCompletion` to OpenRouter, surfaced the upstream 403 cleanly, and correctly fell back to the non-delegated path with `fallback: "planner_empty"` in the JSON output. Confirms the wiring reaches the network boundary and the fail-open path is live.

**Validation deferred (needs real API key the operator has, not the session environment):**

- End-to-end delegated run on `anthropic/claude-haiku-4.5:nitro` via OpenRouter against a real task in a real workspace.
- Non-delegated baseline on the same model + same task, for the go/no-go delta per the plan.

The spike is unblocked to measure — the measurement itself is the operator's next slot. This is the first entry in this log and intentionally does not count toward the verification-family three-green gate, because this spike was CLI delegation, not a verification-family real-use session. The counter for verification-family observations starts the next time a real session exercises `sandbox_run_tests` / `sandbox_check_types` / `sandbox_verify_workspace`.

**Status:** delegation wiring fine (typecheck + tests + smoke all green). End-to-end delta unmeasured.
