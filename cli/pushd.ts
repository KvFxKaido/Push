#!/usr/bin/env node
// @ts-nocheck — gradual typing in progress for this large module
/**
 * pushd.ts — Push daemon (Track 4)
 *
 * Persistent background daemon that reuses the same engine as the CLI.
 * Transport: Unix domain socket or Windows named pipe, NDJSON (one JSON object per line).
 *
 * Supported request types:
 *   hello            — handshake + capability negotiation
 *   ping             — health check
 *   list_sessions    — discover resumable sessions
 *   start_session    — create a new session
 *   send_user_message — start a run from user input
 *   attach_session   — attach to existing session + event replay
 *   get_session_snapshot — read daemon-owned reconnect status for one session
 *   update_session   — mutate session-scoped state (provider/model)
 *   submit_approval  — respond to an approval_required pause
 *   cancel_run       — abort active run
 *   configure_role_routing — set per-role provider/model routing
 *   submit_task_graph      — scaffold for future task graph execution
 *   delegate_explorer      — launch read-only Explorer sub-agent (real streamFn + real read-only toolExec via makeDaemonExplorerToolExec)
 *   delegate_coder         — launch mutating Coder sub-agent (real streamFn + real full-surface toolExec via makeDaemonCoderToolExec)
 *   delegate_reviewer      — launch advisory Reviewer sub-agent (real streamFn, single-turn JSON review; no tool loop)
 *   delegate_deep_reviewer — launch Deep Reviewer sub-agent (real streamFn + read-only tool loop via makeDaemonExplorerToolExec; investigates then reviews)
 *   cancel_delegation      — cancel active sub-agent delegation
 *   fetch_delegation_events — replay delegation event stream
 *   get_daemon_runtime_config — read daemon-owned exec/search settings
 *   set_daemon_runtime_config — persist daemon-owned exec/search settings
 */
import net from 'node:net';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

import {
  startPushdWs,
  type PushdWsConnectionState,
  type PushdWsAuthRecord,
  type PushdWsHandle,
} from './pushd-ws.js';
import {
  revokeDeviceToken,
  listDeviceTokens,
  mintDeviceToken,
  type DeviceTokenRecord,
} from './pushd-device-tokens.js';
import {
  mintDeviceAttachToken,
  revokeDeviceAttachToken,
  revokeAttachTokensByParent,
  listDeviceAttachTokens,
  getAttachTokenTtlMs,
} from './pushd-attach-tokens.js';
import {
  appendAuditEvent,
  shouldLogCommandText,
  truncateForAudit,
  type AuditSurface,
  type AuditAuthKind,
} from './pushd-audit-log.js';
import {
  startPushdRelayClient,
  type RelayClientHandle,
  type RelayConnectionStatus,
} from './pushd-relay-client.js';
import {
  readRelayConfig,
  writeRelayConfig,
  deleteRelayConfig,
  isValidRelayToken,
  type RelayConfig,
} from './pushd-relay-config.js';
import {
  createRelayAllowlistRegistry,
  seedAllowlistFromAttachTokens,
  type RelayAllowlistRegistry,
} from './pushd-relay-allowlist.js';
import { encodeRemotePairBundle } from './pushd-relay-pair-bundle.js';

/**
 * Slice-3 helper: extract the provenance fields the audit log
 * expects from the dispatcher context. Handlers call this once and
 * spread the result into `appendAuditEvent`. `surface` defaults to
 * 'unix-socket' because handlers reachable from BOTH transports get
 * called from the CLI's local Unix-socket path when no WS context
 * is present.
 */
function auditProvenance(
  context:
    | { auth?: { kind: AuditAuthKind; parentDeviceTokenId: string; tokenId: string } }
    | null
    | undefined,
): {
  surface: AuditSurface;
  deviceId?: string;
  attachTokenId?: string;
  authKind?: AuditAuthKind;
} {
  const auth = context?.auth;
  if (!auth) return { surface: 'unix-socket' };
  return {
    surface: 'ws',
    deviceId: auth.parentDeviceTokenId,
    attachTokenId: auth.kind === 'attach' ? auth.tokenId : undefined,
    authKind: auth.kind,
  };
}

/**
 * Dispatcher-level audit emission for request types whose handlers
 * don't emit at a finer grain. Called from `handleRequest` after the
 * handler resolves. Reads `req.payload` for the input fields (path,
 * sessionId, runId) and the response for ok/error metadata. The
 * mapping is intentionally narrow — types not in the switch produce
 * no audit row, so types like `ping` and `hello` stay out of the
 * log.
 *
 * Slice 3 covers: sandbox file ops, delegate.{coder|explorer|reviewer},
 * session.start (start_session), session.cancel_run. The auth and
 * sandbox_exec / mint / revoke handlers emit themselves because they
 * carry context (exit code, closed-connection count, mintedTokenId)
 * the dispatcher doesn't see.
 */
function emitDispatcherAudit(req: any, response: any, context: any): void {
  if (!req || typeof req.type !== 'string') return;
  // Handlers vary on whether sessionId rides in the top-level envelope
  // or the payload. cancel_run / submit_approval place it in payload;
  // attach_session / send_user_message use the envelope. Read both
  // so the audit row records it consistently regardless of caller
  // shape.
  const sessionId =
    typeof req.sessionId === 'string' && req.sessionId
      ? req.sessionId
      : typeof req.payload?.sessionId === 'string'
        ? req.payload.sessionId
        : undefined;
  const ok = Boolean(response?.ok);
  const errorCode =
    response && response.error && typeof response.error.code === 'string'
      ? response.error.code
      : undefined;
  const prov = auditProvenance(context);
  switch (req.type) {
    case 'sandbox_read_file':
    case 'sandbox_write_file':
    case 'sandbox_list_dir':
    case 'sandbox_diff': {
      void appendAuditEvent({
        type: `tool.${req.type}` as any,
        ...prov,
        sessionId,
        payload: {
          path: typeof req.payload?.path === 'string' ? req.payload.path : undefined,
          ok,
          errorCode,
        },
      });
      return;
    }
    case 'delegate_coder':
    case 'delegate_explorer':
    case 'delegate_reviewer':
    case 'delegate_deep_reviewer': {
      // delegate.* events are coarse — they fire as soon as the
      // handler returns, regardless of how long the delegation
      // itself runs. That's fine for "did this device kick off a
      // delegation," which is the auditable surface. A future slice
      // could emit a paired `delegate.complete` from the agent
      // bindings when the run finishes.
      //
      // Privacy posture: the task string can contain bearer tokens,
      // API keys, or other secrets when the model is asked to do
      // work on credential-sensitive systems. Gate `taskExcerpt`
      // behind the same `PUSHD_AUDIT_LOG_COMMANDS=1` opt-in that
      // controls `sandbox_exec` command-text logging. Default leaves
      // the structural shape (which agent kind was invoked, ok/error)
      // without the free-form payload. #520 Copilot review.
      const taskExcerpt =
        shouldLogCommandText() && typeof req.payload?.task === 'string'
          ? truncateForAudit(req.payload.task)
          : undefined;
      const auditType = req.type.replace('delegate_', 'delegate.') as any;
      void appendAuditEvent({
        type: auditType,
        ...prov,
        sessionId,
        payload: { ok, errorCode, taskExcerpt },
      });
      return;
    }
    case 'start_session': {
      void appendAuditEvent({
        type: 'session.start',
        ...prov,
        sessionId:
          ok && response?.payload?.sessionId ? String(response.payload.sessionId) : sessionId,
        payload: { ok, errorCode },
      });
      return;
    }
    case 'abort': {
      // `abort` sugar routes to cancel_run (parent) or cancel_delegation
      // (child). Child aborts aren't dispatcher-audited (parity with a direct
      // cancel_delegation); for the parent case, mirror the cancel_run audit so
      // an abort-routed cancel keeps its session.cancel_run trail.
      if (typeof req.payload?.subagentId === 'string' && req.payload.subagentId) return;
      const abortRunId =
        typeof req.payload?.runId === 'string' && req.payload.runId ? req.payload.runId : undefined;
      void appendAuditEvent({
        type: 'session.cancel_run',
        ...prov,
        sessionId,
        runId: abortRunId,
        payload: { ok, errorCode },
      });
      return;
    }
    case 'cancel_run': {
      const runId =
        typeof req.payload?.runId === 'string' && req.payload.runId ? req.payload.runId : undefined;
      void appendAuditEvent({
        type: 'session.cancel_run',
        ...prov,
        sessionId,
        runId,
        payload: { ok, errorCode },
      });
      return;
    }
    default:
      return;
  }
}

// Module-scoped reference to the running WS handle. Set when startPushdWs
// completes, nulled on shutdown. Daemon admin handlers (`revoke_device_token`,
// `list_devices`) read this to invoke `disconnectByTokenId` / `listConnected-
// Devices`. Plumbing through the dispatcher context was an option but every
// handler signature would have grown — `wsHandle` is genuinely process-global
// state and the module slot reflects that.
let activeWsHandle: PushdWsHandle | null = null;

// Phase 2.e — outbound relay state. The relay client is sibling to
// `activeWsHandle`: started after the WS listener when a relay config
// is persisted, closed before `wsHandle` on shutdown. `activeRelayConfig`
// is the persisted config the client was started with (deploymentUrl
// only — the token is NOT stored at module scope, just passed into
// `startPushdRelayClient` closure once).
let activeRelayClient: RelayClientHandle | null = null;
let activeRelayDeploymentUrl: string | null = null;
let activeRelayLastStatus: RelayConnectionStatus | null = null;
// In-process registry of attach-token bearers currently valid for the
// relay path. Populated at mint; cleared at revoke. See
// `pushd-relay-allowlist.ts` for the lifecycle rationale + the
// daemon-restart known limitation.
const relayAllowlist: RelayAllowlistRegistry = createRelayAllowlistRegistry();

/**
 * Build a `relay_phone_allow` envelope for the given tokenHash(es).
 * `tokenHashes` carries `sha256(bearer)` base64url-encoded — the
 * DO hashes the phone's `Sec-WebSocket-Protocol` bearer at upgrade
 * time and compares against the set. The wire never carries bearer
 * plaintext, which is what lets the allowlist survive a daemon
 * restart (the on-disk attach-token store also keeps only the hash).
 */
function makeRelayPhoneAllowEnvelope(tokenHashes: readonly string[]): string {
  return `${JSON.stringify({
    v: PROTOCOL_VERSION,
    kind: 'relay_phone_allow',
    tokenHashes,
    ts: Date.now(),
  })}\n`;
}

function makeRelayPhoneRevokeEnvelope(tokenHashes: readonly string[]): string {
  return `${JSON.stringify({
    v: PROTOCOL_VERSION,
    kind: 'relay_phone_revoke',
    tokenHashes,
    ts: Date.now(),
  })}\n`;
}

/**
 * Emit a `relay_phone_allow` envelope for the new tokenHash(es). If
 * the relay client isn't connected yet, the envelope is queued in
 * the relay client's pre-open send buffer and flushed on next open.
 * No-ops when no relay is configured at all.
 */
function emitRelayAllowChange(tokenHashes: readonly string[]): void {
  if (tokenHashes.length === 0) return;
  if (!activeRelayClient) return;
  activeRelayClient.send(makeRelayPhoneAllowEnvelope(tokenHashes));
}

function emitRelayRevokeChange(tokenHashes: readonly string[]): void {
  if (tokenHashes.length === 0) return;
  if (!activeRelayClient) return;
  activeRelayClient.send(makeRelayPhoneRevokeEnvelope(tokenHashes));
}

/**
 * Re-emit the full allowlist after a relay (re)connect. The DO's
 * per-session allowlist is in-memory and per-DO-instance, so a DO
 * restart in the middle of a session would lose it; pushd's full
 * re-emit is the recovery path.
 */
function emitRelayFullAllowlist(send: (frame: string) => void): void {
  const hashes = relayAllowlist.allTokenHashes();
  if (hashes.length === 0) return;
  send(makeRelayPhoneAllowEnvelope(hashes));
}

/**
 * Boot-time rebuild of the relay allowlist registry from the
 * persisted attach-token store. Without this, a daemon restart
 * would emit an empty `relay_phone_allow` on the next relay connect
 * and every paired phone would silently lose forwarding access
 * until it re-paired.
 *
 * The persisted store keeps only hashes (no plaintext bearer ever
 * lands on disk), which is exactly what the hash-keyed allowlist
 * registry stores too — so the seed is a straight 1:1 copy. Expired
 * records are filtered out lazily by `listDeviceAttachTokens()` so
 * a token past its sliding-TTL window doesn't get re-allowlisted.
 */
async function seedRelayAllowlistFromAttachTokens(): Promise<number> {
  return seedAllowlistFromAttachTokens(relayAllowlist, listDeviceAttachTokens);
}

/**
 * Synthetic auth record for inbound relay frames. The DO's pushd-
 * controlled allowlist (2.d.1) is the actual security gate for the
 * relay path — pushd has already authorized every bearer that can
 * forward through. From pushd's side of the WS, we can't tell WHICH
 * phone sent a given frame (the DO forwards bytes without per-frame
 * identity), so we synthesize an `attach`-shaped record with sentinel
 * ids the audit log can filter on.
 *
 * Why `kind: 'attach'`: the loopback `mint_device_attach_token`
 * handler refuses non-device callers, which gates the privilege-
 * escalation surface. Treating relay traffic as attach-kind preserves
 * that refusal — a phone can't ask the relay-routed daemon to mint
 * fresh attach tokens. Unix-socket admin handlers (`revoke_*`,
 * `list_*`, `relay_*`) refuse callers that present any `auth` /
 * `record`, so they're also unreachable from the relay path.
 */
const RELAY_SYNTHETIC_AUTH: PushdWsAuthRecord = {
  kind: 'attach',
  tokenId: 'pdat_relay',
  parentDeviceTokenId: 'pdt_relay',
  boundOrigin: 'relay',
  lastUsedAt: null,
  deviceRecord: null,
};

/**
 * Per-relay-client `wsState`. Shared across every inbound request
 * that came through the relay, so a `sandbox_exec` registers its
 * AbortController in this map and the same connection's `cancel_run`
 * can reach it.
 *
 * Because this one map is shared across ALL paired phones (the relay
 * transport has no per-phone connection on the daemon side — the DO
 * forwards frames without sender identity), connection-scoping alone
 * can't keep one phone from cancelling another's run by guessing the
 * runId. Each run is therefore registered with the DO-stamped per-phone
 * sender id (`ownerId`) it arrived with, and the sessionless `cancel_run`
 * path requires a matching sender id before aborting a relay-owned run.
 * See `handleSandboxExec` (registration) and `handleCancelRun`
 * (the sessionless branch). Closes finding #3 of the Remote Control
 * Surface Audit.
 */
let activeRelayWsState: PushdWsConnectionState | null = null;

/**
 * Active sessionId → emit registrations done via the relay path. We
 * need to call `removeSessionClient` for these on shutdown / disable
 * so a torn-down relay doesn't leave stale emit references in the
 * shared session-client registry.
 */
const relaySessionRegistrations = new Set<string>();

/**
 * Boot the outbound relay client. Wires status callbacks into the
 * audit log (`relay.connect` / `relay.disconnect`), `onOpen` into
 * the full-allowlist re-emit path, and `onMessage` into the existing
 * `handleRequest` dispatcher so inbound requests from paired phones
 * actually run.
 *
 * Inbound dispatch (Phase 2.f, post-#530 review fix): every NDJSON
 * line that arrives is parsed and forwarded into `handleRequest`
 * with the synthesized auth context above. Responses + streamed
 * session events flow back through the relay client's `send` (which
 * the relay forwards to the connected phones via the DO's allowlist
 * gate). The shape mirrors `pushd-ws.ts`'s `ws.on('message', ...)`
 * handler so a phone client speaking the same NDJSON protocol works
 * over either transport.
 *
 * The bearer token is consumed once into the relay client's closure
 * and is NOT retained at module scope — the only post-startup access
 * path is through the running handle (which doesn't expose the
 * token).
 */
function startRelayClient(config: RelayConfig): RelayClientHandle {
  // Forward-ref to the handle so onMessage can call `handle.send(...)`
  // without a circular construction (onMessage is captured into the
  // options object before the handle exists). The ref is populated
  // synchronously below, BEFORE the first dial fires (queueMicrotask
  // in startPushdRelayClient).
  let handleRef: RelayClientHandle | null = null;
  // wsState lives in the closure so cancel_run requests from the
  // SAME relay connection can find the AbortController. Reset on
  // every startRelayClient invocation so a `disable → enable` doesn't
  // leak active-runs across the cycle.
  const wsState: PushdWsConnectionState = { activeRuns: new Map() };
  activeRelayWsState = wsState;

  const emitToRelay = (event: unknown): void => {
    if (!handleRef) return;
    try {
      handleRef.send(`${JSON.stringify(event)}\n`);
    } catch {
      // Sending while closed is a no-op via the relay-client's
      // queue logic; nothing actionable here.
    }
  };

  const handle = startPushdRelayClient({
    deploymentUrl: config.deploymentUrl,
    // Phase 2.d.1 walk-back: sessionId is opaque routing, not
    // security-load-bearing. A stable per-daemon id is fine — the
    // allowlist is the actual gate. Derive it from the hostname so
    // operator inspection ("which DO is this daemon talking to?")
    // stays human-readable; salting it with a process startup nonce
    // would force a fresh DO instance on every restart, which is
    // wasteful for what the field actually does.
    sessionId: `pushd-${os.hostname()}`,
    token: config.token,
    onStatus: (status) => {
      activeRelayLastStatus = status;
      if (status.state === 'open') {
        void appendAuditEvent({
          type: 'relay.connect',
          surface: 'unix-socket',
          payload: { deploymentUrl: config.deploymentUrl },
        });
      } else if (status.state === 'closed' || status.state === 'unreachable') {
        void appendAuditEvent({
          type: 'relay.disconnect',
          surface: 'unix-socket',
          payload: {
            deploymentUrl: config.deploymentUrl,
            state: status.state,
            code: status.code,
            reason: status.reason,
            attempt: status.attempt,
            exhausted: status.exhausted,
          },
        });
      }
    },
    onOpen: (send) => {
      emitRelayFullAllowlist(send);
    },
    onMessage: async (text) => {
      // Each text frame may carry one or more NDJSON envelopes —
      // mirror pushd-ws.ts's parsing exactly. Malformed lines drop
      // silently; an attacker can't differentiate parse failures
      // from anything else and a friendly client would never send
      // malformed bytes through the relay.
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let parsed: {
          v?: string;
          kind?: string;
          requestId?: string;
          type?: string;
          sessionId?: string;
          payload?: { sessionId?: string; capabilities?: unknown };
          [RELAY_SENDER_FIELD]?: string;
        };
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          continue;
        }
        // Only `request` envelopes drive dispatch. Other kinds
        // (responses pushd would itself send, relay-control envelopes
        // consumed by the DO before reaching pushd, malformed
        // payloads) drop silently — see pushd-ws.ts for the same
        // discrimination.
        if (parsed.kind !== 'request') continue;
        let response: unknown;
        try {
          // The relay DO stamps the per-connection sender id onto every
          // forwarded phone→pushd frame (`RELAY_SENDER_FIELD`). It's the only
          // trustworthy phone identity here — the shared `wsState` can't tell
          // paired phones apart — so it scopes run ownership (Audit #3). A
          // string-typed value only; anything else (absent, forged non-string)
          // resolves to undefined and the run registers unowned.
          const relaySenderId =
            typeof parsed[RELAY_SENDER_FIELD] === 'string' && parsed[RELAY_SENDER_FIELD]
              ? parsed[RELAY_SENDER_FIELD]
              : undefined;
          response = await handleRequest(parsed, emitToRelay, {
            auth: RELAY_SYNTHETIC_AUTH,
            wsState,
            relaySenderId,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : 'internal error';
          response = makeErrorResponse(
            parsed.requestId ?? makeRequestId(),
            parsed.type ?? 'unknown',
            'INTERNAL_ERROR',
            message,
          );
        }
        emitToRelay(response);

        // Mirror pushd-ws.ts: register the relay's emit as a session
        // client when the phone attaches or starts a session, so
        // streamed events flow back through the relay. Cleanup on
        // shutdown / disable in `stopRelayClient`.
        const respObj = response as {
          ok?: boolean;
          sessionId?: string;
          payload?: { sessionId?: string };
        };
        if (parsed.type === 'attach_session' && respObj?.ok) {
          const sid = parsed.payload?.sessionId;
          if (sid) {
            addSessionClient(sid, emitToRelay, parsed.payload?.capabilities ?? null);
            relaySessionRegistrations.add(sid);
          }
        }
        if (
          (parsed.type === 'start_session' || parsed.type === 'send_user_message') &&
          respObj?.ok
        ) {
          const sid =
            respObj.sessionId ||
            respObj.payload?.sessionId ||
            parsed.sessionId ||
            parsed.payload?.sessionId;
          if (sid) {
            addSessionClient(sid, emitToRelay, parsed.payload?.capabilities ?? null);
            relaySessionRegistrations.add(sid);
          }
        }
      }
    },
  });
  handleRef = handle;
  return handle;
}

/**
 * Tear down the running relay client. By default the in-process
 * tokenHash allowlist is PRESERVED — entries are reseeded at boot
 * from the persisted attach-token store and adjusted at mint/revoke,
 * so clearing here would force a full re-emit cycle on the next
 * `relay.connect`. Only the explicit `relay disable` flow passes
 * `clearAllowlist: true` (config gone → no relay → no allowlist
 * needed).
 *
 * PR #529 Codex P1 + Copilot: `handleRelayEnable` calls this in its
 * live-restart path; without the preserve default, a disable/enable
 * cycle (or even a first enable with phones already paired locally
 * before the relay token arrived) would re-emit an empty allowlist
 * on the next connect.
 */
function stopRelayClient(opts: { clearAllowlist?: boolean } = {}): void {
  if (activeRelayClient) {
    try {
      activeRelayClient.close();
    } catch {
      /* ignore */
    }
    activeRelayClient = null;
  }
  activeRelayDeploymentUrl = null;
  activeRelayLastStatus = null;
  // Abort any in-flight sandbox_exec runs registered against the
  // relay's wsState. Same shape as pushd-ws.ts's cleanup — without
  // this, a `relay disable` mid-run leaves the daemon child burning
  // CPU/disk until its own timeout fires.
  if (activeRelayWsState) {
    for (const run of activeRelayWsState.activeRuns.values()) {
      try {
        run.controller.abort();
      } catch {
        /* ignore */
      }
    }
    activeRelayWsState.activeRuns.clear();
    activeRelayWsState = null;
  }
  // Drop the relay's session-client registrations so the
  // session-event registry doesn't hold dead emit references. The
  // emit fn closes over the relay handle; calling it after close is
  // a no-op (the handle's send routes through a closed WS), but
  // letting it accumulate would leak references across enable/
  // disable cycles.
  for (const sid of relaySessionRegistrations) {
    try {
      // Removing a session client requires the exact emit fn that
      // was registered. We don't have it at this scope (it was a
      // per-invocation closure inside startRelayClient), so the
      // best we can do is signal the registry via the sessionId
      // alone. The session manager's removeSessionClient takes an
      // emit fn though, so a perfect cleanup needs that handle.
      // For now, leaving the closures to GC after the handle dies
      // is acceptable — they'll silently drop emits via the
      // closed-send no-op, and the registry's small.
      void sid;
    } catch {
      /* ignore */
    }
  }
  relaySessionRegistrations.clear();
  if (opts.clearAllowlist) {
    relayAllowlist.clear();
  }
}

import { PROVIDER_CONFIGS, resolveApiKey, getProviderList } from './provider.js';
import { getCuratedModels } from './model-catalog.js';
import {
  getConfigPath,
  loadConfig,
  reapplyProviderConfigToEnv,
  saveConfig,
} from './config-store.js';
import { createDaemonProviderStream } from './daemon-provider-stream.js';
import { executeToolCall, TOOL_PROTOCOL, READ_ONLY_TOOL_PROTOCOL } from './tools.js';
import {
  makeRunId,
  makeAttachToken,
  createSessionState,
  saveSessionState,
  appendSessionEvent,
  loadSessionState,
  loadSessionEvents,
  rewriteMessagesLog,
  listSessions,
  writeRunMarker,
  clearRunMarker,
  scanInterruptedSessions,
  PROTOCOL_VERSION,
} from './session-store.js';
import { compactContext, isFirstUserMessage } from './context-manager.js';
import { buildSystemPrompt, runAssistantTurn, DEFAULT_MAX_ROUNDS } from './engine.js';
import { appendUserMessageWithFileReferences } from './file-references.js';
import { runExplorerAgent } from '../lib/explorer-agent.ts';
import { runCoderAgent } from '../lib/coder-agent.ts';
import { cliProviderModelSupportsNativeToolCalling } from './native-tool-gate.js';
import {
  getCliNativeToolSchemas,
  getCliReadOnlyNativeToolSchemas,
} from './tool-function-schemas.js';
import { RUN_TOKEN_BUDGET_ENV_VAR, resolveRunTokenBudget } from '../lib/run-cost-budget.ts';
import { isSensitivePath as isDaemonSensitivePath } from '../lib/sensitive-paths.ts';
import { isPathAllowed, snapshotAllowlist } from './pushd-allowlist.js';
import { runReviewer } from '../lib/reviewer-agent.ts';
import { runDeepReviewer } from '../lib/deep-reviewer-agent.ts';
import { buildReviewerContextBlock } from '../lib/role-context.ts';
import { getSubagentLabel } from '../lib/role-display.ts';
import {
  capReviewGuidanceLines,
  REVIEW_GUIDANCE_FILENAME,
  resolveReviewGuidance,
} from '../lib/review-guidance.ts';
import { validateTaskGraph, executeTaskGraph, formatTaskGraphResult } from '../lib/task-graph.ts';
import {
  assertValidEvent,
  isStrictModeEnabled,
  isProtocolObserveEnabled,
  validateEvent,
  RELAY_SENDER_FIELD,
} from '../lib/protocol-schema.js';
import { DAEMON_CAPABILITIES, EVENT_V2 } from '../lib/daemon-capabilities.js';
import {
  DAEMON_EXEC_MODES,
  DAEMON_WEB_SEARCH_BACKENDS,
  daemonExecModeToApprovalMode,
  normalizeDaemonExecMode,
  normalizeDaemonWebSearchBackend,
} from '../lib/daemon-runtime-settings.ts';
import { isV2DelegationEvent, synthesizeV1DelegationEvent } from './v1-downgrade.js';
import {
  roleCanUseTool,
  getToolCapabilities,
  isCapabilityMapped,
  ROLE_CAPABILITIES,
} from '../lib/capabilities.ts';
import { setDefaultMemoryStore } from '../lib/context-memory-store.ts';
import { setDefaultVerbatimLog } from '../lib/verbatim-log.ts';
import { installCliEmbeddingProvider } from './embedding-provider-cli.ts';
import { createFileMemoryStore, getMemoryStoreBaseDir } from './context-memory-file-store.ts';
import { createFileVerbatimLog, getVerbatimLogBaseDir } from './verbatim-log-file-store.ts';
import { resolveWorkspaceIdentity } from '../lib/workspace-identity.js';
import { buildTypedMemoryBlockForNode, writeTaskGraphResultMemory } from './task-graph-memory.ts';
import { getBuildStamp, peekBuildStamp, RUNTIME_VERSION } from './build-stamp.js';

const VERSION = RUNTIME_VERSION;
const DAEMON_STARTED_AT_MS = Date.now();
// Drain state: once set, the daemon refuses new runs (`send_user_message`) and
// self-exits the moment it goes idle, so a client can respawn a fresh daemon
// from current code without killing in-flight work. See `handleDrain`.
let draining = false;
// The daemon's advertised protocol capability set. The canonical vocabulary
// (with per-capability docs) lives in `lib/daemon-capabilities.ts` so the
// client surfaces that advertise subsets back can't drift from it — see #745.
const CAPABILITIES = DAEMON_CAPABILITIES;

const VALID_AGENT_ROLES = new Set(['orchestrator', 'explorer', 'coder', 'reviewer', 'auditor']);

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// ─── Socket path ─────────────────────────────────────────────────

function getDefaultWindowsPipePath() {
  const rawUser = process.env.USERNAME || process.env.USER || 'user';
  const safeUser = String(rawUser).replace(/[^A-Za-z0-9_.-]/g, '_');
  return `\\\\.\\pipe\\pushd-${safeUser}`;
}

export function isNamedPipePath(targetPath) {
  return typeof targetPath === 'string' && targetPath.startsWith('\\\\.\\pipe\\');
}

export function getSocketPath() {
  if (process.env.PUSHD_SOCKET) return process.env.PUSHD_SOCKET;
  if (process.platform === 'win32') return getDefaultWindowsPipePath();
  const pushDir = path.join(os.homedir(), '.push', 'run');
  return path.join(pushDir, 'pushd.sock');
}

export function getPidPath() {
  return path.join(os.homedir(), '.push', 'run', 'pushd.pid');
}

export function getPortPath() {
  if (process.env.PUSHD_PORT_PATH) return process.env.PUSHD_PORT_PATH;
  return path.join(os.homedir(), '.push', 'run', 'pushd.port');
}

export function isWsListenerEnabled() {
  // PR 1: WS listener is dormant by default. Internal-dogfooding flag —
  // the listener is loopback-only and token-gated either way, but the
  // flag lets us harden the auth path before exposing it.
  const raw = process.env.PUSHD_WS;
  if (raw === undefined || raw === '') return false;
  return raw === '1' || raw.toLowerCase() === 'true';
}

export function getLogPath() {
  if (process.env.PUSHD_LOG) return process.env.PUSHD_LOG;
  return path.join(os.homedir(), '.push', 'run', 'pushd.log');
}

async function writePidFile() {
  const pidPath = getPidPath();
  await fs.mkdir(path.dirname(pidPath), { recursive: true });
  await fs.writeFile(pidPath, String(process.pid), 'utf8');
}

async function cleanPidFile() {
  try {
    await fs.unlink(getPidPath());
  } catch {
    /* ignore */
  }
}

async function ensureSocketDir(socketPath) {
  if (isNamedPipePath(socketPath)) return;
  const dir = path.dirname(socketPath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
}

async function cleanStaleSocket(socketPath) {
  if (isNamedPipePath(socketPath)) return;
  try {
    await fs.unlink(socketPath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

// ─── ID generators ──────────────────────────────────────────────

function makeRequestId() {
  return `req_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
}

// `makeAttachToken` is now imported from `./session-store` so every session
// creation path (daemon + TUI + CLI) mints through one helper. Re-exported
// below so callers/tests that import it from the daemon module keep working.

function makeApprovalId() {
  return `appr_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
}

// ─── Envelope helpers ────────────────────────────────────────────

export function makeResponse(requestId, type, sessionId, ok, payload, error = null) {
  return {
    v: PROTOCOL_VERSION,
    kind: 'response',
    requestId,
    type,
    sessionId: sessionId || null,
    ok,
    payload,
    error,
  };
}

export function makeErrorResponse(requestId, type, code, message, retryable = false) {
  return makeResponse(
    requestId,
    type,
    null,
    false,
    {},
    {
      code,
      message,
      retryable,
    },
  );
}

// ─── Restart policies ─────────────────────────────────────────────
// Each session can have a restart policy that controls crash recovery.
//   'on-failure' (default) — recover runs that were interrupted by daemon crash
//   'always'               — always recover (same as on-failure for now; future: timer-based restarts)
//   'never'                — never auto-recover; user must manually re-send
const DEFAULT_RESTART_POLICY = 'on-failure';
const VALID_RESTART_POLICIES = new Set(['on-failure', 'always', 'never']);

function getRestartPolicy(state) {
  const policy = state?.restartPolicy || DEFAULT_RESTART_POLICY;
  return VALID_RESTART_POLICIES.has(policy) ? policy : DEFAULT_RESTART_POLICY;
}

function shouldRecover(policy, marker) {
  if (policy === 'never') return false;
  // 'on-failure' and 'always' both recover interrupted runs
  // Guard: reject missing/non-finite startedAt and stale markers (>1 hour)
  const startedAt = Number(marker.startedAt);
  if (!Number.isFinite(startedAt)) return false;
  const age = Date.now() - startedAt;
  const ONE_HOUR = 60 * 60 * 1000;
  if (age < 0 || age > ONE_HOUR) return false;
  return true;
}

// ─── Token validation ─────────────────────────────────────────────

export { getRestartPolicy, shouldRecover, DEFAULT_RESTART_POLICY, VALID_AGENT_ROLES };
// Re-export the session-store mint helper from the daemon module so existing
// importers (and tests) that reach for it here keep resolving after the
// promotion into `./session-store`.
export { makeAttachToken };

// Dedup `open_attach_used` to one warn per session entry — the opt-out is a
// deliberate dev mode, so we want visibility, but not a line per RPC. Keyed by
// the registry entry object (WeakSet so evicted entries don't leak).
const openAttachWarnedEntries = new WeakSet();

/**
 * Is this session explicitly opted into open (bearer-less) attach? The escape
 * hatch the Universal Session Bearer leaves for deliberate dev use: a
 * per-session `openAttach: true` flag (on the entry or its persisted state) or
 * the process-wide `PUSHD_OPEN_ATTACH=1`. Anything else requires a matching
 * bearer — there is no longer an implicit "tokenless = open" bypass.
 */
function isOpenAttach(entry) {
  return (
    entry?.openAttach === true ||
    entry?.state?.openAttach === true ||
    process.env.PUSHD_OPEN_ATTACH === '1'
  );
}

export function validateAttachToken(entry, providedToken) {
  // No session object = nothing to gate here. Handlers check existence
  // (SESSION_NOT_FOUND) before they ever reach validation, so a null entry is
  // never a real auth decision — it can't be reached with a live session.
  if (!entry) return true;
  // Explicit opt-out only. The former `!entry.attachToken → true` bypass is
  // GONE (Universal Session Bearer): a tokenless session is no longer open by
  // accident. "Open" survives solely as this deliberate, logged choice.
  if (isOpenAttach(entry)) {
    if (!openAttachWarnedEntries.has(entry)) {
      openAttachWarnedEntries.add(entry);
      // Attribute precisely — both can be on at once, so don't collapse to one.
      const envOn = process.env.PUSHD_OPEN_ATTACH === '1';
      const flagOn = entry?.openAttach === true || entry?.state?.openAttach === true;
      const source = flagOn && envOn ? 'session+env' : flagOn ? 'session' : 'env';
      process.stderr.write(
        `${JSON.stringify({ level: 'warn', event: 'open_attach_used', sessionId: entry?.state?.sessionId, source })}\n`,
      );
    }
    return true;
  }
  if (typeof providedToken !== 'string' || !providedToken) return false;
  return entry.attachToken === providedToken;
}

export function normalizeProviderInput(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === 'undefined' || normalized === 'null') return '';
  return normalized;
}

// ─── Session registry (in-memory) ────────────────────────────────

// sessionId → { state, attachToken, abortController?, activeRunId?, pendingApproval?, activeDelegations?, activeGraphs? }
const activeSessions = new Map();

export function ensureRuntimeState(entry) {
  if (!entry.activeDelegations) entry.activeDelegations = new Map();
  if (!entry.activeGraphs) entry.activeGraphs = new Map();
  return entry;
}

export function __getActiveSessionForTesting(sessionId) {
  return activeSessions.get(sessionId) || null;
}

/**
 * Test-only: evict a session from the in-memory registry so the next
 * handler call has to lazy-load it from disk. Used to simulate the
 * daemon-restart path without actually restarting the daemon.
 */
export function __evictActiveSessionForTesting(sessionId) {
  return activeSessions.delete(sessionId);
}

/**
 * Insert a synthetic active session. Test seam for handlers that read
 * `activeSessions` directly — e.g. `handleGetSessionMessages` (PR #687).
 * Returns the entry so callers can hold a ref for assertions.
 */
export function __setActiveSessionForTesting(sessionId, entry) {
  activeSessions.set(sessionId, entry);
  return entry;
}

// Test-only seam for deterministic delegate_explorer race coverage.
const delegateExplorerTestHooks = {
  beforeTerminalClaim: null,
  afterTerminalDecision: null,
};

export function __setDelegateExplorerHooksForTesting(hooks = null) {
  delegateExplorerTestHooks.beforeTerminalClaim = hooks?.beforeTerminalClaim || null;
  delegateExplorerTestHooks.afterTerminalDecision = hooks?.afterTerminalDecision || null;
}

// ─── Shared approval builder ─────────────────────────────────────

/**
 * Build an approvalFn for a session entry. The returned function emits
 * approval_required events and awaits a client decision (or times out).
 * Used by both normal runs and crash-recovery runs.
 */
function buildApprovalFn(sessionId, entry, runId) {
  return async (tool, detail) => {
    const approvalId = makeApprovalId();
    // Display fields, computed once and shared between the `approval_required`
    // event payload and the persisted `entry.pendingApproval` so a reconnect
    // snapshot can rebuild a faithful pane (see below + handleGetSessionSnapshot).
    const approvalKind = tool?.tool || 'tool_execution';
    const approvalTitle = `Approve ${tool?.tool || 'action'}`;
    const approvalSummary = typeof detail === 'string' ? detail : JSON.stringify(detail || {});

    const approvalPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        entry.pendingApproval = null;
        reject(new Error('Approval timed out'));
      }, APPROVAL_TIMEOUT_MS);

      // Store the runId alongside the approvalId so `handleSubmitApproval`
      // can emit `approval_received` on the SAME runId we emitted
      // `approval_required` on. Without this, delegation + task-graph
      // approvals mismatched: the required event fired on the child
      // runId while the received event fell back to `entry.activeRunId`
      // (which is the parent for delegations, and null for task-graph
      // nodes), making client-side correlation impossible (codex P1
      // on PR #282).
      //
      // Also persist the display fields (kind/title/summary). A client that
      // reconnects while an approval is pending — with the `approval_required`
      // event already outside its replay window — rebuilds the pane from the
      // snapshot's `pendingApproval`; without these it could only show a
      // generic "waiting for approval" pane (#746).
      entry.pendingApproval = {
        approvalId,
        resolve,
        reject,
        timer,
        runId,
        kind: approvalKind,
        title: approvalTitle,
        summary: approvalSummary,
      };
    });

    const approvalPayload = {
      approvalId,
      kind: approvalKind,
      title: approvalTitle,
      summary: approvalSummary,
      options: ['approve', 'deny'],
    };
    await appendSessionEvent(entry.state, 'approval_required', approvalPayload, runId);
    broadcastEvent(sessionId, {
      v: PROTOCOL_VERSION,
      kind: 'event',
      sessionId,
      runId,
      seq: entry.state.eventSeq,
      ts: Date.now(),
      type: 'approval_required',
      payload: approvalPayload,
    });

    try {
      const decision = await approvalPromise;
      return decision === 'approve';
    } catch {
      return false;
    }
  };
}

