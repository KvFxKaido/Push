# Push arm

Runs the bake-off task through Push's own headless lead loop (`push run`).

```bash
node spikes/harness-bakeoff/shared/model-proxy.mjs   # terminal 1
node spikes/harness-bakeoff/arms/push/run.mjs        # terminal 2
```

Each run gets a fresh temp copy of `fixture/` (committed, so `git diff` is
exact) and a throwaway `HOME`, so the real `~/.push` config and sessions are
never read or written. The record lands in `results/push/<runId>.json`; the
native record (the `push.runtime.v1` JSONL stream plus Push's session files) is
`<runId>.transcript.json`.

Settings that keep the comparison fair: `--max-rounds 30` (the CLI maximum;
the default is 8), `PUSH_ANTHROPIC_WEB_SEARCH=0` so the model gets no
server-side tools, and `--allow-exec` because headless blocks exec by default.

## Findings while wiring it up

- **`push run` ignores `--url` and `--api-key`.** Both are listed in
  `push --help`. With `--url` set, the request still went to
  `https://api.anthropic.com/v1/messages`; with `--api-key` set, startup failed
  with "Missing API key". The runner passes `PUSH_ANTHROPIC_URL` and
  `PUSH_ANTHROPIC_API_KEY` through env instead.
- **Push 400s on `claude-haiku-5-5`.** The CLI defaults `temperature: 0.1`, and
  `anthropicModelRejectsSamplingParams` (`lib/anthropic-bridge.ts`) only strips
  sampling params for Opus 4.7+, Sonnet 5, and Fable/Mythos 5. Haiku 5.5 rejects
  non-default sampling values, so the first turn fails with "`temperature` is
  deprecated for this model." Of current models, it's the only one the gate
  misses (Haiku 4.5, Sonnet 4.6, Opus 4.6 still accept `temperature` on the
  `2023-06-01` API version Push sends). The proxy strips sampling params for the
  bake-off; the fix belongs in Push.
- **Push offers Anthropic no native tools, then replays history as if it had.**
  Every request has `tools: []` and a ~23k-character system prompt carrying the
  toolset. The model writes calls as fenced JSON in plain text; Push parses
  them, then re-encodes its own history as native `tool_use` / `tool_result`
  blocks on the next request. Think and Pi offer native tools from the start,
  so this is a real harness difference under test, not a confound.
- **A thinking-only model turn kills the run.** With Haiku 5.5's default
  adaptive thinking, the model sometimes returns a turn with only a thinking
  block. Push replays it as `thinking` + an empty `text` block, Anthropic
  rejects that ("text content blocks must be non-empty"), and the run fails.
  This happens without the proxy too. The proxy doesn't paper over it, because
  that's loop behavior, which is what's under test.
