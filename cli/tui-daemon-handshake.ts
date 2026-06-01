/**
 * tui-daemon-handshake.ts — Hello-response evaluation + unknown-event triage.
 *
 * Two purely-functional concerns the TUI uses to keep its link with
 * the daemon honest:
 *
 *   1. **Hello-response evaluation.** The daemon already advertises its
 *      `protocolVersion` and `runtimeVersion` in the `hello` reply, but
 *      the TUI used to ignore both fields — connecting in silence on
 *      success and falling back to inline mode on failure with no hint
 *      that "the daemon is alive but speaks a different protocol"
 *      might be the actual cause. `evaluateHelloResponse` reads the
 *      reply, checks it against the TUI's pinned `PROTOCOL_VERSION`,
 *      and returns a typed result the caller renders: `accepted`
 *      proceeds, `rejected` surfaces an actionable warning instead of
 *      a silent disconnect.
 *
 *   2. **Unknown-event triage.** `handleEngineEvent`'s `default:`
 *      branch used to silently swallow every event type the TUI
 *      didn't explicitly handle. A newer daemon emitting a new event
 *      family to an older TUI was invisible — the events vanished
 *      with no log. `shouldWarnAboutUnknownEvent` gates a one-shot
 *      warning per distinct type so the user (and ops) see drift the
 *      first time it happens without spamming the transcript on every
 *      occurrence.
 *
 * Both helpers are pure — they don't touch tuiState, the daemon
 * client, or any other side-effecting surface. The TUI wires them
 * into the relevant flows.
 *
 * No `import` from `cli/pushd.ts` on purpose: pulling the daemon
 * module into the TUI's hot path would drag the whole runtime
 * (capabilities, role agents, sandbox bindings) into a closure that
 * shouldn't need any of it. The wire-protocol constant lives in
 * `lib/protocol-schema.ts` (the shared layer); the daemon's runtime
 * version is surfaced only when the daemon advertises it and is
 * displayed informationally.
 */

import { PROTOCOL_VERSION } from '../lib/protocol-schema.js';

/**
 * Wire-protocol version the TUI expects the daemon to advertise.
 * Imported from the shared schema module so the TUI and the daemon's
 * own dispatcher compare against the same constant by construction —
 * bumping `PROTOCOL_VERSION` lifts both sides at once and the
 * handshake can never silently diverge from the request gate.
 */
export const EXPECTED_PROTOCOL_VERSION = PROTOCOL_VERSION;

/**
 * Daemon-emitted event types the TUI intentionally has no UI for. The
 * `default:` branch of `handleEngineEvent` looks each unknown event
 * up here before warning — anything on this set is a known no-op
 * (logged elsewhere, surfaced through a downstream event, or just
 * informational for tooling outside the TUI). Anything *off* this
 * set is real drift and earns a one-shot transcript warning.
 *
 * Curated, not exhaustive: a new daemon-only event family that
 * should also be silent in the TUI gets added here in the same PR
 * that introduces it. The deliberate friction is the point — silent
 * drops are how protocol drift hides today.
 */
export const TUI_KNOWN_NOOP_EVENT_TYPES: ReadonlySet<string> = new Set([
  // Emitted once at session-create. The TUI already knows the session
  // exists (it asked for it) so there's nothing new to render.
  'session_started',
  // Echo of the user's own message — re-rendering it would duplicate
  // the entry the composer already pushed into the transcript.
  'user_message',
  // Dev observability events from the lib agent kernels. Useful via
  // structured logging and debug surfaces; the TUI has no transcript
  // role for them today.
  'assistant.prompt_snapshot',
  'context.compaction',
  // NB: the Addressable Session Verbs lifecycle events — `context_compacted`
  // (`session_summarize`), `session_reverted` (`session_revert`), and
  // `session_unreverted` (`session_unrevert`) — are deliberately NOT here:
  // they now drive a real transcript resync via explicit cases in
  // `handleEngineEvent` (`resyncDaemonTranscript`), so they must not be
  // treated as silent no-ops. See lib/session-transcript-events.ts.
  // Engine round-lifecycle markers fired by `cli/engine.ts` on every
  // assistant turn. The TUI tracks the same lifecycle implicitly
  // (`tuiState.runState` flips on `assistant_token` / `run_complete`)
  // so leaving these off the allowlist flooded the transcript with
  // "unknown event" warnings on every prompt in both inline AND
  // daemon mode (codex + copilot review on PR #665).
  'assistant.turn_start',
  'assistant.turn_end',
  // Provider-adaptation marker fired when the engine swaps a
  // sub-component for a provider quirk. Informational only.
  'harness.adaptation',
  // Crash-recovery markers. The user-visible effect ships as the
  // run_complete / error that follows; the markers themselves exist
  // for ops tooling, not the chat surface.
  'run_recovered',
  'recovery_skipped',
  // Delegation-interruption marker. Surfaced via the paired
  // subagent.failed event the delegation renderer already handles.
  'delegation_interrupted',
  // Shared-runtime lifecycle events declared in
  // `lib/runtime-contract.ts:RunEventInput`. The TUI doesn't have a
  // transcript role for them today — `job.*` events fire on
  // delegated work that surfaces via `subagent.*`, and the
  // follow-up family is an orchestrator queueing affordance the
  // user already sees through their own composer entry.
  'job.started',
  'job.completed',
  'job.failed',
  'user.follow_up_queued',
  'user.follow_up_steered',
]);

