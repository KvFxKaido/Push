/**
 * Remote Sessions relay — per-session Durable Object.
 *
 * Phase 2.b scaffold landed the WS accept; 2.c added bearer auth +
 * role-aware byte forwarding; 2.d.1 added envelope parsing + phone
 * allowlist; 2.d.2 (this slice) adds the ring buffer + replay runtime
 * that the `relay_attach` envelope schema was reserved for:
 *
 *   - Per-session ring buffer of recent pushd → phone event envelopes,
 *     keyed by `event.seq`. Bounded by both count (default 256) and
 *     age (default 60s); whichever cap fires first evicts oldest
 *     entries. Only `kind: 'event'` envelopes with numeric `seq` get
 *     buffered — responses / requests / relay-control envelopes are
 *     forwarded but not replayable (responses tie to a specific
 *     requestId, not a session-wide ordering).
 *
 *   - Replay on `relay_attach`. When a phone sends a `relay_attach`
 *     envelope with `lastSeq: N`, the relay sends every buffered
 *     envelope where `seq > N` in seq order. If the gap is larger
 *     than the buffer (buffer's earliest seq > N+1), the relay
 *     emits `relay_replay_unavailable` instead so the client knows
 *     to recover via `attach_session` rather than silently missing
 *     events. A `relay_attach` with no `lastSeq` is treated as a
 *     fresh session — no replay.
 *
 *   - Env overrides: `PUSH_RELAY_BUFFER_COUNT` and
 *     `PUSH_RELAY_BUFFER_AGE_MS`. Values that don't parse as positive
 *     integers fall back to the defaults.
 *
 * Constraints baked in here (see docs/decisions/Remote Sessions via
 * pushd Relay.md Q#2):
 *
 *   - No WebSocket Hibernation API. Plain `ws.accept()` keeps the DO
 *     instance pinned in memory for the WS lifetime — this is the
 *     reliability claim the in-memory buffer relies on. With
 *     hibernation the DO could be evicted while phones think the
 *     buffer survives, silently dropping replay state.
 *   - No `state.storage` writes. Buffer + connection state live only
 *     in DO memory; loss across DO restart is intentional and the
 *     client recovers via `relay_replay_unavailable` → `attach_session`.
 *
 * Still open after 2.d.2: pushd outbound dial (2.e), phone client
 * adapter (2.f).
 */

import type { DurableObjectState, WebSocket } from '@cloudflare/workers-types';
import {
  PROTOCOL_VERSION,
  isRelayEnvelope,
  validateRelayEnvelope,
  type RelayEnvelope,
} from '@push/lib/protocol-schema';
import { extractPhoneBearer } from './relay-routes';
import type { Env } from './worker-middleware';

export type RelayConnectionRole = 'pushd' | 'phone';

type ConnectionMeta = { role: 'pushd' } | { role: 'phone'; bearer: string };

/**
 * One buffered envelope. `data` is the original NDJSON text so
 * replays go out byte-identical to the live forward — phones can't
 * tell whether a frame was live or replayed except by the seq.
 */
interface BufferedEnvelope {
  seq: number;
  ts: number;
  data: string;
}

const DEFAULT_BUFFER_COUNT = 256;
const DEFAULT_BUFFER_AGE_MS = 60_000;
// Upper bounds for env-driven config. A fat-fingered secret like
// `PUSH_RELAY_BUFFER_COUNT=1000000` could pin gigabytes per DO instance;
// a multi-day age cap could likewise outlast the DO's natural eviction
// rhythm. Clamp to values that stay within sane DO memory budgets while
// still leaving the operator real headroom over the defaults. PR #528
// Copilot review.
const MAX_BUFFER_COUNT = 10_000;
const MAX_BUFFER_AGE_MS = 60 * 60 * 1000; // 1 hour

/**
 * Parse an env-var string as a positive integer within [1, max].
 * Returns the default for any input that isn't strictly a positive
 * integer (empty, NaN, negative, fractional, non-integer string) AND
 * for values that exceed `max`. Operators tuning a Worker secret get
 * the default rather than a confusing partial config when they fat-
 * finger the value, and absurd values can't OOM the DO.
 */
