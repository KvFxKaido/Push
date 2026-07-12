/**
 * daemon-admin.ts — shared daemon admin RPC + remote/relay command logic.
 *
 * Used by the Silvery TUI control plane (and any other surface that needs the
 * same relay/pairing verbs without embedding the 7k-line ANSI printer).
 * The daemon transport is optional: when no session is attached, RPCs fall
 * back to a short-lived socket connect against the local pushd socket.
 */

import { tryConnect } from './daemon-client.js';
import {
  deleteRelayConfig,
  isValidRelayToken,
  readRelayConfig,
  writeRelayConfig,
} from './pushd-relay-config.js';
import { getSocketPath } from './pushd.js';
import type { DaemonClientLike } from './tui-daemon-session.js';

export type ReportLevel = 'status' | 'warning' | 'error';
export type ReportFn = (level: ReportLevel, text: string) => void;

export interface DaemonAdminTransport {
  connected: boolean;
  sessionId: string | null;
  attachToken: string | null;
  client: DaemonClientLike | null;
  ensureConnected: (opts?: { announce?: boolean }) => Promise<boolean>;
  ensureSession: () => Promise<void>;
  ensureReady: () => Promise<boolean>;
  adoptAttachToken?: (token: string) => void;
  autoStartAttempted?: boolean;
}

export interface DaemonAdminResponse {
  ok: boolean;
  payload?: Record<string, unknown>;
  code?: string;
  error?: string;
}

export async function requestDaemonAdmin(
  daemon: DaemonAdminTransport | null | undefined,
  type: string,
  payload: Record<string, unknown> = {},
  { timeoutMs = 2000, startDaemon = false }: { timeoutMs?: number; startDaemon?: boolean } = {},
): Promise<DaemonAdminResponse> {
  if (daemon && !daemon.connected && startDaemon) {
    await daemon.ensureConnected({ announce: false });
  }

  if (daemon?.connected && daemon.client) {
    try {
      const response = await daemon.client.request(type, payload, null, timeoutMs);
      return {
        ok: Boolean(response.ok),
        payload: (response.payload as Record<string, unknown>) || {},
      };
    } catch (err) {
      const error = err as { code?: string; message?: string };
      return {
        ok: false,
        code: error.code || 'UNKNOWN',
        error: error.message || String(err),
      };
    }
  }

  const client = await tryConnect(getSocketPath(), 500);
  if (!client) return { ok: false, code: 'DAEMON_OFFLINE', error: 'daemon not running' };
  try {
    const response = await client.request(type, payload, null, timeoutMs);
    return {
      ok: Boolean(response.ok),
      payload: (response.payload as Record<string, unknown>) || {},
    };
  } catch (err) {
    const error = err as { code?: string; message?: string };
    return {
      ok: false,
      code: error.code || 'UNKNOWN',
      error: error.message || String(err),
    };
  } finally {
    client.close();
  }
}

export function formatRelayStatusLines(
  payload: Record<string, unknown> | null | undefined,
  { offline = false }: { offline?: boolean } = {},
): string[] {
  const persisted =
    payload?.persisted && typeof payload.persisted === 'object'
      ? (payload.persisted as Record<string, unknown>)
      : null;
  const live =
    payload?.live && typeof payload.live === 'object'
      ? (payload.live as Record<string, unknown>)
      : null;
  if (!persisted) {
    return [`Remote relay: disabled${offline ? ' (daemon offline)' : ''}`];
  }

  const lines = [
    `Remote relay: enabled${offline ? ' (daemon offline)' : ''}`,
    `  deployment: ${String(persisted.deploymentUrl ?? '')}`,
  ];
  if (persisted.enabledAt) {
    lines.push(`  enabled at: ${new Date(Number(persisted.enabledAt)).toISOString()}`);
  }
  if (live?.running) {
    lines.push(`  client: running`);
    lines.push(`  state: ${String(live.state || 'unknown')}`);
    if (typeof live.attempt === 'number' && live.attempt > 0) {
      lines.push(`  attempt: ${live.attempt}`);
    }
    if (live.exhausted) lines.push(`  exhausted: true`);
    if (live.closeCode !== null && live.closeCode !== undefined) {
      lines.push(`  last close: ${live.closeCode} ${live.closeReason || ''}`.trimEnd());
    }
    if (live.fatal) {
      lines.push("  ⚠ won't retry — fix the cause above, then re-run `/remote enable`");
    }
    if (typeof live.allowlistSize === 'number') {
      lines.push(`  allowlist: ${live.allowlistSize} attach token(s)`);
    }
  } else if (!offline) {
    lines.push(`  client: not running`);
  }
  return lines;
}