// ─── Multi-client fan-out ────────────────────────────────────────

// sessionId → Map<emitFn, { capabilities: Set<string> }>
//
// Keyed on the emitFn itself so `removeSessionClient(sessionId, emitFn)`
// can find the entry without the caller needing to hold on to an
// opaque handle. The Map is iterated in insertion order, so the
// effective broadcast order matches the v1 Set-based implementation
// and existing tests that assert "client A attached first, so it gets
// events first" still hold.
const sessionClients = new Map();

/**
 * Register a client listener for a session.
 *
 * @param sessionId     the session the client is attached to
 * @param emitFn        a function that takes an event envelope and
 *                      writes it to the client
 * @param capabilities  optional list of v2 capability names the
 *                      client advertises. Clients that include
 *                      `'event_v2'` receive raw delegation events;
 *                      clients that omit it (including the v1
 *                      default) receive synthesized `assistant_token`
 *                      shadows built by `cli/v1-downgrade.ts`.
 */
function addSessionClient(sessionId, emitFn, capabilities = []) {
  if (!sessionClients.has(sessionId)) {
    sessionClients.set(sessionId, new Map());
  }
  const caps = new Set(Array.isArray(capabilities) ? capabilities : []);
  sessionClients.get(sessionId).set(emitFn, { capabilities: caps });
}

function removeSessionClient(sessionId, emitFn) {
  const clients = sessionClients.get(sessionId);
  if (clients) {
    clients.delete(emitFn);
    if (clients.size === 0) sessionClients.delete(sessionId);
  }
}

/**
 * Validate an outbound envelope before fan-out.
 *
 * Strict mode (`PUSH_PROTOCOL_STRICT=1`, set by the daemon-integration test
 * harness at module load) throws, so envelope drift lands as a CI failure
 * instead of silent consumer-side breakage.
 *
 * Otherwise observe mode (ON by default in the daemon, opt out via
 * `PUSH_PROTOCOL_OBSERVE=0`) validates and emits a structured
 * `protocol_drift_detected` log, but still lets the event through —
 * fail-open, so a drifted envelope is surfaced to ops rather than dropped
 * for every attached client. The log goes to stdout via `console.log` like
 * the daemon's other structured logs; the NDJSON wire is the per-client WS
 * (`emitFn`), never stdout, so it can't corrupt a client stream.
 */
function checkOutboundEvent(event) {
  if (isStrictModeEnabled()) {
    assertValidEvent(event);
    return;
  }
  if (!isProtocolObserveEnabled()) return;
  const issues = validateEvent(event);
  if (issues.length === 0) return;
  console.log(
    JSON.stringify({
      level: 'warn',
      event: 'protocol_drift_detected',
      sessionId: event?.sessionId,
      type: event?.type,
      seq: event?.seq,
      // Log only the dotted paths, never `i.message` — validator messages embed
      // JSON.stringify(value) of the offending field, and a drifted tool-call /
      // approval / stream payload can carry user prompts, tool args, or command
      // output. Path + type + seq is enough drift signal; reproduce with
      // PUSH_PROTOCOL_STRICT=1 locally to see the full values.
      issuePaths: issues.map((i) => i.path || '(root)'),
    }),
  );
}

export function broadcastEvent(sessionId, event) {
  checkOutboundEvent(event);
  const clients = sessionClients.get(sessionId);
  if (!clients) return;

  // Fast path: non-delegation events pass through unchanged to every
  // client regardless of capabilities. This covers the vast majority
  // of traffic (`assistant_token`, `tool_call`, `tool_result`,
  // `status`, `run_complete`, `error`, `session_started`,
  // `approval_required`, etc.).
  const isDelegation = isV2DelegationEvent(event.type);
  if (!isDelegation) {
    for (const [emitFn] of clients) {
      try {
        emitFn(event);
      } catch {
        /* client may have disconnected */
      }
    }
    return;
  }

  // Slow path: a v2 delegation event. Every client that advertised
  // `event_v2` at attach time gets the raw envelope; every other
  // client gets the synthesized v1-shaped `assistant_token` shadow(s)
  // built by `cli/v1-downgrade.ts`. A single synthesis per v1 event
  // is sufficient even with multiple v1 clients — the envelope is
  // pure data and can be fanned out as-is.
  //
  // Approval events are NOT delegation events (see
  // `isV2DelegationEvent` in `cli/v1-downgrade.ts`) and take the fast
  // path above. They reach v1 clients verbatim, and the daemon's
  // internal approvalId → delegation map routes the response back to
  // the correct child — the v1 client never has to know a delegation
  // was involved.
  let synthesized = null;
  for (const [emitFn, meta] of clients) {
    if (meta.capabilities.has(EVENT_V2)) {
      try {
        emitFn(event);
      } catch {
        /* client may have disconnected */
      }
      continue;
    }
    // v1 client: build the downgrade lazily on first need so sessions
    // with only v2 clients pay nothing.
    if (synthesized === null) {
      synthesized = synthesizeV1DelegationEvent(event);
      for (const synth of synthesized) checkOutboundEvent(synth);
    }
    for (const synth of synthesized) {
      try {
        emitFn(synth);
      } catch {
        /* client may have disconnected */
      }
    }
  }
}

/**
 * Emit a single event to a single client applying the same v1 synthetic
 * downgrade rules as `broadcastEvent`'s live-fanout slow path. Used by
 * the replay path inside `handleAttachSession` so a v1 client that
 * reconnects with `lastSeenSeq` doesn't receive raw `subagent.*` /
 * `task_graph.*` events from disk and silently drop them.
 *
 * Fixes the PR #281 codex P1 feedback: before this helper, the replay
 * loop called `emitEvent(event)` directly, which reintroduced the exact
 * "unknown event gets dropped" gap the live broadcast was meant to
 * close. Now every path that emits a delegation event to a client goes
 * through capability-aware synthesis.
 *
 * `capabilities` is a `Set<string>` matching the shape stored in
 * `sessionClients`. Callers that track capabilities as arrays should
 * wrap in `new Set(arr)` before calling.
 */
export function emitEventWithDowngrade(event, emitFn, capabilities) {
  // Validate the original envelope on the replay path too — this is the only
  // path a reconnecting client sees persisted-but-not-live-broadcast events
  // (the recovery trio), and the direct-emit branch below would otherwise skip
  // it. Mirrors broadcastEvent's top-of-function check. The synth branch
  // additionally validates each downgraded shadow.
  checkOutboundEvent(event);
  const isDelegation = isV2DelegationEvent(event.type);
  if (!isDelegation || capabilities.has(EVENT_V2)) {
    try {
      emitFn(event);
    } catch {
      /* client may have disconnected */
    }
    return;
  }
  // v1 client + delegation event — synthesize the downgrade shadow(s).
  const synthesized = synthesizeV1DelegationEvent(event);
  for (const synth of synthesized) checkOutboundEvent(synth);
  for (const synth of synthesized) {
    try {
      emitFn(synth);
    } catch {
      /* client may have disconnected */
    }
  }
}

// ─── Request handlers ────────────────────────────────────────────

async function handleHello(req) {
  return makeResponse(req.requestId, 'hello', null, true, {
    runtimeName: 'pushd',
    runtimeVersion: VERSION,
    // Code-freshness token frozen at this daemon's startup. `peekBuildStamp`
    // is non-null once `main()`'s eager capture resolves (well before the
    // first client connect); fall back to an await so a hello that somehow
    // races startup still advertises a real stamp instead of null.
    buildStamp: peekBuildStamp() ?? (await getBuildStamp()),
    protocolVersion: PROTOCOL_VERSION,
    capabilities: CAPABILITIES,
  });
}

async function handlePing(req) {
  return makeResponse(req.requestId, 'ping', null, true, {
    pong: true,
    ts: Date.now(),
  });
}

/**
 * True when no session has an in-flight assistant run or background work
 * (delegations / task graphs). The drain path uses this to decide whether it
 * can self-exit immediately or must wait for active work to settle.
 */
function isDaemonIdle() {
  for (const [, entry] of activeSessions) {
    if (entry.activeRunId) return false;
    if (entry.activeDelegations && entry.activeDelegations.size > 0) return false;
    if (entry.activeGraphs && entry.activeGraphs.size > 0) return false;
  }
  return true;
}

/**
 * Summarize the work still in flight — surfaced in the drain response so the
 * requesting client can tell the user exactly what it's waiting on before the
 * stale daemon respawns. Reports ALL tracked work types (assistant runs,
 * delegations, task graphs), not just top-level runs, so the client never says
 * "0 active runs" while the daemon is actually blocked on background work.
 */
function pendingWorkSummary() {
  const runs = [];
  let delegations = 0;
  let graphs = 0;
  for (const [sessionId, entry] of activeSessions) {
    if (entry.activeRunId) runs.push({ sessionId, runId: entry.activeRunId });
    if (entry.activeDelegations) delegations += entry.activeDelegations.size;
    if (entry.activeGraphs) graphs += entry.activeGraphs.size;
  }
  return { runs, delegations, graphs, total: runs.length + delegations + graphs };
}

let drainExitScheduled = false;
let drainIdleWatcher = null;
// Poll cadence for the drain idle watcher. A daemon refresh isn't latency-
// sensitive, so a coarse poll keeps the catch-all cheap.
const DRAIN_IDLE_POLL_MS = 250;
// Injectable so tests can assert the drain self-exit decision without actually
// SIGTERM-ing the test runner. Production raises SIGTERM so the existing
// `main()` shutdown closure runs the full teardown.
let drainExitFn = () => {
  process.kill(process.pid, 'SIGTERM');
};
/**
 * Self-exit so the existing `main()` shutdown closure runs the full teardown
 * (relay close, WS close, socket/pidfile cleanup). Deferred a tick so the
 * in-flight drain ack (or final run_complete) flushes to the socket first.
 * Idempotent: only the first idle transition schedules the exit.
 */
function clearDrainIdleWatcher() {
  if (drainIdleWatcher) {
    clearTimeout(drainIdleWatcher);
    drainIdleWatcher = null;
  }
}

function scheduleDrainExit() {
  if (drainExitScheduled) return;
  drainExitScheduled = true;
  clearDrainIdleWatcher();
  console.log(JSON.stringify({ level: 'info', event: 'pushd_drain_exit_scheduled' }));
  setTimeout(() => {
    drainExitFn();
  }, 50);
}

/**
 * Catch-all idle watcher for the drain self-exit. `noteRunSettled()` fires the
 * exit immediately when an assistant run completes, but background work
 * (delegations, task graphs) settles on cleanup paths that don't call it — and
 * `isDaemonIdle()` counts that work, so a drain blocked solely on a delegation
 * would otherwise never self-exit. While draining, this polls idle so the
 * refresh completes for ALL work types in one place, instead of hooking every
 * `activeDelegations`/`activeGraphs` delete site (which must stay in sync and
 * would still miss future trackers).
 */
function startDrainIdleWatcher() {
  if (drainIdleWatcher || drainExitScheduled) return;
  const tick = () => {
    drainIdleWatcher = null;
    if (!draining || drainExitScheduled) return;
    if (isDaemonIdle()) {
      console.log(JSON.stringify({ level: 'info', event: 'pushd_drain_idle_reached' }));
      scheduleDrainExit();
      return;
    }
    drainIdleWatcher = setTimeout(tick, DRAIN_IDLE_POLL_MS);
  };
  drainIdleWatcher = setTimeout(tick, DRAIN_IDLE_POLL_MS);
}

// ── Idle lifecycle exit ────────────────────────────────────────────────────
// Default-on: the daemon's lifetime tracks the local TUI's. When the last
// loopback client disconnects, self-exit after a grace window — but only once
// the daemon is idle (durable runs / delegations finish first) and no relay
// (paired phone) is attached. The grace window is cancelled if a client
// reconnects, so the self-heal drain→respawn and transient disconnects never
// kill a daemon that's still in use. This bends the persistence default toward
// the single-user "quit the TUI, the daemon goes too" behaviour; remote and
// durable use stay alive via the two guards.
let liveConnections = 0;
let lifecycleExitTimer = null;
let lifecycleExitArmed = false;
let lifecycleExitFired = false;
let lifecycleGraceMs = (() => {
  const raw = Number(process.env.PUSH_DAEMON_IDLE_GRACE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 8000;
})();
// Injectable so a test can observe the exit decision without SIGTERM-ing the
// runner. Production raises SIGTERM so `main()`'s shutdown closure runs the full
// teardown (relay close, WS close, socket/pidfile cleanup) — same path as drain.
let lifecycleExitFn = () => {
  process.kill(process.pid, 'SIGTERM');
};

function clearLifecycleExitTimer() {
  if (lifecycleExitTimer) {
    clearTimeout(lifecycleExitTimer);
    lifecycleExitTimer = null;
  }
}

function noteLifecycleClientConnected() {
  liveConnections += 1;
  cancelLifecycleExit('client_connected');
}

function noteLifecycleClientDisconnected() {
  liveConnections = Math.max(0, liveConnections - 1);
  maybeScheduleLifecycleExit();
}

/** A client (re)connected or a relay attached — abort any pending exit. */
function cancelLifecycleExit(reason) {
  clearLifecycleExitTimer();
  if (lifecycleExitArmed) {
    lifecycleExitArmed = false;
    console.log(JSON.stringify({ level: 'info', event: 'pushd_lifecycle_exit_cancelled', reason }));
  }
}

/**
 * Arm (or re-arm) the grace-window self-exit. Safe to call repeatedly — from the
 * last socket close, a relay detach, or a run settling. When the grace timer
 * fires it re-checks every guard: it exits only with no clients, no relay, and
 * an idle daemon; re-arms if a durable run/delegation is still finishing; and
 * bails if a client or relay came back. The drain path owns the exit while
 * draining, so this defers to it.
 */
function maybeScheduleLifecycleExit() {
  if (draining || drainExitScheduled || lifecycleExitFired) return;
  if (liveConnections > 0 || activeRelayClient) {
    cancelLifecycleExit('client_or_relay_present');
    return;
  }
  if (lifecycleExitTimer) return; // already counting down
  if (!lifecycleExitArmed) {
    lifecycleExitArmed = true;
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'pushd_lifecycle_exit_armed',
        graceMs: lifecycleGraceMs,
        idle: isDaemonIdle(),
      }),
    );
  }
  lifecycleExitTimer = setTimeout(() => {
    lifecycleExitTimer = null;
    if (draining || drainExitScheduled || lifecycleExitFired) return;
    if (liveConnections > 0 || activeRelayClient) {
      cancelLifecycleExit('client_or_relay_present');
      return;
    }
    if (!isDaemonIdle()) {
      // Still finishing a durable run / delegation — wait another window.
      maybeScheduleLifecycleExit();
      return;
    }
    lifecycleExitFired = true;
    lifecycleExitArmed = false;
    console.log(JSON.stringify({ level: 'info', event: 'pushd_lifecycle_exit_fired' }));
    lifecycleExitFn();
  }, lifecycleGraceMs);
}

/**
 * Test seam: replace the drain self-exit and reset drain state so a test can
 * drive `handleDrain` / `noteRunSettled` and observe the exit decision without
 * terminating the process. Call with no args to restore the SIGTERM default.
 */
export function __setDrainExitForTesting(fn) {
  drainExitFn = typeof fn === 'function' ? fn : () => process.kill(process.pid, 'SIGTERM');
  draining = false;
  drainExitScheduled = false;
  clearDrainIdleWatcher();
}

/**
 * Test seam: replace the lifecycle self-exit and reset its state so a test can
 * drive `maybeScheduleLifecycleExit` and observe the decision without
 * terminating the runner. `opts.graceMs` shrinks the grace window for fast
 * tests. Call with no args to restore the SIGTERM default.
 */
export function __setLifecycleExitForTesting(fn, opts) {
  lifecycleExitFn = typeof fn === 'function' ? fn : () => process.kill(process.pid, 'SIGTERM');
  if (opts && Number.isFinite(opts.graceMs)) lifecycleGraceMs = opts.graceMs;
  liveConnections = 0;
  lifecycleExitArmed = false;
  lifecycleExitFired = false;
  clearLifecycleExitTimer();
}

export function __setLiveConnectionsForTesting(n) {
  liveConnections = Math.max(0, Math.trunc(n) || 0);
}

export function __setActiveRelayForTesting(handle) {
  activeRelayClient = handle ?? null;
}

export {
  handleDrain,
  noteRunSettled,
  isDaemonIdle,
  maybeScheduleLifecycleExit,
  cancelLifecycleExit,
};

/**
 * Called when an assistant run settles (activeRunId cleared) — the 0-latency
 * path to the drain self-exit. Background work relies on the idle watcher
 * instead. If a drain is pending and the daemon has gone fully idle, trigger
 * the deferred self-exit. Symmetric-log both branches so "draining but still
 * busy" is observable.
 */
function noteRunSettled() {
  if (!draining) return;
  if (isDaemonIdle()) {
    console.log(JSON.stringify({ level: 'info', event: 'pushd_drain_idle_reached' }));
    scheduleDrainExit();
  } else {
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'pushd_drain_awaiting_idle',
        pendingWork: pendingWorkSummary().total,
      }),
    );
  }
}

/**
 * Mark the daemon draining for a runtime refresh. Idempotent. After this:
 *   - new `send_user_message` requests are rejected with `DAEMON_DRAINING`;
 *   - the daemon self-exits the moment it goes idle (immediately if already
 *     idle), letting the client respawn a fresh daemon from current code.
 * Active runs are NOT aborted — the whole point is to let in-flight work finish
 * on the code it started under, then refresh cleanly.
 */
async function handleDrain(req, _emitEvent, context = null) {
  // Loopback-only: drain self-exits the daemon, which is a local-client
  // lifecycle concern (the TUI refreshing stale code over the unix socket).
  // A relay-originated request carries a `relaySenderId`; reject those so a
  // paired phone can't churn the daemon for every local session it shares.
  if (context?.relaySenderId) {
    return makeErrorResponse(
      req.requestId,
      'drain',
      'FORBIDDEN',
      'drain is a loopback-only operation',
    );
  }
  const reason = typeof req.payload?.reason === 'string' ? req.payload.reason : null;
  draining = true;
  const work = pendingWorkSummary();
  const idle = work.total === 0;
  console.log(
    JSON.stringify({
      level: 'info',
      event: 'pushd_drain_requested',
      idle,
      pendingRuns: work.runs.length,
      pendingDelegations: work.delegations,
      pendingGraphs: work.graphs,
      reason,
    }),
  );
  if (idle) {
    scheduleDrainExit();
  } else {
    // Block solely on background work (delegation/task graph) settles on paths
    // that don't call noteRunSettled(); the watcher guarantees the eventual exit.
    startDrainIdleWatcher();
  }
  return makeResponse(req.requestId, 'drain', null, true, {
    draining: true,
    idle,
    pendingRuns: work.runs,
    pendingDelegations: work.delegations,
    pendingGraphs: work.graphs,
    pendingWork: work.total,
  });
}

async function handleListSessions(req) {
  // Validate `limit` instead of accepting any truthy value via `|| 20`.
  // Sibling handlers (e.g. `handleFetchDelegationEvents`) already
  // type-check + bound the field; an unvalidated `limit: '50'` would
  // get passed to `slice()` here and produce surprising results
  // (string coercion + arithmetic vs the array index expectations).
  // Default to 20 (the previous fallback) when the field is missing or
  // malformed; cap at 1000 so a misbehaving client can't ask us to
  // emit megabytes of session metadata in a single response.
  // Floor before bounding so fractional inputs (e.g. `0.5`, which
  // would pass a naive `> 0` but floor to `0`) don't slip through as
  // an accidental empty-result request — anything that doesn't floor
  // to >= 1 falls back to the default.
  const rawLimit = req.payload?.limit;
  const flooredLimit =
    typeof rawLimit === 'number' && Number.isFinite(rawLimit) ? Math.floor(rawLimit) : NaN;
  const limit =
    Number.isFinite(flooredLimit) && flooredLimit >= 1 ? Math.min(flooredLimit, 1000) : 20;

  // Optional mode filter so consumers can ask the server to omit
  // sessions whose origin surface isn't useful in their context. The
  // mobile drawer passes `['headless']` because `./push run` jobs
  // aren't resumable as chats — without server-side filtering, a user
  // with 50 consecutive headless runs would see an empty CLI section
  // even though older interactive sessions exist. Each entry is
  // trimmed before comparison: `handleStartSession` trims the payload
  // before persisting and `listSessions()` trims again on read (see
  // its `stateObj.mode` coalesce), so the listing row always carries
  // a trimmed value. Trimming the filter entries matches that
  // normalization — without it a client sending `' headless '` would
  // silently fail to filter. Strings only; other values are dropped.
  const rawExclude = req.payload?.excludeModes;
  const excludeModes =
    Array.isArray(rawExclude) && rawExclude.length > 0
      ? new Set(
          rawExclude
            .filter((m) => typeof m === 'string')
            .map((m) => m.trim())
            .filter((m) => m.length > 0),
        )
      : null;

  const sessions = await listSessions();
  const filtered =
    excludeModes && excludeModes.size > 0
      ? sessions.filter((s) => !excludeModes.has(s.mode))
      : sessions;
  const limited = filtered.slice(0, limit);

  // Enrich with active run state
  const enriched = limited.map((s) => {
    const entry = activeSessions.get(s.sessionId);
    return {
      ...s,
      state: entry?.activeRunId ? 'running' : 'idle',
      activeRunId: entry?.activeRunId || null,
    };
  });

  return makeResponse(req.requestId, 'list_sessions', null, true, {
    sessions: enriched,
  });
}

async function handleStartSession(req) {
  const payload = req.payload || {};
  // Same fallback chain as cli.ts/tui.ts (explicit → PUSH_PROVIDER →
  // 'ollama'): a caller that omits `provider` should land on the daemon's
  // configured default, not a hardcoded one unrelated to the user's setup.
  const provider =
    normalizeProviderInput(payload.provider) ||
    normalizeProviderInput(process.env.PUSH_PROVIDER) ||
    'ollama';
  const providerConfig = PROVIDER_CONFIGS[provider];
  if (!providerConfig) {
    return makeErrorResponse(
      req.requestId,
      'start_session',
      'PROVIDER_NOT_CONFIGURED',
      `Unknown provider: ${provider}`,
    );
  }

  const cwd = payload.repo?.rootPath || process.cwd();
  const model = payload.model || PROVIDER_CONFIGS[provider].defaultModel;
  const restartPolicy = VALID_RESTART_POLICIES.has(payload.restartPolicy)
    ? payload.restartPolicy
    : DEFAULT_RESTART_POLICY;
  const now = Date.now();
  // Tag the session with its origin surface so `list_sessions` (and the
  // mobile drawer that consumes it) can bucket Remote / CLI without
  // re-deriving the mode from local UI state. Mirrors the value
  // that gets broadcast in the `session_started` event below; the two
  // must stay in sync so the live event and the persisted state.json
  // agree.
  const mode =
    typeof payload.mode === 'string' && payload.mode.trim() ? payload.mode.trim() : 'interactive';

  // Route through the shared factory so the attach token is minted at birth
  // by the same helper the TUI/CLI use (Universal Session Bearer). The
  // persisted token lets disk-reload paths (daemon restart, session eviction,
  // cross-handler lazy load) restore the SAME token the client received here
  // instead of minting a fresh one and rejecting the client's original.
  const state = {
    ...createSessionState({
      provider,
      model,
      cwd,
      mode,
      now,
      messages: [{ role: 'system', content: await buildSystemPrompt(cwd) }],
    }),
    restartPolicy,
    roleRouting: {},
    delegationOutcomes: [],
  };
  const { sessionId, attachToken } = state;

  await appendSessionEvent(state, 'session_started', {
    sessionId,
    state: 'idle',
    mode,
    provider,
    sandboxProvider: payload.sandboxProvider || 'local',
  });
  await saveSessionState(state);

  activeSessions.set(sessionId, { state, attachToken });

  return makeResponse(req.requestId, 'start_session', sessionId, true, {
    sessionId,
    state: 'idle',
    attachToken,
    roleRouting: state.roleRouting,
  });
}

