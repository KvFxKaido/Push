# Tool-Call Parser Convergence Gap

Status: **CLI side resolved 2026-04-15.** The CLI now routes tool-call detection through the shared `createToolDispatcher` kernel at `lib/tool-dispatch.ts`, which adds the bare-object fallback that closes the missing-fence drop. Web-side unification still pending — see [*Fix Direction for Layer 2*](#fix-direction-for-layer-2) below for the remaining work.
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

### Web portion — still pending

The web path is **not** migrated onto `createToolDispatcher` yet, and shouldn't be in a single commit because of a shape mismatch:

- Web `DetectedToolCalls` = `{ readOnly, fileMutations, mutating, extraMutations }` — calls grouped by execution phase (parallel reads → sequential file mutations → at most one trailing side-effect) so the caller can enforce the per-turn mutation transaction contract at `useChat.ts`.
- CLI `DetectedToolCalls` / shared kernel = `{ calls, malformed }` — flat list; the CLI engine runs its own state-machine grouping at `cli/engine.ts` around line 948 onwards (identical semantics, different file).

Unifying the two requires lifting the grouping state machine out of both shells into a second shared primitive (something like `groupCallsByPhase`) that both the web dispatcher and `cli/engine.ts` can call on top of `createToolDispatcher`. It also requires migrating ~14 web-side per-source detectors (`detectToolCall`, `detectSandboxToolCall`, `detectScratchpadToolCall`, `detectWebSearchToolCall`, `detectAskUserToolCall`, plus the inline delegation shape detector and the bare-args recovery path) into `ToolSource` registrations. That's real kernel convergence work and should be planned as its own tranche.

The architectural shape is already there — the web dispatcher can adopt `createToolDispatcher` whenever that tranche is scheduled without touching the kernel again.

## Until Full Extraction Lands

- CLI parser robustness fixes should now land in `lib/tool-dispatch.ts` — the CLI picks them up automatically. Web-side fixes still need to land in `app/src/lib/tool-dispatch.ts` until the second tranche unifies the grouping state machine.
- When debugging "assistant response vanished" or "empty TUI transcript" on CLI, the Layer 3 safety net now surfaces a diagnostic transcript entry instead of rendering nothing, so the symptom is visible. Trace the root cause through `lib/tool-dispatch.ts` (shared kernel) first, then the CLI-side `extractBareToolJsonObjects` in `lib/tool-call-parsing.ts`.
- Claims about "runtime parity" in `docs/architecture.md`, `ROADMAP.md`, and the parent runtime contract doc should call out the CLI-side resolution and the remaining Web-side unification work, rather than eliding both under "partly converged."

## Reproducer

If you need to verify the symptom end-to-end:

1. `./push daemon start`
2. Connect via raw NDJSON client to `~/.push/run/pushd.sock`. Send `hello`, `start_session` (provider `ollama`, model `gemini-3-flash-preview`), then `send_user_message` with a conversational prompt (no `Task:` prefix).
3. Observe: `assistant_token` events DO stream (so the provider and daemon transport are healthy). `assistant_done` fires with empty visible content. The session's `state.json` will show `messages[2]` containing the raw pseudo-tool-call bytes or empty, depending on whether the parser ran a partial cleanup pass.
4. Compare against `./push run --task "<same prompt>" --provider ollama --model gemini-3-flash-preview` — headless returns normal prose.

The divergence between (3) and (4) is the four-layer stack above, concentrated at Layer 2.