/**
 * Result of evaluating a `hello` reply. The TUI is expected to:
 *
 *   - `accepted: true`  — register the event handler and proceed.
 *     Any `warnings` get surfaced as transcript entries but don't
 *     block the connect.
 *   - `accepted: false` — close the client and skip the connect. The
 *     `reason` is a user-facing string the caller dumps into the
 *     transcript so the failure mode is observable instead of
 *     "daemon disconnected for unknown reason."
 */
export type HandshakeResult =
  | {
      accepted: true;
      runtimeVersion: string | null;
      /**
       * Code-freshness token (see cli/build-stamp.ts). Null when the daemon
       * is too old to advertise one — in which case the caller can't compare
       * freshness and leaves the stale-runtime self-heal disabled.
       */
      buildStamp: string | null;
      capabilities: string[];
      warnings: string[];
    }
  | { accepted: false; reason: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Decide whether a hello response is acceptable.
 *
 * Hard-fails on:
 *   - missing/non-object payload — the daemon is responding with the
 *     wrong shape, so the rest of the protocol is going to be
 *     unusable.
 *   - protocolVersion mismatch — the daemon's dispatcher would
 *     reject every subsequent request with
 *     `UNSUPPORTED_PROTOCOL_VERSION` anyway, so failing fast here
 *     turns the silent fallback into an actionable warning.
 *
 * Surfaces (non-fatal) warnings on:
 *   - missing/non-string runtimeVersion. Older daemon that doesn't
 *     advertise it. We accept and let the user keep going; the next
 *     daemon upgrade will start advertising.
 *
 * Runtime version itself is informational. Code freshness, however, is
 * NOT pinned here either — `evaluateHelloResponse` stays a pure shape
 * check. It surfaces the daemon's `buildStamp` (or null for an older
 * daemon that doesn't advertise one) and lets the connection-lifecycle
 * caller compare it against this process's own stamp and decide whether
 * to drain + respawn. Keeping the policy out of this pure function is
 * what makes the freshness decision testable without a live socket.
 */
export function evaluateHelloResponse(payload: unknown): HandshakeResult {
  if (!isPlainObject(payload)) {
    return {
      accepted: false,
      reason: `Daemon hello response is not an object (got ${typeof payload}). The daemon binary may be corrupt or mismatched.`,
    };
  }

  const protocolVersion = payload.protocolVersion;
  if (typeof protocolVersion !== 'string' || protocolVersion.length === 0) {
    return {
      accepted: false,
      reason: `Daemon hello response is missing or has an invalid protocolVersion field. Expected "${EXPECTED_PROTOCOL_VERSION}".`,
    };
  }
  if (protocolVersion !== EXPECTED_PROTOCOL_VERSION) {
    return {
      accepted: false,
      reason: `Daemon protocol version mismatch: expected "${EXPECTED_PROTOCOL_VERSION}", daemon advertised "${protocolVersion}". Restart pushd against a matching TUI build.`,
    };
  }

  const warnings: string[] = [];
  let runtimeVersion: string | null = null;
  if (typeof payload.runtimeVersion === 'string' && payload.runtimeVersion.length > 0) {
    runtimeVersion = payload.runtimeVersion;
  } else {
    warnings.push(
      'Daemon did not advertise a runtimeVersion. Older binary — features added since this TUI build may not be available.',
    );
  }

  let buildStamp: string | null = null;
  if (typeof payload.buildStamp === 'string' && payload.buildStamp.length > 0) {
    buildStamp = payload.buildStamp;
  }
  // No warning when buildStamp is absent: an older daemon simply can't
  // participate in freshness self-heal, and the runtimeVersion warning above
  // already covers "this is an older binary."

  const capabilities = Array.isArray(payload.capabilities)
    ? payload.capabilities.filter((c): c is string => typeof c === 'string')
    : [];

  return { accepted: true, runtimeVersion, buildStamp, capabilities, warnings };
}

/**
 * Decide whether to surface a one-shot warning for an unknown event.
 *
 * The `registry` is owned by the caller — typically a per-daemon-
 * connection Set that gets cleared on reconnect so a daemon upgrade
 * resurfaces the warning. Returns true the first time a given type
 * is seen and never again for that registry, so the transcript
 * shows each new drift exactly once instead of either a flood (one
 * entry per occurrence) or nothing (silent drop, the regression
 * we're closing).
 *
 * Types in `TUI_KNOWN_NOOP_EVENT_TYPES` short-circuit to false —
 * they are intentionally silent, not drift.
 */
export function shouldWarnAboutUnknownEvent(registry: Set<string>, eventType: string): boolean {
  if (!eventType || typeof eventType !== 'string') return false;
  if (TUI_KNOWN_NOOP_EVENT_TYPES.has(eventType)) return false;
  if (registry.has(eventType)) return false;
  registry.add(eventType);
  return true;
}

/**
 * Format a transcript warning line for a single unknown event type.
 * Caller-side helper so the wording stays consistent and so unit
 * tests can pin it without driving a full TUI render loop.
 *
 * Wording is mode-neutral on purpose: `handleEngineEvent` runs from
 * both the daemon's `client.onEvent` bridge AND the inline-mode
 * `runAssistantTurn`'s `emit:` callback, so saying "Daemon emitted"
 * would be wrong half the time (copilot review on PR #665). The
 * generic "engine emitted" plus the hint about rebuilding covers
 * both modes.
 */
export function formatUnknownEventWarning(eventType: string): string {
  return (
    `Engine emitted unknown event type "${eventType}" — the TUI silently ignored it. ` +
    `This usually means a newer event was added without a matching TUI handler; ` +
    `consider rebuilding the TUI or filing a bug if you're not running mixed binaries.`
  );
}
