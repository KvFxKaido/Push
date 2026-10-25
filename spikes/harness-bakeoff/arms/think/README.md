# Think arm

One coding task on `@cloudflare/think` (the `Think` base class) in a Durable
Object. The three shared tools (`run_command`, `read_file`, `write_file`) run in
the container attached to that DO (`this.ctx.container`), built from
`shared/Dockerfile`. One DO, and so one container, per run.

| File | What |
|---|---|
| `src/index.ts` | Worker routes + the `ThinkArm` DO (agent, tools, run record) |
| `wrangler.jsonc` | DO + container (`scheduling_policy: "durable_object"`, image `bakeoff`), `MODEL_BASE_URL` var |
| `run.mjs` | Runner: drives `wrangler dev`, writes `results/think/<runId>.json` + `.transcript.json` |

## Install

The repo root is a pnpm workspace; this arm must not join it:

```bash
cd spikes/harness-bakeoff/arms/think
pnpm install --ignore-workspace
```

Versions are pinned exactly in `package.json`. `@cloudflare/computer` is pinned
to 0.5.1, not the latest 0.7.0: Think 0.21.0 imports it statically and declares
the peer range `^0.5.1`.

## Run

**Container local dev does not work on Windows.** `wrangler dev` stops with
"Local development with containers is currently not supported on Windows. You
should use WSL instead." Run it on Linux, macOS or WSL2, with Docker running.
On this machine that means a Linux-side copy of `spikes/harness-bakeoff/`
(same tree, so `../../shared` resolves), installed there, so the Windows and
Linux `node_modules` never mix.

```bash
# terminal 1: the shared model front door (see shared/model-proxy.mjs)
node spikes/harness-bakeoff/shared/model-proxy.mjs

# terminal 2: the arm (first start builds the image from shared/Dockerfile)
cd spikes/harness-bakeoff/arms/think
WRANGLER_REGISTRY_PATH=$HOME/.think-arm-registry npx wrangler dev --port 8791

# terminal 3
THINK_ARM_URL=http://127.0.0.1:8791 node run.mjs              # submit, then poll /status
THINK_ARM_URL=http://127.0.0.1:8791 node run.mjs --sync       # one blocking POST /run
THINK_ARM_URL=http://127.0.0.1:8791 node run.mjs --resume <runId>
```

`WRANGLER_REGISTRY_PATH` gives this `wrangler dev` its own dev registry. Any
reload of the local server during a request drops that request with "Your
worker restarted mid-request".
- Fact: with the shared registry and the Pi arm's `wrangler dev` running, the
  server reloaded once right after starting. With a private registry, that
  startup reload stopped.
- Fact: the other reloads I traced were esbuild rebuilds after source files
  changed, including my own re-syncs into the Linux copy.
- Inference: wait a few seconds after editing before you POST.

Worker routes:
- `POST /run`: runs the turn and returns `{ run, transcript }`. Node's `fetch`
  gives up waiting for headers after 300 s, so the runner defaults to the async pair.
- `POST /start`: `runTurn({ mode: "submit" })`, a durable submission. Returns `{ runId, submissionId }` at once.
- `GET /status?runId=`: the submission status. Once it is terminal, it runs the
  host-side checks once and returns `{ run, transcript }`.

### Interruption test (stretch, not yet run)

Run `node run.mjs` and kill `wrangler dev` mid-turn. The runner keeps polling.
Restart `wrangler dev` with the same state directory, and the runner picks the
run up (or use `--resume <runId>`).

- **What Think claims (docs, "Durable recovery"):** every turn, including
  `submitMessages()` executions, runs in a recoverable fiber. After an eviction,
  Think persists the partial output and schedules a continuation or retry on the
  DO alarm. A tool call left without a result is repaired into an errored tool
  result, so the model does not silently re-run it.
- **What this code does:** it relies on that recovery and adds nothing. The
  container does not survive `wrangler dev` dying, and `/workspace` is created
  per run, not baked in. So when a tool runs in a fresh container, the arm
  re-runs `reset-workspace` and writes a note in `run.notes`: "container was
  (re)started mid-run ... earlier edits lost". The record says the run was
  interrupted instead of pretending it was continuous. Usage counts only steps
  that finished, and `toolCalls` lives in DO storage, so both survive the restart.

## API notes

Each note is marked Fact (seen in code, on the wire, or in a run) or Inference.

- **System prompt (Fact, `think.js` `_systemPromptForTurn`):** Think appends a
  "You are running inside a Think agent. Capabilities available..." block to
  `getSystemPrompt()`. Returning `system` from `beforeTurn` replaces it. The
  arm does that, and the wire log shows exactly `SYSTEM_PROMPT`.
- **Tools (Fact, wire log):** with `beforeTurn` returning `activeTools`, the
  request carries exactly `run_command`, `read_file` and `write_file`, with the
  shared schemas word for word. Think's built-in workspace tools are not sent.
  `@ai-sdk/anthropic` adds `eager_input_streaming: true` to each tool and
  sends `max_tokens: 128000`.
- **Step cap (Fact):** `maxSteps` defaults to 10 per turn. The arm raises it
  to 50 so the cap is not what the bake-off measures.
- **Transcript (Fact):** `this.messages` is the native record (`UIMessage[]`,
  read from the Session tree in DO SQLite). The arm saves it untouched as
  `<runId>.transcript.json`. On a turn that failed before any output (the
  fake-key 401), the transcript holds only the user message. The error appears
  only in the submission ledger (`inspectSubmission().error`) and the logs.
- **Token usage (Fact for the API; not observed):** usage is not in the
  transcript by default. `onStepFinish(ctx).usage` carries it per step, and the
  arm sums it. No step has completed against a real model yet, so it is still
  `null`. `messageMetadata` could stamp usage into the transcript, but that
  would change the native record.
- **Approvals (Fact for the API; Inference for the effect):** with
  `needsApproval`, the tool call goes to the client, and the conversation
  pauses until a `CF_AGENT_TOOL_APPROVAL` message arrives over the WebSocket.
  A programmatic `runTurn` has no WebSocket client, so a gated tool would
  presumably park the turn. Not tested. `beforeToolCall` returning `block` is
  the server-side policy seam.
- **Container entrypoint (Fact, local dev):** passing
  `start({ entrypoint: ["sleep","infinity"] })` as the Sandbox docs do set
  both Entrypoint and Cmd on the local container. The container ran
  `sleep infinity sleep infinity`, exited 1 ("invalid time interval 'sleep'")
  and crash-looped. The image already has that ENTRYPOINT, so the arm passes
  none. Whether production behaves the same is unknown.
- **`runTurn` is marked `@experimental`.** `waitForSubmission` waits in
  memory and rejects if the object restarts, which is why `/status` polls
  `inspectSubmission` instead.
- **`git diff` misses new files (Fact):** `verify.diff` is
  `git diff -- . ':(exclude)test'` as specified, and it does not show untracked
  files. A fix that only adds a file would show an empty diff.
- **`run_command` timeout (Fact):** `timeout --kill-after=5 60 bash -lc ...`
  stopped a `sleep 90` after about 65.5 s with exit code 124. `bash -lc`
  outlived the TERM, so the KILL ended it.
