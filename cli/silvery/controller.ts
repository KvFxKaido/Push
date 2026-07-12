import path from 'node:path';

import {
  applyConfigToEnv,
  loadConfig,
  maskSecret,
  saveConfig,
  type PushConfig,
} from '../config-store.js';
import { compactContext } from '../context-manager.js';
import { tryConnect } from '../daemon-client.js';
import { DEFAULT_MAX_ROUNDS, runAssistantTurn, type EngineEvent } from '../engine.js';
import { appendUserMessageWithFileReferences } from '../file-references.js';
import { getCuratedModels } from '../model-catalog.js';
import {
  getProviderList,
  PROVIDER_CONFIGS,
  redirectDeprecatedProvider,
  resolveApiKey,
  type ProviderConfig,
} from '../provider.js';
import { initCliSession } from '../session-init.js';
import {
  appendSessionEvent,
  listSessions,
  loadSessionState,
  rewriteMessagesLog,
  saveSessionState,
  type SessionState,
} from '../session-store.js';
import { formatSkillDiagnostics, lintSkills, loadSkills } from '../skill-loader.js';
import { sessionMessagesToTranscriptRows } from '../tui-history.js';
import { createDaemonSession, type DaemonClientLike } from '../tui-daemon-session.js';
import { getCompactGitStatus, type CompactGitStatus } from '../tui-status.js';
import { formatWorktreeStatus } from '../worktree.js';
import {
  applyDaemonTranscriptEvent,
  createDaemonTranscriptMirror,
  type DaemonTranscriptRow,
  type DaemonTranscriptSnapshot,
} from '../daemon-transcript-mirror.ts';
import { TUI_DAEMON_CAPABILITIES } from '../../lib/daemon-capabilities.js';
import { isTranscriptMutationEvent } from '../../lib/session-transcript-events.js';
import type { RunTuiOptions } from './entry.js';

export type SilveryTranscriptItem = DaemonTranscriptRow;

export interface SilverySnapshot {
  rows: SilveryTranscriptItem[];
  running: boolean;
  startedAt: number | null;
  provider: string;
  model: string;
  cwd: string;
  gitStatus: CompactGitStatus | null;
  daemonConnected: boolean;
  error: string | null;
  interaction: SilveryInteraction | null;
}

export type SilveryInteraction =
  | { id: string; kind: 'approval'; title: string; detail: string }
  | { id: string; kind: 'question'; title: string; detail: string };

interface ControllerDeps {
  loadConfig?: () => Promise<PushConfig>;
  saveConfig?: typeof saveConfig;
  initSession?: typeof initCliSession;
  runTurn?: typeof runAssistantTurn;
  saveState?: typeof saveSessionState;
  appendEvent?: typeof appendSessionEvent;
  loadState?: typeof loadSessionState;
  listSessions?: typeof listSessions;
  gitStatus?: typeof getCompactGitStatus;
  resolveKey?: (config: ProviderConfig) => string;
  loadSkills?: typeof loadSkills;
  lintSkills?: typeof lintSkills;
  now?: () => number;
  useDaemon?: boolean;
  createDaemon?: typeof createDaemonSession;
}

const SESSION_ID_RE = /^sess_[a-z0-9]+_[a-f0-9]{6}$/;

export interface SilveryController {
  getSnapshot(): SilverySnapshot;
  subscribe(listener: () => void): () => void;
  submit(text: string): Promise<void>;
  cancel(): void;
  respondToInteraction(id: string, value: boolean | string): void;
  clearDisplay(): void;
  dispose(): Promise<void>;
}

