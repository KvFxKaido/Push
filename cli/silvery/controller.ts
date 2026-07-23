import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  applyConfigToEnv,
  loadConfig,
  maskSecret,
  reapplyProviderConfigToEnv,
  saveConfig,
  type PushConfig,
} from '../config-store.js';
import { compactContext } from '../context-manager.js';
import { resolveExecSandboxBackend } from '../exec-sandbox.js';
import { runCheckpointCommand } from '../checkpoint-command.js';
import {
  requestDaemonAdmin,
  runRemoteCommand,
  runRemoteControlCommand,
  type DaemonAdminTransport,
} from '../daemon-admin.js';
import { tryConnect } from '../daemon-client.js';
import { DEFAULT_MAX_ROUNDS, runAssistantTurn, type EngineEvent } from '../engine.js';
import { appendUserMessageWithFileReferences } from '../file-references.js';
import { getCuratedModels } from '../model-catalog.js';
import { isInternalEnvelope } from '../message-envelopes.js';
import {
  getProviderList,
  PROVIDER_CONFIGS,
  redirectDeprecatedProvider,
  resolveApiKey,
  type ProviderConfig,
} from '../provider.js';
import { getLogPath, getPidPath, getSocketPath } from '../pushd.js';
import { getAuditLogPath, getAuditMaxBytes } from '../pushd-audit-log.js';
import { initCliSession } from '../session-init.js';
import {
  appendSessionEvent,
  getSessionRoot,
  listSessions,
  loadSessionState,
  rewriteMessagesLog,
  saveSessionState,
  type SessionListEntry,
  type SessionState,
} from '../session-store.js';
import { formatSkillDiagnostics, lintSkills, loadSkills } from '../skill-loader.js';
import { sessionMessagesToTranscriptRows } from '../tui-history.js';
import {
  createTerminalHandoff,
  resolveEditorCommand,
  type HandoffRunChild,
  type TerminalHandoff,
} from '../tui-handoff.js';
import { createDefaultTuiIo, type TuiIo } from '../tui-io.js';
import { osc52Copy } from '../tui-renderer.js';
import { copyLastResponse } from '../transcript-copy.js';
import { createDaemonSession, type DaemonClientLike } from '../tui-daemon-session.js';
import { scopeSessionsToWorkspace } from '../tui-fuzzy.js';
import { taskProgressEventToTranscript } from '../tui-task-progress.js';
import { getCompactGitStatus, type CompactGitStatus } from '../tui-status.js';
import { isReducedMotion, type StatusActivity } from '../tui-verbs.js';
import { detectThemeName, isThemeName, THEME_NAMES, VARIANTS } from '../tui-theme.js';
import { ESC } from '../tui-renderer.js';
import { formatUnknownEventWarning } from '../tui-daemon-handshake.js';
import { formatWorktreeStatus } from '../worktree.js';
import {
  applyDaemonTranscriptEvent,
  createDaemonTranscriptMirror,
  type DaemonTranscriptRow,
  type DaemonTranscriptSnapshot,
} from '../daemon-transcript-mirror.ts';
import { TUI_DAEMON_CAPABILITIES } from '../../lib/daemon-capabilities.js';
import { normalizeDaemonExecMode, type DaemonExecMode } from '../../lib/daemon-runtime-settings.js';
import { isTranscriptMutationEvent } from '../../lib/session-transcript-events.js';
import { isToolCardPayload } from '../../lib/tool-cards.js';
import type { RunTuiOptions } from './entry.js';
import {
  formatCitationsRow,
  formatEmptyRunWarning,
  isVisibleEmission,
  shouldWarnAboutUnknownSilveryEvent,
} from './event-diagnostics.js';

export type SilveryTranscriptItem = DaemonTranscriptRow;

export interface SilverySnapshot {
  rows: SilveryTranscriptItem[];
  running: boolean;
  /**
   * What Push is doing right now — drives the header's status verb.
   * Null when idle. DERIVED, never stored: see `currentActivity()`.
   */
  activity: StatusActivity;
  /** Stable per session — seeds the quiet-state mood verb so it can't flicker. */
  sessionId: string;
  startedAt: number | null;
  provider: string;
  model: string;
  cwd: string;
  gitStatus: CompactGitStatus | null;
  daemonConnected: boolean;
  error: string | null;
  interaction: SilveryInteraction | null;
  /** Idle-time model/provider chooser; null when no picker is open. */
  picker: SilveryPicker | null;
  /** Config editor; credential values are masked and raw drafts never enter this snapshot. */
  configEditor: SilveryConfigEditor | null;
  /** Ctrl+G reasoning live-tail. Text is limited to this TUI process: thinking
   * events are intentionally not persisted into transcript rows. */
  reasoning: {
    open: boolean;
    text: string;
    live: boolean;
  };
  /** Live theme preference — drives Silvery's semantic hues (v2 law 2). */
  theme: string;
  /** CLI exec mode (`auto` / `strict` / `yolo`) for the composer mode label. */
  execMode: string;
}

export type SilveryInteraction =
  | { id: string; kind: 'approval'; title: string; detail: string }
  | { id: string; kind: 'question'; title: string; detail: string };

export interface SilveryPickerOption {
  /** Provider id or model name — the value passed back to selectPickerOption. */
  id: string;
  label: string;
  /** Right-aligned annotation, e.g. `no key`. */
  hint?: string;
  /** The currently-active provider/model — cursor starts here. */
  current: boolean;
  /** Providers without a key can't be selected (shown dimmed). */
  disabled?: boolean;
  /** Session metadata used by the resume picker's two-column view. */
  session?: SessionListEntry;
}

export interface SilverySessionPreviewMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface SilverySessionPreview {
  /** Session whose preview is represented; prevents stale async paints. */
  optionId: string;
  loading: boolean;
  messages: SilverySessionPreviewMessage[];
  error?: string;
}

export interface SilveryPicker {
  kind: 'provider' | 'model' | 'session';
  title: string;
  options: SilveryPickerOption[];
  /** Cursor index to open on (the current option). */
  initialIndex: number;
  /** Fresh per open so the view remounts and re-centers the cursor. */
  token: number;
  /** Session picker scope; absent for provider/model pickers. */
  scope?: 'workspace' | 'all';
  /** Number of rows hidden by workspace scope. */
  scopedOutCount?: number;
  /** Async preview for the currently highlighted session. */
  preview?: SilverySessionPreview;
  /** Session rows are fetched asynchronously after the modal opens. */
  loading?: boolean;
  error?: string;
}

export interface SilveryConfigEditorItem {
  /** Provider id, credential id, or runtime preference id. */
  id: string;
  label: string;
  kind: 'secret' | 'toggle' | 'select';
  /** Safe display value. Secret rows contain only a masked value. */
  value: string;
  detail?: string;
  current: boolean;
  options?: Array<{ value: string; label: string; detail: string }>;
}

export interface SilveryConfigEditor {
  items: SilveryConfigEditorItem[];
  initialIndex: number;
  /** Opens directly in the masked field for `/config key` redirects. */
  initialEditTarget?: string;
  /** Fresh per open so local cursor/draft state cannot survive reopening. */
  token: number;
  saving: boolean;
  error?: string;
}

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
  /** IO seam for terminal handoff (tests inject fakes). */
  io?: TuiIo;
  /** Child runner for /editor handoff (tests inject a fake editor). */
  runHandoffChild?: HandoffRunChild;
  /** Called when the terminal leaves Silvery for an external program. */
  onHandoffSuspend?: () => void;
  /** Called when Silvery reclaims the terminal after handoff. */
  onHandoffResume?: () => void;
}

const SESSION_ID_RE = /^sess_[a-z0-9]+_[a-f0-9]{6}$/;

