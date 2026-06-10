/**
 * RunHost Durable Object — Durable Runs (Adopt-on-Silence) track.
 *
 * The binding + v5 migration are durable infrastructure for the track
 * (Phase 2 puts the adoption loop, heartbeat ledger, and checkpoint
 * persistence here). Everything else in this file is **Phase 0 spike
 * code** — throwaway latency instruments whose numbers get recorded in
 * `docs/decisions/Durable Runs — Adopt-on-Silence.md` and then deleted
 * when Phase 2 replaces the internals.
 *
 * Spike endpoints (reached via /api/runhost/spike/* — see
 * run-host-routes.ts):
 *
 *   POST /spike/relay        — call the Worker provider handler directly
 *                              (same mechanism as the CoderJob stream
 *                              adapter) and pipe the SSE body back
 *                              unmodified except for injected SSE comment
 *                              lines carrying DO-side timing marks. The
 *                              client measures its own TTFB/TTFT; the
 *                              marks decompose where the time went.
 *   POST /spike/server-turn  — the DO consumes the provider stream
 *                              itself and returns timing JSON only. This
 *                              is the "adopted run" datum: a provider
 *                              turn with no phone in the loop at all.
 *   GET  /spike/ws           — WebSocket upgrade; the first client frame
 *                              carries the same request body, deltas come
 *                              back as JSON frames. Measures the
 *                              WS-from-DO delivery path the attach/viewer
 *                              phase would use.
 *
 * No durable storage is used by the spike. Provider credentials never
 * leave the Worker isolate — handlers are called as functions with `env`,
 * exactly like the CoderJob / PrReviewJob DOs.
 */

import type { DurableObjectState, WebSocket as CfWebSocket } from '@cloudflare/workers-types';
import type { AIProviderType } from '@push/lib/provider-contract';
import { resolveProviderHandler } from './coder-job-stream-adapter';
import type { Env } from './worker-middleware';

// ---------------------------------------------------------------------------
// Spike request shape
// ---------------------------------------------------------------------------

export interface SpikeChatRequest {
  provider: AIProviderType;
  model: string;
  /** Convenience single-turn prompt; ignored when `messages` is present. */
  prompt?: string;
  messages?: Array<{ role: string; content: string }>;
  maxTokens?: number;
  /** Route `zen` through the OpenCode Zen "Go" endpoint. */
  zenGo?: boolean;
}

const DEFAULT_PROMPT =
  'Count from 1 to 30 as words (one, two, three, ...), comma-separated, no other text.';
const DEFAULT_MAX_TOKENS = 256;
const SPIKE_TURN_TIMEOUT_MS = 60_000;

function parseSpikeBody(raw: unknown): SpikeChatRequest | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  if (typeof body.provider !== 'string' || typeof body.model !== 'string') return null;
  const messages = Array.isArray(body.messages)
    ? body.messages.filter(
        (m): m is { role: string; content: string } =>
          typeof m === 'object' &&
          m !== null &&
          typeof (m as Record<string, unknown>).role === 'string' &&
          typeof (m as Record<string, unknown>).content === 'string',
      )
    : undefined;
  return {
    provider: body.provider as AIProviderType,
    model: body.model,
    prompt: typeof body.prompt === 'string' ? body.prompt : undefined,
    messages: messages && messages.length > 0 ? messages : undefined,
    maxTokens: typeof body.maxTokens === 'number' ? body.maxTokens : undefined,
    zenGo: body.zenGo === true,
  };
}

/**
 * Build the internal Request for a direct provider-handler call. Mirrors
 * the CoderJob stream adapter: OpenAI-compatible payload, Origin set to
 * the deployment origin (forwarded by the route layer via X-Spike-Origin,
 * server-derived — never client-trusted), and a stable X-Forwarded-For
 * bucket so spike traffic rate-limits independently of real users.
 */
function buildProviderRequest(
  origin: string,
  spec: SpikeChatRequest,
  signal: AbortSignal,
): Request {
  const messages = spec.messages ?? [{ role: 'user', content: spec.prompt ?? DEFAULT_PROMPT }];
  const body = JSON.stringify({
    model: spec.model,
    messages,
    stream: true,
    max_tokens: spec.maxTokens ?? DEFAULT_MAX_TOKENS,
  });
  const zenGo = spec.provider === 'zen' && Boolean(spec.zenGo);
  return new Request(`${origin}/api/${zenGo ? 'zen/go' : spec.provider}/chat`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Origin: origin,
      'X-Forwarded-For': 'spike:run-host',
    },
    body,
    signal,
  });
}

