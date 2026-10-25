# Pi arm

`PiHarness` (Agents SDK 0.30.1, Pi Durable 1.4.0) in a Durable Object (`PiRun`, one per run).
Tools run in the container attached to that object (`ctx.container`, `scheduling_policy:
"durable_object"`, image built from `shared/Dockerfile` with build context
`spikes/harness-bakeoff/`). The model is `claude-haiku-5-5` through the bake-off proxy at
`MODEL_BASE_URL` (`http://127.0.0.1:8789/pi`), with a placeholder key.

| File | What |
|---|---|
| `src/index.ts` | Worker routes, the DO, the Pi factory and model provider, host-side verify, run record |
| `src/tools.ts` | `run_command` / `read_file` / `write_file` from `shared/task.mjs`, on the container |
| `src/faux.ts` | `FAUX=1` only: a scripted stand-in model for plumbing checks without credentials |
| `run.mjs` | Runner: starts a run, waits, writes `results/pi/<runId>.json` + `<runId>.transcript.json` |

## Install

```bash
cd spikes/harness-bakeoff/arms/pi
pnpm install --ignore-workspace   # the flag is load-bearing: this arm must not join the repo's pnpm workspace
```

## Run

**Local container dev needs Linux, macOS, or WSL.** On Windows, `wrangler dev` refuses:
"Local development with containers is currently not supported on Windows. You should use WSL
instead." Docker must be running (Docker Desktop with WSL integration works). On Windows, run from
a Linux-side copy so the two `node_modules` never collide:

```bash
# inside WSL
rsync -a --exclude node_modules --exclude results --exclude .wrangler \
  /mnt/c/dev/Push-bakeoff/spikes/harness-bakeoff/ ~/bakeoff-pi/
cd ~/bakeoff-pi/arms/pi && pnpm install --ignore-workspace
node ../../shared/model-proxy.mjs &              # unless the proxy is already on :8789
npx wrangler dev --port 8792 &
PI_ARM_URL=http://127.0.0.1:8792 node run.mjs
```

Routes: `POST /run` (waits; `?wait=0` returns the receipt), `GET /runs/<id>/status`
(`harness.pending()` and `busy()`), `GET /runs/<id>/result` (waits for pi, then verifies; idempotent,
the record is stored in the DO).

Interruption test: `node run.mjs` prints `runId` at submit; kill `wrangler dev` mid-turn, start it
again, then `node run.mjs --resume <runId>`. `npx wrangler dev --var FAUX:1` runs the same flow
with the scripted model (step 2 is `sleep 20`, a window to kill in).

Checks without Docker: `pnpm run check` (tsc) and `pnpm run dry-run` (`wrangler deploy --dry-run`;
this one builds the image, so it needs Docker too).

## API notes

- **Custom Anthropic base URL works.** `PiHarness` never chooses a model provider: the factory
  builds pi-ai `Models` itself. pi-ai's `createProvider()` takes any `api` implementation, and
  `anthropicMessagesApi()` passes `model.baseUrl` to the Anthropic SDK as `baseURL`. This arm uses
  pi-ai's own catalog entry for `claude-haiku-5-5` with `baseUrl` replaced and its own provider id
  (`bakeoff-proxy`), so nothing can fall back to `ANTHROPIC_API_KEY` or api.anthropic.com.
  `createAI({ binding })` from `agents/models/pi-ai` is only the Workers AI / AI Gateway route.
- **No built-in tools unless installed.** `createRegistry()` starts empty; the model is offered
  only what extensions bring. One wrinkle on the wire: pi-ai's Anthropic adapter appends a
  `__pi_deferred_placeholder__` tool with `defer_loading: true` to every request for models with
  `compat.supportsMidConvoToolChanges` (it keeps Anthropic's tool-change scaffolding in the
  prompt-cache prefix). The model cannot call it, but a wire log shows four tool definitions.
- **System prompt is a section, stored as a transcript entry.** The `pi.system` entry comes after
  the first `pi.user` entry, and only changed sections are sent again.
- **Transcript.** `harness.messages()` returns pi's `EntryRecord`s (`pi.user`, `pi.system`,
  `pi.assistant` with `toolCall` parts, `pi.tool-result`). Tool inputs and outputs are all there,
  so `toolCalls` in run.json is rebuilt from it. `session().events()` gives a snapshot (`entries`,
  `tools`, `inbox`, `agent`, `usage`, ...) and then live batches; it lives in memory with no cursor.
- **Usage.** `(await harness.pi()).usage(ctx)` gives per-model `input` / `output` / `cacheRead` /
  `cacheWrite`. run.json takes `input` and `output`; cache counts go in `notes`. A failed attempt
  (such as a 401) counts as zeros, not null.
- **Approvals: none.** Pi Durable has no approval or permission round trip. The closest thing is a
  `ToolTask` `beforeTool` hook that can block or rewrite a call, decided in code, with no human.
  Not used here.
- **Interruption.** `submit()` with `operationId` is durable before it resolves. The Lifecycle
  wake job keeps a 30 s heartbeat alarm while pi works. On reopen, `replay: "safe"` tools rerun,
  and others become an error result: "Tool run_command was interrupted and may have partially run".
  That result is in pi's own transcript. Losing the container is not pi's concern: this arm restarts
  it, resets `/workspace`, and says so in `notes`.
- **Platform cost: local container dev needs WSL/Linux/macOS.** A Windows developer has to keep a
  second, Linux-side checkout and `node_modules` just to run the container.
- **`wrangler dev` sometimes hot-reloads right after a container starts** ("Reloading local
  server..."). Seen in 3 of 4 local sessions, cause unknown. pi treats the reload as a restart, so
  a `run_command` in flight at that moment comes back "interrupted". One plumbing run hit this with
  nothing killed.
- **Tool rounds run in parallel by default** (`settings.toolExecution`). Left at the default.
- **Thinking** is pi's default for a new session, `off`.
- **Retry on submit.** `harness.submit()` with the same `operationId` returns `accepted: false`
  and the same operation, so `start()` is safe to repeat.
