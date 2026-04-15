# Tool-Call Parser Convergence Gap

Status: Known gap, identified 2026-04-15. Contradicts the shared-semantics claim in [Web and CLI Runtime Contract](Web%20and%20CLI%20Runtime%20Contract.md) §2 ("Tool protocol — parsing, repair, and malformed-call handling").
Origin: Debugging a TUI "empty response" bug; raw-socket reproduction against `pushd` showed 452 bytes of malformed fenced tool calls being silently dropped by the CLI parser.

## The Gap

The runtime contract says tool-call parsing, repair, and malformed-call handling are shared semantics. The code says otherwise.

`detectAllToolCalls` — the function that extracts tool-call JSON blocks from assistant text — has **two independent implementations**:

- `app/src/lib/tool-dispatch.ts:157` — web dispatcher
- `cli/tools.ts` (imported by `cli/engine.ts:3`) — CLI-local reimplementation

The low-level *pure-JSON extraction* primitives were extracted to `lib/tool-call-parsing.ts` during the 2026-04-05 Shared Runtime Convergence tranche. But the *high-level tool-typed detection* was not. The module's own header comment acknowledges this explicitly:

> The higher-level tool-typed detection functions (`detectAnyToolCall`, `detectAllToolCalls`, `diagnoseToolCallFailure`) still live in `app/src/lib/tool-dispatch.ts` because they delegate to per-source detectors that are Web-side today.
>
> — `lib/tool-call-parsing.ts:11-16`

That comment was accurate when written. It's aged into an architectural footgun: nothing forced the extraction to complete, and the "partly converged" hedge in the runtime contract doc doesn't name which part.

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

The proper fix is extracting `detectAllToolCalls` + per-source detector registration into a shared `lib/tool-dispatch.ts`, with web and CLI each registering their own tool sources via a DI hook. That's the pattern `app/src/lib/explorer-agent.ts` already uses for its own DI boundary (compat wrapper re-exports from `lib/explorer-agent.ts` and injects web-specific hooks).

Applied to tool-call dispatch, the shape would be:

- `lib/tool-dispatch.ts` — exports `createToolDispatcher(sourceRegistrations)` that returns `detectAllToolCalls`, `detectAnyToolCall`, `diagnoseToolCallFailure`. All tolerance, repair, and malformed-call handling lives here.
- `app/src/lib/tool-dispatch.ts` — compat wrapper that imports the shared dispatcher and registers web sources (github tools, sandbox tools, scratchpad tools).
- `cli/tools.ts` — imports the shared dispatcher and registers CLI sources (local filesystem tools, local exec, etc.).

This is the followup tranche to 2026-04-05 for contract §2, specifically. It's not a bug fix — it's real kernel convergence work and should be planned as such.

## Until Extraction Lands

- Parser robustness fixes need to land in **both** `app/src/lib/tool-dispatch.ts` AND `cli/tools.ts` to stay in sync.
- When debugging "assistant response vanished" or "empty TUI transcript" on CLI, suspect `cli/tools.ts detectAllToolCalls` before suspecting provider, transport, or config.
- Claims about "runtime parity" in `docs/architecture.md`, `ROADMAP.md`, and the parent runtime contract doc should name this gap rather than eliding it under "partly converged."

## Reproducer

If you need to verify the symptom end-to-end:

1. `./push daemon start`
2. Connect via raw NDJSON client to `~/.push/run/pushd.sock`. Send `hello`, `start_session` (provider `ollama`, model `gemini-3-flash-preview`), then `send_user_message` with a conversational prompt (no `Task:` prefix).
3. Observe: `assistant_token` events DO stream (so the provider and daemon transport are healthy). `assistant_done` fires with empty visible content. The session's `state.json` will show `messages[2]` containing the raw pseudo-tool-call bytes or empty, depending on whether the parser ran a partial cleanup pass.
4. Compare against `./push run --task "<same prompt>" --provider ollama --model gemini-3-flash-preview` — headless returns normal prose.

The divergence between (3) and (4) is the four-layer stack above, concentrated at Layer 2.