export async function resolveRelayEnableArgs(parts: string[]): Promise<{
  deploymentUrl?: string;
  token?: string;
}> {
  const first = parts[1];
  const second = parts[2];
  let explicitUrl: string | undefined;
  let explicitToken: string | undefined;
  if (first && second) {
    explicitUrl = first;
    explicitToken = second;
  } else if (first) {
    if (isValidRelayToken(first)) {
      explicitToken = first;
    } else {
      explicitUrl = first;
    }
  }
  const persisted = explicitUrl && explicitToken ? null : await readRelayConfig();
  return {
    deploymentUrl: explicitUrl || persisted?.deploymentUrl,
    token: explicitToken || process.env.PUSH_RELAY_TOKEN?.trim(),
  };
}

async function mintPairBundleForActiveSession(
  daemon: DaemonAdminTransport,
): Promise<DaemonAdminResponse> {
  await daemon.ensureConnected({ announce: false });
  if (!daemon.connected) {
    return { ok: false, code: 'DAEMON_OFFLINE', error: 'daemon not running' };
  }
  await daemon.ensureSession();
  if (!daemon.sessionId) {
    return {
      ok: false,
      code: 'NO_DAEMON_SESSION',
      error: 'no active daemon session',
    };
  }
  return requestDaemonAdmin(
    daemon,
    'mint_remote_pair_bundle',
    {
      targetSessionId: daemon.sessionId,
      ...(daemon.attachToken ? { targetAttachToken: daemon.attachToken } : {}),
    },
    { timeoutMs: 5000 },
  );
}

