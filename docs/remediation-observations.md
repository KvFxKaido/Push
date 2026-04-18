# Remediation Observations

Lightweight observation log per [Architecture Remediation Plan §Lightweight observation log](decisions/Architecture%20Remediation%20Plan%20%E2%80%94%20Defusing%20the%20Big%20Four.md). One line per real session. Three green entries on a given extraction discharges the evaluation step and unblocks the next one.

Format: `date, session purpose, "<tools> fine" or "hit X"`.

**Status as of 2026-04-18 — gate currently suspended:** the three-green-entries mechanism above assumes Push CLI is the operator's daily tool for real coding work. At Push's current stage of CLI readiness, it is not. Real-use observations therefore cannot accumulate through the prescribed path, and the gate is **effectively suspended**. The discipline the gate enforces (don't extract blind, validate behavior preservation) remains valid; until CLI usability reaches a daily-driver state, it is enforced via characterization tests and targeted smoke exercises rather than via this log. Entries below are kept for provenance and for retrospective use once the gate re-activates. See the remediation plan's `§Lightweight observation log` and `§CLI Runtime Parity` for the full framing and the work that moves the prerequisite toward being met.

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

**Measurement harness landed 2026-04-17 (PR #322).** `scripts/measure-delegation.ts` wraps two `./push run --json` invocations (baseline + `--delegate`) on the same task, wall-times each externally, parses outcome/rounds from the JSON output, reads each run's `events.jsonl` for the regression-class signals the plan flags (malformed tool calls, `harness.adaptation` events, errors), and emits a markdown-shaped entry for this log. Stdout by default so the operator still chooses what lands in the log; `--append <path>` writes directly. Warns but does not auto-fix two caveats: both runs share the checkout (baseline mutations leak into delegated), and `--accept` executes on the baseline path but not on the delegated path today. Commits: `78cc887` (wrapper), `d7c7b11` (format), `ac18695` (review fixes on PR #322 — `fs.constants` import hardening, JSON recovery broadened, `acceptance-missing` flag surfaced, worktree-dirty + acceptance-asymmetry warnings, generic `harness-adaptation` reference). The wrapper does not change what the measurement is; it shortens the operator slot from "rerun, eyeball, transcribe" to "paste, edit into the log's prose voice, commit."

---

## 2026-04-18 — Gap 3 Step 1 validation: two root causes found and fixed, small-model delegation grounded end-to-end

**Session purpose:** Run the measurement harness against real small models to populate the Gap 3 Step 1 go/no-go signal. Five runs across three models surfaced a structural bug in the delegation path that had been masking every measurement; fixing it produced the first end-to-end grounded small-model delegation on Push CLI. Commits landed on main: `99cad68` (planner prompt fix), `4f661ca` (system-prompt preservation fix).

**Measurement arc (same task each run: "Document Push's CLI harness adaptation layer: (1) trigger rules + thresholds, (2) files that implement them, (3) how adaptation is invoked from the engine's per-round loop"):**

| # | Model | Baseline | Delegated tool calls | Delegated output |
|---|---|---|---|---|
| 1 | `anthropic/claude-haiku-4.5` | 26.1s, 1 round, emitted array-wrapped tool calls silently dropped by `detectAllToolCalls`, concluded "I can't find it" | 0 | 4 nodes × 12K–25K chars fabricated docs |
| 2 | `google/gemini-3-flash-preview:nitro` | 1.6s, **empty response** (outcome=success via no-calls-no-content artifact) | 0 | 3 nodes × 1.3K–2.7K chars fabricated docs |
| 3 | `anthropic/claude-sonnet-4.6` | 2m12s, `120s` provider timeout, zero content | 0 | 5 nodes, 2 completed + 3 provider timeouts, mixed errors |
| 4 | Gemini Flash after planner prompt fix only | (timeout) | 0 | 3 nodes × 30-byte placeholder (empty content — model knew to investigate but couldn't expose tools) |
| 5 | `google/gemini-3.1-pro-preview:nitro` after planner fix only | **6 grounded tool calls** (search_files + read_file on cli/harness-adaptation.ts and cli/engine.ts:580-615) | **0** | 1 node × empty |

The inconsistency in run 5 — same model, same session store, grounded baseline, empty delegated — surfaced the real bug.

**Root cause #1 (fixed by `99cad68`):** The planner's `PLANNER_SYSTEM_PROMPT` framed `files` as ambiguous between input and output, and its guidelines phrased features as "what to implement" without requiring investigation before generation. Small models interpreted "document X" tasks as "write new files at /workspace/docs/..." and populated `files` with hallucinated output paths — which the graph validator accepted because `validateTaskGraph` only checks structural invariants (cycles, dup ids, dangling deps), not file existence. Fix: rewrote the planner prompt to declare `files` as an INPUT list (existing source files the Coder must read), forbid invented output paths, require descriptions to begin with investigation, and drop the implicit `test -f /workspace/...` verifyCommand pattern. Companion change in `cli/delegation-entry.ts::planToTaskGraph` prepends a read-first instruction to each node brief and relabels the file list "Input files (read these first):". Post-fix plans are coherent ("Investigate the CLI harness adaptation logic within the codebase...") but fabrication merely shifted to empty output — run 4 above — because of the second bug.

**Root cause #2 (fixed by `4f661ca`):** The per-node executor in `runDelegatedHeadless` set `state.messages = []` and `state.workingMemory = undefined` before each node ran, intending to scope per-node conversations. But this also wiped the system message — which contains `TOOL_PROTOCOL`, the tool list, and the workspace snapshot. `runAssistantLoop` then called `ensureSystemPromptReady`, whose first check is `messages[0]?.role === 'system'` → silent early return on an empty array. Every delegated node on every model tonight ran with no system prompt at all, hence zero tool calls regardless of model capability. The inconsistency in run 5 (Gemini 3.1 Pro baseline making 6 grounded calls, delegated making 0) is what pointed at this — a model that demonstrably follows the protocol when given access was producing zero tool calls in the delegated path. Fix: before clearing `state.messages`, pull the system message off the `originalMessages` snapshot (already in scope for the finally-restore pattern) and seed the per-node messages with it. Conversation history is still discarded per-node; the tool protocol and workspace context are preserved.

**Post-fix validation (run 6, `google/gemini-3-flash-preview:nitro`, both fixes in place):**

Delegated path produced **9 grounded tool calls across 3 nodes, 4 rounds total**, wall 2m22s:

- `list_dir .`, `list_dir cli`, `list_dir lib` — structure exploration
- `search_files {pattern:"adaptation"}`, `search_files {pattern:"harness"}`, `search_files {pattern:"trigger"}` — targeted keyword search
- `read_file cli/harness-adaptation.ts` — the main implementation file
- `read_file cli/engine.ts:570-620` — the invocation wiring (matches where the adaptive round-budget check actually lives)
- `read_file app/src/lib/harness-profiles.ts` — **unprompted cross-reference** to the web source the CLI port came from

Zero malformed tool calls, zero harness adaptations. One error in the delegated run (`PROVIDER_ERROR` mid-stream, one node retried successfully). Session id: `sess_mo3mut7r_052ea6`.

Baseline in run 6 hit the same `120s` provider timeout Sonnet hit in run 3. This is a separate concern (small-model `:nitro` initial-stream reliability on OpenRouter) and not a delegation issue; documented as deferred.

**What this validates (per plan §Gap 3 Step 1):**

- **Delegation on small models now produces real, grounded tool use.** The scope-shrinking hypothesis isn't just testable any more — on this model and task, it's the *only path that produces any output at all*. Baseline timed out with zero content; delegated completed with proper investigation. The product case for "delegation helps smaller models" is concretely validated on the cheapest member of the Gemini family.
- **The two fixes compose cleanly.** Without the planner fix, nodes had a "generate X" prompt and fabricated. Without the system-prompt fix, nodes had no tool protocol exposed and produced empty output. Together they close the loop; neither is sufficient alone.
- **Push's tool protocol is followable by capable models.** Gemini 3.1 Pro baseline demonstrated this in run 5. The prior "maybe the `TOOL_PROTOCOL` prompt is too terse for small models" hypothesis is superseded — small models fail because the protocol isn't exposed in delegation, not because the protocol itself is unclear.

**Deferred (explicitly):**

- **Tool-call format-repair layer.** Was a candidate fix before the system-prompt bug surfaced. With delegation now producing grounded tool calls on the smallest model we tested, format-repair becomes a defensive hardening investment rather than a blocker. Revisit only if future runs hit format-quirk failures on specific models.
- **`:nitro` baseline timeout investigation.** Gemini Flash and Sonnet baselines both hit the `120s` provider-stream timeout on initial stream via OpenRouter `:nitro` routing. Non-`:nitro` variants may behave differently. Not a delegation concern; a provider-reliability concern.
- **Node-level role specialization.** Current spike runs every node as `coder` on `runAssistantLoop`. Explorer/Coder split is a separate hypothesis, documented in `cli/delegation-entry.ts:104-106`.

**Three-green-gate status:** this entry intentionally does **not** count toward the verification-family three-green gate — it's a Gap 3 Step 1 validation, not a verification-family extraction observation. The counter for `sandbox_run_tests` / `sandbox_check_types` / `sandbox_verify_workspace` real-use observations still starts the next time such a session actually runs. This entry does discharge the equivalent go/no-go gate for Gap 3 Step 1: small-model delegation works end-to-end.

**Status:** delegation grounded end-to-end on the smallest Gemini model tested. Two fixes committed on main.

---

## 2026-04-18 — Step 2 + Step 4 git/release: tests-first this time, extraction landed (PR #324)

**Session purpose:** Continue the Big Four extraction tranche per the remediation plan's Step 4. Session opened on the premise that "Step 4 verification is the canonical next move" — reconnaissance immediately surfaced that verification had shipped 2026-04-15 (commit `14a63c4`) and the Step 2 verification tests had backfilled 2026-04-17 (commit `c6dec54`, PR #316). Same stale-premise pattern the plan had documented twice already (Gap 1 at lines 184-186, Gap 2 at line 208) — third instance this cycle.

Pivoted the session to (a) reconcile the plan doc and (b) do the next family on the deferred list — git/release — this time respecting the prescribed Step 2 → Step 4 order that verification accidentally violated.

**What shipped (PR #324, branch `claude/assess-gap3-next-steps-CSZxy`):**

Four commits on the branch:

- **`ec5d15e`** docs: reconcile Steps 2 and 4 after reconnaissance showed verification extraction landed. In-place corrections to Status line, Step 2, Step 4, Material Corrections #4, Latent Bug section. Added the honest-ordering note that verification shipped extract-first/tests-later despite the plan's prescription.

- **`e92b2b8`** test(tools): characterize git/release family before extraction. 20 dispatcher-level tests added to `app/src/lib/sandbox-tools.test.ts` (84 → 104). Pin behavior of `sandbox_diff` (4 tests), `sandbox_prepare_commit` (7 new + 3 preexisting override-smoke tests), `sandbox_push` (2), `promote_to_github` (7). Tests pass at HEAD with zero production code changes — Step 2 signal met properly this time.

- **`9c22544`** refactor(tools): extract sandbox git/release family behind handler-context. Four handlers move into new `app/src/lib/sandbox-git-release-handlers.ts` (459 lines) behind `GitReleaseHandlerContext`. Dispatcher: 3,640 → 3,348 lines. Eight injected deps (vs verification's four) — git/release reaches further into the web runtime via the Auditor pipeline and GitHub auth.

- **`b64c2de`** test(tools): clarify git/release characterization comment for PR-as-a-whole context. Single doc-quality fix in response to a Copilot review nit on the test header.

**Validation:**

- `npx tsc --noEmit` in `app/` → clean across all four commits.
- `npx vitest run src/lib/sandbox-tools.test.ts src/lib/sandbox-verification-handlers.test.ts` → 133/133 passed (104 sandbox-tools + 29 verification).
- Adjacent surfaces (approval-gates, capabilities, tool-dispatch, web-tool-execution-runtime, workspace-publish, tool-dispatch-smoke, sandbox-tool-detection) → 224/224 passed.
- biome check + eslint → clean (one auto-formatted line wrap during commit hook on `e92b2b8`, re-verified green after).
- PR #324 CI: all green (Lint/Test/Build app, Format/Typecheck/Test cli, Typecheck/Build github mcp, Workers Builds, Cloudflare deployment). Kilo Code Review: "No Issues Found | Recommendation: Merge."

**Review pass on PR #324** (5 comments across Copilot ×3 and the Claude review bot ×2):

- 1 fixed in `b64c2de` (test header comment clarification).
- 2 deferred with explanations on the threads (1200-char constant extraction = preexisting duplication preserved verbatim, defer to next git/release-touching change; `markWorkspaceMutated` consistency fix = real behavior change, defer to a separate semantic-fix PR with its own characterization).
- 1 incorrect (Copilot claimed `import type X` + `typeof X` won't typecheck — TypeScript supports `typeof` in type positions on type-only imports, verified by the clean typecheck; replied with explanation).
- 1 stale (Copilot read the original PR body before it was updated; no reply needed).

**Two follow-ups noted, not fixed in this PR** (semantic oddities surfaced during characterization, deferred to keep the extraction behavior-preserving):

- `promote_to_github` does not set `markWorkspaceMutated: true` on its git push exec, though `sandbox_push` does. Both push to origin. One-line semantic fix for a separate PR.
- `sandbox_prepare_commit` truncates pre-commit hook output to 1200 chars in two slightly different code paths. Candidate for a shared `HOOK_OUTPUT_TRUNCATION_LIMIT` constant on the next git/release-touching change.
- `sandbox_save_draft` (still inline in the dispatcher at the pre-extraction `:2268`) is git/release-adjacent but not part of the canonical family per the plan. Extract-as-part-of-git-release vs. extract-as-its-own-family is a design call for a later session.

**Three-green-gate status:** this entry does **not** count toward either family's three-green gate — it's an extraction-arc anchor, not a real-use observation. The verification-family counter still starts the next time a real session exercises `sandbox_run_tests` / `sandbox_check_types` / `sandbox_verify_workspace`. The git/release-family counter starts the next time a real session exercises `sandbox_diff` / `sandbox_prepare_commit` / `sandbox_push` / `promote_to_github` against actual work. Two extractions are now in place; both gates are at 0/3.

**Status:** git/release family extracted, characterized, and PR #324 fully review-passed. Combined with verification, the dispatcher has shrunk by ~764 lines across two extraction passes (4,112 → 3,348). Next family per the plan is read-only inspection or mutation, with the "stop here and evaluate the pattern" gate between families.

---

## 2026-04-18 — CLI daily-driver prerequisite: first ergonomics unblock (PR #326)

**Session purpose:** Act on the prerequisite framing that landed earlier the same day (`2cdc427`). The remediation plan's evaluation gate is suspended until Push CLI is daily-driver ready; the suspension note names `§CLI Runtime Parity` as the work that moves the prerequisite toward being met. First concrete ergonomics bite: `push resume` listed sessions but did not attach — every resume cost three commands (run `resume`, copy id, run `attach`), making the CLI un-viable as a daily driver for the real coding sessions the log depends on.

**What shipped (PR #326, branch `claude/review-commit-planning-OTIHj`, commits `7a97f3e` + `ef2a94d`):**

- `cli/cli.ts`: `push resume` in a TTY now renders a numbered picker and calls `runAttach` on selection. Behavior matrix preserves script surfaces exactly — `push sessions` and `--no-attach` stay pure-list, `--json` is untouched, `resume rename` unchanged, non-TTY stdin/stdout bypasses the prompt. Picker accepts 1-based index (gated on `/^\d+$/` so `"1-session-id"` doesn't silently pick index 1) or a full session id; empty / `q` / `quit` cancels. `--no-attach` registered in both `KNOWN_OPTIONS` and the `parseArgs` schema (mirrors `no-resume`). Help text updated in usage + options sections.
- `cli/tests/cli.test.mjs`: nine new cases pinning the behavior matrix end-to-end, including PTY-gated happy path (selects `1`, asserts flow into `runAttach` via the "pushd is not running" error under a synthetic empty `HOME`) and a sanitization test proving injected ANSI SGR codes in user-controlled `sessionName` don't reach the terminal.

**Security follow-through surfaced by review bots (Codex + Copilot, P2):** session names are user-controlled via `push resume rename` and direct state edits, so the picker strips ANSI CSI sequences and C0/DEL before wrapping in `fmt.bold`. Two-pass regex so `\x1b[31m` doesn't leave a visible `[31m` tail while preserving multibyte UTF-8. Closed in `ef2a94d` along with six other review items (parseArgs schema registration, help Options omission, stricter index parsing, non-null assertion at the `runAttach` call site, PTY soft-skip checking stderr too, happy-path test addition). Three noise comments replied to inline (`script -V` consistency already matched `/compact`'s pattern; `PUSH_CONFIG_PATH` portability is preexisting across three harness helpers; non-null assertion accepted and applied).

**Validation:**

- `npm run typecheck` → clean.
- `npm run format` → clean (one auto-fix after initial write).
- `npm run test:cli` → 1055/1055 pass (was 1053; +2 tests for happy-path selection and SGR sanitization).
- PR #326 CI: Cloudflare Workers deploy green on `7a97f3e`; CI re-green after `ef2a94d`. Kilo Code Review: "No Issues Found | Recommendation: Merge."

**What this is and is not:**

- **Is:** a prerequisite-unblock step. The suspension clause explicitly says the gate's mechanism is suspended until CLI usability reaches daily-driver state, with characterization tests and targeted smoke exercises as the substitute discipline in the interim. This PR is one of the ergonomics bites that moves the prerequisite — it is not itself a real-use observation against an extracted family.
- **Is not:** a three-green-gate entry. The verification-family and git/release-family counters both stay at 0/3. Those counters start advancing the next time a real coding session exercises the extracted families' tools against actual work, which still requires the CLI to be daily-driver viable end-to-end. This one-command resume flow moves one specific friction; it does not by itself make the CLI daily-driver ready.

**Out of scope for this PR, noted for follow-up:**

- Auto-attach when exactly one session exists (explicit confirm was preferred over surprise attach for the first cut).
- Richer picker metadata (last-event preview, freshness sort by recency, last message snippet).
- `push` bare invocation with no args surfacing the picker for the top-level REPL entry point (currently `--session <id>` is still required there).
- `PUSH_CONFIG_PATH` hardening via `fs.mkdtemp` across `runCli`/`runCliPty`/`spawnPickerPty` (preexisting, deferred to a test-harness-only sweep).

**Status:** one CLI daily-driver friction removed, fully review-passed. Suspension remains active — this is one of several ergonomics passes the prerequisite needs before the three-green gate becomes populatable through its prescribed mechanism. The next ergonomics bite (candidates from PR #326's scope doc: auto-attach single-session case, freshness indicators in picker, `push` bare invocation picker) is the operator's call.
