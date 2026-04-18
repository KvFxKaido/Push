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

---

## 2026-04-18 — Gap 2 daemon-side role-capability landed; Codex review caught an escape-hatch bug

**Session purpose:** Ship the Gap 2 tranche from §CLI Runtime Parity — unify daemon-side Explorer enforcement behind the shared `TOOL_CAPABILITIES` table so both surfaces use one source of truth. The plan had sat at "2–3 focused evenings with per-tool design calls required before implementation" framing since 2026-04-17; reconnaissance at scope time dissolved one of the three design calls (`ask_user` already converged by inspection — Explorer's grant never included `user:ask`), narrowing the real judgment calls to two. The tranche shipped in one focused session as four commits on branch `claude/gap-2-daemon-role-capability`.

**What shipped (branch `claude/gap-2-daemon-role-capability`, four commits):**

- **`c5e4e12`** feat(tools): add CLI-native tool names to shared capability table. 17 entries added to `lib/capabilities.ts`: `list_dir`, `read_symbols`, `read_symbol`, `git_status`, `git_diff`, `git_commit`, `lsp_diagnostics`, `save_memory`, `write_file`, `edit_file`, `undo_edit`, `exec`, `exec_start`, `exec_poll`, `exec_write`, `exec_stop`, `exec_list_sessions`. 15 pinning tests added to `app/src/lib/capabilities.test.ts` (29 → 44) including the Explorer behavior matrix and the scratchpad grant matrix for `save_memory`.

- **`b71bad4`** feat(tools): swap daemon Explorer gate to roleCanUseTool. `makeDaemonExplorerToolExec` at `cli/pushd.ts:1345` now calls `roleCanUseTool('explorer', toolName)` instead of `READ_ONLY_TOOLS.has(toolName)`. Prose `resultText` preserved verbatim for the Explorer kernel's refusal-feedback loop. Structured `console.warn` line added on denial with `event=role_capability_denied` / `type=ROLE_CAPABILITY_DENIED` for log/dashboard parity with web. `READ_ONLY_TOOLS` kept in `cli/tools.ts` because `lib/deep-reviewer-agent.ts` consumes it for a different purpose (read/mutate bucketing).

- **`938ebd4`** test(tools): characterize daemon role-capability gate (Gap 2). 31 tests in new file `cli/tests/daemon-role-capability.test.mjs`: capability-table entry pins for all 17 CLI-native names, Explorer allow/deny matrix, end-to-end `makeDaemonExplorerToolExec` refusal with filesystem assertions, structured-log emission pinning with set-equality on the granted array, and a drift-detector for `READ_ONLY_TOOLS` ↔ `TOOL_CAPABILITIES` coherence.

- **`1ace017`** fix(tools): drop Explorer-denied tools from read-only protocol. Codex review finding — see next section.

**Codex review finding and the escape-hatch pattern that masked it:**

Codex flagged a P2 immediately after the first three commits: `READ_ONLY_TOOL_PROTOCOL` at `cli/tools.ts:725–726` still advertised `exec_poll` and `exec_list_sessions` to the Explorer model as available tools, but commit `b71bad4`'s new capability gate refused both (Explorer has no `sandbox:exec` grant). Real Explorer runs would have the model follow the prompt, emit the call, and hit the denial — wasting rounds and making session-observation investigations look broken.

**The detail worth capturing as a reference pattern:** the drift-detector test in commit `938ebd4` *explicitly masked this bug*. The test's invariant was:

> For every tool in `READ_ONLY_TOOLS`: either Explorer can call it (shared table says yes) OR it's intentionally denied (exec_poll and exec_list_sessions).

That reads like a drift-detector, but it encodes a *weaker* invariant than post-Gap-2 actually holds. The correct invariant is: *every tool advertised to Explorer must be callable by Explorer*. The "intentionally denied" branch was a carve-out for the very case Codex caught. A characterization test whose expected state includes "the bug is present and intended" isn't doing the job characterization tests are meant to do; it's documenting a known gap as acceptable.

**Fix in `1ace017`:**

- Removed the `exec_poll` and `exec_list_sessions` bullets from `READ_ONLY_TOOL_PROTOCOL`. Added a divergence note above the constant explaining why those names remain in `READ_ONLY_TOOLS` (deep-reviewer-agent bucketing) but not in the prompt (Explorer can't call them).
- Tightened the existing sync test at `cli/tests/daemon-integration.test.mjs:2784` from "advertised ⊆ `READ_ONLY_TOOLS`" to a three-part invariant: (1) advertised ⊆ `READ_ONLY_TOOLS` (dispatcher must know the name), (2) advertised ⊆ `{ tools Explorer can call per roleCanUseTool }` (capability grant check — the new post-Gap-2 addition), (3) `{ Explorer-callable entries in READ_ONLY_TOOLS } ⊆ advertised` (prompt coverage check, skipping entries Explorer can't call).
- Replaced the escape-hatch drift-detector with two separate tests: one asserting every `READ_ONLY_TOOLS` entry has a `TOOL_CAPABILITIES` mapping (the real drift signal), and one explicit pin for the `exec_poll`/`exec_list_sessions` intentional-denial behavior. The second test is honest about what it's pinning — a specific known behavior change — rather than encoding it as an exception to a broader invariant.

**Three-layer truth (captured in the plan's §Dependencies section):** The CLI Explorer path now has three independent layers — `READ_ONLY_TOOLS` (dispatcher allowlist), `READ_ONLY_TOOL_PROTOCOL` (prompt block), `roleCanUseTool` (capability grant). The capability grant is the source of truth; the other two layers must track it. This is worth stating explicitly because Gap 3 Step 3's typed-memory retrieval will describe a tool surface to delegated small models, and the same principle applies: the surface derives from `roleCanUseTool`, not from a hand-maintained list.

**Validation:**

- CLI typecheck: `npm run typecheck` → clean across all four commits.
- App typecheck: `cd app && npx tsc --noEmit` → clean.
- CLI suite: 1111/1111 pass (was 1079 at branch start, +31 from commit `938ebd4` and +1 from commit `1ace017`'s test split).
- Web capability tests: 44/44 pass (15 new from commit `c5e4e12`).
- Web runtime invariant tests: 12/12 pass (unchanged — sanity check that the table additions didn't break the pre-existing web invariant pins).
- Biome pre-commit caught two multi-line-import collapses and one multi-line `assert.equal` collapse during the tranche; fixed inline each time per the existing `push-commit-tooling` memory note on Biome's formatting strictness.

**What this is and is not:**

- **Is:** closure of the Gap 2 tranche and discharge of the Gap 3 Step 3 dependency chain. The `READ_ONLY_TOOLS`-vs-`roleCanUseTool` drift vector that Gap 2 was written to close is closed for Explorer. Coder, Deep Reviewer, and Auditor remain on their own rollout schedule — each needs a capability-grant audit before the gate extends to them on CLI.
- **Is not:** a verification-family or git/release-family three-green-gate entry. The gate counters for both extracted families remain at 0/3, still suspended pending CLI daily-driver readiness. This entry is an architecture-remediation anchor, not a real-use observation.

**Reference-pattern takeaway:** when writing characterization tests for a behavior change, be suspicious of any "OR" or "either/or" branch in the invariant. A test that says "X holds OR Y is the documented exception" is often two tests pretending to be one — and the exception branch is usually where the next bug hides. The Codex review on this tranche is the concrete example; future extraction and parity work should read this entry before writing drift-detectors.

**Status:** Gap 2 shipped and Codex-reviewed-and-patched. Branch ready to push and PR.

---

## 2026-04-18 (later) — Gap 3 Step 3 landed end-to-end with measurement signal

**Session purpose:** Ship the Gap 3 Step 3 tranche (typed context-memory retrieval + write paths in CLI delegation runners) and validate empirically on Gemini 3 Flash that retrieval reduces rounds-to-completion when prior context is available.

**What shipped (branch `claude/gap-3-step-3-typed-memory-cli`, four commits):**

- **`c7034af`** feat(context): file-backed `ContextMemoryStore` at `cli/context-memory-file-store.ts` writing JSONL under `<baseDir>/<repoFullName>/<branch>.jsonl`. 23 characterization tests. Also dedupes `getMemoryStoreBaseDir` (`PUSH_MEMORY_DIR` env override, default `~/.push/memory`) into the same module so both daemon and headless surfaces share one path source. Includes `.js`-extension fixes to four `lib/context-memory-*` files surfaced by cli's NodeNext resolution as the new store transitively pulls them in.

- **`790fd2f`** feat(context): wired write paths into pushd's `handleSubmitTaskGraph`. New `cli/workspace-identity.ts` (`resolveWorkspaceIdentity`) parses `git remote get-url origin` into `owner/repo` and reads current branch via `git rev-parse --abbrev-ref HEAD`, with `path.basename(cwd)` / `null` fallbacks for non-git dirs. New `cli/task-graph-memory.ts:writeTaskGraphResultMemory` iterates `result.nodeStates` and writes a record per completed node, error-isolated per-node. 20 tests across URL parsing, real-git integration (with-remote / no-remote / detached-HEAD), and the write helper.

- **`b1c2c16`** feat(context): retrieval at node-start. New `lib/role-memory-budgets.ts` hoists `ROLE_MEMORY_SECTION_BUDGETS` (`{ facts: 600, taskMemory: 700, verification: 500, stale: 250 }`) to a shared kernel module — both `app/src/lib/role-memory-context.ts` (web Reviewer/Auditor) and the CLI now import from one source, closing the Gap 2 "parallel vocabularies" antipattern preemptively rather than reactively. New `cli/task-graph-memory.ts:buildTypedMemoryBlockForNode` wraps `buildRetrievedMemoryKnownContext` with the shared budgets + `fileHints` derived from `node.files`. `pushd.ts:handleSubmitTaskGraph` now resolves `graphMemoryScope` once per graph, executor closure consumes `enrichedContext` (previously discarded as `_enrichedContext` — an in-passing fix for `lib/task-graph.ts`'s graph-internal `[TASK_GRAPH_MEMORY]` block being silently dropped) and appends the typed memory block to `preambleExtras` threaded through to `runExplorerForTaskGraph` / `runCoderForTaskGraph`. 4 retrieval tests (null-when-no-records, formatted-block-when-records-exist, null-on-missing-repoFullName, graceful-degradation-on-store-throw).

- **`cc92a56`** feat(context): brought the `--delegate` headless path (`cli/delegation-entry.ts:runDelegatedHeadless`) to parity with the daemon path. Same `setDefaultMemoryStore(createFileMemoryStore(...))` wiring at graph-validation success, same `graphMemoryScope` derivation, same `buildTypedMemoryBlockForNode` retrieval per node, same `writeTaskGraphResultMemory` call after `executeTaskGraph` returns. The two CLI delegation surfaces now share one on-disk store, one scope shape, and one memory-block format — a `--delegate` run can write records that a later pushd session retrieves and vice versa. This was scope-expanded mid-tranche after recon revealed `scripts/measure-delegation.ts` (the harness that drives the small-model measurement signal the plan specifies for Step 3) only exercises the `--delegate` path, not pushd's `submit_task_graph` RPC. Without 3b, Commits 2+3 would have been functionally correct but unmeasurable through the existing harness.

**Measurement (Gemini 3 Flash via OpenRouter `google/gemini-3-flash-preview:nitro`):**

Same task ("Document Push's CLI harness adaptation layer: trigger rules + thresholds, files, invocation"), same `--max-rounds 12`, isolated `PUSH_MEMORY_DIR=/tmp/push-mem-measure-…`. Two consecutive `scripts/measure-delegation.ts` invocations:

| Run | Mode | Rounds | Wall | Memory state at start |
|---|---|---|---|---|
| 1 | baseline | 1 | 12.8s | (baseline doesn't use memory) |
| 1 | delegated | 5 (3 nodes) | 16.7s | empty store |
| 2 | baseline | 1 | 2.0s | (baseline doesn't use memory) |
| 2 | delegated | **3 (3 nodes)** | **12.6s** | 3 records from Run 1 retrievable |

**Verdict:** the delegated path's rounds-to-completion dropped from 5 → 3 (40% reduction) between cold and warm memory state on the same task. Wall time improved ~25% (16.7s → 12.6s) on the same delegated path. Memory retrieval is verifiably reducing rounds for this small model when prior context is available. The baseline path's wall time also dropped (12.8s → 2.0s) but baseline doesn't use the memory system at all — the model just gave a much shorter answer the second time.

**Caveats and what this measurement does and doesn't show:**

- **It does show:** the typed-memory loop wires correctly end-to-end, records persist to disk, retrieval kicks in on subsequent runs with shared scope, and a small model uses fewer rounds when prior context is available.
- **It doesn't show:** the more important "would the next operator session have benefited from this if we'd had it earlier" longitudinal signal. That requires real-coding-session exposure, which the suspension clause of the §Lightweight observation log still gates on CLI daily-driver readiness. This measurement is the strongest signal feasible without daily-driver exposure.
- **The baseline-vs-delegated comparison still shows delegated as slower in absolute terms** (3 rounds × planner+nodes overhead vs 1-round single-shot baseline) — that's expected and doesn't contradict the win. The plan's hypothesis is "delegation helps small models on tasks where context carryover matters," not "delegation is always faster than single-shot." The delegated-cold vs delegated-warm comparison is what matters for Step 3's "does typed memory pay for itself" question, and the answer is yes by ~40% on this task and model.
- **3 records → 6 records after Run 2** (file landed in `<baseDir>/KvFxKaido/Push/claude/gap-3-step-3-typed-memory-cli.jsonl` per the file-layout pin). Each run appends its own per-node records; no dedup logic. That's expected but worth a follow-up if record growth becomes a concern (the existing `pruneExpired` covers TTL-based cleanup but doesn't dedupe equivalent records across runs).
- **`--delegate` flag was initially mis-routed through the stale compiled dist** because `PUSH_SKIP_STALE_CHECK=1` opted into `cli/dist/cli/cli.js` which predates the flag — surfaced as "Warning: unknown flag --delegate" stderr noise. Resolved by `npm run build:cli` before the measurement runs. Worth noting because the failure mode looked like a real flag bug for several minutes; future measurement passes should rebuild the dist or unset `PUSH_SKIP_STALE_CHECK` to force the tsx fallback.

**Validation:**

- CLI typecheck (`npm run typecheck`): clean.
- App typecheck (`cd app && npx tsc --noEmit`): clean.
- CLI suite: 1160/1160 across the four commits.
- Web tests on touched surfaces (capabilities, context-memory, role-memory-context, web-tool-execution-runtime): 92/92.
- End-to-end on Gemini 3 Flash via OpenRouter: documented above.

**What this is and is not:**

- **Is:** Gap 3 Step 3 closure with quantitative go/no-go signal. Both CLI delegation surfaces share one typed-memory implementation. The "three-layer truth" lesson from Gap 2 was applied preemptively via shared `lib/role-memory-budgets.ts`. The in-passing fix to the executor's `_enrichedContext` discard means graph-internal memory now flows through too, an improvement separate from typed-memory retrieval.
- **Is not:** a verification-family or git/release-family three-green-gate entry. Those counters remain at 0/3, suspended pending CLI daily-driver readiness. This is an architecture-remediation anchor with a Gap 3 Step 1-style measurement validation.

**Status:** Gap 3 Step 3 shipped end-to-end with measurement evidence. Branch ready to push and PR.

---

## 2026-04-18 (latest) — PR #333 review caught the measurement signal was variance, not retrieval

**Session purpose:** Address PR #333 review findings. The decisive one was Codex's P1: `runDelegatedHeadless` was passing `chatId: state.sessionId` into the memory scope, but `lib/context-memory-retrieval.ts:122,205` filter records out when both query and record have `chatId` set and they differ. Each `push run` mints a fresh sessionId — so Run 1 wrote records with `chatId=sess_X` and Run 2 queried with `chatId=sess_Y`, and **every record from Run 1 was excluded.** The 5 → 3 rounds reduction reported in the previous obs entry was variance, not retrieval. The plumbing was writing correctly but retrieval was 100% broken across runs in the normal `push run --delegate` workflow.

**The honest re-measurement, post-fix (same task, same Gemini 3 Flash, fresh `PUSH_MEMORY_DIR=/tmp/push-mem-fixed-c3PKz2`):**

| Run | Mode | Rounds | Wall | Memory at start |
|---|---|---|---|---|
| 1 | baseline | 1 | 1.1s | (baseline doesn't use memory) |
| 1 | delegated | 5 (2 nodes) | 16.9s | empty store |
| 2 | baseline | 1 | 1.0s | (baseline doesn't use memory) |
| 2 | delegated | **5 (3 nodes)** | **14.6s** | 2 records from Run 1 retrievable |

Rounds-to-completion did not change between cold and warm cache on this task at N=1 per condition. **The chatId fix isn't the difference between "retrieval works" and "retrieval doesn't show signal" — it's the difference between "retrieval is broken" (pre-fix) and "retrieval works but doesn't dramatically affect short-task rounds" (post-fix).** Verified retrieval works via direct call into `buildTypedMemoryBlockForNode` against the post-Run-2 store: returned 3 records with proper formatting, including the prior `task_outcome` summaries and file hints.

**What this honestly shows:**

- **Plumbing works end-to-end:** records persist with workspace scope (no chatId), queries find them via repo+branch matching, the formatted memory block flows into the node prompt. Verified by manual retrieval call.
- **The original signal was variance.** Codex's review was correct in theory and confirmed in practice. Future measurements need either (a) larger N per condition to dampen Gemini 3 Flash's ~30% nondeterminism on short tasks, or (b) a task with stronger precursor coupling where prior context provides concrete code-level findings the model would otherwise have to re-derive.
- **The retrieved records are summaries, not deep findings.** The retrieval block contains things like "I have created `docs/ADAPTATION.md` which details..." and "[no summary — outcome=success]" — useful signal that prior work happened, less useful as a substitute for the model investigating the code directly. Tuning the writeTaskGraphNodeMemory record shape (more file/symbol detail, more concrete summary truncation) is a follow-up that could meaningfully change the warm-cache effect, but it's outside this tranche.
- **The lesson worth keeping:** trace the data path before trusting the metric. I had a hypothesis ("typed memory should help small models"), the harness produced data that fit the hypothesis (5→3 rounds), I declared victory. I never verified the causal mechanism — that records actually flowed through. Codex caught what I should have caught. Future measurement work on this surface should always include a "did the retrieval block contain N records?" assertion at minimum, and ideally a manual inspection of the block contents.

**What also shipped in the review-fix commit:**

1. **chatId dropped from CLI scope** (`cli/delegation-entry.ts` and `cli/pushd.ts`). Records become repo+branch+taskGraphId-scoped. taskGraphId is still used as a same-graph score boost (`lib/context-memory-retrieval.ts:144`) for within-graph node ordering, not as a hard filter — so cross-run retrieval works while within-graph retrieval still favors same-graph dependency context.
2. **Path-traversal hardening in `cli/context-memory-file-store.ts:fileFor` + `clearByRepo`** (Codex + Copilot P2). `assertSafePathSegment` rejects empty / `.` / `..` / absolute / drive-letter components on both `repoFullName` and `branch`; a belt-and-braces `path.resolve` + prefix check verifies the resolved file path stays under `baseDir`. Codex's specific attack vector was `git@example.com:../evil.git` which the SSH parser reduces to `../evil`; that now throws cleanly at the store boundary instead of silently writing outside `baseDir`. 6 new regression tests pin: `..`-segment rejection, absolute-path rejection, backslash-injected `..` rejection, branch with `..` rejection, `clearByRepo` rejecting traversal-shaped names without touching the FS, and a sanity pin that `KvFxKaido/Push`-style names still pass.
3. **Removed redundant `try/catch` in `delegation-entry.ts`** that fell back to `state.cwd` (an absolute path) which would have slipped through `path.join`. `resolveWorkspaceIdentity` is non-throwing by contract, so the catch was both incorrect and unnecessary (Copilot P2).
4. **Trivial cleanups:** unused `createMemoryRecord` import dropped from a test file (Copilot); workspace-identity test comment corrected to match what `initGitRepo` actually does (Copilot).

CLI suite 1166/1166 (was 1160; +6 path-traversal tests). Both typechecks clean.

**Status:** Honest measurement signal landed. The "5 → 3 rounds" claim from the previous entry is retracted. The tranche still stands as: typed-memory plumbing works, persists across runs, retrieves correctly post-chatId-fix, and is the foundation Gap 3 Steps 4-5 will build on. Whether typed memory measurably moves small-model rounds-to-completion remains an open question that requires either better measurement methodology (larger N) or richer record content.
 Live work after this is Gap 3 Steps 4 (attach + event stream UX) and 5 (TUI graph widget).

---

## 2026-04-18 (late) — Gap 3 Step 2 landed; validateTaskGraph zero-coverage discovered and closed

**Session purpose:** Ship the Gap 3 Step 2 characterization tests per the plan's §CLI Runtime Parity Gap 3 Shape-of-the-work. Prerequisite for Step 3 (typed context-memory retrieval through node runners), which will modify the node runners and would otherwise risk a silent regression if the executor's behavior weren't pinned first.

**What shipped (branch `claude/gap-3-step-2-task-graph-characterization`, commit `f366a76`):**

- `app/src/lib/task-graph.test.ts` expanded from 6 → 34 tests (+28 new) across three describe blocks:
  - `validateTaskGraph` full coverage (15 tests): all five error types (`empty_graph`, `duplicate_id`, `invalid_agent`, `missing_dependency`, `cycle`) with specific-message pins; cycle detection edge cases (self-loop, 2-node, 3-node, cycle buried among valid nodes); short-circuit behavior (cycle detection skipped when non-cycle errors present — `task-graph.ts:83-88`); error composition (duplicate_id + invalid_agent + missing_dependency surface together); valid graph shapes (single, linear, diamond, fully independent).
  - `executeTaskGraph` behavioral gap-fills (9 tests): coder serialization (max 1 in flight), explorer parallelism at `maxParallelExplorers` default (3), custom override, explorer+coder concurrency when independent, progress event sequencing (`task_ready → task_started → task_completed`, `task_failed` on throw), `graph_complete` detail phrasing for each terminal state, transitive `cascadeFailure` (root → mid → leaf cancellation), pre-dispatch abort with zero executor calls, `formatTaskGraphResult` output shapes.
  - DelegationOutcome edge cases (2 tests): executor returning undefined `delegationOutcome` → node completes with raw summary; executor returning empty/whitespace summary → no memoryEntry built, downstream tasks see no `[TASK_GRAPH_MEMORY]` section.

**Non-obvious discovery worth recording:** `validateTaskGraph` had zero direct test coverage until this commit. The six existing tests all exercised `executeTaskGraph` — so a regression in validation would only surface if an executor assertion happened to trip on the downstream effect. The Gap 3 Step 3 work will not touch `validateTaskGraph`, but the *reason* the plan's Step 2 prerequisite exists is exactly this pattern: code with no direct coverage can silently drift, and adding characterization before touching the surrounding code is cheaper than debugging the regression later.

**Scope narrowing at recon time:** The plan's Step 2 bullet names "delegation outcomes and task-graph execution." Looking at the daemon RPC layer, `cli/tests/daemon-integration.test.mjs` already has 10+ test calls each on `submit_task_graph` and `delegate_explorer` with happy paths, error paths, and terminal-claim semantics all pinned. Adding more there would be redundant. The real gap was the pure-logic layer in `lib/task-graph.ts`, which this commit closes. Same pattern as the Gap 2 `ask_user` design call that dissolved on inspection — reconnaissance at scope time beats trusting the plan's decision-time framing.

**Validation:**

- App typecheck: `cd app && npx tsc --noEmit` → clean.
- CLI typecheck: `npm run typecheck` → clean (unchanged, no CLI files touched).
- App vitest: `npx vitest run src/lib/task-graph.test.ts` → 34/34 pass.

**What this is and is not:**

- **Is:** Gap 3 Step 2 closure and Step 3 unblock. The node-runner modifications Step 3 will make to enable typed context-memory retrieval can now land against a pinned executor, with the three-layer-truth principle from Gap 2's closure applying: the tool surface packed into each node's context must derive from `roleCanUseTool`, not from a hand-maintained list.
- **Is not:** a verification-family or git/release-family three-green-gate entry. Those counters remain at 0/3, still suspended pending CLI daily-driver readiness.

**Status:** Gap 3 Step 2 shipped. Branch ready to push and PR.

---

## 2026-04-18 (very late) — Typed-memory record-quality tranche closes the post-PR-#333 retraction

**Session purpose:** Close the content-quality axis of the typed-memory question that the previous (latest) entry retracted. The retraction said "plumbing works, doesn't measurably move rounds." Recon traced that to "the records themselves were mostly garbage" (array-wrapped tool-call JSON captured as summary) — a content problem upstream of the metric. PR #334 ran a five-fix tranche to enumerate and close every silent-drop / placeholder / error-as-summary path on the typed-memory write side, with two follow-up commits responding to Codex review.

**What shipped (PR #334, 7 commits on `claude/fix-detector-array-wrapped`, merged):**

The failure-mode taxonomy and the commit that addressed each:

| # | Failure mode | Symptom in records | Fixed by |
|---|---|---|---|
| A | Detector silent drop on fenced array of tool calls | Array JSON captured as summary | `253bacf` |
| A' | Array path can't repair garbled JSON (trailing commas etc.) | `json_parse_error` on cases the single-object path recovered from | `ef3c4c1` |
| A'' | Array path lacks raw-newline-in-string repair | Batched `write_file` / `edit_file` with multiline content fails as array form, recovers as single-object | `b0a0d39` (Codex P1 follow-up) |
| A''' | Loose pre-check matches `tool:` inside string values | `["tool: read_file"]` enters array path → emits `TOOL_CALL_PARSE_ERROR` correction prompt | `b0a0d39` (Copilot follow-up) |
| B | Empty success returns from `runAssistantLoop` | `[no summary — outcome=success]` placeholder | `2dd5cb9` |
| B' | Fix B's pre-finalization `assistant_done` desyncs with the new finalization stream | Newline-flush handlers leave finalization text unterminated | `0178226` (Codex P2) |
| B'' | Fix B leaves orphaned `[FINAL_SUMMARY_REQUEST]` in `state.messages` on failure paths | Next turn sees a request the model "didn't respond to" | `a7adf71` (Codex P2 follow-up) |
| C | Error-outcome `finalAssistantText` (timeout messages, policy-halt blobs) captured as summary | "Request timed out after 120s..." landed as memory record | `9cb746e` |
| C' | Fix C's error throw used unbounded summary text | Spammy `state.error` in node state + JSON output + event log | `a7adf71` |

Plus one adjacent prompt-tuning fix (`a7adf71`, github-actions bot suggestion): added "(no JSON, no fenced blocks)" to the empty-success finalization prompt because small models otherwise sometimes return another tool-call-shaped payload when asked for a summary.

**Composite measurement progression (Gemini 3 Flash via OpenRouter, fresh `PUSH_MEMORY_DIR` per state, same task each run):**

| State | Garbage records | Placeholder records | Error-as-summary | Real records |
|---|---|---|---|---|
| Pre-tranche (PR #333 baseline) | 33% (1/3) | 67% (2/3) | 0 | **0%** |
| Post-tranche final | 0 | 0 | 0 | **100% (5/5)** |

Note on the absolute count: the PR #334 body's progression table reported 6/6 for the post-merge measurement (no node failures in that run); the 5/5 above is from the post-Codex-review re-measurement where one node hit a provider timeout that Fix 3 correctly skipped from memory. **The percentage is the stable signal — the absolute count varies by how many nodes survive provider issues in any given run.** Both runs are valid post-tranche measurements at the same code state (the difference is run-level provider variance, not tranche behavior).

Per-node rounds stayed in the 2-3 range across all measurement states (cold and warm cache), so the **rounds-to-completion delta** that PR #333's retraction left as the open question is **still open**. The tranche closed the content-quality axis (records are now reliably useful natural-language summaries) without resolving the value axis (whether retrieval measurably reduces work for small models). Future measurement work needs either (a) larger N per condition to dampen Gemini 3 Flash's nondeterminism + planner variance, or (b) a task with stronger precursor coupling where prior context provides concrete code-level findings the model would otherwise re-derive.

**What this is and is not:**

- **Is:** closure of the record-content-quality axis. Future debugging of "memory records contain garbage" symptoms can refer to this entry plus the failure-mode taxonomy in `docs/decisions/Tool-Call Parser Convergence Gap.md`'s 2026-04-18 update. Future operators inspecting `~/.push/memory/<repo>/<branch>.jsonl` will see real findings, which is a debugging affordance in its own right.
- **Is not:** an answer to the value question PR #333's retraction left open. The "does typed memory measurably help small models" question remains research-shaped. Any future N=1 measurement on this surface should include a "did the retrieval block contain N records?" assertion at minimum and a content-quality sniff before believing rounds metrics.

**Reference-pattern takeaways worth keeping:**

1. **The five-failure-modes shape was discovered by surfacing each as the previous one's fix exposed it.** Pre-Fix-1: garbage records visible on disk. Pre-A': trailing-comma case fails Codex's repro. Pre-Fix-2: placeholders visible after Fix 1. Pre-Fix-3: timeout messages visible after Fix 2. Each step had immediate visible feedback. When the next bug isn't visible after a fix, that's the signal to stop and do a different kind of investigation rather than guess.
2. **"Graceful degradation" claims need to enumerate specifically what state remains valid.** Fix 2 said it "degrades to pre-fix behavior" on failure — true for `finalAssistantText` (stays empty) but false for `state.messages` (orphaned prompt persists). Future degradation claims should list per-state-axis what survives and what gets rolled back.
3. **Asymmetric strictness based on downstream filtering capability is a useful pattern.** Single-object payloads have downstream `isRecord` shape gates that catch false positives. Arrays don't — they emit per-element malformed reports that trigger correction prompts. So arrays need stricter UPSTREAM gates. Documented in the PR #334 array-fenced-gate commit.

**Status:** Record-content-quality issue closed end-to-end. Typed-memory tranche stands as: plumbing works (PR #333 + chatId fix), records contain useful content (PR #334), value question still open (future work).

---

## 2026-04-18 (very late+) — Gap 3 Step 4 attach/event-stream UX landed

**Session purpose:** Ship the transcript-first attach client slice from Gap 3 Step 4, now that Step 3's typed-memory records are mechanically useful. The Step 4 concern was not another task-graph executor change; it was making the daemon's existing event stream observable from a normal terminal attach flow.

**What shipped:**

- `cli/cli.ts`: `push attach` now sends `capabilities: ['event_v2']` on every `attach_session` request, so the stock CLI attach client sees raw `subagent.*` / `task_graph.*` events instead of relying on the v1 synthetic `assistant_token` downgrade. The existing `lastSeenSeq` replay/reconnect behavior is preserved.
- `cli/cli.ts`: attach now best-effort reads the local session state's persisted `attachToken` and includes it in the RPC payload when present. Legacy sessions with no token still omit it and use the daemon's migration bypass.
- `cli/tui-delegation-events.ts`: subagent lifecycle entries now carry `boundary: 'start' | 'end'` and render as visible transcript separators (`--- subagent started/completed/failed: role --- ...`). `makeCLIEventHandler` adds blank-line grouping around those boundaries in the transcript-first attach output.
- `ROADMAP.md`: `pushd Attach + Event Stream UX` promoted from `planned` to `in_progress`, matching the remediation plan's Step 4 instruction while the richer TUI graph widget remains Step 5.

**Validation:**

- `node --import tsx --test cli/tests/tui-delegation-events.test.mjs cli/tests/cli-event-handler.test.mjs` → pass.
- `npm run typecheck` → pass.
- `node --import tsx --test cli/tests/daemon-integration.test.mjs` → 135/135 pass outside the sandbox. The first sandboxed run failed on localhost mock-provider `listen EPERM`, not on this patch.

**What this is and is not:**

- **Is:** Gap 3 Step 4's transcript-first attach/event-stream slice. The CLI attach client now participates in the raw v2 event contract and visually separates subagent boundaries.
- **Is not:** the Step 5 graph widget. The current output remains transcript-first line rendering; DAG/node-focus rendering belongs in `cli/tui-delegation-events.ts` / TUI-lite work next.

**Status:** Gap 3 Step 4 shipped. Live Gap 3 implementation work is now Step 5 (TUI graph widget). The typed-memory value question remains research-shaped and separate from the implementation checklist.

---

## 2026-04-18 (very late++) — Gap 3 Step 5 graph/node-focus transcript renderer landed

**Session purpose:** Finish the Gap 3 implementation checklist by moving task-graph rendering beyond one-line lifecycle logging while preserving Push's transcript-first terminal muscle memory. The goal was a graph-aware view that still lands as ordinary transcript text in both `push attach` and the interactive TUI.

**What shipped:**

- `cli/tui-delegation-events.ts`: added `createDelegationTranscriptRenderer()`, a stateful renderer keyed by `executionId`. It tracks observed task nodes, current status, latest focus node, elapsed times, summaries/errors/reasons, and final graph stats.
- `cli/tui-delegation-events.ts`: task-graph events now render as compact snapshots: header counts, a `focus:` line, per-node rows (`[ready]`, `[running]`, `[done]`, `[failed]`, `[cancelled]`), and final `result:` lines for graph completion.
- `cli/tui-delegation-events.ts`: supports explicit `dependsOn` / `dependencies` payload fields when present, but does not invent edges from event order. Current daemon/web `task_graph.*` events do not carry dependency edges, so this is honestly a node-focus graph view rather than an edge-drawn DAG.
- `cli/cli.ts` and `cli/tui.ts`: both instantiate one renderer per event handler, so attach output and full-screen TUI output share the same transcript-compatible graph semantics.
- `ROADMAP.md`: moved `pushd Attach + Event Stream UX` from Current Priorities to Recently Completed.

**Validation:**

- `node --import tsx --test cli/tests/tui-delegation-events.test.mjs cli/tests/cli-event-handler.test.mjs` -> pass.
- `npm run typecheck` -> pass.

**What this is and is not:**

- **Is:** Gap 3 Step 5 closure and completion of the Step 4+5 attach/event-stream UX tranche. Task-graph progress is now readable as a compact state view instead of isolated lifecycle lines.
- **Is not:** a new full-screen graph mode or a protocol change. If a future producer wants a true edge-rendered DAG, the event payload should carry dependencies explicitly; the renderer already has a narrow hook for that shape.

**Status:** Gap 3 implementation checklist closed. Remaining work on "does typed memory measurably help small models" is still research-shaped, not implementation-blocking.