async function handleSendUserMessage(req, emitEvent) {
  const sessionId = req.sessionId || req.payload?.sessionId;
  const text = req.payload?.text;

  if (!sessionId || !text) {
    return makeErrorResponse(
      req.requestId,
      'send_user_message',
      'INVALID_REQUEST',
      'sessionId and text are required',
    );
  }

  let entry = activeSessions.get(sessionId);
  if (!entry) {
    try {
      const state = await loadSessionState(sessionId);
      // Restore the persisted attach token from session state instead of
      // minting a fresh one. Without this, clients lose their token on any
      // handler that lazy-loads a session from disk (including after a
      // daemon crash + restart), because `validateAttachToken` would
      // compare the caller's original token against a freshly minted one.
      // Legacy sessions without a persisted token load with attachToken
      // undefined; they are claimed on first `attach_session` (bootstrap
      // grace). A non-attach handler reached before that claim now rejects —
      // the implicit tokenless bypass is gone (Universal Session Bearer).
      entry = { state, attachToken: state.attachToken };
      activeSessions.set(sessionId, entry);
    } catch {
      return makeErrorResponse(
        req.requestId,
        'send_user_message',
        'SESSION_NOT_FOUND',
        `Session not found: ${sessionId}`,
      );
    }
  }

  // Reject if a run is already in progress
  if (entry.activeRunId) {
    return makeErrorResponse(
      req.requestId,
      'send_user_message',
      'RUN_IN_PROGRESS',
      `Run ${entry.activeRunId} is already active`,
    );
  }

  // Refuse new runs once draining: the daemon is on its way out for a runtime
  // refresh, so starting work here would run it on stale code. The client
  // routes around this by respawning a fresh daemon and retrying there.
  if (draining) {
    return makeErrorResponse(
      req.requestId,
      'send_user_message',
      'DAEMON_DRAINING',
      'Daemon is draining for a runtime refresh; retry on the fresh daemon.',
    );
  }

  const providedToken = req.payload?.attachToken;
  if (!validateAttachToken(entry, providedToken)) {
    return makeErrorResponse(
      req.requestId,
      'send_user_message',
      'INVALID_TOKEN',
      'Invalid or missing attach token',
    );
  }

  const { state } = entry;

  // Session-scoped provider/model live in the daemon as the source of
  // truth. Clients mutate them via `update_session` (handler below);
  // we no longer adopt them from each `send_user_message` payload.
  // Per-role routing (`resolveRoleRouting`) still takes precedence
  // over the base provider/model when a role override is configured.

  const runId = makeRunId();
  const abortController = new AbortController();

  entry.activeRunId = runId;
  entry.abortController = abortController;
  // A new message commits any pending revert — the fork is taken, so the
  // stashed tail is no longer restorable via `session_unrevert`.
  entry.revertedTail = null;

  // Acknowledge immediately
  const ack = makeResponse(req.requestId, 'send_user_message', sessionId, true, {
    runId,
    accepted: true,
  });

  await appendUserMessageWithFileReferences(state, text, state.cwd);
  const userMessagePayload = { chars: text.length, preview: text.slice(0, 280) };
  // Capture the seq synchronously, right as the call starts — not after
  // awaiting it. appendSessionEvent increments state.eventSeq before its
  // first await, so this read is race-free (nothing else can run between
  // "call the function" and "read the field" in the same tick); reading
  // state.eventSeq only after the await could pick up a LATER event's seq if
  // a background delegation/task-graph run appends to the same session
  // concurrently (send_user_message only rejects on entry.activeRunId, not
  // background runs) — the broadcast envelope would then mismatch the
  // persisted journal entry (Codex P2 on #1321).
  const appendPromise = appendSessionEvent(state, 'user_message', userMessagePayload, runId);
  const userMessageSeq = state.eventSeq;
  await appendPromise;
  // Broadcast so another client attached to this session (e.g. the TUI that
  // originated it, watching a phone-driven turn) renders the prompt live —
  // previously only persisted, never fanned out, so the assistant's reply
  // would appear on other clients with no visible question above it.
  broadcastEvent(sessionId, {
    v: PROTOCOL_VERSION,
    kind: 'event',
    sessionId: state.sessionId,
    runId,
    seq: userMessageSeq,
    ts: Date.now(),
    type: 'user_message',
    payload: userMessagePayload,
  });

  const providerConfig = PROVIDER_CONFIGS[state.provider];
  let apiKey;
  try {
    apiKey = resolveApiKey(providerConfig);
  } catch (err) {
    entry.activeRunId = null;
    entry.abortController = null;
    noteRunSettled();
    return makeErrorResponse(
      req.requestId,
      'send_user_message',
      'PROVIDER_NOT_CONFIGURED',
      err.message,
    );
  }

  const approvalFn = buildApprovalFn(sessionId, entry, runId);

  // Run in background — broadcast events to all attached clients
  (async () => {
    // Write run marker so crash recovery can detect interrupted runs.
    // Awaited inside the async IIFE so a crash right after launch is still detectable.
    try {
      await writeRunMarker(sessionId, runId, {
        provider: state.provider,
        model: state.model,
        cwd: state.cwd,
      });
    } catch (err) {
      process.stderr.write(
        `warning: failed to write run marker for ${sessionId}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    let sawError = false;
    let sawRunComplete = false;
    try {
      await runAssistantTurn(state, providerConfig, apiKey, text, DEFAULT_MAX_ROUNDS, {
        runId,
        // Daemon turns run at a fixed DEFAULT_MAX_ROUNDS: the client's
        // `--max-rounds` isn't carried through `send_user_message`, so disable
        // the adaptive harness here rather than silently grow a cap the user
        // can't control. Threading the real cap (+ adaptation) through the
        // daemon protocol is a follow-up.
        explicitMaxRounds: true,
        signal: abortController.signal,
        approvalFn,
        emit: (event) => {
          const seq = state.eventSeq;
          if (event.type === 'error') sawError = true;
          if (event.type === 'run_complete') sawRunComplete = true;

          broadcastEvent(sessionId, {
            v: PROTOCOL_VERSION,
            kind: 'event',
            sessionId: event.sessionId,
            runId: event.runId,
            seq,
            ts: Date.now(),
            type: event.type,
            payload: event.payload,
          });
        },
      });
      await saveSessionState(state);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!sawError) {
        await appendSessionEvent(
          state,
          'error',
          {
            code: 'INTERNAL_ERROR',
            message,
            retryable: false,
          },
          runId,
        );
        broadcastEvent(sessionId, {
          v: PROTOCOL_VERSION,
          kind: 'event',
          sessionId,
          runId,
          seq: state.eventSeq,
          ts: Date.now(),
          type: 'error',
          payload: { code: 'INTERNAL_ERROR', message, retryable: false },
        });
      }
      if (!sawRunComplete) {
        await appendSessionEvent(
          state,
          'run_complete',
          {
            runId,
            outcome: 'failed',
            summary: message.slice(0, 500),
          },
          runId,
        );
        broadcastEvent(sessionId, {
          v: PROTOCOL_VERSION,
          kind: 'event',
          sessionId,
          runId,
          seq: state.eventSeq,
          ts: Date.now(),
          type: 'run_complete',
          payload: { outcome: 'failed', summary: message.slice(0, 500) },
        });
      }
      await saveSessionState(state);
    } finally {
      entry.activeRunId = null;
      entry.abortController = null;
      if (entry.pendingApproval) {
        clearTimeout(entry.pendingApproval.timer);
        entry.pendingApproval = null;
      }
      // Clear run marker — this run is no longer active
      clearRunMarker(sessionId).catch(() => {});
      // If a drain is pending, this run settling may be the transition to
      // idle that lets the daemon self-exit for a runtime refresh.
      noteRunSettled();
    }
  })();

  return ack;
}

async function handleAttachSession(req, emitEvent) {
  const {
    sessionId,
    lastSeenSeq,
    attachToken: providedToken,
    capabilities: clientCapabilities,
  } = req.payload || {};
  if (!sessionId) {
    return makeErrorResponse(
      req.requestId,
      'attach_session',
      'INVALID_REQUEST',
      'sessionId is required',
    );
  }

  let entry = activeSessions.get(sessionId);
  if (!entry) {
    try {
      const state = await loadSessionState(sessionId);
      // Restore the persisted attach token from session state instead of
      // minting a fresh one. Without this, clients lose their token on any
      // handler that lazy-loads a session from disk (including after a
      // daemon crash + restart), because `validateAttachToken` would
      // compare the caller's original token against a freshly minted one.
      // Legacy sessions without a persisted token are claimed by the
      // bootstrap-grace block below on their first tokenless attach.
      entry = { state, attachToken: state.attachToken };
      activeSessions.set(sessionId, entry);
    } catch {
      return makeErrorResponse(
        req.requestId,
        'attach_session',
        'SESSION_NOT_FOUND',
        `Session not found: ${sessionId}`,
      );
    }
  }

  // Bootstrap grace (Universal Session Bearer legacy cutover): a session
  // created before the bearer factory existed is tokenless on disk. On its
  // FIRST attach where the client ALSO presents no token, claim it — mint +
  // persist + accept this one attach — and return the token so the client
  // adopts it (see the response payload below + the TUI/CLI adopt paths).
  // Every subsequent attach then requires it: the session is tokened forever.
  // New sessions never reach here tokenless — the factory mints them at
  // birth. Rationale: the 0600 unix socket is already the local boundary, so
  // a single unauthenticated local claim-attach per legacy session is an
  // acceptable migration affordance (docs/decisions/Universal Session Bearer.md).
  // Any OTHER combination (token on disk, or client presented a token) flows
  // through `validateAttachToken` and enforces normally.
  const clientPresentedToken = typeof providedToken === 'string' && providedToken.trim().length > 0;
  if (!entry.attachToken && !clientPresentedToken) {
    const claimedToken = makeAttachToken();
    entry.attachToken = claimedToken;
    entry.state.attachToken = claimedToken;
    let persisted = true;
    try {
      await saveSessionState(entry.state);
    } catch (err) {
      // The in-memory claim still authorizes this run, but a daemon restart
      // would lose it and re-trigger the grace on the next attach. Surface it
      // rather than failing the attach — the session is already usable live.
      persisted = false;
      process.stderr.write(
        `${JSON.stringify({ level: 'warn', event: 'legacy_claim_persist_failed', sessionId, error: err instanceof Error ? err.message : String(err) })}\n`,
      );
    }
    // The claim IS the auth for this one attach — fall through (no validate).
    // A `legacy_claim` count trending to zero is the signal the migration is
    // complete; new sessions are born tokened and never emit it.
    process.stderr.write(
      `${JSON.stringify({ level: 'info', event: 'legacy_claim', sessionId, persisted })}\n`,
    );
  } else if (!validateAttachToken(entry, providedToken)) {
    return makeErrorResponse(
      req.requestId,
      'attach_session',
      'INVALID_TOKEN',
      'Invalid or missing attach token',
    );
  }

  // Register this client for multi-client fan-out. Capabilities drive
  // the v1 synthetic-downgrade path in `broadcastEvent` — clients that
  // include `'event_v2'` receive raw delegation envelopes, clients
  // that omit it (or pass `capabilities: []`, or don't include the
  // field at all) receive synthesized `assistant_token` shadows.
  const capabilitiesArray = Array.isArray(clientCapabilities) ? clientCapabilities : [];
  addSessionClient(sessionId, emitEvent, capabilitiesArray);
  // Same capability set is used to drive the replay path below so v1
  // clients see synthesized events for missed delegation rounds as
  // well as live ones (codex P1 on PR #281).
  const replayCapabilities = new Set(capabilitiesArray);

  const { state } = entry;
  const currentSeq = state.eventSeq;
  const fromSeq = (lastSeenSeq || 0) + 1;

  // Replay missed events from disk. Route each through
  // `emitEventWithDowngrade` so v1 clients don't silently drop raw
  // `subagent.*` / `task_graph.*` envelopes that landed on disk while
  // they were disconnected. The live fan-out path already does this
  // via `broadcastEvent`; the replay path has to do it too or
  // reconnects on `lastSeenSeq` reintroduce the gap this PR was meant
  // to close.
  try {
    const allEvents = await loadSessionEvents(sessionId);
    const missed = allEvents.filter((e) => e.seq >= fromSeq && e.seq <= currentSeq);
    for (const event of missed) {
      emitEventWithDowngrade(event, emitEvent, replayCapabilities);
    }
  } catch {
    // best-effort replay
  }

  return makeResponse(req.requestId, 'attach_session', sessionId, true, {
    sessionId,
    state: entry.activeRunId ? 'running' : 'idle',
    activeRunId: entry.activeRunId || null,
    // Return the session's attach token so the client can ADOPT it into its
    // in-memory token (TUI `state.attachToken` / `daemonAttachToken`). This is
    // what closes the legacy-claim staleness loop: a TUI that attached with a
    // stale `undefined` (legacy tokenless session) gets the just-claimed token
    // here and presents it on the next reconnect instead of being locked out.
    // For an already-tokened session this just echoes the token the client
    // already holds (no new exposure — the caller already authenticated).
    attachToken: entry.attachToken,
    // Session-scoped truth: the daemon is the source. Clients (TUI, web)
    // hydrate from these on attach instead of loading state.json
    // directly, which keeps the two views in lock-step after a
    // mid-session switch from another client.
    provider: state.provider,
    model: state.model,
    roleRouting: state.roleRouting || {},
    replay: {
      fromSeq,
      toSeq: currentSeq,
      completed: true,
      gap: fromSeq > currentSeq + 1,
    },
  });
}

/**
 * handleGetSessionMessages — return the conversation transcript for an
 * existing session so a freshly attaching web client can hydrate its
 * chat surface from the daemon's source of truth.
 *
 * Why this exists (PR #687): `attach_session` returns session metadata
 * (provider/model/roleRouting) and replays missed events, but the
 * `user_message` event only carries `{ chars, preview: text.slice(0, 280) }`
 * — the full user message body lives in `state.messages`. So a
 * web-side hydrator built purely from replayed events would surface
 * truncated user messages. This RPC fills that gap by returning the
 * already-persisted user/assistant pairs from `state.messages`.
 *
 * Auth identical to `attach_session`: requires `attachToken` to match
 * the session's stored token. System + tool messages are filtered —
 * the web's `ChatContainer` renders only the human-visible dialogue.
 */
export async function handleGetSessionMessages(req) {
  const { sessionId, attachToken: providedToken } = req.payload || {};
  if (!sessionId) {
    return makeErrorResponse(
      req.requestId,
      'get_session_messages',
      'INVALID_REQUEST',
      'sessionId is required',
    );
  }

  let entry = activeSessions.get(sessionId);
  if (!entry) {
    try {
      const state = await loadSessionState(sessionId);
      entry = { state, attachToken: state.attachToken };
      activeSessions.set(sessionId, entry);
    } catch {
      return makeErrorResponse(
        req.requestId,
        'get_session_messages',
        'SESSION_NOT_FOUND',
        `Session not found: ${sessionId}`,
      );
    }
  }

  if (!validateAttachToken(entry, providedToken)) {
    return makeErrorResponse(
      req.requestId,
      'get_session_messages',
      'INVALID_TOKEN',
      'Invalid or missing attach token',
    );
  }

  // Filter to user/assistant pairs and coerce content to string. Some
  // providers represent multimodal content as an array of blocks; for
  // hydration we only carry the text channel — `''` for messages we
  // can't render as plain text. Indices supply stable IDs so the
  // web's React lists are stable across re-fetches.
  const allMessages = Array.isArray(entry.state.messages) ? entry.state.messages : [];
  const messages = [];
  for (let i = 0; i < allMessages.length; i++) {
    const msg = allMessages[i];
    if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) continue;
    const content = typeof msg.content === 'string' ? msg.content : '';
    messages.push({
      id: `daemon-${sessionId}-${i}`,
      role: msg.role,
      content,
    });
  }

  return makeResponse(req.requestId, 'get_session_messages', sessionId, true, {
    sessionId,
    messages,
  });
}

async function readGitBranch(cwd) {
  try {
    // `branch --show-current` (not `rev-parse --abbrev-ref HEAD`) so a freshly
    // `git init`'d repo with no commits still reports its unborn branch instead
    // of erroring out; it prints empty only when detached. Mirrors the
    // normalized Git backend (`lib/git/backend.ts`). Copilot review on #743.
    const { stdout } = await execFileAsync('git', ['branch', '--show-current'], {
      cwd,
      timeout: 1_000,
      maxBuffer: 16_000,
    });
    const branch = stdout.trim();
    return branch ? branch : null;
  } catch {
    return null;
  }
}

function normalizeRecentEventLimit(rawLimit) {
  const floored =
    typeof rawLimit === 'number' && Number.isFinite(rawLimit) ? Math.floor(rawLimit) : NaN;
  return Number.isFinite(floored) && floored >= 1 ? Math.min(floored, 100) : 20;
}

/**
 * `get_session_snapshot` — one daemon-owned reconnect packet for clients that
 * need to render "what is happening now" before/instead of reconstructing it
 * from local state plus event replay. Read-only and bearer-gated; never returns
 * bearer plaintext.
 */
async function handleGetSessionSnapshot(req) {
  const auth = await loadAndAuthSession(req, 'get_session_snapshot');
  if (auth.error) return auth.error;
  const { entry, sessionId } = auth;
  const state = entry.state || {};
  const currentSeq = typeof state.eventSeq === 'number' ? state.eventSeq : 0;
  const recentEventLimit = normalizeRecentEventLimit(req.payload?.recentEventLimit);

  let recentEvents = [];
  try {
    const allEvents = await loadSessionEvents(sessionId);
    recentEvents = allEvents.slice(-recentEventLimit);
  } catch {
    recentEvents = [];
  }

  const activeRunId =
    typeof entry.activeRunId === 'string' && entry.activeRunId ? entry.activeRunId : null;
  // Background work (delegations / task graphs) keeps a session "running" even
  // when `activeRunId` is null — the orchestrator turn that kicked it off has
  // already returned, so the top-level run id is cleared while sub-agent work
  // is still in flight. `handleUpdateSession` blocks on the same non-empty
  // maps with RUN_IN_PROGRESS; the snapshot must agree or a reconnecting
  // client renders the session as idle during live delegation. Codex review
  // on #743.
  const activeDelegations = entry.activeDelegations?.size ?? 0;
  const activeGraphs = entry.activeGraphs?.size ?? 0;
  const hasBackgroundWork = activeDelegations > 0 || activeGraphs > 0;
  const isRunning = activeRunId !== null || hasBackgroundWork;
  const pendingApproval = entry.pendingApproval
    ? {
        approvalId: entry.pendingApproval.approvalId,
        runId:
          typeof entry.pendingApproval.runId === 'string' && entry.pendingApproval.runId
            ? entry.pendingApproval.runId
            : null,
        // Display context so a reconnecting client renders the same pane as the
        // live `approval_required` event, not a generic fallback (#746). Null
        // when absent (e.g. a pre-#746 daemon's in-memory entry); the client
        // falls back to a generic summary in that case.
        kind:
          typeof entry.pendingApproval.kind === 'string' && entry.pendingApproval.kind
            ? entry.pendingApproval.kind
            : null,
        title:
          typeof entry.pendingApproval.title === 'string' && entry.pendingApproval.title
            ? entry.pendingApproval.title
            : null,
        summary:
          typeof entry.pendingApproval.summary === 'string' && entry.pendingApproval.summary
            ? entry.pendingApproval.summary
            : null,
      }
    : null;

  return makeResponse(req.requestId, 'get_session_snapshot', sessionId, true, {
    host: {
      hostname: os.hostname(),
      daemonVersion: VERSION,
      protocolVersion: PROTOCOL_VERSION,
      startedAtMs: DAEMON_STARTED_AT_MS,
    },
    repo: {
      rootPath: state.cwd || process.cwd(),
      branch: await readGitBranch(state.cwd || process.cwd()),
    },
    relay: await buildRelayStatusPayload(),
    session: {
      sessionId,
      state: isRunning ? 'running' : 'idle',
      activeRunId,
      // Count of in-flight sub-agent work with no top-level run id. Lets a
      // reconnecting client distinguish "running because of a foreground turn"
      // (activeRun set) from "running because of background delegation" — and
      // render progress without waiting for an event-tail to reveal it.
      backgroundWork: { delegations: activeDelegations, graphs: activeGraphs },
      provider: state.provider || null,
      model: state.model || null,
      mode: typeof state.mode === 'string' && state.mode.trim() ? state.mode.trim() : 'interactive',
      roleRouting: state.roleRouting || {},
      eventSeq: currentSeq,
      attachTokenPresent: Boolean(entry.attachToken),
    },
    // Foreground run descriptor. `type`/`cancellable` are fixed to the
    // assistant-turn model the top-level `activeRunId` represents today — when
    // a delegation or task graph is the in-flight work, `activeRunId` is null
    // (see `backgroundWork` above), so this stays null rather than describing a
    // child run with different cancel semantics. As the run model grows
    // (task_graph_v1 / delegation_* gaining cancellable child descriptors),
    // widen this shape in a later slice. Kilo review on #743.
    activeRun: activeRunId
      ? {
          runId: activeRunId,
          type: 'assistant_turn',
          cancellable: true,
        }
      : null,
    pendingApproval,
    transcript: {
      lastSeq: currentSeq,
      recentEvents,
    },
  });
}

async function handleSubmitApproval(req, _emitEvent, context) {
  const { sessionId, approvalId, decision } = req.payload || {};
  if (!sessionId || !approvalId || !decision) {
    return makeErrorResponse(
      req.requestId,
      'submit_approval',
      'INVALID_REQUEST',
      'sessionId, approvalId, and decision are required',
    );
  }

  const entry = activeSessions.get(sessionId);
  if (!entry) {
    return makeErrorResponse(
      req.requestId,
      'submit_approval',
      'SESSION_NOT_FOUND',
      `Session not found: ${sessionId}`,
    );
  }

  // Bearer-gate the approval decision (Addressable Session Verbs follow-up —
  // the gap the cancel_run fix in #723 left open). An approval decision
  // executes or denies a paused tool call; without this any relay-authenticated
  // client that learns a live sessionId + approvalId could approve/deny a tool
  // run on a session whose bearer it does not hold. Placed AFTER the existence
  // check (mirroring handleCancelRun) so an unknown session still returns
  // SESSION_NOT_FOUND, and BEFORE the pending-approval lookup so a stolen
  // approvalId can't even probe whether one is outstanding.
  const providedToken = req.payload?.attachToken;
  if (!validateAttachToken(entry, providedToken)) {
    process.stderr.write(
      `${JSON.stringify({ level: 'warn', event: 'submit_approval_unauthenticated_rejected', sessionId, hadToken: typeof providedToken === 'string' && providedToken.length > 0 })}\n`,
    );
    return makeErrorResponse(
      req.requestId,
      'submit_approval',
      'INVALID_TOKEN',
      'Invalid or missing attach token',
    );
  }

  const pending = entry.pendingApproval;
  if (!pending || pending.approvalId !== approvalId) {
    return makeErrorResponse(
      req.requestId,
      'submit_approval',
      'APPROVAL_NOT_FOUND',
      `No pending approval with id: ${approvalId}`,
    );
  }

  clearTimeout(pending.timer);
  entry.pendingApproval = null;
  pending.resolve(decision);

  // Emit approval_received to all clients on the SAME runId we used
  // for `approval_required` (stored alongside in `buildApprovalFn`).
  // Falling back to `entry.activeRunId` — which is the parent run for
  // a main loop, but null for delegations and task-graph nodes —
  // caused the received event to mismatch the required event for
  // anything routed through `delegate_coder` /
  // `handleSubmitTaskGraph`, making client-side correlation
  // impossible.
  const approvalRunId = typeof pending.runId === 'string' ? pending.runId : entry.activeRunId;
  const eventPayload = { approvalId, decision, by: 'client' };
  await appendSessionEvent(entry.state, 'approval_received', eventPayload, approvalRunId);
  // Build envelope after appendSessionEvent so seq matches the persisted event.
  // Omit `runId` when falsy (protocol-schema strict mode rejects
  // `runId: null` on wire envelopes — see PR #276 review).
  const envelope = {
    v: PROTOCOL_VERSION,
    kind: 'event',
    sessionId,
    seq: entry.state.eventSeq,
    ts: Date.now(),
    type: 'approval_received',
    payload: eventPayload,
  };
  if (typeof approvalRunId === 'string' && approvalRunId.length > 0) {
    envelope.runId = approvalRunId;
  }
  broadcastEvent(sessionId, envelope);

  // Phase 3 slice 4 audit. Records the decision alongside the
  // requesting device's provenance — closes the audit-log
  // "approval decisions identify surface/device" minimum-model item.
  void appendAuditEvent({
    type: 'approval.decision',
    ...auditProvenance(context),
    sessionId,
    runId: typeof approvalRunId === 'string' ? approvalRunId : undefined,
    payload: { approvalId, decision },
  });

  return makeResponse(req.requestId, 'submit_approval', sessionId, true, {
    accepted: true,
  });
}

async function handleCancelRun(req, _emitEvent, context) {
  const { sessionId, runId } = req.payload || {};

  // Sessionless cancel path (Phase 1.f remote-sessions cancel): the
  // web side may issue `cancel_run` with only a runId to abort an
  // in-flight `sandbox_exec` registered against this connection's
  // wsState. We accept this ONLY when the runId matches a registration
  // on the same WS connection — that scoping keeps a stolen runId
  // from a different paired client out of reach on the loopback WS,
  // where each connection owns its own wsState.
  //
  // The relay transport defeats connection-scoping: every paired phone
  // shares the one `activeRelayWsState`, so a guessed runId would
  // otherwise reach across phones. When a run was registered with an
  // `ownerId` (the relay DO's per-phone sender id), require the cancel to
  // arrive from the SAME phone — i.e. its DO-stamped `relaySenderId` must
  // match. Runs with a null ownerId (loopback callers, which don't ride the
  // relay) stay purely connection-scoped, unchanged. Closes Remote Control
  // Surface Audit #3.
  if (!sessionId) {
    if (!runId) {
      return makeErrorResponse(
        req.requestId,
        'cancel_run',
        'INVALID_REQUEST',
        'sessionId or runId is required',
      );
    }
    const wsState = context?.wsState;
    const run = wsState && wsState.activeRuns instanceof Map ? wsState.activeRuns.get(runId) : null;
    if (!run) {
      return makeErrorResponse(
        req.requestId,
        'cancel_run',
        'NO_ACTIVE_RUN',
        `No active run to cancel: ${runId}`,
      );
    }
    if (run.ownerId !== null) {
      // The cancel must come from the same phone that started the run. The
      // sender id is DO-stamped and trusted (a phone can't forge it). A
      // mismatch is reported as NO_ACTIVE_RUN (not a distinct auth error) so
      // the runId↔owner binding isn't oracle'd — a different phone can't
      // distinguish "runId exists, other owner" from "runId doesn't exist."
      const cancelSenderId =
        typeof context?.relaySenderId === 'string' ? context.relaySenderId : null;
      if (cancelSenderId !== run.ownerId) {
        process.stderr.write(
          `${JSON.stringify({ level: 'warn', event: 'cancel_run_runid_owner_mismatch', runId, hadSender: cancelSenderId !== null })}\n`,
        );
        return makeErrorResponse(
          req.requestId,
          'cancel_run',
          'NO_ACTIVE_RUN',
          `No active run to cancel: ${runId}`,
        );
      }
    }
    try {
      run.controller.abort();
    } catch {
      // ignore — handleSandboxExec's finally clears the map entry
    }
    return makeResponse(req.requestId, 'cancel_run', null, true, {
      accepted: true,
      runId,
    });
  }

  const entry = activeSessions.get(sessionId);
  if (!entry) {
    return makeErrorResponse(
      req.requestId,
      'cancel_run',
      'SESSION_NOT_FOUND',
      `Session not found: ${sessionId}`,
    );
  }

  // Bearer-gate the session-ful cancel (Addressable Session Verbs phase 2 —
  // the 12th enforcement site, missed by the Universal Session Bearer sweep).
  // Without this a relay-authenticated client could abort a run on a session it
  // does not hold the bearer for, just by knowing the sessionId. Placed AFTER
  // the existence check so a cancel for a session the daemon doesn't have still
  // returns SESSION_NOT_FOUND (the benign loopback best-effort path), not a
  // token error. The runId-only path above stays WS-connection-scoped and is
  // intentionally not token-gated.
  const providedToken = req.payload?.attachToken;
  if (!validateAttachToken(entry, providedToken)) {
    process.stderr.write(
      `${JSON.stringify({ level: 'warn', event: 'cancel_run_unauthenticated_rejected', sessionId, hadToken: typeof providedToken === 'string' && providedToken.length > 0 })}\n`,
    );
    return makeErrorResponse(
      req.requestId,
      'cancel_run',
      'INVALID_TOKEN',
      'Invalid or missing attach token',
    );
  }

  if (!entry.activeRunId) {
    return makeErrorResponse(
      req.requestId,
      'cancel_run',
      'NO_ACTIVE_RUN',
      'No active run to cancel',
    );
  }

  if (runId && entry.activeRunId !== runId) {
    return makeErrorResponse(
      req.requestId,
      'cancel_run',
      'NO_ACTIVE_RUN',
      `Run ${runId} is not the active run`,
    );
  }

  // Abort the run
  if (entry.abortController) {
    entry.abortController.abort();
  }

  // Also resolve any pending approval as denied
  if (entry.pendingApproval) {
    clearTimeout(entry.pendingApproval.timer);
    entry.pendingApproval.resolve('deny');
    entry.pendingApproval = null;
  }

  return makeResponse(req.requestId, 'cancel_run', sessionId, true, {
    accepted: true,
  });
}

/**
 * `abort` — sugar verb (Addressable Session Verbs phase 2b). Routes by id shape
 * to the existing, uniformly bearer-gated cancel handlers: a `subagentId` in the
 * payload means a child run → `cancel_delegation`; otherwise the parent run →
 * `cancel_run`. The response/error `type` is re-stamped to `abort` so the client
 * sees the verb it dispatched, not the delegate target. No new auth surface:
 * both targets validate the session bearer (`cancel_run` since the phase-2 gate,
 * `cancel_delegation` always). Dispatcher audit for the parent case is mirrored
 * in `emitDispatcherAudit`'s `abort` case so an abort-routed cancel keeps its
 * `session.cancel_run` trail.
 */
async function handleAbort(req, emitEvent, context) {
  const isChild = typeof req.payload?.subagentId === 'string' && req.payload.subagentId.length > 0;
  const underlying = isChild
    ? await handleCancelDelegation(req, emitEvent, context)
    : await handleCancelRun(req, emitEvent, context);
  return underlying && typeof underlying === 'object'
    ? { ...underlying, type: 'abort' }
    : underlying;
}

// ─── Role routing ───────────────────────────────────────────────

async function handleConfigureRoleRouting(req) {
  const sessionId = req.sessionId || req.payload?.sessionId;
  const routing = req.payload?.routing;

  if (!sessionId) {
    return makeErrorResponse(
      req.requestId,
      'configure_role_routing',
      'INVALID_REQUEST',
      'sessionId is required',
    );
  }

  if (!routing || typeof routing !== 'object' || Array.isArray(routing)) {
    return makeErrorResponse(
      req.requestId,
      'configure_role_routing',
      'INVALID_REQUEST',
      'routing must be a non-null object mapping role → { provider, model? }',
    );
  }

  let entry = activeSessions.get(sessionId);
  if (!entry) {
    try {
      const state = await loadSessionState(sessionId);
      // Restore the persisted attach token from session state instead of
      // minting a fresh one. Without this, clients lose their token on any
      // handler that lazy-loads a session from disk (including after a
      // daemon crash + restart), because `validateAttachToken` would
      // compare the caller's original token against a freshly minted one.
      // Legacy sessions without a persisted token load with attachToken
      // undefined; they are claimed on first `attach_session` (bootstrap
      // grace). A non-attach handler reached before that claim now rejects —
      // the implicit tokenless bypass is gone (Universal Session Bearer).
      entry = { state, attachToken: state.attachToken };
      activeSessions.set(sessionId, entry);
    } catch {
      return makeErrorResponse(
        req.requestId,
        'configure_role_routing',
        'SESSION_NOT_FOUND',
        `Session not found: ${sessionId}`,
      );
    }
  }

  const providedToken = req.payload?.attachToken;
  if (!validateAttachToken(entry, providedToken)) {
    return makeErrorResponse(
      req.requestId,
      'configure_role_routing',
      'INVALID_TOKEN',
      'Invalid or missing attach token',
    );
  }

  const normalized = {};
  for (const [role, spec] of Object.entries(routing)) {
    if (!VALID_AGENT_ROLES.has(role)) {
      return makeErrorResponse(
        req.requestId,
        'configure_role_routing',
        'INVALID_ROLE',
        `Unknown agent role: ${role}. Valid roles: ${[...VALID_AGENT_ROLES].join(', ')}`,
      );
    }

    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
      return makeErrorResponse(
        req.requestId,
        'configure_role_routing',
        'INVALID_REQUEST',
        `Entry for role "${role}" must be an object with at least { provider }`,
      );
    }

    const provider = typeof spec.provider === 'string' ? spec.provider.trim() : spec.provider;
    if (!provider || typeof provider !== 'string') {
      return makeErrorResponse(
        req.requestId,
        'configure_role_routing',
        'INVALID_REQUEST',
        `Entry for role "${role}" must specify a provider`,
      );
    }

    const providerConfig = PROVIDER_CONFIGS[provider];
    if (!providerConfig) {
      return makeErrorResponse(
        req.requestId,
        'configure_role_routing',
        'PROVIDER_NOT_CONFIGURED',
        `Unknown provider "${provider}" for role "${role}"`,
      );
    }

    normalized[role] = {
      provider,
      model:
        typeof spec.model === 'string' && spec.model.trim()
          ? spec.model.trim()
          : providerConfig.defaultModel,
    };
  }

  const { state } = entry;
  state.roleRouting = { ...(state.roleRouting || {}), ...normalized };
  // `broadcastSessionStateChanged` appends the event AND saves the
  // state — calling `saveSessionState` first would persist a stale
  // `eventSeq` that filters this very event out of attach-replay
  // (codex / copilot review on PR #663). The helper owns the order.
  await broadcastSessionStateChanged(state);

  return makeResponse(req.requestId, 'configure_role_routing', sessionId, true, {
    roleRouting: state.roleRouting,
  });
}

/**
 * Patch session-scoped state (currently provider + model) from a client.
 *
 * This is the daemon-as-source-of-truth path: the TUI switches model/provider
 * by calling this RPC instead of writing the session file directly. The old
 * "carry the model on every send_user_message" workaround
 * (`adoptClientModelSelection`) is gone — the daemon now owns the truth and
 * every client reads it back via `attach_session` or the broadcast event.
 *
 * Atomicity rule: provider + model are treated as ONE selection. A patch with
 * provider but no model snaps the model to that provider's default — adopting
 * only the provider would strand the session's old model on the new provider.
 * A model-only patch is a same-provider model switch.
 *
 * Rejected during an active run: switching mid-run would race with the
 * already-streaming round (which has already captured the provider config
 * via `PROVIDER_CONFIGS[state.provider]`).
 */
async function handleUpdateSession(req) {
  const sessionId = req.sessionId || req.payload?.sessionId;
  if (!sessionId) {
    return makeErrorResponse(
      req.requestId,
      'update_session',
      'INVALID_REQUEST',
      'sessionId is required',
    );
  }
  const patch = req.payload?.patch;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return makeErrorResponse(
      req.requestId,
      'update_session',
      'INVALID_REQUEST',
      'patch must be a non-null object with optional { provider, model }',
    );
  }

  let entry = activeSessions.get(sessionId);
  if (!entry) {
    try {
      const state = await loadSessionState(sessionId);
      entry = { state, attachToken: state.attachToken };
      activeSessions.set(sessionId, entry);
    } catch {
      return makeErrorResponse(
        req.requestId,
        'update_session',
        'SESSION_NOT_FOUND',
        `Session not found: ${sessionId}`,
      );
    }
  }

  if (!validateAttachToken(entry, req.payload?.attachToken)) {
    return makeErrorResponse(
      req.requestId,
      'update_session',
      'INVALID_TOKEN',
      'Invalid or missing attach token',
    );
  }

  if (entry.activeRunId) {
    return makeErrorResponse(
      req.requestId,
      'update_session',
      'RUN_IN_PROGRESS',
      `Run ${entry.activeRunId} is active; cannot update session state mid-run`,
    );
  }

  // Delegations and task-graph executions read `state.provider` /
  // `state.model` (via `resolveRoleRouting`) for every sub-agent call
  // they make, so a mid-flight patch would silently swap the model
  // under the running work. The session entry tracks both via
  // `ensureRuntimeState`; non-empty Maps mean work is in flight even
  // though `activeRunId` is null (the orchestrator turn that kicked
  // them off has already returned). Block them with the same code
  // so clients have one path to surface (copilot review on PR #663).
  const activeDelegations = entry.activeDelegations?.size ?? 0;
  const activeGraphs = entry.activeGraphs?.size ?? 0;
  if (activeDelegations > 0 || activeGraphs > 0) {
    return makeErrorResponse(
      req.requestId,
      'update_session',
      'RUN_IN_PROGRESS',
      `Background work is active (${activeDelegations} delegation(s), ${activeGraphs} task graph(s)); cannot update session state until it completes`,
    );
  }

  const { state } = entry;
  let nextProvider = state.provider;
  let nextModel = state.model;
  let providerChanged = false;

  if (patch.provider !== undefined && patch.provider !== null) {
    const normalized = normalizeProviderInput(patch.provider);
    if (!normalized || !PROVIDER_CONFIGS[normalized]) {
      return makeErrorResponse(
        req.requestId,
        'update_session',
        'PROVIDER_NOT_CONFIGURED',
        `Unknown provider: ${JSON.stringify(patch.provider)}`,
      );
    }
    nextProvider = normalized;
    providerChanged = normalized !== state.provider;
  }

  if (patch.model !== undefined && patch.model !== null) {
    if (typeof patch.model !== 'string' || !patch.model.trim()) {
      return makeErrorResponse(
        req.requestId,
        'update_session',
        'INVALID_REQUEST',
        'model must be a non-empty string',
      );
    }
    nextModel = patch.model.trim();
  } else if (providerChanged) {
    // Atomic-selection rule: a provider change without an explicit model
    // snaps the model to the new provider's default. Adopting only the
    // provider would leave the old model name on a foreign provider and
    // the next run would fail at the provider call.
    nextModel = PROVIDER_CONFIGS[nextProvider].defaultModel;
  }

  state.provider = nextProvider;
  state.model = nextModel;
  // `broadcastSessionStateChanged` appends the event AND saves the
  // state. A pre-save would persist a stale `eventSeq` and the
  // attach-replay filter (`seq <= currentSeq`) would drop this very
  // event on the next disk-reload.
  await broadcastSessionStateChanged(state);

  return makeResponse(req.requestId, 'update_session', sessionId, true, {
    provider: state.provider,
    model: state.model,
    roleRouting: state.roleRouting || {},
  });
}

/**
 * Emit `session_state_changed` to every client attached to the session.
 *
 * Persisted via `appendSessionEvent` so reconnecting clients pick up the
 * change in their replay window (the attach response also carries the
 * current values, but persisting the event keeps the timeline honest
 * for any consumer that watches state transitions — and the seq stays
 * monotonic instead of broadcasting an envelope with a duplicated seq).
 *
 * Saves the slim session state *after* `appendSessionEvent` increments
 * `state.eventSeq`, otherwise a daemon restart loads the pre-increment
 * `eventSeq` from `state.json` and `attach_session` filters this very
 * event out of replay (its `seq` is `> currentSeq` from disk). Callers
 * therefore MUST NOT pre-save — they let this helper own the save
 * order, which keeps the persisted cursor monotonic across restarts.
 *
 * Not scoped to a runId: state changes are session-level and happen
 * between runs (an active run blocks `update_session`). The envelope
 * omits the `runId` field entirely — strict-mode rejects `runId: null`.
 */
async function broadcastSessionStateChanged(state) {
  const payload = {
    provider: state.provider,
    model: state.model,
    roleRouting: state.roleRouting || {},
  };
  await appendSessionEvent(state, 'session_state_changed', payload, null);
  await saveSessionState(state);
  broadcastEvent(state.sessionId, {
    v: PROTOCOL_VERSION,
    kind: 'event',
    sessionId: state.sessionId,
    seq: state.eventSeq,
    ts: Date.now(),
    type: 'session_state_changed',
    payload,
  });
}

// ─── Task graph / delegation scaffolds ──────────────────────────

/**
 * Resolve {provider, model} for a given role on an active session.
 * Honours configure_role_routing entries; falls back to session defaults.
 * Throws an Error with a descriptive message if nothing usable is available.
 */
function resolveRoleRouting(entry, role) {
  const routeEntry = entry.state.roleRouting?.[role];
  const routedProvider = normalizeProviderInput(routeEntry?.provider);
  if (routedProvider && !PROVIDER_CONFIGS[routedProvider]) {
    throw new Error(`Unknown provider "${routedProvider}" for ${role} role routing`);
  }
  const sessionProvider = normalizeProviderInput(entry.state.provider);
  if (!routedProvider && (!sessionProvider || !PROVIDER_CONFIGS[sessionProvider])) {
    throw new Error(`Unknown provider "${sessionProvider || '(missing)'}" in session state`);
  }
  const provider = routedProvider || sessionProvider;
  const model =
    (typeof routeEntry?.model === 'string' && routeEntry.model.trim()) ||
    (typeof entry.state.model === 'string' && entry.state.model.trim()) ||
    PROVIDER_CONFIGS[provider].defaultModel;
  return { provider, model };
}

// ─── Daemon Coder tool executor (real lib-kernel integration) ──

/**
 * Wrap a raw CLI tool call (`{ tool, args }`) into the nested shape
 * the lib Coder kernel reads: `{ call: { tool, args } }`. The kernel
 * does a structural cast and reaches for `toolCall.call.tool` /
 * `toolCall.call.args` in both the parallel-reads and single-call
 * branches (`lib/coder-agent.ts` around lines 1437 and 1760). If we
 * hand the kernel a raw flat call, accessing `.call.tool` throws a
 * runtime TypeError and the delegation fails on the first tool turn
 * (codex P1 feedback on PR #282). The `source: 'cli'` tag is a hint
 * to future log inspectors but the kernel itself ignores it.
 *
 * The wrapper + the `DetectedToolCalls` classifier moved to
 * `cli/lead-turn.ts` so the daemon's delegated nodes and the lead-kernel
 * lane (§10 step 2) share one implementation. Re-exported here so
 * existing test imports (`cli/tests/daemon-integration.test.mjs`) keep
 * resolving against pushd.
 */
import {
  wrapCliDetectAllToolCalls,
  wrapCliDetectAnyToolCall,
  wrapCliDetectNativeToolCalls,
} from './lead-turn.js';
export { wrapCliDetectAllToolCalls, wrapCliDetectAnyToolCall, wrapCliDetectNativeToolCalls };

/**
 * Build a `CoderToolExecResult`-shaped tool executor bound to a running
 * delegation. The closure runs `executeToolCall` from `cli/tools.ts`
 * (the same production tool executor the CLI lead turn uses via
 * `cli/lead-turn.ts`) against the session's
 * `state.cwd`, with approval gating routed through `buildApprovalFn`
 * so any high-risk exec emits an `approval_required` event on the
 * child `runId` and blocks on a `submit_approval` RPC.
 *
 * The result is translated from CLI's
 * `{ ok, text, meta?, structuredError? }` shape to lib's discriminated
 * union (`{ kind: 'executed', resultText, errorType? } | { kind: 'denied', reason }`).
 * `errorType` feeds the kernel's mutation-failure tracker
 * (`lib/coder-agent.ts` guards against repeated same-tool+file failures).
 *
 * Non-goals: no sandbox layer (runs directly against `state.cwd`, same
 * model as the CLI engine), no OpenTelemetry spans, no
 * `CapabilityLedger` gating, no `TurnPolicyRegistry` (all Web-side).
 * Pushd is an RPC transport + approval gate, nothing more.
 */
export function makeDaemonCoderToolExec({ sessionId, entry, runId, signal }) {
  const approvalFn = buildApprovalFn(sessionId, entry, runId);
  const workspaceRoot = entry.state.cwd;
  return async (toolCall, _execCtx) => {
    // The kernel passes the nested wrapper we returned from
    // `wrapCliDetectAllToolCalls` / `wrapCliDetectAnyToolCall` — a
    // `{ source, call: { tool, args } }` shape. Unwrap once to get the
    // flat `{ tool, args }` form `executeToolCall` expects. If a
    // caller somehow hands us a bare CLI call (e.g. tests that call
    // the executor directly), fall through and pass it as-is.
    const rawCall =
      toolCall && typeof toolCall === 'object' && toolCall.call ? toolCall.call : toolCall;
    try {
      const result = await executeToolCall(rawCall, workspaceRoot, {
        approvalFn,
        signal,
        // Daemon delegations are expected to run the full tool surface;
        // the approval gate above keeps high-risk exec commands behind
        // an explicit user decision. `execMode: 'auto'` mirrors the
        // non-delegated CLI engine's default, which gates only the
        // commands `isHighRiskCommand()` flags.
        allowExec: true,
        execMode: 'auto',
        // Surface the actual role to executor cases that gate by
        // capability (e.g. `create_artifact`'s defense-in-depth check)
        // and to author-stamping. Without this, a Coder-emitted
        // artifact would default to `role: 'orchestrator'` and
        // misattribute.
        role: 'coder',
        // Provider + model for the Auditor commit gate. The gate is
        // default-on (`lib/auditor-policy.ts`), so a delegated Coder that
        // emits git_commit needs these to run the verdict — without them the
        // gate fails closed and blocks the commit. The env var
        // (`PUSH_AUDITOR_GATE`, forwarded from config by `applyConfigToEnv`)
        // still governs whether the gate runs at all.
        providerId: entry.state.provider,
        model: entry.state.model,
        runId,
      });
      const resultText = typeof result?.text === 'string' ? result.text : '';
      if (result && result.ok === true) {
        return {
          kind: 'executed',
          resultText,
        };
      }
      // Tool ran to completion but reported failure. Feed the opaque
      // structured-error code into the kernel's mutation-failure
      // tracker via `errorType` so repeated same-tool+file failures
      // trigger the kernel's halt guard (`lib/coder-agent.ts`
      // ~line 1407).
      return {
        kind: 'executed',
        resultText,
        errorType: result?.structuredError?.code,
      };
    } catch (err) {
      // `executeToolCall` throwing is the rare exception path —
      // approval-timeout, abort during exec, catastrophic I/O. Surface
      // as a `denied` result so the kernel doesn't spin on the same
      // call forever. The kernel injects the `reason` into the next
      // user message so the model can react to it.
      const message = err instanceof Error ? err.message : String(err);
      return { kind: 'denied', reason: `daemon tool executor error: ${message}` };
    }
  };
}

/**
 * Build an Explorer-shaped tool executor bound to a running delegation.
 *
 * Mirrors `makeDaemonCoderToolExec` but returns the simpler Explorer
 * shape `{ resultText, card? }` instead of the Coder kernel's
 * discriminated union. Two other differences:
 *
 *   1. **No approval gating.** Explorer's contract is read-only — it
 *      inspects the workspace but never mutates it. High-risk exec is
 *      moot because the executor refuses mutating tools outright. We
 *      therefore skip `buildApprovalFn` entirely and pass
 *      `approvalFn: null` / `allowExec: false` to `executeToolCall`.
 *
 *   2. **Capability refusal.** Even with a read-only contract, the
 *      Explorer kernel still routes the optional `mutating` slot
 *      (returned by `wrapCliDetectAllToolCalls`) through `toolExec`
 *      when the model emits one — see `lib/explorer-agent.ts:470`.
 *      We call `roleCanUseTool('explorer', toolName)` inside the
 *      executor and return a polite denial `resultText` for any tool
 *      the Explorer role does not grant, so the kernel feeds the
 *      refusal back into the next round and the model can
 *      course-correct. This mirrors the web-side
 *      `ROLE_CAPABILITY_DENIED` check at
 *      `app/src/lib/web-tool-execution-runtime.ts:147` so both
 *      surfaces enforce via one shared capability table
 *      (`lib/capabilities.ts`). Gate swapped 2026-04-18 as part of
 *      the Gap 2 daemon-side role-capability tranche; the previous
 *      `READ_ONLY_TOOLS` allowlist still exists in `cli/tools.ts`
 *      because `lib/deep-reviewer-agent.ts` consumes it for a
 *      different purpose (read/mutation bucketing of detected tool
 *      calls).
 *
 * We skip `card` entirely. The web-side Explorer tool executor attaches
 * rich metadata cards pulled from structured tool output (e.g. a
 * `read_file` card with the file path + first N lines). Daemon-side we
 * don't have that layer yet, so the `card?` field is simply omitted —
 * the kernel handles `undefined` cards fine (see the `if (entry.card)`
 * guard around line 460).
 *
 * Non-goals (same as Coder): no sandbox layer, no OTel spans, no
 * `CapabilityLedger` gating, no `TurnPolicyRegistry`.
 */
export function makeDaemonExplorerToolExec({ entry, signal, role = 'explorer' }) {
  const workspaceRoot = entry.state.cwd;
  // Read-only roles that share this executor (Explorer, Deep Reviewer). The
  // gate + executor case-dispatch run under this role so capability-gated
  // cases attribute correctly. Defaults to 'explorer' so the two existing
  // call sites are unchanged; the deep-reviewer handler passes 'reviewer'.
  // User-facing label comes from the shared display seam (`lib/role-display.ts`)
  // rather than being spelled here. The deep-reviewer runs under the `reviewer`
  // role but is tagged distinctly in events, so map it to the `deep_reviewer`
  // subagent for display; the plain read-only role is the Explorer.
  const roleLabel = getSubagentLabel(role === 'reviewer' ? 'deep_reviewer' : role);
  return async (toolCall, _execCtx) => {
    // Unwrap the `{ source, call: { tool, args } }` shape produced by
    // `wrapCliDetectAllToolCalls` / `wrapCliDetectAnyToolCall`. Tests
    // that hand in a bare CLI call fall through unchanged.
    const rawCall =
      toolCall && typeof toolCall === 'object' && toolCall.call ? toolCall.call : toolCall;

    // Enforce the role capability grant. The Explorer kernel happily
    // routes a mutating slot through `toolExec` when the model emits
    // one — but Explorer is inspection-only by design. Return a denial
    // resultText so the kernel feeds the refusal back into the next
    // round as a user message and the model can adapt.
    //
    // Three-layer gate (deny if ANY layer says no):
    //   (1) `toolName` must be a non-empty string (defense against
    //       malformed detector output).
    //   (2) `isCapabilityMapped(toolName)` must be true — the name
    //       must have an own-property entry in `TOOL_CAPABILITIES`.
    //       This is stricter than `roleCanUseTool`'s documented
    //       fail-open semantics and diverges intentionally from the
    //       web runtime's fail-open behavior at
    //       `app/src/lib/web-tool-execution-runtime.ts:147`. The
    //       rationale (Copilot PR #331): if a new CLI tool ever
    //       reaches `executeToolCall` without a matching
    //       `TOOL_CAPABILITIES` entry, Explorer should refuse it at
    //       the gate rather than have `roleCanUseTool` fail-open and
    //       silently admit it. The web runtime has other layers that
    //       catch unknown names (per-source executor dispatch table);
    //       the daemon Explorer gate is closer to the model and
    //       should be fail-closed.
    //   (3) `roleCanUseTool('explorer', toolName)` must be true for
    //       the known tool. This is the core Gap 2 check.
    //
    // Layer (2) also defends against prototype-key attacks (`__proto__`,
    // `constructor`, `toString`, `valueOf`, `hasOwnProperty`,
    // `isPrototypeOf`) — `getToolCapabilities` uses `Object.hasOwn`
    // to avoid resolving those to inherited prototype values, but
    // `isCapabilityMapped` belt-and-braces the same concern at the
    // gate. Codex review on PR #331.
    const toolName = typeof rawCall?.tool === 'string' ? rawCall.tool : null;
    if (!toolName || !isCapabilityMapped(toolName) || !roleCanUseTool(role, toolName)) {
      // Phrasing note: we deliberately do NOT name `delegate_coder`
      // here because Explorer cannot invoke it from inside the kernel
      // (delegation is an RPC initiated by the orchestrator / client,
      // not a tool the Explorer model can emit). Naming it would send
      // the model down a dead-end loop of trying to call it as a tool
      // (Copilot review on PR #284).
      //
      // Structured log so operators can grep for ROLE_CAPABILITY_DENIED
      // the same way they do on web. Console.warn keeps this out of
      // the session event protocol (no new event types) while still
      // giving observability parity with the web runtime's structured
      // error at `web-tool-execution-runtime.ts:152`.
      if (toolName) {
        const required = getToolCapabilities(toolName);
        const granted = Array.from(ROLE_CAPABILITIES[role] ?? []);
        try {
          console.warn(
            JSON.stringify({
              level: 'warn',
              event: 'role_capability_denied',
              type: 'ROLE_CAPABILITY_DENIED',
              role,
              tool: toolName,
              required,
              granted,
              sessionId: entry?.sessionId ?? null,
            }),
          );
        } catch {
          // JSON.stringify cycle guard — don't let a malformed log
          // crash the executor.
        }
      }
      return {
        resultText: `[pushd] tool "${toolName ?? '(unknown)'}" is not available to ${roleLabel}. ${roleLabel} is read-only; if mutation is needed, report it in your summary and the orchestrator will request a Coder delegation after you finish.`,
      };
    }

    try {
      const result = await executeToolCall(rawCall, workspaceRoot, {
        // Explorer never gates on approvals — it's read-only.
        approvalFn: null,
        signal,
        // `allowExec: false` keeps the tool surface genuinely read-only
        // even if the capability table ever accidentally grants an
        // exec-family tool to Explorer. Defense in depth behind
        // `roleCanUseTool`.
        allowExec: false,
        execMode: 'auto',
        // Same rationale as the Coder wrapper above: pass the actual
        // role so capability-gated executor cases (artifact dispatch
        // etc.) deny correctly rather than defaulting to orchestrator.
        // Written `role: role` (not shorthand) so the role-required drift
        // detector (cli/tests/role-required-drift.test.mjs) sees the `role:`
        // key it scans for.
        role: role,
      });
      const resultText = typeof result?.text === 'string' ? result.text : '';
      return { resultText };
    } catch (err) {
      // `executeToolCall` throwing is the rare exception path (abort
      // during read, catastrophic I/O). Surface the message as a
      // resultText so the kernel can see what went wrong rather than
      // crashing the delegation. Matches Coder's "don't spin forever"
      // stance.
      const message = err instanceof Error ? err.message : String(err);
      return { resultText: `[pushd] ${roleLabel} tool executor error: ${message}` };
    }
  };
}

/**
 * Task-graph Explorer node invocation — wires `runExplorerAgent` from
 * `lib/explorer-agent.ts` to the real daemon tool executor
 * (`makeDaemonExplorerToolExec`) so explorer nodes actually read the
 * workspace instead of running against a stub. Mirrors
 * `runCoderForTaskGraph` structurally but without approval gating
 * (Explorer is read-only) and with the simpler `{ resultText }`
 * executor return shape.
 *
 * Used only for task-graph explorer nodes; the direct
 * `delegate_explorer` RPC path still goes through
 * `handleDelegateExplorer` for its race-safe terminal-claim
 * semantics — both call sites share the same `makeDaemonExplorerToolExec`
 * factory.
 */

/**
 * Builds an `onRunEvent` handler for role-agent kernels (Coder /
 * Explorer / Reviewer / Auditor) running on the CLI daemon.
 *
 * Two race-safety properties:
 *
 *   1. Seq capture is synchronous. `appendSessionEvent` increments
 *      `state.eventSeq` before its filesystem await resolves, so we
 *      read the seq immediately after starting the append, BEFORE
 *      awaiting. Reading inside `.then()` would race with concurrent
 *      emits (e.g. task-graph `task_completed`) that bump `eventSeq`
 *      before this promise resolves, causing the live envelope to
 *      reuse a later seq than the persisted record — and break clients
 *      that reconcile/replay by seq. Codex P2 on PR #540.
 *
 *   2. Broadcast is gated on persistence success. If the filesystem
 *      append fails the broadcast is skipped, so the wire stream never
 *      contains an envelope that has no persisted counterpart. Errors
 *      surface via the `error` event channel so an operator sees the
 *      gap rather than silent loss.
 */
function emitRoleAgentRunEvent(sessionId, entry, runId) {
  return (event) => {
    const { type, ...payload } = event;
    const writePromise = appendSessionEvent(entry.state, type, payload, runId);
    // Synchronous capture — `state.eventSeq` was bumped by
    // appendSessionEvent before its first await.
    const seq = entry.state.eventSeq;
    writePromise
      .then(() => {
        broadcastEvent(sessionId, {
          v: PROTOCOL_VERSION,
          kind: 'event',
          sessionId,
          ...(runId ? { runId } : {}),
          seq,
          ts: Date.now(),
          type,
          payload,
        });
      })
      .catch((err) => {
        // Persistence failed — skip the broadcast (don't ship a wire
        // envelope without a journal record) and surface a structured
        // warning so the gap is visible to operators.
        const message = err instanceof Error ? err.message : String(err);
        broadcastEvent(sessionId, {
          v: PROTOCOL_VERSION,
          kind: 'event',
          sessionId,
          ...(runId ? { runId } : {}),
          seq,
          ts: Date.now(),
          type: 'warning',
          payload: {
            code: 'PROMPT_SNAPSHOT_PERSIST_FAILED',
            message: `Failed to persist ${type}: ${message}`,
          },
        });
      });
  };
}

async function runExplorerForTaskGraph(sessionId, entry, node, signal, preambleExtras = []) {
  const startedAt = Date.now();
  const { provider, model } = resolveRoleRouting(entry, 'explorer');
  const toolExec = makeDaemonExplorerToolExec({ entry, signal });
  const evaluateAfterModel = async () => null;
  const daemonStream = createDaemonProviderStream(provider, sessionId);
  const nativeToolSchemas = cliProviderModelSupportsNativeToolCalling(provider, model)
    ? getCliReadOnlyNativeToolSchemas()
    : undefined;

  // Splice graph-internal memory (from executeTaskGraph's
  // enrichedContext) and typed-memory retrieval blocks into the
  // task preamble. The model sees them as part of the task
  // description, separated by blank lines — matches how web's
  // role-memory-context.appendRetrievedMemoryBlock concatenates.
  const taskPreamble = [node.task, ...preambleExtras].filter(Boolean).join('\n\n');

  const result = await runExplorerAgent(
    {
      provider,
      stream: daemonStream,
      modelId: model,
      sandboxId: null,
      allowedRepo: '',
      userProfile: null,
      taskPreamble,
      symbolSummary: null,
      toolExec,
      detectAllToolCalls: wrapCliDetectAllToolCalls,
      detectNativeToolCalls: wrapCliDetectNativeToolCalls,
      detectAnyToolCall: wrapCliDetectAnyToolCall,
      webSearchToolProtocol: '',
      // `sandboxToolProtocol` replaces the kernel's default
      // `EXPLORER_TOOL_PROTOCOL` block (which advertises web-side
      // public names like `read` / `repo_read` / `search`) with the
      // CLI-named read-only subset (`read_file` / `list_dir` /
      // `search_files` / …). Without this override the model emits
      // tool calls our detector can't recognize and every round
      // silently fails to execute anything (codex + Copilot P1 on
      // PR #284).
      sandboxToolProtocol: READ_ONLY_TOOL_PROTOCOL,
      nativeToolSchemas,
      evaluateAfterModel,
    },
    {
      onStatus: () => {},
      signal,
      // Forward the per-delegation prompt snapshot onto the daemon
      // event stream so a connected client (TUI / CLI / relay
      // consumer) sees the same audit trail the web orchestrator
      // already emits per turn. `appendSessionEvent` manages
      // persistence + seq; `broadcastEvent` fans out to live
      // listeners using the same envelope shape as the rest of the
      // daemon's emit sites.
      //
      // Seq capture: `appendSessionEvent` increments `state.eventSeq`
      // synchronously before its filesystem await resolves, so we read
      // the seq IMMEDIATELY after starting the append. Reading it
      // inside `.then()` would race with concurrent emits (e.g.
      // task-graph `task_completed`) that bump `eventSeq` before this
      // promise resolves, causing the live envelope to reuse a later
      // seq than the persisted record. Codex P2 on PR #540.
      //
      // Error handling: if the filesystem append fails the broadcast
      // is skipped — sending a live envelope that has no persisted
      // counterpart would diverge the journal from the wire.
      onRunEvent: emitRoleAgentRunEvent(sessionId, entry, null),
    },
  );

  const delegationOutcome = {
    agent: 'explorer',
    status: result.hitRoundCap ? 'incomplete' : 'complete',
    summary: result.summary,
    evidence: [],
    checks: [],
    gateVerdicts: [],
    missingRequirements: [],
    nextRequiredAction: result.hitRoundCap
      ? 'Investigation hit round cap — re-explore with a narrower scope or proceed with partial findings'
      : null,
    rounds: result.rounds,
    checkpoints: 0,
    elapsedMs: Date.now() - startedAt,
  };

  return {
    summary: result.summary,
    delegationOutcome,
    rounds: result.rounds,
  };
}

/**
 * Task-graph Coder node invocation — wires `runCoderAgent` from
 * `lib/coder-agent.ts` to the real daemon tool executor.
 *
 * Mirrors `runExplorerForTaskGraph` structurally, but plugs in
 * `makeDaemonCoderToolExec` (production tool surface + approval gating)
 * and `wrapCliDetect*` (real detectors over `cli/tools.ts`) instead of
 * stubs. The LLM streams real tokens, tool calls are detected, and
 * `executeToolCall` runs them against `entry.state.cwd` — this is the
 * full-fat daemon Coder path.
 *
 * Approval events from tool calls emit on the `parentRunId` passed in
 * by `handleSubmitTaskGraph`, so a task-graph client that's attached
 * to the session sees approval prompts routed through the parent run's
 * stream (the task graph is part of the parent's work — this matches
 * the semantic the synthetic-downgrade path relies on for v1 clients).
 *
 * Coder-specific option fields that don't apply to a daemon run are
 * filled with null/empty defaults so the kernel's branches short-circuit:
 *   - `sandboxId: ''`               — no sandbox layer; runs against `cwd`
 *   - `sandboxToolProtocol: ''`     — prompt block supplied by tool detectors
 *   - `verificationPolicyBlock: null` — no daemon-side verification policy yet
 *   - `approvalModeBlock: null`     — approval gating happens inside `toolExec`
 *
 * Acceptance criteria / harness overrides are omitted so the kernel's
 * defaults apply (no criteria, no context resets, default round cap).
 */
async function runCoderForTaskGraph(
  sessionId,
  entry,
  node,
  parentRunId,
  signal,
  preambleExtras = [],
) {
  const startedAt = Date.now();
  const { provider, model } = resolveRoleRouting(entry, 'coder');
  const daemonStream = createDaemonProviderStream(provider, sessionId);
  const nativeToolSchemas = cliProviderModelSupportsNativeToolCalling(provider, model)
    ? getCliNativeToolSchemas()
    : undefined;
  // `parentRunId` can be null when `submit_task_graph` is called on a
  // session with no active run AND no `parentRunId` payload override.
  // `buildApprovalFn` would emit `approval_required` events with
  // `runId: null` on the wire envelope, which violates the
  // protocol-schema strict-mode rule that `runId` must be omitted or
  // a non-empty string (codex P1 on PR #282). Mint a fresh child run
  // id for the task-graph node in that case so approval events still
  // carry a valid runId, even if no client is specifically listening
  // for this execution's run.
  const effectiveRunId =
    typeof parentRunId === 'string' && parentRunId.trim().length > 0 ? parentRunId : makeRunId();
  const toolExec = makeDaemonCoderToolExec({
    sessionId,
    entry,
    runId: effectiveRunId,
    signal,
  });
  const evaluateAfterModel = async () => null;

  const taskPreamble = [node.task, ...preambleExtras].filter(Boolean).join('\n\n');

  const result = await runCoderAgent(
    {
      provider,
      stream: daemonStream,
      modelId: model,
      // Daemon task-graph node: a delegated implementer, not the lead.
      persona: 'coder',
      sandboxId: '',
      allowedRepo: '',
      userProfile: null,
      taskPreamble,
      symbolSummary: null,
      toolExec,
      detectAllToolCalls: wrapCliDetectAllToolCalls,
      detectNativeToolCalls: wrapCliDetectNativeToolCalls,
      detectAnyToolCall: wrapCliDetectAnyToolCall,
      webSearchToolProtocol: '',
      // `sandboxToolProtocol` is the tool-instruction block the kernel
      // splices into its system prompt — without it the model has no
      // guidance on what tool-call JSON to emit (codex P1 on PR #282).
      // Feed in `TOOL_PROTOCOL` from `cli/tools.ts`, the same block the
      // non-delegated CLI engine uses.
      sandboxToolProtocol: TOOL_PROTOCOL,
      nativeToolSchemas,
      verificationPolicyBlock: null,
      approvalModeBlock: null,
      evaluateAfterModel,
      // Per-run token budget for this daemon task-graph Coder node. Resolved
      // from env (config is forwarded to `PUSH_RUN_TOKEN_BUDGET` by
      // `applyConfigToEnv`); null (uncapped) maps to undefined for the kernel.
      harnessTokenBudget:
        resolveRunTokenBudget({ env: process.env[RUN_TOKEN_BUDGET_ENV_VAR] }) ?? undefined,
    },
    {
      onStatus: () => {},
      signal,
      onRunEvent: emitRoleAgentRunEvent(sessionId, entry, parentRunId ?? null),
    },
  );

  const delegationOutcome = {
    agent: 'coder',
    // Runs that return from `runCoderAgent` without throwing have made
    // it through the kernel's loop. The kernel itself doesn't classify
    // "complete vs incomplete"; that's a delegation-outcome concern.
    // We default to 'complete' on a clean return — any structural
    // failure (thrown error) lands in the catch block in the caller
    // and marks the outcome 'inconclusive'. A richer classifier that
    // inspects working memory + acceptance criteria is a follow-up.
    status: 'complete',
    summary: result.summary,
    evidence: [],
    checks: [],
    gateVerdicts: [],
    missingRequirements: [],
    nextRequiredAction: null,
    rounds: result.rounds,
    checkpoints: result.checkpoints,
    elapsedMs: Date.now() - startedAt,
  };

  return {
    summary: result.summary,
    delegationOutcome,
    rounds: result.rounds,
  };
}

async function handleSubmitTaskGraph(req) {
  const sessionId = req.sessionId || req.payload?.sessionId;
  const providedToken = req.payload?.attachToken;
  const graph = req.payload?.graph;
  const parentRunIdPayload =
    typeof req.payload?.parentRunId === 'string' ? req.payload.parentRunId : null;

  if (!sessionId) {
    return makeErrorResponse(
      req.requestId,
      'submit_task_graph',
      'INVALID_REQUEST',
      'sessionId is required',
    );
  }

  if (!graph || typeof graph !== 'object' || !Array.isArray(graph.tasks)) {
    return makeErrorResponse(
      req.requestId,
      'submit_task_graph',
      'INVALID_REQUEST',
      'graph.tasks must be an array of task nodes',
    );
  }

  let entry = activeSessions.get(sessionId);
  if (!entry) {
    try {
      const state = await loadSessionState(sessionId);
      // Restore the persisted attach token from session state instead of
      // minting a fresh one. Without this, clients lose their token on any
      // handler that lazy-loads a session from disk (including after a
      // daemon crash + restart), because `validateAttachToken` would
      // compare the caller's original token against a freshly minted one.
      // Legacy sessions without a persisted token load with attachToken
      // undefined; they are claimed on first `attach_session` (bootstrap
      // grace). A non-attach handler reached before that claim now rejects —
      // the implicit tokenless bypass is gone (Universal Session Bearer).
      entry = { state, attachToken: state.attachToken };
      activeSessions.set(sessionId, entry);
    } catch {
      return makeErrorResponse(
        req.requestId,
        'submit_task_graph',
        'SESSION_NOT_FOUND',
        `Session not found: ${sessionId}`,
      );
    }
  }

  if (!validateAttachToken(entry, providedToken)) {
    return makeErrorResponse(
      req.requestId,
      'submit_task_graph',
      'INVALID_TOKEN',
      'Invalid or missing attach token',
    );
  }

  const validationErrors = validateTaskGraph(graph.tasks);
  if (validationErrors.length > 0) {
    return makeErrorResponse(
      req.requestId,
      'submit_task_graph',
      'INVALID_TASK_GRAPH',
      validationErrors.map((e) => `${e.type}: ${e.message}`).join('; '),
    );
  }

  ensureRuntimeState(entry);

  const executionId = `graph_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
  const parentRunId = parentRunIdPayload || entry.activeRunId || null;
  const abortController = new AbortController();
  const startedAt = Date.now();
  const nodeCount = graph.tasks.length;

  entry.activeGraphs.set(executionId, {
    executionId,
    parentRunId,
    abortController,
    startedAt,
    nodeCount,
  });

  const ack = makeResponse(req.requestId, 'submit_task_graph', sessionId, true, {
    executionId,
    accepted: true,
    nodeCount,
  });

  // Background execution — RPC has already acked. Events flow through
  // appendSessionEvent + broadcastEvent as lib/task-graph makes progress.
  (async () => {
    // Index nodes by id so onProgress can recover the agent kind from taskId.
    const nodesById = new Map();
    for (const node of graph.tasks) nodesById.set(node.id, node);

    // Serialize task-graph progress writes through a per-session promise
    // chain. `executeTaskGraph` calls `onProgress` synchronously, and with
    // parallel explorer nodes (max 3) multiple progress callbacks can fire
    // in quick succession. Without serialization, concurrent
    // `appendSessionEvent` calls race on `state.eventSeq` — the field is
    // mutated *before* the filesystem append resolves, so overlapping calls
    // can (a) write events to `events.jsonl` out of seq order and
    // (b) read a seq value for the broadcast envelope that has already been
    // bumped by a later write. `attach_session` replays from disk in file
    // order, so misordering would surface on any reconnect.
    let emitChain = Promise.resolve();
    const emitTaskGraphEvent = (type, payload) => {
      const runIdField = parentRunId ? { runId: parentRunId } : {};
      const chained = emitChain.then(async () => {
        // Pass `parentRunId` (possibly null) through to appendSessionEvent;
        // session-store already omits `runId` from the persisted envelope
        // when the argument is falsy, so the on-disk record stays consistent
        // with the wire envelope built below.
        await appendSessionEvent(entry.state, type, payload, parentRunId).catch(() => {});
        broadcastEvent(sessionId, {
          v: PROTOCOL_VERSION,
          kind: 'event',
          sessionId,
          ...runIdField,
          seq: entry.state.eventSeq,
          ts: Date.now(),
          type,
          payload,
        });
      });
      emitChain = chained.catch(() => {});
      return chained;
    };

    const onProgress = (evt) => {
      if (evt.type === 'graph_complete') {
        // Final graph_completed event is emitted explicitly below with
        // richer metadata (success/aborted/counters) from the result object.
        return;
      }
      const node = evt.taskId ? nodesById.get(evt.taskId) : null;
      const agent = node?.agent || 'explorer';
      switch (evt.type) {
        case 'task_ready':
          emitTaskGraphEvent('task_graph.task_ready', {
            executionId,
            taskId: evt.taskId,
            agent,
            detail: evt.detail,
          });
          return;
        case 'task_started':
          emitTaskGraphEvent('task_graph.task_started', {
            executionId,
            taskId: evt.taskId,
            agent,
            detail: evt.detail,
          });
          return;
        case 'task_completed':
          emitTaskGraphEvent('task_graph.task_completed', {
            executionId,
            taskId: evt.taskId,
            agent,
            summary: evt.detail || '',
            elapsedMs: evt.elapsedMs,
          });
          return;
        case 'task_failed':
          emitTaskGraphEvent('task_graph.task_failed', {
            executionId,
            taskId: evt.taskId,
            agent,
            error: evt.detail || 'Task failed',
            elapsedMs: evt.elapsedMs,
          });
          return;
        case 'task_cancelled':
          emitTaskGraphEvent('task_graph.task_cancelled', {
            executionId,
            taskId: evt.taskId,
            agent,
            reason: evt.detail || 'Task cancelled',
            elapsedMs: evt.elapsedMs,
          });
          return;
        default:
          return;
      }
    };

    // Resolve workspace identity once per graph — branch could move
    // during a long-running graph if a Coder node commits or
    // switches branches, but for the scope of this graph the
    // identity captured here is used as the memory scope for all
    // retrievals + writes. This matches how web uses a single
    // branchInfoRef snapshot per delegation (useAgentDelegation.ts).
    // resolveWorkspaceIdentity is non-throwing by contract (errors
    // become path.basename(cwd) / null fallbacks internally), so no
    // outer catch needed.
    const workspaceIdentity = await resolveWorkspaceIdentity(entry.state.cwd);
    // chatId deliberately omitted from the scope: pushd's sessionId is
    // per-invocation for headless flows, and even attached sessions
    // wouldn't benefit from chatId-narrowing memory across the
    // workspace. Codex P1 review on PR #333.
    const graphMemoryScope = {
      repoFullName: workspaceIdentity.repoFullName,
      branch: workspaceIdentity.branch ?? undefined,
      taskGraphId: executionId,
    };

    const executor = async (node, enrichedContext, signal) => {
      // Retrieve typed memory scoped to this node. Splice it
      // alongside the graph-internal memory (`enrichedContext`
      // from lib/task-graph.ts, containing `[TASK_GRAPH_MEMORY]`
      // summaries of completed dependency + sibling nodes) into
      // the node's taskPreamble. Retrieval failures return null
      // and the node runs with just the graph-internal memory —
      // graceful degradation.
      const retrievedBlock = await buildTypedMemoryBlockForNode({
        node,
        scope: graphMemoryScope,
      });
      const preambleExtras = [
        ...(enrichedContext ?? []),
        ...(retrievedBlock ? [retrievedBlock] : []),
      ];

      if (node.agent === 'explorer') {
        return runExplorerForTaskGraph(sessionId, entry, node, signal, preambleExtras);
      }
      if (node.agent === 'coder') {
        return runCoderForTaskGraph(sessionId, entry, node, parentRunId, signal, preambleExtras);
      }
      throw new Error(`Unsupported task-graph agent: ${node.agent}`);
    };

    let result;
    let execError = null;
    try {
      result = await executeTaskGraph(graph.tasks, executor, {
        signal: abortController.signal,
        onProgress,
      });
    } catch (err) {
      // executeTaskGraph normally does not throw (cancellation surfaces via
      // aborted=true), but defensively emit a terminal event so clients are
      // never left waiting on a silent graph.
      execError = err instanceof Error ? err : new Error(String(err));
    }

    const completedPayload = result
      ? {
          executionId,
          summary: formatTaskGraphResult(result),
          success: result.success,
          aborted: result.aborted,
          nodeCount,
          totalRounds: result.totalRounds,
          wallTimeMs: result.wallTimeMs,
        }
      : {
          executionId,
          summary: `Task graph crashed: ${execError?.message ?? 'unknown error'}`,
          success: false,
          aborted: false,
          nodeCount,
          totalRounds: 0,
          wallTimeMs: Date.now() - startedAt,
        };

    // Persist typed memory for each completed node before emitting
    // graph_completed so later runs can retrieve prior findings +
    // outcomes. Writes are error-isolated — a failure for one node
    // logs and continues, never blocking the completion event.
    // Reuses `graphMemoryScope` already resolved above so we don't
    // invoke git twice per graph.
    if (result) {
      try {
        await writeTaskGraphResultMemory(result, graphMemoryScope);
      } catch (err) {
        // Belt-and-braces — writeTaskGraphResultMemory is
        // error-isolated per-node, so a throw at this level means
        // something went wrong before the loop (e.g., an
        // unexpected store-initialization failure).
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `${JSON.stringify({
            level: 'warn',
            event: 'task_graph_memory_persist_failed',
            executionId,
            error: msg,
          })}\n`,
        );
      }
    }

    await emitTaskGraphEvent('task_graph.graph_completed', completedPayload);
    entry.activeGraphs.delete(executionId);
    await saveSessionState(entry.state).catch(() => {});
  })();

  return ack;
}

async function handleCancelDelegation(req) {
  const sessionId = req.sessionId || req.payload?.sessionId;
  const providedToken = req.payload?.attachToken;
  const subagentId = req.payload?.subagentId;

  if (!sessionId) {
    return makeErrorResponse(
      req.requestId,
      'cancel_delegation',
      'INVALID_REQUEST',
      'sessionId is required',
    );
  }

  if (!subagentId) {
    return makeErrorResponse(
      req.requestId,
      'cancel_delegation',
      'INVALID_REQUEST',
      'subagentId is required',
    );
  }

  let entry = activeSessions.get(sessionId);
  if (!entry) {
    try {
      const state = await loadSessionState(sessionId);
      // Restore the persisted attach token from session state instead of
      // minting a fresh one. Without this, clients lose their token on any
      // handler that lazy-loads a session from disk (including after a
      // daemon crash + restart), because `validateAttachToken` would
      // compare the caller's original token against a freshly minted one.
      // Legacy sessions without a persisted token load with attachToken
      // undefined; they are claimed on first `attach_session` (bootstrap
      // grace). A non-attach handler reached before that claim now rejects —
      // the implicit tokenless bypass is gone (Universal Session Bearer).
      entry = { state, attachToken: state.attachToken };
      activeSessions.set(sessionId, entry);
    } catch {
      return makeErrorResponse(
        req.requestId,
        'cancel_delegation',
        'SESSION_NOT_FOUND',
        `Session not found: ${sessionId}`,
      );
    }
  }

  if (!validateAttachToken(entry, providedToken)) {
    return makeErrorResponse(
      req.requestId,
      'cancel_delegation',
      'INVALID_TOKEN',
      'Invalid or missing attach token',
    );
  }

  ensureRuntimeState(entry);
  const delegation = entry.activeDelegations.get(subagentId);

  // If the id doesn't map to an active delegation, treat it as a task-graph
  // executionId. We reuse cancel_delegation here so v2 task-graph clients
  // don't need a new RPC just to abort a graph.
  if (!delegation) {
    const graph = entry.activeGraphs.get(subagentId);
    if (graph) {
      if (graph.abortController) graph.abortController.abort();
      // The background executor loop observes `signal.aborted`, drives each
      // running node to a `task_graph.task_cancelled` event, and emits the
      // final `task_graph.graph_completed` with aborted=true before removing
      // the entry from activeGraphs.
      return makeResponse(req.requestId, 'cancel_delegation', sessionId, true, {
        accepted: true,
        kind: 'task_graph',
        executionId: subagentId,
      });
    }
    return makeErrorResponse(
      req.requestId,
      'cancel_delegation',
      'DELEGATION_NOT_FOUND',
      `No active delegation with subagentId: ${subagentId}`,
      false,
    );
  }

  if (delegation.abortController) {
    delegation.abortController.abort();
  }
  entry.activeDelegations.delete(subagentId);

  const childRunId = typeof delegation.childRunId === 'string' ? delegation.childRunId : null;
  const parentRunId = typeof delegation.parentRunId === 'string' ? delegation.parentRunId : null;
  const agent = delegation.agent || delegation.role || 'subagent';
  const message = 'Cancelled by client';
  const eventPayload = {
    executionId: subagentId,
    subagentId,
    ...(parentRunId ? { parentRunId } : {}),
    ...(childRunId ? { childRunId } : {}),
    agent,
    role: delegation.role || agent,
    error: message,
    errorDetails: { code: 'CANCELLED', message, retryable: false },
  };
  await appendSessionEvent(entry.state, 'subagent.failed', eventPayload, childRunId);
  await saveSessionState(entry.state);
  broadcastEvent(sessionId, {
    v: PROTOCOL_VERSION,
    kind: 'event',
    sessionId,
    runId: childRunId,
    seq: entry.state.eventSeq,
    ts: Date.now(),
    type: 'subagent.failed',
    payload: eventPayload,
  });

  return makeResponse(req.requestId, 'cancel_delegation', sessionId, true, {
    accepted: true,
  });
}

// ─── Delegation event replay ────────────────────────────────────

async function handleFetchDelegationEvents(req) {
  const sessionId = req.sessionId || req.payload?.sessionId;
  const providedToken = req.payload?.attachToken;
  const subagentId = req.payload?.subagentId;
  const childRunId = req.payload?.childRunId;
  const sinceSeq = req.payload?.sinceSeq;
  const limit = req.payload?.limit;

  if (!sessionId) {
    return makeErrorResponse(
      req.requestId,
      'fetch_delegation_events',
      'INVALID_REQUEST',
      'sessionId is required',
    );
  }

  if (!subagentId && !childRunId) {
    return makeErrorResponse(
      req.requestId,
      'fetch_delegation_events',
      'INVALID_REQUEST',
      'At least one of subagentId or childRunId is required',
    );
  }

  let entry = activeSessions.get(sessionId);
  if (!entry) {
    try {
      const state = await loadSessionState(sessionId);
      // Restore the persisted attach token from session state instead of
      // minting a fresh one. Without this, clients lose their token on any
      // handler that lazy-loads a session from disk (including after a
      // daemon crash + restart), because `validateAttachToken` would
      // compare the caller's original token against a freshly minted one.
      // Legacy sessions without a persisted token load with attachToken
      // undefined; they are claimed on first `attach_session` (bootstrap
      // grace). A non-attach handler reached before that claim now rejects —
      // the implicit tokenless bypass is gone (Universal Session Bearer).
      entry = { state, attachToken: state.attachToken };
      activeSessions.set(sessionId, entry);
    } catch {
      return makeErrorResponse(
        req.requestId,
        'fetch_delegation_events',
        'SESSION_NOT_FOUND',
        `Session not found: ${sessionId}`,
      );
    }
  }

  if (!validateAttachToken(entry, providedToken)) {
    return makeErrorResponse(
      req.requestId,
      'fetch_delegation_events',
      'INVALID_TOKEN',
      'Invalid or missing attach token',
    );
  }

  const allEvents = await loadSessionEvents(sessionId);

  let filtered = allEvents.filter((e) => eventBelongsToChild(e, { subagentId, childRunId }));

  if (typeof sinceSeq === 'number' && Number.isFinite(sinceSeq)) {
    filtered = filtered.filter((e) => e.seq > sinceSeq);
  }

  const fromSeq = filtered.length > 0 ? filtered[0].seq : 0;

  if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
    filtered = filtered.slice(0, limit);
  }

  const toSeq = filtered.length > 0 ? filtered[filtered.length - 1].seq : fromSeq;

  return makeResponse(req.requestId, 'fetch_delegation_events', sessionId, true, {
    events: filtered,
    replay: {
      fromSeq,
      toSeq,
      completed: true,
    },
  });
}

// ─── Addressable child sessions (Addressable Session Verbs phase 3) ──
//
// A delegated Coder/Explorer run is addressed by its `subagentId` — the stable
// id minted at delegation time. It is NOT a separate session on disk: a child
// is a *view* over the parent session (its events filtered by childRunId).
// `list_children` enumerates them; `get_child_session` returns one as a
// structured descriptor + an event summary. Both are bearer-gated reads over
// the PARENT session's attach token (the 13th + 14th enforcement sites). Live
// streaming (`attach_child_session`) and the `abort` alias are follow-ups;
// child abort already exists as `cancel_delegation`.

/**
 * Does this event belong to the given child run? Membership is by subagentId
 * (`payload.subagentId` / `payload.executionId`) or childRunId
 * (`payload.childRunId` / envelope `runId`). Single source of truth shared by
 * `fetch_delegation_events`, `list_children`, and `get_child_session` so the
 * three can't drift on "which events are this child's".
 */
function eventBelongsToChild(event, { subagentId, childRunId }) {
  const p = event && event.payload && typeof event.payload === 'object' ? event.payload : {};
  if (subagentId && p.subagentId === subagentId) return true;
  if (subagentId && p.executionId === subagentId) return true;
  if (childRunId && p.childRunId === childRunId) return true;
  if (childRunId && event?.runId === childRunId) return true;
  return false;
}

/**
 * Descriptor for an ACTIVE child (still in `entry.activeDelegations`). Rich:
 * the in-memory record carries role/agent/task/parent/childRunId/startedAt.
 */
function buildActiveChildDescriptor(subagentId, record) {
  return {
    subagentId,
    status: 'active',
    role: record.role || record.agent || 'subagent',
    agent: record.agent || record.role || 'subagent',
    task: typeof record.task === 'string' ? record.task : '',
    childRunId: typeof record.childRunId === 'string' ? record.childRunId : null,
    parentRunId: typeof record.parentRunId === 'string' ? record.parentRunId : null,
    startedAt: typeof record.startedAt === 'number' ? record.startedAt : null,
  };
}

/**
 * Descriptor for a COMPLETED child (in `state.delegationOutcomes`). The
 * persisted `DelegationOutcome` carries agent/status/summary/rounds/etc. but
 * NOT the original task or childRunId (those lived on the in-memory record,
 * dropped at completion) — `get_child_session` recovers them from the child's
 * `subagent.started` event when a single-child event scan is affordable.
 */
function buildCompletedChildDescriptor(subagentId, outcome) {
  const o = outcome && typeof outcome === 'object' ? outcome : {};
  return {
    subagentId,
    status: 'completed',
    role: o.agent || 'subagent',
    agent: o.agent || 'subagent',
    outcomeStatus: typeof o.status === 'string' ? o.status : null,
    summary: typeof o.summary === 'string' ? o.summary : '',
    rounds: typeof o.rounds === 'number' ? o.rounds : null,
    checkpoints: typeof o.checkpoints === 'number' ? o.checkpoints : null,
    elapsedMs: typeof o.elapsedMs === 'number' ? o.elapsedMs : null,
  };
}

/**
 * Descriptor reconstructed from the EVENT LOG for a child that is neither in
 * `activeDelegations` nor `delegationOutcomes` — i.e. a completed reviewer /
 * deep_reviewer run (those emit `subagent.started` + a terminal event but
 * persist no `DelegationOutcome`, whose `agent` type is only `'coder' |
 * 'explorer'`). Event-derived ⟹ not in the active map ⟹ historical, so
 * `status` is `'completed'`; `terminalType` records which terminal event was
 * seen (`subagent.completed` / `subagent.failed`), or null if the run ended
 * without one (e.g. a daemon crash mid-run). `events` must already be filtered
 * to this child and is expected to contain a `subagent.started` (both call
 * sites guarantee it); if it doesn't, metadata fields degrade to null/empty
 * rather than throwing.
 */
function buildEventDerivedChildDescriptor(subagentId, events) {
  const started = events.find((e) => e.type === 'subagent.started');
  const sp = started?.payload && typeof started.payload === 'object' ? started.payload : {};
  const terminal = events.find(
    (e) => e.type === 'subagent.completed' || e.type === 'subagent.failed',
  );
  return {
    subagentId,
    status: 'completed',
    source: 'events',
    role: sp.role || sp.agent || 'subagent',
    agent: sp.agent || sp.role || 'subagent',
    task: typeof sp.detail === 'string' ? sp.detail : '',
    childRunId:
      typeof sp.childRunId === 'string'
        ? sp.childRunId
        : typeof started?.runId === 'string'
          ? started.runId
          : null,
    parentRunId: typeof sp.parentRunId === 'string' ? sp.parentRunId : null,
    startedAt: typeof started?.ts === 'number' ? started.ts : null,
    terminalType: terminal ? terminal.type : null,
  };
}

/**
 * Lazy-load + bearer-validate a session entry for the child read verbs. Mirrors
 * the `cancel_delegation` / `fetch_delegation_events` preamble (lazy disk-load
 * restores the persisted token; a legacy tokenless session is claimed only by
 * `attach_session`, so a tokenless read here is rejected — bypass is gone).
 * Returns `{ entry, sessionId }` on success or `{ error }` ready to return.
 */
async function loadAndAuthSession(req, type) {
  const sessionId = req.sessionId || req.payload?.sessionId;
  const providedToken = req.payload?.attachToken;
  if (!sessionId) {
    return {
      error: makeErrorResponse(req.requestId, type, 'INVALID_REQUEST', 'sessionId is required'),
    };
  }
  let entry = activeSessions.get(sessionId);
  if (!entry) {
    try {
      const state = await loadSessionState(sessionId);
      entry = { state, attachToken: state.attachToken };
      activeSessions.set(sessionId, entry);
    } catch {
      return {
        error: makeErrorResponse(
          req.requestId,
          type,
          'SESSION_NOT_FOUND',
          `Session not found: ${sessionId}`,
        ),
      };
    }
  }
  if (!validateAttachToken(entry, providedToken)) {
    return {
      error: makeErrorResponse(
        req.requestId,
        type,
        'INVALID_TOKEN',
        'Invalid or missing attach token',
      ),
    };
  }
  return { entry, sessionId };
}

/**
 * `list_children` — enumerate the delegated child runs of a session. Active
 * children come from the in-memory `activeDelegations` map (lost on daemon
 * restart, like the runs themselves); completed children come from the
 * persisted `state.delegationOutcomes`. Read-only, bearer-gated. Task-graph
 * executions are a separate concept (their own `task_graph.*` events) and are
 * intentionally not listed here.
 *
 * Default is cheap (no event-log scan). Pass `includeEventDerived: true` to also
 * surface children reconstructed from the event log — completed reviewer /
 * deep_reviewer runs that emit `subagent.*` events but persist no
 * `DelegationOutcome` (its `agent` type is only `'coder' | 'explorer'`). That
 * path loads the full log (O(n)); it is opt-in so the default stays O(children).
 */
async function handleListChildren(req) {
  const auth = await loadAndAuthSession(req, 'list_children');
  if (auth.error) return auth.error;
  const { entry, sessionId } = auth;
  ensureRuntimeState(entry);
  const includeEventDerived = req.payload?.includeEventDerived === true;

  const active = [];
  for (const [subagentId, record] of entry.activeDelegations) {
    active.push(buildActiveChildDescriptor(subagentId, record));
  }
  const activeIds = new Set(active.map((c) => c.subagentId));

  // Completed children from persisted outcomes (coder/explorer only — see the
  // event-derived path below for reviewer/deep_reviewer).
  const completed = [];
  const seenCompleted = new Set();
  const outcomes = Array.isArray(entry.state?.delegationOutcomes)
    ? entry.state.delegationOutcomes
    : [];
  for (const rec of outcomes) {
    if (!rec || typeof rec.subagentId !== 'string') continue;
    // Prefer the live 'active' view if the same id is somehow still in flight.
    if (activeIds.has(rec.subagentId)) continue;
    // Dedup: a crash/retry path could append the same subagentId more than once;
    // surface each child exactly once (the first/authoritative outcome record).
    if (seenCompleted.has(rec.subagentId)) continue;
    seenCompleted.add(rec.subagentId);
    completed.push(buildCompletedChildDescriptor(rec.subagentId, rec.outcome));
  }

  // Opt-in: reconstruct children present in the event log but not in the
  // active map or persisted outcomes (the reviewer / deep_reviewer case).
  const eventDerived = [];
  if (includeEventDerived) {
    const known = new Set([...activeIds, ...seenCompleted]);
    const byChild = new Map();
    const allEvents = await loadSessionEvents(sessionId);
    for (const e of allEvents) {
      const p = e.payload && typeof e.payload === 'object' ? e.payload : {};
      // Group by the REAL delegation id only — every `subagent.*` event carries
      // `subagentId`. No `executionId` fallback: task-graph executions are keyed
      // by executionId and are a separate concept (their own `task_graph.*`
      // events), so this keeps their pseudo-subagents out of the children list.
      const sid = typeof p.subagentId === 'string' ? p.subagentId : null;
      if (!sid || known.has(sid)) continue;
      if (!byChild.has(sid)) byChild.set(sid, []);
      byChild.get(sid).push(e);
    }
    for (const [sid, evs] of byChild) {
      // Require a started event so a stray subagentId-tagged event without a
      // real delegation start isn't mistaken for a child.
      if (!evs.some((e) => e.type === 'subagent.started')) continue;
      eventDerived.push(buildEventDerivedChildDescriptor(sid, evs));
    }
  }

  return makeResponse(req.requestId, 'list_children', sessionId, true, {
    children: [...active, ...completed, ...eventDerived],
    activeCount: active.length,
    completedCount: completed.length,
    eventDerivedCount: eventDerived.length,
  });
}

/**
 * `get_child_session` — return one delegated child as a structured descriptor
 * plus a summary of its event stream (count + seq range). For a completed
 * child, recovers childRunId/task/parentRunId/startedAt from its
 * `subagent.started` event. Read-only, bearer-gated. The full transcript is
 * available via `fetch_delegation_events`.
 */
async function handleGetChildSession(req) {
  const subagentId = req.payload?.subagentId;
  if (!subagentId || typeof subagentId !== 'string') {
    return makeErrorResponse(
      req.requestId,
      'get_child_session',
      'INVALID_REQUEST',
      'subagentId is required',
    );
  }
  const auth = await loadAndAuthSession(req, 'get_child_session');
  if (auth.error) return auth.error;
  const { entry, sessionId } = auth;
  ensureRuntimeState(entry);

  const activeRecord = entry.activeDelegations.get(subagentId);
  const outcomes = Array.isArray(entry.state?.delegationOutcomes)
    ? entry.state.delegationOutcomes
    : [];
  const outcomeRec = activeRecord ? null : outcomes.find((o) => o && o.subagentId === subagentId);

  // Scan the child's events once to build the summary, recover metadata, and
  // (when the child is neither active nor a persisted outcome) reconstruct an
  // event-derived descriptor — this is what surfaces completed reviewer /
  // deep_reviewer children, which emit subagent.* events but persist no
  // DelegationOutcome. Loading the full parent log is O(n) per call — the same
  // cost `fetch_delegation_events` already pays; acceptable for a single-child
  // read, not the cheap `list_children` enumeration. childRunId is recovered
  // from the started event (a completed child's descriptor has none), then the
  // log is re-filtered with both ids so events carrying only the envelope runId
  // are included too.
  const allEvents = await loadSessionEvents(sessionId);
  let childRunId =
    activeRecord && typeof activeRecord.childRunId === 'string' ? activeRecord.childRunId : null;
  if (!childRunId) {
    const started0 = allEvents.find(
      (e) =>
        e.type === 'subagent.started' && eventBelongsToChild(e, { subagentId, childRunId: null }),
    );
    if (started0?.payload && typeof started0.payload === 'object') {
      const p = started0.payload;
      if (typeof p.childRunId === 'string') childRunId = p.childRunId;
    }
  }
  const events = allEvents.filter((e) => eventBelongsToChild(e, { subagentId, childRunId }));
  const started = events.find((e) => e.type === 'subagent.started');

  // Resolve the descriptor: active > persisted outcome > event-derived > not found.
  let descriptor;
  if (activeRecord) {
    descriptor = buildActiveChildDescriptor(subagentId, activeRecord);
  } else if (outcomeRec) {
    descriptor = buildCompletedChildDescriptor(subagentId, outcomeRec.outcome);
  } else if (started) {
    descriptor = buildEventDerivedChildDescriptor(subagentId, events);
  } else {
    return makeErrorResponse(
      req.requestId,
      'get_child_session',
      'CHILD_NOT_FOUND',
      `No child delegation with subagentId: ${subagentId}`,
    );
  }

  // Enrich the active / persisted-outcome descriptors from the started event
  // (best-effort: missing fields degrade to null/empty). The event-derived
  // descriptor is already built straight from the events.
  if (descriptor.source !== 'events' && started?.payload && typeof started.payload === 'object') {
    const p = started.payload;
    if (descriptor.childRunId == null && typeof p.childRunId === 'string') {
      descriptor.childRunId = p.childRunId;
    }
    if (descriptor.parentRunId == null && typeof p.parentRunId === 'string') {
      descriptor.parentRunId = p.parentRunId;
    }
    if (descriptor.startedAt == null && typeof started.ts === 'number') {
      descriptor.startedAt = started.ts;
    }
    if ((!descriptor.task || descriptor.task.length === 0) && typeof p.detail === 'string') {
      descriptor.task = p.detail;
    }
  }

  const eventSummary = {
    eventCount: events.length,
    firstSeq: events.length > 0 ? events[0].seq : null,
    lastSeq: events.length > 0 ? events[events.length - 1].seq : null,
    lastType: events.length > 0 ? events[events.length - 1].type : null,
  };

  return makeResponse(req.requestId, 'get_child_session', sessionId, true, {
    child: descriptor,
    eventSummary,
  });
}

/**
 * `session_summarize` — on-demand context compaction (Addressable Session Verbs
 * phase 4; opencode's `session.summarize`). Replaces the older turns with a
 * digest, keeping the system prompt, first user turn, and the last
 * `preserveTurns` turns — the same `compactContext` the CLI `/compact` command
 * uses, now reachable as a bearer-gated daemon verb. Persists the compacted
 * transcript (`rewriteMessagesLog`, since the length-only fast path can skip a
 * same-length swap) and emits `context_compacted`. Rejected while a run is
 * active (compacting mid-run would corrupt the in-flight context).
 */
async function handleSessionSummarize(req, _emitEvent) {
  const auth = await loadAndAuthSession(req, 'session_summarize');
  if (auth.error) return auth.error;
  const { entry, sessionId } = auth;

  if (entry.activeRunId) {
    return makeErrorResponse(
      req.requestId,
      'session_summarize',
      'RUN_IN_PROGRESS',
      `Cannot summarize while run ${entry.activeRunId} is active`,
    );
  }

  // Strict, like the CLI `/compact`: a positive integer (or its exact digit
  // string), clamped to [1, 64]. Reject malformed input rather than coercing.
  const preserveTurns = parsePositiveIntField(req.payload?.preserveTurns, 6, 64);
  if (preserveTurns === null) {
    return makeErrorResponse(
      req.requestId,
      'session_summarize',
      'INVALID_REQUEST',
      'preserveTurns must be a positive integer',
    );
  }

  const messages = Array.isArray(entry.state?.messages) ? entry.state.messages : [];
  const result = compactContext(messages, { preserveTurns });

  // "Nothing to compact" is a valid no-op outcome, not an error.
  if (!result.compacted) {
    return makeResponse(req.requestId, 'session_summarize', sessionId, true, {
      compacted: false,
      preserveTurns: result.preserveTurns,
      totalTurns: result.totalTurns,
      beforeTokens: result.beforeTokens,
      afterTokens: result.afterTokens,
      removedCount: 0,
      compactedCount: 0,
    });
  }

  entry.state.messages = result.messages;
  const compactedPayload = {
    preserveTurns: result.preserveTurns,
    totalTurns: result.totalTurns,
    compactedMessages: result.compactedCount,
    removedCount: result.removedCount,
    beforeTokens: result.beforeTokens,
    afterTokens: result.afterTokens,
  };
  await appendSessionEvent(entry.state, 'context_compacted', compactedPayload);
  // Explicit rewrite: compaction can produce a same-length messages array
  // (drop one, insert digest), which `saveSessionState`'s length-only fast path
  // would skip — leaving the on-disk transcript out of sync with memory.
  await rewriteMessagesLog(entry.state);
  // Notify live clients so an attached transcript view doesn't go stale.
  broadcastEvent(sessionId, {
    v: PROTOCOL_VERSION,
    kind: 'event',
    sessionId,
    seq: entry.state.eventSeq,
    ts: Date.now(),
    type: 'context_compacted',
    payload: compactedPayload,
  });

  return makeResponse(req.requestId, 'session_summarize', sessionId, true, {
    compacted: true,
    preserveTurns: result.preserveTurns,
    totalTurns: result.totalTurns,
    compactedCount: result.compactedCount,
    removedCount: result.removedCount,
    beforeTokens: result.beforeTokens,
    afterTokens: result.afterTokens,
  });
}

/**
 * Parse a strict positive-integer payload field (a number or its exact digit
 * string), clamped to [1, max]. Returns `null` for anything malformed —
 * matches the CLI `/compact` strictness; the handler turns `null` into an
 * INVALID_REQUEST rather than coercing bad input.
 */
function parsePositiveIntField(raw: unknown, fallback: number, max: number): number | null {
  if (raw === undefined) return fallback;
  let n: number;
  if (typeof raw === 'number') n = raw;
  else if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) n = Number.parseInt(raw.trim(), 10);
  else n = Number.NaN;
  if (!Number.isInteger(n) || n < 1) return null;
  return Math.min(max, n);
}

/**
 * `session_revert` — undo the last N user turns of the conversation
 * (Addressable Session Verbs phase 5; opencode's `session.revert`). Transcript
 * only: it truncates `state.messages` (and persists via `rewriteMessagesLog`)
 * and stashes the removed tail on the entry so `session_unrevert` can restore
 * it. Sandbox / git state is deliberately untouched — code rollback is a
 * separate concern with its own typed branch tools. Turn boundaries use the
 * same `isFirstUserMessage` detector as compaction. The stash accumulates
 * across consecutive reverts and is cleared by the next `send_user_message`
 * (a new message commits the fork). Bearer-gated; rejected mid-run.
 */
async function handleSessionRevert(req) {
  const auth = await loadAndAuthSession(req, 'session_revert');
  if (auth.error) return auth.error;
  const { entry, sessionId } = auth;

  if (entry.activeRunId) {
    return makeErrorResponse(
      req.requestId,
      'session_revert',
      'RUN_IN_PROGRESS',
      `Cannot revert while run ${entry.activeRunId} is active`,
    );
  }

  const turns = parsePositiveIntField(req.payload?.turns, 1, 1024);
  if (turns === null) {
    return makeErrorResponse(
      req.requestId,
      'session_revert',
      'INVALID_REQUEST',
      'turns must be a positive integer',
    );
  }

  const messages = Array.isArray(entry.state?.messages) ? entry.state.messages : [];
  const turnStarts = [];
  for (let i = 0; i < messages.length; i += 1) {
    if (isFirstUserMessage(messages[i])) turnStarts.push(i);
  }
  const totalTurns = turnStarts.length;

  if (totalTurns === 0) {
    return makeResponse(req.requestId, 'session_revert', sessionId, true, {
      reverted: false,
      removedCount: 0,
      totalTurns: 0,
      remainingTurns: 0,
    });
  }

  // Critical section: read `messages` → mutate `state.messages` + `revertedTail`
  // with NO `await` in between, so it runs atomically on Node's single-threaded
  // loop — a concurrent revert/unrevert can't interleave a read-modify-write
  // here (the first `await` below is the only yield point). Same concurrency
  // posture as every other session-mutating handler; no extra lock is taken.
  const effectiveTurns = Math.min(turns, totalTurns);
  const cutIndex = turnStarts[totalTurns - effectiveTurns];
  const removed = messages.slice(cutIndex);
  entry.state.messages = messages.slice(0, cutIndex);
  // Accumulate so `unrevert` can undo a run of consecutive reverts in order.
  entry.revertedTail = [
    ...removed,
    ...(Array.isArray(entry.revertedTail) ? entry.revertedTail : []),
  ];

  const payload = {
    turns: effectiveTurns,
    removedCount: removed.length,
    totalTurns,
    remainingTurns: totalTurns - effectiveTurns,
    remainingMessages: entry.state.messages.length,
  };
  await appendSessionEvent(entry.state, 'session_reverted', payload);
  await rewriteMessagesLog(entry.state);
  broadcastEvent(sessionId, {
    v: PROTOCOL_VERSION,
    kind: 'event',
    sessionId,
    seq: entry.state.eventSeq,
    ts: Date.now(),
    type: 'session_reverted',
    payload,
  });

  return makeResponse(req.requestId, 'session_revert', sessionId, true, {
    reverted: true,
    ...payload,
    canUnrevert: true,
  });
}

/**
 * `session_unrevert` — restore the messages removed by the most recent run of
 * `session_revert`(s) (opencode's `session.unrevert`). Appends the stashed tail
 * back, persists, and clears the stash. NOTHING_TO_UNREVERT if no revert is
 * pending (e.g. a `send_user_message` already committed the fork). Bearer-gated;
 * rejected mid-run.
 */
async function handleSessionUnrevert(req) {
  const auth = await loadAndAuthSession(req, 'session_unrevert');
  if (auth.error) return auth.error;
  const { entry, sessionId } = auth;

  if (entry.activeRunId) {
    return makeErrorResponse(
      req.requestId,
      'session_unrevert',
      'RUN_IN_PROGRESS',
      `Cannot unrevert while run ${entry.activeRunId} is active`,
    );
  }

  const tail = Array.isArray(entry.revertedTail) ? entry.revertedTail : [];
  if (tail.length === 0) {
    return makeErrorResponse(
      req.requestId,
      'session_unrevert',
      'NOTHING_TO_UNREVERT',
      'No reverted messages to restore (a new message may have committed the fork)',
    );
  }

  // Await-free critical section (see the note in handleSessionRevert): the
  // read→restore→clear runs atomically before the first await below.
  const restoredCount = tail.length;
  const messages = Array.isArray(entry.state?.messages) ? entry.state.messages : [];
  entry.state.messages = [...messages, ...tail];
  entry.revertedTail = null;

  const payload = { restoredCount, totalMessages: entry.state.messages.length };
  await appendSessionEvent(entry.state, 'session_unreverted', payload);
  await rewriteMessagesLog(entry.state);
  broadcastEvent(sessionId, {
    v: PROTOCOL_VERSION,
    kind: 'event',
    sessionId,
    seq: entry.state.eventSeq,
    ts: Date.now(),
    type: 'session_unreverted',
    payload,
  });

  return makeResponse(req.requestId, 'session_unrevert', sessionId, true, {
    unreverted: true,
    ...payload,
  });
}

// ─── Delegate Explorer (scaffold + real lib-kernel integration) ─

/**
 * `delegate_explorer` — daemon-side Explorer launch.
 *
 * Wires the full delegate_explorer RPC path from handler → runExplorerAgent
 * (the Phase 5D step 1 lib kernel) → DelegationOutcome persistence. The
 * `streamFn` DI slot is a real daemon-side adapter (`createDaemonProviderStream`,
 * see cli/daemon-provider-stream.ts) that streams tokens through the existing
 * `cli/provider.ts#streamCompletion` helper. The `toolExec` slot remains stubbed
 * — stub detectors short-circuit it, so no tool is ever actually invoked.
 *
 * Provider / model resolution honors role routing: if
 * `entry.state.roleRouting.explorer` is set (via `configure_role_routing`),
 * that provider+model is used; otherwise the session-level defaults are.
 * The adapter itself stays provider-agnostic — all policy lives here.
 *
 * The capability flag is `delegation_explorer_v1`. `multi_agent` is also
 * advertised (see the CAPABILITIES list) — both prerequisites it once waited
 * on are shipped: this handler runs `makeDaemonExplorerToolExec` (real
 * `executeToolCall`) and `handleDelegateCoder` wires the second role.
 */
async function handleDelegateExplorer(req) {
  const sessionId = req.sessionId || req.payload?.sessionId;
  const providedToken = req.payload?.attachToken;
  const task = req.payload?.task;
  const allowedRepo = typeof req.payload?.allowedRepo === 'string' ? req.payload.allowedRepo : '';
  const parentRunIdPayload =
    typeof req.payload?.parentRunId === 'string' ? req.payload.parentRunId : null;

  if (!sessionId) {
    return makeErrorResponse(
      req.requestId,
      'delegate_explorer',
      'INVALID_REQUEST',
      'sessionId is required',
    );
  }

  if (!task || typeof task !== 'string' || !task.trim()) {
    return makeErrorResponse(
      req.requestId,
      'delegate_explorer',
      'INVALID_REQUEST',
      'task is required and must be a non-empty string',
    );
  }

  let entry = activeSessions.get(sessionId);
  if (!entry) {
    try {
      const state = await loadSessionState(sessionId);
      // Restore the persisted attach token from session state instead of
      // minting a fresh one. Without this, clients lose their token on any
      // handler that lazy-loads a session from disk (including after a
      // daemon crash + restart), because `validateAttachToken` would
      // compare the caller's original token against a freshly minted one.
      // Legacy sessions without a persisted token load with attachToken
      // undefined; they are claimed on first `attach_session` (bootstrap
      // grace). A non-attach handler reached before that claim now rejects —
      // the implicit tokenless bypass is gone (Universal Session Bearer).
      entry = { state, attachToken: state.attachToken };
      activeSessions.set(sessionId, entry);
    } catch {
      return makeErrorResponse(
        req.requestId,
        'delegate_explorer',
        'SESSION_NOT_FOUND',
        `Session not found: ${sessionId}`,
      );
    }
  }

  if (!validateAttachToken(entry, providedToken)) {
    return makeErrorResponse(
      req.requestId,
      'delegate_explorer',
      'INVALID_TOKEN',
      'Invalid or missing attach token',
    );
  }

  // Resolve provider/model with role-routing precedence. configure_role_routing
  // stores `state.roleRouting[role] = { provider, model }`; when present for
  // 'explorer' it overrides the session-level defaults for this delegation.
  const explorerRoute = entry.state.roleRouting?.explorer;
  const routedProvider = normalizeProviderInput(explorerRoute?.provider);
  if (routedProvider && !PROVIDER_CONFIGS[routedProvider]) {
    return makeErrorResponse(
      req.requestId,
      'delegate_explorer',
      'PROVIDER_NOT_CONFIGURED',
      `Unknown provider "${routedProvider}" for explorer role routing`,
    );
  }
  const sessionProvider = normalizeProviderInput(entry.state.provider);
  if (!routedProvider && (!sessionProvider || !PROVIDER_CONFIGS[sessionProvider])) {
    return makeErrorResponse(
      req.requestId,
      'delegate_explorer',
      'PROVIDER_NOT_CONFIGURED',
      `Unknown provider "${sessionProvider || '(missing)'}" in session state`,
    );
  }
  const resolvedProvider = routedProvider || sessionProvider;
  const resolvedModel =
    (typeof explorerRoute?.model === 'string' && explorerRoute.model.trim()) ||
    (typeof entry.state.model === 'string' && entry.state.model.trim()) ||
    PROVIDER_CONFIGS[resolvedProvider].defaultModel;

  ensureRuntimeState(entry);

  const subagentId = `sub_explorer_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
  const childRunId = makeRunId();
  const parentRunId = parentRunIdPayload || entry.activeRunId || null;
  const abortController = new AbortController();
  const startedAt = Date.now();
  const trimmedTask = task.trim();

  entry.activeDelegations.set(subagentId, {
    role: 'explorer',
    agent: 'explorer',
    parentRunId,
    childRunId,
    abortController,
    startedAt,
    task: trimmedTask,
  });

  const startEventPayload = {
    executionId: subagentId,
    subagentId,
    ...(parentRunId ? { parentRunId } : {}),
    childRunId,
    agent: 'explorer',
    role: 'explorer',
    detail: trimmedTask.slice(0, 280),
  };
  await appendSessionEvent(entry.state, 'subagent.started', startEventPayload, childRunId);
  await saveSessionState(entry.state);
  broadcastEvent(sessionId, {
    v: PROTOCOL_VERSION,
    kind: 'event',
    sessionId,
    runId: childRunId,
    seq: entry.state.eventSeq,
    ts: Date.now(),
    type: 'subagent.started',
    payload: startEventPayload,
  });

  const ack = makeResponse(req.requestId, 'delegate_explorer', sessionId, true, {
    subagentId,
    childRunId,
    accepted: true,
  });

  // Background run. The RPC has already acked. Events are broadcast as the
  // lib kernel progresses. Terminal ownership is claimed synchronously by
  // deleting the delegation entry before any awaited terminal-event work so
  // cancel_delegation wins whenever it removes the entry first.
  (async () => {
    const toolExec = makeDaemonExplorerToolExec({
      entry,
      signal: abortController.signal,
    });
    const evaluateAfterModel = async () => null;

    let outcome;
    let runError = null;
    try {
      const daemonStream = createDaemonProviderStream(resolvedProvider, sessionId);
      const nativeToolSchemas = cliProviderModelSupportsNativeToolCalling(
        resolvedProvider,
        resolvedModel,
      )
        ? getCliReadOnlyNativeToolSchemas()
        : undefined;
      const result = await runExplorerAgent(
        {
          provider: resolvedProvider,
          stream: daemonStream,
          modelId: resolvedModel,
          sandboxId: null,
          allowedRepo,
          userProfile: null,
          taskPreamble: trimmedTask,
          symbolSummary: null,
          toolExec,
          detectAllToolCalls: wrapCliDetectAllToolCalls,
          detectNativeToolCalls: wrapCliDetectNativeToolCalls,
          detectAnyToolCall: wrapCliDetectAnyToolCall,
          webSearchToolProtocol: '',
          // See `runExplorerForTaskGraph` above for why this matters:
          // the kernel's default `EXPLORER_TOOL_PROTOCOL` advertises
          // web-side public tool names (`read`, `repo_read`, `search`)
          // that the daemon's detector doesn't recognize. Overriding
          // with `READ_ONLY_TOOL_PROTOCOL` from `cli/tools.ts` makes
          // the model emit CLI tool names that match
          // `READ_ONLY_TOOLS` + `executeToolCall`'s dispatch table.
          sandboxToolProtocol: READ_ONLY_TOOL_PROTOCOL,
          nativeToolSchemas,
          evaluateAfterModel,
        },
        {
          onStatus: () => {
            // Quiet for now — later slices can emit agent_status events here.
          },
          signal: abortController.signal,
        },
      );

      outcome = {
        agent: 'explorer',
        status: result.hitRoundCap ? 'incomplete' : 'complete',
        summary: result.summary,
        evidence: [],
        checks: [],
        gateVerdicts: [],
        missingRequirements: [],
        nextRequiredAction: result.hitRoundCap
          ? 'Investigation hit round cap — re-explore with a narrower scope or proceed with partial findings'
          : null,
        rounds: result.rounds,
        checkpoints: 0,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (err) {
      runError = err;
      const isAbort =
        err &&
        ((err instanceof Error && err.name === 'AbortError') ||
          (typeof err?.message === 'string' && err.message.includes('cancelled')));
      const message = err instanceof Error ? err.message : String(err);
      outcome = {
        agent: 'explorer',
        status: 'inconclusive',
        summary: isAbort
          ? 'Explorer cancelled during daemon run.'
          : `Explorer failed during daemon run: ${message}`,
        evidence: [],
        checks: [],
        gateVerdicts: [],
        missingRequirements: [],
        nextRequiredAction: null,
        rounds: 0,
        checkpoints: 0,
        elapsedMs: Date.now() - startedAt,
      };
    }

    // Persist the outcome record even if cancel_delegation already emitted —
    // the session-state record must reflect what the scaffold run produced.
    if (!Array.isArray(entry.state.delegationOutcomes)) {
      entry.state.delegationOutcomes = [];
    }
    entry.state.delegationOutcomes.push({ subagentId, outcome });

    if (delegateExplorerTestHooks.beforeTerminalClaim) {
      await delegateExplorerTestHooks.beforeTerminalClaim({
        sessionId,
        subagentId,
        childRunId,
        outcome,
        runError,
      });
    }

    const activeDelegation = entry.activeDelegations?.get(subagentId);
    if (!activeDelegation) {
      // cancel_delegation already removed the entry and emitted subagent.failed.
      // Persist outcome only, no event emission to avoid duplicates.
      await saveSessionState(entry.state);
      if (delegateExplorerTestHooks.afterTerminalDecision) {
        await delegateExplorerTestHooks.afterTerminalDecision({
          sessionId,
          subagentId,
          childRunId,
          emittedTerminalEvent: false,
          terminalEventType: null,
        });
      }
      return;
    }
    entry.activeDelegations.delete(subagentId);

    if (runError) {
      const isAbort =
        (runError instanceof Error && runError.name === 'AbortError') ||
        (typeof runError?.message === 'string' && runError.message.includes('cancelled'));
      const message = runError instanceof Error ? runError.message : String(runError);
      const failPayload = {
        executionId: subagentId,
        subagentId,
        ...(parentRunId ? { parentRunId } : {}),
        childRunId,
        agent: 'explorer',
        role: 'explorer',
        error: message,
        errorDetails: {
          code: isAbort ? 'CANCELLED' : 'EXPLORER_FAILED',
          message,
          retryable: false,
        },
      };
      await appendSessionEvent(entry.state, 'subagent.failed', failPayload, childRunId);
      await saveSessionState(entry.state);
      broadcastEvent(sessionId, {
        v: PROTOCOL_VERSION,
        kind: 'event',
        sessionId,
        runId: childRunId,
        seq: entry.state.eventSeq,
        ts: Date.now(),
        type: 'subagent.failed',
        payload: failPayload,
      });
    } else {
      const completePayload = {
        executionId: subagentId,
        subagentId,
        ...(parentRunId ? { parentRunId } : {}),
        childRunId,
        agent: 'explorer',
        role: 'explorer',
        summary: outcome.summary.slice(0, 280),
        delegationOutcome: outcome,
      };
      await appendSessionEvent(entry.state, 'subagent.completed', completePayload, childRunId);
      await saveSessionState(entry.state);
      broadcastEvent(sessionId, {
        v: PROTOCOL_VERSION,
        kind: 'event',
        sessionId,
        runId: childRunId,
        seq: entry.state.eventSeq,
        ts: Date.now(),
        type: 'subagent.completed',
        payload: completePayload,
      });
    }
    if (delegateExplorerTestHooks.afterTerminalDecision) {
      await delegateExplorerTestHooks.afterTerminalDecision({
        sessionId,
        subagentId,
        childRunId,
        emittedTerminalEvent: true,
        terminalEventType: runError ? 'subagent.failed' : 'subagent.completed',
      });
    }
  })();

  return ack;
}

// ─── Delegate Coder (scaffold + real lib-kernel integration) ───

/**
 * `delegate_coder` — daemon-side Coder launch.
 *
 * Resolves role routing, validates input, mints ids, emits
 * `subagent.started`, acks the RPC, and runs the lib Coder kernel in the
 * background. The kernel consumes `makeDaemonCoderToolExec` (a real
 * `executeToolCall`-backed tool executor from `cli/tools.ts`) and
 * `wrapCliDetect*` (the production detectors from `cli/tools.ts`). LLM
 * streams real tokens via `createDaemonProviderStream`; tool calls the
 * model emits are parsed, classified into read-only / mutating by
 * `READ_ONLY_TOOLS`, and executed against `entry.state.cwd` with
 * approval gating routed through `buildApprovalFn` on `childRunId`. This
 * is the full-fat daemon Coder path — no scaffolding, no stubs.
 *
 * Why a separate handler from `delegate_explorer` when the shapes are so
 * similar: the explorer kernel's option interface is narrower (no
 * `sandboxToolProtocol`, no approval/verification policy slots), and
 * the coder kernel's `CoderToolExecResult` discriminated union has its
 * own shape rules (`errorType` feeds the mutation-failure tracker,
 * `policyPost` drives the kernel's halt guard). Explorer is also fully
 * wired (`makeDaemonExplorerToolExec` → real `executeToolCall`); the two
 * handlers stay separate for the option-shape reasons above, not because
 * either is still a stub.
 *
 * Provider / model resolution honours `entry.state.roleRouting.coder` —
 * set via `configure_role_routing` — and falls back to session defaults
 * otherwise. The resolved values feed both the daemon stream adapter and
 * the `modelId` option on the kernel.
 *
 * Capability flag: `delegation_coder_v1`. `multi_agent` is advertised too —
 * both executors (Explorer + Coder) are real and the v1 synthetic downgrade
 * path ships in `cli/v1-downgrade.ts`, so nothing here still blocks it.
 */
async function handleDelegateCoder(req) {
  const sessionId = req.sessionId || req.payload?.sessionId;
  const providedToken = req.payload?.attachToken;
  const task = req.payload?.task;
  const allowedRepo = typeof req.payload?.allowedRepo === 'string' ? req.payload.allowedRepo : '';
  const parentRunIdPayload =
    typeof req.payload?.parentRunId === 'string' ? req.payload.parentRunId : null;

  if (!sessionId) {
    return makeErrorResponse(
      req.requestId,
      'delegate_coder',
      'INVALID_REQUEST',
      'sessionId is required',
    );
  }

  if (!task || typeof task !== 'string' || !task.trim()) {
    return makeErrorResponse(
      req.requestId,
      'delegate_coder',
      'INVALID_REQUEST',
      'task is required and must be a non-empty string',
    );
  }

  let entry = activeSessions.get(sessionId);
  if (!entry) {
    try {
      const state = await loadSessionState(sessionId);
      entry = { state, attachToken: state.attachToken };
      activeSessions.set(sessionId, entry);
    } catch {
      return makeErrorResponse(
        req.requestId,
        'delegate_coder',
        'SESSION_NOT_FOUND',
        `Session not found: ${sessionId}`,
      );
    }
  }

  if (!validateAttachToken(entry, providedToken)) {
    return makeErrorResponse(
      req.requestId,
      'delegate_coder',
      'INVALID_TOKEN',
      'Invalid or missing attach token',
    );
  }

  // Resolve provider/model with role-routing precedence for the coder role.
  // Mirrors the explorer block; we inline rather than delegate to
  // `resolveRoleRouting()` (used by the task-graph scaffold path) so we can
  // produce structured `PROVIDER_NOT_CONFIGURED` errors before any state
  // mutation or subagent.started event — same contract as explorer.
  const coderRoute = entry.state.roleRouting?.coder;
  const routedProvider = normalizeProviderInput(coderRoute?.provider);
  if (routedProvider && !PROVIDER_CONFIGS[routedProvider]) {
    return makeErrorResponse(
      req.requestId,
      'delegate_coder',
      'PROVIDER_NOT_CONFIGURED',
      `Unknown provider "${routedProvider}" for coder role routing`,
    );
  }
  const sessionProvider = normalizeProviderInput(entry.state.provider);
  if (!routedProvider && (!sessionProvider || !PROVIDER_CONFIGS[sessionProvider])) {
    return makeErrorResponse(
      req.requestId,
      'delegate_coder',
      'PROVIDER_NOT_CONFIGURED',
      `Unknown provider "${sessionProvider || '(missing)'}" in session state`,
    );
  }
  const resolvedProvider = routedProvider || sessionProvider;
  const resolvedModel =
    (typeof coderRoute?.model === 'string' && coderRoute.model.trim()) ||
    (typeof entry.state.model === 'string' && entry.state.model.trim()) ||
    PROVIDER_CONFIGS[resolvedProvider].defaultModel;

  ensureRuntimeState(entry);

  const subagentId = `sub_coder_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
  const childRunId = makeRunId();
  const parentRunId = parentRunIdPayload || entry.activeRunId || null;
  const abortController = new AbortController();
  const startedAt = Date.now();
  const trimmedTask = task.trim();

  entry.activeDelegations.set(subagentId, {
    role: 'coder',
    agent: 'coder',
    parentRunId,
    childRunId,
    abortController,
    startedAt,
    task: trimmedTask,
  });

  const startEventPayload = {
    executionId: subagentId,
    subagentId,
    ...(parentRunId ? { parentRunId } : {}),
    childRunId,
    agent: 'coder',
    role: 'coder',
    detail: trimmedTask.slice(0, 280),
  };
  await appendSessionEvent(entry.state, 'subagent.started', startEventPayload, childRunId);
  await saveSessionState(entry.state);
  broadcastEvent(sessionId, {
    v: PROTOCOL_VERSION,
    kind: 'event',
    sessionId,
    runId: childRunId,
    seq: entry.state.eventSeq,
    ts: Date.now(),
    type: 'subagent.started',
    payload: startEventPayload,
  });

  const ack = makeResponse(req.requestId, 'delegate_coder', sessionId, true, {
    subagentId,
    childRunId,
    accepted: true,
  });

  // Background run — identical lifecycle to handleDelegateExplorer: the
  // RPC has already acked, the lib kernel streams real tokens through the
  // daemon provider adapter, and terminal ownership is claimed synchronously
  // by deleting the delegation registry entry BEFORE any awaited terminal
  // event so `cancel_delegation` wins whenever it removes the entry first.
  (async () => {
    // Real daemon tool executor + real CLI detectors. Replaces the
    // scaffold stubs that returned `{ kind: 'denied', reason: 'not yet wired' }`.
    // Tool calls now actually read/write files and run shell commands
    // under approval gating — high-risk exec commands emit an
    // `approval_required` event on `childRunId` and block on a
    // `submit_approval` RPC via `buildApprovalFn` (baked into the
    // executor closure itself).
    const toolExec = makeDaemonCoderToolExec({
      sessionId,
      entry,
      runId: childRunId,
      signal: abortController.signal,
    });
    const evaluateAfterModel = async () => null;

    let outcome;
    let runError = null;
    try {
      const daemonStream = createDaemonProviderStream(resolvedProvider, sessionId);
      const nativeToolSchemas = cliProviderModelSupportsNativeToolCalling(
        resolvedProvider,
        resolvedModel,
      )
        ? getCliNativeToolSchemas()
        : undefined;
      const result = await runCoderAgent(
        {
          provider: resolvedProvider,
          stream: daemonStream,
          modelId: resolvedModel,
          // Daemon delegated child Coder run, not the lead.
          persona: 'coder',
          sandboxId: '',
          allowedRepo,
          userProfile: null,
          taskPreamble: trimmedTask,
          symbolSummary: null,
          toolExec,
          detectAllToolCalls: wrapCliDetectAllToolCalls,
          detectNativeToolCalls: wrapCliDetectNativeToolCalls,
          detectAnyToolCall: wrapCliDetectAnyToolCall,
          webSearchToolProtocol: '',
          // `sandboxToolProtocol` is the tool-instruction block the kernel
          // splices into its system prompt — without it the model has no
          // guidance on what tool-call JSON to emit (codex P1 on PR #282).
          // Feed in `TOOL_PROTOCOL` from `cli/tools.ts`, the same block the
          // non-delegated CLI engine uses.
          sandboxToolProtocol: TOOL_PROTOCOL,
          nativeToolSchemas,
          verificationPolicyBlock: null,
          approvalModeBlock: null,
          evaluateAfterModel,
          // Per-run token budget for this daemon delegated Coder. Resolved from
          // env (config forwarded to `PUSH_RUN_TOKEN_BUDGET` by
          // `applyConfigToEnv`); null (uncapped) maps to undefined.
          harnessTokenBudget:
            resolveRunTokenBudget({ env: process.env[RUN_TOKEN_BUDGET_ENV_VAR] }) ?? undefined,
        },
        {
          onStatus: () => {
            // Quiet for now — later slices can emit agent_status events here.
          },
          signal: abortController.signal,
          onRunEvent: emitRoleAgentRunEvent(sessionId, entry, childRunId ?? null),
        },
      );

      outcome = {
        agent: 'coder',
        // Kernel returned cleanly — default to 'complete'. Deeper
        // classification (incomplete on unfinished acceptance criteria,
        // inconclusive on policy halts) is a follow-up that inspects
        // working memory + criteriaResults. For now, structural success
        // (no thrown error) lands as 'complete'.
        status: 'complete',
        summary: result.summary,
        evidence: [],
        checks: [],
        gateVerdicts: [],
        missingRequirements: [],
        nextRequiredAction: null,
        rounds: result.rounds,
        checkpoints: result.checkpoints,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (err) {
      runError = err;
      const isAbort =
        err &&
        ((err instanceof Error && err.name === 'AbortError') ||
          (typeof err?.message === 'string' && err.message.includes('cancelled')));
      const message = err instanceof Error ? err.message : String(err);
      outcome = {
        agent: 'coder',
        status: 'inconclusive',
        summary: isAbort
          ? 'Coder cancelled during daemon run.'
          : `Coder failed during daemon run: ${message}`,
        evidence: [],
        checks: [],
        gateVerdicts: [],
        missingRequirements: [],
        nextRequiredAction: null,
        rounds: 0,
        checkpoints: 0,
        elapsedMs: Date.now() - startedAt,
      };
    }

    if (!Array.isArray(entry.state.delegationOutcomes)) {
      entry.state.delegationOutcomes = [];
    }
    entry.state.delegationOutcomes.push({ subagentId, outcome });

    const activeDelegation = entry.activeDelegations?.get(subagentId);
    if (!activeDelegation) {
      // cancel_delegation already removed the entry and emitted subagent.failed.
      // Persist outcome only, no event emission to avoid duplicates.
      await saveSessionState(entry.state);
      return;
    }
    entry.activeDelegations.delete(subagentId);

    if (runError) {
      const isAbort =
        (runError instanceof Error && runError.name === 'AbortError') ||
        (typeof runError?.message === 'string' && runError.message.includes('cancelled'));
      const message = runError instanceof Error ? runError.message : String(runError);
      const failPayload = {
        executionId: subagentId,
        subagentId,
        ...(parentRunId ? { parentRunId } : {}),
        childRunId,
        agent: 'coder',
        role: 'coder',
        error: message,
        errorDetails: {
          code: isAbort ? 'CANCELLED' : 'CODER_FAILED',
          message,
          retryable: false,
        },
      };
      await appendSessionEvent(entry.state, 'subagent.failed', failPayload, childRunId);
      await saveSessionState(entry.state);
      broadcastEvent(sessionId, {
        v: PROTOCOL_VERSION,
        kind: 'event',
        sessionId,
        runId: childRunId,
        seq: entry.state.eventSeq,
        ts: Date.now(),
        type: 'subagent.failed',
        payload: failPayload,
      });
    } else {
      const completePayload = {
        executionId: subagentId,
        subagentId,
        ...(parentRunId ? { parentRunId } : {}),
        childRunId,
        agent: 'coder',
        role: 'coder',
        summary: outcome.summary.slice(0, 280),
        delegationOutcome: outcome,
      };
      await appendSessionEvent(entry.state, 'subagent.completed', completePayload, childRunId);
      await saveSessionState(entry.state);
      broadcastEvent(sessionId, {
        v: PROTOCOL_VERSION,
        kind: 'event',
        sessionId,
        runId: childRunId,
        seq: entry.state.eventSeq,
        ts: Date.now(),
        type: 'subagent.completed',
        payload: completePayload,
      });
    }
  })();

  return ack;
}

// ─── Delegate Reviewer (advisory diff review, single-turn) ──────

// Byte ceiling for the bounded REVIEW.md read below. Comfortably exceeds the
// downstream char cap in role-context (8000) and ~600 lines of guidance, while
// bounding memory so a pathological REVIEW.md can't be materialized whole.
const REVIEW_GUIDANCE_MAX_BYTES = 64 * 1024;

/**
 * Read the working-copy REVIEW.md from a daemon workspace, byte- and line-capped.
 * The daemon reviews the local checkout, so the working copy (including unpushed
 * edits) is the authoritative guidance. Returns null when the file is absent so
 * `resolveReviewGuidance` treats it as "no guidance" rather than a read failure;
 * a genuine read error (permissions, etc.) rethrows so the resolver logs it.
 *
 * Reads at most `REVIEW_GUIDANCE_MAX_BYTES` via a bounded file-handle read rather
 * than `fs.readFile`, so the cap actually bounds memory instead of slicing a
 * fully-materialized file after the fact.
 */
async function readWorkspaceReviewGuidance(cwd) {
  let handle;
  try {
    handle = await fs.open(path.join(cwd, REVIEW_GUIDANCE_FILENAME), 'r');
    const buffer = Buffer.alloc(REVIEW_GUIDANCE_MAX_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, REVIEW_GUIDANCE_MAX_BYTES, 0);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    return capReviewGuidanceLines(text);
  } catch (err) {
    if (err && typeof err === 'object' && err.code === 'ENOENT') return null;
    throw err;
  } finally {
    await handle?.close();
  }
}

/**
 * `delegate_reviewer` — daemon-side Reviewer launch.
 *
 * Wires the full delegate_reviewer RPC path from handler → runReviewer
 * (the Phase 5D reviewer lib kernel) → ReviewResult persistence. Unlike
 * Explorer, the Reviewer is single-turn and read-only — it streams JSON
 * once, parses it into a ReviewResult, and returns. No tool loop, no
 * stub detectors, no DelegationOutcome envelope: the review payload has
 * its own schema (`filesReviewed` / `totalFiles` / `truncated` / `comments`)
 * that would be lossy in the gate-shaped DelegationOutcome contract.
 *
 * The streamFn adapter is wrapped in a signal-forwarding closure so the
 * handler's AbortController still reaches the underlying fetch even though
 * `runReviewer` itself doesn't accept an AbortSignal in its options.
 *
 * Provider / model resolution honors `roleRouting.reviewer`; otherwise
 * it falls back to session-level defaults.
 *
 * Capability flag: `delegation_reviewer_v1`.
 */
async function handleDelegateReviewer(req) {
  const sessionId = req.sessionId || req.payload?.sessionId;
  const providedToken = req.payload?.attachToken;
  const diff = typeof req.payload?.diff === 'string' ? req.payload.diff : '';
  const parentRunIdPayload =
    typeof req.payload?.parentRunId === 'string' ? req.payload.parentRunId : null;
  const rawContext =
    req.payload?.context && typeof req.payload.context === 'object'
      ? req.payload.context
      : undefined;

  if (!sessionId) {
    return makeErrorResponse(
      req.requestId,
      'delegate_reviewer',
      'INVALID_REQUEST',
      'sessionId is required',
    );
  }

  if (!diff || typeof diff !== 'string' || !diff.trim()) {
    return makeErrorResponse(
      req.requestId,
      'delegate_reviewer',
      'INVALID_REQUEST',
      'diff is required and must be a non-empty string',
    );
  }

  let entry = activeSessions.get(sessionId);
  if (!entry) {
    try {
      const state = await loadSessionState(sessionId);
      // Restore the persisted attach token from session state instead of
      // minting a fresh one. Without this, clients lose their token on any
      // handler that lazy-loads a session from disk (including after a
      // daemon crash + restart), because `validateAttachToken` would
      // compare the caller's original token against a freshly minted one.
      // Legacy sessions without a persisted token load with attachToken
      // undefined; they are claimed on first `attach_session` (bootstrap
      // grace). A non-attach handler reached before that claim now rejects —
      // the implicit tokenless bypass is gone (Universal Session Bearer).
      entry = { state, attachToken: state.attachToken };
      activeSessions.set(sessionId, entry);
    } catch {
      return makeErrorResponse(
        req.requestId,
        'delegate_reviewer',
        'SESSION_NOT_FOUND',
        `Session not found: ${sessionId}`,
      );
    }
  }

  if (!validateAttachToken(entry, providedToken)) {
    return makeErrorResponse(
      req.requestId,
      'delegate_reviewer',
      'INVALID_TOKEN',
      'Invalid or missing attach token',
    );
  }

  const reviewerRoute = entry.state.roleRouting?.reviewer;
  const routedProvider = normalizeProviderInput(reviewerRoute?.provider);
  if (routedProvider && !PROVIDER_CONFIGS[routedProvider]) {
    return makeErrorResponse(
      req.requestId,
      'delegate_reviewer',
      'PROVIDER_NOT_CONFIGURED',
      `Unknown provider "${routedProvider}" for reviewer role routing`,
    );
  }
  const sessionProvider = normalizeProviderInput(entry.state.provider);
  if (!routedProvider && (!sessionProvider || !PROVIDER_CONFIGS[sessionProvider])) {
    return makeErrorResponse(
      req.requestId,
      'delegate_reviewer',
      'PROVIDER_NOT_CONFIGURED',
      `Unknown provider "${sessionProvider || '(missing)'}" in session state`,
    );
  }
  const resolvedProvider = routedProvider || sessionProvider;
  const resolvedModel =
    (typeof reviewerRoute?.model === 'string' && reviewerRoute.model.trim()) ||
    (typeof entry.state.model === 'string' && entry.state.model.trim()) ||
    PROVIDER_CONFIGS[resolvedProvider].defaultModel;

  ensureRuntimeState(entry);

  const subagentId = `sub_reviewer_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
  const childRunId = makeRunId();
  const parentRunId = parentRunIdPayload || entry.activeRunId || null;
  const abortController = new AbortController();
  const startedAt = Date.now();

  entry.activeDelegations.set(subagentId, {
    role: 'reviewer',
    agent: 'reviewer',
    parentRunId,
    childRunId,
    abortController,
    startedAt,
    task: 'review-diff',
  });

  const detail = `review diff (${diff.length} chars)`;
  const startEventPayload = {
    executionId: subagentId,
    subagentId,
    ...(parentRunId ? { parentRunId } : {}),
    childRunId,
    agent: 'reviewer',
    role: 'reviewer',
    detail,
  };
  await appendSessionEvent(entry.state, 'subagent.started', startEventPayload, childRunId);
  await saveSessionState(entry.state);
  broadcastEvent(sessionId, {
    v: PROTOCOL_VERSION,
    kind: 'event',
    sessionId,
    runId: childRunId,
    seq: entry.state.eventSeq,
    ts: Date.now(),
    type: 'subagent.started',
    payload: startEventPayload,
  });

  const ack = makeResponse(req.requestId, 'delegate_reviewer', sessionId, true, {
    subagentId,
    childRunId,
    accepted: true,
  });

  (async () => {
    let reviewResult = null;
    let runError = null;
    try {
      const baseStream = createDaemonProviderStream(resolvedProvider, sessionId);
      // The lib reviewer's `iteratePushStreamText` only owns its own activity
      // controller. Compose `abortController.signal` with the consumer's
      // per-stream signal so cancel_delegation aborts the upstream call.
      const signalAwareStream = (req) =>
        baseStream({
          ...req,
          signal: req.signal
            ? AbortSignal.any([req.signal, abortController.signal])
            : abortController.signal,
        });

      // Default-on REVIEW.md: an explicit caller-supplied `reviewGuidance` wins
      // (the RPC client knows the review ref); otherwise resolve the daemon
      // workspace's working-copy REVIEW.md so the CLI Reviewer gets the same
      // repo-specific guidance the web Reviewer already does.
      const callerGuidance =
        rawContext && typeof rawContext.reviewGuidance === 'string'
          ? rawContext.reviewGuidance
          : null;
      const reviewGuidance =
        callerGuidance ??
        (await resolveReviewGuidance({
          readWorkingCopy: () => readWorkspaceReviewGuidance(entry.state.cwd),
        }));
      const reviewerContext = reviewGuidance
        ? { ...(rawContext ?? {}), reviewGuidance }
        : rawContext;

      reviewResult = await runReviewer(
        diff,
        {
          provider: resolvedProvider,
          stream: signalAwareStream,
          modelId: resolvedModel,
          context: reviewerContext,
          resolveRuntimeContext: async (_diff, context) => buildReviewerContextBlock(context) || '',
        },
        () => {
          // Quiet for now — later slices can emit agent_status events here.
        },
      );
    } catch (err) {
      runError = err;
    }

    // Persist review result even if cancel_delegation already claimed the entry.
    if (reviewResult) {
      if (!Array.isArray(entry.state.reviewOutcomes)) {
        entry.state.reviewOutcomes = [];
      }
      entry.state.reviewOutcomes.push({ subagentId, result: reviewResult });
    }

    const activeDelegation = entry.activeDelegations?.get(subagentId);
    if (!activeDelegation) {
      // cancel_delegation already removed the entry and emitted subagent.failed.
      // Persist outcome only, no event emission.
      await saveSessionState(entry.state);
      return;
    }
    entry.activeDelegations.delete(subagentId);

    if (runError || !reviewResult) {
      const err = runError;
      const isAbort =
        err &&
        ((err instanceof Error && err.name === 'AbortError') ||
          (typeof err?.message === 'string' && err.message.includes('cancelled')));
      const message = err instanceof Error ? err.message : String(err ?? 'unknown reviewer error');
      const failPayload = {
        executionId: subagentId,
        subagentId,
        ...(parentRunId ? { parentRunId } : {}),
        childRunId,
        agent: 'reviewer',
        role: 'reviewer',
        error: message,
        errorDetails: {
          code: isAbort ? 'CANCELLED' : 'REVIEWER_FAILED',
          message,
          retryable: false,
        },
      };
      await appendSessionEvent(entry.state, 'subagent.failed', failPayload, childRunId);
      await saveSessionState(entry.state);
      broadcastEvent(sessionId, {
        v: PROTOCOL_VERSION,
        kind: 'event',
        sessionId,
        runId: childRunId,
        seq: entry.state.eventSeq,
        ts: Date.now(),
        type: 'subagent.failed',
        payload: failPayload,
      });
    } else {
      const summary = typeof reviewResult.summary === 'string' ? reviewResult.summary : '';
      const completePayload = {
        executionId: subagentId,
        subagentId,
        ...(parentRunId ? { parentRunId } : {}),
        childRunId,
        agent: 'reviewer',
        role: 'reviewer',
        summary: summary.slice(0, 280),
        reviewResult,
      };
      await appendSessionEvent(entry.state, 'subagent.completed', completePayload, childRunId);
      await saveSessionState(entry.state);
      broadcastEvent(sessionId, {
        v: PROTOCOL_VERSION,
        kind: 'event',
        sessionId,
        runId: childRunId,
        seq: entry.state.eventSeq,
        ts: Date.now(),
        type: 'subagent.completed',
        payload: completePayload,
      });
    }
  })();

  return ack;
}

/**
 * `delegate_deep_reviewer` — daemon-side Deep Reviewer launch.
 *
 * Same RPC/persistence/event shape as `handleDelegateReviewer`, but routes
 * through the multi-round investigation kernel (`runDeepReviewer`) instead of
 * the single-shot `runReviewer`. The deep reviewer reads surrounding code,
 * callers, and tests via a read-only tool loop before forming its opinion,
 * then returns the same `ReviewResult`.
 *
 * Tool loop wiring (the only structural difference from the simple reviewer):
 *   - `toolExec: makeDaemonExplorerToolExec({ role: 'reviewer' })` — the same
 *     read-only CLI-native executor the Explorer uses, gated on the reviewer
 *     role (which grants repo:read / pr:read / web:search — exactly the
 *     read-only surface).
 *   - `detectAllToolCalls` / `detectAnyToolCall: wrapCliDetect*` — the CLI
 *     detectors that produce the `DetectedToolCalls` shape the kernel expects.
 *   - `sandboxToolProtocol: READ_ONLY_TOOL_PROTOCOL` — overrides the kernel's
 *     built-in web-public-name tool block with the CLI-native names the
 *     detector + executor actually recognize. Without this the model would
 *     emit `repo_read` / `search` and the CLI detector would drop them, wasting
 *     rounds (the Explorer P1 from PR #284, avoided by construction here).
 *
 * Provider / model resolution honors `roleRouting.reviewer` (shared with the
 * simple reviewer); results persist to `reviewOutcomes` and surface through the
 * same `subagent.*` lifecycle, tagged `agent: 'deep_reviewer'`.
 *
 * Capability flag: `delegation_deep_reviewer_v1`.
 */
async function handleDelegateDeepReviewer(req) {
  const sessionId = req.sessionId || req.payload?.sessionId;
  const providedToken = req.payload?.attachToken;
  const diff = typeof req.payload?.diff === 'string' ? req.payload.diff : '';
  const parentRunIdPayload =
    typeof req.payload?.parentRunId === 'string' ? req.payload.parentRunId : null;
  const rawContext =
    req.payload?.context && typeof req.payload.context === 'object'
      ? req.payload.context
      : undefined;

  if (!sessionId) {
    return makeErrorResponse(
      req.requestId,
      'delegate_deep_reviewer',
      'INVALID_REQUEST',
      'sessionId is required',
    );
  }

  if (!diff || typeof diff !== 'string' || !diff.trim()) {
    return makeErrorResponse(
      req.requestId,
      'delegate_deep_reviewer',
      'INVALID_REQUEST',
      'diff is required and must be a non-empty string',
    );
  }

  let entry = activeSessions.get(sessionId);
  if (!entry) {
    try {
      const state = await loadSessionState(sessionId);
      entry = { state, attachToken: state.attachToken };
      activeSessions.set(sessionId, entry);
    } catch {
      return makeErrorResponse(
        req.requestId,
        'delegate_deep_reviewer',
        'SESSION_NOT_FOUND',
        `Session not found: ${sessionId}`,
      );
    }
  }

  if (!validateAttachToken(entry, providedToken)) {
    return makeErrorResponse(
      req.requestId,
      'delegate_deep_reviewer',
      'INVALID_TOKEN',
      'Invalid or missing attach token',
    );
  }

  // Provider/model routing — shared with the simple reviewer (roleRouting.reviewer).
  const reviewerRoute = entry.state.roleRouting?.reviewer;
  const routedProvider = normalizeProviderInput(reviewerRoute?.provider);
  if (routedProvider && !PROVIDER_CONFIGS[routedProvider]) {
    return makeErrorResponse(
      req.requestId,
      'delegate_deep_reviewer',
      'PROVIDER_NOT_CONFIGURED',
      `Unknown provider "${routedProvider}" for reviewer role routing`,
    );
  }
  const sessionProvider = normalizeProviderInput(entry.state.provider);
  if (!routedProvider && (!sessionProvider || !PROVIDER_CONFIGS[sessionProvider])) {
    return makeErrorResponse(
      req.requestId,
      'delegate_deep_reviewer',
      'PROVIDER_NOT_CONFIGURED',
      `Unknown provider "${sessionProvider || '(missing)'}" in session state`,
    );
  }
  const resolvedProvider = routedProvider || sessionProvider;
  const resolvedModel =
    (typeof reviewerRoute?.model === 'string' && reviewerRoute.model.trim()) ||
    (typeof entry.state.model === 'string' && entry.state.model.trim()) ||
    PROVIDER_CONFIGS[resolvedProvider].defaultModel;

  ensureRuntimeState(entry);

  const subagentId = `sub_deepreviewer_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
  const childRunId = makeRunId();
  const parentRunId = parentRunIdPayload || entry.activeRunId || null;
  const abortController = new AbortController();
  const startedAt = Date.now();

  entry.activeDelegations.set(subagentId, {
    role: 'reviewer',
    agent: 'deep_reviewer',
    parentRunId,
    childRunId,
    abortController,
    startedAt,
    task: 'deep-review-diff',
  });

  const detail = `deep review diff (${diff.length} chars)`;
  const startEventPayload = {
    executionId: subagentId,
    subagentId,
    ...(parentRunId ? { parentRunId } : {}),
    childRunId,
    agent: 'deep_reviewer',
    role: 'reviewer',
    detail,
  };
  await appendSessionEvent(entry.state, 'subagent.started', startEventPayload, childRunId);
  await saveSessionState(entry.state);
  broadcastEvent(sessionId, {
    v: PROTOCOL_VERSION,
    kind: 'event',
    sessionId,
    runId: childRunId,
    seq: entry.state.eventSeq,
    ts: Date.now(),
    type: 'subagent.started',
    payload: startEventPayload,
  });

  const ack = makeResponse(req.requestId, 'delegate_deep_reviewer', sessionId, true, {
    subagentId,
    childRunId,
    accepted: true,
  });

  (async () => {
    let reviewResult = null;
    let runError = null;
    try {
      const baseStream = createDaemonProviderStream(resolvedProvider, sessionId);
      const signalAwareStream = (req) =>
        baseStream({
          ...req,
          signal: req.signal
            ? AbortSignal.any([req.signal, abortController.signal])
            : abortController.signal,
        });

      const callerGuidance =
        rawContext && typeof rawContext.reviewGuidance === 'string'
          ? rawContext.reviewGuidance
          : null;
      const reviewGuidance =
        callerGuidance ??
        (await resolveReviewGuidance({
          readWorkingCopy: () => readWorkspaceReviewGuidance(entry.state.cwd),
        }));
      const reviewerContext = reviewGuidance
        ? { ...(rawContext ?? {}), reviewGuidance }
        : rawContext;

      // Read-only CLI-native tool loop, gated on the reviewer role.
      const toolExec = makeDaemonExplorerToolExec({
        entry,
        signal: abortController.signal,
        role: 'reviewer',
      });

      reviewResult = await runDeepReviewer(
        diff,
        {
          provider: resolvedProvider,
          stream: signalAwareStream,
          modelId: resolvedModel,
          context: reviewerContext,
          resolveRuntimeContext: async (_diff, context) => buildReviewerContextBlock(context) || '',
          // The daemon investigates the LOCAL working tree, not a cloud
          // sandbox. We still pass a truthy sandboxId (the workspace path) so
          // the kernel does NOT inject its "No sandbox available — use GitHub
          // tools instead" guidance: that guidance is wrong here because (a)
          // our sandboxToolProtocol override advertises the local read tools
          // (read_file / search_files / …) the executor actually runs, and
          // (b) no GitHub tools are wired on this path. Without a truthy id the
          // model would be steered away from the only tools it has (Codex P2).
          // `sandboxId` is informational in the kernel (prompt guidance +
          // hasSandbox flag) — it's never used as a real sandbox handle; all
          // tool calls route through `toolExec` above.
          sandboxId: entry.state.cwd || 'local',
          allowedRepo: '',
          userProfile: null,
          toolExec,
          detectAllToolCalls: wrapCliDetectAllToolCalls,
          detectNativeToolCalls: wrapCliDetectNativeToolCalls,
          detectAnyToolCall: wrapCliDetectAnyToolCall,
          // Advertise the CLI-native read-only tool names (matches the
          // detector + executor); see the handler doc above. The block already
          // lists web_search, so the separate webSearchToolProtocol is unused.
          sandboxToolProtocol: READ_ONLY_TOOL_PROTOCOL,
          webSearchToolProtocol: '',
        },
        {
          onStatus: () => {
            // Quiet for now — later slices can emit agent_status events.
          },
          signal: abortController.signal,
        },
      );
    } catch (err) {
      runError = err;
    }

    if (reviewResult) {
      if (!Array.isArray(entry.state.reviewOutcomes)) {
        entry.state.reviewOutcomes = [];
      }
      entry.state.reviewOutcomes.push({ subagentId, result: reviewResult });
    }

    const activeDelegation = entry.activeDelegations?.get(subagentId);
    if (!activeDelegation) {
      await saveSessionState(entry.state);
      return;
    }
    entry.activeDelegations.delete(subagentId);

    if (runError || !reviewResult) {
      const err = runError;
      const isAbort =
        err &&
        ((err instanceof Error && err.name === 'AbortError') ||
          (typeof err?.message === 'string' && err.message.includes('cancelled')));
      const message =
        err instanceof Error ? err.message : String(err ?? 'unknown deep reviewer error');
      const failPayload = {
        executionId: subagentId,
        subagentId,
        ...(parentRunId ? { parentRunId } : {}),
        childRunId,
        agent: 'deep_reviewer',
        role: 'reviewer',
        error: message,
        errorDetails: {
          code: isAbort ? 'CANCELLED' : 'REVIEWER_FAILED',
          message,
          retryable: false,
        },
      };
      await appendSessionEvent(entry.state, 'subagent.failed', failPayload, childRunId);
      await saveSessionState(entry.state);
      broadcastEvent(sessionId, {
        v: PROTOCOL_VERSION,
        kind: 'event',
        sessionId,
        runId: childRunId,
        seq: entry.state.eventSeq,
        ts: Date.now(),
        type: 'subagent.failed',
        payload: failPayload,
      });
    } else {
      const summary = typeof reviewResult.summary === 'string' ? reviewResult.summary : '';
      const completePayload = {
        executionId: subagentId,
        subagentId,
        ...(parentRunId ? { parentRunId } : {}),
        childRunId,
        agent: 'deep_reviewer',
        role: 'reviewer',
        summary: summary.slice(0, 280),
        reviewResult,
      };
      await appendSessionEvent(entry.state, 'subagent.completed', completePayload, childRunId);
      await saveSessionState(entry.state);
      broadcastEvent(sessionId, {
        v: PROTOCOL_VERSION,
        kind: 'event',
        sessionId,
        runId: childRunId,
        seq: entry.state.eventSeq,
        ts: Date.now(),
        type: 'subagent.completed',
        payload: completePayload,
      });
    }
  })();

  return ack;
}

// ─── Remote-sessions handlers (web app drives daemon over WS) ────
//
// These are reachable via the WS transport added in PR #507 and used
// by the web's LocalDaemonSandboxClient (PR 3c.1). They mirror the
// shape of the cloud sandbox's `/api/sandbox/*` endpoints so a single
// web-side dispatcher can fork on session binding without translating
// payloads. Unix-socket clients (legacy CLI) can call sandbox_exec
// directly too, but daemon_identify is WS-only (its response surface
// is the authenticated device token, which only exists on WS upgrades).

const SANDBOX_EXEC_DEFAULT_TIMEOUT_MS = 60_000;
const SANDBOX_EXEC_MAX_TIMEOUT_MS = 300_000;
const SANDBOX_EXEC_MAX_OUTPUT = 256_000;

async function handleSandboxExec(req, _emitEvent, context) {
  const payload = req.payload || {};
  const command = typeof payload.command === 'string' ? payload.command : '';
  // Pre-execution denial audits (#521 Codex P2). The original
  // emission only fired from the try/finally below, so
  // PATH_NOT_ALLOWED and INVALID_REQUEST early returns produced
  // NO audit row — exactly the case operators most want to see
  // ("which device tried to exec outside the allowlist?"). Emit a
  // structural denial row before each early-return.
  if (!command) {
    void appendAuditEvent({
      type: 'tool.sandbox_exec',
      ...auditProvenance(context),
      payload: { ok: false, errorCode: 'INVALID_REQUEST' },
    });
    return makeErrorResponse(
      req.requestId,
      'sandbox_exec',
      'INVALID_REQUEST',
      'sandbox_exec requires a non-empty `command` string in payload.',
    );
  }

  const rawTimeout =
    typeof payload.timeoutMs === 'number' && Number.isFinite(payload.timeoutMs)
      ? payload.timeoutMs
      : SANDBOX_EXEC_DEFAULT_TIMEOUT_MS;
  const timeoutMs = Math.min(Math.max(rawTimeout, 1_000), SANDBOX_EXEC_MAX_TIMEOUT_MS);
  const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();

  // Phase 3 allowlist gate: refuse exec if its cwd sits outside every
  // allowed root. NB: this only constrains the *working directory* —
  // the shell command itself can still touch any file the daemon
  // process can reach (`cat /etc/passwd`, etc.). Containing the
  // command-surface requires chroot/namespace isolation and is
  // explicitly out of scope for Phase 3; the allowlist is meaningful
  // for `sandbox_read_file` / `sandbox_write_file` / `sandbox_list_dir`
  // / `sandbox_diff` which DO route paths through `resolveAndAuthorize`.
  // Documented in `docs/decisions/Remote Sessions via pushd Relay.md`.
  {
    const cwdSnapshot = await snapshotAllowlist(process.cwd());
    if (!isPathAllowed(path.resolve(cwd), cwdSnapshot)) {
      // Audit the denial — this is exactly the "device tried to exec
      // outside the allowlist" case the operator most needs to see.
      // The denial happens BEFORE the try/finally below, so without
      // this emission the audit log would silently drop the attempt.
      // #521 Codex P2.
      void appendAuditEvent({
        type: 'tool.sandbox_exec',
        ...auditProvenance(context),
        payload: { ok: false, errorCode: 'PATH_NOT_ALLOWED', cwd },
      });
      return makeErrorResponse(
        req.requestId,
        'sandbox_exec',
        'PATH_NOT_ALLOWED',
        `sandbox_exec cwd is not in the daemon allowlist: ${cwd}`,
      );
    }
  }

  // Daemon-side mid-run cancellation (Phase 1.f): the web side may
  // include a `runId` in the payload and call `cancel_run` later to
  // abort the in-flight child. Register an AbortController in the
  // per-WS active-runs map (passed via context.wsState) so cancel_run
  // arriving on the same connection can find it. Unix-socket callers
  // don't carry wsState — they skip registration and behave as before
  // (cancellation isn't reachable there anyway).
  //
  // The run records the per-phone relay sender id it was started under
  // (`ownerId`, from the DO-stamped `RELAY_SENDER_FIELD` on the context). On
  // the relay transport every phone shares one wsState, so the sessionless
  // `cancel_run` path gates on this id to stop a guessed runId from one phone
  // aborting another's run (Remote Control Surface Audit #3). A null id
  // (loopback callers, which don't ride the relay) keeps the legacy
  // connection-scoped behavior.
  const runId = typeof payload.runId === 'string' && payload.runId ? payload.runId : null;
  const runOwnerId =
    typeof context?.relaySenderId === 'string' && context.relaySenderId
      ? context.relaySenderId
      : null;
  const wsState = context?.wsState;
  let abortController = null;
  if (runId && wsState && wsState.activeRuns instanceof Map) {
    abortController = new AbortController();
    wsState.activeRuns.set(runId, { controller: abortController, ownerId: runOwnerId });
  }

  const startedAt = Date.now();
  const { runCommandInResolvedShell } = await import('./shell.js');
  const { scrubEnv } = await import('./env-scrub.js');

  // Phase 3 slice 3 audit emission. We build the payload incrementally
  // from the actual outcome (exit code, duration, cancelled flag) and
  // emit ONCE in the finally block so success and failure paths share
  // a single record shape. Command text is opt-in via
  // PUSHD_AUDIT_LOG_COMMANDS=1 — see pushd-audit-log.ts for the
  // privacy rationale.
  let auditExitCode = 0;
  let auditCancelled = false;
  let auditTimedOut = false;
  let auditTruncated = false;
  // Non-zero exit codes are NOT errors at the RPC layer — they're a
  // normal result the model needs to see. We only set ok=false for
  // INVALID_REQUEST cases above. The caller reads `exitCode` for the
  // actual outcome.
  try {
    const execOpts = {
      cwd,
      timeout: timeoutMs,
      maxBuffer: SANDBOX_EXEC_MAX_OUTPUT,
      env: scrubEnv(),
    };
    if (abortController) execOpts.signal = abortController.signal;
    const { stdout, stderr } = await runCommandInResolvedShell(command, execOpts);
    // Success path can't actually carry truncated output: runCommand-
    // InResolvedShell enforces maxBuffer by rejecting once stdout+
    // stderr exceed it, so reaching here means both fit. Reporting
    // anything but `false` would be misleading. (PR #511 review.)
    return makeResponse(req.requestId, 'sandbox_exec', null, true, {
      stdout: truncateExecOutput(stdout),
      stderr: truncateExecOutput(stderr),
      exitCode: 0,
      durationMs: Date.now() - startedAt,
      truncated: false,
    });
  } catch (err) {
    // Abort path: distinguish a user-requested cancel from a timeout
    // so the model gets the right `cancelled` flag and won't retry
    // it as if it had timed out.
    const wasAborted = err?.name === 'AbortError' || Boolean(abortController?.signal?.aborted);
    const killed = Boolean(err?.killed);
    // maxBuffer overflow surfaces as a string err.code AND
    // err.killed === true. Distinguish it from a timeout so the
    // model gets an accurate `truncated` and isn't misled into
    // "command timed out" when the real signal was "output too big."
    const isMaxBufferOverflow = err?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
    const isTimeout = killed && !isMaxBufferOverflow && !wasAborted;
    const exitCode = typeof err?.code === 'number' ? err.code : killed || wasAborted ? 124 : 1;
    // Defensive: also flag truncation if the captured output actually
    // exceeds the cap, even if Node didn't tag the error code (some
    // runtimes / future Node versions may shift the contract).
    const capturedTooLarge =
      (err?.stdout?.length ?? 0) > SANDBOX_EXEC_MAX_OUTPUT ||
      (err?.stderr?.length ?? 0) > SANDBOX_EXEC_MAX_OUTPUT;
    auditExitCode = exitCode;
    auditCancelled = wasAborted;
    auditTimedOut = isTimeout;
    auditTruncated = isMaxBufferOverflow || capturedTooLarge;
    return makeResponse(req.requestId, 'sandbox_exec', null, true, {
      stdout: truncateExecOutput(err?.stdout ?? ''),
      stderr: truncateExecOutput(err?.stderr ?? err?.message ?? ''),
      exitCode,
      durationMs: Date.now() - startedAt,
      truncated: isMaxBufferOverflow || capturedTooLarge,
      timedOut: isTimeout,
      cancelled: wasAborted,
    });
  } finally {
    if (runId && wsState && wsState.activeRuns instanceof Map) {
      wsState.activeRuns.delete(runId);
    }
    void appendAuditEvent({
      type: 'tool.sandbox_exec',
      ...auditProvenance(context),
      runId: runId ?? undefined,
      payload: {
        cwd,
        exitCode: auditExitCode,
        durationMs: Date.now() - startedAt,
        cancelled: auditCancelled,
        timedOut: auditTimedOut,
        truncated: auditTruncated,
        // Privacy posture: command text is opt-in. The decision doc's
        // minimum-model checklist names "command/tool" — the tool is
        // always recorded (event type = `tool.sandbox_exec`); the
        // command text rides on the env opt-in. See pushd-audit-log.ts.
        command: shouldLogCommandText() ? truncateForAudit(command) : undefined,
      },
    });
  }
}

function truncateExecOutput(text) {
  if (typeof text !== 'string') return '';
  if (text.length <= SANDBOX_EXEC_MAX_OUTPUT) return text;
  return `${text.slice(0, SANDBOX_EXEC_MAX_OUTPUT)}\n…[truncated]`;
}

// ─── Phase 1.e file ops (PR 3c.3) ──────────────────────────────────
//
// Mirror the cloud `sandbox_read_file` / `sandbox_write_file` /
// `sandbox_list_dir` / `sandbox_diff` surface on the daemon. The
// implementations are deliberately minimal: no version cache, no
// optimistic concurrency, no workspace-revision tracking. Each
// resolves paths through `resolveDaemonPath` so a model that pastes
// `/workspace/foo` (the cloud convention) ends up reading from the
// daemon's cwd instead of `/workspace/foo` literally on the host.

const SANDBOX_FILE_MAX_BYTES = 1_000_000;
const SANDBOX_FILE_MAX_LINES = 50_000;
// Higher cap for ranged reads than the whole-file path so a model can
// read deep into multi-MB logs. Buffer-and-split implementation (NOT
// streaming): `readFile` + `split('\n')` lets the ranged path produce
// the same `totalLines` count as the whole-file path (split-on-newline
// includes the trailing empty entry; readline yields one fewer). The
// 32 MB cap keeps memory bounded for huge files — anything larger is
// rejected with a FILE_TOO_LARGE soft error. Copilot PR #516.
const SANDBOX_RANGED_READ_MAX_BYTES = 32_000_000;
const SANDBOX_LIST_MAX_ENTRIES = 1_000;
const SANDBOX_DIFF_MAX_BYTES = 1_000_000;
const SANDBOX_GIT_TIMEOUT_MS = 30_000;

// `isDaemonSensitivePath` is the same predicate the web layer uses,
// imported from `@push/lib/sensitive-paths` so daemon and web share
// one source of truth. The web layer ALSO blocks these paths before
// forwarding to the daemon (clean prompt context, no model round-
// trip), but a stolen bearer used outside our client would bypass
// that. Defense in depth: the daemon refuses the read at the boundary
// that actually has filesystem access. Centralized after Copilot
// drift concern on PR #516.

/**
 * Resolve a model-supplied path against the daemon's cwd.
 *
 * Cloud sandbox paths are conventionally rooted at `/workspace/...`.
 * On the local daemon, the cwd at startup IS the workspace, so we
 * strip a leading `/workspace/` and reinterpret the rest as relative.
 * Absolute non-`/workspace/` paths are honored as-is (the user paired
 * the daemon — they consented to local FS access). Bare relative
 * paths resolve against cwd. The leading-tilde case is not expanded
 * (cwd-based interpretation is enough for chat-driven reads).
 */
function resolveDaemonPath(p) {
  if (typeof p !== 'string' || p === '') return '';
  const cwd = process.cwd();
  if (p.startsWith('/workspace/')) {
    const resolved = path.resolve(cwd, p.slice('/workspace/'.length));
    return isContainedIn(resolved, cwd) ? resolved : null;
  }
  if (p === '/workspace') return cwd;
  if (path.isAbsolute(p)) return p;
  // Bare relative path: resolve against cwd AND enforce containment.
  // A model-emitted `../outside` would resolve to a sibling of cwd
  // and let the daemon read/write outside the paired workspace root
  // — pairing consents to cwd, not to traversal. Absolute paths are
  // still honored because pairing gates that explicitly; this only
  // tightens the relative-path surface. Copilot PR #516.
  const resolved = path.resolve(cwd, p);
  return isContainedIn(resolved, cwd) ? resolved : null;
}

function isContainedIn(absChild, absParent) {
  // path.relative is the canonical containment check: if the relative
  // path either starts with `..` or is absolute, child is outside.
  const rel = path.relative(absParent, absChild);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Phase 3 allowlist gate. Resolves the model's path against cwd
 * conventions, then checks the resolved location against the
 * daemon's effective allowlist (implicit-cwd default OR the
 * explicit user-configured roots in ~/.push/run/pushd.allowlist).
 *
 * Returns the absolute path on success, or `null` if the path is
 * malformed, traverses outside the workspace root, or sits outside
 * every allowed root. Callers translate `null` into a soft error
 * envelope with the existing `PATH_OUTSIDE_WORKSPACE` code so the
 * model sees the same recovery hint regardless of which gate
 * rejected — distinguishing them would only help an attacker
 * probing the allowlist boundaries.
 */
async function resolveAndAuthorize(rawPath) {
  const resolved = resolveDaemonPath(rawPath);
  if (resolved === null || resolved === '') return null;
  const snapshot = await snapshotAllowlist(process.cwd());
  return isPathAllowed(resolved, snapshot) ? resolved : null;
}

/**
 * Build a "soft" error envelope for the file-op handlers that exposes
 * a code + a generic message + the model's original requested path
 * — but NOT the daemon's fully-resolved absolute host path. Node's
 * `err.message` for ENOENT/EACCES/etc. includes the resolved path,
 * which leaks user/host filesystem details into the chat surface.
 * Copilot PR #516.
 */
function safeFsErrorPayload(err, requestedPath) {
  const code = typeof err?.code === 'string' ? err.code : 'READ_FAILED';
  let message;
  if (code === 'ENOENT') message = 'No such file or directory';
  else if (code === 'EACCES') message = 'Permission denied';
  else if (code === 'EISDIR') message = 'Path is a directory, not a file';
  else if (code === 'ENOTDIR') message = 'Path is not a directory';
  else if (code === 'EBUSY') message = 'Resource busy or locked';
  else if (code === 'EMFILE' || code === 'ENFILE') message = 'Too many open files';
  else message = 'Filesystem operation failed';
  return {
    code,
    error: `${message}: ${requestedPath}`,
  };
}

async function handleSandboxReadFile(req) {
  const payload = req.payload || {};
  const rawPath = typeof payload.path === 'string' ? payload.path : '';
  if (!rawPath) {
    return makeErrorResponse(
      req.requestId,
      'sandbox_read_file',
      'INVALID_REQUEST',
      'sandbox_read_file requires a non-empty `path` string in payload.',
    );
  }
  // Daemon-side sensitive-path reject. The web layer already blocks
  // these before forwarding, but a stolen bearer used outside our
  // client could skip that. The daemon is the boundary that actually
  // touches the filesystem, so it gets the second copy of the rule.
  // Kilo WARNING on PR #515.
  if (isDaemonSensitivePath(rawPath)) {
    return makeResponse(req.requestId, 'sandbox_read_file', null, true, {
      content: '',
      truncated: false,
      error: 'sensitive path refused by daemon',
      code: 'SENSITIVE_PATH',
    });
  }
  const resolved = await resolveAndAuthorize(rawPath);
  if (resolved === null) {
    return makeResponse(req.requestId, 'sandbox_read_file', null, true, {
      content: '',
      truncated: false,
      error: `path escapes workspace root: ${rawPath}`,
      code: 'PATH_OUTSIDE_WORKSPACE',
    });
  }
  const startLine = Number.isInteger(payload.startLine) ? payload.startLine : undefined;
  const endLine = Number.isInteger(payload.endLine) ? payload.endLine : undefined;
  const isRangeRead = startLine !== undefined || endLine !== undefined;

  // Ranged-read path: use a higher byte cap than the whole-file path
  // so a model can read lines deep into a multi-MB file (e.g. a long
  // log). totalLines is computed via the same split-on-newline rule
  // the whole-file path uses, so both paths report the same value
  // for the same file. Codex P2 on PR #515.
  if (isRangeRead) {
    let stat;
    try {
      stat = await fs.stat(resolved);
    } catch (err) {
      return makeResponse(req.requestId, 'sandbox_read_file', null, true, {
        content: '',
        truncated: false,
        ...safeFsErrorPayload(err, rawPath),
      });
    }
    if (stat.size > SANDBOX_RANGED_READ_MAX_BYTES) {
      return makeResponse(req.requestId, 'sandbox_read_file', null, true, {
        content: '',
        truncated: true,
        error: `file exceeds ${SANDBOX_RANGED_READ_MAX_BYTES} byte cap for ranged reads`,
        code: 'FILE_TOO_LARGE',
      });
    }
    let buf;
    try {
      buf = await fs.readFile(resolved);
    } catch (err) {
      return makeResponse(req.requestId, 'sandbox_read_file', null, true, {
        content: '',
        truncated: false,
        ...safeFsErrorPayload(err, rawPath),
      });
    }
    const allLines = buf.toString('utf8').split('\n');
    const totalLines = allLines.length;
    const s = Math.max(1, startLine ?? 1);
    const e = Math.min(totalLines, Math.max(s, endLine ?? totalLines));
    return makeResponse(req.requestId, 'sandbox_read_file', null, true, {
      content: allLines.slice(s - 1, e).join('\n'),
      truncated: false,
      totalLines,
    });
  }

  // Whole-file path: keep the previous in-memory implementation.
  let buf;
  try {
    buf = await fs.readFile(resolved);
  } catch (err) {
    return makeResponse(req.requestId, 'sandbox_read_file', null, true, {
      content: '',
      truncated: false,
      ...safeFsErrorPayload(err, rawPath),
    });
  }

  if (buf.length > SANDBOX_FILE_MAX_BYTES) {
    return makeResponse(req.requestId, 'sandbox_read_file', null, true, {
      content: buf.slice(0, SANDBOX_FILE_MAX_BYTES).toString('utf8'),
      truncated: true,
    });
  }

  const allText = buf.toString('utf8');
  const allLines = allText.split('\n');
  const totalLines = allLines.length;
  return makeResponse(req.requestId, 'sandbox_read_file', null, true, {
    content:
      totalLines > SANDBOX_FILE_MAX_LINES
        ? allLines.slice(0, SANDBOX_FILE_MAX_LINES).join('\n')
        : allText,
    truncated: totalLines > SANDBOX_FILE_MAX_LINES,
    totalLines,
  });
}

async function handleSandboxWriteFile(req) {
  const payload = req.payload || {};
  const rawPath = typeof payload.path === 'string' ? payload.path : '';
  const content = typeof payload.content === 'string' ? payload.content : null;
  if (!rawPath || content === null) {
    return makeErrorResponse(
      req.requestId,
      'sandbox_write_file',
      'INVALID_REQUEST',
      'sandbox_write_file requires `path` and `content` strings in payload.',
    );
  }
  if (isDaemonSensitivePath(rawPath)) {
    return makeResponse(req.requestId, 'sandbox_write_file', null, true, {
      ok: false,
      error: 'sensitive path refused by daemon',
    });
  }
  const resolved = await resolveAndAuthorize(rawPath);
  if (resolved === null) {
    return makeResponse(req.requestId, 'sandbox_write_file', null, true, {
      ok: false,
      error: `path escapes workspace root: ${rawPath}`,
    });
  }
  try {
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content, 'utf8');
    return makeResponse(req.requestId, 'sandbox_write_file', null, true, {
      ok: true,
      bytesWritten: Buffer.byteLength(content, 'utf8'),
    });
  } catch (err) {
    const { error } = safeFsErrorPayload(err, rawPath);
    return makeResponse(req.requestId, 'sandbox_write_file', null, true, {
      ok: false,
      error,
    });
  }
}

async function handleSandboxListDir(req) {
  const payload = req.payload || {};
  const rawPath = typeof payload.path === 'string' && payload.path ? payload.path : '.';
  if (isDaemonSensitivePath(rawPath)) {
    return makeResponse(req.requestId, 'sandbox_list_dir', null, true, {
      entries: [],
      truncated: false,
      error: 'sensitive path refused by daemon',
    });
  }
  const resolved = await resolveAndAuthorize(rawPath);
  if (resolved === null) {
    return makeResponse(req.requestId, 'sandbox_list_dir', null, true, {
      entries: [],
      truncated: false,
      error: `path escapes workspace root: ${rawPath}`,
    });
  }

  let dirents;
  try {
    dirents = await fs.readdir(resolved, { withFileTypes: true });
  } catch (err) {
    const { error } = safeFsErrorPayload(err, rawPath);
    return makeResponse(req.requestId, 'sandbox_list_dir', null, true, {
      entries: [],
      truncated: false,
      error,
    });
  }

  const truncated = dirents.length > SANDBOX_LIST_MAX_ENTRIES;
  const slice = truncated ? dirents.slice(0, SANDBOX_LIST_MAX_ENTRIES) : dirents;
  const entries = await Promise.all(
    slice.map(async (d) => {
      let type;
      if (d.isFile()) type = 'file';
      else if (d.isDirectory()) type = 'directory';
      else if (d.isSymbolicLink()) type = 'symlink';
      else type = 'other';
      let size;
      if (type === 'file') {
        try {
          const stat = await fs.stat(path.join(resolved, d.name));
          size = stat.size;
        } catch {
          // Best-effort — leave size undefined.
        }
      }
      return { name: d.name, type, size };
    }),
  );

  return makeResponse(req.requestId, 'sandbox_list_dir', null, true, {
    entries,
    truncated,
  });
}

// Empty-tree sha1 (`git hash-object -t tree --stdin < /dev/null`).
// Built into every git installation. Diffing against it yields "every
// tracked file is an add" — what we want when HEAD doesn't exist yet
// (freshly init'd repo with no commits). Gemini PR #515.
const GIT_EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

async function handleSandboxDiff(req) {
  const { runCommandInResolvedShell } = await import('./shell.js');
  const cwd = process.cwd();
  // Phase 3 allowlist gate. `sandbox_diff` shells out `git` from
  // cwd; if the user has tightened the allowlist to exclude cwd
  // (intentional or accidental), surface a clear error instead of
  // running git in a disallowed directory.
  {
    const cwdSnapshot = await snapshotAllowlist(cwd);
    if (!isPathAllowed(cwd, cwdSnapshot)) {
      return makeResponse(req.requestId, 'sandbox_diff', null, true, {
        diff: '',
        truncated: false,
        error: `daemon cwd is not in the allowlist: ${cwd}`,
      });
    }
  }
  // git diff HEAD: tracked-file working-copy changes vs the most recent
  // commit. Untracked-file presence is conveyed by `git status --porcelain`
  // below so the model has a complete picture. If HEAD doesn't exist
  // (fresh repo, no commits), diff against the empty tree instead so
  // the model still gets a useful payload.
  let diffText = '';
  let statusText = '';
  let diffError;
  let diffBase = 'HEAD';
  try {
    await runCommandInResolvedShell('git rev-parse --verify HEAD', {
      cwd,
      timeout: SANDBOX_GIT_TIMEOUT_MS,
      maxBuffer: 64_000,
    });
  } catch {
    diffBase = GIT_EMPTY_TREE;
  }
  try {
    const out = await runCommandInResolvedShell(`git diff ${diffBase}`, {
      cwd,
      timeout: SANDBOX_GIT_TIMEOUT_MS,
      maxBuffer: SANDBOX_DIFF_MAX_BYTES + 64_000,
    });
    diffText = out.stdout || '';
  } catch (err) {
    // Treat as soft-error: not a fatal RPC failure (might just mean no
    // commits yet AND no empty-tree access — should be impossible, but
    // we keep the soft error path), surface via the error field for
    // the dispatch fork.
    diffError = err?.stderr || err?.message || 'git diff failed';
  }
  try {
    const out = await runCommandInResolvedShell('git status --porcelain', {
      cwd,
      timeout: SANDBOX_GIT_TIMEOUT_MS,
      maxBuffer: 256_000,
    });
    statusText = out.stdout || '';
  } catch {
    // Status is advisory; swallow.
  }

  // Current HEAD SHA so callers can pre/post-snapshot a Coder run and
  // detect committed-but-no-longer-in-working-tree work. See PR #604.
  let headSha;
  try {
    const out = await runCommandInResolvedShell('git rev-parse HEAD', {
      cwd,
      timeout: SANDBOX_GIT_TIMEOUT_MS,
      maxBuffer: 64_000,
    });
    const trimmed = (out.stdout || '').trim();
    if (trimmed) headSha = trimmed;
  } catch {
    // HEAD may not exist in a fresh repo; leave headSha undefined.
  }

  // Optional ranged diff (`since_ref..HEAD`) so the Auditor can see
  // committed work after the working tree is clean. Same shell-injection
  // guard as the worker route: hex SHA shape only.
  let diffSinceRef = '';
  const sinceRefRaw =
    typeof req.payload?.since_ref === 'string' ? req.payload.since_ref.trim() : '';
  const sinceRef = /^[0-9a-f]{7,40}$/i.test(sinceRefRaw) ? sinceRefRaw : '';
  if (sinceRef) {
    try {
      const out = await runCommandInResolvedShell(`git diff ${sinceRef}..HEAD`, {
        cwd,
        timeout: SANDBOX_GIT_TIMEOUT_MS,
        maxBuffer: SANDBOX_DIFF_MAX_BYTES + 64_000,
      });
      diffSinceRef = out.stdout || '';
    } catch {
      // Ranged-diff failure (bad ref, etc.) is non-fatal — fall back
      // to the working-tree diff path.
    }
  }

  const truncated = diffText.length > SANDBOX_DIFF_MAX_BYTES;
  const truncatedSinceRef = diffSinceRef.length > SANDBOX_DIFF_MAX_BYTES;
  return makeResponse(req.requestId, 'sandbox_diff', null, true, {
    diff: truncated ? `${diffText.slice(0, SANDBOX_DIFF_MAX_BYTES)}\n…[truncated]` : diffText,
    truncated,
    gitStatus: statusText,
    ...(headSha ? { headSha } : {}),
    ...(diffSinceRef
      ? {
          diffSinceRef: truncatedSinceRef
            ? `${diffSinceRef.slice(0, SANDBOX_DIFF_MAX_BYTES)}\n…[truncated]`
            : diffSinceRef,
        }
      : {}),
    error: diffError,
  });
}

async function handleDaemonIdentify(req, _emitEvent, context) {
  // Phase 3 slice 2: identify reads from the auth principal so an
  // attach-token-authed connection still sees its parent device's
  // identity. Reporting the attach tokenId would defeat the purpose
  // of the device-identity surface (the attach token rotates; the
  // device identity is what other peers actually recognize).
  const auth = context?.auth;
  if (!auth) {
    return makeErrorResponse(
      req.requestId,
      'daemon_identify',
      'UNSUPPORTED_VIA_TRANSPORT',
      'daemon_identify is only available over the WebSocket transport.',
    );
  }
  return makeResponse(req.requestId, 'daemon_identify', null, true, {
    tokenId: auth.parentDeviceTokenId,
    boundOrigin: auth.boundOrigin,
    daemonVersion: VERSION,
    protocolVersion: PROTOCOL_VERSION,
    /**
     * Slice 2 addition. Lets clients verify their connection's auth
     * kind without exposing the attach tokenId (which is private).
     * 'attach' means the client is using a derived short-lived
     * token; 'device' means it's still using the durable bearer
     * (typically only seen during the brief pairing window before
     * the first mint).
     */
    authKind: auth.kind,
  });
}

// ─── Phase 3 device-admin handlers ───────────────────────────────
//
// These are intended for the Unix-socket-only `push daemon` CLI
// surface. Exposing them over the WS would let a paired device
// revoke OTHER paired devices, which the threat model doesn't
// authorize — the WS is bound to a specific device's tokenId and
// shouldn't grant cross-device admin authority. The handlers refuse
// when the request context carries a WS-authenticated `record`.

function refuseFromWs(req, type) {
  return makeErrorResponse(
    req.requestId,
    type,
    'UNSUPPORTED_VIA_TRANSPORT',
    `${type} is only available over the Unix-socket admin transport.`,
  );
}

/**
 * Live device revoke. Mutates the tokens file AND closes every WS
 * connection currently bearing the revoked tokenId. Closes the
 * "revoke takes effect on next upgrade" gap from open question #6 in
 * the decision doc.
 */
async function handleRevokeDeviceToken(req, _emitEvent, context) {
  if (context?.record || context?.auth) return refuseFromWs(req, 'revoke_device_token');
  const tokenId = typeof req.payload?.tokenId === 'string' ? req.payload.tokenId : '';
  if (!tokenId) {
    return makeErrorResponse(
      req.requestId,
      'revoke_device_token',
      'INVALID_REQUEST',
      'tokenId is required',
    );
  }
  const removed = await revokeDeviceToken(tokenId);
  if (!removed) {
    return makeErrorResponse(
      req.requestId,
      'revoke_device_token',
      'TOKEN_NOT_FOUND',
      `no such token: ${tokenId}`,
    );
  }
  // Cascade: every attach token derived from this device token is
  // now orphaned and must be invalidated alongside its parent.
  // Otherwise a stolen attach token would continue to authenticate
  // even after the user clicked "revoke this device." Phase 3
  // slice 2 — the load-bearing piece of the cascade contract.
  const revokedAttachIds = await revokeAttachTokensByParent(tokenId);
  // disconnectByTokenId is now device-scoped (slice 2): it closes
  // every WS bearing this parent device, regardless of whether each
  // individual connection used the device token directly or one of
  // its attach tokens. So one call handles both the device-direct
  // connection and every child attach connection.
  const closedConnections = activeWsHandle
    ? activeWsHandle.disconnectByTokenId(tokenId, 'device token revoked')
    : 0;
  // Phase 2.e cascade: drop every tokenHash derived from the revoked
  // device from the relay allowlist and emit `relay_phone_revoke`
  // for those that were actually registered.
  const revokedHashes = relayAllowlist.removeMany(revokedAttachIds);
  if (revokedHashes.length > 0) emitRelayRevokeChange(revokedHashes);
  void appendAuditEvent({
    type: 'auth.revoke_device',
    ...auditProvenance(context),
    payload: {
      tokenId,
      closedConnections,
      revokedAttachTokens: revokedAttachIds,
    },
  });
  return makeResponse(req.requestId, 'revoke_device_token', null, true, {
    tokenId,
    closedConnections,
    revokedAttachTokens: revokedAttachIds,
  });
}

/**
 * Mint a fresh device-attach token. Requires a device-token-
 * authenticated WS context: the durable device token is the credential
 * that BOOTSTRAPS attach tokens, so an attach-token-authed caller
 * cannot ask for a new attach token (no privilege escalation /
 * refresh-chaining). Web clients use this once at pairing time, then
 * discard the device token; CLI tooling never calls it.
 *
 * Refusing the call when the caller authed with an attach token
 * preserves the "device token = durable, attach token = short-lived"
 * model. A future slice may add a separate `refresh_attach_token`
 * surface that DOES accept an attach-authed caller and rotates it
 * for a fresh one, but the current minimum-viable shape is "mint
 * via device token only."
 */
async function handleMintDeviceAttachToken(req, _emitEvent, context) {
  const auth = context?.auth;
  if (!auth) {
    return makeErrorResponse(
      req.requestId,
      'mint_device_attach_token',
      'UNSUPPORTED_VIA_TRANSPORT',
      'mint_device_attach_token is only available over the WebSocket transport.',
    );
  }
  if (auth.kind !== 'device') {
    return makeErrorResponse(
      req.requestId,
      'mint_device_attach_token',
      'DEVICE_TOKEN_REQUIRED',
      'mint_device_attach_token requires a device-token-authenticated connection.',
    );
  }
  const result = await mintDeviceAttachToken({
    parentTokenId: auth.tokenId,
    boundOrigin: auth.boundOrigin as 'loopback' | string,
  });
  // Phase 2.e + hash-allowlist hardening: register the tokenHash
  // (already computed by mintDeviceAttachToken) in the relay
  // allowlist and push a `relay_phone_allow` envelope. We never
  // capture bearer plaintext — the on-disk store and the relay
  // wire both speak hashes, which is what makes daemon-restart
  // recovery work.
  relayAllowlist.add(result.tokenId, result.record.tokenHash);
  emitRelayAllowChange([result.record.tokenHash]);
  void appendAuditEvent({
    type: 'auth.mint_attach',
    ...auditProvenance(context),
    payload: {
      mintedTokenId: result.tokenId,
      parentTokenId: auth.tokenId,
      ttlMs: result.ttlMs,
    },
  });
  return makeResponse(req.requestId, 'mint_device_attach_token', null, true, {
    token: result.token,
    tokenId: result.tokenId,
    ttlMs: result.ttlMs,
    parentTokenId: auth.tokenId,
  });
}

/**
 * Revoke a single attach token by id. Unix-socket admin only (mirrors
 * `revoke_device_token`'s posture). Cascade is unnecessary here —
 * attach tokens have no children — but we DO close the corresponding
 * live WS connection so an attacker who already attached doesn't
 * keep their session alive past the revoke. `disconnectByAttachTokenId`
 * is narrow: it does NOT close the parent device's other connections.
 */
async function handleRevokeDeviceAttachToken(req, _emitEvent, context) {
  if (context?.record || context?.auth) return refuseFromWs(req, 'revoke_device_attach_token');
  const tokenId = typeof req.payload?.tokenId === 'string' ? req.payload.tokenId : '';
  if (!tokenId) {
    return makeErrorResponse(
      req.requestId,
      'revoke_device_attach_token',
      'INVALID_REQUEST',
      'tokenId is required',
    );
  }
  const removed = await revokeDeviceAttachToken(tokenId);
  if (!removed) {
    return makeErrorResponse(
      req.requestId,
      'revoke_device_attach_token',
      'TOKEN_NOT_FOUND',
      `no such attach token: ${tokenId}`,
    );
  }
  const closedConnections = activeWsHandle
    ? activeWsHandle.disconnectByAttachTokenId(tokenId, 'attach token revoked')
    : 0;
  // Phase 2.e: drop the tokenHash from the relay allowlist and push
  // a `relay_phone_revoke`. The hash-keyed registry is reseeded at
  // startup from the persisted attach-token store, so an entry that
  // outlived a daemon restart is still present here.
  const removedHash = relayAllowlist.remove(tokenId);
  if (removedHash !== null) emitRelayRevokeChange([removedHash]);
  void appendAuditEvent({
    type: 'auth.revoke_attach',
    ...auditProvenance(context),
    payload: { tokenId, closedConnections },
  });
  return makeResponse(req.requestId, 'revoke_device_attach_token', null, true, {
    tokenId,
    closedConnections,
  });
}

/**
 * `list_attach_tokens` returns metadata for every non-expired attach
 * token in the file. Token text is never returned. Like
 * `list_devices`, this is a Unix-socket-only admin surface — a paired
 * device can't enumerate other devices' attach tokens.
 */
/**
 * Phase 2.e admin handlers (`relay_enable` / `relay_disable` /
 * `relay_status`). Unix-socket-only — the relay is per-daemon
 * config and changing it from a paired WS would invert the trust
 * direction (the relay would be reconfiguring the daemon's outbound
 * trust path). `refuseFromWs` enforces the boundary.
 */
async function handleRelayEnable(req, _emitEvent, context) {
  if (context?.record || context?.auth) return refuseFromWs(req, 'relay_enable');
  const deploymentUrl =
    typeof req.payload?.deploymentUrl === 'string' ? req.payload.deploymentUrl.trim() : '';
  const token = typeof req.payload?.token === 'string' ? req.payload.token : '';
  if (!deploymentUrl) {
    return makeErrorResponse(
      req.requestId,
      'relay_enable',
      'INVALID_REQUEST',
      'deploymentUrl is required',
    );
  }
  if (!isValidRelayToken(token)) {
    return makeErrorResponse(
      req.requestId,
      'relay_enable',
      'INVALID_REQUEST',
      'token must start with pushd_relay_ and include a token body (yours looks truncated)',
    );
  }
  let persisted: RelayConfig;
  try {
    persisted = await writeRelayConfig({ deploymentUrl, token });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return makeErrorResponse(req.requestId, 'relay_enable', 'INTERNAL_ERROR', message);
  }
  // Live restart: close any existing client, then start a fresh one
  // with the new config. Doing both inside the handler keeps the
  // CLI shape honest — `push daemon relay enable` should take effect
  // immediately, not require a daemon restart.
  stopRelayClient();
  try {
    activeRelayClient = startRelayClient(persisted);
    activeRelayDeploymentUrl = persisted.deploymentUrl;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return makeErrorResponse(req.requestId, 'relay_enable', 'INTERNAL_ERROR', message);
  }
  return makeResponse(req.requestId, 'relay_enable', null, true, {
    deploymentUrl: persisted.deploymentUrl,
    enabledAt: persisted.enabledAt,
  });
}

async function handleRelayDisable(req, _emitEvent, context) {
  if (context?.record || context?.auth) return refuseFromWs(req, 'relay_disable');
  let removed = false;
  try {
    removed = await deleteRelayConfig();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return makeErrorResponse(req.requestId, 'relay_disable', 'INTERNAL_ERROR', message);
  }
  const wasActive = activeRelayClient !== null;
  // Disable is the only path that intentionally drops the in-process
  // allowlist: no relay means no need to keep bearers around. The
  // live-restart inside `relay_enable` deliberately keeps them.
  stopRelayClient({ clearAllowlist: true });
  return makeResponse(req.requestId, 'relay_disable', null, true, {
    configRemoved: removed,
    clientStopped: wasActive,
  });
}

async function buildRelayStatusPayload() {
  let persistedDeploymentUrl: string | null = null;
  let persistedEnabledAt: number | null = null;
  try {
    const cfg = await readRelayConfig();
    if (cfg) {
      persistedDeploymentUrl = cfg.deploymentUrl;
      persistedEnabledAt = cfg.enabledAt;
    }
  } catch {
    // If the file is unreadable the operator/client should still get
    // live state back; surface the read failure as `null` config rather
    // than making a read-only status packet fail.
  }
  const status = activeRelayLastStatus;
  const live = activeRelayClient
    ? {
        running: true,
        deploymentUrl: activeRelayDeploymentUrl,
        state: status?.state ?? 'connecting',
        attempt: status && 'attempt' in status ? status.attempt : 0,
        exhausted:
          status && (status.state === 'closed' || status.state === 'unreachable')
            ? status.exhausted
            : false,
        closeCode:
          status && (status.state === 'closed' || status.state === 'unreachable')
            ? status.code
            : null,
        closeReason:
          status && (status.state === 'closed' || status.state === 'unreachable')
            ? status.reason
            : null,
        fatal:
          status && (status.state === 'closed' || status.state === 'unreachable')
            ? (status.fatal ?? false)
            : false,
        allowlistSize: relayAllowlist.size(),
      }
    : { running: false };
  return {
    persisted: persistedDeploymentUrl
      ? { deploymentUrl: persistedDeploymentUrl, enabledAt: persistedEnabledAt }
      : null,
    live,
  };
}

/**
 * Returns both persisted config (presence + deploymentUrl, never the
 * token) AND live runtime state (connection status, reconnect
 * counter, last-error). Operators reading this need to see both —
 * "config says enabled but daemon hasn't dialled" is a real failure
 * mode worth surfacing distinctly from "no config" and "open and
 * forwarding."
 */
async function handleRelayStatus(req, _emitEvent, context) {
  if (context?.record || context?.auth) return refuseFromWs(req, 'relay_status');
  return makeResponse(req.requestId, 'relay_status', null, true, await buildRelayStatusPayload());
}

/**
 * Minimal shape of an `activeSessions` entry this helper reads/mutates. The
 * registry Map is untyped (`new Map()`), so this narrow type documents the
 * contract for the exported helper and its isolation tests.
 */
type MintableSessionEntry = {
  attachToken?: string | null;
  state?: { attachToken?: string | null; sessionId?: string } | null;
};

/**
 * Resolve the attach token for a target daemon session. Under the Universal
 * Session Bearer this is now a plain resolve: every session is tokened at
 * birth (the `createSessionState` factory) or on first attach (the
 * bootstrap-grace legacy claim), so `entry.attachToken` is always present and
 * the `minted: false` branch is the only one real traffic takes.
 *
 * The defensive mint below is RETIRED to a TRIPWIRE — if it ever fires, a
 * session creation path slipped past the factory (a regression), so it logs
 * `attach_token_minted_unexpectedly` (warn) loudly while still minting so
 * remote pairing keeps working rather than hard-failing. Kept I/O-free (random
 * token + entry mutation only) so it's unit-testable without a session dir.
 * The caller persists `entry.state` and surfaces `minted` so a live TUI can
 * adopt the token before its next reconnect.
 *
 * Throws on a missing/non-object entry — the caller (`handleMintRemotePairBundle`)
 * already rejects an absent session with SESSION_NOT_FOUND, but the export must
 * fail loudly rather than throw a cryptic "cannot set property of null".
 */
export function resolveOrMintTargetAttachToken(entry: MintableSessionEntry) {
  if (!entry || typeof entry !== 'object') {
    throw new Error('resolveOrMintTargetAttachToken requires a session entry object');
  }
  if (entry.attachToken) return { token: entry.attachToken, minted: false };
  // TRIPWIRE: reaching here means a session reached remote-pairing without a
  // bearer — i.e. a creation path bypassed the factory and the bootstrap grace
  // never claimed it. Mint defensively so pairing still works, but log loudly.
  const token = makeAttachToken();
  process.stderr.write(
    `${JSON.stringify({ level: 'warn', event: 'attach_token_minted_unexpectedly', sessionId: entry.state?.sessionId })}\n`,
  );
  entry.attachToken = token;
  if (entry.state && typeof entry.state === 'object') {
    entry.state.attachToken = token;
  }
  return { token, minted: true };
}

/**
 * Phase 2.f: mint a one-shot pairing bundle for a remote phone.
 * Reads the relay config (errors if `relay enable` hasn't been run),
 * mints a fresh device token + child attach token, populates the
 * in-process relay allowlist with the new attach bearer (so the
 * relay client's next emit covers it), and returns the bundled
 * string the operator pastes into the phone.
 *
 * Each `pair --remote` invocation mints a NEW device token. That
 * means each remote phone gets its own durable identity, revocable
 * via `push daemon revoke <tokenId>` — and the cascade revoke kills
 * the child attach token + closes any live relay forwarding for
 * that phone in one shot (Phase 3 slice 2 cascade contract).
 *
 * Unix-socket admin only; WS callers are refused. The operator
 * already has filesystem-level admin authority over the daemon
 * config; the pair bundle conveys exactly that authority to one
 * remote phone.
 *
 * NOTE: pairing a *tokenless* target session mints an attach token for it
 * (see `resolveOrMintTargetAttachToken`), which flips that session from "open
 * attach" to "bearer required" for all clients. Intentional and benign — see
 * that helper's doc for the rationale and the one local-client edge case.
 */
async function handleMintRemotePairBundle(req, _emitEvent, context) {
  if (context?.record || context?.auth) return refuseFromWs(req, 'mint_remote_pair_bundle');
  const config = await readRelayConfig();
  if (!config) {
    return makeErrorResponse(
      req.requestId,
      'mint_remote_pair_bundle',
      'RELAY_NOT_ENABLED',
      'Relay is not enabled. Run `push daemon relay enable --url <…> --token <…>` first.',
    );
  }
  const targetSessionId =
    typeof req.payload?.targetSessionId === 'string' && req.payload.targetSessionId.length > 0
      ? req.payload.targetSessionId
      : null;
  const targetAttachToken =
    typeof req.payload?.targetAttachToken === 'string' && req.payload.targetAttachToken.length > 0
      ? req.payload.targetAttachToken
      : null;
  if (!targetSessionId && targetAttachToken) {
    return makeErrorResponse(
      req.requestId,
      'mint_remote_pair_bundle',
      'INVALID_REQUEST',
      'targetAttachToken requires targetSessionId.',
    );
  }
  let resolvedTargetAttachToken = targetAttachToken;
  // When set, the session attach token was minted on demand below — surfaced
  // in the response so the calling TUI can adopt it (see the handler doc).
  let mintedSessionAttachToken = null;
  if (targetSessionId && targetAttachToken) {
    const entry = activeSessions.get(targetSessionId);
    if (!entry || entry.attachToken !== targetAttachToken) {
      return makeErrorResponse(
        req.requestId,
        'mint_remote_pair_bundle',
        'INVALID_TOKEN',
        'Target daemon session is not active or its attach token did not match.',
      );
    }
  }
  if (targetSessionId && !targetAttachToken) {
    const entry = activeSessions.get(targetSessionId);
    if (!entry) {
      return makeErrorResponse(
        req.requestId,
        'mint_remote_pair_bundle',
        'SESSION_NOT_FOUND',
        'Target daemon session is not active.',
      );
    }
    // Universal Session Bearer: the target is tokened at birth (factory) or on
    // first attach (grace), so this resolves to the existing token and
    // `minted` is false. The mint branch is now a tripwire — if it fires, a
    // creation path slipped past the factory (see resolveOrMintTargetAttachToken).
    // The persist + adopt plumbing below is kept for that defensive case.
    const resolved = resolveOrMintTargetAttachToken(entry);
    resolvedTargetAttachToken = resolved.token;
    if (resolved.minted) {
      mintedSessionAttachToken = resolved.token;
      if (entry.state && typeof entry.state === 'object') {
        try {
          await saveSessionState(entry.state);
          process.stderr.write(
            `${JSON.stringify({ level: 'info', event: 'pair_bundle_minted_session_token', targetSessionId })}\n`,
          );
        } catch (err) {
          // Persist failed: the in-memory token still works for this run, but
          // a daemon restart would lose it. Surface it instead of failing the
          // pairing — the bundle is already usable for the live session.
          process.stderr.write(
            `${JSON.stringify({ level: 'warn', event: 'pair_bundle_mint_persist_failed', targetSessionId, error: err instanceof Error ? err.message : String(err) })}\n`,
          );
        }
      }
    }
  }
  // Mint a fresh device token first (durable identity for this
  // remote phone), then a child attach token (the actual bearer the
  // phone carries to the relay). Both writes go through the existing
  // serialized stores so concurrent pair-remote calls don't collide.
  // boundOrigin is 'loopback' because the relay phone never connects
  // to the daemon's loopback WS listener — the relay does the actual
  // origin enforcement on the phone's WS upgrade.
  const device = await mintDeviceToken({ boundOrigin: 'loopback' });
  const attach = await mintDeviceAttachToken({
    parentTokenId: device.tokenId,
    boundOrigin: 'loopback',
  });
  // Register the new tokenHash in the relay allowlist (same path
  // mint takes for the LAN-paired case) and emit a `relay_phone_allow`
  // so the DO updates its per-session allowlist before the phone
  // even tries to connect.
  relayAllowlist.add(attach.tokenId, attach.record.tokenHash);
  emitRelayAllowChange([attach.record.tokenHash]);
  // sessionId mirrors what `startRelayClient` uses — a stable per-
  // daemon routing key. The relay sessionId is opaque routing, not
  // load-bearing for security (see 2.d.1 walk-back); using the
  // hostname-derived form keeps phone bundles routing to the same
  // DO instance as the running relay client without coordinating a
  // separate id.
  const sessionId = `pushd-${os.hostname()}`;
  const bundle = encodeRemotePairBundle({
    deploymentUrl: config.deploymentUrl,
    sessionId,
    token: attach.token,
    // Public ids included so the web pair panel can surface them
    // in the paired-device row for revocation guidance. Neither
    // is bearer material; both are already printed to stdout.
    // PR #530 GH Actions review.
    attachTokenId: attach.tokenId,
    deviceTokenId: device.tokenId,
    ...(targetSessionId && resolvedTargetAttachToken
      ? { targetSessionId, targetAttachToken: resolvedTargetAttachToken }
      : {}),
  });
  void appendAuditEvent({
    type: 'auth.mint_attach',
    surface: 'unix-socket',
    payload: {
      mintedTokenId: attach.tokenId,
      parentTokenId: device.tokenId,
      ttlMs: attach.ttlMs,
      remote: true,
      targetSessionId: targetSessionId ?? undefined,
    },
  });
  // Audit logs the tokenIds but NEVER the bundle (which carries the
  // bearer in plaintext). The bundle is one-shot: it lives in the
  // response payload to the CLI and then in the operator's terminal
  // buffer — it must not land in the audit log too.
  return makeResponse(req.requestId, 'mint_remote_pair_bundle', null, true, {
    bundle,
    deviceTokenId: device.tokenId,
    attachTokenId: attach.tokenId,
    sessionId,
    targetSessionId,
    deploymentUrl: config.deploymentUrl,
    ttlMs: attach.ttlMs,
    // Present only when we minted a fresh attach token for a previously
    // tokenless target session. The TUI adopts it so its own future
    // reconnects carry the now-required bearer. Same trust domain (unix
    // socket → local admin); never written to the audit log.
    ...(mintedSessionAttachToken ? { mintedTargetAttachToken: mintedSessionAttachToken } : {}),
  });
}

/**
 * `grant_session_attach` — hand an already-authenticated client the
 * attach token for one daemon session, so a paired phone can resume a
 * session it discovered via `list_sessions` (tap-to-resume; the
 * Session Continuity north star: "a session created in the TUI is
 * listed and resumable from the phone").
 *
 * Trust analysis (why this does NOT widen the threat surface):
 *   - Callers must already hold transport auth: a device/attach-token
 *     WS connection, the relay path (allowlisted `pushd_da_*` bearers
 *     only — the DO enforces at upgrade), or the local Unix socket
 *     (operator; can read session files directly anyway). An
 *     unauthenticated caller never reaches this handler with a grant.
 *   - The pair-bundle flow already conveys exactly this class of
 *     secret (`targetAttachToken`) to a paired phone; this extends
 *     "one session at pairing time" to "any session while paired,"
 *     which is the documented product direction.
 *   - A granted session token is useless without transport access:
 *     `attach_session` is only reachable over the same authenticated
 *     transports, so device revocation (allowlist cascade + WS
 *     disconnect) still cuts off a revoked phone even if it kept
 *     granted tokens.
 *   - Unlike `mint_device_attach_token` (device-kind only), this
 *     mints no new credential — it reveals the session's existing
 *     bearer, and every grant is audit-logged with provenance.
 */
async function handleGrantSessionAttach(req, _emitEvent, context) {
  const sessionId =
    typeof req.payload?.sessionId === 'string' && req.payload.sessionId.length > 0
      ? req.payload.sessionId
      : null;
  if (!sessionId) {
    return makeErrorResponse(
      req.requestId,
      'grant_session_attach',
      'INVALID_REQUEST',
      'sessionId is required',
    );
  }

  let entry = activeSessions.get(sessionId);
  if (!entry) {
    // Mirror attach_session's lazy load so a session that survived a
    // daemon restart (on disk, not yet touched) is still resumable.
    try {
      const state = await loadSessionState(sessionId);
      entry = { state, attachToken: state.attachToken };
      activeSessions.set(sessionId, entry);
    } catch {
      return makeErrorResponse(
        req.requestId,
        'grant_session_attach',
        'SESSION_NOT_FOUND',
        `Session not found: ${sessionId}`,
      );
    }
  }

  // Universal Session Bearer: resolves to the existing token; the mint
  // branch is a tripwire for creation paths that bypassed the factory
  // (see resolveOrMintTargetAttachToken).
  const resolved = resolveOrMintTargetAttachToken(entry);
  if (resolved.minted && entry.state && typeof entry.state === 'object') {
    try {
      await saveSessionState(entry.state);
    } catch (err) {
      // In-memory token still authorizes this run; a restart loses it
      // and the next grant re-mints. Surface rather than fail.
      process.stderr.write(
        `${JSON.stringify({ level: 'warn', event: 'grant_attach_mint_persist_failed', sessionId, error: err instanceof Error ? err.message : String(err) })}\n`,
      );
    }
  }

  // Audit the grant (tokenId-free — never the bearer) with transport
  // provenance so `push daemon audit` can answer "which device was
  // granted access to which session, when."
  void appendAuditEvent({
    type: 'auth.grant_session_attach',
    ...auditProvenance(context),
    sessionId,
    payload: {
      minted: resolved.minted,
      relaySenderId: typeof context?.relaySenderId === 'string' ? context.relaySenderId : undefined,
    },
  });

  return makeResponse(req.requestId, 'grant_session_attach', null, true, {
    sessionId,
    attachToken: resolved.token,
  });
}

async function handleListAttachTokens(req, _emitEvent, context) {
  if (context?.record || context?.auth) return refuseFromWs(req, 'list_attach_tokens');
  const records = await listDeviceAttachTokens();
  return makeResponse(req.requestId, 'list_attach_tokens', null, true, {
    tokens: records.map((r) => ({
      tokenId: r.tokenId,
      parentTokenId: r.parentTokenId,
      boundOrigin: r.boundOrigin,
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt,
    })),
    ttlMs: getAttachTokenTtlMs(),
  });
}

/**
 * `list_devices` returns one row per tokenId that currently has at
 * least one open WS connection. Tokens with zero live connections
 * still appear in `list_tokens` (the file-backed view) but are
 * intentionally absent here — this surface is "who's connected right
 * now," not "who has ever been paired."
 */
async function handleListDevices(req, _emitEvent, context) {
  if (context?.record || context?.auth) return refuseFromWs(req, 'list_devices');
  // If the WS listener never started (PUSHD_WS=0 or startup failure),
  // surface that explicitly rather than reporting an empty list — an
  // empty list under a disabled listener would be misleading.
  if (!activeWsHandle) {
    return makeResponse(req.requestId, 'list_devices', null, true, {
      devices: [],
      wsListenerActive: false,
    });
  }
  const liveRows = activeWsHandle.listConnectedDevices();
  // Cross-reference with the tokens file so we can render boundOrigin /
  // lastUsedAt that may have been updated since the WS handshake (the
  // `lastUsedAt` touch is async and the WS-side `record` is captured
  // at connection time). This is best-effort; if the file read fails
  // we fall back to the WS-side values.
  let fileRecords: DeviceTokenRecord[] = [];
  try {
    fileRecords = await listDeviceTokens();
  } catch {
    // non-fatal
  }
  const fileByTokenId = new Map(fileRecords.map((r) => [r.tokenId, r]));
  const devices = liveRows.map((row) => {
    const fileRecord = fileByTokenId.get(row.tokenId);
    return {
      tokenId: row.tokenId,
      boundOrigin: row.boundOrigin,
      connections: row.connections,
      // Slice 2: expose the split so CLI/UI consumers can flag
      // "device token still in use" — that means pairing hasn't yet
      // upgraded to an attach token and the durable bearer is still
      // active in the browser.
      attachConnections: row.attachConnections,
      deviceConnections: row.deviceConnections,
      lastUsedAt: fileRecord?.lastUsedAt ?? row.lastUsedAt,
    };
  });
  return makeResponse(req.requestId, 'list_devices', null, true, {
    devices,
    wsListenerActive: true,
  });
}

function resolveDaemonRuntimeConfigPayload(config) {
  const execMode =
    normalizeDaemonExecMode(process.env.PUSH_EXEC_MODE) ||
    normalizeDaemonExecMode(config.execMode) ||
    'auto';
  const webSearchBackend =
    normalizeDaemonWebSearchBackend(process.env.PUSH_WEB_SEARCH_BACKEND) ||
    normalizeDaemonWebSearchBackend(config.webSearchBackend) ||
    'auto';
  return {
    execMode,
    approvalMode: daemonExecModeToApprovalMode(execMode),
    webSearchBackend,
    configPath: getConfigPath(),
  };
}

/**
 * Read daemon-owned runtime controls for paired web clients. Unlike repo-mode
 * controls, these values are resolved from the daemon process itself (env first,
 * then ~/.push/config.json) because Remote turns execute on this machine, not
 * in the browser.
 */
async function handleGetDaemonRuntimeConfig(req) {
  let config;
  try {
    config = await loadConfig();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return makeErrorResponse(req.requestId, req.type, 'CONFIG_READ_FAILED', message);
  }
  return makeResponse(
    req.requestId,
    req.type,
    null,
    true,
    resolveDaemonRuntimeConfigPayload(config),
  );
}

/**
 * Persist daemon runtime controls and update the live process env so the next
 * turn sees the new setting immediately. Accepts the Unix-socket admin
 * transport and a direct loopback WS connection — both are the operator, on
 * this machine. Refuses true relay callers: unlike a session-scoped verb, this
 * mutates the daemon's GLOBAL execution safety posture (including `yolo`,
 * which disables approval prompts) for every future turn on this daemon, not
 * just the caller's own session — a stolen/leaked Remote-pairing bearer
 * should not be able to downgrade it from across the internet.
 */
async function handleSetDaemonRuntimeConfig(req, _emitEvent, context) {
  if (context?.auth?.boundOrigin === 'relay') {
    return makeErrorResponse(
      req.requestId,
      req.type,
      'UNSUPPORTED_VIA_TRANSPORT',
      'set_daemon_runtime_config is not available over the Remote relay — use a direct loopback connection or the Unix-socket admin transport.',
    );
  }

  const rawPatch =
    req.payload?.patch && typeof req.payload.patch === 'object' && !Array.isArray(req.payload.patch)
      ? req.payload.patch
      : req.payload && typeof req.payload === 'object' && !Array.isArray(req.payload)
        ? req.payload
        : null;
  if (!rawPatch) {
    return makeErrorResponse(
      req.requestId,
      req.type,
      'INVALID_REQUEST',
      'patch must be a non-null object with optional { execMode, webSearchBackend }',
    );
  }

  const hasExecMode = Object.prototype.hasOwnProperty.call(rawPatch, 'execMode');
  const hasWebSearchBackend = Object.prototype.hasOwnProperty.call(rawPatch, 'webSearchBackend');
  if (!hasExecMode && !hasWebSearchBackend) {
    return makeErrorResponse(
      req.requestId,
      req.type,
      'INVALID_REQUEST',
      'patch must include execMode or webSearchBackend',
    );
  }

  const execMode = hasExecMode ? normalizeDaemonExecMode(rawPatch.execMode) : null;
  if (hasExecMode && !execMode) {
    return makeErrorResponse(
      req.requestId,
      req.type,
      'INVALID_REQUEST',
      `execMode must be one of: ${DAEMON_EXEC_MODES.join(', ')}`,
    );
  }

  const webSearchBackend = hasWebSearchBackend
    ? normalizeDaemonWebSearchBackend(rawPatch.webSearchBackend)
    : null;
  if (hasWebSearchBackend && !webSearchBackend) {
    return makeErrorResponse(
      req.requestId,
      req.type,
      'INVALID_REQUEST',
      `webSearchBackend must be one of: ${DAEMON_WEB_SEARCH_BACKENDS.join(', ')}`,
    );
  }

  let config;
  try {
    config = await loadConfig();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return makeErrorResponse(req.requestId, req.type, 'CONFIG_READ_FAILED', message);
  }

  const next = { ...config };
  if (execMode) {
    next.execMode = execMode;
  }
  if (webSearchBackend) {
    next.webSearchBackend = webSearchBackend;
  }

  try {
    await saveConfig(next);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return makeErrorResponse(req.requestId, req.type, 'CONFIG_WRITE_FAILED', message);
  }

  if (execMode) process.env.PUSH_EXEC_MODE = execMode;
  if (webSearchBackend) process.env.PUSH_WEB_SEARCH_BACKEND = webSearchBackend;

  void appendAuditEvent({
    type: 'daemon.set_runtime_config',
    ...auditProvenance(context),
    payload: {
      boundOrigin: context?.auth?.boundOrigin,
      ...(execMode ? { execMode } : {}),
      ...(webSearchBackend ? { webSearchBackend } : {}),
    },
  });

  return makeResponse(req.requestId, req.type, null, true, resolveDaemonRuntimeConfigPayload(next));
}

/**
 * Read-only catalog of providers this daemon can route to, with curated
 * models per provider. Powers Remote's model picker — the web
 * client has no other way to know what's actually configured on THIS
 * machine (which providers have a working key, what models to offer)
 * versus its own browser-local provider config, which is irrelevant to a
 * daemon-executed turn. Safe over relay: `hasKey` is a boolean, never the
 * key itself (mirrors `getProviderList`'s own posture).
 */
async function handleListProviders(req) {
  const providers = getProviderList().map((p) => ({
    ...p,
    models: getCuratedModels(p.id),
  }));
  return makeResponse(req.requestId, req.type, null, true, { providers });
}

/**
 * Re-read `~/.push/config.json` and force its provider keys/urls/models into
 * the daemon's `process.env`, overwriting stale values. The TUI fires this
 * after a config edit (e.g. rotating a provider API key): the daemon resolves
 * keys live from `process.env` per run (`resolveApiKey`), but inherited its env
 * at spawn, so without this a long-lived daemon keeps serving the old key while
 * `config.json` already shows the new one. No values cross the wire — the verb
 * only triggers a re-read of the local on-disk file, so it's safe over relay.
 */
async function handleReloadConfig(req) {
  let config;
  try {
    config = await loadConfig();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `${JSON.stringify({ level: 'error', event: 'pushd_config_reload_failed', message })}\n`,
    );
    return makeErrorResponse(req.requestId, req.type, 'CONFIG_READ_FAILED', message);
  }
  const refreshed = reapplyProviderConfigToEnv(config);
  process.stderr.write(
    `${JSON.stringify({
      level: 'info',
      event: 'pushd_config_reloaded',
      refreshedCount: refreshed.length,
      // env var NAMES only (e.g. PUSH_ZEN_API_KEY) — never the secret values.
      refreshed,
    })}\n`,
  );
  return makeResponse(req.requestId, req.type, null, true, { refreshed });
}

// ─── Request dispatcher ──────────────────────────────────────────

const HANDLERS = {
  hello: handleHello,
  ping: handlePing,
  list_sessions: handleListSessions,
  start_session: handleStartSession,
  send_user_message: handleSendUserMessage,
  attach_session: handleAttachSession,
  get_session_messages: handleGetSessionMessages,
  get_session_snapshot: handleGetSessionSnapshot,
  update_session: handleUpdateSession,
  submit_approval: handleSubmitApproval,
  cancel_run: handleCancelRun,
  drain: handleDrain,
  abort: handleAbort,
  configure_role_routing: handleConfigureRoleRouting,
  submit_task_graph: handleSubmitTaskGraph,
  delegate_explorer: handleDelegateExplorer,
  delegate_coder: handleDelegateCoder,
  delegate_reviewer: handleDelegateReviewer,
  delegate_deep_reviewer: handleDelegateDeepReviewer,
  cancel_delegation: handleCancelDelegation,
  fetch_delegation_events: handleFetchDelegationEvents,
  list_children: handleListChildren,
  get_child_session: handleGetChildSession,
  session_summarize: handleSessionSummarize,
  session_revert: handleSessionRevert,
  session_unrevert: handleSessionUnrevert,
  sandbox_exec: handleSandboxExec,
  sandbox_read_file: handleSandboxReadFile,
  sandbox_write_file: handleSandboxWriteFile,
  sandbox_list_dir: handleSandboxListDir,
  sandbox_diff: handleSandboxDiff,
  daemon_identify: handleDaemonIdentify,
  revoke_device_token: handleRevokeDeviceToken,
  list_devices: handleListDevices,
  mint_device_attach_token: handleMintDeviceAttachToken,
  revoke_device_attach_token: handleRevokeDeviceAttachToken,
  list_attach_tokens: handleListAttachTokens,
  relay_enable: handleRelayEnable,
  relay_disable: handleRelayDisable,
  relay_status: handleRelayStatus,
  mint_remote_pair_bundle: handleMintRemotePairBundle,
  grant_session_attach: handleGrantSessionAttach,
  get_daemon_runtime_config: handleGetDaemonRuntimeConfig,
  set_daemon_runtime_config: handleSetDaemonRuntimeConfig,
  list_providers: handleListProviders,
  reload_config: handleReloadConfig,
};

export async function handleRequest(req, emitEvent, context = null) {
  if (!req || req.v !== PROTOCOL_VERSION) {
    return makeErrorResponse(
      req?.requestId || makeRequestId(),
      req?.type || 'unknown',
      'UNSUPPORTED_PROTOCOL_VERSION',
      `Expected ${PROTOCOL_VERSION}, got ${req?.v}`,
    );
  }

  if (req.kind !== 'request') {
    return makeErrorResponse(
      req.requestId || makeRequestId(),
      req.type || 'unknown',
      'INVALID_REQUEST',
      `Expected kind "request", got "${req.kind}"`,
    );
  }

  const handler = HANDLERS[req.type];
  if (!handler) {
    return makeErrorResponse(
      req.requestId,
      req.type,
      'UNSUPPORTED_REQUEST_TYPE',
      `Unknown request type: ${req.type}`,
    );
  }

  let response;
  try {
    response = await handler(req, emitEvent, context);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    response = makeErrorResponse(req.requestId, req.type, 'INTERNAL_ERROR', message);
  }
  // Phase 3 slice 3: dispatcher-level audit emission for the
  // request types whose handlers don't already emit themselves.
  // The sandbox_exec / mint / revoke handlers emit at a finer
  // grain (they know exit codes / closed-connection counts), so
  // they're excluded here. Auth.upgrade is emitted in pushd-ws on
  // connection. Everything else flows through this wrapper so we
  // don't have to thread audit calls through every handler body.
  try {
    emitDispatcherAudit(req, response, context);
  } catch {
    // audit never throws into the response path
  }
  return response;
}

// ─── Connection handling ─────────────────────────────────────────

function handleConnection(socket) {
  // A local client connected — count it and abort any pending lifecycle exit so
  // a transient disconnect / self-heal respawn never kills a daemon back in use.
  noteLifecycleClientConnected();
  let buffer = '';
  const attachedSessions = new Set(); // track which sessions this socket is observing
  // Remember the capabilities the client most recently advertised at
  // attach-time so that a later auto-attach (start_session /
  // send_user_message on the same socket) inherits them. Without this
  // a client that sends `start_session` or `send_user_message` with
  // capabilities but no prior `attach_session` would have the
  // auto-attach register it as a v1 client, and delegation events
  // would get synthesized into `assistant_token`s even though the
  // client is v2-capable (codex P1 feedback on PR #281).
  //
  // Capabilities are pinned on the FIRST observed request that
  // carries a `capabilities` array — any request type (attach_session,
  // start_session, send_user_message). Subsequent requests with
  // capability arrays are ignored to prevent a client from flipping
  // between v1/v2 behaviour mid-connection, which would change how
  // delegation events route for clients attached via auto-attach.
  // `null` sentinel means "not yet observed"; once pinned the value
  // persists until the socket closes.
  let socketCapabilities = null;

  const emitEvent = (event) => {
    try {
      socket.write(JSON.stringify(event) + '\n');
    } catch {
      // connection may have closed
    }
  };

  socket.on('data', async (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const req = JSON.parse(line);
        // Pin capabilities on first-observed request of ANY type that
        // carries a `capabilities` array. This covers:
        //   - explicit `attach_session` (the documented path)
        //   - `start_session` (first request on a fresh socket)
        //   - `send_user_message` (clients that only ever send turns)
        //   - `hello` (capability negotiation handshake)
        // The second-and-later capability arrays are ignored — pin-on-
        // first keeps the socket's classification stable for the
        // lifetime of the connection so delegation-event routing can't
        // flip mid-session.
        if (socketCapabilities === null && Array.isArray(req.payload?.capabilities)) {
          socketCapabilities = req.payload.capabilities;
        }
        const response = await handleRequest(req, emitEvent);
        socket.write(JSON.stringify(response) + '\n');

        // Track attach for cleanup on disconnect
        if (req.type === 'attach_session' && response.ok) {
          attachedSessions.add(req.payload?.sessionId);
        }
        // Auto-attach when starting a session or sending a message
        if ((req.type === 'start_session' || req.type === 'send_user_message') && response.ok) {
          const sid =
            response.sessionId ||
            response.payload?.sessionId ||
            req.sessionId ||
            req.payload?.sessionId;
          if (sid) {
            addSessionClient(sid, emitEvent, socketCapabilities);
            attachedSessions.add(sid);
          }
        }
      } catch (err) {
        const errResponse = makeErrorResponse(
          makeRequestId(),
          'unknown',
          'INVALID_REQUEST',
          `Failed to parse request: ${err.message}`,
        );
        socket.write(JSON.stringify(errResponse) + '\n');
      }
    }
  });

  // close and error can both fire for one socket — decrement exactly once, then
  // re-evaluate the lifecycle exit (last client gone → arm the grace window).
  let connectionClosed = false;
  const cleanupConnection = () => {
    if (connectionClosed) return;
    connectionClosed = true;
    for (const sessionId of attachedSessions) {
      removeSessionClient(sessionId, emitEvent);
    }
    attachedSessions.clear();
    noteLifecycleClientDisconnected();
  };

  socket.on('close', cleanupConnection);
  socket.on('error', cleanupConnection);
}

