/**
 * Headless driver for `runTUI` (TUI Decomposition Phase 0 — see
 * `docs/decisions/TUI Decomposition - Testability Seam and Daemon Session
 * Controller.md`).
 *
 * `runTUI` historically grabbed `process.stdin`/`process.stdout` and a real
 * daemon socket, so every behavior in the 6,500-line closure was verifiable
 * only by driving a live terminal. This harness uses the `options.io` /
 * `options.deps` seam to run it in-process:
 *
 *   - a fake stdin (EventEmitter) so we can feed keystrokes,
 *   - a capture stdout/stderr,
 *   - no-op signal/exit hooks so the closure can't register real process
 *     handlers or terminate the test runner,
 *   - a STUB daemon client that records the `{type, payload}` of every
 *     `request()` and returns canned envelopes,
 *   - an `onState` hook to read `tuiState.transcript` directly.
 *
 * The point is to exercise the REAL input→dispatch→send path: feeding
 * `/revert 3` drives `onData` → `parseKey` → composer → `sendMessage` →
 * `handleSlashCommand` → `sendDaemonSessionVerb` → the stub's `request()`. A
 * wiring regression anywhere on that path fails the characterization test.
 */
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { runTUI } from '../tui.ts';
import { PROTOCOL_VERSION } from '../../lib/protocol-schema.ts';

/** Accepted hello payload the stub returns by default. */
function defaultHelloPayload() {
  return {
    protocolVersion: PROTOCOL_VERSION,
    runtimeVersion: 'test-runtime',
    capabilities: [],
  };
}

/** Minimal config the TUI needs at startup (provider + theme + exec patterns). */
function defaultConfig(provider) {
  return {
    provider,
    theme: 'mono',
    safeExecPatterns: [],
    // Disable daemon autostart so the only connect path is our stub
    // `tryConnect` probe — never a real spawn.
    daemonAutoStart: false,
  };
}

/**
 * Build the io/deps/onState wiring + a stub daemon client. `verbResponses` maps
 * a request `type` to either a response envelope, or `{ rejectCode, message }`
 * to make `request()` reject (the daemon-client contract: non-ok envelopes
 * REJECT with `err.code`).
 */
export function createTuiHarness({
  provider = 'zen',
  verbResponses = {},
  config,
  deps: extraDeps,
} = {}) {
  const requests = [];
  const stdoutChunks = [];
  const stderrChunks = [];
  const eventCallbacks = new Set();

  const stdin = new EventEmitter();
  stdin.isTTY = false;
  stdin.setRawMode = () => {};
  stdin.resume = () => {};
  stdin.setEncoding = () => {};
  stdin.pause = () => {};

  const stdout = {
    write: (chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    },
    on: () => {},
    removeListener: () => {},
  };
  const stderr = { write: (chunk) => stderrChunks.push(String(chunk)) };

  let exited = null;
  const io = {
    stdin,
    stdout,
    stderr,
    exit: (code) => {
      exited = code;
    },
    addSignalHandler: () => {},
    removeSignalHandler: () => {},
  };

  const socket = new EventEmitter();
  const stubClient = {
    connected: true,
    request(type, payload, sessionId) {
      requests.push({ type, payload, sessionId });
      if (type === 'hello') {
        return Promise.resolve({ kind: 'response', payload: defaultHelloPayload() });
      }
      if (type === 'start_session') {
        return Promise.resolve({
          kind: 'response',
          payload: { sessionId: 'stub-session', attachToken: 'stub-token' },
        });
      }
      const canned = verbResponses[type];
      if (canned && canned.rejectCode) {
        const err = new Error(canned.message ?? `${type} rejected`);
        err.code = canned.rejectCode;
        return Promise.reject(err);
      }
      return Promise.resolve(canned ?? { kind: 'response', payload: {} });
    },
    onEvent(cb) {
      eventCallbacks.add(cb);
      return () => eventCallbacks.delete(cb);
    },
    close() {},
    _socket: socket,
  };

  let state = null; // { tuiState, composer }
  const onState = (ctx) => {
    state = ctx;
  };

  let resolveInputReady;
  const inputReady = new Promise((resolve) => {
    resolveInputReady = resolve;
  });
  const onInputReady = () => resolveInputReady();

  const deps = {
    loadConfig: async () => config ?? defaultConfig(provider),
    listSessions: async () => [],
    tryConnect: async () => stubClient,
    // Test-specific injections (e.g. `runHandoffChild` for terminal-handoff
    // tests) ride through to runTUI's deps seam.
    ...(extraDeps ?? {}),
  };

  return {
    io,
    deps,
    onState,
    requests,
    stdoutChunks,
    stderrChunks,
    stubClient,
    onInputReady,
    inputReady,
    /** Push a daemon event to all registered `onEvent` callbacks. */
    emitDaemonEvent: (event) => {
      for (const cb of eventCallbacks) cb(event);
    },
    get tuiState() {
      return state?.tuiState ?? null;
    },
    get composer() {
      return state?.composer ?? null;
    },
    get exitCode() {
      return exited;
    },
    requestsOfType: (type) => requests.filter((r) => r.type === type),
  };
}