function renderPairBundleLines(
  payload: Record<string, unknown>,
  daemon: DaemonAdminTransport,
  onMintedAttachToken?: (token: string) => void,
): string {
  const bundle = String(payload?.bundle || '');
  const deviceTokenId = String(payload?.deviceTokenId || '');
  const attachTokenId = String(payload?.attachTokenId || '');
  const deploymentUrl = String(payload?.deploymentUrl || '');
  const relaySessionId = String(payload?.sessionId || '');
  const targetSessionId = String(payload?.targetSessionId || daemon.sessionId || '');
  const mintedTargetAttachToken = String(payload?.mintedTargetAttachToken || '');
  if (mintedTargetAttachToken) {
    daemon.adoptAttachToken?.(mintedTargetAttachToken);
    onMintedAttachToken?.(mintedTargetAttachToken);
  }
  return [
    'Remote pairing bundle minted for this TUI session.',
    `  deployment: ${deploymentUrl || 'unknown'}`,
    `  relay route: ${relaySessionId || 'unknown'}`,
    `  target session: ${targetSessionId || 'unknown'}`,
    `  device id: ${deviceTokenId || 'unknown'}`,
    `  attach id: ${attachTokenId || 'unknown'}`,
    '',
    'Bundle (copy now - this is the only time the bearer is shown):',
    '',
    `  ${bundle}`,
    '',
    'Paste this into the phone Remote pairing screen.',
    deviceTokenId ? `Revoke this phone with: push daemon revoke ${deviceTokenId}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function relayLiveHealthy(live: Record<string, unknown> | null | undefined): boolean {
  return Boolean(
    live?.running &&
      !live.exhausted &&
      !live.fatal &&
      (live.state === 'open' || live.state === 'connecting'),
  );
}

/** `/remote …` — manage the Remote relay + phone pairing. */
export async function runRemoteCommand(
  arg: string,
  daemon: DaemonAdminTransport,
  report: ReportFn,
  opts: {
    maskSecret: (value: unknown) => string;
    onMintedAttachToken?: (token: string) => void;
  } = {
    maskSecret: (v) => String(v ?? ''),
  },
): Promise<void> {
  const parts = (arg || '').trim().split(/\s+/).filter(Boolean);
  const sub = (parts[0] || 'status').toLowerCase();

  if (sub === 'status' || sub === 'show') {
    const response = await requestDaemonAdmin(daemon, 'relay_status', {}, { timeoutMs: 1500 });
    if (response.ok) {
      report('status', formatRelayStatusLines(response.payload).join('\n'));
      return;
    }
    if (response.code === 'DAEMON_OFFLINE') {
      const cfg = await readRelayConfig();
      const payload = cfg
        ? { persisted: { deploymentUrl: cfg.deploymentUrl, enabledAt: cfg.enabledAt } }
        : { persisted: null };
      report('status', formatRelayStatusLines(payload, { offline: true }).join('\n'));
      return;
    }
    report('error', `Remote relay status failed: ${response.error || response.code || 'unknown'}`);
    return;
  }

  if (sub === 'enable') {
    const { deploymentUrl, token } = await resolveRelayEnableArgs(parts);
    if (!deploymentUrl || !token) {
      report(
        'warning',
        'Usage: /remote enable <deployment-url> <pushd_relay_...>\n' +
          '  <deployment-url> may be omitted if a relay was already configured on this machine.\n' +
          '  <pushd_relay_...> may be omitted if PUSH_RELAY_TOKEN is set in the environment.',
      );
      return;
    }
    if (!isValidRelayToken(token)) {
      report(
        'warning',
        'Remote relay token must start with pushd_relay_ and include a token body (yours looks truncated)',
      );
      return;
    }
    const response = await requestDaemonAdmin(
      daemon,
      'relay_enable',
      { deploymentUrl, token },
      { timeoutMs: 5000, startDaemon: true },
    );
    if (response.ok) {
      report('status', `Remote relay enabled: ${deploymentUrl} (${opts.maskSecret(token)})`);
      return;
    }
    if (response.code === 'DAEMON_OFFLINE') {
      try {
        await writeRelayConfig({ deploymentUrl, token });
        report(
          'status',
          `Remote relay config saved: ${deploymentUrl}. pushd will dial it on start.`,
        );
      } catch (err) {
        report(
          'error',
          `Remote relay enable failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return;
    }
    report('error', `Remote relay enable failed: ${response.error || response.code || 'unknown'}`);
    return;
  }

  if (sub === 'pair') {
    const response = await mintPairBundleForActiveSession(daemon);
    if (response.ok && response.payload) {
      report('status', renderPairBundleLines(response.payload, daemon, opts.onMintedAttachToken));
      return;
    }
    if (response.code === 'RELAY_NOT_ENABLED') {
      report(
        'warning',
        'Remote relay is not enabled. Use: /remote setup <deployment-url> <pushd_relay_...>',
      );
    } else {
      report('error', `Remote pairing failed: ${response.error || response.code || 'unknown'}`);
    }
    return;
  }

  if (sub === 'setup') {
    const { deploymentUrl, token } = await resolveRelayEnableArgs(parts);
    if (!deploymentUrl || !token) {
      report(
        'warning',
        'Usage: /remote setup <deployment-url> <pushd_relay_...>\n' +
          '  <deployment-url> may be omitted if a relay was already configured on this machine.\n' +
          '  <pushd_relay_...> may be omitted if PUSH_RELAY_TOKEN is set in the environment.',
      );
      return;
    }
    if (!isValidRelayToken(token)) {
      report(
        'warning',
        'Remote relay token must start with pushd_relay_ and include a token body (yours looks truncated)',
      );
      return;
    }
    const enableResponse = await requestDaemonAdmin(
      daemon,
      'relay_enable',
      { deploymentUrl, token },
      { timeoutMs: 5000, startDaemon: true },
    );
    if (!enableResponse.ok) {
      report(
        'error',
        `Remote relay enable failed: ${enableResponse.error || enableResponse.code || 'unknown'}`,
      );
      return;
    }
    report('status', `Remote relay enabled: ${deploymentUrl} (${opts.maskSecret(token)})`);
    const pairResponse = await mintPairBundleForActiveSession(daemon);
    if (pairResponse.ok && pairResponse.payload) {
      report(
        'status',
        renderPairBundleLines(pairResponse.payload, daemon, opts.onMintedAttachToken),
      );
      return;
    }
    report(
      'error',
      `Remote pairing failed after enabling relay: ${pairResponse.error || pairResponse.code || 'unknown'}`,
    );
    return;
  }

  if (sub === 'disable') {
    const response = await requestDaemonAdmin(daemon, 'relay_disable', {}, { timeoutMs: 3000 });
    if (response.ok) {
      const removed = Boolean(response.payload?.configRemoved);
      const stopped = Boolean(response.payload?.clientStopped);
      report(
        'status',
        `Remote relay disabled${removed ? '' : ' (no config was present)'}${stopped ? ' (closed live connection)' : ''}`,
      );
      return;
    }
    if (response.code === 'DAEMON_OFFLINE') {
      const removed = await deleteRelayConfig();
      report(
        'status',
        `Remote relay config ${removed ? 'removed' : 'was not set'} (daemon offline)`,
      );
      return;
    }
    report('error', `Remote relay disable failed: ${response.error || response.code || 'unknown'}`);
    return;
  }

  report(
    'warning',
    'Usage: /remote status | /remote setup <deployment-url> <pushd_relay_...> | /remote pair | /remote enable <deployment-url> <pushd_relay_...> | /remote disable',
  );
}