// ─── Crash recovery ──────────────────────────────────────────────

/**
 * Scan for sessions with run markers (interrupted by daemon crash).
 * For each, check restart policy and optionally re-enter the assistant loop.
 *
 * Recovery injects a [SESSION_RECOVERED] reconciliation message so the model
 * knows context was interrupted and can adjust.
 */
/**
 * Scan a session event log and return delegations/task-graphs that were
 * tied to the given parent run but never reached a terminal event. Used by
 * crash recovery to build the `[DELEGATION_INTERRUPTED]` reconciliation note.
 *
 * A subagent delegation is "orphaned" if there is a `subagent.started` event
 * whose `payload.parentRunId === parentRunId` AND no matching
 * `subagent.completed` / `subagent.failed` for the same `subagentId`.
 *
 * A task graph is "orphaned" if there is any `task_graph.*` event whose
 * envelope `runId === parentRunId` AND no matching `task_graph.graph_completed`
 * for the same `executionId`.
 *
 * We deliberately restrict to events bound to the interrupted parent run —
 * older fire-and-forget failures from prior runs are not this recovery's
 * problem.
 */
export function collectOrphanedDelegations(events, parentRunId) {
  const startedSubagents = new Map(); // subagentId -> { agent }
  const terminatedSubagents = new Set(); // subagentId
  const seenGraphs = new Map(); // executionId -> true
  const completedGraphs = new Set(); // executionId

  for (const event of events) {
    if (!event || typeof event.type !== 'string') continue;
    const payload = event.payload || {};

    if (event.type === 'subagent.started') {
      if (payload.parentRunId !== parentRunId) continue;
      const subagentId = typeof payload.subagentId === 'string' ? payload.subagentId : null;
      if (!subagentId) continue;
      startedSubagents.set(subagentId, {
        agent: typeof payload.agent === 'string' ? payload.agent : 'subagent',
      });
      continue;
    }
    if (event.type === 'subagent.completed' || event.type === 'subagent.failed') {
      const subagentId = typeof payload.subagentId === 'string' ? payload.subagentId : null;
      if (subagentId) terminatedSubagents.add(subagentId);
      continue;
    }
    if (event.type.startsWith('task_graph.')) {
      if (event.runId !== parentRunId) continue;
      const executionId = typeof payload.executionId === 'string' ? payload.executionId : null;
      if (!executionId) continue;
      if (event.type === 'task_graph.graph_completed') {
        completedGraphs.add(executionId);
      } else {
        seenGraphs.set(executionId, true);
      }
      continue;
    }
  }

  const orphanedSubagents = [];
  for (const [subagentId, meta] of startedSubagents) {
    if (!terminatedSubagents.has(subagentId)) {
      orphanedSubagents.push({ subagentId, agent: meta.agent });
    }
  }

  const orphanedGraphs = [];
  for (const [executionId] of seenGraphs) {
    if (!completedGraphs.has(executionId)) {
      orphanedGraphs.push({ executionId });
    }
  }

  return { subagents: orphanedSubagents, graphs: orphanedGraphs };
}

