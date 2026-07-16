/** Daemon-global runtime controls and provider catalog handlers. */
import process from 'node:process';

import {
  DAEMON_EXEC_MODES,
  DAEMON_WEB_SEARCH_BACKENDS,
  daemonExecModeToApprovalMode,
  normalizeDaemonExecMode,
  normalizeDaemonWebSearchBackend,
} from '../../lib/daemon-runtime-settings.ts';
import {
  getConfigPath,
  loadConfig,
  reapplyProviderConfigToEnv,
  saveConfig,
} from '../config-store.js';
import { getCuratedModels } from '../model-catalog.js';
import { getProviderList } from '../provider.js';
import { appendAuditEvent } from '../pushd-audit-log.js';
import { auditProvenance } from './audit-provenance.js';
import { makeErrorResponse, makeResponse } from './envelopes.js';
import type { DaemonHandler } from './handler-types.js';

function resolveDaemonRuntimeConfigPayload(config: any) {
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
async function handleGetDaemonRuntimeConfig(req: any) {
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
async function handleSetDaemonRuntimeConfig(req: any, _emitEvent: any, context: any) {
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
async function handleListProviders(req: any) {
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
async function handleReloadConfig(req: any) {
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

export const daemonRuntimeHandlers: {
  handleGetDaemonRuntimeConfig: DaemonHandler;
  handleSetDaemonRuntimeConfig: DaemonHandler;
  handleListProviders: DaemonHandler;
  handleReloadConfig: DaemonHandler;
} = {
  handleGetDaemonRuntimeConfig,
  handleSetDaemonRuntimeConfig,
  handleListProviders,
  handleReloadConfig,
};