export interface SilveryController {
  getSnapshot(): SilverySnapshot;
  subscribe(listener: () => void): () => void;
  submit(text: string): Promise<void>;
  cancel(): void;
  respondToInteraction(id: string, value: boolean | string): void;
  /** Open a model/provider/session chooser (no-op while a turn is running). */
  openPicker(kind: 'provider' | 'model' | 'session'): void;
  /** Dismiss the open picker without switching. */
  closePicker(): void;
  /** Apply the highlighted provider/model/session; disabled options keep the picker open. */
  selectPickerOption(id: string): void;
  /** Load the highlighted session's recent messages into the preview pane. */
  previewPickerOption(id: string): void;
  /** Toggle the resume picker between this workspace and all workspaces. */
  toggleSessionPickerScope(): void;
  /** Open the masked config editor, optionally focused on one provider key. */
  openConfigEditor(targetId?: string): void;
  /** Dismiss the config editor and discard its surface-owned secret draft. */
  closeConfigEditor(): void;
  /** Toggle the reasoning live-tail, including while a turn is running. */
  toggleReasoning(): void;
  /** Dismiss the reasoning live-tail. */
  closeReasoning(): void;
  /** Persist a secret submitted by the masked field. Raw text is never snapshotted. */
  saveConfigSecret(targetId: string, secret: string): Promise<boolean>;
  /** Persist a non-secret preference selected in the config editor. */
  saveConfigPreference(targetId: string, value: string): Promise<boolean>;
  clearDisplay(): void;
  /**
   * Yank the last assistant response to the system clipboard (OSC 52).
   *
   * Copies the row's CONTENT, not the screen rectangle under it: a tool row
   * copies its diff or its declared card, so what lands on the clipboard is
   * something you can paste into `git apply` or a message — not gutters and
   * wrap artifacts. Always reports the outcome on the transcript, including
   * "nothing to copy" and "truncated", because OSC 52 gives no delivery
   * receipt and a silent no-op is indistinguishable from success.
   */
  copyLastResponse(): void;
  /** Wire Silvery Instance pause/resume after the renderer mounts. */
  setHandoffHooks(hooks: { onSuspend?: () => void; onResume?: () => void }): void;
  /**
   * After `/editor` succeeds, the composed draft is parked here for the
   * surface to load into the TextArea (composer is not controller-owned).
   */
  takePendingComposerText(): string | null;
  /**
   * User-typed prompts for composer Up/Down recall, oldest → newest.
   *
   * Derived at call time from the authoritative transcript source — persisted
   * session messages inline, the daemon mirror when attached — so recall works
   * across restarts and resumes without a separate history store. Slash
   * commands are handled locally and never persisted, so they are not
   * recallable; runtime-injected user turns (internal envelopes) are filtered
   * by the shared mapper. Unlike the display rows, this is NOT sliced by
   * clear-display — Ctrl+L hides the transcript, it doesn't forget prompts.
   */
  getPromptHistory(): string[];
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

/**
 * Reduce persisted messages to the recent human/assistant exchange shown by
 * the session picker. Internal user envelopes are runtime plumbing, not chat.
 */
export function sessionPreviewMessages(messages: unknown): SilverySessionPreviewMessage[] {
  if (!Array.isArray(messages)) return [];
  const preview: SilverySessionPreviewMessage[] = [];
  for (const value of messages) {
    if (!value || typeof value !== 'object') continue;
    const message = value as { role?: unknown; content?: unknown };
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    let content = '';
    if (typeof message.content === 'string') content = message.content;
    else {
      try {
        content = JSON.stringify(message.content) ?? String(message.content ?? '');
      } catch {
        content = String(message.content ?? '');
      }
    }
    if (!content.trim()) continue;
    if (message.role === 'user' && isInternalEnvelope(content.trim())) continue;
    preview.push({ role: message.role, content });
  }
  return preview.slice(-6);
}

/**
 * One line for a status / warning / error row.
 *
 * `phase` and `detail` COMPOSE; they are not alternatives. The old chain
 * (`message ?? detail ?? phase ?? type`) picked exactly one and put `detail`
 * ahead of `phase`, so a halt rendered as a bare "Hit 50 round limit" — the
 * consequence with the cause discarded — and a round tick rendered "Round 1"
 * rather than the phase it belonged to. Cause then action, per Visual Language
 * v2 law 11.
 */
function statusText(payload: Record<string, unknown>, eventType: string): string {
  const message = typeof payload.message === 'string' ? payload.message.trim() : '';
  if (message) return message;
  const phase = typeof payload.phase === 'string' ? payload.phase.trim() : '';
  const detail = typeof payload.detail === 'string' ? payload.detail.trim() : '';
  if (phase && detail) return `${phase} · ${detail}`;
  return phase || detail || eventType;
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
  let optimisticUserRow: SilveryTranscriptItem | null = null;
  let optimisticDaemonInsertIndex: number | null = null;
  /** Mirror row count at daemon-turn send time. The activity scan never looks
   *  below it: mirror rows persist across turns, and before the daemon echoes
   *  this turn's `user_message` there is no user row to stop at — without the
   *  floor, a pending call stranded by an earlier failed turn pins the verb. */
  let daemonTurnRowFloor = 0;
  let daemonMirror = createDaemonTranscriptMirror();
  let daemonHiddenBefore = 0;
  let running = false;
  let startedAt: number | null = null;
  let error: string | null = null;
  let interaction: SilveryInteraction | null = null;
  let picker: SilveryPicker | null = null;
  let pickerToken = 0;
  let configEditor: SilveryConfigEditor | null = null;
  let configEditorToken = 0;
  let reasoningModalOpen = false;
  let reasoningBuffer = '';
  let lastReasoning = '';
  let reasoningStreaming = false;
  const inlineUnknownEventTypes = new Set<string>();
  let sessionPickerRows: SessionListEntry[] = [];
  let sessionPreviewRequest = 0;
  // Visible-output count for the current run, for the empty-run diagnostic. Both
  // lanes feed `observeEventDiagnostics`; reset at run start (`submit`).
  let runVisibleEmissionCount = 0;
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
  let transcriptResyncSequence = 0;
  let execModeRefreshSequence = 0;
  let gitStatus = await (deps.gitStatus ?? getCompactGitStatus)(state.cwd);
  const listeners = new Set<() => void>();

  const nextId = (kind: string) => `${kind}-${++sequence}`;

  /**
   * What Push is doing right now, for the header verb.
   *
   * Derived from state that already exists — deliberately NOT a field updated
   * from the event switch. A stored `activity` would be a second state machine
   * tracking the same run, and the two would disagree on exactly the paths
   * nobody tests: a tool that errors, an abort mid-stream, a turn that ends
   * with calls still pending. Reading the answer out of `running` / `liveText`
   * / the pending rows makes desync unrepresentable rather than unlikely.
   *
   * `running` gates everything, which is what makes a stale pending row
   * harmless: `submit()` clears `activityRows` per turn, and the `finally`
   * drops `running` even on abort, so an unsettled call from a cancelled turn
   * can never pin the verb.
   *
   * Last pending call wins. Reads run in parallel (cap 6) so several can be
   * live at once, and the most recent one is the honest label — it is the one
   * that just changed.
   */
  const currentActivity = (): StatusActivity => {
    if (!running) return null;
    if (daemonStateStale) {
      // Daemon-backed turns render from the mirror, so the verb must derive
      // from the same rows the surface paints (Codex P2 on #1519). Unlike
      // `activityRows`, the mirror is the whole transcript — rows persist
      // across turns — so the scan is bounded twice: it never descends below
      // `daemonTurnRowFloor` (rows that predate this turn's send), and it
      // stops at a user row (the echo marks the turn start once it lands). A
      // pending call stranded by an earlier failed turn can satisfy neither.
      // `submit()`-cleared local rows never need this.
      for (let i = daemonMirror.rows.length - 1; i >= daemonTurnRowFloor; i -= 1) {
        const row = daemonMirror.rows[i];
        if (row?.kind === 'message' && row.role === 'user') break;
        if (row?.kind === 'tool' && row.pending && row.toolName) {
          return { kind: 'tool', toolName: row.toolName };
        }
      }
      return daemonMirror.liveText ? { kind: 'streaming' } : { kind: 'thinking' };
    }
    for (let i = activityRows.length - 1; i >= daemonTurnRowFloor; i -= 1) {
      const row = activityRows[i];
      if (row?.kind === 'tool' && row.pending && row.toolName) {
        return { kind: 'tool', toolName: row.toolName };
      }
    }
    // Tokens arriving means prose is streaming; silence means the model is
    // still deciding. Both clear per turn and at `assistant_done`.
    return liveText ? { kind: 'streaming' } : { kind: 'thinking' };
  };
  const historyRows = (): SilveryTranscriptItem[] =>
    sessionMessagesToTranscriptRows(state.messages)
      .slice(hiddenBefore)
      .map((row, index) => ({
        id: `history-${hiddenBefore + index}`,
        kind: 'message' as const,
        ...row,
      }));

  const resolveThemeName = (): string => {
    const fromConfig = config.theme;
    if (isThemeName(fromConfig)) return fromConfig;
    return detectThemeName();
  };
  const localExecMode = (): DaemonExecMode =>
    normalizeDaemonExecMode(process.env.PUSH_EXEC_MODE) ??
    normalizeDaemonExecMode(config.execMode) ??
    'auto';
  let execMode = localExecMode();

  const daemonTranscriptRows = (): SilveryTranscriptItem[] => {
    const rows = daemonMirror.rows.slice(daemonHiddenBefore);
    if (optimisticUserRow) {
      const insertAt =
        optimisticDaemonInsertIndex === null
          ? rows.length
          : Math.max(0, Math.min(rows.length, optimisticDaemonInsertIndex - daemonHiddenBefore));
      rows.splice(insertAt, 0, optimisticUserRow);
    }
    if (daemonMirror.liveText) {
      rows.push({
        id: 'daemon-assistant-live',
        kind: 'message',
        role: 'assistant',
        text: daemonMirror.liveText,
        live: true,
      });
    }
    return rows;
  };

  const buildSnapshot = (): SilverySnapshot => ({
    rows: daemonStateStale
      ? daemonTranscriptRows()
      : [
          ...historyRows(),
          ...(optimisticUserRow ? [optimisticUserRow] : []),
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
    activity: currentActivity(),
    sessionId: state.sessionId,
    startedAt,
    provider: state.provider,
    model: state.model,
    cwd: state.cwd,
    gitStatus,
    daemonConnected,
    error,
    interaction,
    picker,
    configEditor,
    reasoning: {
      open: reasoningModalOpen,
      text: reasoningBuffer || lastReasoning,
      live: reasoningStreaming,
    },
    theme: resolveThemeName(),
    execMode,
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

  let handoffSuspend = deps.onHandoffSuspend ?? (() => undefined);
  let handoffResume = deps.onHandoffResume ?? (() => undefined);
  let terminalHandoff: TerminalHandoff | null = null;

  // Hoisted out of getTerminalHandoff(): the clipboard write needs the same
  // stdout the handoff writes its ANSI through, and a test needs to be able to
  // inject one IO and observe both.
  const io = deps.io ?? createDefaultTuiIo();

  function getTerminalHandoff(): TerminalHandoff {
    if (!terminalHandoff) {
      terminalHandoff = createTerminalHandoff({
        io,
        // Mirror the ANSI handoff sequences: leave alt screen + mouse for the
        // child, reclaim and full-repaint on return (Silvery Instance.resume
        // also forces a full redraw when wired via setHandoffHooks).
        suspendSequence: () =>
          ESC.mouseOff +
          ESC.altScrollOn +
          ESC.bracketedPasteOff +
          ESC.cursorShow +
          ESC.altScreenOff +
          ESC.reset,
        resumeSequence: () =>
          ESC.altScreenOn +
          ESC.cursorHide +
          ESC.clearScreen +
          ESC.bracketedPasteOn +
          ESC.altScrollOff +
          ESC.mouseOn,
        onSuspend: () => handoffSuspend(),
        onResume: () => handoffResume(),
        runChild: deps.runHandoffChild,
      });
    }
    return terminalHandoff;
  }

  /**
   * Protocol-first session listing (mobile-drawer wire parity): prefer the
   * daemon `list_sessions` RPC; fall back to the disk lister for inline mode
   * and older daemons. Never spawns a daemon just to list.
   */
  async function fetchSessionRows(): Promise<SessionListEntry[]> {
    const res = await requestDaemonAdmin(
      daemon as DaemonAdminTransport,
      'list_sessions',
      { limit: 1000 },
      { timeoutMs: 1500, startDaemon: false },
    );
    if (res.ok && Array.isArray(res.payload?.sessions)) {
      return res.payload.sessions as SessionListEntry[];
    }
    const expected =
      !res.ok && (res.code === 'DAEMON_OFFLINE' || res.code === 'UNSUPPORTED_REQUEST_TYPE');
    if (!expected && (res.ok || res.code)) {
      console.error(
        JSON.stringify({
          level: 'warn',
          event: 'tui_list_sessions_rpc_failed',
          code: res.code ?? 'MALFORMED_PAYLOAD',
          message: res.error ?? null,
        }),
      );
    }
    return (deps.listSessions ?? listSessions)();
  }

  async function handleEditorCommand(): Promise<void> {
    const { command, args } = resolveEditorCommand();
    const tmpFile = path.join(
      os.tmpdir(),
      `push-editor-${process.pid}-${Date.now().toString(36)}.md`,
    );
    // Composer is cleared before slash dispatch (same as ANSI), so the external
    // editor starts empty — compose-in-$EDITOR, not "edit the /editor token".
    try {
      await fs.writeFile(tmpFile, '', { encoding: 'utf8', mode: 0o600 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendStatus(`/editor: could not create temp file: ${msg}`, true);
      return;
    }
    try {
      const result = await getTerminalHandoff().run({ command, args: [...args, tmpFile] });
      if (!result.ok) {
        appendStatus(
          `/editor: ${result.error ?? `editor exited via ${result.signal}`} (${command})`,
          true,
        );
        return;
      }
      if (result.exitCode !== 0) {
        appendStatus(
          `/editor: ${command} exited ${result.exitCode}; composer left unchanged.`,
          true,
        );
        return;
      }
      const edited = await fs.readFile(tmpFile, 'utf8');
      // Park for the surface TextArea (composer text is view-owned).
      pendingComposerText = edited.replace(/\r?\n$/, '');
      if (!pendingComposerText) {
        appendStatus('/editor: empty draft discarded.');
      }
      notify();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendStatus(`/editor: ${msg}`, true);
    } finally {
      fs.unlink(tmpFile).catch(() => {
        /* temp cleanup is best-effort */
      });
    }
  }

  /** Populated by /editor; surface reads via takePendingComposerText(). */
  let pendingComposerText: string | null = null;

  /**
   * Inline-lane diagnostics run before the local switch renders the event.
   * The daemon lane derives the same rows inside its daemon-owned transcript
   * mirror so a completion resync cannot erase them.
   */
  function observeInlineEventDiagnostics(event: EngineEvent): void {
    if (event.type === 'assistant_citations') {
      const sources = formatCitationsRow(event.payload);
      if (sources) {
        runVisibleEmissionCount += 1;
        appendStatus(sources);
      }
    } else if (isVisibleEmission(event.type)) runVisibleEmissionCount += 1;
  }

  /** Capture live provider reasoning without promoting it into transcript or
   * durable session state. `lastReasoning` keeps the completed turn available
   * until the next turn begins, matching the deleted ANSI TUI contract. */
  function observeReasoningEvent(event: EngineEvent): void {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    if (event.type === 'assistant_thinking_token') {
      const text = typeof payload.text === 'string' ? payload.text : '';
      if (text) {
        reasoningBuffer += text;
        reasoningStreaming = true;
      }
      return;
    }
    if (
      event.type === 'assistant_thinking_done' ||
      event.type === 'assistant_done' ||
      event.type === 'run_complete'
    ) {
      reasoningStreaming = false;
      if (reasoningBuffer.trim()) lastReasoning = reasoningBuffer;
    }
  }

  /**
   * On run completion, warn if the turn produced no visible output at all — the
   * Tool-Call Parser Convergence Gap symptom, otherwise an unexplained blank
   * turn. Always resets the counter for the next run.
   */
  function finishRunDiagnostics(): void {
    if (runVisibleEmissionCount === 0) appendStatus(formatEmptyRunWarning());
    runVisibleEmissionCount = 0;
  }

  const onEvent = (event: EngineEvent) => {
    observeReasoningEvent(event);
    observeInlineEventDiagnostics(event);
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    switch (event.type) {
      case 'assistant_thinking_token':
      case 'assistant_thinking_done':
        // Captured by observeReasoningEvent before the transcript switch.
        break;
      case 'assistant_token':
        liveText += String(payload.text ?? '');
        break;
      case 'assistant_done':
        liveText = '';
        break;
      case 'assistant.tool_prose':
        liveText = '';
        activityRows = [
          ...activityRows,
          {
            id: nextId('tool-prose'),
            kind: 'tool_prose',
            role: 'assistant',
            text: String(payload.text ?? ''),
          },
        ];
        break;
      case 'tool_call':
      case 'tool.execution_start': {
        const toolName = String(payload.toolName ?? '');
        const executionId = String(payload.executionId ?? '');
        activityRows = [
          ...activityRows,
          {
            id: nextId('activity'),
            kind: 'tool',
            role: activityRole(event),
            text: activityText(event),
            pending: true,
            ...(toolName ? { toolName } : {}),
            ...(executionId ? { executionId } : {}),
          },
        ];
        break;
      }
      case 'tool_result':
      case 'tool.execution_complete': {
        const toolName = String(payload.toolName ?? '');
        const target = String(payload.target ?? '');
        const executionId = String(payload.executionId ?? '');
        // Settle the matching pending start row (by executionId, like the
        // daemon mirror) rather than appending a duplicate; fall back to a
        // fresh row when there was no correlated start.
        const settled = {
          text: activityText(event),
          pending: false,
          isError: payload.isError === true,
          ...(toolName ? { toolName } : {}),
          ...(target ? { target } : {}),
          ...(isToolCardPayload(payload.card) ? { card: payload.card } : {}),
        };
        let idx = executionId
          ? activityRows.findIndex(
              (row) => row.kind === 'tool' && row.pending && row.executionId === executionId,
            )
          : -1;
        // Legacy events may not carry executionId, and old persisted starts
        // may carry an id that does not match the completion. Mirror the
        // daemon transcript's reverse name scan so those rows still settle.
        if (idx < 0) {
          for (let i = activityRows.length - 1; i >= daemonTurnRowFloor; i -= 1) {
            const row = activityRows[i];
            if (row?.kind === 'tool' && row.pending && row.toolName === toolName) {
              idx = i;
              break;
            }
          }
        }
        activityRows =
          idx >= 0
            ? activityRows.map((row, i) => (i === idx ? { ...row, ...settled } : row))
            : [
                ...activityRows,
                { id: nextId('activity'), kind: 'tool', role: activityRole(event), ...settled },
              ];
        break;
      }
      case 'warning':
      case 'error':
      case 'status':
        activityRows = [
          ...activityRows,
          {
            id: nextId('status'),
            kind: 'status',
            role: 'status',
            text: statusText(payload, event.type),
          },
        ];
        break;
      case 'task.ledger_snapshot':
      case 'task.drift_changed': {
        const entry = taskProgressEventToTranscript(event);
        if (entry) {
          activityRows = [
            ...activityRows,
            {
              id: nextId('task-progress'),
              kind: 'status',
              role: 'status',
              text: entry.text,
              isError: entry.role === 'warning',
            },
          ];
        }
        break;
      }
      case 'run_complete':
        finishRunDiagnostics();
        running = false;
        startedAt = null;
        resolveDaemonTurn?.();
        resolveDaemonTurn = null;
        break;
      default:
        if (shouldWarnAboutUnknownSilveryEvent(inlineUnknownEventTypes, event.type, 'inline')) {
          runVisibleEmissionCount += 1;
          appendStatus(formatUnknownEventWarning(event.type));
        }
    }
    notify();
  };

  const onDaemonEvent = (event: EngineEvent & { seq?: number }) => {
    observeReasoningEvent(event);
    applyDaemonTranscriptEvent(daemonMirror, {
      seq: typeof event.seq === 'number' ? event.seq : 0,
      type: event.type,
      payload: event.payload,
    });
    // The daemon echo is authoritative. Drop the local submit-time row in the
    // same repaint so a healthy echo replaces it without a duplicate flash.
    if (event.type === 'user_message') {
      optimisticUserRow = null;
      optimisticDaemonInsertIndex = null;
      // A user_message is the turn boundary in the daemon lane. A remote-initiated
      // turn never passes through submit(), so without this reset the modal would
      // show the previous turn's reasoning as current and append the new turn's
      // tokens onto it. For a local submit this is a harmless double-clear: the
      // daemon appends the user message before running the model, so the echo
      // always precedes the same turn's thinking tokens.
      reasoningBuffer = '';
      lastReasoning = '';
      reasoningStreaming = false;
    }
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
        reasoningModalOpen = false;
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
        execMode = localExecMode();
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
        void refreshDaemonExecMode();
        void resyncDaemonTranscript('attach');
        notify();
      },
      invalidateReconnectAnimators: notify,
    },
    SILVERY_DAEMON_CAPABILITIES,
  );

  async function refreshDaemonExecMode(): Promise<boolean> {
    if (!daemon.connected || !daemon.client) return false;
    const sequence = ++execModeRefreshSequence;
    try {
      const response = await daemon.client.request('get_daemon_runtime_config', {}, null, 1500);
      const resolved = normalizeDaemonExecMode(response.payload?.execMode);
      if (!resolved || sequence !== execModeRefreshSequence) return false;
      execMode = resolved;
      notify();
      return true;
    } catch {
      return false;
    }
  }

  if (deps.useDaemon !== false) {
    daemonConnected = await daemon.ensureConnected({ announce: false });
    if (daemonConnected) await refreshDaemonExecMode();
    notify();
  }

  async function resyncDaemonTranscript(reason: string): Promise<boolean> {
    if (!daemon.connected || !daemon.sessionId || !daemon.attachToken) return false;
    const resyncSequence = ++transcriptResyncSequence;
    try {
      const response = await daemon.client!.request(
        'get_session_snapshot',
        {
          sessionId: daemon.sessionId,
          attachToken: daemon.attachToken,
          recentEventLimit: 1,
          capabilities: [...SILVERY_DAEMON_CAPABILITIES],
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
      // Attach, mutation, and run-complete resyncs are intentionally
      // fire-and-forget. Never let an older response overwrite a newer
      // request, or let a snapshot taken before live events replace the
      // already-advanced mirror while a turn is running.
      if (resyncSequence !== transcriptResyncSequence) return false;
      if (
        !isTranscriptMutationEvent(reason) &&
        typeof snapshot.lastSeq === 'number' &&
        snapshot.lastSeq < daemonMirror.lastSeq
      ) {
        return false;
      }
      daemonMirror = createDaemonTranscriptMirror(snapshot);
      if (reason !== 'before_send') {
        optimisticUserRow = null;
        optimisticDaemonInsertIndex = null;
      }
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
      if (resyncSequence !== transcriptResyncSequence) return false;
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

  /**
   * Shared provider switch used by `/provider <name|#>` and the picker. Fails
   * closed with a status line on a missing key; routes through the daemon when
   * attached, else mutates local state — same path the slash command has always
   * taken, extracted so the picker never re-implements it.
   */
  async function applyProviderSwitch(targetId: string): Promise<void> {
    const targetConfig = PROVIDER_CONFIGS[targetId];
    if (!targetConfig) {
      appendStatus(`Unknown provider: ${targetId}`, true);
      return;
    }
    if (targetId === state.provider) {
      // The picker opens its cursor on the current provider, so a bare Enter
      // lands here. Recomputing targetModel from saved config/default would
      // silently reset a CLI/free-text or resumed-daemon model — no-op instead
      // and keep the active model (mirrors applyModelSwitch's same-value guard).
      appendStatus(`Already on provider ${targetId}.`);
      return;
    }
    try {
      (deps.resolveKey ?? resolveApiKey)(targetConfig);
    } catch {
      appendStatus(`Cannot switch to ${targetId}: no API key.`, true);
      return;
    }
    const providerSlot = config[targetId] as { model?: string } | undefined;
    const targetModel = providerSlot?.model || targetConfig.defaultModel;
    if (daemon.connected && daemon.sessionId) {
      const ok = await patchDaemonSession({ provider: targetId, model: targetModel });
      if (!ok) return;
    } else {
      state.provider = targetId;
      state.model = targetModel;
      await (deps.saveState ?? saveSessionState)(state);
    }
    config.provider = targetId;
    await persistConfig(config);
    appendStatus(`Switched to ${state.provider} | model: ${state.model}`);
    notify();
  }

  /** Shared model switch used by `/model <name|#>` and the picker. */
  async function applyModelSwitch(target: string): Promise<void> {
    if (target === state.model) {
      appendStatus(`Already using model: ${target}`);
      return;
    }
    if (daemon.connected && daemon.sessionId) {
      const ok = await patchDaemonSession({ model: target });
      if (!ok) return;
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
  }

  /** Shared session switch used by `/resume <id>` and the resume picker. */
  async function applySessionSwitch(targetId: string): Promise<void> {
    if (targetId === state.sessionId) {
      appendStatus(`Already on session ${state.sessionId}.`);
      return;
    }
    try {
      const next = await (deps.loadState ?? loadSessionState)(targetId);
      const previousState = { ...state };
      const previousPersisted = persisted;
      const replaceSessionState = (replacement: typeof state) => {
        for (const key of Object.keys(state)) delete state[key];
        Object.assign(state, replacement);
      };
      replaceSessionState(next);
      persisted = true;

      if (daemon.connected && !(await daemon.rebindExistingSession())) {
        replaceSessionState(previousState);
        persisted = previousPersisted;
        const restored = await daemon.rebindExistingSession();
        throw new Error(
          `pushd could not attach session ${targetId}${
            restored ? '; the previous daemon session was restored' : '; the daemon is now detached'
          }`,
        );
      }
      daemonMirror = createDaemonTranscriptMirror();
      daemonHiddenBefore = 0;
      daemonStateStale = false;
      activityRows = [];
      liveText = '';
      reasoningModalOpen = false;
      reasoningBuffer = '';
      lastReasoning = '';
      reasoningStreaming = false;
      hiddenBefore = 0;
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
  }

  function maskedProviderKey(providerId: string): string {
    const providerBranch = config[providerId];
    const configured =
      providerBranch && typeof providerBranch === 'object'
        ? (providerBranch as { apiKey?: unknown }).apiKey
        : undefined;
    if (configured) return maskSecret(configured) || '(not set)';
    const provider = PROVIDER_CONFIGS[providerId];
    if (!provider) return '(not set)';
    try {
      return maskSecret((deps.resolveKey ?? resolveApiKey)(provider)) || '(not set)';
    } catch {
      return '(not set)';
    }
  }

  function buildConfigEditor(targetId?: string): SilveryConfigEditor {
    const items: SilveryConfigEditorItem[] = getProviderList().map((provider) => {
      const branch = config[provider.id];
      const model =
        branch && typeof branch === 'object' ? (branch as { model?: unknown }).model : undefined;
      return {
        id: provider.id,
        label: provider.id,
        kind: 'secret' as const,
        value: maskedProviderKey(provider.id),
        detail: typeof model === 'string' && model ? model : provider.defaultModel,
        current: provider.id === state.provider,
      };
    });
    const tavilyKey = config.tavilyApiKey || process.env.PUSH_TAVILY_API_KEY;
    items.push({
      id: 'tavily',
      label: 'tavily',
      kind: 'secret',
      value: maskSecret(tavilyKey) || '(not set)',
      detail: 'web search',
      current: false,
    });
    const sandbox = resolveExecSandboxBackend(
      process.env.PUSH_LOCAL_SANDBOX ?? config.localSandbox,
    );
    items.push({
      id: 'sandbox',
      label: 'sandbox',
      kind: 'select',
      value: sandbox,
      detail: 'exec isolation',
      current: false,
      options: [
        { value: 'host', label: 'host', detail: 'run directly on this machine' },
        { value: 'docker', label: 'docker', detail: 'isolated Docker sandbox' },
        { value: 'native', label: 'native', detail: 'native sandbox backend' },
      ],
    });
    items.push({
      id: 'execMode',
      label: 'exec mode',
      kind: 'select',
      value: localExecMode(),
      detail: 'command approvals',
      current: false,
      options: [
        { value: 'strict', label: 'strict', detail: 'prompt before every exec command' },
        { value: 'auto', label: 'auto', detail: 'prompt only for high-risk commands' },
        { value: 'yolo', label: 'yolo', detail: 'no exec prompts' },
      ],
    });
    const explainEnv = process.env.PUSH_EXPLAIN_MODE;
    const explainOn =
      explainEnv === undefined
        ? config.explainMode === true || config.explainMode === 'true'
        : explainEnv === 'true';
    items.push({
      id: 'explain',
      label: 'explain',
      kind: 'toggle',
      value: explainOn ? 'on' : 'off',
      detail: 'tool narration',
      current: false,
    });
    const daemonAuto = !(
      process.env.PUSH_TUI_DAEMON_AUTOSTART === 'false' ||
      config.tuiDaemonAutoStart === false ||
      config.tuiDaemonAutoStart === 'false'
    );
    items.push({
      id: 'daemon',
      label: 'daemon',
      kind: 'toggle',
      value: daemonAuto ? 'auto' : 'off',
      detail: 'TUI autostart',
      current: false,
    });
    const requestedIndex = targetId ? items.findIndex((item) => item.id === targetId) : -1;
    const requestedItem = requestedIndex >= 0 ? items[requestedIndex] : undefined;
    const currentIndex = items.findIndex((item) => item.current);
    return {
      items,
      initialIndex: requestedIndex >= 0 ? requestedIndex : Math.max(0, currentIndex),
      initialEditTarget: requestedItem?.kind === 'secret' ? targetId : undefined,
      token: (configEditorToken += 1),
      saving: false,
    };
  }

  function openConfigEditor(targetId?: string): void {
    if (running) {
      appendStatus('Finish or cancel the turn before editing config.', true);
      return;
    }
    picker = null;
    reasoningModalOpen = false;
    configEditor = buildConfigEditor(targetId);
    notify();
  }

  function closeConfigEditor(): void {
    if (!configEditor) return;
    configEditor = null;
    notify();
  }

  function toggleReasoning(): void {
    reasoningModalOpen = !reasoningModalOpen;
    if (reasoningModalOpen) {
      picker = null;
      configEditor = null;
    }
    notify();
  }

  function closeReasoning(): void {
    if (!reasoningModalOpen) return;
    reasoningModalOpen = false;
    notify();
  }

  async function notifyDaemonConfigReload(): Promise<void> {
    const client = daemon.client;
    if (!client?.connected) return;
    try {
      await client.request('reload_config', {}, null, 3000);
      await refreshDaemonExecMode();
    } catch (cause) {
      const code =
        cause && typeof cause === 'object' && 'code' in cause
          ? String((cause as { code?: unknown }).code || '')
          : '';
      if (code === 'UNSUPPORTED_REQUEST_TYPE') return;
      const message = cause instanceof Error ? cause.message : String(cause);
      io.stderr.write(
        `${JSON.stringify({ level: 'warn', event: 'silvery_config_reload_notify_failed', message })}\n`,
      );
    }
  }

  async function notifyDaemonRuntimeConfig(
    patch: { execMode?: string; sandboxBackend?: string },
    failureEvent: string,
  ): Promise<boolean> {
    const client = daemon.client;
    if (!client?.connected) return deps.useDaemon === false;
    try {
      await client.request('set_daemon_runtime_config', { patch }, null, 3000);
      return true;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      io.stderr.write(`${JSON.stringify({ level: 'warn', event: failureEvent, message })}\n`);
      return false;
    }
  }

  function refreshOpenConfigEditor(active: SilveryConfigEditor): void {
    if (configEditor !== active) return;
    const refreshed = buildConfigEditor();
    refreshed.token = active.token;
    refreshed.initialIndex = active.initialIndex;
    configEditor = refreshed;
  }

  async function saveConfigSecret(targetId: string, rawSecret: string): Promise<boolean> {
    const secret = rawSecret.trim();
    const active = configEditor;
    if (!secret) {
      if (active) {
        active.error = 'Key cannot be empty.';
        notify();
      }
      return false;
    }
    if (targetId !== 'tavily' && !PROVIDER_CONFIGS[targetId]) {
      if (active) {
        active.error = `Unknown provider: ${targetId}`;
        notify();
      }
      return false;
    }

    if (active) {
      active.saving = true;
      active.error = undefined;
      notify();
    }
    const previous = targetId === 'tavily' ? config.tavilyApiKey : config[targetId];
    try {
      if (targetId === 'tavily') {
        config.tavilyApiKey = secret;
      } else {
        const branch =
          config[targetId] && typeof config[targetId] === 'object'
            ? { ...(config[targetId] as Record<string, unknown>) }
            : {};
        branch.apiKey = secret;
        config[targetId] = branch;
      }
      await persistConfig(config);
      reapplyProviderConfigToEnv(config);
      await notifyDaemonConfigReload();

      if (active) refreshOpenConfigEditor(active);
      appendStatus(
        `${targetId === 'tavily' ? 'Tavily' : targetId} API key saved (${maskSecret(secret)}).`,
      );
      return true;
    } catch {
      if (targetId === 'tavily') {
        config.tavilyApiKey = previous as string | undefined;
      } else if (previous === undefined) {
        delete config[targetId];
      } else {
        config[targetId] = previous;
      }
      if (configEditor === active && active) {
        active.saving = false;
        active.error = 'Failed to save key. Check config file permissions and try again.';
        notify();
      }
      return false;
    }
  }

  async function saveConfigPreference(targetId: string, value: string): Promise<boolean> {
    const allowed =
      targetId === 'sandbox'
        ? ['host', 'docker', 'native']
        : targetId === 'execMode'
          ? ['strict', 'auto', 'yolo']
          : targetId === 'explain'
            ? ['on', 'off']
            : targetId === 'daemon'
              ? ['auto', 'off']
              : [];
    const active = configEditor;
    if (!allowed.includes(value)) {
      if (active) {
        active.error = 'Invalid config preference.';
        notify();
      }
      return false;
    }

    if (active) {
      active.saving = true;
      active.error = undefined;
      notify();
    }
    const previous =
      targetId === 'sandbox'
        ? config.localSandbox
        : targetId === 'execMode'
          ? config.execMode
          : targetId === 'explain'
            ? config.explainMode
            : config.tuiDaemonAutoStart;
    let daemonSandboxSynced = true;
    try {
      if (targetId === 'sandbox') config.localSandbox = value === 'host' ? false : value;
      else if (targetId === 'execMode') config.execMode = value;
      else if (targetId === 'explain') config.explainMode = value === 'on';
      else config.tuiDaemonAutoStart = value === 'auto';
      await persistConfig(config);

      if (targetId === 'sandbox') {
        process.env.PUSH_LOCAL_SANDBOX = value;
        daemonSandboxSynced = await notifyDaemonRuntimeConfig(
          { sandboxBackend: value },
          'silvery_sandbox_backend_notify_failed',
        );
      } else if (targetId === 'execMode') {
        process.env.PUSH_EXEC_MODE = value;
        execMode = normalizeDaemonExecMode(value) ?? 'auto';
        if (
          await notifyDaemonRuntimeConfig({ execMode: value }, 'silvery_exec_mode_notify_failed')
        ) {
          await refreshDaemonExecMode();
        }
      } else if (targetId === 'explain') process.env.PUSH_EXPLAIN_MODE = String(value === 'on');
      else process.env.PUSH_TUI_DAEMON_AUTOSTART = String(value === 'auto');

      if (active) refreshOpenConfigEditor(active);
      appendStatus(
        targetId === 'sandbox' && !daemonSandboxSynced
          ? `sandbox: ${value}. Restart pushd to apply it to daemon-backed exec.`
          : `${targetId === 'execMode' ? 'Exec mode' : targetId}: ${value}`,
      );
      return true;
    } catch {
      if (targetId === 'sandbox') config.localSandbox = previous;
      else if (targetId === 'execMode') config.execMode = previous as string | undefined;
      else if (targetId === 'explain') config.explainMode = previous;
      else config.tuiDaemonAutoStart = previous;
      if (configEditor === active && active) {
        active.saving = false;
        active.error = 'Failed to save preference. Check config file permissions and try again.';
        notify();
      }
      return false;
    }
  }

  function buildProviderPicker(): SilveryPicker {
    const options: SilveryPickerOption[] = getProviderList().map((entry) => ({
      id: entry.id,
      label: entry.id,
      hint: entry.hasKey ? undefined : 'no key',
      current: entry.id === state.provider,
      disabled: !entry.hasKey,
    }));
    const currentIndex = options.findIndex((option) => option.current);
    return {
      kind: 'provider',
      title: 'Switch provider',
      options,
      initialIndex: currentIndex >= 0 ? currentIndex : 0,
      token: (pickerToken += 1),
    };
  }

  function buildModelPicker(): SilveryPicker {
    const options: SilveryPickerOption[] = getCuratedModels(state.provider).map((name) => ({
      id: name,
      label: name,
      current: name === state.model,
    }));
    const currentIndex = options.findIndex((option) => option.current);
    return {
      kind: 'model',
      title: `Switch model · ${state.provider}`,
      options,
      initialIndex: currentIndex >= 0 ? currentIndex : 0,
      token: (pickerToken += 1),
    };
  }

  function buildSessionPicker(scope: 'workspace' | 'all'): SilveryPicker {
    const workspaceRows = scopeSessionsToWorkspace(sessionPickerRows, state.cwd);
    const rows = scope === 'workspace' ? workspaceRows : sessionPickerRows;
    const options: SilveryPickerOption[] = rows.map((entry) => ({
      id: entry.sessionId,
      label: entry.sessionName || entry.sessionId,
      hint: `${entry.provider}/${entry.model}`,
      current: entry.sessionId === state.sessionId,
      session: entry,
    }));
    const currentIndex = options.findIndex((option) => option.current);
    return {
      kind: 'session',
      title: 'Resume session',
      options,
      initialIndex: currentIndex >= 0 ? currentIndex : 0,
      token: (pickerToken += 1),
      scope,
      scopedOutCount: sessionPickerRows.length - rows.length,
    };
  }

  async function loadSessionPickerPreview(target: SilveryPicker, optionId: string): Promise<void> {
    if (target.kind !== 'session') return;
    const option = target.options.find((candidate) => candidate.id === optionId);
    if (!option) return;
    const request = (sessionPreviewRequest += 1);
    target.preview = { optionId, loading: true, messages: [] };
    if (picker === target) notify();
    try {
      const previewState =
        optionId === state.sessionId ? state : await (deps.loadState ?? loadSessionState)(optionId);
      if (picker !== target || request !== sessionPreviewRequest) return;
      target.preview = {
        optionId,
        loading: false,
        messages: sessionPreviewMessages(previewState.messages),
      };
    } catch {
      if (picker !== target || request !== sessionPreviewRequest) return;
      target.preview = {
        optionId,
        loading: false,
        messages: [],
        error: 'Failed to load preview',
      };
    }
    notify();
  }

  async function openSessionPicker(): Promise<void> {
    if (running) {
      appendStatus('Finish or cancel the turn before resuming another session.', true);
      return;
    }
    const loadingPicker: SilveryPicker = {
      kind: 'session',
      title: 'Resume session',
      options: [],
      initialIndex: 0,
      token: (pickerToken += 1),
      loading: true,
      scope: 'workspace',
      scopedOutCount: 0,
    };
    picker = loadingPicker;
    notify();
    try {
      sessionPickerRows = await fetchSessionRows();
      if (picker !== loadingPicker) return;
      const workspaceRows = scopeSessionsToWorkspace(sessionPickerRows, state.cwd);
      const scope = workspaceRows.length > 0 ? 'workspace' : 'all';
      const next = buildSessionPicker(scope);
      picker = next;
      notify();
      const initial = next.options[next.initialIndex];
      if (initial) await loadSessionPickerPreview(next, initial.id);
    } catch (cause) {
      if (picker !== loadingPicker) return;
      loadingPicker.loading = false;
      loadingPicker.error = `Failed to list sessions: ${
        cause instanceof Error ? cause.message : String(cause)
      }`;
      notify();
    }
  }

  function openPicker(kind: 'provider' | 'model' | 'session'): void {
    if (running) {
      appendStatus('Finish or cancel the turn before opening a picker.', true);
      return;
    }
    configEditor = null;
    reasoningModalOpen = false;
    if (kind === 'session') {
      void openSessionPicker();
      return;
    }
    if (kind === 'model' && getCuratedModels(state.provider).length === 0) {
      appendStatus(`No curated models for ${state.provider}. Use /model <name>.`);
      return;
    }
    picker = kind === 'provider' ? buildProviderPicker() : buildModelPicker();
    notify();
  }

  function closePicker(): void {
    if (!picker) return;
    sessionPreviewRequest += 1;
    picker = null;
    notify();
  }

  function previewPickerOption(id: string): void {
    const active = picker;
    if (!active || active.kind !== 'session') return;
    void loadSessionPickerPreview(active, id);
  }

  function toggleSessionPickerScope(): void {
    const active = picker;
    if (!active || active.kind !== 'session' || active.loading) return;
    sessionPreviewRequest += 1;
    const next = buildSessionPicker(active.scope === 'workspace' ? 'all' : 'workspace');
    picker = next;
    notify();
    const initial = next.options[next.initialIndex];
    if (initial) void loadSessionPickerPreview(next, initial.id);
  }

  async function selectPicker(id: string): Promise<void> {
    const active = picker;
    if (!active) return;
    const option = active.options.find((candidate) => candidate.id === id);
    if (!option) return;
    if (option.disabled) {
      // Keep the picker open so the user can pick a usable provider instead.
      appendStatus(`${id} needs an API key. Set one with /config key <secret>.`, true);
      return;
    }
    // Hold the picker open (composer stays inert) until the switch lands, so a
    // daemon-backed session can't submit a turn on the pre-switch provider/model
    // while patchDaemonSession is still in flight. Clear on success or failure.
    try {
      if (active.kind === 'provider') await applyProviderSwitch(id);
      else if (active.kind === 'model') await applyModelSwitch(id);
      else await applySessionSwitch(id);
    } finally {
      sessionPreviewRequest += 1;
      picker = null;
      notify();
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
          '  /provider [name|#]     Open the provider picker or switch directly',
          '  /model [name|#]        Open the model picker or switch directly',
          '  /config                Open the masked API-key editor',
          '  /config key [provider] Open a provider directly in the editor',
          '  /config url|sandbox|…  Set non-secret runtime preferences',
          '  /resume [session-id]   Open the session picker or switch directly',
          '  /skills [reload|lint]  List, reload, or lint workspace skills',
          '  /compact [turns]       Compact context (default preserve 6 turns)',
          '  /revert [turns]        Daemon: remove recent user turns',
          '  /unrevert              Daemon: restore the last reverted tail',
          '  /children [id]         List or inspect delegated child runs',
          '  /checkpoint …          Snapshot / restore conversation + files',
          '  /remote …              Manage Remote relay + phone pairing',
          '  /rc [pair]             Hand this session to your phone',
          '  /daemon status|restart Show pushd status or reconnect',
          '  /theme [list|name]     List or set the saved theme preference',
          '  /editor                Compose the prompt in $EDITOR (PUSH_EDITOR/VISUAL/EDITOR)',
          '  /debug runtime         Runtime path/provider/session diagnostics',
          '  /worktree              Show worktree sandbox status',
          '  /exit | /quit          Use the command palette or Ctrl+C to exit',
          '',
          'Keys:',
          '  Tab / Shift+Tab        Complete and cycle slash commands or @paths',
          '  Ctrl+K                 Open the command palette',
          '  Ctrl+P                 Open the provider picker',
          '  Ctrl+R                 Open the session picker',
          '  Ctrl+L                 Clear the transcript display',
          '  Ctrl+O                 Copy the last response to the clipboard',
          '  Ctrl+G                 Toggle the reasoning live-tail',
          '  Ctrl+C                 Cancel the active turn or exit while idle',
          '  Shift/Alt+Enter        Insert a newline',
          '  Ctrl+A/E · Alt+B/F     Line start/end · word backward/forward',
          '  Ctrl+U/W · Ctrl+Y      Delete to line start/word · paste deletion',
          '  Up/Down                Recall prompt history at the composer edge',
          '  Ctrl+Z · Ctrl+Shift+Z  Undo / redo composer edits (Ctrl+_ also undoes)',
          '  ?                      Show this help from an empty composer',
        ].join('\n'),
      );
      return true;
    }

    if (command === 'editor') {
      await handleEditorCommand();
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
      reasoningBuffer = '';
      // Without this the buffer wipe is unobservable: the snapshot falls back to
      // `lastReasoning`, which between turns holds the identical text.
      lastReasoning = '';
      reasoningStreaming = false;
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
      // Bare `/provider` opens the navigable picker; an arg switches directly.
      if (!arg) {
        openPicker('provider');
        return true;
      }
      const providers = getProviderList();
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
      await applyProviderSwitch(targetId);
      return true;
    }

    if (command === 'model') {
      // Bare `/model` opens the navigable picker; an arg switches directly.
      if (!arg) {
        openPicker('model');
        return true;
      }
      const models = [...getCuratedModels(state.provider)];
      let target = arg;
      if (/^\d+$/.test(arg)) {
        const num = Number.parseInt(arg, 10);
        if (num < 1 || num > models.length) {
          appendStatus(`Model index out of range: ${num}`, true);
          return true;
        }
        target = models[num - 1]!;
      }
      await applyModelSwitch(target);
      return true;
    }

    if (command === 'config') {
      if (!arg) {
        openConfigEditor();
        return true;
      }
      const [sub, ...restArgs] = arg.split(/\s+/);
      const subcommand = sub?.toLowerCase() ?? '';
      if (subcommand === 'key') {
        const candidate = restArgs[0]?.toLowerCase();
        const redirected = candidate ? (redirectDeprecatedProvider(candidate) ?? candidate) : '';
        openConfigEditor(redirected && PROVIDER_CONFIGS[redirected] ? redirected : state.provider);
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
      if (subcommand === 'tavily') {
        openConfigEditor('tavily');
        return true;
      }
      if (subcommand === 'sandbox') {
        const mode = (restArgs[0] || '').toLowerCase();
        if (!['on', 'off', 'host', 'docker', 'native'].includes(mode)) {
          appendStatus('Usage: /config sandbox host|docker|native', true);
          return true;
        }
        const backend = resolveExecSandboxBackend(
          mode === 'on' ? 'docker' : mode === 'off' ? 'host' : mode,
        );
        config.localSandbox = backend === 'host' ? false : backend;
        await persistConfig(config);
        process.env.PUSH_LOCAL_SANDBOX = backend;
        appendStatus(`Exec sandbox saved: ${backend}. Restart Push/pushd to apply it everywhere.`);
        return true;
      }
      if (subcommand === 'explain') {
        const mode = (restArgs[0] || '').toLowerCase();
        if (mode !== 'on' && mode !== 'off') {
          appendStatus('Usage: /config explain on|off', true);
          return true;
        }
        config.explainMode = mode === 'on';
        await persistConfig(config);
        applyConfigToEnv(config);
        appendStatus(`Explain mode: ${mode}`);
        return true;
      }
      if (subcommand === 'daemon') {
        const mode = (restArgs[0] || '').toLowerCase();
        if (mode !== 'auto' && mode !== 'off') {
          appendStatus('Usage: /config daemon auto|off', true);
          return true;
        }
        config.tuiDaemonAutoStart = mode === 'auto';
        process.env.PUSH_TUI_DAEMON_AUTOSTART = mode === 'auto' ? 'true' : 'false';
        await persistConfig(config);
        appendStatus(`Daemon autostart: ${mode}`);
        return true;
      }
      appendStatus(
        'Usage: /config | /config key [provider] | /config tavily | /config url <url> | /config sandbox host|docker|native | /config explain on|off | /config daemon auto|off',
        true,
      );
      return true;
    }

    if (command === 'resume') {
      if (!arg) {
        await openSessionPicker();
        return true;
      }
      if (!SESSION_ID_RE.test(arg)) {
        appendStatus('Usage: /resume | /resume <session-id>', true);
        return true;
      }
      await applySessionSwitch(arg);
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

    if (command === 'checkpoint') {
      await runCheckpointCommand(
        arg,
        {
          workspaceRoot: state.cwd,
          sessionId: state.sessionId,
          messages: state.messages,
          provider: state.provider,
          model: state.model,
        },
        {
          status: (text) => appendStatus(text),
          warning: (text) => appendStatus(text, true),
          error: (text) => appendStatus(`checkpoint: ${text}`, true),
          bold: (text) => text,
          dim: (text) => text,
          code: (text) => `\`${text}\``,
        },
      );
      return true;
    }

    if (command === 'remote') {
      await runRemoteCommand(
        arg,
        daemon as DaemonAdminTransport,
        (level, text) => {
          appendStatus(text, level === 'error' || level === 'warning');
        },
        {
          maskSecret,
          onMintedAttachToken: (token) => {
            state.attachToken = token;
          },
        },
      );
      return true;
    }

    if (command === 'rc') {
      await runRemoteControlCommand(
        arg,
        daemon as DaemonAdminTransport,
        (level, text) => {
          appendStatus(text, level === 'error' || level === 'warning');
        },
        {
          sessionName: state.sessionName,
          onMintedAttachToken: (token) => {
            state.attachToken = token;
          },
        },
      );
      return true;
    }

    if (command === 'daemon') {
      const sub = (arg.split(/\s+/)[0] || 'status').toLowerCase();
      if (sub === 'status' || sub === 'show' || !arg) {
        const autostart =
          process.env.PUSH_TUI_DAEMON_AUTOSTART === 'false' ||
          config.tuiDaemonAutoStart === false ||
          config.tuiDaemonAutoStart === 'false'
            ? false
            : true;
        const lines = [`Autostart: ${autostart ? 'auto' : 'off'}`];
        if (daemon.connected) {
          lines.push('Connected: yes');
          if (daemon.sessionId) lines.push(`Session: ${daemon.sessionId}`);
        } else if (!autostart) {
          lines.push('Connected: no (autostart off, running inline)');
        } else if (daemon.autoStartAttempted) {
          lines.push('Connected: no (autostart attempted, fell back to inline)');
        } else {
          lines.push('Connected: no (inline mode, autostart pending)');
        }
        try {
          const pidRaw = await fs.readFile(getPidPath(), 'utf8');
          const pid = Number.parseInt(pidRaw.trim(), 10);
          if (Number.isFinite(pid)) {
            let running = false;
            try {
              process.kill(pid, 0);
              running = true;
            } catch (err) {
              running = (err as NodeJS.ErrnoException)?.code === 'EPERM';
            }
            lines.push(
              running
                ? `Process: pid ${pid} (running)`
                : `Process: pid ${pid} in pidfile but not running (stale)`,
            );
          } else {
            lines.push('Process: pid file unreadable');
          }
        } catch {
          lines.push('Process: not running (no pid file)');
        }
        lines.push('', 'Paths:', `  socket: ${getSocketPath()}`, `  log:    ${getLogPath()}`);
        const auditPath = getAuditLogPath();
        lines.push(`  audit:  ${auditPath}`);
        try {
          const stat = await fs.stat(auditPath);
          const sizeMb = (stat.size / 1024 / 1024).toFixed(2);
          const maxMb = (getAuditMaxBytes() / 1024 / 1024).toFixed(0);
          lines.push(`  audit size: ${sizeMb} MB (rotates at ${maxMb} MB)`);
        } catch {
          // no audit log yet
        }
        appendStatus(lines.join('\n'));
        return true;
      }
      if (sub === 'restart' || sub === 'refresh') {
        const connected = await daemon.ensureConnected({ announce: true });
        appendStatus(
          connected
            ? 'Daemon connection refreshed (or already connected).'
            : 'No daemon running and reconnect failed. Check /daemon status.',
          !connected,
        );
        return true;
      }
      appendStatus(
        `Unknown daemon subcommand: ${sub}. Try: /daemon status | /daemon restart`,
        true,
      );
      return true;
    }

    if (command === 'theme') {
      const parts = arg.split(/\s+/).filter(Boolean);
      const sub = (parts[0] || 'show').toLowerCase();
      if (sub === 'show' || !arg) {
        appendStatus(
          `theme: ${resolveThemeName()} — semantic color over the AMOLED/grayscale baseline.`,
        );
        return true;
      }
      if (sub === 'list') {
        appendStatus(
          [
            'Themes (semantic roles stay stable; hue and saturation change):',
            ...THEME_NAMES.map((name) => `  ${name.padEnd(10)}  ${VARIANTS[name].description}`),
          ].join('\n'),
        );
        return true;
      }
      const name = sub === 'set' ? parts[1] : sub;
      if (!name || !isThemeName(name)) {
        appendStatus(
          `Unknown theme: ${name || '(missing)'}. Available: ${THEME_NAMES.join(', ')}`,
          true,
        );
        return true;
      }
      config.theme = name;
      process.env.PUSH_THEME = name;
      await persistConfig(config);
      appendStatus(`theme: ${name} — semantic palette applied.`);
      return true;
    }

    if (command === 'debug') {
      if (arg.trim() !== 'runtime') {
        appendStatus('Usage: /debug runtime', true);
        return true;
      }
      appendStatus(
        [
          'Runtime Debug:',
          `  cwd: ${process.cwd()}`,
          `  workspace: ${state.cwd}`,
          `  node: ${process.execPath}`,
          `  argv[1]: ${process.argv[1] || '(unknown)'}`,
          `  provider: ${state.provider}`,
          `  model: ${state.model}`,
          `  session id: ${state.sessionId}`,
          `  session root: ${getSessionRoot()}`,
          `  daemon connected: ${daemon.connected ? 'yes' : 'no'}`,
          `  daemon session: ${daemon.sessionId || '(none)'}`,
        ].join('\n'),
      );
      return true;
    }

    if (command === 'exit' || command === 'quit') {
      appendStatus('Use the command palette Exit or Ctrl+C to leave the TUI.');
      return true;
    }

    appendStatus(`Unknown command /${command}. Try /help.`, true);
    return true;
  }

  return {
    getSnapshot: () => currentSnapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setHandoffHooks(hooks) {
      if (hooks.onSuspend) handoffSuspend = hooks.onSuspend;
      if (hooks.onResume) handoffResume = hooks.onResume;
      // Force rebuild so the next /editor uses the live hooks.
      terminalHandoff = null;
    },
    takePendingComposerText() {
      const text = pendingComposerText;
      pendingComposerText = null;
      return text;
    },
    getPromptHistory() {
      if (daemonStateStale) {
        return daemonMirror.rows
          .filter((row) => row.kind === 'message' && row.role === 'user' && !row.live)
          .map((row) => row.text);
      }
      return sessionMessagesToTranscriptRows(state.messages)
        .filter((row) => row.role === 'user')
        .map((row) => row.text);
    },
    async submit(rawText) {
      const text = rawText.trim();
      if (!text || running || disposed) return;
      if (await handleSlashCommand(text)) return;
      error = null;
      activityRows = [];
      liveText = '';
      reasoningBuffer = '';
      lastReasoning = '';
      reasoningStreaming = false;
      // Fresh run: reset the visible-output counter so a prior turn's output
      // can't suppress this turn's empty-run diagnostic (defensive — a completed
      // run already reset it in finishRunDiagnostics).
      runVisibleEmissionCount = 0;
      const submittedAt = now();
      optimisticDaemonInsertIndex = null;
      optimisticUserRow = {
        id: nextId('optimistic-user'),
        kind: 'message',
        role: 'user',
        text,
        timestampMs: submittedAt,
      };
      running = true;
      startedAt = submittedAt;
      notify();
      abortController = new AbortController();
      let saveLocalState = false;
      // Tracks whether the turn's user message was actually accepted (daemon send
      // resolved, or the inline history append succeeded). The optimistic row is a
      // fallback the daemon echo/resync or the inline append replaces on success;
      // if the submission was never accepted, `finally` must drop it (below).
      let messageAccepted = false;
      try {
        await ensurePersisted();
        if (await daemon.ensureReady()) {
          daemonTurn = true;
          await refreshDaemonExecMode();
          if (abortController.signal.aborted) return;
          daemonStateStale = true;
          await resyncDaemonTranscript('before_send');
          optimisticDaemonInsertIndex = daemonMirror.rows.length;
          daemonTurnRowFloor = daemonMirror.rows.length;
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
          messageAccepted = true;
          await completion;
          return;
        }
        execMode = localExecMode();
        notify();
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
        optimisticUserRow = null;
        optimisticDaemonInsertIndex = null;
        messageAccepted = true;
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
                reasoningModalOpen = false;
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
                reasoningModalOpen = false;
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
        reasoningStreaming = false;
        if (reasoningBuffer.trim()) lastReasoning = reasoningBuffer;
        abortController = null;
        interaction = null;
        resolveApproval = null;
        resolveQuestion = null;
        // A submission that was never accepted (send rejected, inline append threw,
        // or aborted before send) must not leave its optimistic row haunting the
        // idle transcript. Accepted turns already cleared it via the daemon
        // echo/resync or the inline history append, so this only fires on failure.
        if (!messageAccepted) {
          optimisticUserRow = null;
          optimisticDaemonInsertIndex = null;
        }
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
    openPicker,
    closePicker,
    previewPickerOption,
    toggleSessionPickerScope,
    openConfigEditor,
    closeConfigEditor,
    toggleReasoning,
    closeReasoning,
    saveConfigSecret,
    saveConfigPreference,
    selectPickerOption(id) {
      // selectPicker is fire-and-forget from the view; surface any late failure
      // (config/session persistence) as a status line rather than swallowing it.
      void selectPicker(id).catch((cause) => {
        appendStatus(
          `Switch failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          true,
        );
      });
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
    copyLastResponse() {
      // Copy what the user can SEE, so the snapshot is the source — not the
      // session log, which may hold rows cleared from the display.
      const payload = copyLastResponse(currentSnapshot.rows);
      if (!payload) {
        appendStatus('Nothing to copy yet — no assistant response in view.');
        return;
      }
      io.stdout.write(osc52Copy(payload.text));
      // OSC 52 is fire-and-forget: the terminal may not support it, and there
      // is no reply to wait on. Report what we SENT, never claim receipt — and
      // never let the size cap bite silently (CLAUDE.md: no silent caps).
      const size = `${payload.text.length} chars`;
      appendStatus(
        payload.truncated
          ? `Copied ${payload.label} to clipboard — TRUNCATED at ${size} (OSC 52 payload ceiling; the rest was not sent).`
          : `Copied ${payload.label} to clipboard (${size}).`,
      );
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