/** `/rc [pair]` — one-shot "hand this session to the phone". */
export async function runRemoteControlCommand(
  arg: string,
  daemon: DaemonAdminTransport,
  report: ReportFn,
  opts: {
    sessionName?: string;
    onMintedAttachToken?: (token: string) => void;
  } = {},
): Promise<void> {
  const sub = (arg || '').trim().toLowerCase();
  if (sub && sub !== 'pair') {
    report(
      'warning',
      'Usage: /rc  (make this session reachable on your phone) | /rc pair  (mint a bundle for a new phone)',
    );
    return;
  }

  const status = await requestDaemonAdmin(
    daemon,
    'relay_status',
    {},
    { timeoutMs: 2000, startDaemon: true },
  );
  if (!status.ok) {
    report(
      'error',
      status.code === 'DAEMON_OFFLINE'
        ? '/rc needs the pushd daemon, and it is not running (autostart may be off). Try /daemon restart, then /rc again.'
        : `Remote control failed reading relay status: ${status.error || status.code || 'unknown'}`,
    );
    return;
  }

  const persisted =
    status.payload?.persisted && typeof status.payload.persisted === 'object'
      ? (status.payload.persisted as Record<string, unknown>)
      : null;
  let live =
    status.payload?.live && typeof status.payload.live === 'object'
      ? (status.payload.live as Record<string, unknown>)
      : null;
  if (!persisted) {
    report(
      'warning',
      [
        'Remote relay is not configured yet. One-time setup:',
        '  /remote setup <deployment-url> <pushd_relay_...>',
        'After that, /rc hands any TUI session to your phone.',
      ].join('\n'),
    );
    return;
  }

  if (!relayLiveHealthy(live)) {
    const cfg = await readRelayConfig();
    if (cfg) {
      const enable = await requestDaemonAdmin(
        daemon,
        'relay_enable',
        { deploymentUrl: cfg.deploymentUrl, token: cfg.token },
        { timeoutMs: 5000 },
      );
      if (!enable.ok) {
        report(
          'error',
          `Remote control could not restart the relay client: ${enable.error || enable.code || 'unknown'}`,
        );
        return;
      }
      const refreshed = await requestDaemonAdmin(daemon, 'relay_status', {}, { timeoutMs: 2000 });
      if (refreshed.ok && refreshed.payload?.live && typeof refreshed.payload.live === 'object') {
        live = refreshed.payload.live as Record<string, unknown>;
      }
    }
    if (!relayLiveHealthy(live)) {
      const closeInfo =
        live?.closeCode !== null && live?.closeCode !== undefined
          ? ` (last close: ${live.closeCode}${live.closeReason ? ` ${live.closeReason}` : ''})`
          : '';
      report(
        'error',
        `Remote relay is not connected (state: ${live?.state || 'unknown'})${closeInfo}. Check /remote status, then /rc again.`,
      );
      return;
    }
  }

  const pairedPhones = typeof live?.allowlistSize === 'number' ? live.allowlistSize : 0;

  if (sub === 'pair' || pairedPhones === 0) {
    const response = await mintPairBundleForActiveSession(daemon);
    if (response.ok && response.payload) {
      report(
        'status',
        [
          renderPairBundleLines(response.payload, daemon, opts.onMintedAttachToken),
          '',
          'Once pasted on the phone, this session appears in the Chats drawer under Connected.',
        ].join('\n'),
      );
      return;
    }
    report(
      'error',
      response.code === 'NO_DAEMON_SESSION'
        ? 'Remote control failed: this TUI has no daemon session yet. Enable daemon autostart (/config daemon auto), then retry.'
        : `Remote control pairing failed: ${response.error || response.code || 'unknown'}`,
    );
    return;
  }

  await daemon.ensureConnected({ announce: false });
  if (daemon.connected) await daemon.ensureSession();
  if (!daemon.connected || !daemon.sessionId) {
    report(
      'warning',
      'A phone is paired, but this TUI is running inline (no daemon session), so the phone cannot see this chat. Enable daemon autostart (/config daemon auto), then /rc again.',
    );
    return;
  }

  const sessionLabel = opts.sessionName ? `"${opts.sessionName}"` : daemon.sessionId;
  report(
    'status',
    [
      `Session ${sessionLabel} is reachable from your phone.`,
      `  relay: ${live?.state || 'connected'}`,
      `  paired phones: ${pairedPhones}`,
      '  Open the Chats drawer on the phone — this session is listed under Connected; tap it to continue there.',
      '  /rc pair adds another phone.',
    ].join('\n'),
  );
}