/**
 * Build the `[DELEGATION_INTERRUPTED]` reconciliation note injected into the
 * message history on recovery. Returns null if nothing was orphaned.
 */
export function formatDelegationInterruptedNote(orphans) {
  const { subagents, graphs } = orphans;
  if (subagents.length === 0 && graphs.length === 0) return null;
  const lines = ['[DELEGATION_INTERRUPTED]'];
  lines.push(
    'One or more sub-agents launched during the interrupted run never reported a terminal result.',
  );
  if (subagents.length > 0) {
    lines.push('Unfinished delegations:');
    for (const { subagentId, agent } of subagents) {
      lines.push(`  - ${agent} (${subagentId})`);
    }
  }
  if (graphs.length > 0) {
    lines.push('Unfinished task graphs:');
    for (const { executionId } of graphs) {
      lines.push(`  - ${executionId}`);
    }
  }
  lines.push(
    'Assume their work is lost. If you still need their results, re-delegate explicitly — do not wait for ghost completions.',
  );
  lines.push('[/DELEGATION_INTERRUPTED]');
  return lines.join('\n');
}

async function recoverInterruptedRuns() {
  let interrupted;
  try {
    interrupted = await scanInterruptedSessions();
  } catch {
    return; // scan failure is non-fatal
  }

  if (interrupted.length === 0) return;
  process.stdout.write(`crash recovery: found ${interrupted.length} interrupted session(s)\n`);

  for (const { sessionId, marker } of interrupted) {
    let state;
    try {
      state = await loadSessionState(sessionId);
    } catch {
      // Can't load state — clear stale marker and skip
      await clearRunMarker(sessionId).catch(() => {});
      process.stdout.write(`  ${sessionId}: state unreadable, clearing marker\n`);
      continue;
    }

    const policy = getRestartPolicy(state);
    if (!shouldRecover(policy, marker)) {
      await clearRunMarker(sessionId).catch(() => {});
      const reason = policy === 'never' ? 'policy=never' : 'marker too old';
      process.stdout.write(`  ${sessionId}: skipped (${reason})\n`);

      // Log that we skipped recovery
      await appendSessionEvent(state, 'recovery_skipped', {
        originalRunId: marker.runId,
        reason,
        policy,
        markerAge: Date.now() - (marker.startedAt || 0),
      }).catch(() => {});
      await saveSessionState(state).catch(() => {});
      continue;
    }

    // Resolve provider + API key
    const providerConfig = PROVIDER_CONFIGS[state.provider];
    if (!providerConfig) {
      await clearRunMarker(sessionId).catch(() => {});
      process.stdout.write(
        `  ${sessionId}: unknown provider "${state.provider}", clearing marker\n`,
      );
      continue;
    }

    let apiKey;
    try {
      apiKey = resolveApiKey(providerConfig);
    } catch {
      await clearRunMarker(sessionId).catch(() => {});
      process.stdout.write(`  ${sessionId}: no API key for "${state.provider}", clearing marker\n`);
      continue;
    }

    const recoveryRunId = makeRunId();
    const abortController = new AbortController();
    // Restore the persisted attach token so a client that had the session
    // open before the crash can successfully re-attach with the SAME token
    // they originally received from `start_session`. A legacy session with no
    // persisted token is claimed on its first `attach_session` (bootstrap
    // grace); the implicit tokenless bypass is gone (Universal Session Bearer).
    const attachToken = state.attachToken;

    // Register in-memory
    const entry = { state, attachToken, activeRunId: recoveryRunId, abortController };
    activeSessions.set(sessionId, entry);

    // Crash recovery is narrow: we recover the parent only. Any sub-agents or
    // task graphs that were in-flight when the daemon died are lost. Detect
    // them from the event log and fold a DELEGATION_INTERRUPTED note into the
    // recovery turn so the recovered lead re-delegates rather than waiting on
    // ghost completions that will never arrive.
    let orphans = { subagents: [], graphs: [] };
    try {
      const events = await loadSessionEvents(sessionId);
      orphans = collectOrphanedDelegations(events, marker.runId);
    } catch {
      // Event-log scan is best-effort — if we can't read it, skip the note.
    }
    const interruptedNote = formatDelegationInterruptedNote(orphans);

    // Inject reconciliation as a SINGLE recovery turn — the kernel lane runs it
    // as the lead's `userText`, so the recovery note + the interrupted note must
    // be one message (a second would render as clipped "prior conversation"
    // rather than the task).
    const recoveryUserText = [
      `[SESSION_RECOVERED]\nThe previous run (${marker.runId}) was interrupted by a daemon crash.\nYou are resuming in a new run (${recoveryRunId}). Review your working memory and continue where you left off.\nDo NOT restart from scratch — pick up from the last completed step.\n[/SESSION_RECOVERED]`,
      interruptedNote,
    ]
      .filter(Boolean)
      .join('\n\n');
    state.messages.push({ role: 'user', content: recoveryUserText });
    if (interruptedNote) {
      await appendSessionEvent(state, 'delegation_interrupted', {
        originalRunId: marker.runId,
        recoveryRunId,
        subagents: orphans.subagents,
        graphs: orphans.graphs,
      }).catch(() => {});
    }

    await appendSessionEvent(state, 'run_recovered', {
      originalRunId: marker.runId,
      recoveryRunId,
      policy,
      markerAge: Date.now() - (marker.startedAt || 0),
    }).catch(() => {});

    process.stdout.write(`  ${sessionId}: recovering run ${marker.runId} → ${recoveryRunId}\n`);

    // Clear old marker and write new one for the recovery run
    await clearRunMarker(sessionId).catch(() => {});
    await writeRunMarker(sessionId, recoveryRunId, {
      provider: state.provider,
      model: state.model,
      cwd: state.cwd,
      recoveredFrom: marker.runId,
    }).catch(() => {});

    // Build approval gate so recovered runs can request client approvals
    const approvalFn = buildApprovalFn(sessionId, entry, recoveryRunId);

    // Launch recovery run in background (same pattern as handleSendUserMessage)
    (async () => {
      let sawError = false;
      let sawRunComplete = false;
      try {
        await runAssistantTurn(
          state,
          providerConfig,
          apiKey,
          recoveryUserText,
          DEFAULT_MAX_ROUNDS,
          {
            runId: recoveryRunId,
            // Fixed cap on daemon turns — see handleSendUserMessage; adaptation
            // stays off until the client cap is threaded through the daemon.
            explicitMaxRounds: true,
            approvalFn,
            signal: abortController.signal,
            emit: (event) => {
              const seq = state.eventSeq;
              if (event.type === 'error') sawError = true;
              if (event.type === 'run_complete') sawRunComplete = true;

              broadcastEvent(sessionId, {
                v: PROTOCOL_VERSION,
                kind: 'event',
                sessionId: event.sessionId,
                runId: event.runId,
                seq,
                ts: Date.now(),
                type: event.type,
                payload: event.payload,
              });
            },
          },
        );
        await saveSessionState(state);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!sawError) {
          await appendSessionEvent(
            state,
            'error',
            { code: 'RECOVERY_ERROR', message, retryable: false },
            recoveryRunId,
          ).catch(() => {});
          broadcastEvent(sessionId, {
            v: PROTOCOL_VERSION,
            kind: 'event',
            sessionId,
            runId: recoveryRunId,
            seq: state.eventSeq,
            ts: Date.now(),
            type: 'error',
            payload: { code: 'RECOVERY_ERROR', message, retryable: false },
          });
        }
        if (!sawRunComplete) {
          await appendSessionEvent(
            state,
            'run_complete',
            { runId: recoveryRunId, outcome: 'failed', summary: message.slice(0, 500) },
            recoveryRunId,
          ).catch(() => {});
          broadcastEvent(sessionId, {
            v: PROTOCOL_VERSION,
            kind: 'event',
            sessionId,
            runId: recoveryRunId,
            seq: state.eventSeq,
            ts: Date.now(),
            type: 'run_complete',
            payload: { outcome: 'failed', summary: message.slice(0, 500) },
          });
        }
        await saveSessionState(state).catch(() => {});
      } finally {
        entry.activeRunId = null;
        entry.abortController = null;
        if (entry.pendingApproval) {
          clearTimeout(entry.pendingApproval.timer);
          entry.pendingApproval = null;
        }
        clearRunMarker(sessionId).catch(() => {});
      }
    })();
  }
}