// ---------------------------------------------------------------------------
// Minimal SSE delta extraction (spike-local; the production pump lives in
// coder-job-stream-adapter.ts and yields PushStreamEvents — overkill here)
// ---------------------------------------------------------------------------

interface SseScanState {
  buffer: string;
  done: boolean;
}

/**
 * Race a stream read against the turn deadline. The dispatch-time
 * AbortController should cancel a stalled upstream, but signal propagation
 * through every provider handler isn't guaranteed — without this race a
 * provider that stops emitting would hang the DO turn on a bare
 * `await reader.read()` forever.
 */
async function readWithDeadline<T>(promise: Promise<T>, deadlineEpochMs: number): Promise<T> {
  const remaining = deadlineEpochMs - Date.now();
  if (remaining <= 0) throw new Error('spike turn timed out');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('spike turn timed out')), remaining);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Feed a decoded chunk; returns the text deltas it completed. */
function scanSseChunk(state: SseScanState, chunk: string): string[] {
  state.buffer += chunk.replace(/\r\n/g, '\n');
  const deltas: string[] = [];
  let idx = state.buffer.indexOf('\n\n');
  while (idx !== -1) {
    const rawEvent = state.buffer.slice(0, idx);
    state.buffer = state.buffer.slice(idx + 2);
    for (const line of rawEvent.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') {
        state.done = true;
        continue;
      }
      try {
        const parsed = JSON.parse(data) as {
          choices?: Array<{ delta?: { content?: string } }>;
        };
        const delta = parsed.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta.length > 0) deltas.push(delta);
      } catch {
        // Heartbeats / non-JSON control frames — skip quietly.
      }
    }
    idx = state.buffer.indexOf('\n\n');
  }
  return deltas;
}

// ---------------------------------------------------------------------------
// RunHost DO
// ---------------------------------------------------------------------------

export class RunHost {
  private readonly env: Env;

