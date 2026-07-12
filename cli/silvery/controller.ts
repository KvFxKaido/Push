import path from 'node:path';

import { applyConfigToEnv, loadConfig, type PushConfig } from '../config-store.js';
import { tryConnect } from '../daemon-client.js';
import { DEFAULT_MAX_ROUNDS, runAssistantTurn, type EngineEvent } from '../engine.js';
import { appendUserMessageWithFileReferences } from '../file-references.js';
import {
  PROVIDER_CONFIGS,
  redirectDeprecatedProvider,
  resolveApiKey,
  type ProviderConfig,
} from '../provider.js';
import { initCliSession } from '../session-init.js';
import {
  appendSessionEvent,
  loadSessionState,
  saveSessionState,
  type SessionState,
} from '../session-store.js';
import { sessionMessagesToTranscriptRows } from '../tui-history.js';
import { createDaemonSession, type DaemonClientLike } from '../tui-daemon-session.js';
import { getCompactGitStatus, type CompactGitStatus } from '../tui-status.js';
import { EVENT_V2, TUI_DAEMON_CAPABILITIES } from '../../lib/daemon-capabilities.js';
import type { RunTuiOptions } from './entry.js';

export type SilveryTranscriptRole = 'user' | 'assistant' | 'coder' | 'explorer' | 'status';

export interface SilveryTranscriptItem {
  id: string;
  role: SilveryTranscriptRole;
  text: string;
  live?: boolean;
}

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
}

interface ControllerDeps {
  loadConfig?: () => Promise<PushConfig>;
  initSession?: typeof initCliSession;
  runTurn?: typeof runAssistantTurn;
  saveState?: typeof saveSessionState;
  appendEvent?: typeof appendSessionEvent;
  loadState?: typeof loadSessionState;
  gitStatus?: typeof getCompactGitStatus;
  resolveKey?: (config: ProviderConfig) => string;
  now?: () => number;
  useDaemon?: boolean;
  createDaemon?: typeof createDaemonSession;
}

export interface SilveryController {
  getSnapshot(): SilverySnapshot;
  subscribe(listener: () => void): () => void;
  submit(text: string): Promise<void>;
  cancel(): void;
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

const SILVERY_DAEMON_CAPABILITIES = TUI_DAEMON_CAPABILITIES.filter(
  (capability) => capability !== EVENT_V2,
);

export async function createSilveryController(
  options: RunTuiOptions,
  deps: ControllerDeps = {},
): Promise<SilveryController> {
  const config = await (deps.loadConfig ?? loadConfig)();
  applyConfigToEnv(config);
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
  let daemonDisplayRows: SilveryTranscriptItem[] = [];
  let activityRows: SilveryTranscriptItem[] = [];
  let running = false;
  let startedAt: number | null = null;
  let error: string | null = null;
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
      .map((row, index) => ({ id: `history-${hiddenBefore + index}`, ...row }));

  const buildSnapshot = (): SilverySnapshot => ({
    rows: [
      ...historyRows(),
      ...daemonDisplayRows,
      ...activityRows,
      ...(liveText
        ? [{ id: 'assistant-live', role: 'assistant' as const, text: liveText, live: true }]
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
  });
  let currentSnapshot = buildSnapshot();
  const notify = () => {
    currentSnapshot = buildSnapshot();
    for (const listener of listeners) listener();
  };

  const onEvent = (event: EngineEvent) => {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    switch (event.type) {
      case 'assistant_token':
        liveText += String(payload.text ?? '');
        break;
      case 'assistant_done':
        if (daemonTurn && liveText) {
          daemonDisplayRows = [
            ...daemonDisplayRows,
            { id: nextId('daemon-assistant'), role: 'assistant', text: liveText },
          ];
        }
        liveText = '';
        break;
      case 'tool_call':
      case 'tool.execution_start':
      case 'tool_result':
      case 'tool.execution_complete':
        activityRows = [
          ...activityRows,
          { id: nextId('activity'), role: activityRole(event), text: activityText(event) },
        ];
        break;
      case 'warning':
      case 'error':
      case 'status':
        activityRows = [
          ...activityRows,
          {
            id: nextId('status'),
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
        activityRows = [...activityRows, { id: nextId('daemon'), role: 'status', text }];
        notify();
      },
      markFooterDirty: () => {
        daemonConnected = daemon.connected;
        notify();
      },
      markAllDirty: notify,
      onEngineEvent: (event) => {
        if (typeof event.seq === 'number') daemon.noteSeenSeq(event.seq);
        onEvent(event as EngineEvent);
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

  return {
    getSnapshot: () => currentSnapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async submit(rawText) {
      const text = rawText.trim();
      if (!text || running || disposed) return;
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
          daemonDisplayRows = [
            ...daemonDisplayRows,
            { id: nextId('daemon-user'), role: 'user', text },
          ];
          notify();
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
          daemonDisplayRows = [];
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
            // P1 has one modal (the command palette). Interactive approval and
            // ask-user dialogs remain fail-closed until their retained-mode panes land.
            approvalFn: async (tool) => {
              activityRows = [
                ...activityRows,
                {
                  id: nextId('approval'),
                  role: 'status',
                  text: `${tool} needs approval; denied because P1 only ships the command palette.`,
                },
              ];
              notify();
              return false;
            },
            askUserFn: async (question) => {
              activityRows = [
                ...activityRows,
                {
                  id: nextId('question'),
                  role: 'status',
                  text: `Question deferred: ${question}`,
                },
              ];
              notify();
              return '(skipped — make a reasonable assumption)';
            },
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
    },
    clearDisplay() {
      hiddenBefore = sessionMessagesToTranscriptRows(state.messages).length;
      daemonDisplayRows = [];
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