function parseClampedPositiveIntEnv(
  raw: string | undefined,
  fallback: number,
  max: number,
): number {
  if (typeof raw !== 'string' || raw.length === 0) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return fallback;
  if (n > max) return fallback;
  return n;
}

export class RelaySessionDO {
  private readonly connections = new Map<WebSocket, ConnectionMeta>();
  private readonly allowedPhoneBearers = new Set<string>();
  // Ring buffer of recent pushd-originated event envelopes, sorted by
  // insertion order (which IS seq order since seq is monotonic per
  // session). Eviction pops from the front; insertion pushes to the
  // back. Array (not Map) because seq lookups are O(n) in either case
  // for the replay walk, but insertion-order iteration matters more.
  private readonly buffer: BufferedEnvelope[] = [];
  private readonly bufferCount: number;
  private readonly bufferAgeMs: number;
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    void this.state;
    this.bufferCount = parseClampedPositiveIntEnv(
      env.PUSH_RELAY_BUFFER_COUNT,
      DEFAULT_BUFFER_COUNT,
      MAX_BUFFER_COUNT,
    );
    this.bufferAgeMs = parseClampedPositiveIntEnv(
      env.PUSH_RELAY_BUFFER_AGE_MS,
      DEFAULT_BUFFER_AGE_MS,
      MAX_BUFFER_AGE_MS,
    );
  }

  async fetch(request: Request): Promise<Response> {
    const upgrade = request.headers.get('Upgrade')?.toLowerCase();
    if (upgrade !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    const url = new URL(request.url);
    const roleParam = url.searchParams.get('role');
    if (roleParam !== 'pushd' && roleParam !== 'phone') {
      return new Response('Role missing on DO request — route handler must tag', {
        status: 500,
      });
    }
    const role = roleParam;

    if (role === 'pushd' && this.getPushdConnection() !== null) {
      // Reject the second pushd at the upgrade boundary — no WS pair
      // has been created yet, so we return an HTTP 409 (not a close
      // code). The first pushd stays authoritative; reconnect path is
      // "old WS closes, then new pushd opens."
      return new Response('Pushd already attached to this session', { status: 409 });
    }

    // For phones, re-extract the bearer from the subprotocol so the
    // DO can store it alongside the connection. The route handler
    // already validated the bearer's format at upgrade — the DO
    // trusts that decision but needs the value itself for the
    // allowlist check on every outbound forward.
    let phoneBearer: string | null = null;
    if (role === 'phone') {
      phoneBearer = extractPhoneBearer(request.headers.get('Sec-WebSocket-Protocol'));
      if (!phoneBearer) {
        return new Response('Phone bearer missing — route handler must authenticate', {
          status: 500,
        });
      }
    }

    const pair = new (
      globalThis as unknown as { WebSocketPair: new () => Record<string, WebSocket> }
    ).WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    if (role === 'pushd') {
      this.acceptPushd(server);
    } else {
      this.acceptPhone(server, phoneBearer!);
    }

    return new Response(null, {
      status: 101,
      // @ts-expect-error — Cloudflare extension: Response init accepts `webSocket` to attach a paired socket on upgrade.
      webSocket: client,
      headers: new Headers([['Sec-WebSocket-Protocol', 'push.relay.v1']]),
    });
  }

  /** Exposed for tests. */
  acceptPushd(ws: WebSocket): void {
    ws.accept();
    this.connections.set(ws, { role: 'pushd' });
    this.wireConnectionLifecycle(ws);
  }

  /** Exposed for tests. */
  acceptPhone(ws: WebSocket, bearer: string): void {
    ws.accept();
    this.connections.set(ws, { role: 'phone', bearer });
    this.wireConnectionLifecycle(ws);
  }

  private wireConnectionLifecycle(ws: WebSocket): void {
    ws.addEventListener('message', (event) => {
      // DOM `MessageEvent` and Workers `MessageEvent` types diverge;
      // both expose `.data`, so we lean on the structural shape rather
      // than picking a side.
      this.handleMessage(ws, event as unknown as { data: unknown });
    });

    const cleanup = () => {
      this.connections.delete(ws);
    };
    ws.addEventListener('close', cleanup);
    ws.addEventListener('error', cleanup);
  }

  /**
   * Top-level message handler. Tries to parse the frame as a relay-
   * control envelope; if it matches one of `RELAY_ENVELOPE_KINDS`
   * the relay consumes it in-band. Otherwise the frame is forwarded
   * unchanged to the opposite role(s).
   *
   * Malformed JSON is forwarded as-is (the receiving side will reject
   * it). This keeps the relay dumb about non-relay-control payloads.
   */
  private handleMessage(sender: WebSocket, event: { data: unknown }): void {
    const senderMeta = this.connections.get(sender);
    if (!senderMeta) return;
    const data = event.data;
    if (typeof data !== 'string' && !(data instanceof ArrayBuffer)) {
      // Workers WS frames are string or ArrayBuffer. Anything else
      // (Blob, etc.) shouldn't reach us; drop defensively.
      return;
    }

    // Only attempt to parse string frames — relay-control envelopes
    // are JSON text. Binary frames are forwarded raw.
    if (typeof data === 'string') {
      const classified = classifyRelayFrame(data);
      if (classified === 'drop') {
        // Malformed envelope with a relay-control `kind` — drop
        // rather than forward the reserved vocabulary to the
        // counterparty (Copilot #526 hardening).
        return;
      }
      if (classified) {
        this.handleRelayControl(sender, senderMeta, classified);
        return;
      }
    }

    this.forwardData(sender, senderMeta, data);
  }

  private handleRelayControl(
    sender: WebSocket,
    senderMeta: ConnectionMeta,
    envelope: RelayEnvelope,
  ): void {
    // Allowlist mutations are pushd-only — a phone sending a
    // `relay_phone_allow` would otherwise be able to grant itself
    // access. Drop and log (defensive: pushd is the authority).
    if (envelope.kind === 'relay_phone_allow' || envelope.kind === 'relay_phone_revoke') {
      if (senderMeta.role !== 'pushd') {
        // Silent drop — the protocol doesn't define an error response
        // for unauthorized control envelopes, and forwarding to pushd
        // would surface the bogus envelope to it. 2.d.2's per-conn
        // metrics can light this up later.
        return;
      }
      if (envelope.kind === 'relay_phone_allow') {
        for (const token of envelope.tokens) {
          this.allowedPhoneBearers.add(token);
        }
      } else {
        const revokedTokens = new Set(envelope.tokens);
        for (const token of revokedTokens) {
          this.allowedPhoneBearers.delete(token);
        }
        // Drop any currently-connected phone whose bearer was revoked.
        // Close code 1008 mirrors the device-token revoke path in pushd.
        for (const [ws, meta] of this.connections) {
          if (meta.role === 'phone' && revokedTokens.has(meta.bearer)) {
            ws.close(1008, 'phone bearer revoked');
          }
        }
      }
      return;
    }

    // Phase 2.d.2: `relay_attach` is consumed by the ring-buffer
    // replay path. Only phones can send it; pushd emitting one is a
    // protocol violation and gets dropped here.
    if (envelope.kind === 'relay_attach') {
      if (senderMeta.role !== 'phone') return;
      this.handleRelayAttach(sender, senderMeta.bearer, envelope.lastSeq);
      return;
    }

    // `relay_replay_unavailable` is server → client — if a client
    // ever sent it back, drop. Defensive only.
  }

  /**
   * Replay buffered envelopes to a reconnecting phone, OR emit
   * `relay_replay_unavailable` if the gap exceeds the buffer.
   *
   * Cases:
   *   - sender's bearer not in allowlist: silent no-op. This closes
   *     the symmetric flaw to `forwardData`'s gating — an un-allowlisted
   *     phone connecting and immediately sending `relay_attach` would
   *     otherwise siphon buffered session events. PR #528 Copilot + Codex
   *     P1 (independent flags on the same bug). Importantly we DROP
   *     `relay_replay_unavailable` too — sending it would leak that
   *     the bearer reached the DO at all.
   *   - lastSeq undefined or non-finite: phone is starting fresh (or
   *     misbehaving), no replay needed.
   *   - buffer empty: no events to replay; nothing to do.
   *   - buffer's max seq <= lastSeq: client is up to date; no replay.
   *   - buffer's min seq > lastSeq + 1: gap is larger than buffered
   *     window; emit `relay_replay_unavailable` so the client falls
   *     back to `attach_session` for current state.
   *   - otherwise: send all buffered entries with seq > lastSeq in
   *     order. Eviction has already trimmed expired entries.
   */
  private handleRelayAttach(phone: WebSocket, bearer: string, lastSeq: number | undefined): void {
    // Allowlist gate, symmetric with forwardData. Without this, the
    // ring buffer becomes a leak channel for any phone that knows the
    // sessionId and presents a well-shaped bearer. Closes Copilot +
    // Codex P1.
    if (!this.allowedPhoneBearers.has(bearer)) return;
    // typeof check first, then isFinite — `typeof NaN === 'number'` so
    // the type check alone is insufficient. Without the finite check a
    // crafted `lastSeq: NaN` would skip the up-to-date/gap conditions
    // (all NaN comparisons are false) and fall through to the replay
    // loop where `entry.seq <= NaN` is false → every buffered entry
    // sent. Kilo flagged this on #528.
    if (typeof lastSeq !== 'number' || !Number.isFinite(lastSeq)) return;
    if (phone.readyState !== 1) return;

    // Evict expired entries before deciding replay vs. unavailable.
    // Without this, a stale entry could keep `min seq` artificially
    // low and skip the unavailable signal even though the phone
    // can't actually be brought up to date.
    this.evictExpired();

    if (this.buffer.length === 0) return; // nothing to replay or signal
    const minSeq = this.buffer[0].seq;
    const maxSeq = this.buffer[this.buffer.length - 1].seq;

    if (maxSeq <= lastSeq) return; // client already at or past tip

    if (minSeq > lastSeq + 1) {
      // Gap is larger than the ring buffer can cover. Tell the client
      // explicitly so it can fall back rather than silently missing.
      const unavailable = {
        v: PROTOCOL_VERSION,
        kind: 'relay_replay_unavailable' as const,
        reason: `buffer gap: oldest buffered seq=${minSeq}, requested replay from seq=${lastSeq + 1}`,
        ts: Date.now(),
      };
      try {
        phone.send(`${JSON.stringify(unavailable)}\n`);
      } catch {
        // connection may be closing
      }
      return;
    }

    // Replay in order. The buffer is already sorted by seq (insertion
    // order matches seq order); just iterate and send the ones above
    // lastSeq. Re-send the original `data` text byte-for-byte so the
    // replayed frames are indistinguishable from live forwards apart
    // from their (older) seq.
    for (const entry of this.buffer) {
      if (entry.seq <= lastSeq) continue;
      try {
        phone.send(entry.data);
      } catch {
        // connection may be closing — stop trying
        return;
      }
    }
  }

  private forwardData(
    sender: WebSocket,
    senderMeta: ConnectionMeta,
    data: string | ArrayBuffer,
  ): void {
    if (senderMeta.role === 'pushd') {
      // pushd → phones, gated on the phone's bearer being in the
      // pushd-controlled allowlist. Closes Codex #525 P1.
      for (const [ws, meta] of this.connections) {
        if (
          ws !== sender &&
          meta.role === 'phone' &&
          this.allowedPhoneBearers.has(meta.bearer) &&
          ws.readyState === 1
        ) {
          ws.send(data as string | ArrayBuffer);
        }
      }
      // Buffer event envelopes (kind: 'event', numeric seq) so a
      // reconnecting phone can ask for them via `relay_attach`.
      // Non-event envelopes (responses, requests) are forwarded but
      // not buffered — responses tie to a specific requestId, not a
      // session-wide ordering, so replaying them out-of-band would
      // confuse correlation. Binary frames aren't buffered either
      // — they don't carry a parseable seq.
      if (typeof data === 'string') {
        this.tryBufferEvent(data);
      }
    } else {
      // phone → pushd, also gated on the phone's bearer being in the
      // allowlist (closes Codex #526 P1: pushd can't see the
      // originating bearer on a forwarded frame, so the relay is the
      // only place that can enforce this direction). Asymmetric
      // gating was the wrong call — both directions need the same
      // boundary.
      if (!this.allowedPhoneBearers.has(senderMeta.bearer)) {
        return;
      }
      const pushd = this.getPushdConnection();
      if (pushd && pushd !== sender && pushd.readyState === 1) {
        pushd.send(data as string | ArrayBuffer);
      }
    }
  }

  private getPushdConnection(): WebSocket | null {
    for (const [ws, meta] of this.connections) {
      if (meta.role === 'pushd') return ws;
    }
    return null;
  }

  /** Visible for tests. */
  getConnectionCount(): number {
    return this.connections.size;
  }

  /** Visible for tests. */
  getRoleCounts(): { pushd: number; phone: number } {
    let pushd = 0;
    let phone = 0;
    for (const meta of this.connections.values()) {
      if (meta.role === 'pushd') pushd += 1;
      else phone += 1;
    }
    return { pushd, phone };
  }

  /** Visible for tests. */
  getAllowedPhoneBearers(): readonly string[] {
    return Array.from(this.allowedPhoneBearers);
  }

  /** Visible for tests — snapshot of the ring buffer in seq order. */
  getBufferSnapshot(): readonly BufferedEnvelope[] {
    return this.buffer.slice();
  }

  /** Visible for tests — count + age caps after env parsing. */
  getBufferConfig(): { count: number; ageMs: number } {
    return { count: this.bufferCount, ageMs: this.bufferAgeMs };
  }

  /**
   * Parse one NDJSON line; if it's a session event with numeric seq,
   * push to the buffer and evict whichever cap fires first (count
   * OR age). Anything else — non-event envelopes, malformed JSON,
   * relay-control frames — is a no-op here.
   */
  private tryBufferEvent(data: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    const envelope = parsed as { kind?: unknown; seq?: unknown };
    if (envelope.kind !== 'event') return;
    if (typeof envelope.seq !== 'number' || !Number.isInteger(envelope.seq)) return;

    this.buffer.push({ seq: envelope.seq, ts: Date.now(), data });
    this.evictByCount();
    this.evictExpired();
  }

  private evictByCount(): void {
    // Shift from the front because seq is monotonic and the buffer
    // stays in insertion (== seq) order. splice would also work but
    // for the common case of overflow-by-one, shift is cheaper.
    while (this.buffer.length > this.bufferCount) {
      this.buffer.shift();
    }
  }

  private evictExpired(): void {
    const cutoff = Date.now() - this.bufferAgeMs;
    while (this.buffer.length > 0 && this.buffer[0].ts < cutoff) {
      this.buffer.shift();
    }
  }
}

/**
 * Three-way classifier on a text frame:
 *
 *   - returns a typed envelope when the frame parses as a valid
 *     relay-control envelope (caller consumes in-band);
 *   - returns `'drop'` when the frame's `kind` looks like a relay
 *     envelope but validation fails — caller drops the frame
 *     entirely rather than forwarding the reserved vocabulary to
 *     the counterparty (Copilot #526 hardening);
 *   - returns null otherwise (caller forwards raw — non-control
 *     payloads and malformed JSON both fall here).
 */
function classifyRelayFrame(text: string): RelayEnvelope | 'drop' | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRelayEnvelope(parsed)) return null;
  if (validateRelayEnvelope(parsed).length > 0) return 'drop';
  return parsed;
}
