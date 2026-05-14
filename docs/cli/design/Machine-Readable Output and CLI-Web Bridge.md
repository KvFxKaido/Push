# Machine-Readable Output and CLI↔Web Bridge

Design document. Current state + historical bridge sketch.

Status: Historical for the web bridge. The local/remote web bridge shipped through loopback WebSocket and Worker relay adapters, not the HTTP/SSE shape below. The headless NDJSON streaming idea remains a future CLI option if we still want script-consumable real-time events.

---

## What's Already There

The foundation is largely built. Understanding it prevents duplication.

**`push.runtime.v1` event protocol** — `session-store.ts`, `pushd.ts`, and `lib/protocol-schema.ts` define a shared envelope:

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

**pushd already streams this protocol** — `pushd.ts:handleSendUserMessage` passes an `emit` function to `runAssistantLoop` that wraps each internal engine event in the `push.runtime.v1` envelope and writes it as NDJSON to connected Unix-socket clients. The same envelopes also ride the paired loopback WebSocket and Worker relay transports.

**Headless mode drops all events** — `cli.ts:runHeadless` passes `emit: null` to `runAssistantLoop`. All streaming events (tool calls, tokens, results) are silently discarded during execution. A single JSON summary blob is emitted at the end via `--json`. There is no real-time machine-readable output.

**Session files are the audit trail** — `~/.push/sessions/<id>/events.jsonl` contains every `appendSessionEvent` call as NDJSON. These are persistence events (session lifecycle, user messages, acceptance results), not the real-time engine events.

---

## Event Schema Reference

Internal engine events (the `emit` callback in `engine.ts`):

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

These are wrapped in the `push.runtime.v1` envelope by `pushd.ts:handleSendUserMessage`. The same wrapping still needs to happen in headless mode if we add NDJSON streaming there.

---

## Phase 1: NDJSON Streaming to Stdout

**The gap:** `emit: null` in `cli.ts:runHeadless`.

**The fix:** Add `makeNDJSONEventHandler()` to `cli.ts` as a parallel to `makeCLIEventHandler()`. Instead of formatting events as human-readable text, it writes each event as a `push.runtime.v1`-envelope NDJSON line to stdout.

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

## Phase 2: Web Bridge (Superseded)

The shipped bridge did not use HTTP/SSE. It uses:

- `cli/pushd-ws.ts` for loopback-only WebSocket access to the same `handleRequest` dispatcher as the Unix socket.
- `app/src/lib/local-daemon-binding.ts` for Local PC clients.
- `cli/pushd-relay-client.ts`, `app/src/worker/relay-routes.ts`, and `app/src/worker/relay-do.ts` for the Worker/Durable Object relay path.
- `app/src/lib/relay-daemon-binding.ts` for Remote clients.

The exact remote topology and remaining packaging work live in `docs/decisions/Remote Sessions via pushd Relay.md`.

---

## Web App Integration

The web app (React PWA) now connects to daemon-backed sessions through a dedicated binding layer.

```
Web App (browser)
    ├── createLocalDaemonBinding() → ws://127.0.0.1:<port>
    └── createRelayDaemonBinding() → wss://<deployment>/api/relay/v1/session/<id>/connect
```

Both bindings dispatch `push.runtime.v1` envelopes into the daemon chat surface (`DaemonChatBody`) and route sandbox tool requests through the paired daemon.

**Connection states:**
- `unavailable` — connection refused (daemon not running)
- `connecting` — WebSocket opening
- `live` — streaming
- `reconnecting` — hook-managed reconnect/backoff

Show a "Local agent connected" indicator when a pushd session is active. No UI changes needed to render events — the existing chat pipeline handles them.

---

## What Not to Build Yet

- **MCP bridge** — wait for the ecosystem to mature; token overhead is unresolved
- **Direct public WebSocket exposure from a user's PC** — the shipped remote topology uses the Worker relay instead.

---

## Build Order

1. Optional: `makeNDJSONEventHandler()` in `cli.ts` — wire to `runHeadless` under a separate streaming flag.
2. Optional: keep the JSON Schema artifacts in `docs/cli/schemas/` synchronized with the active `lib/protocol-schema.ts` validator, or retire the artifacts.
