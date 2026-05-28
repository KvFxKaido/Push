# Tool-Call Parser Convergence Gap

Status: **Resolved 2026-05-28** — both CLI and Web now route through the shared `createToolDispatcher` kernel at `lib/tool-dispatch.ts`. The original CLI side closed 2026-04-15 (missing-fence drop) + 2026-04-18 (four silent-drop modes, PR #334). The Web side closed in a four-PR tranche on 2026-05-28: **#677** extracted phase-grouping to `lib/tool-call-grouping.ts`; **#679** migrated web's `detectAllToolCalls` onto `createToolDispatcher` (textual-order merge, three legacy-fallback shapes); **#680** unified the caps surface (web + CLI both pass `DEFAULT_GROUPING_CAPS`) and split `batchOverflow` from `extraMutations` so the model gets the right correction hint; **#681** added `enableInternalRecovery: false` for callers that run their own gated recovery + closed the recovery-args-region bypass in the legacy fallback. See [*Fix Direction for Layer 2*](#fix-direction-for-layer-2) below for the historical narrative. **The two open follow-ups (per-source `ToolSource` split + bare-block-eligibility loosening) have no current forcing function and are tracked as reference only.**
Origin: Debugging a TUI "empty response" bug; raw-socket reproduction against `pushd` showed 452 bytes of malformed fenced tool calls being silently dropped by the CLI parser.

## The Gap (as originally identified)

The runtime contract said tool-call parsing, repair, and malformed-call handling were shared semantics. The code said otherwise.

`detectAllToolCalls` — the function that extracts tool-call JSON blocks from assistant text — had **two independent implementations**:

- `app/src/lib/tool-dispatch.ts:157` — web dispatcher (still owned here)
- `cli/tools.ts` (imported by `cli/engine.ts:3`) — CLI-local reimplementation (now a thin wrapper around the shared kernel)

The low-level *pure-JSON extraction* primitives were extracted to `lib/tool-call-parsing.ts` during the 2026-04-05 Shared Runtime Convergence tranche. But the *high-level tool-typed detection* was not. The module's own header comment acknowledged this explicitly, and it aged into an architectural footgun: nothing forced the extraction to complete, and the "partly converged" hedge in the runtime contract doc didn't name which part.

The CLI half of that gap is now closed. The Web half is still open — see [*Fix Direction for Layer 2*](#fix-direction-for-layer-2) below for why the Web shape is harder to unify.

## How the Gap Surfaced

Gemini-3-flash-preview on Ollama Cloud, given a conversational prompt through `push daemon`, emitted 452 bytes of malformed pseudo-tool-calls:

```
json
{"tool":"list_dir","args":{"path":"."}}
{"tool":"read_file","args":{"path":"ROADMAP.md"}}
{"tool":"git_status","args":{}}
...
```

Note the missing opening fence. The model knew from the system prompt that tool calls should be fenced JSON blocks, but output `json\n{...}` without the leading triple-backtick. The CLI's `detectAllToolCalls` couldn't extract them (not a valid fenced block), the raw text wasn't rendered as prose either, and `assistant_done` fired with zero visible content. The TUI went silent.

Same prompt through headless `push run` worked — but for a *different* reason: `cli/cli.ts:351` wraps user text in `buildHeadlessTaskBrief` → `buildDelegationBrief`, which prepends `Task: `, and that framing biases the model away from tool-call mode. Headless masks the parser gap via prompt bias; daemon exposes it.

## Four-Layer Stack

The "empty response" symptom is four stacked bugs, not one:

| Layer | Bug | Fix location |
|---|---|---|
| 1. Model bias | Gemini-3-flash on Ollama Cloud emits malformed fenced tool calls when system prompt has heavy TOOL PROTOCOL and user message is conversational | System prompt tuning or model swap |
| 2. **Parser intolerance** | `cli/tools.ts detectAllToolCalls` requires proper fences; silently drops content missing them | `cli/tools.ts` — and *this is the kernel-convergence gap* |
| 3. TUI visibility | `cli/tui.ts handleEngineEvent` renders nothing on empty `assistant_done`, so parser-dropped content is invisible | `cli/tui.ts` |
| 4. Daemon framing | `cli/pushd.ts handleSendUserMessage` sends raw user text without the `Task:` framing that headless uses | `cli/pushd.ts` |

Priority order for fixing these is roughly inverse to layer number — **3 first** (always correct, cheap, decouples visibility from underlying correctness), **2 second** (real kernel work), **4 and 1 optional** (symptom suppressors).

## Fix Direction for Layer 2

### CLI portion — landed 2026-04-15

`lib/tool-dispatch.ts` now exists and exports `createToolDispatcher(sources)`, which takes a list of per-source detectors and returns a `detectAllToolCalls(text)` that owns:

- fenced-block extraction (triple-backtick and tilde variants, optional `json`/`tool` language hints)
- `JSON.parse` + `repairToolJson` fallback (from `lib/tool-call-parsing.ts`)
- **bare-object fallback via `extractBareToolJsonObjects`** — this is the specific primitive that closes the missing-fence drop bug. Scanning the whole text for brace-counted `{tool, args}` objects catches the `json\n{...}` case that was silently dropped before.
- dedup via stable-key serialized args
- malformed reporting for fenced candidates only (silent on bare-object scans to avoid false positives on prose-embedded `{...}` objects)

`cli/tools.ts` now delegates `detectAllToolCalls` / `detectToolCall` to a single pass-through-source dispatcher. The CLI doesn't distinguish by source at parse time — tool-name validation happens downstream in `executeToolCall` — so the pass-through source from `lib/tool-dispatch.ts` (`PASS_THROUGH_CLI_SOURCE`) is the only registration it needs. Twenty pinning tests in `lib/tool-dispatch.test.ts` cover the missing-fence cases, fenced-block cases, dedup, source registration order, and shape validation.

The Layer 3 safety net (see table above) also landed in the same tranche: `cli/tui.ts handleEngineEvent` now tracks a per-run `runVisibleEmissionCount` and surfaces a diagnostic transcript entry on `run_complete` when a run produced zero visible output. That way a future drop-class bug reaches the user as visible text instead of silence.

### Additional CLI silent-drop modes closed 2026-04-18 (PR #334)

The 2026-04-15 closure handled the original missing-fence shape that surfaced as the empty-TUI bug. Four adjacent silent-drop variants stayed open until the typed-memory measurement on PR #333 surfaced them by writing the dropped JSON as memory record summaries. Each was a distinct "model emits tool calls in shape X, detector returns `{calls: [], malformed: []}`" pattern — the engine then declared the run successful with the dropped JSON as the final assistant text.

The four variants and their fixes:

| # | Failure shape | Empirical trigger | Closed by |
|---|---|---|---|
| A | Fenced block containing a JSON **array** of tool calls | Gemini 3 Flash batches planned tool calls into one `[ {...}, {...} ]` block instead of one fence per call | Commit `253bacf`: new `parseToolArrayCandidate` branch in `createToolDispatcher`'s fenced-block phase |
| A' | Fenced array with normal LLM garbling (trailing commas, double commas, unquoted keys, single quotes, Python literals) | Same model emitting `[{...},]` or similar | Commit `b0a0d39`: shared `applyJsonTextRepairs` helper extracted from `repairToolJson` so both object and array paths get the same shape-agnostic textual repairs |
| A'' | Fenced array with literal newlines inside string values | Batched `write_file` / `edit_file` with multiline content args | Commit `b0a0d39` (Codex P1 follow-up): exposed `escapeRawNewlinesInJsonStrings` from `lib/tool-call-parsing.ts` (was internal); array path now does the same two-phase recovery as `repairToolJson` (textual repairs → if still failing, escape raw newlines → retry parse) |
| A''' | Loose pre-check `\btool\s*:` matched `tool:` substring inside string values, so `["tool: read_file"]` entered the array path and emitted spurious `TOOL_CALL_PARSE_ERROR` correction prompts | Conversational responses where the model literally mentioned a tool call as text | Commit `b0a0d39` (Copilot follow-up): array-specific stricter sniff `/\{\s*['"]?tool['"]?\s*:/` requires object-key context. Single-object path keeps the looser pre-check (asymmetric strictness because single-object has a downstream `isRecord` shape gate that arrays lack) |

A separate but adjacent class — **bare objects with prose contamination** breaking `isBareBlockEligible`'s contiguity gate — was identified during the same investigation but deferred. Tracked as the next parser convergence follow-up; would need a similar gate-loosening or a bare-array analogue. Not currently load-bearing because the array fix above is the dominant Gemini 3 Flash shape.

The empirical evidence chain that made these visible was the typed-memory record-quality measurement: pre-tranche, 0% of memory records contained useful natural-language summaries (the rest were dropped tool-call JSON or `[no summary — outcome=success]` placeholders). Post-tranche, 100% useful records on the same task. See `docs/remediation-observations.md` 2026-04-18 entries for the measurement narrative.

**Tests:** `lib/tool-dispatch.test.ts` grew from ~40 to 51 tests across the parser tranche, covering each silent-drop variant with both happy-path (extraction succeeds) and gate-rejection (string-value substrings, non-tool arrays) pins.

### Web portion — closed 2026-05-28

The web tranche landed in four PRs, each closing one piece of the shape-mismatch problem this section originally framed:

| PR | Scope | What it closed |
|---|---|---|
| **#677** | Extract phase-grouping into `lib/tool-call-grouping.ts` (`groupCallsByPhase<T>(calls, predicates, caps)`) | Eliminated the two parallel state machines (web `classifyDetectedCalls` + CLI engine inline grouping). Predicates and caps injected so each surface keeps its own behavior at first. |
| **#679** | Migrate web's `detectAllToolCalls` onto `createToolDispatcher` via a thin single-source adapter (`WEB_DISPATCH_SOURCE`) | Web inherits kernel's fenced + bare extraction, including the fenced-array fix and the four 2026-04-18 silent-drop variants. Three legacy-fallback shapes documented and gated. Textual-order merge between kernel and legacy calls (Codex P1 / Copilot review). |
| **#680** | CLI adopts `DEFAULT_GROUPING_CAPS` (6 parallel reads, 8 file mutations) + kernel splits `batchOverflow` from `extraMutations` | CLI cap divergence closed; rejection handler emits `FILE_MUTATION_BATCH_OVERFLOW` vs `MULTI_MUTATION_NOT_ALLOWED` precisely (Copilot review caught the global-flag misclassification). |
| **#681** | Kernel `enableInternalRecovery: false` opt-out + web `isInsideRecoveryArgsRegion` gate in the legacy fallback | Heuristic recovery (namespaced + XML) can no longer bypass web's outer `!hasExplicitWrappers` gate (Codex P2). Args portion of a recovery shape isn't double-claimed as a bare-args inference. |

Two further follow-ups stay deferred without a forcing function:

- **Per-source `ToolSource` split** — `WEB_DISPATCH_SOURCE` is one adapter that cascades through all nine existing detectors via re-stringify. Splitting into per-detector typed sources buys no behavioral win today because runtime dispatch (`executeAnyToolCall`) branches on `AnyToolCall.source`, not on the kernel source name. Deferred indefinitely.
- **Bare-block-eligibility loosening** — `isBareBlockEligible`'s contiguity gate is conservative; the original doc noted it as "the next parser convergence follow-up." No forcing function today because the array fix above handles the dominant Gemini-3-Flash shape.

## After Convergence (operational notes)

- Parser robustness fixes land in `lib/tool-dispatch.ts` (shared kernel). Both web and CLI pick them up automatically. Web-only post-process (recovery paths, `droppedCandidates` mapping, legacy fallback for shapes the kernel filters) lives in `app/src/lib/tool-dispatch.ts:detectAllToolCalls`.
- When debugging "assistant response vanished" or "empty TUI transcript" on CLI, the Layer 3 safety net surfaces a diagnostic transcript entry instead of rendering nothing. Trace the root cause through `lib/tool-dispatch.ts` (shared kernel) first, then the CLI-side `extractBareToolJsonObjects` in `lib/tool-call-parsing.ts`. The same kernel now backs the web path; debugging steps are the same on both surfaces.
- The cap surface and `batchOverflow` / `extraMutations` split documented in `lib/tool-call-grouping.ts` is the canonical contract — surface-specific custom error codes (e.g. CLI's `FILE_MUTATION_BATCH_OVERFLOW`) consume those lists rather than re-deriving the overflow condition.

## Reproducer

If you need to verify the symptom end-to-end:

1. `./push daemon start`
2. Connect via raw NDJSON client to `~/.push/run/pushd.sock`. Send `hello`, `start_session` (provider `ollama`, model `gemini-3-flash-preview`), then `send_user_message` with a conversational prompt (no `Task:` prefix).
3. Observe: `assistant_token` events DO stream (so the provider and daemon transport are healthy). `assistant_done` fires with empty visible content. The session's `state.json` will show `messages[2]` containing the raw pseudo-tool-call bytes or empty, depending on whether the parser ran a partial cleanup pass.
4. Compare against `./push run --task "<same prompt>" --provider ollama --model gemini-3-flash-preview` — headless returns normal prose.

The divergence between (3) and (4) is the four-layer stack above, concentrated at Layer 2.