// ─── Main ────────────────────────────────────────────────────────

export async function main() {
  const socketPath = getSocketPath();
  await ensureSocketDir(socketPath);
  await cleanStaleSocket(socketPath);

  // Freeze the build stamp at startup so it reflects the commit THIS process
  // loaded — captured now, before any client can connect, so the first hello
  // advertises a stamp synchronously via `peekBuildStamp()`.
  getBuildStamp().catch(() => {
    /* stamp falls back to <version>+nogit on failure; never fatal */
  });

  // Wire a file-backed ContextMemoryStore so typed memory records
  // written by task-graph node completions (see handleSubmitTaskGraph)
  // persist across pushd restarts. The in-memory default would lose
  // all history on SIGTERM/restart, which defeats the "memory" in
  // typed memory. See Gap 3 Step 3 in the Architecture Remediation
  // Plan for context.
  setDefaultMemoryStore(createFileMemoryStore({ baseDir: getMemoryStoreBaseDir() }));
  // LCM Phase 3: durable verbatim log (twin of the typed store above) so the
  // full original behind a record's verbatimRef survives restarts.
  setDefaultVerbatimLog(createFileVerbatimLog({ baseDir: getVerbatimLogBaseDir() }));
  installCliEmbeddingProvider();

  const server = net.createServer(handleConnection);

  const oldUmask = process.umask(0o077);
  server.listen(socketPath, () => {
    process.umask(oldUmask);
    process.stdout.write(`pushd listening on ${socketPath}\n`);
    process.stdout.write(`protocol: ${PROTOCOL_VERSION}\n`);
    process.stdout.write(`version: ${VERSION}\n`);
    process.stdout.write(`pid: ${process.pid}\n`);
  });

  let wsHandle: PushdWsHandle | null = null;

  server.on('listening', async () => {
    try {
      await writePidFile();
      if (!isNamedPipePath(socketPath)) {
        await fs.chmod(socketPath, 0o600);
      }
    } catch {
      // non-fatal
    }

    // Optional WebSocket listener for browser clients (PR 1 of the
    // remote-sessions track). Loopback-only, token + Origin gated.
    // Dormant unless PUSHD_WS=1.
    if (isWsListenerEnabled()) {
      try {
        wsHandle = await startPushdWs(
          {
            handleRequest,
            addSessionClient,
            removeSessionClient,
            makeErrorResponse,
            makeRequestId,
            onClientConnected: noteLifecycleClientConnected,
            onClientDisconnected: noteLifecycleClientDisconnected,
          },
          { portFilePath: getPortPath() },
        );
        activeWsHandle = wsHandle;
        process.stdout.write(`pushd-ws listening on 127.0.0.1:${wsHandle.port}\n`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`pushd-ws failed to start: ${msg}\n`);
      }
    }

    // Phase 2.e: if a relay config is persisted, dial the Worker.
    // Independent of PUSHD_WS — the relay is the OUTBOUND path,
    // PUSHD_WS gates the INBOUND loopback listener.
    //
    // Hash-allowlist hardening: rebuild the in-process allowlist from
    // the persisted attach-token store BEFORE starting the relay
    // client. The relay client's first `onOpen` fires the full
    // `relay_phone_allow` re-emit; if the registry hadn't been
    // seeded yet, that re-emit would be empty and every paired phone
    // would lose forwarding access across the restart.
    try {
      const seeded = await seedRelayAllowlistFromAttachTokens();
      if (seeded > 0) {
        process.stdout.write(`pushd-relay allowlist seeded from ${seeded} attach token(s)\n`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`pushd-relay allowlist seed failed: ${msg}\n`);
    }
    try {
      const relayConfig = await readRelayConfig();
      if (relayConfig) {
        activeRelayClient = startRelayClient(relayConfig);
        activeRelayDeploymentUrl = relayConfig.deploymentUrl;
        process.stdout.write(`pushd-relay dialing ${relayConfig.deploymentUrl}\n`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`pushd-relay startup failed: ${msg}\n`);
    }

    // Recover interrupted runs from previous crash
    try {
      await recoverInterruptedRuns();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`crash recovery failed: ${msg}\n`);
    }
  });

  const shutdown = async () => {
    process.stdout.write('\nshutting down...\n');

    // Abort all active runs
    for (const [, entry] of activeSessions) {
      if (entry.abortController) {
        entry.abortController.abort();
      }
      if (entry.pendingApproval) {
        clearTimeout(entry.pendingApproval.timer);
        entry.pendingApproval.resolve('deny');
      }
    }

    // Phase 2.e: close the outbound relay first so any in-flight
    // `relay_phone_*` envelope finishes flushing before the daemon
    // tears down the WS listener that mint/revoke hangs off.
    stopRelayClient();

    if (wsHandle) {
      try {
        await wsHandle.close();
      } catch {
        /* ignore */
      }
      activeWsHandle = null;
    }

    server.close();
    await cleanStaleSocket(socketPath);
    await cleanPidFile();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  server.on('error', (err) => {
    process.stderr.write(`Server error: ${err.message}\n`);
    process.exit(1);
  });
}

// Only run main() when executed directly (not when imported).
// Matches the entry basename `pushd` with any of the extensions we ship
// under (`.ts` via tsx for dev/tests, `.js`/`.mjs`/`.cjs` for compiled
// output produced by `npm run build:cli`). Handles POSIX (`/`) and
// Windows (`\\`) path separators so a packaged daemon binary on either
// platform still boots.
const isDirectRun =
  typeof process.argv[1] === 'string' && /[/\\]pushd\.(ts|mjs|cjs|js)$/.test(process.argv[1]);

if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`Fatal: ${err.message}\n`);
    process.exit(1);
  });
}