  constructor(_state: DurableObjectState, env: Env) {
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/spike/relay' && request.method === 'POST') {
      return this.spikeRelay(request);
    }
    if (url.pathname === '/spike/server-turn' && request.method === 'POST') {
      return this.spikeServerTurn(request);
    }
    if (url.pathname === '/spike/ws') {
      return this.spikeWs(request);
    }
    return json({ error: 'NOT_FOUND' }, 404);
  }

  /** Resolve handler + build the provider Request, or produce an error
   * Response. Shared preamble for all three spike arms. */
  private prepareDispatch(
    request: Request,
    rawBody: unknown,
  ):
    | {
        ok: true;
        dispatch: () => Promise<Response>;
        clearDeadline: () => void;
        spec: SpikeChatRequest;
      }
    | { ok: false; response: Response } {
    const spec = parseSpikeBody(rawBody);
    if (!spec) {
      return {
        ok: false,
        response: json({ error: 'INVALID_BODY', message: 'provider and model are required' }, 400),
      };
    }
    // Route layer sets this unconditionally from the deployment origin —
    // server-derived, never client-trusted (see run-host-routes.ts).
    const origin = new URL(request.url).searchParams.get('spikeOrigin');
    if (!origin) {
      return {
        ok: false,
        response: json({ error: 'MISSING_ORIGIN', message: 'route must set spikeOrigin' }, 500),
      };
    }
    const zenGo = spec.provider === 'zen' && Boolean(spec.zenGo);
    const handler = resolveProviderHandler(spec.provider, zenGo);
    if (!handler) {
      return {
        ok: false,
        response: json({ error: 'UNSUPPORTED_PROVIDER', provider: spec.provider }, 400),
      };
    }
    // The deadline covers the WHOLE turn, not just time-to-headers: a
    // provider that returns SSE headers and then stalls mid-body must
    // still get aborted. dispatch() therefore does NOT clear the timer on
    // resolve — each arm calls clearDeadline() when its stream actually
    // finishes (or lets the abort fire, which cancels the upstream body
    // and errors any pipe reading from it).
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SPIKE_TURN_TIMEOUT_MS);
    const clearDeadline = () => clearTimeout(timeout);
    const providerRequest = buildProviderRequest(origin, spec, controller.signal);
    const dispatch = async () => {
      try {
        return await handler(providerRequest, this.env);
      } catch (err) {
        clearDeadline();
        throw err;
      }
    };
    return { ok: true, dispatch, clearDeadline, spec };
  }

  /**
   * Arm 2 (relay-SSE): pass the provider SSE through the DO unmodified,
   * with timing marks injected as SSE comment lines (`: spike ...`) —
   * invisible to EventSource consumers, visible to the spike page's raw
   * reader. Marks: `do_dispatch` epoch-ms when the handler was invoked,
   * `upstream_first_byte_ms` delta when the first upstream chunk arrived.
   */
  private async spikeRelay(request: Request): Promise<Response> {
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return json({ error: 'INVALID_BODY', message: 'POST body must be JSON' }, 400);
    }
    const prepared = this.prepareDispatch(request, raw);
    if (!prepared.ok) return prepared.response;

    const dispatchedAt = Date.now();
    const upstream = await prepared.dispatch();
    if (!upstream.ok || !upstream.body) {
      prepared.clearDeadline();
      const errText = await upstream.text().catch(() => '');
      return json(
        { error: 'PROVIDER_ERROR', status: upstream.status, detail: errText.slice(0, 300) },
        502,
      );
    }

    const encoder = new TextEncoder();
    let firstChunk = true;
    const clearDeadline = prepared.clearDeadline;
    const marked = upstream.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        start(ctrl) {
          ctrl.enqueue(encoder.encode(`: spike do_dispatch=${dispatchedAt}\n\n`));
        },
        transform(chunk, ctrl) {
          if (firstChunk) {
            firstChunk = false;
            ctrl.enqueue(
              encoder.encode(`: spike upstream_first_byte_ms=${Date.now() - dispatchedAt}\n\n`),
            );
          }
          ctrl.enqueue(chunk);
        },
        // Stream finished — the turn deadline has done its job. If the
        // upstream stalls instead, the deadline aborts the provider fetch,
        // which errors this pipe and unblocks the client's reader rather
        // than hanging it. (No `cancel` hook — TS's Transformer type lacks
        // it; a timer that fires after the client cancelled just aborts an
        // already-cancelled upstream, a no-op.)
        flush() {
          clearDeadline();
        },
      }),
    );
    return new Response(marked, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      },
    });
  }

  /**
   * Arm 4 (server-turn): the DO consumes the stream itself and returns
   * timing JSON. No client in the loop — this is what an adopted run's
   * provider round trip looks like.
   */
  private async spikeServerTurn(request: Request): Promise<Response> {
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return json({ error: 'INVALID_BODY', message: 'POST body must be JSON' }, 400);
    }
    const prepared = this.prepareDispatch(request, raw);
    if (!prepared.ok) return prepared.response;

    const t0 = Date.now();
    const upstream = await prepared.dispatch();
    if (!upstream.ok || !upstream.body) {
      prepared.clearDeadline();
      const errText = await upstream.text().catch(() => '');
      return json(
        { error: 'PROVIDER_ERROR', status: upstream.status, detail: errText.slice(0, 300) },
        502,
      );
    }
    const firstByteMs = Date.now() - t0;

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    const scan: SseScanState = { buffer: '', done: false };
    const deadline = t0 + SPIKE_TURN_TIMEOUT_MS;
    let firstTokenMs: number | null = null;
    let contentChars = 0;
    let chunkCount = 0;
    try {
      while (true) {
        const { done, value } = await readWithDeadline(reader.read(), deadline);
        if (done) break;
        chunkCount += 1;
        const deltas = scanSseChunk(scan, decoder.decode(value, { stream: true }));
        for (const delta of deltas) {
          if (firstTokenMs === null) firstTokenMs = Date.now() - t0;
          contentChars += delta.length;
        }
        if (scan.done) break;
      }
    } catch (err) {
      // Free the upstream before responding — the deadline race leaves a
      // pending read on the reader.
      await reader.cancel().catch(() => {});
      return json(
        { error: 'TURN_TIMEOUT', message: err instanceof Error ? err.message : 'stream stalled' },
        504,
      );
    } finally {
      prepared.clearDeadline();
      try {
        reader.releaseLock();
      } catch {
        // releaseLock throws while a read is pending (the timeout race) —
        // the reader was already cancelled, nothing left to free.
      }
    }

    return json({
      ok: true,
      serverFirstByteMs: firstByteMs,
      serverFirstTokenMs: firstTokenMs,
      serverTotalMs: Date.now() - t0,
      contentChars,
      chunkCount,
    });
  }

  /**
   * Arm 3 (relay-WS): WebSocket delivery of the same provider stream —
   * the transport shape the Phase 3 attach/viewer path would use. Frames:
   *   client → server: SpikeChatRequest JSON (first frame only)
   *   server → client: {t:'open', doDispatch} → {t:'delta', text} ... →
   *                    {t:'done', serverFirstByteMs, serverFirstTokenMs,
   *                     serverTotalMs, contentChars}
   */
  private spikeWs(request: Request): Response {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }
    const pair = new (
      globalThis as unknown as {
        WebSocketPair: new () => Record<string, CfWebSocket>;
      }
    ).WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    let started = false;
    server.addEventListener('message', (event: { data: unknown }) => {
      if (started) return; // one turn per connection — extra frames ignored
      started = true;
      let raw: unknown;
      try {
        raw = JSON.parse(String(event.data));
      } catch {
        server.send(JSON.stringify({ t: 'error', message: 'first frame must be JSON' }));
        server.close(1003, 'invalid payload');
        return;
      }
      this.runWsTurn(request, raw, server).catch((err) => {
        try {
          server.send(
            JSON.stringify({ t: 'error', message: err instanceof Error ? err.message : 'failed' }),
          );
          server.close(1011, 'turn failed');
        } catch {
          // socket already gone — nothing to report to.
        }
      });
    });

    return new Response(null, {
      status: 101,
      // @ts-expect-error — Cloudflare extension: Response init accepts `webSocket` to attach a paired socket on upgrade.
      webSocket: client,
    });
  }

  private async runWsTurn(request: Request, raw: unknown, server: CfWebSocket): Promise<void> {
    const prepared = this.prepareDispatch(request, raw);
    if (!prepared.ok) {
      const detail = await prepared.response.text().catch(() => '');
      server.send(JSON.stringify({ t: 'error', message: detail.slice(0, 300) }));
      server.close(1008, 'rejected');
      return;
    }

    const t0 = Date.now();
    server.send(JSON.stringify({ t: 'open', doDispatch: t0 }));
    const upstream = await prepared.dispatch();
    if (!upstream.ok || !upstream.body) {
      prepared.clearDeadline();
      const errText = await upstream.text().catch(() => '');
      server.send(
        JSON.stringify({
          t: 'error',
          message: `provider ${upstream.status}: ${errText.slice(0, 200)}`,
        }),
      );
      server.close(1011, 'provider error');
      return;
    }
    const firstByteMs = Date.now() - t0;

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    const scan: SseScanState = { buffer: '', done: false };
    const deadline = t0 + SPIKE_TURN_TIMEOUT_MS;
    let firstTokenMs: number | null = null;
    let contentChars = 0;
    try {
      while (true) {
        const { done, value } = await readWithDeadline(reader.read(), deadline);
        if (done) break;
        const deltas = scanSseChunk(scan, decoder.decode(value, { stream: true }));
        for (const delta of deltas) {
          if (firstTokenMs === null) firstTokenMs = Date.now() - t0;
          contentChars += delta.length;
          server.send(JSON.stringify({ t: 'delta', text: delta }));
        }
        if (scan.done) break;
      }
    } catch (err) {
      // Free the upstream, then rethrow so the call-site catch reports the
      // timeout over the socket and closes it.
      await reader.cancel().catch(() => {});
      throw err;
    } finally {
      prepared.clearDeadline();
      try {
        reader.releaseLock();
      } catch {
        // releaseLock throws while a read is pending (the timeout race) —
        // the reader was already cancelled, nothing left to free.
      }
    }

    server.send(
      JSON.stringify({
        t: 'done',
        serverFirstByteMs: firstByteMs,
        serverFirstTokenMs: firstTokenMs,
        serverTotalMs: Date.now() - t0,
        contentChars,
      }),
    );
    server.close(1000, 'done');
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