const tick = () => delay(2);

/**
 * Launch `runTUI` headlessly. Returns the harness plus a `promise` (the
 * still-running TUI) and driver methods. Does NOT await `runTUI` — it only
 * resolves once the TUI exits (via `stop()`), so callers drive then stop.
 */
export async function startHeadlessTui(opts = {}) {
  // The provider's `resolveApiKey` runs at startup and throws without a key.
  // Seed a dummy for the default `zen` provider — no network call is ever made
  // (the daemon client is stubbed), so any non-empty value is fine.
  process.env.PUSH_ZEN_API_KEY ||= 'test-key';
  const h = createTuiHarness(opts);
  // Capture an async `runTUI` failure rather than letting it become an
  // unhandled rejection: the harness attaches the promise but doesn't await it
  // until `stop()`, so a startup/run error would otherwise be reported only as
  // a PromiseRejectionHandledWarning. We stash it and surface it at the next
  // gate (`stop()` re-throws; the input-ready wait short-circuits on it).
  let runError = null;
  h.promise = runTUI({
    provider: opts.provider ?? 'zen',
    io: h.io,
    deps: h.deps,
    onState: h.onState,
    onInputReady: h.onInputReady,
    ...(opts.runTuiOptions ?? {}),
  }).catch((err) => {
    runError = err;
  });
  h.getRunError = () => runError;

  async function waitFor(predicate, { timeoutMs = 4000, intervalMs = 10 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await delay(intervalMs);
    }
    return false;
  }
  h.waitFor = waitFor;

  // Gate on the input-listener registration, NOT the "Connected" status: the
  // status is emitted near the top of setup, but `io.stdin.on('data')` is wired
  // ~4,000 lines later. Feeding before that drops the first keystrokes. If
  // `runTUI` dies during startup, `h.promise` resolves early (caught) — surface
  // the real error instead of waiting out the input-ready timeout.
  await Promise.race([
    h.inputReady,
    h.promise.then(() => {
      throw runError ?? new Error('headless TUI exited before signaling input-ready');
    }),
    delay(4000).then(() => {
      throw new Error('headless TUI did not signal input-ready within timeout');
    }),
  ]);
  // Then wait for the daemon connect to land so verbs have a connected client.
  await waitFor(() =>
    (h.tuiState?.transcript ?? []).some(
      (e) => typeof e.text === 'string' && e.text.includes('pushd daemon'),
    ),
  );

  // Feed characters one `data` event at a time, but synchronously in a tight
  // loop (no await between): `onData` processes each event synchronously, so
  // the composer accumulates every char before any async render runs. Awaiting
  // between chars let the render scheduler interleave and drop some. Per-char
  // (not whole-chunk) because `splitRawInputChunk` only splits plain runs — a
  // `/`-led command line isn't split, so a single chunk mis-parses.
  async function type(str) {
    for (const ch of str) h.io.stdin.emit('data', Buffer.from(ch, 'utf8'));
    await tick();
  }

  async function typeLine(str) {
    await type(str);
    h.io.stdin.emit('data', Buffer.from('\r'));
    await delay(opts.settleMs ?? 30);
  }

  /** Feed a raw byte sequence (e.g. Ctrl+D = \x04) without a trailing Enter. */
  async function feed(bytes) {
    h.io.stdin.emit('data', Buffer.from(bytes));
    await delay(opts.settleMs ?? 40);
  }

  /** End the TUI cleanly (Ctrl+D resolves the exit promise) and await teardown. */
  async function stop() {
    h.io.stdin.emit('data', Buffer.from('\x04'));
    await Promise.race([h.promise, delay(2000)]);
    if (runError) throw runError;
  }

  return Object.assign(h, { type, typeLine, feed, stop });
}