function normalizeProvider(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function activityRole(event: EngineEvent): 'coder' | 'explorer' {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const role = String(payload.role ?? payload.agentRole ?? '');
  if (role === 'coder' || role === 'explorer') return role;
  const tool = String(payload.toolName ?? '');
  return /^(read_file|list_files|search|web_search|git_status|git_diff)$/.test(tool)
    ? 'explorer'
    : 'coder';
}

function activityText(event: EngineEvent): string {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const tool = String(payload.toolName ?? 'work');
  if (event.type === 'tool_result' || event.type === 'tool.execution_complete') {
    return `${tool} ${payload.isError ? 'failed' : 'complete'}`;
  }
  return tool;
}

/** Approval detail is `unknown` on EngineEvent; InteractionModal needs a string. */
function formatApprovalDetail(detail: unknown): string {
  if (typeof detail === 'string') return detail;
  if (detail === undefined) return '';
  try {
    const serialized = JSON.stringify(detail, null, 2);
    return typeof serialized === 'string' ? serialized : '';
  } catch {
    return String(detail);
  }
}

const SILVERY_DAEMON_CAPABILITIES = TUI_DAEMON_CAPABILITIES;

export async function createSilveryController(
  options: RunTuiOptions,
  deps: ControllerDeps = {},
): Promise<SilveryController> {
  let config = await (deps.loadConfig ?? loadConfig)();
  applyConfigToEnv(config);
  const persistConfig = deps.saveConfig ?? saveConfig;
  const requested =
    normalizeProvider(options.provider) ||
    normalizeProvider(process.env.PUSH_PROVIDER) ||
    normalizeProvider(config.provider) ||
    'ollama';
  const providerName = redirectDeprecatedProvider(requested) ?? requested;
  const providerConfig = PROVIDER_CONFIGS[providerName];
  if (!providerConfig) throw new Error(`Unknown provider: ${providerName}`);
  const cwd = path.resolve(options.cwd || process.cwd());
  const state = await (deps.initSession ?? initCliSession)(
    options.sessionId,
    providerName,
    options.model || providerConfig.defaultModel,
    cwd,
    'tui',
  );

  if (options.provider && providerName !== state.provider) {
    state.provider = providerName;
    state.model = options.model || providerConfig.defaultModel;
  }
  if (options.model) state.model = options.model;
  if (options.cwd) state.cwd = cwd;
  const activeProvider = PROVIDER_CONFIGS[state.provider];
  if (!activeProvider) throw new Error(`Unknown provider in session: ${state.provider}`);

  const now = deps.now ?? Date.now;
  let sequence = 0;
  let liveText = '';
  let activityRows: SilveryTranscriptItem[] = [];
  let daemonMirror = createDaemonTranscriptMirror();
  let daemonHiddenBefore = 0;
  let running = false;
  let startedAt: number | null = null;
  let error: string | null = null;
  let interaction: SilveryInteraction | null = null;
  let resolveApproval: ((approved: boolean) => void) | null = null;
  let resolveQuestion: ((answer: string) => void) | null = null;
  let hiddenBefore = 0;
  let abortController: AbortController | null = null;
  let disposed = false;
  let persisted = Boolean(options.sessionId);
  let daemonConnected = false;
  let daemonTurn = false;
  let daemonRunId: string | null = null;
  let resolveDaemonTurn: (() => void) | null = null;
  let daemonStateStale = false;
  let gitStatus = await (deps.gitStatus ?? getCompactGitStatus)(state.cwd);
  const listeners = new Set<() => void>();

  const nextId = (kind: string) => `${kind}-${++sequence}`;
  const historyRows = (): SilveryTranscriptItem[] =>
    sessionMessagesToTranscriptRows(state.messages)
      .slice(hiddenBefore)
      .map((row, index) => ({
        id: `history-${hiddenBefore + index}`,
        kind: 'message' as const,
        ...row,
      }));

  const buildSnapshot = (): SilverySnapshot => ({
    rows: daemonStateStale
      ? [
          ...daemonMirror.rows.slice(daemonHiddenBefore),
          ...(daemonMirror.liveText
            ? [
                {
                  id: 'daemon-assistant-live',
                  kind: 'message' as const,
                  role: 'assistant' as const,
                  text: daemonMirror.liveText,
                  live: true,
                },
              ]
            : []),
        ]
      : [
          ...historyRows(),
          ...activityRows,
          ...(liveText
            ? [
                {
                  id: 'assistant-live',
                  kind: 'message' as const,
                  role: 'assistant' as const,
                  text: liveText,
                  live: true,
                },
              ]
            : []),
        ],
    running,
    startedAt,
    provider: state.provider,
    model: state.model,
    cwd: state.cwd,
    gitStatus,
    daemonConnected,
    error,
    interaction,
  });
  let currentSnapshot = buildSnapshot();
  const notify = () => {
    currentSnapshot = buildSnapshot();
    for (const listener of listeners) listener();
  };

  const appendStatus = (text: string, isError = false) => {
    const row: SilveryTranscriptItem = {
      id: nextId(isError ? 'error' : 'status'),
      kind: 'status',
      role: 'status',
      text,
      isError,
    };
    if (daemonStateStale) daemonMirror.rows.push(row);
    else activityRows = [...activityRows, row];
    notify();
  };

  const onEvent = (event: EngineEvent) => {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    switch (event.type) {
      case 'assistant_token':
        liveText += String(payload.text ?? '');
        break;
      case 'assistant_done':
        liveText = '';
        break;
      case 'tool_call':
      case 'tool.execution_start':
      case 'tool_result':
      case 'tool.execution_complete':
        activityRows = [
          ...activityRows,
          {
            id: nextId('activity'),
            kind: 'tool',
            role: activityRole(event),
            text: activityText(event),
          },
        ];
        break;
      case 'warning':
      case 'error':
      case 'status':
        activityRows = [
          ...activityRows,
          {
            id: nextId('status'),
            kind: 'status',
            role: 'status',
            text: String(payload.message ?? payload.detail ?? payload.phase ?? event.type),
          },
        ];
        break;
      case 'run_complete':
        running = false;
        startedAt = null;
        resolveDaemonTurn?.();
        resolveDaemonTurn = null;
        break;
    }
    notify();
  };

  const onDaemonEvent = (event: EngineEvent & { seq?: number }) => {
    applyDaemonTranscriptEvent(daemonMirror, {
      seq: typeof event.seq === 'number' ? event.seq : 0,
      type: event.type,
      payload: event.payload,
    });
    if (event.type === 'run_complete') {
      running = false;
      startedAt = null;
      resolveDaemonTurn?.();
      resolveDaemonTurn = null;
      void resyncDaemonTranscript('run_complete');
    } else if (isTranscriptMutationEvent(event.type)) {
      // Compact/revert/unrevert rewrite daemon `state.messages` and invalidate
      // the daemon's cached mirror. Local apply is a no-op for these types;
      // refetch the snapshot so Silvery drops pre-mutation turns (ANSI TUI
      // does the same via get_session_messages).
      void resyncDaemonTranscript(event.type);
    } else if (event.type === 'approval_required') {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const approvalId = typeof payload.approvalId === 'string' ? payload.approvalId : '';
      if (approvalId) {
        interaction = {
          id: approvalId,
          kind: 'approval',
          title: typeof payload.title === 'string' ? payload.title : 'Approval required',
          detail:
            (typeof payload.summary === 'string' && payload.summary) ||
            (typeof payload.kind === 'string' && payload.kind) ||
            'The daemon is waiting for a decision.',
        };
      }
    } else if (event.type === 'approval_received') {
      interaction = null;
    }
    notify();
  };

  async function ensurePersisted() {
    if (persisted) return;
    await (deps.appendEvent ?? appendSessionEvent)(state, 'session_started', {
      sessionId: state.sessionId,
      state: 'idle',
      mode: state.mode || 'tui',
      provider: state.provider,
    });
    await (deps.saveState ?? saveSessionState)(state);
    persisted = true;
  }

  const daemon = (deps.createDaemon ?? createDaemonSession)(
    {
      tryConnectTransport: (socketPath, timeoutMs) =>
        tryConnect(socketPath, timeoutMs) as unknown as Promise<DaemonClientLike | null>,
      note: (_kind, text) => {
        activityRows = [
          ...activityRows,
          { id: nextId('daemon'), kind: 'status', role: 'status', text },
        ];
        notify();
      },
      markFooterDirty: () => {
        daemonConnected = daemon.connected;
        notify();
      },
      markAllDirty: notify,
      onEngineEvent: (event) => {
        if (typeof event.seq === 'number') daemon.noteSeenSeq(event.seq);
        onDaemonEvent(event as EngineEvent & { seq?: number });
      },
      onSocketClose: () => {
        daemonConnected = false;
        if (resolveDaemonTurn) {
          error = 'Daemon disconnected before the turn completed.';
          resolveDaemonTurn();
          resolveDaemonTurn = null;
        }
        notify();
        daemon.scheduleReconnect({ announce: true });
      },
      isAutoStartEnabled: () => false,
      spawnDaemon: async () => ({
        status: 'already-running',
        ready: false,
        socketPath: '',
        logPath: '',
      }),
      onReusedDaemon: async () => undefined,
      appendDaemonLogTail: async () => undefined,
      getDurableSession: () => ({
        persisted,
        sessionId: persisted ? state.sessionId : null,
        attachToken: typeof state.attachToken === 'string' ? state.attachToken : null,
      }),
      setDurableAttachToken: (token) => {
        state.attachToken = token;
        if (!daemonStateStale) void (deps.saveState ?? saveSessionState)(state);
      },
      getStartSessionPayload: () => ({
        provider: state.provider,
        model: state.model,
        cwd: state.cwd,
      }),
      onAttached: (payload) => {
        const attached = payload as { provider?: unknown; model?: unknown };
        if (typeof attached.provider === 'string') state.provider = attached.provider;
        if (typeof attached.model === 'string') state.model = attached.model;
        void resyncDaemonTranscript('attach');
        notify();
      },
      invalidateReconnectAnimators: notify,
    },
    SILVERY_DAEMON_CAPABILITIES,
  );
  if (deps.useDaemon !== false) {
    daemonConnected = await daemon.ensureConnected({ announce: false });
    notify();
  }

  async function resyncDaemonTranscript(reason: string): Promise<boolean> {
    if (!daemon.connected || !daemon.sessionId || !daemon.attachToken) return false;
    try {
      const response = await daemon.client!.request(
        'get_session_snapshot',
        {
          sessionId: daemon.sessionId,
          attachToken: daemon.attachToken,
          recentEventLimit: 1,
        },
        daemon.sessionId,
        1500,
      );
      const payload = response.payload as
        | {
            transcript?: { mirror?: DaemonTranscriptSnapshot };
            pendingApproval?: {
              approvalId?: unknown;
              title?: unknown;
              summary?: unknown;
              kind?: unknown;
            } | null;
          }
        | undefined;
      const snapshot = payload?.transcript?.mirror;
      if (!snapshot || !Array.isArray(snapshot.rows)) return false;
      daemonMirror = createDaemonTranscriptMirror(snapshot);
      daemonHiddenBefore = Math.min(daemonHiddenBefore, daemonMirror.rows.length);
      daemonStateStale = true;
      // Clear transient resync failures once a valid mirror is adopted.
      error = null;
      const pending = payload?.pendingApproval;
      if (pending && typeof pending.approvalId === 'string') {
        interaction = {
          id: pending.approvalId,
          kind: 'approval',
          title: typeof pending.title === 'string' ? pending.title : 'Approval required',
          detail:
            (typeof pending.summary === 'string' && pending.summary) ||
            (typeof pending.kind === 'string' && pending.kind) ||
            'The daemon is waiting for a decision.',
        };
      } else if (interaction?.kind === 'approval' && !resolveApproval) {
        interaction = null;
      }
      notify();
      return true;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      error = `Daemon transcript resync failed (${reason}): ${message}`;
      notify();
      return false;
    }
  }

  async function patchDaemonSession(patch: {
    provider?: string;
    model?: string;
  }): Promise<boolean> {
    if (!daemon.connected || !daemon.sessionId || !daemon.client) return false;
    try {
      const response = await daemon.client.request(
        'update_session',
        {
          sessionId: daemon.sessionId,
          attachToken: daemon.attachToken,
          patch,
        },
        daemon.sessionId,
      );
      const payload = (response.payload ?? {}) as { provider?: unknown; model?: unknown };
      if (typeof payload.provider === 'string') state.provider = payload.provider;
      if (typeof payload.model === 'string') state.model = payload.model;
      return true;
    } catch (cause) {
      appendStatus(
        `Daemon rejected session update: ${cause instanceof Error ? cause.message : String(cause)}`,
        true,
      );
      return false;
    }
  }

  async function handleSlashCommand(text: string): Promise<boolean> {
    if (!text.startsWith('/')) return false;
    const [rawCommand, ...rest] = text.slice(1).split(/\s+/);
    const command = rawCommand?.toLowerCase() ?? '';
    const arg = rest.join(' ').trim();

    if (command === 'help') {
      appendStatus(
        [
          'Commands:',
          '  /clear | /new          Hide the current transcript display',
          '  /session               Show the active session id',
          '  /session rename <name> Rename the session (--clear to unset)',
          '  /provider [name|#]     List or switch provider',
          '  /model [name|#]        List curated models or switch model',
          '  /config                Show config overview (secrets masked)',
          '  /config key <secret>   Set API key for current provider',
          '  /config key <p> <s>    Set API key for a named provider',
          '  /config url <url>      Set endpoint URL for current provider',
          '  /resume <session-id>   Switch to a saved session',
          '  /skills [reload|lint]  List, reload, or lint workspace skills',
          '  /compact [turns]       Compact context (default preserve 6 turns)',
          '  /revert [turns]        Daemon: remove recent user turns',
          '  /unrevert              Daemon: restore the last reverted tail',
          '  /children [id]         List or inspect delegated child runs',
          '  /worktree              Show worktree sandbox status',
          '  /exit | /quit          Use the command palette or Ctrl+C to exit',
          '',
          'Not yet ported: interactive pickers, /remote, /rc, /checkpoint, /theme, /spinner.',
        ].join('\n'),
      );
      return true;
    }

    if (command === 'clear' || command === 'new') {
      if (daemonStateStale) {
        daemonHiddenBefore = daemonMirror.rows.length;
        daemonMirror.liveText = '';
      } else {
        hiddenBefore = sessionMessagesToTranscriptRows(state.messages).length;
      }
      activityRows = [];
      liveText = '';
      notify();
      return true;
    }

    if (command === 'session') {
      if (!arg) {
        appendStatus(
          `session: ${state.sessionId}${state.sessionName ? ` (${state.sessionName})` : ''}`,
        );
        return true;
      }
      if (arg === 'rename' || arg.startsWith('rename ')) {
        const name = arg === 'rename' ? '' : arg.slice('rename'.length).trim();
        if (!name) {
          appendStatus('Usage: /session rename <name> | /session rename --clear', true);
          return true;
        }
        if (name === '--clear') {
          state.sessionName = '';
          await (deps.appendEvent ?? appendSessionEvent)(state, 'session_renamed', { name: null });
          await (deps.saveState ?? saveSessionState)(state);
          appendStatus('Session name cleared.');
          return true;
        }
        state.sessionName = name;
        await (deps.appendEvent ?? appendSessionEvent)(state, 'session_renamed', { name });
        await (deps.saveState ?? saveSessionState)(state);
        appendStatus(`Session renamed: ${JSON.stringify(name)}`);
        return true;
      }
      appendStatus('Usage: /session | /session rename <name> | /session rename --clear', true);
      return true;
    }

    if (command === 'provider') {
      const providers = getProviderList();
      if (!arg) {
        appendStatus(
          providers
            .map(
              (entry, index) =>
                `${index + 1}. ${entry.id}${entry.id === state.provider ? '  (current)' : ''}${
                  entry.hasKey ? '' : '  · no key'
                }`,
            )
            .join('\n'),
        );
        return true;
      }
      let targetId: string | null = null;
      if (/^\d+$/.test(arg)) {
        const num = Number.parseInt(arg, 10);
        targetId = num >= 1 && num <= providers.length ? providers[num - 1]!.id : null;
      } else {
        const normalized = redirectDeprecatedProvider(arg.toLowerCase()) ?? arg.toLowerCase();
        targetId = PROVIDER_CONFIGS[normalized] ? normalized : null;
      }
      if (!targetId || !PROVIDER_CONFIGS[targetId]) {
        appendStatus(`Unknown provider: ${arg}`, true);
        return true;
      }
      const targetConfig = PROVIDER_CONFIGS[targetId]!;
      try {
        (deps.resolveKey ?? resolveApiKey)(targetConfig);
      } catch {
        appendStatus(`Cannot switch to ${targetId}: no API key.`, true);
        return true;
      }
      const providerSlot = config[targetId] as { model?: string } | undefined;
      const targetModel = providerSlot?.model || targetConfig.defaultModel;
      if (daemon.connected && daemon.sessionId) {
        const ok = await patchDaemonSession({ provider: targetId, model: targetModel });
        if (!ok) return true;
      } else {
        state.provider = targetId;
        state.model = targetModel;
        await (deps.saveState ?? saveSessionState)(state);
      }
      config.provider = targetId;
      await persistConfig(config);
      appendStatus(`Switched to ${state.provider} | model: ${state.model}`);
      notify();
      return true;
    }

    if (command === 'model') {
      const models = [...getCuratedModels(state.provider)];
      if (!arg) {
        appendStatus(
          models.length
            ? models
                .map(
                  (name, index) =>
                    `${index + 1}. ${name}${name === state.model ? '  (current)' : ''}`,
                )
                .join('\n')
            : `No curated models for ${state.provider}. Use /model <name>.`,
        );
        return true;
      }
      let target = arg;
      if (/^\d+$/.test(arg)) {
        const num = Number.parseInt(arg, 10);
        if (num < 1 || num > models.length) {
          appendStatus(`Model index out of range: ${num}`, true);
          return true;
        }
        target = models[num - 1]!;
      }
      if (target === state.model) {
        appendStatus(`Already using model: ${target}`);
        return true;
      }
      if (daemon.connected && daemon.sessionId) {
        const ok = await patchDaemonSession({ model: target });
        if (!ok) return true;
      } else {
        state.model = target;
        await (deps.saveState ?? saveSessionState)(state);
      }
      if (!config[state.provider] || typeof config[state.provider] !== 'object') {
        (config as Record<string, unknown>)[state.provider] = {};
      }
      (config[state.provider] as { model?: string }).model = target;
      await persistConfig(config);
      appendStatus(`Model switched to: ${state.model}`);
      notify();
      return true;
    }

    if (command === 'config') {
      if (!arg) {
        const providerCfg = (config[state.provider] ?? {}) as {
          apiKey?: string;
          url?: string;
        };
        appendStatus(
          [
            `provider: ${state.provider}`,
            `model: ${state.model}`,
            `key: ${maskSecret(providerCfg.apiKey) || '(env / unset)'}`,
            `url: ${providerCfg.url || PROVIDER_CONFIGS[state.provider]?.url || '(default)'}`,
            `tavily: ${maskSecret(config.tavilyApiKey) || '(unset)'}`,
            `daemon autostart: ${config.tuiDaemonAutoStart === false || config.tuiDaemonAutoStart === 'false' ? 'off' : 'auto'}`,
            `sandbox: ${config.localSandbox === true || config.localSandbox === 'true' ? 'on' : 'off'}`,
          ].join('\n'),
        );
        return true;
      }
      const [sub, ...restArgs] = arg.split(/\s+/);
      const subcommand = sub?.toLowerCase() ?? '';
      if (subcommand === 'key') {
        if (restArgs.length === 1) {
          const secret = restArgs[0]!;
          if (!config[state.provider] || typeof config[state.provider] !== 'object') {
            (config as Record<string, unknown>)[state.provider] = {};
          }
          (config[state.provider] as { apiKey?: string }).apiKey = secret;
          await persistConfig(config);
          applyConfigToEnv(config);
          appendStatus(`API key set for ${state.provider} (${maskSecret(secret)}).`);
          return true;
        }
        if (restArgs.length >= 2) {
          const targetProvider =
            redirectDeprecatedProvider(restArgs[0]!.toLowerCase()) ?? restArgs[0]!.toLowerCase();
          const secret = restArgs.slice(1).join(' ');
          if (!PROVIDER_CONFIGS[targetProvider]) {
            appendStatus(`Unknown provider: ${restArgs[0]}`, true);
            return true;
          }
          if (!config[targetProvider] || typeof config[targetProvider] !== 'object') {
            (config as Record<string, unknown>)[targetProvider] = {};
          }
          (config[targetProvider] as { apiKey?: string }).apiKey = secret;
          await persistConfig(config);
          applyConfigToEnv(config);
          appendStatus(`API key set for ${targetProvider} (${maskSecret(secret)}).`);
          return true;
        }
        appendStatus('Usage: /config key <secret> or /config key <provider> <secret>', true);
        return true;
      }
      if (subcommand === 'url') {
        const url = restArgs.join(' ').trim();
        if (!url) {
          appendStatus('Usage: /config url <url>', true);
          return true;
        }
        if (!config[state.provider] || typeof config[state.provider] !== 'object') {
          (config as Record<string, unknown>)[state.provider] = {};
        }
        (config[state.provider] as { url?: string }).url = url;
        await persistConfig(config);
        applyConfigToEnv(config);
        appendStatus(`URL set for ${state.provider}: ${url}`);
        return true;
      }
      appendStatus(
        'Usage: /config | /config key <secret> | /config key <provider> <secret> | /config url <url>',
        true,
      );
      return true;
    }

    if (command === 'resume') {
      if (!arg) {
        const sessions = await (deps.listSessions ?? listSessions)();
        appendStatus(
          sessions.length
            ? sessions
                .slice(0, 12)
                .map(
                  (entry) =>
                    `${entry.sessionId}${entry.sessionName ? ` · ${entry.sessionName}` : ''} · ${entry.provider}/${entry.model}`,
                )
                .join('\n') + (sessions.length > 12 ? `\n… ${sessions.length - 12} more` : '')
            : 'No saved sessions.',
        );
        return true;
      }
      if (!SESSION_ID_RE.test(arg)) {
        appendStatus('Usage: /resume | /resume <session-id>', true);
        return true;
      }
      try {
        const next = await (deps.loadState ?? loadSessionState)(arg);
        Object.assign(state, next);
        daemonMirror = createDaemonTranscriptMirror();
        daemonHiddenBefore = 0;
        daemonStateStale = false;
        activityRows = [];
        liveText = '';
        hiddenBefore = 0;
        persisted = true;
        gitStatus = await (deps.gitStatus ?? getCompactGitStatus)(state.cwd);
        appendStatus(
          `Resumed session ${state.sessionId}${state.sessionName ? ` (${state.sessionName})` : ''}.`,
        );
        notify();
      } catch (cause) {
        appendStatus(
          `Resume failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          true,
        );
      }
      return true;
    }

    if (command === 'skills') {
      if (arg === 'reload') {
        const skills = await (deps.loadSkills ?? loadSkills)(state.cwd);
        appendStatus(`Reloaded skills: ${skills.size}`);
        return true;
      }
      if (arg === 'lint') {
        const diags = await (deps.lintSkills ?? lintSkills)(state.cwd);
        appendStatus(
          formatSkillDiagnostics(diags),
          diags.some((diag) => diag.severity === 'error'),
        );
        return true;
      }
      if (arg) {
        appendStatus('Usage: /skills | /skills reload | /skills lint', true);
        return true;
      }
      const skills = await (deps.loadSkills ?? loadSkills)(state.cwd);
      appendStatus(
        skills.size
          ? [...skills.keys()]
              .sort()
              .map((name) => `/${name}`)
              .join('\n')
          : 'No skills loaded.',
      );
      return true;
    }

    if (command === 'worktree') {
      appendStatus(await formatWorktreeStatus(state));
      return true;
    }

    if (command === 'compact') {
      if (arg && !/^\d+$/.test(arg)) {
        appendStatus('Usage: /compact [turns] (positive integer)', true);
        return true;
      }
      const preserveTurns = arg ? Math.max(1, Math.min(64, Number.parseInt(arg, 10))) : 6;
      if (await daemon.ensureReady()) {
        try {
          const response = await daemon.summarize(preserveTurns);
          const payload = response?.payload as { compacted?: boolean } | undefined;
          if (payload?.compacted === false) appendStatus('Nothing to compact.');
          else {
            await resyncDaemonTranscript('compact');
            appendStatus('Context compacted on the daemon.');
          }
        } catch (cause) {
          appendStatus(
            `Summarize failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            true,
          );
        }
        return true;
      }
      const result = compactContext(state.messages as Parameters<typeof compactContext>[0], {
        preserveTurns,
      });
      if (!result.compacted) {
        appendStatus(
          `Nothing to compact (turns: ${result.totalTurns}, preserve: ${result.preserveTurns}).`,
        );
        return true;
      }
      state.messages = result.messages;
      await (deps.appendEvent ?? appendSessionEvent)(state, 'context_compacted', {
        preserveTurns: result.preserveTurns,
        totalTurns: result.totalTurns,
        compactedMessages: result.compactedCount,
        removedCount: result.removedCount,
        beforeTokens: result.beforeTokens,
        afterTokens: result.afterTokens,
      });
      await rewriteMessagesLog(state);
      appendStatus(
        `Compacted context: ${result.compactedCount} messages → 1 summary (kept ${result.preserveTurns} turns).`,
      );
      notify();
      return true;
    }

    if (command === 'revert') {
      if (arg && !/^\d+$/.test(arg)) {
        appendStatus('Usage: /revert [turns] (positive integer)', true);
        return true;
      }
      const turns = arg ? Math.max(1, Math.min(1024, Number.parseInt(arg, 10))) : 1;
      if (!(await daemon.ensureReady())) {
        appendStatus('/revert needs a daemon session.', true);
        return true;
      }
      try {
        const response = await daemon.revert(turns);
        const payload = response?.payload as { reverted?: boolean } | undefined;
        if (payload?.reverted === false) appendStatus('Nothing to revert.');
        else {
          await resyncDaemonTranscript('revert');
          appendStatus(`Reverted ${turns} turn(s) on the daemon.`);
        }
      } catch (cause) {
        appendStatus(
          `Revert failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          true,
        );
      }
      return true;
    }

    if (command === 'unrevert') {
      if (!(await daemon.ensureReady())) {
        appendStatus('/unrevert needs a daemon session.', true);
        return true;
      }
      try {
        await daemon.unrevert();
        await resyncDaemonTranscript('unrevert');
        appendStatus('Restored the last reverted tail on the daemon.');
      } catch (cause) {
        appendStatus(cause instanceof Error ? cause.message : String(cause), true);
      }
      return true;
    }

    if (command === 'children') {
      if (!(await daemon.ensureReady())) {
        appendStatus('/children needs a daemon session.', true);
        return true;
      }
      try {
        if (arg) {
          const response = await daemon.getChild(arg);
          appendStatus(JSON.stringify(response?.payload?.child ?? {}, null, 2));
        } else {
          const response = await daemon.listChildren();
          const children = Array.isArray(response?.payload?.children)
            ? response.payload.children
            : [];
          appendStatus(
            children.length
              ? children
                  .map(
                    (child) =>
                      `${child.subagentId ?? '?'} · ${child.agent ?? 'subagent'} · ${child.status ?? '?'}`,
                  )
                  .join('\n')
              : 'No delegated children for this session.',
          );
        }
      } catch (cause) {
        appendStatus(
          `Children query failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          true,
        );
      }
      return true;
    }

    if (command === 'exit' || command === 'quit') {
      appendStatus('Use the command palette Exit or Ctrl+C to leave the TUI.');
      return true;
    }

    appendStatus(`Command /${command} is not ported to the retained TUI yet.`, true);
    return true;
  }

  return {
    getSnapshot: () => currentSnapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async submit(rawText) {
      const text = rawText.trim();
      if (!text || running || disposed) return;
      if (await handleSlashCommand(text)) return;
      error = null;
      activityRows = [];
      liveText = '';
      running = true;
      startedAt = now();
      notify();
      abortController = new AbortController();
      let saveLocalState = false;
      try {
        await ensurePersisted();
        if (await daemon.ensureReady()) {
          daemonTurn = true;
          daemonStateStale = true;
          await resyncDaemonTranscript('before_send');
          const completion = new Promise<void>((resolve) => {
            resolveDaemonTurn = resolve;
          });
          const response = await daemon.client!.request(
            'send_user_message',
            {
              sessionId: daemon.sessionId,
              text,
              attachToken: daemon.attachToken,
              capabilities: [...SILVERY_DAEMON_CAPABILITIES],
            },
            daemon.sessionId,
          );
          daemonRunId = typeof response.payload?.runId === 'string' ? response.payload.runId : null;
          await completion;
          return;
        }
        if (daemonStateStale && persisted) {
          const refreshed = await (deps.loadState ?? loadSessionState)(state.sessionId);
          Object.assign(state, refreshed);
          daemonMirror = createDaemonTranscriptMirror();
          daemonHiddenBefore = 0;
          daemonStateStale = false;
        }
        saveLocalState = true;
        await appendUserMessageWithFileReferences(
          state as unknown as Parameters<typeof appendUserMessageWithFileReferences>[0],
          text,
          state.cwd,
        );
        await (deps.appendEvent ?? appendSessionEvent)(state, 'user_message', {
          chars: text.length,
          preview: text.slice(0, 280),
        });
        notify();
        const turnProvider = PROVIDER_CONFIGS[state.provider] ?? activeProvider;
        const apiKey = (deps.resolveKey ?? resolveApiKey)(turnProvider);
        await (deps.runTurn ?? runAssistantTurn)(
          state,
          turnProvider,
          apiKey,
          text,
          options.maxRounds || DEFAULT_MAX_ROUNDS,
          {
            signal: abortController.signal,
            emit: onEvent,
            safeExecPatterns: config.safeExecPatterns ?? [],
            execMode: process.env.PUSH_EXEC_MODE || config.execMode || 'auto',
            disabledTools: config.disabledTools,
            alwaysAllow: config.alwaysAllow,
            auditorGate: config.auditorGate,
            explicitMaxRounds: options.explicitMaxRounds ?? false,
            approvalFn: async (tool, detail) =>
              new Promise<boolean>((resolve) => {
                const id = nextId('approval');
                resolveApproval = resolve;
                interaction = {
                  id,
                  kind: 'approval',
                  title: `${tool} needs approval`,
                  detail: formatApprovalDetail(detail),
                };
                notify();
              }),
            askUserFn: async (question) =>
              new Promise<string>((resolve) => {
                const id = nextId('question');
                resolveQuestion = resolve;
                interaction = {
                  id,
                  kind: 'question',
                  title: 'Push has a question',
                  detail: question,
                };
                notify();
              }),
          },
        );
      } catch (cause) {
        if (!(cause instanceof Error && cause.name === 'AbortError')) {
          error = cause instanceof Error ? cause.message : String(cause);
        }
      } finally {
        daemonTurn = false;
        daemonRunId = null;
        resolveDaemonTurn = null;
        running = false;
        startedAt = null;
        liveText = '';
        abortController = null;
        interaction = null;
        resolveApproval = null;
        resolveQuestion = null;
        if (saveLocalState) {
          try {
            await (deps.saveState ?? saveSessionState)(state);
          } catch (cause) {
            error ??= cause instanceof Error ? cause.message : String(cause);
          }
        }
        try {
          gitStatus = await (deps.gitStatus ?? getCompactGitStatus)(state.cwd);
        } catch (cause) {
          error ??= cause instanceof Error ? cause.message : String(cause);
        }
        notify();
      }
    },
    cancel() {
      abortController?.abort();
      resolveApproval?.(false);
      resolveQuestion?.('(skipped — make a reasonable assumption)');
      resolveApproval = null;
      resolveQuestion = null;
      interaction = null;
      if (daemon.connected && daemon.sessionId && daemonRunId) {
        void daemon.client?.request(
          'cancel_run',
          {
            sessionId: daemon.sessionId,
            runId: daemonRunId,
            attachToken: daemon.attachToken,
          },
          daemon.sessionId,
        );
      }
      resolveDaemonTurn?.();
      notify();
    },
    respondToInteraction(id, value) {
      if (!interaction || interaction.id !== id) return;
      if (interaction.kind === 'approval') {
        const approved = value === true;
        if (resolveApproval) resolveApproval(approved);
        else if (daemon.connected && daemon.sessionId) {
          void daemon.client?.request(
            'submit_approval',
            {
              sessionId: daemon.sessionId,
              approvalId: id,
              decision: approved ? 'approve' : 'deny',
              attachToken: daemon.attachToken,
            },
            daemon.sessionId,
          );
        }
        resolveApproval = null;
      } else {
        const answer =
          typeof value === 'string' && value.trim()
            ? value.trim()
            : '(skipped — make a reasonable assumption)';
        resolveQuestion?.(answer);
        resolveQuestion = null;
      }
      interaction = null;
      notify();
    },
    clearDisplay() {
      if (daemonStateStale) {
        daemonHiddenBefore = daemonMirror.rows.length;
        // buildSnapshot appends liveText as a live row; hide it with the rest.
        daemonMirror.liveText = '';
      } else {
        hiddenBefore = sessionMessagesToTranscriptRows(state.messages).length;
      }
      activityRows = [];
      liveText = '';
      notify();
    },
    async dispose() {
      disposed = true;
      abortController?.abort();
      daemon.teardown();
      if (persisted && !daemonStateStale) await (deps.saveState ?? saveSessionState)(state);
      listeners.clear();
    },
  };
}
