# Machine-Readable Output and CLI↔Web Bridge

Design document. Current state + two-phase architecture.

---

## What's Already There

The foundation is largely built. Understanding it prevents duplication.

**`push.runtime.v1` event protocol** — `session-store.mjs` and `pushd.mjs` define a shared envelope:

```json
{
  "v": "push.runtime.v1",
  "kind": "event",
  "sessionId": "sess_...",
  "runId": "run_...",
  "seq": 5,
  "ts": 1708612345678,
  "type": "tool_call",
  "payload": { "toolName": "read_file" }
}
```

**pushd already streams this protocol** — `pushd.mjs:handleSendUserMessage` passes an `emit` function to `runAssistantLoop` that wraps each internal engine event in the `push.runtime.v1` envelope and writes it as NDJSON to the connected Unix socket client.

**Headless mode drops all events** — `cli.mjs:runHeadless` passes `emit: null` to `runAssistantLoop`. All streaming events (tool calls, tokens, results) are silently discarded during execution. A single JSON summary blob is emitted at the end via `--json`. There is no real-time machine-readable output.

**Session files are the audit trail** — `~/.push/sessions/<id>/events.jsonl` contains every `appendSessionEvent` call as NDJSON. These are persistence events (session lifecycle, user messages, acceptance results), not the real-time engine events.

---

## Event Schema Reference

Internal engine events (the `emit` callback in `engine.mjs`):

| `type` | `payload` fields |
|---|---|
| `tool_call` | `toolName` |
| `tool_result` | `text`, `isError` |
| `assistant_token` | `text` |
| `assistant_thinking_token` | `text` |
| `assistant_thinking_done` | _(none)_ |
| `assistant_done` | `text` (full response) |
| `status` | `phase`, `detail` |
| `warning` | `message`, `code` |
| `error` | `message` |
| `run_complete` | `outcome`, `summary`, `rounds` |

These are wrapped in the `push.runtime.v1` envelope by `pushd.mjs:handleSendUserMessage`. The same wrapping needs to happen in headless mode.

---

## Phase 1: NDJSON Streaming to Stdout

**The gap:** `emit: null` in `cli.mjs:runHeadless`.

**The fix:** Add `makeNDJSONEventHandler()` to `cli.mjs` as a parallel to `makeCLIEventHandler()`. Instead of formatting events as human-readable text, it writes each event as a `push.runtime.v1`-envelope NDJSON line to stdout.

```js
function makeNDJSONEventHandler(sessionId, runId) {
  return (event) => {
    process.stdout.write(JSON.stringify({
      v: PROTOCOL_VERSION,
      kind: 'event',
      sessionId,
      runId,
      seq: null, // not tracked in headless; consumers should use ts ordering
      ts: Date.now(),
      type: event.type,
      payload: event.payload ?? {},
    }) + '\n');
  };
}
```

Pass it to `runAssistantLoop` when `--json` is set in headless mode. The existing final-summary JSON blob at the end of `runHeadless` becomes the last `run_complete` event — or can be kept as a separate terminal object for backward compatibility.

**Result:** `push run --task "..." --json` streams one NDJSON line per event, ending with `run_complete`. Pipeable to `jq`, wrappable by scripts, consumable by any process that can spawn `push`.

**Backward-compatible path:** Keep the current single-blob `--json` behavior as `--json` and add `--stream` for NDJSON streaming. Alternatively, detect `--stream` as a distinct flag. Either way, the final summary blob stays for compatibility with any existing scripts.

---

## Phase 2: HTTP/SSE Bridge in pushd

The web app cannot connect to a Unix socket directly. The daemon needs an HTTP surface.

**Add a local HTTP server to `pushd.mjs`** alongside the Unix socket:

```
pushd
├── Unix socket (~/.push/run/pushd.sock) — existing, for CLI attach
└── HTTP server (localhost:PORT, default 47821) — new, for web app
    ├── POST /sessions              → start_session
    ├── POST /sessions/:id/messages → send_user_message
    └── GET  /sessions/:id/stream  → SSE event stream
```

Port is configurable via `PUSHD_HTTP_PORT` env or `~/.push/config.json`. Bound to `127.0.0.1` only — never exposed to network.

**SSE stream** at `/sessions/:id/stream`:
- Client subscribes with `EventSource`
- Server pushes `push.runtime.v1` events as SSE `data:` lines
- Same event format as the Unix socket — identical envelope, identical types
- `Last-Event-ID` header for reconnect gap recovery (maps to `seq`)

**Auth:** `attachToken` issued at `start_session`, required as `Authorization: Bearer <token>` on all subsequent requests. Same token mechanism already in `pushd.mjs`.

**Port discovery:** The web app needs to find the daemon's HTTP port. Options:
- Well-known fixed default (`47821`)
- Port written to `~/.push/run/pushd.port` on start (web app reads it on connect)
- Fallback: try default port, handle connection refused as "daemon not running"

---

## Web App Integration

The web app (React PWA) connects to the local daemon via a **bridge layer** in the service worker or a dedicated hook.

```
Web App (browser)
    └── usePushdBridge hook
          ├── GET http://127.0.0.1:47821/sessions → list sessions
          ├── POST /sessions → start new session
          └── EventSource /sessions/:id/stream → live events
```

`usePushdBridge` subscribes to SSE and dispatches events into the same message pipeline that the web app's existing sandbox/LLM responses flow through. The web app already knows how to render `tool_call`, `assistant_token`, `run_complete` — it just needs a new event source.

**Connection states:**
- `unavailable` — connection refused (daemon not running)
- `connecting` — EventSource opening
- `live` — streaming
- `reconnecting` — EventSource auto-reconnects with `Last-Event-ID`

Show a "Local agent connected" indicator when a pushd session is active. No UI changes needed to render events — the existing chat pipeline handles them.

---

## What Not to Build Yet

- **MCP bridge** — wait for the ecosystem to mature; token overhead is unresolved
- **Bidirectional web→CLI commands** — read-only event streaming first; sending messages from the web app to a running CLI session is a later extension of `send_user_message`
- **Tunnel/ngrok for remote access** — local-only is the right scope for v1; remote access has significant auth surface

---

## Build Order

1. `makeNDJSONEventHandler()` in `cli.mjs` — wire to `runHeadless` under `--stream` flag
2. Stabilize and document the event schema (all `type` values and their `payload` shapes)
3. HTTP server in `pushd.mjs` with SSE `/sessions/:id/stream`
4. `usePushdBridge` hook in the web app
5. "Local agent" indicator in the web app UI

Steps 1–2 are self-contained CLI work. Steps 3–5 require both CLI and web app to be in sync on the event schema, which is why documenting it (step 2) is the gate.
