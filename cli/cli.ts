#!/usr/bin/env node
// @ts-nocheck — gradual typing in progress for this large module
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
  PROVIDER_CONFIGS,
  DEPRECATED_PROVIDERS,
  createProviderStream,
  resolveApiKey,
  getProviderList,
} from './provider.js';
import { isInvalidGitRef, matchingRiskPatternIndex, suggestApprovalPrefix } from './tools.js';
import {
  addWorktree,
  autoWorktreeBranchName,
  formatWorktreeStatus,
  resolveGitRoot,
  teardownWorktree,
  WorktreeError,
  type WorktreeHandle,
} from './worktree.js';
import { getCuratedModels, DEFAULT_MODELS } from './model-catalog.js';
import { safeCitations, citationHost, sanitizeCitationText } from './citation-format.js';
import type { AIProviderType, LlmMessage, UrlCitation } from '../lib/provider-contract.ts';
import {
  createSessionState,
  saveSessionState,
  appendSessionEvent,
  loadSessionState,
  listSessions,
  makeRunId,
  pruneSessions,
  rewriteMessagesLog,
  type PruneSelectors,
} from './session-store.js';
import { runCheckpointCommand } from './checkpoint-command.js';
import { isBunRuntime, resolvePushdEntryCandidate, pushdSpawnPlan } from './daemon-spawn-args.js';
import {
  buildSystemPromptBase,
  ensureSystemPromptReady,
  runAssistantTurn,
  DEFAULT_MAX_ROUNDS,
  MAX_ALLOWED_ROUNDS,
} from './engine.js';
import {
  loadConfig,
  resolveRuntimeConfig,
  saveConfig,
  applyConfigToEnv,
  getConfigPath,
  maskSecret,
} from './config-store.js';
import { aggregateStats, formatStats } from './stats.js';
import { getToolCallMetrics } from './tool-call-metrics.js';
import { getSocketPath, getPidPath, getLogPath } from './pushd.js';
import {
  loadSkills,
  interpolateSkill,
  getSkillPromptTemplate,
  filterSkillsForEnvironment,
  getCurrentSkillPlatform,
  lintSkills,
  formatSkillDiagnostics,
  skillDiagnosticLogLines,
  skillDiagnosticSummaryLine,
  type SkillDiagnostic,
} from './skill-loader.js';
import { ALL_CAPABILITIES, type Capability } from '../lib/capabilities.js';
import { ATTACH_CLIENT_CAPABILITIES } from '../lib/daemon-capabilities.js';
import { isToolCardPayload } from '../lib/tool-cards.js';
import { formatToolCard } from './tool-card-format.js';
import { createCompleter } from './completer.js';
import { fmt, formatRelativeTime, Spinner } from './format.js';
import { formatWorkspaceStateView } from './tui-status.js';
import { appendUserMessageWithFileReferences } from './file-references.js';
import { compactContext } from './context-manager.js';
import { createDelegationTranscriptRenderer, isDelegationEvent } from './tui-delegation-events.js';
import { runCommandInResolvedShell } from './shell.js';
import { scrubEnv } from './env-scrub.js';
import { resolveExecSandboxBackend, runCommandInExecSandbox } from './exec-sandbox.js';
import { createHeadlessJsonlWriter } from './headless-jsonl.js';
import {
  constrainOutputToSchema,
  formatOutputSchemaInstruction,
  loadOutputSchema,
  type ConstrainedOutputResult,
} from './output-schema.js';
import { ensureRepoCommandsSeeded } from './repo-commands.js';
import { getDefaultMemoryStore, setDefaultMemoryStore } from '../lib/context-memory-store.js';
import { setDefaultVerbatimLog } from '../lib/verbatim-log.js';
import { getDefaultEmbeddingProvider } from '../lib/embedding-provider.js';
import { reduceWorkspaceStateEvent } from '../lib/workspace-state.js';
import { installCliEmbeddingProvider } from './embedding-provider-cli.js';
import { createFileMemoryStore, getMemoryStoreBaseDir } from './context-memory-file-store.js';
import { createFileVerbatimLog, getVerbatimLogBaseDir } from './verbatim-log-file-store.js';
import {
  readClientAttachState,
  writeClientAttachState,
  makeDebouncedClientAttachWriter,
} from './client-attach-state.js';

const VERSION = '0.1.0';
// Canonical, drift-tested definition lives in `lib/daemon-capabilities.ts`
// (#745). Re-exported here so existing importers (and the attach path below)
// keep their entry point.
export { ATTACH_CLIENT_CAPABILITIES };

const KNOWN_OPTIONS = new Set([
  'provider',
  'model',
  'url',
  'api-key',
  'apiKey',
  'cwd',
  'session',
  'tavily-key',
  'tavilyKey',
  'search-backend',
  'searchBackend',
  'task',
  'accept',
  'max-rounds',
  'maxRounds',
  'json',
  'jsonl',
  'policy',
  'run-id',
  'runId',
  'session-id',
  'sessionId',
  'output-schema',
  'outputSchema',
  'profile',
  'lint',
  'headless',
  'allow-exec',
  'allowExec',
  'skill',
  'mode',
  'help',
  'sandbox',
  'sandbox-backend',
  'sandboxBackend',
  'no-sandbox',
  'version',
  'exec-mode',
  'dry-run',
  'dryRun',
  'force',
  'no-resume',
  'noResume',
  'no-attach',
  'noAttach',
  'no-resume-prompt',
  'noResumePrompt',
  'deep',
  'origin',
  'tail',
  'since',
  'type',
  'token',
  'remote',
  'older-than',
  'olderThan',
  'keep',
  'match-model',
  'matchModel',
  'empty',
  'limit',
  'no-rejected',
  'noRejected',
]);

const KNOWN_SUBCOMMANDS = new Set([
  '',
  'run',
  'eval',
  'config',
  'resume',
  'sessions',
  'skills',
  'stats',
  'daemon',
  'attach',
  'tui',
  'theme',
  'memory',
  'init-deep',
  'audit-evals',
]);
const SEARCH_BACKENDS = new Set(['auto', 'tavily', 'ollama', 'duckduckgo']);
const DEFAULT_COMPACT_TURNS = 6;

export function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function truncateText(text: string | null | undefined, maxLength = 100) {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '...';
}

// Strict boolean flag parser — parseArgs runs with strict: false so a scripted
// caller can pass `--force=false` or `--dry-run=false`, and the raw value
// arrives as the STRING "false". Plain Boolean(...) would then coerce it to
// true and do the opposite of what the caller asked for. Accept the common
// string forms explicitly and reject anything else rather than guessing.
export function parseBoolFlag(raw: unknown, flagName: string) {
  if (raw === undefined || raw === false) return false;
  if (raw === true) return true;
  if (typeof raw === 'string') {
    const normalized = raw.toLowerCase();
    if (normalized === '' || normalized === 'true' || normalized === '1') return true;
    if (normalized === 'false' || normalized === '0') return false;
    throw new Error(`Invalid value for --${flagName}: ${JSON.stringify(raw)}`);
  }
  return Boolean(raw);
}

// Strip ANSI CSI + OSC sequences + C0/DEL from user-controlled text
// before rendering it inside fmt.bold or any other terminal-styling
// wrapper. Session names can be set via `push resume rename` or by
// editing state files directly, so this runs anywhere we render a
// sessionName in a TTY-visible context. Three passes:
//   1. CSI (ESC `[` ... letter) — styling, cursor movement, SGR.
//   2. OSC (ESC `]` ... BEL or ST) — window title, hyperlinks, etc.
//      Terminated by BEL (`\x07`) or ST (`\x1b\`).
//   3. Any remaining C0/DEL bytes (including bare ESC, BEL, etc.).
// Order matters: structured sequences are removed as whole units before
// the C0 scrub so they don't leave visible `[31m` or `]0;…` tails.
// Multibyte UTF-8 is preserved.
export function sanitizeTerminalText(raw: string) {
  return (
    raw
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping injected CSI is the point
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping injected OSC is the point
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping bare C0/DEL is the point
      .replace(/[\x00-\x1f\x7f]/g, '')
  );
}

function printHelp() {
  process.stdout.write(
    `Push CLI (bootstrap)

Usage:
  push                          Start TUI when enabled, otherwise interactive session (REPL prompts to resume if sessions exist for this cwd)
  push --session <id>           Resume session (TUI when enabled, otherwise interactive)
  push --no-resume-prompt       Start a new session without the resume prompt
  push run --task "..."         Run once in headless mode
  push run "..."                Run once in headless mode
  push eval <run.jsonl>         Evaluate a saved push.runtime.v1 receipt
  push eval <run.jsonl> --policy <policy.json> [--json]
                                Apply explicit gates and score thresholds
  push resume                   Pick a session and attach (TTY); list only when piped
  push resume --no-attach       List resumable sessions without prompting (script-friendly)
  push sessions                 List resumable sessions (never prompts; alias for scripts)
  push sessions prune           Prune stored sessions: --empty / --older-than <days> / --keep <n> / --match-model <regex> (AND-combined; dry-run unless --force)
  push skills                   List available skills (--lint to report dropped/degraded skill files)
  push stats                    Show provider compliance stats
  push daemon start             Start background daemon
  push daemon stop              Stop background daemon
  push daemon status            Check daemon status
  push daemon pair              Mint a loopback device token (low-level/back-compat)
  push daemon pair --origin <url>
                                Mint a device token bound to an exact origin
  push daemon tokens            List device tokens (no secrets)
  push daemon revoke <tokenId>  Revoke a device token
  push daemon relay enable      Enable outbound relay dial (--url/--token optional after first setup;
                                --url falls back to the persisted deployment, --token to PUSH_RELAY_TOKEN)
  push daemon relay disable     Disable the outbound relay
  push daemon relay status      Show persisted + live relay state
  push daemon pair --remote     Mint a one-shot Remote pairing bundle (phone via relay)
  push tui                       Start full-screen TUI
  push tui --session <id>        Resume session in TUI
  push attach <session-id>      Attach to a running daemon session
  push init-deep                Generate AGENTS.md skeletons for significant directories
  push init-deep --dry-run      Preview the init-deep plan without writing files
  push init-deep --force        Overwrite existing AGENTS.md files
  push audit-evals list         Show captured Auditor rejection→correction pairs
  push audit-evals replay       Replay the corpus through the Auditor; exits non-zero on regressions
  push audit-evals replay --no-rejected --limit <n> --json
  push config show              Show saved CLI config
  push config explain           Show effective config and winning sources
  push config init              Interactive setup wizard
  push config set ...           Save provider config defaults
  push theme                    Show current TUI theme
  push theme list               List available TUI themes
  push theme preview [<name>]   Preview swatches for a theme (all themes if omitted)
  push theme set <name>         Set TUI theme (mono|default|neon|metallic|solarized|forest)
  push memory backfill          Embed stored memory records that lack an embedding (semantic recall)

Options:
  --provider <name>             ollama | openrouter | kimi | zai | huggingface | zen | nvidia | fireworks | deepseek | sakana | openai | anthropic | google | xai (default: ollama)
  --model <name>                Override model
  --url <endpoint>              Override provider endpoint URL
  --api-key <secret>            Set provider API key (for push config set/init)
  --tavily-key <secret>         Set Tavily API key (for push config set/init)
  --search-backend <mode>       auto | tavily | ollama | duckduckgo
  --cwd <path>                  Workspace root (default: current directory)
  --session <id>                Resume session id
  --task <text>                 Task text for headless mode
  --skill <name>               Run a skill (e.g. commit, review, fix)
  --accept <cmd>                Acceptance check command (repeatable)
  --max-rounds <n>              Tool-loop cap per user prompt (default: 50, max: 200; harness may extend on healthy progress)
  --allow-exec                  Allow exec tool in headless mode (blocked by default)
  --worktree                    Run in an isolated git worktree + branch (auto-named); kept on exit only if it has changes
  --worktree-name <name>        --worktree with a custom branch name
  --mode <strict|auto|yolo>     Exec approval mode: strict=prompt all, auto=prompt high-risk (default), yolo=no prompts
  --json                        JSON output in headless mode / resume / eval
  --jsonl                       Stream push.runtime.v1 events in headless mode
  --policy <path>               Runtime evaluation policy (push eval only)
  --run-id <id>                 Select one run from a combined receipt
  --session-id <id>             Select one session from a combined receipt
  --output-schema <path>        Constrain the final push run output to a JSON Schema
  --profile <name>              Apply a named config profile (else PUSH_PROFILE / activeProfile)
  --no-attach                   Resume: list sessions without prompting (script-friendly)
  --no-resume-prompt            Bare push: skip the "resume or new" prompt and start a new session
  --sandbox                     Enable local Docker sandbox
  --sandbox-backend <backend>   Subprocess isolation: host | docker | native (Linux/WSL Bubblewrap)
  --no-sandbox                  Disable local Docker sandbox
  -v, --version                 Show version
  -h, --help                    Show help
`,
  );
}

async function runAcceptanceChecks(cwd, checks) {
  const entries = [];
  for (const command of checks) {
    const startedAt = Date.now();
    try {
      const { stdout, stderr } = await runCommandInExecSandbox(command, cwd, {
        cwd,
        timeout: 120_000,
        maxBuffer: 4_000_000,
        env: scrubEnv(),
      });
      entries.push({
        command,
        ok: true,
        exitCode: 0,
        durationMs: Date.now() - startedAt,
        stdout: (stdout || '').slice(0, 2000),
        stderr: (stderr || '').slice(0, 2000),
      });
    } catch (err) {
      entries.push({
        command,
        ok: false,
        exitCode: typeof err.code === 'number' ? err.code : 1,
        durationMs: Date.now() - startedAt,
        stdout: (err.stdout || '').slice(0, 2000),
        stderr: (err.stderr || String(err.message || err)).slice(0, 2000),
      });
    }
  }
  return {
    passed: entries.every((entry) => entry.ok),
    checks: entries,
  };
}

export function makeCLIEventHandler() {
  let isAssistantStreaming = false;
  let isReasoningStreaming = false;
  let workspaceStateView = null;
  const spinner = new Spinner();
  const renderDelegationEvent = createDelegationTranscriptRenderer();

  function flushInlineStreams() {
    if (isReasoningStreaming || isAssistantStreaming) {
      process.stdout.write('\n');
      isReasoningStreaming = false;
      isAssistantStreaming = false;
    }
  }

  return (event) => {
    // Route `subagent.*` and `task_graph.*` events through the shared
    // transcript renderer so a `push attach` client sees the same transcript
    // semantics the interactive TUI already exposes. The renderer is stateful
    // for task graphs, so it is constructed once per handler instance.
    if (isDelegationEvent(event)) {
      const entry = renderDelegationEvent(event);
      if (entry) {
        flushInlineStreams();
        spinner.stop();
        const badge =
          entry.role === 'error'
            ? fmt.error('[error]')
            : entry.role === 'warning'
              ? fmt.warn('[warn]')
              : fmt.dim('[info]');
        if (entry.boundary === 'start') {
          process.stdout.write('\n');
        }
        process.stdout.write(`${badge} ${entry.text}\n`);
        if (entry.boundary === 'end') {
          process.stdout.write('\n');
        }
        return;
      }
    }

    switch (event.type) {
      case 'workspace.state_snapshot':
      case 'workspace.state_delta': {
        const result = reduceWorkspaceStateEvent(workspaceStateView, {
          type: event.type,
          ...(event.payload || {}),
        });
        workspaceStateView = result.view;
        if (
          workspaceStateView &&
          (result.outcome === 'snapshot_adopted' || result.outcome === 'delta_applied')
        ) {
          flushInlineStreams();
          spinner.stop();
          process.stderr.write(
            `${fmt.dim('[workspace]')} ${formatWorkspaceStateView(workspaceStateView, 80)}\n`,
          );
        }
        break;
      }
      case 'tool_call':
      case 'tool.execution_start':
        flushInlineStreams();
        spinner.stop();
        process.stdout.write(`${fmt.dim('[tool]')} ${event.payload.toolName}\n`);
        spinner.start(event.payload.toolName);
        break;
      case 'tool_result':
      case 'tool.execution_complete': {
        spinner.stop();
        const ok = !event.payload.isError;
        const card = isToolCardPayload(event.payload.card)
          ? formatToolCard(event.payload.card)
          : null;
        const text = truncateText(event.payload.text || event.payload.preview || '', 420);
        const badge = ok ? fmt.green('[tool:ok]') : fmt.red('[tool:error]');
        if (card) {
          process.stdout.write(`${badge} ${card.title}\n`);
          for (const row of card.rows) {
            process.stdout.write(`  ${fmt.dim(`${row.label}: ${row.value}`)}\n`);
          }
          for (const line of card.bodyLines ?? []) {
            const rendered =
              line.tone === 'add'
                ? fmt.green(line.text)
                : line.tone === 'delete'
                  ? fmt.red(line.text)
                  : fmt.dim(line.text);
            process.stdout.write(`  ${rendered}\n`);
          }
        } else if (ok) {
          process.stdout.write(`${badge} ${fmt.dim(text)}\n`);
        } else {
          process.stdout.write(`${badge} ${text}\n`);
        }
        break;
      }
      case 'status':
        if (event.payload.phase === 'context_trimming') {
          spinner.stop();
          process.stdout.write(`\n${fmt.dim('[context] ' + event.payload.detail)}\n`);
        }
        break;
      case 'assistant_token':
        spinner.stop();
        if (isReasoningStreaming) {
          process.stdout.write('\n');
          isReasoningStreaming = false;
        }
        if (!isAssistantStreaming) {
          process.stdout.write(`\n${fmt.bold(fmt.cyan('assistant>'))} `);
          isAssistantStreaming = true;
        }
        process.stdout.write(event.payload.text);
        break;
      case 'assistant_thinking_token':
        spinner.stop();
        if (isAssistantStreaming) {
          process.stdout.write('\n');
          isAssistantStreaming = false;
        }
        if (!isReasoningStreaming) {
          process.stdout.write(`\n${fmt.dim('reasoning>')} `);
          isReasoningStreaming = true;
        }
        process.stdout.write(fmt.dim(event.payload.text));
        break;
      case 'assistant_thinking_done':
        if (isReasoningStreaming) {
          process.stdout.write('\n');
          isReasoningStreaming = false;
        }
        break;
      case 'assistant_done':
        if (isReasoningStreaming || isAssistantStreaming) {
          process.stdout.write('\n');
          isReasoningStreaming = false;
          isAssistantStreaming = false;
        }
        break;
      case 'assistant_citations': {
        flushInlineStreams();
        const safe = safeCitations((event.payload.citations ?? []) as UrlCitation[]);
        if (safe.length === 0) break;
        process.stdout.write(`\n${fmt.dim('sources>')}\n`);
        safe.forEach(({ citation, url }, i) => {
          const title = sanitizeCitationText(citation.title) || citationHost(url);
          process.stdout.write(`  ${fmt.dim(`${i + 1}.`)} ${title} ${fmt.dim(url.href)}\n`);
        });
        break;
      }
      case 'warning':
        spinner.stop();
        process.stdout.write(
          `\n${fmt.warn('[warning]')} ${event.payload.message || event.payload.code}\n`,
        );
        break;
      case 'tool.call_malformed':
        spinner.stop();
        process.stdout.write(
          `\n${fmt.warn('[warning]')} malformed tool call: ${event.payload.reason}\n`,
        );
        break;
      case 'error':
        spinner.stop();
        process.stdout.write(`\n${fmt.error('[error]')} ${event.payload.message}\n`);
        break;
      case 'run_complete':
        spinner.stop();
        if (event.payload.outcome === 'aborted') {
          process.stdout.write(`\n${fmt.yellow('[cancelled]')}\n`);
        } else if (event.payload.outcome === 'failed') {
          process.stdout.write(`\n${fmt.error('[failed]')} ${event.payload.summary}\n`);
        }
        break;
    }
  };
}

const OUTPUT_REPAIR_TIMEOUT_MS = 120_000;

/**
 * Run one output-only repair request. No tool schemas or executor are attached,
 * and every provider-native server tool is explicitly disabled, so this cannot
 * replay the primary turn's filesystem/GitHub/command or provider-search side
 * effects.
 */
async function generateOutputSchemaRepair(state, providerConfig, apiKey, prompt, signal) {
  const abortError = () => {
    const error = new Error('Output-schema repair aborted.');
    error.name = 'AbortError';
    return error;
  };
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), OUTPUT_REPAIR_TIMEOUT_MS);
  const signals = [timeoutController.signal];
  if (signal) signals.push(signal);
  const compositeSignal = AbortSignal.any(signals);
  const stream = createProviderStream(providerConfig, apiKey, { sessionId: state.sessionId });
  const messages: LlmMessage[] = [
    {
      id: `output-repair-${Date.now().toString(36)}`,
      role: 'user',
      content: prompt,
      timestamp: Date.now(),
    },
  ];
  let text = '';

  try {
    for await (const event of stream({
      provider: providerConfig.id as AIProviderType,
      model: state.model || providerConfig.defaultModel,
      messages,
      signal: compositeSignal,
      // The CLI adapters default several provider-owned search tools on when
      // these flags are omitted. Repairs must be output-only even when those
      // defaults or their environment variables are enabled.
      openrouterWebSearch: false,
      anthropicWebSearch: false,
      googleSearchGrounding: false,
      responsesWebSearch: false,
    })) {
      if (event.type === 'text_delta') text += event.text;
    }
    if (signal?.aborted) throw abortError();
    if (timeoutController.signal.aborted && !signal?.aborted) {
      throw new Error(`Output-schema repair timed out after ${OUTPUT_REPAIR_TIMEOUT_MS / 1000}s.`);
    }
    return text;
  } catch (error) {
    if (signal?.aborted) throw abortError();
    if (timeoutController.signal.aborted && !signal?.aborted) {
      throw new Error(`Output-schema repair timed out after ${OUTPUT_REPAIR_TIMEOUT_MS / 1000}s.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function runHeadless(
  state,
  providerConfig,
  apiKey,
  task,
  maxRounds,
  jsonOutput,
  jsonlOutput,
  acceptanceChecks,
  {
    allowExec = false,
    safeExecPatterns = [],
    execMode = 'auto',
    // `disabledTools` / `alwaysAllow` deliberately default to `undefined` so
    // omission flows through to `executeToolCall`'s env-var fallback. An
    // explicit `[]` is an opt-out and is preserved.
    disabledTools,
    alwaysAllow,
    // Auditor commit gate (opt-out, default on). `undefined` → the tool layer
    // resolves it against `PUSH_AUDITOR_GATE` then the default.
    auditorGate,
    outputSchema = null,
    // True when the user set an explicit --max-rounds (disables adaptation).
    explicitMaxRounds = false,
  } = {},
) {
  // Headless runs the single conversational lead on the shared coder kernel
  // (`runAssistantTurn`), same runtime as interactive turns. Acceptance checks
  // ride as plain prompt context here and are verified post-run by
  // `runAcceptanceChecks` below — that post-loop check is the real gate.
  const acceptanceBlock =
    Array.isArray(acceptanceChecks) && acceptanceChecks.length > 0
      ? `\n\nAcceptance criteria (verified after the run):\n${acceptanceChecks
          .map((c) => `- ${c}`)
          .join('\n')}`
      : '';
  const outputSchemaBlock = outputSchema
    ? `\n\n${formatOutputSchemaInstruction(outputSchema)}`
    : '';
  const taskPrompt = `${task}${acceptanceBlock}${outputSchemaBlock}`;
  const runId = makeRunId();
  const jsonl = jsonlOutput ? createHeadlessJsonlWriter(state) : null;
  const ownsTerminalRunComplete = Boolean(jsonl || outputSchema);
  await appendUserMessageWithFileReferences(state, taskPrompt, state.cwd, {
    referenceSourceText: task,
  });
  const userMessagePayload = {
    chars: task.length,
    preview: task.slice(0, 280),
  };
  await appendSessionEvent(state, 'user_message', userMessagePayload, runId);
  jsonl?.emit('user_message', { ...userMessagePayload, text: taskPrompt }, runId);

  // Shared runtime/tool telemetry uses console.log for daemon-friendly
  // structured ops lines. A headless machine contract must keep stdout pure,
  // so route those lines to stderr for the lifetime of either machine mode.
  // This process runs one headless command, making the temporary global
  // redirect scoped and deterministic; the JSON/JSONL writers use
  // process.stdout.write directly and remain untouched.
  const originalConsoleLog = console.log;
  if (jsonOutput || jsonlOutput) console.log = console.error;

  let terminalRunCompleteEmitted = false;
  const emitHeadlessRunComplete = async (
    outcome: 'success' | 'failed' | 'aborted' | 'max_rounds',
    summary: string,
  ) => {
    if (!ownsTerminalRunComplete || terminalRunCompleteEmitted) return;
    const payload = { runId, outcome, summary };
    await appendSessionEvent(state, 'run_complete', payload, runId);
    terminalRunCompleteEmitted = true;
    await saveSessionState(state);
    jsonl?.emit('run_complete', payload, runId);
  };

  const ac = new AbortController();
  const onSigint = () => ac.abort();
  process.on('SIGINT', onSigint);

  try {
    const result = await runAssistantTurn(state, providerConfig, apiKey, taskPrompt, maxRounds, {
      runId,
      signal: ac.signal,
      // `run_complete` is emitted by the kernel before headless acceptance and
      // output-schema checks. When this adapter owns the terminal receipt,
      // hold the early event back so the persisted/JSONL outcome reflects all
      // post-run gates.
      emit: jsonl
        ? (event) => {
            if (event.type !== 'run_complete') jsonl.emitEngineEvent(event);
          }
        : null,
      suppressRunComplete: ownsTerminalRunComplete,
      allowExec,
      safeExecPatterns,
      execMode,
      disabledTools,
      alwaysAllow,
      auditorGate,
      explicitMaxRounds,
    });
    await saveSessionState(state);

    // Non-throw abort path (engine returned outcome: 'aborted' without throwing)
    if (result.outcome === 'aborted') {
      await emitHeadlessRunComplete('aborted', 'Aborted by user.');
      if (jsonOutput && !jsonl) {
        process.stdout.write(
          `${JSON.stringify({ sessionId: state.sessionId, runId: result.runId || null, outcome: 'aborted' }, null, 2)}\n`,
        );
      } else if (!jsonl) {
        process.stderr.write(`${fmt.yellow('[aborted]')}\n`);
      }
      return 130;
    }

    let constrainedOutput: ConstrainedOutputResult | null = null;
    if (outputSchema && result.outcome === 'success') {
      constrainedOutput = await constrainOutputToSchema(
        outputSchema,
        task,
        result.finalAssistantText,
        (repairPrompt) =>
          generateOutputSchemaRepair(state, providerConfig, apiKey, repairPrompt, ac.signal),
      );

      if (constrainedOutput.ok) {
        result.finalAssistantText = constrainedOutput.text;
        // The lead kernel already persisted its unconstrained final summary.
        // Replace that tail entry so resumed model context matches the value
        // returned to the machine consumer. saveSessionState detects the
        // same-length tail mutation and atomically rewrites messages.jsonl.
        for (let i = state.messages.length - 1; i >= 0; i -= 1) {
          const message = state.messages[i];
          if (message && typeof message === 'object' && message.role === 'assistant') {
            message.content = constrainedOutput.text;
            break;
          }
        }
        await saveSessionState(state);
        if (constrainedOutput.repairs > 0 && (jsonOutput || jsonlOutput)) {
          console.error(
            JSON.stringify({
              level: 'info',
              event: 'output_schema_validated',
              repairs: constrainedOutput.repairs,
              schemaPath: outputSchema.path,
            }),
          );
        }
      } else {
        const message = `Final output did not satisfy --output-schema after ${constrainedOutput.repairs} repair attempts: ${constrainedOutput.error}`;
        const payload = {
          code: 'OUTPUT_SCHEMA_VALIDATION_FAILED',
          message,
          retryable: false,
          repairs: constrainedOutput.repairs,
        };
        await appendSessionEvent(state, 'error', payload, runId);
        jsonl?.emit('error', payload, runId);
        await saveSessionState(state);
        if (jsonOutput || jsonlOutput) {
          console.error(
            JSON.stringify({
              level: 'error',
              event: 'output_schema_validation_failed',
              repairs: constrainedOutput.repairs,
              schemaPath: outputSchema.path,
              error: constrainedOutput.error,
            }),
          );
        }
      }
    }

    let acceptance = null;

    if (
      constrainedOutput?.ok !== false &&
      Array.isArray(acceptanceChecks) &&
      acceptanceChecks.length > 0
    ) {
      acceptance = await runAcceptanceChecks(state.cwd, acceptanceChecks);
      const acceptancePayload = {
        passed: acceptance.passed,
        checks: acceptance.checks.map((check) => ({
          command: check.command,
          ok: check.ok,
          exitCode: check.exitCode,
          durationMs: check.durationMs,
        })),
      };
      await appendSessionEvent(state, 'acceptance_complete', acceptancePayload, runId);
      jsonl?.emit('acceptance_complete', acceptancePayload, runId);
      await saveSessionState(state);
    }

    const outputSchemaPassed = !outputSchema || constrainedOutput?.ok === true;
    const success =
      result.outcome === 'success' && outputSchemaPassed && (!acceptance || acceptance.passed);

    const terminalOutcome = success
      ? 'success'
      : acceptance && !acceptance.passed
        ? 'failed'
        : constrainedOutput && !constrainedOutput.ok
          ? 'failed'
          : result.outcome === 'error'
            ? 'failed'
            : result.outcome;
    const terminalSummary =
      constrainedOutput && !constrainedOutput.ok
        ? `Output schema validation failed: ${constrainedOutput.error}`
        : result.finalAssistantText;
    await emitHeadlessRunComplete(terminalOutcome, terminalSummary);

    if (jsonl) {
      // The terminal event was emitted above after every post-run gate.
    } else if (jsonOutput) {
      process.stdout.write(
        `${JSON.stringify(
          {
            sessionId: state.sessionId,
            runId: result.runId || null,
            outcome: success
              ? 'success'
              : acceptance && !acceptance.passed
                ? 'acceptance_failed'
                : constrainedOutput && !constrainedOutput.ok
                  ? 'output_schema_failed'
                  : result.outcome,
            rounds: result.rounds,
            assistant: result.finalAssistantText,
            acceptance,
            ...(outputSchema
              ? {
                  outputSchema: constrainedOutput
                    ? {
                        valid: constrainedOutput.ok,
                        repairs: constrainedOutput.repairs,
                        ...(constrainedOutput.ok ? {} : { error: constrainedOutput.error }),
                      }
                    : { valid: false, repairs: 0, error: 'run did not complete successfully' },
                }
              : {}),
          },
          null,
          2,
        )}\n`,
      );
    } else {
      if (constrainedOutput && !constrainedOutput.ok) {
        process.stderr.write(
          `${fmt.error('Error:')} Output schema validation failed: ${constrainedOutput.error}\n`,
        );
      } else {
        process.stdout.write(`${result.finalAssistantText}\n`);
      }
      if (acceptance) {
        const verdict = acceptance.passed ? fmt.green('PASS') : fmt.red('FAIL');
        process.stdout.write(`\nAcceptance checks: ${verdict}\n`);
        for (const check of acceptance.checks) {
          const tag = check.ok ? fmt.green('[ok]') : fmt.red('[fail]');
          process.stdout.write(`- ${tag} ${check.command} (exit ${check.exitCode})\n`);
        }
      }
    }

    return success ? 0 : 1;
  } catch (err) {
    if (err.name === 'AbortError') {
      await saveSessionState(state);
      await emitHeadlessRunComplete('aborted', 'Aborted by user.');
      if (jsonOutput && !jsonl) {
        process.stdout.write(
          `${JSON.stringify({ sessionId: state.sessionId, outcome: 'aborted' }, null, 2)}\n`,
        );
      } else if (!jsonl) {
        process.stderr.write(`${fmt.yellow('[aborted]')}\n`);
      }
      return 130;
    }

    const message = err instanceof Error ? err.message : String(err);
    const errorPayload = { code: 'HEADLESS_RUN_ERROR', message, retryable: false };
    await appendSessionEvent(state, 'error', errorPayload, runId);
    await saveSessionState(state);

    jsonl?.emit('error', errorPayload, runId);
    await emitHeadlessRunComplete('failed', message);
    if (jsonOutput && !jsonl) {
      process.stdout.write(
        `${JSON.stringify({ sessionId: state.sessionId, outcome: 'error', error: message }, null, 2)}\n`,
      );
    } else if (!jsonl) {
      process.stderr.write(`${fmt.error('Error:')} ${message}\n`);
    }
    return 1;
  } finally {
    console.log = originalConsoleLog;
    process.removeListener('SIGINT', onSigint);
  }
}

function makeInteractiveApprovalFn(rl, { config, safeExecPatterns }) {
  const trustedPatterns = new Set();

  return async (tool, detail) => {
    // Session trust: auto-approve if this risk pattern was previously trusted
    const patIdx = matchingRiskPatternIndex(detail);
    if (patIdx >= 0 && trustedPatterns.has(patIdx)) {
      process.stdout.write(`\n${fmt.dim('[auto-approved]')} ${tool}: ${detail}\n`);
      return true;
    }

    const suggestedPrefix = suggestApprovalPrefix(detail);
    process.stdout.write(
      `\n${fmt.yellow('[!]')} ${fmt.warn('High-risk operation detected:')}\n    ${tool}: ${detail}\n`,
    );
    if (suggestedPrefix) {
      process.stdout.write(`    ${fmt.dim(`Suggested reusable prefix: "${suggestedPrefix}"`)}\n`);
    }
    const answer = await rl.question('    Allow? (y/N/a=always-session/p=save-prefix) ');
    const choice = answer.trim().toLowerCase();

    if (choice === 'a') {
      if (patIdx >= 0) {
        trustedPatterns.add(patIdx);
        process.stdout.write(`    ${fmt.dim('[trusted for session]')}\n`);
      }
      return true;
    }

    if (choice === 'p') {
      if (!suggestedPrefix) {
        process.stdout.write(`    ${fmt.dim('[no prefix suggestion available; approved once]')}\n`);
        return true;
      }
      if (!safeExecPatterns.includes(suggestedPrefix)) {
        safeExecPatterns.push(suggestedPrefix);
        config.safeExecPatterns = [...new Set(safeExecPatterns)];
        try {
          await saveConfig(config);
          process.stdout.write(`    ${fmt.dim(`[saved prefix] ${suggestedPrefix}`)}\n`);
        } catch (err) {
          process.stdout.write(
            `    ${fmt.warn(`[warn] failed to persist prefix: ${err.message || String(err)}`)}\n`,
          );
        }
      } else {
        process.stdout.write(`    ${fmt.dim('[prefix already trusted]')}\n`);
      }
      return true;
    }

    return choice === 'y';
  };
}

// Bare-`push` picker: render cwd-filtered sessions and let the user pick
// one (by number or full sessionId), press Enter or type `n` to start a
// new session, or type `q` to cancel. Returns the sessionId to resume,
// the string `'new'` to start fresh, or `'cancel'` to bail. Callers
// should handle `cancel` as a normal user abort consistent with the
// existing bare-`push` flow (print a one-liner, exit 0); `'new'` is the
// fall-through that matches pre-picker bare-`push` behavior.
// Render a session's last human message as a one-line preview for the
// resume pickers. Flatten whitespace, strip control chars (session
// state is user-controlled via /edits or direct file edits), and
// truncate so a single long prompt doesn't blow out the picker
// formatting. Empty input and empty-after-sanitization both return '',
// so the caller can skip the preview line entirely.
const PREVIEW_MAX_LEN = 72;

function formatLastMessagePreview(raw: string): string {
  if (!raw) return '';
  const flattened = sanitizeTerminalText(raw).replace(/\s+/g, ' ').trim();
  if (!flattened) return '';
  if (flattened.length <= PREVIEW_MAX_LEN) return flattened;
  return `${flattened.slice(0, PREVIEW_MAX_LEN - 1).trimEnd()}…`;
}

async function promptResumeOrNew(
  sessions: Array<{
    sessionId: string;
    sessionName: string;
    updatedAt: number;
    provider: string;
    model: string;
    cwd: string;
    lastUserMessage: string;
  }>,
): Promise<string | 'new' | 'cancel'> {
  const indexWidth = String(sessions.length).length;
  process.stdout.write('\nResumable sessions for this workspace:\n');
  for (let i = 0; i < sessions.length; i++) {
    const row = sessions[i];
    const num = String(i + 1).padStart(indexWidth, ' ');
    const safeName = sanitizeTerminalText(row.sessionName);
    const name = safeName ? ` ${fmt.bold(safeName)}` : '';
    const when = formatRelativeTime(row.updatedAt);
    const preview = formatLastMessagePreview(row.lastUserMessage);
    process.stdout.write(
      `  ${num}. ${row.sessionId}${name}\n` +
        `     ${fmt.dim(`${when} · ${row.provider}/${row.model}`)}\n` +
        (preview ? `     ${fmt.dim(`"${preview}"`)}\n` : ''),
    );
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  try {
    while (true) {
      const raw = (
        await rl.question(`\nResume [1-${sessions.length}, Enter=new, q=cancel]: `)
      ).trim();
      const lower = raw.toLowerCase();
      if (!raw || lower === 'n' || lower === 'new') return 'new';
      if (lower === 'q' || lower === 'quit' || lower === 'cancel') return 'cancel';
      if (/^\d+$/.test(raw)) {
        const num = Number.parseInt(raw, 10);
        if (num >= 1 && num <= sessions.length) {
          return sessions[num - 1].sessionId;
        }
      }
      const byId = sessions.find((s) => s.sessionId === raw);
      if (byId) return byId.sessionId;
      process.stdout.write(
        `Invalid choice. Enter a number 1-${sessions.length}, a session id, Enter (or n) for new, or q to cancel.\n`,
      );
    }
  } finally {
    rl.close();
  }
}

function makeAskUserFn(rl) {
  return async (question, choices) => {
    const choiceHint = choices?.length ? `  Choices: ${choices.join(' / ')}\n` : '';
    return rl.question(`\n  ${fmt.cyan('[?]')} ${question}\n${choiceHint}  > `);
  };
}

async function handleModelCommand(arg, ctx, state, config) {
  const models = getCuratedModels(ctx.providerConfig.id);

  if (!arg) {
    // Show current model + numbered list
    process.stdout.write(`Current model: ${state.model}\n`);
    if (models.length === 0) {
      process.stdout.write('No curated models for this provider. Enter any model name.\n');
      return;
    }
    process.stdout.write('Available models:\n');
    for (let i = 0; i < models.length; i++) {
      const marker = models[i] === state.model ? ' ← current' : '';
      process.stdout.write(`  ${i + 1}. ${models[i]}${marker}\n`);
    }
    process.stdout.write('Use /model <name|#> to switch.\n');
    return;
  }

  // Resolve by number (digits only) or name
  let target;
  if (/^\d+$/.test(arg)) {
    const num = parseInt(arg, 10);
    target = num >= 1 && num <= models.length ? models[num - 1] : arg;
  } else {
    target = arg;
  }

  if (target === state.model) {
    process.stdout.write(`Already using ${target}.\n`);
    return;
  }

  state.model = target;
  // Persist model to config under current provider
  const branch = { ...(config[ctx.providerConfig.id] || {}) };
  branch.model = target;
  config[ctx.providerConfig.id] = branch;
  await saveConfig(config);
  await appendSessionEvent(state, 'model_switched', {
    model: target,
    provider: ctx.providerConfig.id,
  });
  process.stdout.write(`Switched to model: ${target}\n`);
}

async function handleProviderCommand(arg, ctx, state, config) {
  const providers = getProviderList();

  if (!arg) {
    // Show all providers with status
    process.stdout.write('Providers:\n');
    for (let i = 0; i < providers.length; i++) {
      const p = providers[i];
      const current = p.id === ctx.providerConfig.id ? ' ← current' : '';
      const keyStatus = p.requiresKey ? (p.hasKey ? 'key set' : 'no key') : 'no key needed';
      process.stdout.write(
        `  ${i + 1}. ${p.id}  [${keyStatus}] default: ${p.defaultModel}${current}\n`,
      );
    }
    process.stdout.write('Use /provider <name|#> to switch.\n');
    return;
  }

  // Resolve by number (digits only) or name
  let target;
  if (/^\d+$/.test(arg)) {
    const num = parseInt(arg, 10);
    target = num >= 1 && num <= providers.length ? providers[num - 1] : null;
  } else {
    target = providers.find((p) => p.id === arg.toLowerCase());
  }

  if (!target) {
    process.stdout.write(
      `Unknown provider: ${arg}. Use: ollama, openrouter, kimi, zai, huggingface, zen, nvidia, fireworks, deepseek, sakana, openai, anthropic, google, xai\n`,
    );
    return;
  }

  if (target.id === ctx.providerConfig.id) {
    process.stdout.write(`Already using ${target.id}.\n`);
    return;
  }

  const newConfig = PROVIDER_CONFIGS[target.id];
  let newApiKey;
  try {
    newApiKey = resolveApiKey(newConfig);
  } catch {
    process.stdout.write(
      `Cannot switch to ${target.id}: no API key found.\nSet one of: ${newConfig.apiKeyEnv.join(', ')}\n`,
    );
    return;
  }

  // Update mutable context
  ctx.providerConfig = newConfig;
  ctx.apiKey = newApiKey;
  state.provider = target.id;
  state.model = config[target.id]?.model || newConfig.defaultModel;

  // Persist
  config.provider = target.id;
  await saveConfig(config);
  await appendSessionEvent(state, 'provider_switched', { provider: target.id, model: state.model });
  process.stdout.write(`Switched to ${target.id} | model: ${state.model}\n`);
}

async function runInteractive(
  state,
  providerConfig,
  apiKey,
  maxRounds,
  { alreadyPersisted = false, explicitMaxRounds = false, runtimeConfig = null } = {},
) {
  // Mutable context — allows mid-session provider/model switching
  const ctx = { providerConfig, apiKey };
  // Keep the raw user file for commands that persist changes, but consume the
  // resolved runtime view for policy. Otherwise an explicit list in the user
  // file would mask a higher-precedence PUSH_DISABLED_TOOLS / ALWAYS_ALLOW
  // environment layer on the interactive path while headless behaved
  // correctly.
  const config = await loadConfig();
  const policyConfig = runtimeConfig || config;
  if (!Array.isArray(policyConfig.safeExecPatterns)) {
    config.safeExecPatterns = [];
  }
  const safeExecPatterns = Array.isArray(policyConfig.safeExecPatterns)
    ? [...policyConfig.safeExecPatterns]
    : [];
  // Pass undefined (not []) when the key is absent so `executeToolCall`'s
  // env-var fallback (`PUSH_DISABLED_TOOLS` / `PUSH_ALWAYS_ALLOW`) actually
  // applies. An explicit empty array is an opt-out and would mask the env.
  const disabledTools = Array.isArray(policyConfig.disabledTools)
    ? policyConfig.disabledTools
    : undefined;
  const alwaysAllow = Array.isArray(policyConfig.alwaysAllow)
    ? policyConfig.alwaysAllow
    : undefined;
  const auditorGate =
    typeof policyConfig.auditorGate === 'boolean' ? policyConfig.auditorGate : undefined;

  // Lazy session creation: defer disk writes until first user message.
  let sessionPersisted = alreadyPersisted;
  async function ensureSessionPersisted() {
    if (sessionPersisted) return;
    sessionPersisted = true;
    // Normalize once so the condition (is it set?) and the emitted
    // value (the trimmed payload) can't disagree. `listSessions()`
    // trims `state.mode` on read; emitting an untrimmed value here
    // would make the `session_started` event drift from the
    // `list_sessions` row by a whitespace-padding accident.
    const trimmedMode = typeof state.mode === 'string' ? state.mode.trim() : '';
    const mode = trimmedMode || 'interactive';
    await appendSessionEvent(state, 'session_started', {
      sessionId: state.sessionId,
      state: 'idle',
      mode,
      provider: state.provider,
      sandboxProvider: resolveExecSandboxBackend() === 'host' ? 'modal' : 'local',
    });
    await saveSessionState(state);
  }
  // Skill-lint diagnostics for the current workspace. Collected on every (re)load so a malformed
  // `.push/skills/*.md` or `.claude/commands/**.md` no longer silently vanishes from `/skills`.
  // Structured, symmetric logs go to stderr (CLI stdout is reserved for user output / --json) so a
  // dropped skill is visible to ops, not just to whoever runs `/skills lint`. This is the line-based
  // REPL — stderr is safe here; the full-screen TUI deliberately omits these (see tui.ts) and relies
  // on its in-app surfacing instead. Event names/levels live once in `skillDiagnosticLogLines`.
  let skillDiagnostics: SkillDiagnostic[] = [];
  function logSkillDiagnostics(diags: SkillDiagnostic[]): void {
    for (const line of skillDiagnosticLogLines(diags)) console.error(line);
  }
  const skills = await loadSkills(state.cwd, { diagnostics: skillDiagnostics });
  logSkillDiagnostics(skillDiagnostics);
  // `visibleSkills` mirrors `skills` filtered by current platform + capabilities.
  // The completer iterates the visible view so hidden skills don't tab-complete;
  // dispatch uses the full `skills` so explicit `/<name>` invocation still runs.
  const skillFilterEnv = {
    platform: getCurrentSkillPlatform(),
    availableCapabilities: new Set<Capability>(ALL_CAPABILITIES),
  };
  const visibleSkills = filterSkillsForEnvironment(skills, skillFilterEnv);
  function rebuildVisibleSkills() {
    const fresh = filterSkillsForEnvironment(skills, skillFilterEnv);
    visibleSkills.clear();
    for (const [name, skill] of fresh) {
      visibleSkills.set(name, skill);
    }
  }

  async function reloadSkillsMap() {
    const freshDiagnostics: SkillDiagnostic[] = [];
    const fresh = await loadSkills(state.cwd, { diagnostics: freshDiagnostics });
    skills.clear();
    for (const [name, skill] of fresh) {
      skills.set(name, skill);
    }
    skillDiagnostics = freshDiagnostics;
    logSkillDiagnostics(freshDiagnostics);
    rebuildVisibleSkills();
    return skills.size;
  }

  async function compactSessionContext(rawArg) {
    const arg = String(rawArg || '').trim();
    let preserveTurns = DEFAULT_COMPACT_TURNS;
    if (arg) {
      if (!/^\d+$/.test(arg)) {
        process.stdout.write('Usage: /compact [turns] (positive integer)\n');
        return;
      }
      preserveTurns = clamp(Number.parseInt(arg, 10), 1, 64);
    }

    const result = compactContext(state.messages, { preserveTurns });
    if (!result.compacted) {
      process.stdout.write(
        `Nothing to compact (turns: ${result.totalTurns}, preserve: ${result.preserveTurns}).\n`,
      );
      return;
    }

    state.messages = result.messages;
    await appendSessionEvent(state, 'context_compacted', {
      preserveTurns: result.preserveTurns,
      totalTurns: result.totalTurns,
      compactedMessages: result.compactedCount,
      removedCount: result.removedCount,
      beforeTokens: result.beforeTokens,
      afterTokens: result.afterTokens,
    });
    // /compact replaces state.messages with a digest+tail array. That
    // can produce same-length output (drop one, insert digest) where
    // saveSessionState's length-only fast path would skip the log.
    // Use rewriteMessagesLog explicitly so the on-disk transcript
    // matches what the user just compacted.
    await rewriteMessagesLog(state);

    process.stdout.write(
      `Compacted context: ${result.compactedCount} messages -> 1 summary ` +
        `(kept last ${result.preserveTurns} turns, ~${result.beforeTokens} -> ~${result.afterTokens} tokens).\n`,
    );
  }

  const replCheckpointRenderer = {
    status: (text) => process.stdout.write(`${text}\n`),
    warning: (text) => process.stdout.write(`${text}\n`),
    error: (text) => process.stderr.write(`${fmt.error('checkpoint:')} ${text}\n`),
    bold: fmt.bold,
    dim: fmt.dim,
    // Terminal output already supports ANSI; bold reads visually as a
    // command-formatted token here. (TUI uses backticks instead because
    // the transcript renderer strips styling.)
    code: fmt.bold,
  };

  async function handleCheckpointCommand(rawArg) {
    await runCheckpointCommand(
      rawArg,
      {
        workspaceRoot: state.cwd,
        sessionId: state.sessionId,
        messages: state.messages,
        provider: state.provider,
        model: state.model,
      },
      replCheckpointRenderer,
    );
  }

  const execMode = process.env.PUSH_EXEC_MODE || 'auto';
  const completer = createCompleter({
    ctx,
    skills: visibleSkills,
    getCuratedModels,
    getProviderList,
    workspaceRoot: state.cwd,
  });
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    completer,
  });

  const approvalFn = makeInteractiveApprovalFn(rl, { config, safeExecPatterns });
  const askUserFn = makeAskUserFn(rl);
  const onEvent = makeCLIEventHandler();
  let runInFlight = false;
  let exitRequestedBySigint = false;

  const onPromptSigint = () => {
    // During assistant execution, per-run SIGINT handlers cancel the run.
    if (runInFlight) return;
    if (exitRequestedBySigint) return;
    exitRequestedBySigint = true;
    process.stdout.write(
      `\n${fmt.dim('[autosave]')} Ctrl+C received — saving session and exiting...\n`,
    );
    rl.close();
  };
  rl.on('SIGINT', onPromptSigint);

  process.stdout.write(
    `${fmt.bold('Push CLI')}\n` +
      `${fmt.dim('session:')} ${state.sessionId}\n` +
      `${fmt.dim('provider:')} ${ctx.providerConfig.id} ${fmt.dim('|')} ${fmt.dim('model:')} ${state.model}\n` +
      `${fmt.dim('endpoint:')} ${ctx.providerConfig.url}\n` +
      `${fmt.dim('workspace:')} ${state.cwd}\n` +
      `${fmt.dim('execSandbox:')} ${resolveExecSandboxBackend()}\n` +
      `${fmt.dim('Type /help for commands.')}\n`,
  );

  try {
    while (true) {
      let inputLine;
      try {
        inputLine = await rl.question('\n> ');
      } catch (err) {
        if (exitRequestedBySigint || err?.code === 'ERR_USE_AFTER_CLOSE') break;
        throw err;
      }
      const line = inputLine.trim();
      if (!line) continue;

      if (line === '/exit' || line === '/quit') break;
      if (line === '/help') {
        process.stdout.write(
          `Commands:\n` +
            `  ${fmt.bold('/new')} | ${fmt.bold('/clear')}        Start a new session (same provider/model/cwd)\n` +
            `  ${fmt.bold('/model')}               Show current model + available models\n` +
            `  ${fmt.bold('/model')} <name|#>      Switch model\n` +
            `  ${fmt.bold('/provider')}            Show all providers with status\n` +
            `  ${fmt.bold('/provider')} <name|#>   Switch provider\n` +
            `  ${fmt.bold('/skills')}              List available skills\n` +
            `  ${fmt.bold('/skills')} reload       Reload workspace + Claude skills\n` +
            `  ${fmt.bold('/compact')} [turns]     Compact older context (default keep ${DEFAULT_COMPACT_TURNS} turns)\n` +
            `  ${fmt.bold('/checkpoint')}           Snapshot/rollback (create | list | load | delete)\n` +
            `  ${fmt.bold('/worktree')}            Show the git-worktree sandbox status (if any)\n` +
            `  ${fmt.bold('/<skill>')} [args]      Run a skill (e.g. /commit, /review src/app.ts)\n` +
            `  ${fmt.dim('@path[:line[-end]]')}     Preload file refs into context (e.g. @src/app.ts:10-40)\n` +
            `  ${fmt.bold('/session')}             Print session id\n` +
            `  ${fmt.bold('/session')} rename <name>  Rename current session (${fmt.dim('--clear')} to unset)\n` +
            `  ${fmt.bold('/exit')} | ${fmt.bold('/quit')}        Exit\n`,
        );
        continue;
      }
      if (line === '/new' || line === '/clear') {
        const previousSessionId = state.sessionId;
        await ensureSessionPersisted(); // flush any unpersisted current session before switching
        await saveSessionState(state);
        state = await initSession(null, state.provider, state.model, state.cwd);
        sessionPersisted = false; // new session is lazy
        process.stdout.write(
          `Started new session: ${state.sessionId} ` +
            `(${fmt.dim(`from ${previousSessionId}`)}) ` +
            `${fmt.dim(`[${state.provider}/${state.model}]`)}\n`,
        );
        continue;
      }
      if (line === '/session' || line.startsWith('/session ')) {
        const arg = line.slice('/session'.length).trim();
        if (!arg) {
          const nameSuffix = state.sessionName ? ` (${JSON.stringify(state.sessionName)})` : '';
          process.stdout.write(`session: ${state.sessionId}${nameSuffix}\n`);
          continue;
        }

        if (arg === 'rename' || arg.startsWith('rename ')) {
          const rawName = arg.slice('rename'.length).trim();
          if (!rawName) {
            process.stdout.write('Usage: /session rename <name> | /session rename --clear\n');
            continue;
          }
          if (rawName === '--clear') {
            delete state.sessionName;
            await appendSessionEvent(state, 'session_renamed', { name: null });
            await saveSessionState(state);
            process.stdout.write('Session name cleared.\n');
            continue;
          }
          state.sessionName = rawName;
          await appendSessionEvent(state, 'session_renamed', { name: rawName });
          await saveSessionState(state);
          process.stdout.write(`Session renamed: ${JSON.stringify(rawName)}\n`);
          continue;
        }

        process.stdout.write(
          'Usage: /session | /session rename <name> | /session rename --clear\n',
        );
        continue;
      }

      // /model [arg]
      if (line === '/model' || line.startsWith('/model ')) {
        const arg = line.slice('/model'.length).trim();
        await handleModelCommand(arg || null, ctx, state, config);
        continue;
      }

      // /provider [arg]
      if (line === '/provider' || line.startsWith('/provider ')) {
        const arg = line.slice('/provider'.length).trim();
        await handleProviderCommand(arg || null, ctx, state, config);
        continue;
      }

      // /skills — list loaded skills (filtered for the current environment)
      if (line === '/skills' || line.startsWith('/skills ')) {
        const arg = line.slice('/skills'.length).trim();
        if (!arg) {
          if (skills.size === 0) {
            process.stdout.write('No skills loaded.\n');
          } else if (visibleSkills.size === 0) {
            process.stdout.write(
              `All ${skills.size} skills hidden by platform or capability constraints.\n`,
            );
          } else {
            for (const [name, skill] of visibleSkills) {
              const tag =
                skill.source === 'workspace'
                  ? fmt.dim(' (workspace)')
                  : skill.source === 'claude'
                    ? fmt.dim(' (claude)')
                    : '';
              const hint = skill.argumentHint ? ` ${fmt.dim(skill.argumentHint)}` : '';
              process.stdout.write(
                `  ${fmt.bold('/' + name)}${hint}  ${skill.description}${tag}\n`,
              );
            }
            const hidden = skills.size - visibleSkills.size;
            if (hidden > 0) {
              process.stdout.write(
                fmt.dim(`  (${hidden} hidden — platform or capability constraints unmet)\n`),
              );
            }
          }
          const summary = skillDiagnosticSummaryLine(skillDiagnostics);
          if (summary) {
            process.stdout.write(fmt.dim(`  (${summary})\n`));
          }
          continue;
        }
        if (arg === 'reload') {
          const count = await reloadSkillsMap();
          process.stdout.write(`Reloaded skills: ${count}\n`);
          continue;
        }
        if (arg === 'lint') {
          const diags = await lintSkills(state.cwd);
          skillDiagnostics = diags;
          process.stdout.write(`${formatSkillDiagnostics(diags)}\n`);
          continue;
        }
        process.stdout.write('Usage: /skills | /skills reload | /skills lint\n');
        continue;
      }

      // /compact [turns] — user-triggered context compaction
      if (line === '/compact' || line.startsWith('/compact ')) {
        const arg = line.slice('/compact'.length).trim();
        await compactSessionContext(arg || null);
        continue;
      }

      // /checkpoint [op] [args] — Nano-style snapshot/rollback
      if (line === '/checkpoint' || line.startsWith('/checkpoint ')) {
        await handleCheckpointCommand(line.slice('/checkpoint'.length));
        continue;
      }

      // /worktree — show the session's git-worktree sandbox status, if any
      if (line === '/worktree' || line.startsWith('/worktree ')) {
        process.stdout.write(
          `${await formatWorktreeStatus(state as { worktree?: WorktreeHandle })}\n`,
        );
        continue;
      }

      // /<name> [args] — skill dispatch
      if (line.startsWith('/')) {
        const spaceIdx = line.indexOf(' ');
        const cmdName = spaceIdx === -1 ? line.slice(1) : line.slice(1, spaceIdx);
        const skill = skills.get(cmdName);
        if (skill) {
          const args = spaceIdx === -1 ? '' : line.slice(spaceIdx + 1).trim();
          const promptTemplate = await getSkillPromptTemplate(skill);
          const prompt = interpolateSkill(promptTemplate, args);
          await ensureSessionPersisted();
          await appendUserMessageWithFileReferences(state, prompt, state.cwd, {
            referenceSourceText: args,
          });
          await appendSessionEvent(state, 'user_message', {
            chars: prompt.length,
            preview: prompt.slice(0, 280),
            skill: cmdName,
          });

          const ac = new AbortController();
          const onSigint = () => ac.abort();
          process.on('SIGINT', onSigint);
          runInFlight = true;

          try {
            // The user message (`prompt`) is already appended above, matching
            // the TUI's `runAssistantTurn` contract (cli/tui.ts): the dispatcher
            // runs the single conversational lead on the shared coder kernel
            // (`leadMode`) by default, with `delegated` / `engine` as opt-outs,
            // so the transcript REPL behaves identically to the TUI.
            const result = await runAssistantTurn(
              state,
              ctx.providerConfig,
              ctx.apiKey,
              prompt,
              maxRounds,
              {
                approvalFn,
                askUserFn,
                signal: ac.signal,
                emit: onEvent,
                safeExecPatterns,
                execMode,
                disabledTools,
                alwaysAllow,
                auditorGate,
                explicitMaxRounds,
              },
            );
            await saveSessionState(state);
          } catch (err) {
            if (err.name === 'AbortError') {
              await saveSessionState(state);
              process.stdout.write(`\n${fmt.yellow('[cancelled]')}\n`);
            } else {
              const message = err instanceof Error ? err.message : String(err);
              await appendSessionEvent(state, 'error', { message });
              await saveSessionState(state);
              process.stderr.write(`${fmt.error('Error:')} ${message}\n`);
            }
          } finally {
            runInFlight = false;
            process.removeListener('SIGINT', onSigint);
          }
          continue;
        }

        // Unknown /command — hint
        process.stdout.write(
          fmt.warn(
            `Unknown command: ${line.split(' ')[0]}. Type /help for commands or /skills for skills.`,
          ) + '\n',
        );
        continue;
      }

      await ensureSessionPersisted();
      await appendUserMessageWithFileReferences(state, line, state.cwd);
      await appendSessionEvent(state, 'user_message', {
        chars: line.length,
        preview: line.slice(0, 280),
      });

      const ac = new AbortController();
      const onSigint = () => ac.abort();
      process.on('SIGINT', onSigint);
      runInFlight = true;

      try {
        // `line` is already appended above — same contract the TUI uses for
        // `runAssistantTurn`: a kernel `leadMode` lead turn (the `delegated` /
        // `engine` opt-outs are retired), so the REPL matches the TUI.
        const result = await runAssistantTurn(
          state,
          ctx.providerConfig,
          ctx.apiKey,
          line,
          maxRounds,
          {
            approvalFn,
            askUserFn,
            signal: ac.signal,
            emit: onEvent,
            safeExecPatterns,
            execMode,
            disabledTools,
            alwaysAllow,
            auditorGate,
            explicitMaxRounds,
          },
        );
        await saveSessionState(state);
        if (result.outcome === 'aborted') {
          // handled by event
        } else if (result.outcome !== 'success') {
          if (result.outcome === 'max_rounds' || result.outcome === 'error') {
            // warning already emitted
          }
        }
      } catch (err) {
        if (err.name === 'AbortError') {
          await saveSessionState(state);
          process.stdout.write(`\n${fmt.yellow('[cancelled]')}\n`);
        } else {
          const message = err instanceof Error ? err.message : String(err);
          await appendSessionEvent(state, 'error', { message });
          await saveSessionState(state);
          process.stderr.write(`${fmt.error('Error:')} ${message}\n`);
        }
      } finally {
        runInFlight = false;
        process.removeListener('SIGINT', onSigint);
      }
    }
  } finally {
    rl.removeListener('SIGINT', onPromptSigint);
    rl.close();
    await saveSessionState(state);
  }

  // End-of-session metrics summary
  const metrics = getToolCallMetrics(state.sessionId);
  const malformedTotal = Object.values(metrics.malformed).reduce((a, b) => a + b, 0);
  if (malformedTotal > 0) {
    const reasons = Object.entries(metrics.malformed)
      .map(([k, v]) => `${k}:${v}`)
      .join(', ');
    process.stdout.write(
      `\n${fmt.dim('[stats]')} ${fmt.yellow(String(malformedTotal))} malformed tool call(s) this session: ${reasons}\n`,
    );
  }

  return 0;
}

async function initSession(sessionId, provider, model, cwd, mode = 'interactive') {
  if (sessionId) {
    try {
      const resumed = await loadSessionState(sessionId);
      // Seed validation commands on resumed sessions too — covers users who
      // upgrade the CLI after starting a session that pre-dates the field.
      // ensureRepoCommandsSeeded is defensive about a missing workingMemory.
      ensureRepoCommandsSeeded(resumed);
      // Intentionally don't overwrite a resumed session's `mode`. The
      // tag captures the *origin* surface; if a TUI session is later
      // resumed in the REPL, the on-disk record should keep saying
      // `'tui'` (and a legacy session with no field stays undefined →
      // listSessions defaults it to 'interactive').
      return resumed;
    } catch (err) {
      if (err.code === 'ENOENT' || (err.message && err.message.includes('ENOENT'))) {
        throw new Error(
          `Session not found: ${sessionId}. Use "push resume" to list available sessions.`,
        );
      }
      throw err;
    }
  }

  // Route through the shared factory so the attach token is minted at birth
  // (Universal Session Bearer) — the CLI's inline session is no longer born
  // tokenless, so disk-load by the daemon has nothing to backfill. `mode`
  // tags the origin surface so `list_sessions` (and the mobile drawer) bucket
  // without re-deriving from local state; it mirrors the daemon's
  // `handleStartSession` behavior. `state.mode` is the single source of
  // truth — the interactive REPL's `ensureSessionPersisted` (lower in this
  // file) and the TUI's equivalent (in tui.ts) both read it into the
  // `session_started` event payload so the event and the persisted state
  // can't drift. The headless path (`runHeadless`) skips `session_started`
  // entirely and starts from `user_message`; that event-log asymmetry is
  // pre-existing and doesn't affect `list_sessions` since it reads
  // `state.mode` from disk.
  const state = {
    ...createSessionState({
      provider,
      model,
      cwd,
      mode,
      messages: [{ role: 'system', content: buildSystemPromptBase(cwd) }],
    }),
    workingMemory: {
      plan: '',
      openTasks: [],
      filesTouched: [],
      assumptions: [],
      errorsEncountered: [],
      currentPhase: '',
      completedPhases: [],
    },
  };
  // Start enriching the system prompt in the background — will be
  // awaited before the first LLM call in the lead turn.
  ensureSystemPromptReady(state);
  // Seed repo validation commands (test/lint/typecheck/...) into working
  // memory in the background. Best-effort: failures don't block the session.
  ensureRepoCommandsSeeded(state);
  // Disk writes are deferred to first user message (lazy session creation).
  // The caller is responsible for calling appendSessionEvent('session_started') + saveSessionState
  // before the first user_message event.
  return state;
}

function normalizeProviderInput(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === 'undefined' || normalized === 'null') return '';
  return normalized;
}

function parseProvider(raw, fallback) {
  const provider =
    normalizeProviderInput(raw) ||
    normalizeProviderInput(process.env.PUSH_PROVIDER) ||
    normalizeProviderInput(fallback) ||
    'ollama';
  if (PROVIDER_CONFIGS[provider]) return provider;
  if (DEPRECATED_PROVIDERS[provider]) {
    const replacement = DEPRECATED_PROVIDERS[provider];
    process.stderr.write(
      `Warning: provider "${provider}" has been removed. Falling back to "${replacement}".\n`,
    );
    return replacement;
  }
  throw new Error(`Unsupported provider: ${provider}`);
}

function parseSearchBackend(raw, fallback = 'auto') {
  const value = String(raw || '')
    .trim()
    .toLowerCase();
  if (!value) return fallback;
  if (SEARCH_BACKENDS.has(value)) return value;
  throw new Error(
    `Unsupported --search-backend value: ${raw}. Expected one of: auto, tavily, ollama, duckduckgo`,
  );
}

function getSearchBackendArg(values) {
  return values['search-backend'] || values.searchBackend;
}

function sanitizeConfig(config) {
  const redactProvider = (obj) => {
    const out = { ...obj };
    if (out.apiKey) out.apiKey = maskSecret(out.apiKey);
    return out;
  };
  const sanitized = {
    provider: config.provider || null,
    localSandbox: config.localSandbox ?? null,
    explainMode: config.explainMode ?? null,
    tavilyApiKey: config.tavilyApiKey ? maskSecret(config.tavilyApiKey) : null,
    webSearchBackend: config.webSearchBackend || null,
    execMode: config.execMode || null,
    theme: config.theme || null,
    tuiMouseMode: config.tuiMouseMode || null,
    tuiDaemonAutoStart: config.tuiDaemonAutoStart ?? null,
    safeExecPatterns: Array.isArray(config.safeExecPatterns) ? config.safeExecPatterns : [],
    disabledTools: Array.isArray(config.disabledTools) ? config.disabledTools : [],
    alwaysAllow: Array.isArray(config.alwaysAllow) ? config.alwaysAllow : [],
    auditorGate: config.auditorGate ?? null,
    postEditDiagnostics: config.postEditDiagnostics ?? null,
    runTokenBudget: config.runTokenBudget ?? null,
    scrub: config.scrub || {},
  };
  for (const provider of Object.keys(PROVIDER_CONFIGS)) {
    sanitized[provider] = config[provider] ? redactProvider(config[provider]) : {};
  }
  return sanitized;
}

async function runConfigInit(values, config) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('push config init requires an interactive terminal. Use: push config set ...');
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  try {
    // --- Provider picker ---
    const providerDefault = parseProvider(values.provider || config.provider || 'ollama');
    let provider = providerDefault;

    if (!values.provider) {
      const providers = getProviderList();
      process.stdout.write('\nProvider:\n');
      for (let i = 0; i < providers.length; i++) {
        const p = providers[i];
        const current = p.id === providerDefault ? ' (current)' : '';
        const keyStatus = p.requiresKey ? (p.hasKey ? 'key set' : 'no key') : 'no key needed';
        process.stdout.write(`  ${i + 1}. ${p.id}  [${keyStatus}]${current}\n`);
      }
      while (true) {
        const input = (await rl.question(`Select [${providerDefault}]: `)).trim();
        if (!input) break; // keep default
        const num = parseInt(input, 10);
        if (!isNaN(num) && num >= 1 && num <= providers.length) {
          provider = providers[num - 1].id;
          break;
        }
        try {
          provider = parseProvider(input);
          break;
        } catch {
          process.stdout.write('Invalid choice. Enter a number or name.\n');
        }
      }
    }

    const providerConfig = PROVIDER_CONFIGS[provider];
    const current =
      config[provider] && typeof config[provider] === 'object' ? config[provider] : {};

    // --- Model picker ---
    const defaultModel = values.model || current.model || providerConfig.defaultModel;
    let model = defaultModel;

    if (!values.model) {
      const models = getCuratedModels(provider);
      if (models.length > 0) {
        process.stdout.write('\nModel:\n');
        for (let i = 0; i < models.length; i++) {
          const marker = models[i] === defaultModel ? ' (current)' : '';
          process.stdout.write(`  ${i + 1}. ${models[i]}${marker}\n`);
        }
        process.stdout.write('  Or type a custom model name.\n');
      }
      const modelInput = (await rl.question(`Select [${defaultModel}]: `)).trim();
      if (modelInput) {
        if (/^\d+$/.test(modelInput)) {
          const num = parseInt(modelInput, 10);
          model = num >= 1 && num <= models.length ? models[num - 1] : modelInput;
        } else {
          model = modelInput;
        }
      }
    }

    // --- Endpoint URL ---
    const defaultUrl = values.url || current.url || providerConfig.url;
    const urlInput = values.url
      ? values.url
      : (await rl.question(`Endpoint URL [${defaultUrl}]: `)).trim();
    const url = urlInput || defaultUrl;

    // --- API key ---
    const apiKeyArg = values['api-key'] || values.apiKey;
    let apiKey;
    if (apiKeyArg) {
      apiKey = apiKeyArg;
    } else {
      const currentMask = current.apiKey ? maskSecret(current.apiKey) : 'not set';
      const input = await rl.question(`API key (Enter to keep ${currentMask}): `);
      const trimmed = input.trim();
      if (trimmed) apiKey = trimmed;
    }

    // --- Tavily API key (optional, global) ---
    const tavilyKeyArg = values['tavily-key'] || values.tavilyKey;
    let tavilyApiKey;
    if (tavilyKeyArg) {
      tavilyApiKey = tavilyKeyArg;
    } else {
      const currentMask = config.tavilyApiKey ? maskSecret(config.tavilyApiKey) : 'not set';
      const input = await rl.question(`Tavily API key (optional, Enter to keep ${currentMask}): `);
      const trimmed = input.trim();
      if (trimmed) tavilyApiKey = trimmed;
    }

    // --- Web search backend (optional, global) ---
    const searchBackendArg = getSearchBackendArg(values);
    let webSearchBackend;
    if (searchBackendArg) {
      webSearchBackend = parseSearchBackend(searchBackendArg);
    } else {
      let currentBackend = 'auto';
      try {
        currentBackend = parseSearchBackend(config.webSearchBackend, 'auto');
      } catch {
        currentBackend = 'auto';
      }
      const input = await rl.question(
        `Web search backend [${currentBackend}] (auto|tavily|ollama|duckduckgo): `,
      );
      const trimmed = input.trim();
      webSearchBackend = trimmed ? parseSearchBackend(trimmed) : currentBackend;
    }

    // --- Local sandbox ---
    const localSandboxDefault = config.localSandbox ?? true;
    const localSandboxInput = await rl.question(
      `Local Docker sandbox (y/n) [${localSandboxDefault ? 'y' : 'n'}]: `,
    );
    const localSandbox = localSandboxInput
      ? localSandboxInput.toLowerCase() === 'y'
      : localSandboxDefault;

    // --- Save ---
    const next = { ...config, provider };
    const branch = { ...(next[provider] || {}) };
    branch.model = model;
    branch.url = url;
    if (apiKey !== undefined) branch.apiKey = apiKey;
    if (tavilyApiKey !== undefined) next.tavilyApiKey = tavilyApiKey;
    if (webSearchBackend !== undefined) next.webSearchBackend = webSearchBackend;
    next.localSandbox = localSandbox;
    next[provider] = branch;

    const configPath = await saveConfig(next);
    process.stdout.write(
      `\n${fmt.dim('┌─')} Saved to ${fmt.bold(configPath)}\n` +
        `${fmt.dim('│')}  ${fmt.dim('provider:')}     ${provider}\n` +
        `${fmt.dim('│')}  ${fmt.dim('model:')}        ${branch.model}\n` +
        `${fmt.dim('│')}  ${fmt.dim('endpoint:')}     ${branch.url}\n` +
        `${fmt.dim('│')}  ${fmt.dim('apiKey:')}       ${branch.apiKey ? maskSecret(branch.apiKey) : '(not set)'}\n` +
        `${fmt.dim('│')}  ${fmt.dim('tavilyKey:')}    ${next.tavilyApiKey ? maskSecret(next.tavilyApiKey) : '(not set)'}\n` +
        `${fmt.dim('│')}  ${fmt.dim('webSearch:')}    ${next.webSearchBackend || 'auto'}\n` +
        `${fmt.dim('│')}  ${fmt.dim('localSandbox:')} ${next.localSandbox}\n` +
        `${fmt.dim('└────────────────────────────────')}\n`,
    );

    return 0;
  } finally {
    rl.close();
  }
}

async function runConfigSubcommand(values, positionals, startupResolution = null) {
  const action = (positionals[1] || 'show').toLowerCase();
  const config = await loadConfig();

  if (action === 'show') {
    process.stdout.write(
      `${JSON.stringify(
        {
          path: getConfigPath(),
          config: sanitizeConfig(config),
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  if (action === 'explain') {
    // Use the pre-hydration resolution captured at process startup. Calling
    // applyConfigToEnv() canonicalizes fallback aliases (for example
    // ANTHROPIC_API_KEY -> PUSH_ANTHROPIC_API_KEY); resolving again afterward
    // would report the synthetic canonical name instead of the user's source.
    const resolution =
      startupResolution || resolveRuntimeConfig(config, { profile: values.profile });
    process.stdout.write(
      `${JSON.stringify(
        {
          precedence: ['user', 'environment', 'cli'],
          layers: resolution.layers,
          config: sanitizeConfig(resolution.config),
          provenance: resolution.provenance,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  if (action === 'init') {
    return runConfigInit(values, config);
  }

  if (action !== 'set') {
    throw new Error(
      `Unknown config action: ${action}. Use: push config show | push config explain | push config init | push config set ...`,
    );
  }

  const provider = parseProvider(values.provider || config.provider || 'ollama');
  const next = { ...config, provider };
  const branch = { ...(next[provider] || {}) };

  let changed = false;
  if (values.provider) {
    next.provider = provider;
    changed = true;
  }
  if (values.model) {
    branch.model = values.model;
    changed = true;
  }
  if (values.url) {
    branch.url = values.url;
    changed = true;
  }
  const apiKeyArg = values['api-key'] || values.apiKey;
  if (apiKeyArg) {
    branch.apiKey = apiKeyArg;
    changed = true;
  }
  const tavilyKeyArg = values['tavily-key'] || values.tavilyKey;
  if (tavilyKeyArg) {
    next.tavilyApiKey = tavilyKeyArg;
    changed = true;
  }
  const searchBackendArg = getSearchBackendArg(values);
  if (searchBackendArg) {
    next.webSearchBackend = parseSearchBackend(searchBackendArg);
    changed = true;
  }
  if (values.sandbox !== undefined) {
    next.localSandbox = true;
    changed = true;
  }
  const sandboxBackendArg = values['sandbox-backend'] || values.sandboxBackend;
  if (sandboxBackendArg) {
    const backend = resolveExecSandboxBackend(sandboxBackendArg);
    next.localSandbox = backend === 'host' ? false : backend;
    changed = true;
  }
  if (values['no-sandbox'] !== undefined) {
    next.localSandbox = false;
    changed = true;
  }
  const execModeArg = values['exec-mode'];
  if (execModeArg) {
    const VALID_EXEC_MODES = new Set(['strict', 'auto', 'yolo']);
    if (!VALID_EXEC_MODES.has(execModeArg)) {
      throw new Error(`Invalid --exec-mode "${execModeArg}". Valid values: strict, auto, yolo`);
    }
    next.execMode = execModeArg;
    changed = true;
  }

  next[provider] = branch;

  if (!changed) {
    throw new Error(
      'No config changes provided. Use one or more of: --provider, --model, --url, --api-key, --tavily-key, --search-backend, --sandbox, --sandbox-backend, --no-sandbox, --exec-mode',
    );
  }

  const configPath = await saveConfig(next);
  process.stdout.write(
    `Saved config to ${fmt.bold(configPath)}\n` +
      `${fmt.dim('provider:')} ${next.provider}\n` +
      `${fmt.dim('model:')} ${next[provider]?.model || '(unchanged)'}\n` +
      `${fmt.dim('url:')} ${next[provider]?.url || '(unchanged)'}\n` +
      `${fmt.dim('apiKey:')} ${next[provider]?.apiKey ? maskSecret(next[provider].apiKey) : '(unchanged)'}\n` +
      `${fmt.dim('tavilyKey:')} ${next.tavilyApiKey ? maskSecret(next.tavilyApiKey) : '(unchanged)'}\n` +
      `${fmt.dim('webSearch:')} ${next.webSearchBackend || 'auto'}\n` +
      `${fmt.dim('localSandbox:')} ${next.localSandbox ?? '(unchanged)'}\n` +
      `${fmt.dim('execMode:')} ${next.execMode || '(unchanged)'}\n`,
  );
  return 0;
}

async function runThemeSubcommand(positionals) {
  const { THEME_NAMES, VARIANTS, isThemeName, detectThemeName, renderThemePreview } = await import(
    './tui-theme.js'
  );
  const config = await loadConfig();
  // Match the runtime fallback chain: config.theme → PUSH_THEME →
  // detectThemeName() default. Hardcoding `'default'` here drifted out
  // of sync when the runtime default flipped to `'mono'`. Copilot
  // review on PR #552.
  const current = isThemeName(config.theme) ? config.theme : detectThemeName();
  const action = (positionals[1] || 'show').toLowerCase();

  if (action === 'show') {
    process.stdout.write(`${current}\n`);
    return 0;
  }

  if (action === 'list') {
    for (const name of THEME_NAMES) {
      const marker = name === current ? '*' : ' ';
      const variant = VARIANTS[name];
      process.stdout.write(
        `${marker} ${fmt.bold(name.padEnd(10))} ${fmt.dim(variant.description)}\n`,
      );
    }
    return 0;
  }

  if (action === 'preview') {
    const names = positionals[2] ? [positionals[2]] : THEME_NAMES;
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      if (!isThemeName(name)) {
        throw new Error(`Unknown theme: ${name}. Available: ${THEME_NAMES.join(', ')}`);
      }
      if (i > 0) process.stdout.write('\n');
      process.stdout.write(`${renderThemePreview(name)}\n`);
    }
    return 0;
  }

  // `push theme <name>` and `push theme set <name>` both set the theme.
  const name = action === 'set' ? positionals[2] : action;
  if (!name || !isThemeName(name)) {
    throw new Error(`Unknown theme: ${name || '(missing)'}. Available: ${THEME_NAMES.join(', ')}`);
  }

  const next = { ...config, theme: name };
  const configPath = await saveConfig(next);
  process.stdout.write(`Saved theme: ${fmt.bold(name)} → ${fmt.dim(configPath)}\n`);
  return 0;
}

async function runMemorySubcommand(positionals: string[]): Promise<number> {
  const sub = (positionals[1] || '').toLowerCase();
  if (sub !== 'backfill') {
    throw new Error(`Unknown memory subcommand: ${sub || '(missing)'}. Supported: backfill`);
  }

  const provider = getDefaultEmbeddingProvider();
  if (!provider) {
    process.stdout.write(
      'No embedding provider configured — nothing to backfill. Enable local embeddings ' +
        '(PUSH_EMBED_LOCAL, the default) or set PUSH_EMBED_URL, then re-run.\n',
    );
    return 0;
  }

  const { backfillEmbeddings } = await import('../lib/context-memory-backfill.js');
  const store = getDefaultMemoryStore();
  process.stdout.write(`Backfilling embeddings in ${getMemoryStoreBaseDir()} …\n`);
  const result = await backfillEmbeddings(store, provider, {
    onProgress: (embedded, total) => {
      process.stdout.write(`  ${embedded}/${total} embedded\n`);
    },
  });

  if (result.needed === 0) {
    process.stdout.write(`Up to date: ${result.scanned} record(s), none missing embeddings.\n`);
    return 0;
  }
  if (!result.providerReady) {
    process.stdout.write(
      `Embedding model unavailable (${provider.model}); left ${result.needed} record(s) lexical. ` +
        'Install @huggingface/transformers or check PUSH_EMBED_URL, then re-run.\n',
    );
    return 0;
  }
  process.stdout.write(
    `Done: ${result.scanned} scanned, ${result.embedded} embedded` +
      (result.failed ? `, ${result.failed} failed` : '') +
      `, ${result.scanned - result.needed} already current.\n`,
  );
  return 0;
}

const PRUNE_USAGE =
  'Usage: push sessions prune [--empty] [--older-than <days>] [--keep <n>] ' +
  '[--match-model <regex>] [--force] [--json]\n' +
  'Selectors AND together; at least one is required. Dry-run by default — ' +
  '--force deletes.';

function formatPruneBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/**
 * `push sessions prune` — explicit retention for the session store
 * (sessions previously accumulated unboundedly; see `pruneSessions` in
 * session-store.ts). Dry-run by default: without `--force` it only prints
 * the kill list. Selectors combine with AND so a multi-flag invocation
 * deletes the intersection, never the union.
 */
async function runSessionsPrune(values: Record<string, unknown>): Promise<number> {
  const olderThanRaw = (values['older-than'] ?? values.olderThan) as string | undefined;
  const keepRaw = values.keep as string | undefined;
  const matchModel = (values['match-model'] ?? values.matchModel) as string | undefined;
  const empty = parseBoolFlag(values.empty, 'empty') ?? false;
  const force = parseBoolFlag(values.force, 'force') ?? false;
  const dryRunFlag = parseBoolFlag(values['dry-run'] ?? values.dryRun, 'dry-run') ?? false;
  if (force && dryRunFlag) {
    throw new Error('--force and --dry-run are mutually exclusive.');
  }

  const selectors: PruneSelectors = {};
  if (empty) selectors.empty = true;
  if (olderThanRaw !== undefined) {
    const days = Number(olderThanRaw);
    if (!Number.isFinite(days) || days < 0) {
      throw new Error(`--older-than expects a non-negative number of days, got ${olderThanRaw}`);
    }
    selectors.olderThanDays = days;
  }
  if (keepRaw !== undefined) {
    const keep = Number(keepRaw);
    if (!Number.isInteger(keep) || keep < 0) {
      throw new Error(`--keep expects a non-negative integer, got ${keepRaw}`);
    }
    selectors.keep = keep;
  }
  if (matchModel !== undefined) {
    try {
      new RegExp(matchModel);
    } catch (err) {
      throw new Error(
        `--match-model is not a valid regex: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    selectors.matchModel = matchModel;
  }
  if (Object.keys(selectors).length === 0) {
    throw new Error(PRUNE_USAGE);
  }

  const report = await pruneSessions(selectors, { dryRun: !force });

  if (values.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.failed.length > 0 ? 1 : 0;
  }

  for (const c of report.candidates) {
    const age = c.updatedAt ? formatRelativeTime(c.updatedAt) : 'unknown age';
    process.stdout.write(
      `  ${c.sessionId}  ${c.provider}/${c.model}  ${age}  ${formatPruneBytes(c.bytes)}\n`,
    );
  }
  if (report.skippedActive.length > 0) {
    process.stdout.write(
      `Skipped ${report.skippedActive.length} session(s) with a live run marker: ` +
        `${report.skippedActive.join(', ')}\n`,
    );
  }
  if (report.candidates.length === 0) {
    process.stdout.write(`No sessions matched (${report.scanned} scanned).\n`);
    return 0;
  }
  if (report.dryRun) {
    process.stdout.write(
      `Dry run: ${report.candidates.length} of ${report.scanned} session(s) matched ` +
        `(${formatPruneBytes(report.bytesSelected)}). Nothing deleted — re-run with --force.\n`,
    );
    return 0;
  }
  for (const failure of report.failed) {
    process.stderr.write(`${fmt.warn('Failed:')} ${failure.sessionId}: ${failure.error}\n`);
  }
  process.stdout.write(
    `Deleted ${report.deleted.length} of ${report.candidates.length} matched session(s) ` +
      `(${formatPruneBytes(report.bytesSelected)} selected).\n`,
  );
  return report.failed.length > 0 ? 1 : 0;
}

async function readPidFile() {
  try {
    const raw = await fs.readFile(getPidPath(), 'utf8');
    return parseInt(raw.trim(), 10);
  } catch {
    return null;
  }
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid, timeoutMs) {
  const start = Date.now();
  while (isProcessRunning(pid) && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return !isProcessRunning(pid);
}

async function readLogTail(logPath, lineCount) {
  // pushd.log appends indefinitely (no rotation today). Read only the trailing
  // chunk to keep memory bounded — 16KB is well over a typical "last 5 lines"
  // worth of log output and small enough that the worst case is cheap.
  const CHUNK_SIZE = 16384;
  try {
    const stat = await fs.stat(logPath);
    const start = Math.max(0, stat.size - CHUNK_SIZE);
    const handle = await fs.open(logPath, 'r');
    try {
      const { bytesRead, buffer } = await handle.read(
        Buffer.alloc(CHUNK_SIZE),
        0,
        CHUNK_SIZE,
        start,
      );
      const contents = buffer.toString('utf8', 0, bytesRead);
      // If we landed mid-line at the chunk start, the first line may be
      // truncated — slice(-lineCount) drops it as long as lineCount is small.
      const lines = contents.split('\n').filter((line) => line.length > 0);
      return lines.slice(-lineCount);
    } finally {
      await handle.close();
    }
  } catch {
    return [];
  }
}

async function runDaemonSubcommand(values, positionals) {
  const action = (positionals[1] || 'status').toLowerCase();
  const deep = parseBoolFlag(values?.deep, 'deep');

  // Internal: run pushd in-process. Single-executable builds have no
  // sibling pushd.<ext> file on disk, so `daemon start` re-execs this
  // same binary with `daemon __run` (see the start action below).
  // Deliberately absent from help and the unknown-action list.
  if (action === '__run') {
    const { main: pushdMain } = await import('./pushd.js');
    await pushdMain();
    return 0;
  }

  if (action === 'status') {
    const pid = await readPidFile();
    const socketPath = getSocketPath();
    if (pid && isProcessRunning(pid)) {
      // Also try a live ping to confirm responsiveness
      const { tryConnect } = await import('./daemon-client.js');
      const client = await tryConnect(socketPath, 1000);
      let livenessLine;
      let sessionCount = null;
      if (client) {
        try {
          await client.request('ping', {}, null, 1000);
          livenessLine = 'status: responsive';
          if (deep) {
            try {
              const res = await client.request('list_sessions', {}, null, 1500);
              // request() resolves with the full response envelope; the
              // handler's data lives under `.payload`.
              const sessions = res?.payload?.sessions;
              if (Array.isArray(sessions)) {
                sessionCount = sessions.length;
              }
            } catch {
              // list_sessions optional under --deep; don't fail the whole status
            }
          }
        } catch {
          livenessLine = 'status: not responding to ping';
        } finally {
          client.close();
        }
      } else {
        livenessLine = 'status: socket not reachable';
      }
      process.stdout.write(
        `pushd is running (pid: ${pid})\nsocket: ${socketPath}\n${livenessLine}\n`,
      );
      if (deep) {
        let uptime = '';
        try {
          const stat = await fs.stat(getPidPath());
          const ms = Date.now() - stat.mtime.getTime();
          uptime = `${Math.floor(ms / 1000)}s since pid file written`;
        } catch {
          uptime = 'unknown';
        }
        process.stdout.write(`uptime: ${uptime}\n`);
        process.stdout.write(
          `sessions: ${sessionCount === null ? 'unavailable' : String(sessionCount)}\n`,
        );
        const tail = await readLogTail(getLogPath(), 5);
        if (tail.length === 0) {
          process.stdout.write('log: (empty)\n');
        } else {
          process.stdout.write(`log (last ${tail.length}):\n`);
          for (const line of tail) process.stdout.write(`  ${line}\n`);
        }
      }
    } else {
      process.stdout.write('pushd is not running\n');
      if (pid) {
        try {
          await fs.unlink(getPidPath());
        } catch {
          /* ignore */
        }
      }
    }
    return 0;
  }

  if (action === 'start') {
    const pid = await readPidFile();
    if (pid && isProcessRunning(pid)) {
      process.stdout.write(`pushd is already running (pid: ${pid})\n`);
      return 0;
    }

    // Launch pushd as a detached child process.
    const { spawn } = await import('node:child_process');
    // Derive pushd entry from the current runtime file extension (.js → .js, .ts → .ts, .mjs → .mjs).
    const pushdCandidate = resolvePushdEntryCandidate(import.meta.url);
    // A bun single-executable build (bun build --compile) still reports an
    // import.meta.url ending in .mjs — it's bun's internal embedded-bundle
    // root (e.g. `B:\~BUN\root\cli.mjs`), not a real file on disk. Matching
    // on extension alone sent that case down the "resolve a real pushd.mjs"
    // branch, which spawned the compiled binary with that virtual path as
    // its first positional arg — the CLI's own parser then rejected it as
    // an unknown subcommand ("Unknown command: B:\~BUN\root\pushd.mjs"),
    // so pushd never came up and every run silently fell back to inline
    // mode. Confirm the resolved path actually exists before trusting it.
    const pushdExists = pushdCandidate.path
      ? await fs.access(pushdCandidate.path).then(
          () => true,
          () => false,
        )
      : false;
    const spawnPlan = pushdSpawnPlan({
      underBun: isBunRuntime(),
      ext: pushdCandidate.ext,
      path: pushdCandidate.path,
      pathExists: pushdExists,
    });
    const nodeArgs = spawnPlan.args;
    if (spawnPlan.mode === 'script') {
      console.error(
        JSON.stringify({
          level: 'info',
          event: 'pushd_spawn_mode_script',
          entry: spawnPlan.entry,
        }),
      );
    } else {
      // No extension, or the resolved path doesn't exist on disk (bun
      // single-executable build): import.meta.url points at the embedded
      // bundle and process.execPath IS this packaged CLI. Re-exec ourselves
      // with the internal `daemon __run` action, which runs pushd's main()
      // in-process.
      // Symmetric with pushd_spawn_mode_script; stderr because CLI stdout
      // is user output. This branch choice was the silent wrong-turn behind
      // the Windows daemon-start failure — keep both sides observable.
      console.error(
        JSON.stringify({
          level: 'info',
          event: 'pushd_spawn_mode_self_exec',
          pushdPathChecked: spawnPlan.pushdPathChecked,
        }),
      );
    }

    // Redirect pushd's stdout/stderr to a log file. Previously stdio was
    // 'ignore', which hid every startup crash — a daemon that dies before
    // the socket comes up looked identical to one that's still initializing.
    // Harden the dir + file perms explicitly: fs.open's mode arg only applies
    // on first creation, so a pre-existing dir/file may retain looser perms.
    const logPath = getLogPath();
    const logDir = path.dirname(logPath);
    await fs.mkdir(logDir, { recursive: true, mode: 0o700 });
    await fs.chmod(logDir, 0o700);
    const logHandle = await fs.open(logPath, 'a', 0o600);
    await fs.chmod(logPath, 0o600);

    // try/finally so a spawn() throw (invalid execPath, bad args) can't leak
    // the log file descriptor in the parent.
    let child;
    try {
      child = spawn(process.execPath, nodeArgs, {
        detached: true,
        stdio: ['ignore', logHandle.fd, logHandle.fd],
        env: { ...process.env },
      });
      child.unref();
    } finally {
      // The child inherits the fd via dup(); release our own handle so the
      // parent process can exit without holding the log file open.
      await logHandle.close();
    }

    // Wait for daemon to become ready
    const socketPath = getSocketPath();
    const { waitForReady } = await import('./daemon-client.js');
    const ready = await waitForReady(socketPath, { maxWaitMs: 3000, intervalMs: 200 });

    if (ready) {
      process.stdout.write(
        `pushd started (pid: ${child.pid})\nsocket: ${socketPath}\nlog: ${logPath}\n`,
      );
    } else {
      process.stdout.write(
        `pushd spawned (pid: ${child.pid}) but not yet responsive\nsocket: ${socketPath}\nlog: ${logPath}\n`,
      );
    }
    return 0;
  }

  if (action === 'stop') {
    const pid = await readPidFile();
    if (!pid || !isProcessRunning(pid)) {
      process.stdout.write('pushd is not running\n');
      return 0;
    }
    process.kill(pid, 'SIGTERM');
    process.stdout.write(`pushd stopped (pid: ${pid})\n`);
    return 0;
  }

  if (action === 'restart') {
    const pid = await readPidFile();
    if (pid && isProcessRunning(pid)) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch (err) {
        // ESRCH means the process exited between our check and the signal —
        // the desired end state. Anything else (EPERM etc.) is a real failure.
        if (err?.code !== 'ESRCH') throw err;
      }
      // Wait up to 5s for the old process to fully exit before spawning a new
      // one — otherwise the new pushd races the old one on the same socket.
      const exited = await waitForProcessExit(pid, 5000);
      if (!exited) {
        process.stdout.write(
          `pushd did not exit within 5s (pid: ${pid}); restart aborted. Try \`push daemon stop\` then \`push daemon start\`.\n`,
        );
        return 1;
      }
      process.stdout.write(`pushd stopped (pid: ${pid})\n`);
    } else {
      process.stdout.write('pushd was not running; starting fresh\n');
      if (pid) {
        // Clean up the stale PID file so start() begins from a known-empty
        // state — same pattern as the status action.
        try {
          await fs.unlink(getPidPath());
        } catch {
          /* ignore */
        }
      }
    }
    return runDaemonSubcommand(values, ['daemon', 'start']);
  }

  if (action === 'pair') {
    return runDaemonPair(values);
  }

  if (action === 'revoke') {
    return runDaemonRevoke(positionals);
  }

  if (action === 'tokens') {
    return runDaemonTokens(values);
  }

  if (action === 'allow') {
    return runDaemonAllow(positionals);
  }

  if (action === 'deny') {
    return runDaemonDeny(positionals);
  }

  if (action === 'allowlist') {
    return runDaemonAllowlist(values);
  }

  if (action === 'devices') {
    return runDaemonDevices(values);
  }

  if (action === 'attach-tokens') {
    return runDaemonAttachTokens(values);
  }

  if (action === 'revoke-attach') {
    return runDaemonRevokeAttach(positionals);
  }

  if (action === 'audit') {
    return runDaemonAudit(values);
  }

  if (action === 'relay') {
    return runDaemonRelay(positionals, values);
  }

  throw new Error(
    `Unknown daemon action: ${action}. Use: push daemon start|stop|restart|status [--deep] | pair [--origin <url> | --remote] | revoke <tokenId> | tokens | allow <path> | deny <path> | allowlist | devices | attach-tokens | revoke-attach <tokenId> | audit [--tail N] [--since DATE] [--type TYPE] [--json] | relay enable --url <url> --token <token> | relay disable | relay status`,
  );
}

async function runDaemonPair(values: Record<string, unknown>): Promise<number> {
  // Phase 2.f: `--remote` short-circuits to the bundled-pairing flow
  // for a phone connecting through the Worker relay. The remote case
  // needs three pieces (deploymentUrl + sessionId + attach token)
  // bundled into one paste string, and it routes through a running
  // daemon (which holds the relay config) rather than the local file
  // store. Keep the loopback `pair` path untouched.
  if (values?.remote === true) {
    return runDaemonPairRemote();
  }

  const { normalizeOrigin, OriginNormalizationError } = await import('./pushd-origin.js');
  const { mintDeviceToken } = await import('./pushd-device-tokens.js');

  const rawOrigin = typeof values?.origin === 'string' ? (values.origin as string) : null;
  let boundOrigin: 'loopback' | string = 'loopback';
  let boundLabel = 'loopback (localhost / 127.0.0.1 / [::1] only)';

  if (rawOrigin && rawOrigin.length > 0) {
    try {
      const normalized = normalizeOrigin(rawOrigin);
      boundOrigin = normalized;
      boundLabel = normalized;
    } catch (err) {
      const message = err instanceof OriginNormalizationError ? err.message : 'invalid origin';
      process.stderr.write(`pair failed: ${message}\n`);
      return 1;
    }
  }

  const { token, tokenId } = await mintDeviceToken({ boundOrigin });

  // Print the token exactly once. We deliberately do NOT log it anywhere
  // else (no pushd.log entry, no debug echo). The bound origin is fine
  // to repeat — it isn't secret.
  process.stdout.write(`\nToken minted.\n`);
  process.stdout.write(`  id:           ${tokenId}\n`);
  process.stdout.write(`  bound origin: ${boundLabel}\n`);
  process.stdout.write(`\n`);
  process.stdout.write(`Bearer token (copy now — this is the only time it will be shown):\n`);
  process.stdout.write(`\n  ${token}\n\n`);
  process.stdout.write(
    `Loopback token minted for low-level clients. For the Push web/mobile app, use:\n`,
  );
  process.stdout.write(`  push daemon pair --remote\n\n`);
  process.stdout.write(`Revoke this token with:\n`);
  process.stdout.write(`  push daemon revoke ${tokenId}\n`);
  return 0;
}

/**
 * Phase 2.f: `push daemon pair --remote` — print a one-shot bundled
 * pairing string for a phone connecting through the Worker relay.
 *
 * Always routes through the running daemon (the relay config and the
 * in-process allowlist registry live in the daemon process; minting
 * an attach token to a fresh device token AND emitting
 * `relay_phone_allow` over the running relay client is a single
 * server-side operation that the CLI can't replicate via direct file
 * mutation). If the daemon isn't running, surface a clear "start the
 * daemon first" error rather than falling back.
 */
async function runDaemonPairRemote(): Promise<number> {
  const response = await sendDaemonAdminRequest({
    type: 'mint_remote_pair_bundle',
    payload: {},
  });
  if (response.ok) {
    const payload = response.payload ?? {};
    const bundle = String(payload.bundle ?? '');
    const deviceTokenId = String(payload.deviceTokenId ?? '');
    const attachTokenId = String(payload.attachTokenId ?? '');
    const deploymentUrl = String(payload.deploymentUrl ?? '');
    const sessionId = String(payload.sessionId ?? '');
    process.stdout.write(`\nRemote pairing bundle minted.\n`);
    process.stdout.write(`  device id:    ${deviceTokenId}\n`);
    process.stdout.write(`  attach id:    ${attachTokenId}\n`);
    process.stdout.write(`  deployment:   ${deploymentUrl}\n`);
    process.stdout.write(`  sessionId:    ${sessionId}\n\n`);
    process.stdout.write(
      `Bundle (copy now — this is the only time the bearer is shown):\n\n  ${bundle}\n\n`,
    );
    process.stdout.write(
      `Paste this bundle in the Push web app's "Remote" pairing flow on the phone.\n`,
    );
    process.stdout.write(`Revoke this phone with:\n  push daemon revoke ${deviceTokenId}\n`);
    return 0;
  }
  if (response.code === 'DAEMON_OFFLINE') {
    process.stderr.write(
      `pair --remote failed: daemon is offline. Start it with \`push daemon start\` and re-run.\n`,
    );
    return 1;
  }
  if (response.code === 'RELAY_NOT_ENABLED') {
    process.stderr.write(
      `pair --remote failed: relay is not enabled.\nRun \`push daemon relay enable --url <…> --token <…>\` first.\n`,
    );
    return 1;
  }
  process.stderr.write(`pair --remote failed: ${response.error ?? response.code ?? 'unknown'}\n`);
  return 1;
}

async function runDaemonRevoke(positionals: string[]): Promise<number> {
  const tokenId = positionals[2];
  if (!tokenId) {
    process.stderr.write('Usage: push daemon revoke <tokenId>\n');
    return 1;
  }
  // Prefer routing through the running daemon — it mutates the tokens
  // file AND closes any live WS connections that bear this token. If
  // the daemon isn't running, fall back to direct file mutation;
  // future upgrades will be rejected, and there's no live connection
  // to kill anyway. Phase 3 (#517 follow-up): live disconnect closes
  // the open-question #6 gap in the decision doc.
  const daemonResponse = await sendDaemonAdminRequest({
    type: 'revoke_device_token',
    payload: { tokenId },
  });
  if (daemonResponse.ok) {
    const closed = (daemonResponse.payload?.closedConnections as number) ?? 0;
    process.stdout.write(
      `revoked ${tokenId}${closed > 0 ? ` (closed ${closed} live connection${closed === 1 ? '' : 's'})` : ''}\n`,
    );
    return 0;
  }
  if (daemonResponse.code === 'DAEMON_OFFLINE') {
    const { revokeDeviceToken } = await import('./pushd-device-tokens.js');
    const removed = await revokeDeviceToken(tokenId);
    if (removed) {
      process.stdout.write(`revoked ${tokenId} (daemon offline, no live connections)\n`);
      return 0;
    }
    process.stderr.write(`no such token: ${tokenId}\n`);
    return 1;
  }
  // Match the file-fallback UX for TOKEN_NOT_FOUND so a CLI consumer
  // that scrapes the message gets the same string in both paths.
  // Copilot review on PR #518.
  if (daemonResponse.code === 'TOKEN_NOT_FOUND') {
    process.stderr.write(`no such token: ${tokenId}\n`);
    return 1;
  }
  process.stderr.write(
    `revoke failed: ${daemonResponse.error ?? daemonResponse.code ?? 'unknown'}\n`,
  );
  return 1;
}

async function runDaemonTokens(values: Record<string, unknown>): Promise<number> {
  const { listDeviceTokens } = await import('./pushd-device-tokens.js');
  const records = await listDeviceTokens();
  if (values?.json) {
    // Hashes are SHA-256 of the bearer token. They are not the bearer
    // itself and cannot be reversed; safe to include.
    process.stdout.write(`${JSON.stringify(records, null, 2)}\n`);
    return 0;
  }
  if (records.length === 0) {
    process.stdout.write(
      'no device tokens (web/mobile pairing: push daemon pair --remote; loopback token: push daemon pair [--origin <url>])\n',
    );
    return 0;
  }
  for (const r of records) {
    const created = new Date(r.createdAt).toISOString();
    const lastUsed = r.lastUsedAt ? new Date(r.lastUsedAt).toISOString() : 'never';
    process.stdout.write(
      `${r.tokenId}  ${r.boundOrigin}  created=${created}  lastUsed=${lastUsed}\n`,
    );
  }
  return 0;
}

async function runDaemonAllow(positionals: string[]): Promise<number> {
  const rawPath = positionals[2];
  if (!rawPath) {
    process.stderr.write('Usage: push daemon allow <absolute-path>\n');
    return 1;
  }
  const { addAllowedPath } = await import('./pushd-allowlist.js');
  try {
    const added = await addAllowedPath(rawPath);
    if (added) process.stdout.write(`added ${rawPath}\n`);
    else process.stdout.write(`already allowed: ${rawPath}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`allow failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

async function runDaemonDeny(positionals: string[]): Promise<number> {
  const rawPath = positionals[2];
  if (!rawPath) {
    process.stderr.write('Usage: push daemon deny <absolute-path>\n');
    return 1;
  }
  const { removeAllowedPath } = await import('./pushd-allowlist.js');
  const removed = await removeAllowedPath(rawPath);
  if (removed) {
    process.stdout.write(`removed ${rawPath}\n`);
    return 0;
  }
  process.stderr.write(`not in allowlist: ${rawPath}\n`);
  return 1;
}

async function runDaemonAllowlist(values: Record<string, unknown>): Promise<number> {
  const { listAllowedPaths, snapshotAllowlist } = await import('./pushd-allowlist.js');
  const records = await listAllowedPaths();
  if (values?.json) {
    const snapshot = await snapshotAllowlist();
    process.stdout.write(`${JSON.stringify({ entries: records, effective: snapshot }, null, 2)}\n`);
    return 0;
  }
  if (records.length === 0) {
    process.stdout.write(
      `no explicit allowlist (implicit default: ${process.cwd()})\n` +
        `add with: push daemon allow <absolute-path>\n`,
    );
    return 0;
  }
  for (const r of records) {
    const added = new Date(r.addedAt).toISOString();
    process.stdout.write(`${r.path}  added=${added}\n`);
  }
  return 0;
}

/**
 * `push daemon devices` — connect to the running daemon's Unix socket
 * and ask for the list of currently-attached WS connections (per-
 * device). Falls back to listing the device-token records (without
 * live status) if the daemon isn't running.
 */
async function runDaemonDevices(values: Record<string, unknown>): Promise<number> {
  const response = await sendDaemonAdminRequest({ type: 'list_devices', payload: {} });
  if (!response.ok) {
    if (response.code === 'DAEMON_OFFLINE') {
      // No live state to report — the file-based token list is the
      // only "who's paired" view available offline. Direct the user
      // there rather than printing a confusing "devices failed".
      process.stderr.write(
        'daemon not running. Run `push daemon start` first, or `push daemon tokens` for the paired-device list.\n',
      );
      return 1;
    }
    process.stderr.write(`devices failed: ${response.error ?? response.code ?? 'unknown'}\n`);
    return 1;
  }
  const devices = (response.payload?.devices as DaemonDeviceRow[]) ?? [];
  if (values?.json) {
    process.stdout.write(`${JSON.stringify(devices, null, 2)}\n`);
    return 0;
  }
  if (devices.length === 0) {
    process.stdout.write('no devices connected\n');
    return 0;
  }
  for (const d of devices) {
    const lastUsed = d.lastUsedAt ? new Date(d.lastUsedAt).toISOString() : 'never';
    process.stdout.write(
      `${d.tokenId}  ${d.boundOrigin}  connections=${d.connections} (${d.attachConnections ?? 0} attach, ${d.deviceConnections ?? 0} device)  lastUsed=${lastUsed}\n`,
    );
  }
  return 0;
}

/**
 * `push daemon attach-tokens` — list active device-attach tokens
 * (Phase 3 slice 2). Falls back to direct file read when the daemon
 * isn't running so an operator can still audit which tokens exist
 * even after the daemon stops.
 */
async function runDaemonAttachTokens(values: Record<string, unknown>): Promise<number> {
  const response = await sendDaemonAdminRequest({ type: 'list_attach_tokens', payload: {} });
  if (!response.ok && response.code !== 'DAEMON_OFFLINE') {
    process.stderr.write(`attach-tokens failed: ${response.error ?? response.code ?? 'unknown'}\n`);
    return 1;
  }
  let tokens: DaemonAttachTokenRow[];
  let ttlMs: number | undefined;
  if (response.ok) {
    tokens = (response.payload?.tokens as DaemonAttachTokenRow[]) ?? [];
    ttlMs = response.payload?.ttlMs as number | undefined;
  } else {
    // Offline: read the file directly. lastUsedAt filtering matches
    // the daemon's view (records older than TTL are hidden).
    const { listDeviceAttachTokens, getAttachTokenTtlMs } = await import(
      './pushd-attach-tokens.js'
    );
    const records = await listDeviceAttachTokens();
    tokens = records.map((r) => ({
      tokenId: r.tokenId,
      parentTokenId: r.parentTokenId,
      boundOrigin: String(r.boundOrigin),
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt,
    }));
    ttlMs = getAttachTokenTtlMs();
  }
  if (values?.json) {
    process.stdout.write(`${JSON.stringify({ tokens, ttlMs }, null, 2)}\n`);
    return 0;
  }
  if (tokens.length === 0) {
    process.stdout.write('no active attach tokens\n');
    return 0;
  }
  for (const t of tokens) {
    const created = new Date(t.createdAt).toISOString();
    const lastUsed = new Date(t.lastUsedAt).toISOString();
    process.stdout.write(
      `${t.tokenId}  parent=${t.parentTokenId}  ${t.boundOrigin}  created=${created}  lastUsed=${lastUsed}\n`,
    );
  }
  return 0;
}

/**
 * `push daemon revoke-attach <tokenId>` — revoke a single attach
 * token by id. Phase 3 slice 2 surface. Routes through the daemon
 * over its Unix socket so a live WS bearing the token also gets
 * disconnected (code 1008). Falls back to file mutation if offline.
 */
async function runDaemonRevokeAttach(positionals: string[]): Promise<number> {
  const tokenId = positionals[2];
  if (!tokenId) {
    process.stderr.write('Usage: push daemon revoke-attach <tokenId>\n');
    return 1;
  }
  const daemonResponse = await sendDaemonAdminRequest({
    type: 'revoke_device_attach_token',
    payload: { tokenId },
  });
  if (daemonResponse.ok) {
    const closed = (daemonResponse.payload?.closedConnections as number) ?? 0;
    process.stdout.write(
      `revoked ${tokenId}${closed > 0 ? ` (closed ${closed} live connection${closed === 1 ? '' : 's'})` : ''}\n`,
    );
    return 0;
  }
  if (daemonResponse.code === 'DAEMON_OFFLINE') {
    const { revokeDeviceAttachToken } = await import('./pushd-attach-tokens.js');
    const removed = await revokeDeviceAttachToken(tokenId);
    if (removed) {
      process.stdout.write(`revoked ${tokenId} (daemon offline, no live connections)\n`);
      return 0;
    }
    process.stderr.write(`no such attach token: ${tokenId}\n`);
    return 1;
  }
  if (daemonResponse.code === 'TOKEN_NOT_FOUND') {
    process.stderr.write(`no such attach token: ${tokenId}\n`);
    return 1;
  }
  process.stderr.write(
    `revoke-attach failed: ${daemonResponse.error ?? daemonResponse.code ?? 'unknown'}\n`,
  );
  return 1;
}

/**
 * `push daemon audit [--tail N] [--since DATE] [--type TYPE] [--json]`
 *
 * Reads directly from the audit log files — no daemon round-trip
 * needed. This means the command works even when the daemon is
 * stopped, which is the most useful posture for incident response
 * ("the daemon is down, let me see what happened"). Filters compose:
 * --tail applies AFTER --since / --type, so `--tail 5 --type
 * tool.sandbox_exec` returns the last 5 exec events, not the last 5
 * events of any kind that happen to also be exec.
 */
async function runDaemonAudit(values: Record<string, unknown>): Promise<number> {
  const { readAuditEvents, getAuditLogPath } = await import('./pushd-audit-log.js');
  const tailRaw = typeof values?.tail === 'string' ? values.tail : null;
  const sinceRaw = typeof values?.since === 'string' ? values.since : null;
  const typeFilter = typeof values?.type === 'string' ? values.type : undefined;
  let tail: number | undefined;
  if (tailRaw !== null) {
    const parsed = Number.parseInt(tailRaw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      process.stderr.write(`audit: invalid --tail value: ${tailRaw}\n`);
      return 1;
    }
    tail = parsed;
  }
  let sinceMs: number | undefined;
  if (sinceRaw !== null) {
    const parsed = Date.parse(sinceRaw);
    if (!Number.isFinite(parsed)) {
      process.stderr.write(`audit: invalid --since value (expected ISO date): ${sinceRaw}\n`);
      return 1;
    }
    sinceMs = parsed;
  }
  let events;
  try {
    events = await readAuditEvents({
      tail,
      sinceMs,
      type: typeFilter as any,
    });
  } catch (err) {
    process.stderr.write(
      `audit: read failed (${err instanceof Error ? err.message : String(err)})\n` +
        `audit: log path is ${getAuditLogPath()}\n`,
    );
    return 1;
  }
  if (values?.json) {
    process.stdout.write(`${JSON.stringify(events, null, 2)}\n`);
    return 0;
  }
  if (events.length === 0) {
    process.stdout.write('no audit events match the filter\n');
    return 0;
  }
  for (const e of events) {
    const when = new Date(e.ts).toISOString();
    const surface = e.surface;
    // Show the attach tokenId alongside the parent device when the
    // connection authed via attach — operators investigating a
    // specific session/tab need both ids to correlate. The parent
    // device alone groups all that user's tabs together, the
    // attach tokenId distinguishes them. #520 review.
    const who = e.deviceId
      ? e.attachTokenId
        ? `device=${e.deviceId} attach=${e.attachTokenId}`
        : `device=${e.deviceId}`
      : 'device=-';
    const auth = e.authKind ? ` auth=${e.authKind}` : '';
    const session = e.sessionId ? ` session=${e.sessionId}` : '';
    const run = e.runId ? ` run=${e.runId}` : '';
    const payload = e.payload ? ` ${JSON.stringify(e.payload)}` : '';
    process.stdout.write(
      `${when}  ${e.type}  ${surface}  ${who}${auth}${session}${run}${payload}\n`,
    );
  }
  return 0;
}

async function runDaemonRelay(
  positionals: string[],
  values: Record<string, unknown>,
): Promise<number> {
  const sub = positionals[2];
  if (sub === 'enable') {
    const { readRelayConfig } = await import('./pushd-relay-config.js');
    // Both values are optional on the command line: --url falls back to
    // whatever deployment is already persisted (the common case is
    // rotating the token against the same Worker you already dialed),
    // and --token falls back to PUSH_RELAY_TOKEN so a shell profile can
    // make `relay enable` a zero-argument command, same as the provider
    // API key env vars.
    const explicitUrl = typeof values?.url === 'string' ? (values.url as string).trim() : '';
    const explicitToken = typeof values?.token === 'string' ? (values.token as string).trim() : '';
    const persisted = explicitUrl && explicitToken ? null : await readRelayConfig();
    const url = explicitUrl || persisted?.deploymentUrl || '';
    const token = explicitToken || process.env.PUSH_RELAY_TOKEN?.trim() || '';
    if (!url || !token) {
      process.stderr.write(
        'Usage: push daemon relay enable --url <deployment-url> --token <pushd_relay_…>\n' +
          '  --url may be omitted if a relay was already configured on this machine.\n' +
          '  --token may be omitted if PUSH_RELAY_TOKEN is set in the environment.\n',
      );
      return 1;
    }
    const { isValidRelayToken } = await import('./pushd-relay-config.js');
    if (!isValidRelayToken(token)) {
      process.stderr.write(
        'relay enable failed: token must start with pushd_relay_ and include a token body (yours looks truncated)\n',
      );
      return 1;
    }
    // Try the live admin RPC first — change takes effect immediately
    // without a daemon restart. If the daemon is offline, fall back
    // to writing the file directly; the next daemon start picks it up.
    const response = await sendDaemonAdminRequest({
      type: 'relay_enable',
      payload: { deploymentUrl: url, token },
    });
    if (response.ok) {
      process.stdout.write(`relay enabled (deployment: ${url})\n`);
      return 0;
    }
    if (response.code === 'DAEMON_OFFLINE') {
      const { writeRelayConfig } = await import('./pushd-relay-config.js');
      try {
        await writeRelayConfig({ deploymentUrl: url, token });
        process.stdout.write(
          `relay config written (deployment: ${url}); start the daemon to dial.\n`,
        );
        return 0;
      } catch (err) {
        process.stderr.write(
          `relay enable failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        return 1;
      }
    }
    process.stderr.write(`relay enable failed: ${response.error ?? response.code ?? 'unknown'}\n`);
    return 1;
  }

  if (sub === 'disable') {
    const response = await sendDaemonAdminRequest({ type: 'relay_disable', payload: {} });
    if (response.ok) {
      const removed = Boolean(response.payload?.configRemoved);
      const stopped = Boolean(response.payload?.clientStopped);
      process.stdout.write(
        `relay disabled${removed ? '' : ' (no config was present)'}${stopped ? ' (closed live connection)' : ''}\n`,
      );
      return 0;
    }
    if (response.code === 'DAEMON_OFFLINE') {
      const { deleteRelayConfig } = await import('./pushd-relay-config.js');
      try {
        const removed = await deleteRelayConfig();
        process.stdout.write(
          `relay config ${removed ? 'removed' : 'was not set'} (daemon offline)\n`,
        );
        return 0;
      } catch (err) {
        process.stderr.write(
          `relay disable failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        return 1;
      }
    }
    process.stderr.write(`relay disable failed: ${response.error ?? response.code ?? 'unknown'}\n`);
    return 1;
  }

  if (sub === 'status') {
    // `relay status` always tries the live admin first because the
    // operator usually wants the runtime view ("is it actually
    // connected right now?"). When the daemon is offline we fall
    // back to a config-only read so the operator still sees whether
    // the file is present without having to start the daemon.
    const response = await sendDaemonAdminRequest({ type: 'relay_status', payload: {} });
    if (response.ok) {
      const persisted = response.payload?.persisted as
        | { deploymentUrl: string; enabledAt: number | null }
        | null
        | undefined;
      const live = response.payload?.live as Record<string, unknown> | undefined;
      if (values?.json) {
        process.stdout.write(`${JSON.stringify(response.payload, null, 2)}\n`);
        return 0;
      }
      if (!persisted) {
        process.stdout.write('relay: disabled (no config)\n');
        return 0;
      }
      process.stdout.write(`relay: enabled\n`);
      process.stdout.write(`  deployment:  ${persisted.deploymentUrl}\n`);
      if (persisted.enabledAt) {
        process.stdout.write(`  enabled at:  ${new Date(persisted.enabledAt).toISOString()}\n`);
      }
      if (live && live.running) {
        process.stdout.write(`  client:      running\n`);
        process.stdout.write(`  state:       ${String(live.state)}\n`);
        if (typeof live.attempt === 'number' && live.attempt > 0) {
          process.stdout.write(`  attempt:     ${live.attempt}\n`);
        }
        if (live.exhausted) process.stdout.write(`  exhausted:   true\n`);
        if (live.closeCode !== null && live.closeCode !== undefined) {
          process.stdout.write(
            `  last close:  ${live.closeCode} ${String(live.closeReason ?? '')}\n`,
          );
        }
        if (live.fatal) {
          process.stdout.write(
            "  ⚠ won't retry — fix the cause above, then re-run `push daemon relay enable`\n",
          );
        }
        if (typeof live.allowlistSize === 'number') {
          process.stdout.write(`  allowlist:   ${live.allowlistSize} attach token(s)\n`);
        }
      } else {
        process.stdout.write(`  client:      not running\n`);
      }
      return 0;
    }
    if (response.code === 'DAEMON_OFFLINE') {
      const { readRelayConfig } = await import('./pushd-relay-config.js');
      try {
        const cfg = await readRelayConfig();
        if (!cfg) {
          process.stdout.write('relay: disabled (no config; daemon offline)\n');
          return 0;
        }
        process.stdout.write(
          `relay: config present (daemon offline)\n  deployment:  ${cfg.deploymentUrl}\n  enabled at:  ${new Date(cfg.enabledAt).toISOString()}\n`,
        );
        return 0;
      } catch (err) {
        process.stderr.write(
          `relay status failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        return 1;
      }
    }
    process.stderr.write(`relay status failed: ${response.error ?? response.code ?? 'unknown'}\n`);
    return 1;
  }

  process.stderr.write(
    `Unknown relay subcommand: ${sub ?? '(missing)'}. Use: push daemon relay enable --url <url> --token <token> | disable | status\n`,
  );
  return 1;
}

interface DaemonAttachTokenRow {
  tokenId: string;
  parentTokenId: string;
  boundOrigin: string;
  createdAt: number;
  lastUsedAt: number;
}

interface DaemonDeviceRow {
  tokenId: string;
  boundOrigin: string;
  connections: number;
  /** Slice 2: split connections by auth kind. Optional for back-compat. */
  attachConnections?: number;
  deviceConnections?: number;
  lastUsedAt: number | null;
}

interface DaemonAdminResponse {
  ok: boolean;
  payload?: Record<string, unknown>;
  /** Human-readable error message; populated when `ok` is false. */
  error?: string;
  /**
   * Structured error code from the daemon's response envelope
   * (TOKEN_NOT_FOUND, INVALID_REQUEST, etc.) or one of the synthetic
   * codes this wrapper emits (`DAEMON_OFFLINE`). Lets CLI callers
   * branch on the failure mode without parsing the message string —
   * see `runDaemonRevoke`'s TOKEN_NOT_FOUND case for the canonical
   * pattern. Copilot review on PR #518.
   */
  code?: string;
}

/**
 * Open a one-shot connection to the daemon's Unix socket, send a
 * single admin request, await the response, close. Used by CLI
 * subcommands that need a *live* view or *live* mutation of daemon
 * state — `push daemon devices` (read live WS connections) and
 * `push daemon revoke` (close any live WS for a token in addition
 * to mutating the tokens file).
 *
 * If the daemon socket isn't reachable, returns `{ ok: false, code:
 * 'DAEMON_OFFLINE', error: 'daemon not running' }` so the caller can
 * fall back to a file-only path. When the daemon answers with
 * ok=false the wrapper preserves the structured error code from the
 * response envelope (TOKEN_NOT_FOUND etc.) so callers can produce
 * the same UX the file-only path emits.
 */
async function sendDaemonAdminRequest(opts: {
  type: string;
  payload: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<DaemonAdminResponse> {
  const { connect: connectDaemon } = await import('./daemon-client.js');
  const socketPath = getSocketPath();
  let client: Awaited<ReturnType<typeof connectDaemon>>;
  try {
    client = await connectDaemon(socketPath);
  } catch {
    return { ok: false, code: 'DAEMON_OFFLINE', error: 'daemon not running' };
  }
  try {
    const response = await client.request(opts.type, opts.payload, undefined, opts.timeoutMs);
    return {
      ok: Boolean(response.ok),
      payload: (response.payload as Record<string, unknown>) ?? {},
    };
  } catch (err) {
    // daemon-client rejects with an Error whose `.code` carries the
    // server-side error code (set in daemon-client.ts at the response
    // dispatch site). Cast through `unknown` because the public Error
    // type doesn't include `.code` but our requests always populate it.
    const e = err as { message?: string; code?: string };
    return {
      ok: false,
      code: typeof e.code === 'string' ? e.code : 'UNKNOWN',
      error: e.message || String(err),
    };
  } finally {
    try {
      client.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Sleep for `ms` milliseconds but check `shouldCancel()` every ~100ms so
 * Ctrl+C during an attach-reconnect backoff aborts within one poll tick
 * instead of blocking for the full delay. Returns `true` if the sleep
 * completed, `false` if cancelled early.
 */
async function sleepInterruptible(ms, shouldCancel) {
  const CHECK_INTERVAL = 100;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (shouldCancel()) return false;
    const chunk = Math.min(CHECK_INTERVAL, end - Date.now());
    if (chunk <= 0) break;
    await new Promise((r) => setTimeout(r, chunk));
  }
  return !shouldCancel();
}

async function readLocalAttachToken(sessionId) {
  try {
    const state = await loadSessionState(sessionId);
    const token = state?.attachToken;
    return typeof token === 'string' && token.trim() ? token : null;
  } catch {
    return null;
  }
}

export function buildAttachSessionPayload({ sessionId, lastSeenSeq, attachToken = null }) {
  const payload = {
    sessionId,
    lastSeenSeq,
    capabilities: [...ATTACH_CLIENT_CAPABILITIES],
  };
  if (typeof attachToken === 'string' && attachToken.trim()) {
    payload.attachToken = attachToken;
  }
  return payload;
}

export async function buildAttachSessionPayloadForSession(sessionId, lastSeenSeq) {
  const attachToken = await readLocalAttachToken(sessionId);
  return buildAttachSessionPayload({ sessionId, lastSeenSeq, attachToken });
}

/**
 * `push attach <session-id>` — stream live events from a pushd session.
 *
 * Behavior contract:
 *   1. Attach to a live session.
 *   2. Watch events in a readable transcript — delegation events route
 *      through `delegationEventToTranscript` via `makeCLIEventHandler`.
 *   3. Recover after disconnect without manual state inspection — we
 *      persist `lastSeenSeq` to the session's `client-attach.json` and
 *      auto-reconnect with exponential backoff (0s, 1s, 2s, 4s, 8s, 16s,
 *      30s, capped). On each reattach we pass the persisted seq to
 *      `attach_session`, so the daemon replays exactly the events we
 *      missed — never the whole log from zero.
 *
 * Options:
 *   --no-resume — start fresh from seq 0 (useful if the stored state is
 *     corrupt or you explicitly want to replay the full history).
 */
async function runAttach(sessionId, options = {}) {
  const pid = await readPidFile();
  if (!pid || !isProcessRunning(pid)) {
    throw new Error('pushd is not running. Start it with: push daemon start');
  }

  const socketPath = getSocketPath();
  const { connect } = await import('./daemon-client.js');

  // Resume from the last seq we successfully processed. `--no-resume`
  // is the escape hatch: replay the whole event log from the beginning.
  const persisted = options.noResume
    ? { lastSeenSeq: 0, updatedAt: 0 }
    : await readClientAttachState(sessionId);
  let lastSeenSeq = persisted.lastSeenSeq;
  const seqWriter = makeDebouncedClientAttachWriter(sessionId);

  const onEvent = makeCLIEventHandler();
  // Wrap the renderer so we track the highest seq we've observed BEFORE
  // delegating to the renderer. A render-time exception is swallowed by
  // daemon-client's try/catch around listeners, but we still want the
  // resume point to advance so a later reconnect doesn't replay the
  // event that tripped the renderer. Workspace-state events are live-only
  // and reuse the durable stream's current seq, so they must not move this
  // cursor.
  const observingHandler = (event) => {
    const isWorkspaceStateEvent =
      event.type === 'workspace.state_snapshot' || event.type === 'workspace.state_delta';
    if (!isWorkspaceStateEvent && typeof event.seq === 'number' && event.seq > lastSeenSeq) {
      lastSeenSeq = event.seq;
      seqWriter.schedule(lastSeenSeq);
    }
    onEvent(event);
  };

  let userRequestedExit = false;
  let currentClient = null;
  const onSigint = () => {
    userRequestedExit = true;
    process.stdout.write('\n[detached]\n');
    if (currentClient) {
      currentClient.close();
    }
  };
  process.on('SIGINT', onSigint);

  // Reconnect backoff. Index 0 is the initial connect attempt (no wait);
  // subsequent entries apply after each unexpected disconnect. We cap at
  // 30s to keep the worst-case resume latency bounded on a daemon that's
  // slow to restart.
  const BACKOFF_MS = [0, 1000, 2000, 4000, 8000, 16000, 30000];
  let attemptIdx = 0;
  let firstConnection = true;
  let exitCode = 0;

  try {
    while (!userRequestedExit) {
      const delay = BACKOFF_MS[Math.min(attemptIdx, BACKOFF_MS.length - 1)];
      if (delay > 0) {
        process.stdout.write(
          `${fmt.dim(`[reconnecting in ${Math.round(delay / 1000)}s — Ctrl+C to give up]`)}\n`,
        );
        const completed = await sleepInterruptible(delay, () => userRequestedExit);
        if (!completed) break;
      }
      attemptIdx += 1;

      let client;
      try {
        client = await connect(socketPath);
      } catch (err) {
        if (firstConnection) {
          process.stderr.write(`${fmt.error('Connection error:')} ${err.message}\n`);
          exitCode = 1;
          break;
        }
        // Transient failure during reconnect — back off and retry.
        continue;
      }
      currentClient = client;
      client.onEvent(observingHandler);

      let res;
      try {
        res = await client.request(
          'attach_session',
          await buildAttachSessionPayloadForSession(sessionId, lastSeenSeq),
        );
      } catch (err) {
        if (firstConnection) {
          process.stderr.write(`${fmt.error('Attach failed:')} ${err.message}\n`);
          client.close();
          currentClient = null;
          exitCode = 1;
          break;
        }
        // Attach failed on a reconnect — likely SESSION_NOT_FOUND or
        // INVALID_TOKEN. These are not transient, so surface and exit.
        process.stderr.write(`${fmt.error('Attach failed on reconnect:')} ${err.message}\n`);
        client.close();
        currentClient = null;
        exitCode = 1;
        break;
      }

      if (firstConnection) {
        process.stdout.write(
          `Attached to ${sessionId}\n` +
            `State: ${res.payload.state}${res.payload.activeRunId ? ` (run: ${res.payload.activeRunId})` : ''}\n` +
            `Replay: seq ${res.payload.replay.fromSeq}–${res.payload.replay.toSeq}\n`,
        );
        firstConnection = false;
      } else {
        process.stdout.write(
          `${fmt.dim(`[reattached — replayed seq ${res.payload.replay.fromSeq}–${res.payload.replay.toSeq}]`)}\n`,
        );
      }

      // A successful attach resets the backoff ladder so the next drop
      // retries quickly rather than inheriting this cycle's delay.
      attemptIdx = 0;

      await new Promise((resolve) => {
        // `.once` (not `.on`) so an `error` followed by the inevitable
        // `close` doesn't double-resolve, and so neither listener lingers
        // on the socket after we move on to the next reconnect iteration.
        const done = () => resolve();
        client._socket.once('close', done);
        client._socket.once('error', done);
      });

      // Belt-and-suspenders: `daemon-client.connect`'s `error` handler
      // tears down pending requests but does NOT call `socket.end()`, so
      // an error-path exit can leave the underlying fd half-alive. Call
      // `client.close()` (which ends the socket) unconditionally before
      // looping. It's idempotent — on an already-closed socket `end()`
      // is a no-op — so calling it in the normal close path is safe too.
      try {
        client.close();
      } catch {
        // Swallow: we're past this client's lifecycle anyway.
      }

      currentClient = null;
      if (userRequestedExit) break;
      process.stdout.write(`${fmt.dim('[disconnected]')}\n`);
      // Next attempt waits BACKOFF_MS[1] (1s) rather than the 0s initial.
      attemptIdx = 1;
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
    // Final flush so the debounced writer doesn't leave data in memory.
    await seqWriter.flush();
    // Belt-and-suspenders: write the current lastSeenSeq one more time in
    // case the debounced writer had nothing pending.
    await writeClientAttachState(sessionId, lastSeenSeq);
  }

  return exitCode;
}

/**
 * Read piped stdin to completion when stdin is not a TTY. Returns the
 * trimmed payload, or null when the stream is empty / actually a TTY.
 * Capped at `maxBytes` so a runaway pipe can't OOM the process; the cap
 * is generous (1 MiB) since piped tasks are prose, not binaries.
 *
 * Uses async iteration rather than `'data'`/`'end'` listeners so the
 * common "stdin closed before we attached" race resolves immediately
 * instead of hanging — the iterator reads from the stream's internal
 * state, which already knows the stream ended.
 */
async function readPipedStdin(maxBytes = 1024 * 1024): Promise<string | null> {
  if (process.stdin.isTTY) return null;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = maxBytes - total;
    if (buf.length > remaining) {
      chunks.push(buf.subarray(0, remaining));
      total = maxBytes;
      break;
    }
    chunks.push(buf);
    total += buf.length;
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text || null;
}

/**
 * Friendly exit for non-TTY invocations of bare `push` when no task was
 * given and stdin had nothing to read. Tells the caller exactly how to
 * use the headless path or pipe a prompt instead of leaving them with
 * the historical "requires a TTY" wall.
 */
function exitNonInteractiveNoTask(): never {
  const lines = [
    `${fmt.error('push:')} no TTY available and no task was provided.`,
    '',
    'For scripted or CI use, pass a task explicitly:',
    '  push run --task "describe the task"',
    '',
    'Or pipe a prompt on stdin:',
    '  echo "fix the failing test" | push',
    '  cat task.md | push',
    '',
  ];
  process.stderr.write(lines.join('\n'));
  process.exit(1);
}

// Sole full-screen TUI launcher. Both launch sites (the `tui` subcommand and
// bare `push`) route through the retained Silvery surface. Session/worktree
// lifecycle stays at the call sites; this seam only guards the runtime, imports
// the renderer lazily, logs the launch, and forwards resolved options.
// Silvery is bundled into the Bun single-binary; only unused optional terminal
// adapters stay external (see CI compile flags).

type RunTuiOptions = import('./silvery/entry.js').RunTuiOptions;
type TuiRunnerModule = {
  runTuiSilvery?: (options: RunTuiOptions) => Promise<number> | number;
};

export interface LaunchTuiDeps {
  nodeMajor?: number;
  isBun?: () => boolean;
  log?: (line: string) => void;
  loadSilvery?: () => Promise<TuiRunnerModule>;
}

export async function launchTui(options: RunTuiOptions, deps: LaunchTuiDeps = {}) {
  const log = deps.log ?? console.error;
  const bun = (deps.isBun ?? isBunRuntime)();
  const nodeMajor = deps.nodeMajor ?? Number(process.versions.node.split('.')[0]);
  if (!bun && nodeMajor < 24) {
    throw new Error(
      `Push TUI requires Node >=24 (silvery 0.21 uses \`using\` syntax); ` +
        `you are on ${process.version}. Run \`nvm use 24\`.`,
    );
  }
  log(JSON.stringify({ level: 'info', event: 'tui_launch_silvery' }));
  const renderer = deps.loadSilvery ? await deps.loadSilvery() : await import('./silvery/entry.js');
  const { runTuiSilvery } = renderer as TuiRunnerModule;
  if (!runTuiSilvery) throw new Error('Silvery renderer module does not export runTuiSilvery().');
  return runTuiSilvery(options);
}

export async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: false,
    options: {
      provider: { type: 'string' },
      model: { type: 'string' },
      url: { type: 'string' },
      'api-key': { type: 'string' },
      apiKey: { type: 'string' },
      'tavily-key': { type: 'string' },
      tavilyKey: { type: 'string' },
      'search-backend': { type: 'string' },
      searchBackend: { type: 'string' },
      cwd: { type: 'string' },
      session: { type: 'string' },
      task: { type: 'string' },
      skill: { type: 'string' },
      accept: { type: 'string', multiple: true },
      'max-rounds': { type: 'string' },
      maxRounds: { type: 'string' },
      json: { type: 'boolean', default: false },
      jsonl: { type: 'boolean', default: false },
      policy: { type: 'string' },
      'run-id': { type: 'string' },
      runId: { type: 'string' },
      'session-id': { type: 'string' },
      sessionId: { type: 'string' },
      'output-schema': { type: 'string' },
      outputSchema: { type: 'string' },
      profile: { type: 'string' },
      lint: { type: 'boolean', default: false },
      headless: { type: 'boolean', default: false },
      'allow-exec': { type: 'boolean' },
      allowExec: { type: 'boolean' },
      mode: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      // Opt-in git-worktree sandbox for `push run` (cli/worktree.ts). `--worktree`
      // is a plain boolean (auto-named branch) to dodge the `strict:false`
      // string-option footgun documented below, where a bare value-taking flag
      // swallows the next argv token. `--worktree-name <name>` sets a custom
      // branch and implies `--worktree`.
      worktree: { type: 'boolean' },
      'worktree-name': { type: 'string' },
      worktreeName: { type: 'string' },
      sandbox: { type: 'boolean' },
      'sandbox-backend': { type: 'string' },
      sandboxBackend: { type: 'string' },
      'exec-mode': { type: 'string' },
      'no-sandbox': { type: 'boolean' },
      'no-resume': { type: 'boolean' },
      'no-attach': { type: 'boolean' },
      'no-resume-prompt': { type: 'boolean' },
      version: { type: 'boolean', short: 'v' },
      deep: { type: 'boolean' },
      origin: { type: 'string' },
      // Phase 3 slice 3 audit-log filters. Declared as string options
      // so `--tail 5 --since 2026-05-01 --type tool.sandbox_exec` is
      // parsed correctly. Without the explicit string type the
      // `strict: false` mode treats unknown long options as boolean
      // true and shifts the next argv into positionals, silently
      // dropping the filter value. Codex P2 on #520.
      tail: { type: 'string' },
      since: { type: 'string' },
      type: { type: 'string' },
      // `push sessions prune` selectors. Value-taking flags MUST be declared
      // as strings — under `strict: false`, an undeclared `--keep 100` parses
      // as boolean true and shifts `100` into positionals (same class as the
      // Codex P2 on #520 above).
      'older-than': { type: 'string' },
      olderThan: { type: 'string' },
      keep: { type: 'string' },
      'match-model': { type: 'string' },
      matchModel: { type: 'string' },
      empty: { type: 'boolean' },
      force: { type: 'boolean' },
      // Phase 2.e: `push daemon relay enable --url <…> --token <…>`.
      // `--url` is already declared above for the cloud-side run path.
      token: { type: 'string' },
      // Phase 2.f: `push daemon pair --remote` switches to the
      // relay-bundle pairing flow.
      remote: { type: 'boolean' },
      // `push audit-evals replay` controls. `--limit <n>` is value-taking, so
      // it must be declared as a string under `strict: false` (same footgun as
      // `--keep` / `--tail` above); `--no-rejected` skips the rejected-arm
      // replay.
      limit: { type: 'string' },
      'no-rejected': { type: 'boolean' },
      noRejected: { type: 'boolean' },
    },
  });

  // Warn on unknown flags (strict: false swallows them silently)
  for (const key of Object.keys(values)) {
    if (!KNOWN_OPTIONS.has(key)) {
      process.stderr.write(`${fmt.warn('Warning:')} unknown flag --${key}\n`);
    }
  }

  if (values.version) {
    process.stdout.write(`push ${VERSION}\n`);
    return 0;
  }

  // Install the file-backed ContextMemoryStore for the interactive CLI, mirroring
  // the daemon (`cli/pushd.ts`) and headless `push run` (`runHeadless`) entries.
  // Without this the inline REPL/TUI uses a fresh in-memory store, so persisted
  // records under ~/.push/memory are invisible to both the session-digest prefetch
  // (cli/engine.ts) and the memory_grep/memory_expand tools. Idempotent — the
  // daemon/headless paths re-set the same store.
  setDefaultMemoryStore(createFileMemoryStore({ baseDir: getMemoryStoreBaseDir() }));
  // LCM Phase 3: durable verbatim log so the full original text behind a
  // record's verbatimRef survives restarts and memory_expand can recall it.
  setDefaultVerbatimLog(createFileVerbatimLog({ baseDir: getVerbatimLogBaseDir() }));
  installCliEmbeddingProvider();

  if (values.help) {
    printHelp();
    return 0;
  }

  // Validate every config-shaped CLI value before assembling the highest-
  // precedence layer. This keeps both runtime behavior and `config explain`
  // on the same resolution snapshot.
  const userConfig = await loadConfig();
  const baselineConfig = resolveRuntimeConfig(userConfig, { profile: values.profile }).config;
  const sandboxBackendArg = values['sandbox-backend'] || values.sandboxBackend;
  if (values.sandbox && values['no-sandbox']) {
    throw new Error('Conflicting flags: --sandbox and --no-sandbox cannot both be set.');
  }
  if (sandboxBackendArg && (values.sandbox || values['no-sandbox'])) {
    throw new Error(
      'Conflicting sandbox flags: choose one of --sandbox, --sandbox-backend, or --no-sandbox.',
    );
  }
  const envSandbox = process.env.PUSH_LOCAL_SANDBOX
    ? resolveExecSandboxBackend(process.env.PUSH_LOCAL_SANDBOX)
    : undefined;
  const flagSandbox = sandboxBackendArg
    ? resolveExecSandboxBackend(sandboxBackendArg)
    : values.sandbox
      ? true
      : values['no-sandbox']
        ? false
        : undefined;

  const searchBackendArg = getSearchBackendArg(values);
  const cliSearchBackend = searchBackendArg ? parseSearchBackend(searchBackendArg) : undefined;

  const VALID_EXEC_MODES = new Set(['strict', 'auto', 'yolo']);
  if (values.mode && !VALID_EXEC_MODES.has(values.mode)) {
    throw new Error(`Invalid --mode "${values.mode}". Valid values: strict, auto, yolo`);
  }

  const cliProvider =
    values.provider || values.model
      ? parseProvider(values.provider, baselineConfig.provider)
      : undefined;
  const cliConfigOverrides = {};
  if (values.provider) cliConfigOverrides.provider = cliProvider;
  if (values.model && cliProvider) {
    cliConfigOverrides[cliProvider] = { model: values.model };
  }
  if (flagSandbox !== undefined) cliConfigOverrides.localSandbox = flagSandbox;
  if (cliSearchBackend) cliConfigOverrides.webSearchBackend = cliSearchBackend;
  if (values.mode) cliConfigOverrides.execMode = values.mode;

  const runtimeConfigResolution = resolveRuntimeConfig(userConfig, {
    overrides: cliConfigOverrides,
    profile: values.profile,
  });
  const { config: runtimeConfig } = runtimeConfigResolution;
  applyConfigToEnv(runtimeConfig);

  // Preserve explicit flags on the compatibility env surface consumed by
  // provider/tool modules and child processes.
  const localSandbox = flagSandbox ?? envSandbox ?? runtimeConfig.localSandbox;
  if (localSandbox !== undefined) {
    process.env.PUSH_LOCAL_SANDBOX = String(localSandbox);
  }

  if (cliSearchBackend) {
    process.env.PUSH_WEB_SEARCH_BACKEND = cliSearchBackend;
  }

  if (values.mode) {
    process.env.PUSH_EXEC_MODE = values.mode;
  }

  const subcommand = positionals[0] || '';
  if (values.json && values.jsonl) {
    throw new Error('Conflicting output flags: --json and --jsonl cannot be combined.');
  }
  if (values.jsonl && subcommand !== 'run') {
    throw new Error('--jsonl is supported only by `push run`.');
  }
  if (values.policy !== undefined && subcommand !== 'eval') {
    throw new Error('--policy is supported only by `push eval`.');
  }
  if (
    (values['run-id'] !== undefined ||
      values.runId !== undefined ||
      values['session-id'] !== undefined ||
      values.sessionId !== undefined) &&
    subcommand !== 'eval'
  ) {
    throw new Error('--run-id and --session-id are supported only by `push eval`.');
  }
  const outputSchemaArg = values['output-schema'] || values.outputSchema;
  if (outputSchemaArg && subcommand !== 'run') {
    throw new Error('--output-schema is supported only by `push run`.');
  }
  // Resolve relative to the invoking shell before --worktree can re-root the
  // session cwd. Schema errors fail before provider auth or agent side effects.
  const outputSchema = outputSchemaArg
    ? await loadOutputSchema(outputSchemaArg, process.cwd())
    : null;
  // TUI is the default UX for bare `push` in a TTY. Set PUSH_TUI_ENABLED=0
  // (or 'false') to opt back to the transcript REPL. The launcher used to
  // export PUSH_TUI_ENABLED=1 to achieve this; that's now the in-code
  // default so direct `node cli/cli.ts` invocations get the same UX as
  // `./push`.
  const tuiOptOut =
    process.env.PUSH_TUI_ENABLED === '0' || process.env.PUSH_TUI_ENABLED === 'false';
  const tuiEnabled = !tuiOptOut;
  if (subcommand === 'config') {
    return runConfigSubcommand(values, positionals, runtimeConfigResolution);
  }

  if (subcommand === 'theme') {
    return runThemeSubcommand(positionals);
  }

  if (subcommand === 'memory') {
    return runMemorySubcommand(positionals);
  }

  if (subcommand === 'audit-evals') {
    const { runAuditEvalsSubcommand } = await import('./audit-eval-replay.ts');
    return runAuditEvalsSubcommand(values, positionals);
  }

  if (subcommand === 'eval') {
    const { runRuntimeEvalSubcommand } = await import('./runtime-eval-command.ts');
    return runRuntimeEvalSubcommand(values, positionals, {
      cwd: path.resolve(values.cwd || process.cwd()),
    });
  }

  if (subcommand === 'resume' || subcommand === 'sessions') {
    const sessionsCmd = positionals[1] || '';
    if (sessionsCmd === 'prune') {
      return runSessionsPrune(values);
    }
    if (sessionsCmd === 'rename') {
      const sessionId = positionals[2];
      const nameArg = positionals.slice(3).join(' ').trim();
      if (!sessionId) {
        throw new Error('Usage: push resume rename <session-id> <name|--clear>');
      }
      if (!nameArg) {
        throw new Error('Usage: push resume rename <session-id> <name|--clear>');
      }
      const state = await loadSessionState(sessionId);
      if (nameArg === '--clear') {
        delete state.sessionName;
        await appendSessionEvent(state, 'session_renamed', { name: null });
        await saveSessionState(state);
        if (values.json) {
          process.stdout.write(
            `${JSON.stringify({ ok: true, sessionId, sessionName: null }, null, 2)}\n`,
          );
        } else {
          process.stdout.write(`Cleared session name: ${sessionId}\n`);
        }
        return 0;
      }
      state.sessionName = nameArg;
      await appendSessionEvent(state, 'session_renamed', { name: nameArg });
      await saveSessionState(state);
      if (values.json) {
        process.stdout.write(
          `${JSON.stringify({ ok: true, sessionId, sessionName: nameArg }, null, 2)}\n`,
        );
      } else {
        process.stdout.write(`Renamed ${sessionId} -> ${JSON.stringify(nameArg)}\n`);
      }
      return 0;
    }
    if (sessionsCmd) {
      throw new Error(`Unknown resume subcommand: ${sessionsCmd}. Supported: rename, prune`);
    }

    const sessions = await listSessions();
    if (values.json) {
      process.stdout.write(`${JSON.stringify(sessions, null, 2)}\n`);
      return 0;
    }
    if (sessions.length === 0) {
      process.stdout.write('No sessions found.\n');
      return 0;
    }

    const noAttach = parseBoolFlag(values['no-attach'] ?? values.noAttach, 'no-attach');
    // `push sessions` is the script-friendly alias and must never prompt.
    // `push resume` attaches interactively when stdio is a TTY, unless the
    // caller opted out with --no-attach or --json (both covered above).
    const shouldPrompt =
      subcommand === 'resume' &&
      !noAttach &&
      Boolean(process.stdin.isTTY) &&
      Boolean(process.stdout.isTTY);

    if (!shouldPrompt) {
      for (const row of sessions) {
        const namePart = row.sessionName ? `  name=${JSON.stringify(row.sessionName)}` : '';
        process.stdout.write(
          `${row.sessionId}  ${new Date(row.updatedAt).toISOString()}  ${row.provider}/${row.model}  ${row.cwd}${namePart}\n`,
        );
      }
      return 0;
    }

    const noResume = parseBoolFlag(values['no-resume'] ?? values.noResume, 'no-resume');

    // When exactly one session is resumable the picker's disambiguation
    // value is zero — the user's answer is already knowable. Skip the prompt
    // and attach directly, but print a one-liner naming the session first so
    // the auto-resume is visible (not a surprise) and the operator still has
    // a Ctrl-C window before runAttach's network handshake. `--no-attach`
    // and non-TTY paths above already bypass this branch.
    if (sessions.length === 1) {
      const only = sessions[0];
      const safeName = sanitizeTerminalText(only.sessionName);
      const label = safeName ? ` (${fmt.bold(safeName)})` : '';
      const when = formatRelativeTime(only.updatedAt);
      const preview = formatLastMessagePreview(only.lastUserMessage);
      process.stdout.write(
        `\nResuming only session: ${only.sessionId}${label}\n` +
          `  ${fmt.dim(`${when} · ${only.provider}/${only.model} · ${only.cwd}`)}\n` +
          (preview ? `  ${fmt.dim(`"${preview}"`)}\n` : ''),
      );
      return runAttach(only.sessionId, { noResume });
    }

    const indexWidth = String(sessions.length).length;
    process.stdout.write('\nResumable sessions:\n');
    for (let i = 0; i < sessions.length; i++) {
      const row = sessions[i];
      const num = String(i + 1).padStart(indexWidth, ' ');
      const safeName = sanitizeTerminalText(row.sessionName);
      const name = safeName ? ` ${fmt.bold(safeName)}` : '';
      const when = formatRelativeTime(row.updatedAt);
      const preview = formatLastMessagePreview(row.lastUserMessage);
      process.stdout.write(
        `  ${num}. ${row.sessionId}${name}\n` +
          `     ${fmt.dim(`${when} · ${row.provider}/${row.model} · ${row.cwd}`)}\n` +
          (preview ? `     ${fmt.dim(`"${preview}"`)}\n` : ''),
      );
    }

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    let selected: (typeof sessions)[number] | null = null;
    try {
      while (true) {
        const raw = (
          await rl.question('\nAttach which? [1-' + sessions.length + ', q to cancel]: ')
        ).trim();
        if (!raw || raw.toLowerCase() === 'q' || raw.toLowerCase() === 'quit') {
          process.stdout.write('Cancelled.\n');
          return 0;
        }
        // Require digits-only for numeric selection so inputs like
        // "1-session-id" don't get parsed as index 1 via parseInt's lenient
        // prefix match.
        if (/^\d+$/.test(raw)) {
          const num = Number.parseInt(raw, 10);
          if (num >= 1 && num <= sessions.length) {
            selected = sessions[num - 1];
            break;
          }
        }
        const byId = sessions.find((s) => s.sessionId === raw);
        if (byId) {
          selected = byId;
          break;
        }
        process.stdout.write(
          `Invalid choice. Enter a number 1-${sessions.length}, a session id, or q to cancel.\n`,
        );
      }
    } finally {
      rl.close();
    }

    return runAttach(selected!.sessionId, { noResume });
  }

  if (subcommand === 'skills') {
    const cwd = path.resolve(values.cwd || process.cwd());
    if (values.lint) {
      // `push skills --lint` is CI-usable: exit 1 when any skill file is dropped (errors),
      // 0 when only warnings or clean. Warnings don't fail the gate — they're fail-open degrades.
      const diags = await lintSkills(cwd);
      const hasErrors = diags.some((d) => d.severity === 'error');
      if (values.json) {
        process.stdout.write(`${JSON.stringify(diags, null, 2)}\n`);
      } else {
        process.stdout.write(`${formatSkillDiagnostics(diags)}\n`);
      }
      return hasErrors ? 1 : 0;
    }
    const skills = await loadSkills(cwd);
    if (values.json) {
      // JSON includes every skill plus its constraint fields so tooling can introspect
      // (filtering is a display concern; consumers may have a different runtime profile).
      const arr = [...skills.values()].map(
        ({ name, description, source, filePath, requiresCapabilities, platforms }) => ({
          name,
          description,
          source,
          filePath,
          ...(requiresCapabilities ? { requiresCapabilities } : {}),
          ...(platforms ? { platforms } : {}),
        }),
      );
      process.stdout.write(`${JSON.stringify(arr, null, 2)}\n`);
      return 0;
    }
    const visible = filterSkillsForEnvironment(skills, {
      platform: getCurrentSkillPlatform(),
      availableCapabilities: new Set<Capability>(ALL_CAPABILITIES),
    });
    if (skills.size === 0) {
      process.stdout.write('No skills found.\n');
      return 0;
    }
    if (visible.size === 0) {
      process.stdout.write(
        `All ${skills.size} skills hidden by platform or capability constraints.\n`,
      );
      return 0;
    }
    for (const [name, skill] of visible) {
      const tag =
        skill.source === 'workspace'
          ? fmt.dim(' (workspace)')
          : skill.source === 'claude'
            ? fmt.dim(' (claude)')
            : '';
      process.stdout.write(`  ${fmt.bold('/' + name)}  ${skill.description}${tag}\n`);
    }
    const hidden = skills.size - visible.size;
    if (hidden > 0) {
      process.stdout.write(
        fmt.dim(`  (${hidden} hidden — platform or capability constraints unmet)\n`),
      );
    }
    return 0;
  }

  if (subcommand === 'stats') {
    const filter = {};
    if (values.provider) filter.provider = values.provider;
    if (values.model) filter.model = values.model;
    const stats = await aggregateStats(filter);
    if (values.json) {
      process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
    } else {
      process.stdout.write(`${formatStats(stats)}\n`);
    }
    return 0;
  }

  if (subcommand === 'daemon') {
    return runDaemonSubcommand(values, positionals);
  }

  if (subcommand === 'attach') {
    const sessionId = positionals[1];
    if (!sessionId) throw new Error('Usage: push attach <session-id> [--no-resume]');
    const noResume = parseBoolFlag(values['no-resume'] ?? values.noResume, 'no-resume');
    return runAttach(sessionId, { noResume });
  }

  if (subcommand === 'init-deep') {
    const { runInitDeep } = await import('./init-deep.ts');
    const cwd = path.resolve(values.cwd || process.cwd());
    const dryRun = parseBoolFlag(values['dry-run'] ?? values.dryRun, 'dry-run');
    const force = parseBoolFlag(values.force, 'force');
    const result = await runInitDeep({ cwd, dryRun, force });

    if (values.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            dryRun,
            force,
            significantDirs: result.significantDirs,
            written: result.written.map((p) => ({
              path: p.path,
              dir: p.dir,
              significance: p.significance,
            })),
            skipped: result.skipped.map((p) => ({
              path: p.path,
              dir: p.dir,
              significance: p.significance,
            })),
          },
          null,
          2,
        )}\n`,
      );
      return 0;
    }

    process.stdout.write(
      `${fmt.dim('[init-deep]')} scanned ${result.significantDirs} significant director${
        result.significantDirs === 1 ? 'y' : 'ies'
      }\n`,
    );

    const writeLabel = dryRun ? '[plan]' : '[write]';
    for (const proposal of result.written) {
      process.stdout.write(`${fmt.green(writeLabel)} ${proposal.path}\n`);
    }
    for (const proposal of result.skipped) {
      process.stdout.write(
        `${fmt.dim('[skip]')} ${proposal.path} (already exists — use --force to overwrite)\n`,
      );
    }

    if (dryRun) {
      process.stdout.write(
        `${fmt.dim('[init-deep]')} dry-run — ${result.written.length} file(s) would be written, ${result.skipped.length} skipped. Re-run without --dry-run to apply.\n`,
      );
    } else {
      process.stdout.write(
        `${fmt.dim('[init-deep]')} wrote ${result.written.length} file(s), skipped ${result.skipped.length}\n`,
      );
    }
    return 0;
  }

  if (subcommand === 'tui') {
    if (!tuiEnabled) {
      throw new Error(
        'TUI was disabled by PUSH_TUI_ENABLED (0 / false). Unset the variable, or set it to 1 / true, to re-enable it.',
      );
    }
    if (!process.stdin.isTTY) {
      throw new Error('TUI requires a TTY terminal. For scripted use, run: push run --task "..."');
    }
    return launchTui({
      sessionId: values.session,
      provider: values.provider,
      model: values.model,
      cwd: values.cwd ? path.resolve(values.cwd) : undefined,
      maxRounds:
        values['max-rounds'] || values.maxRounds
          ? clamp(Number(values['max-rounds'] || values.maxRounds), 1, MAX_ALLOWED_ROUNDS)
          : undefined,
      explicitMaxRounds: (values['max-rounds'] || values.maxRounds) !== undefined,
    });
  }

  if (!KNOWN_SUBCOMMANDS.has(subcommand)) {
    throw new Error(
      `Unknown command: ${subcommand}. Known commands: run, eval, config, sessions, skills, stats, daemon, attach, tui, theme, animate, spinner, memory, init-deep, audit-evals. See: push --help`,
    );
  }

  const provider = parseProvider(values.provider, runtimeConfig.provider);
  const providerConfig = PROVIDER_CONFIGS[provider];
  const cwd = path.resolve(values.cwd || process.cwd());
  if (values.cwd) {
    let cwdStat;
    try {
      cwdStat = await fs.stat(cwd);
    } catch (err) {
      if (err.code === 'ENOENT') throw new Error(`--cwd path does not exist: ${cwd}`);
      throw err;
    }
    if (!cwdStat.isDirectory()) throw new Error(`--cwd path is not a directory: ${cwd}`);
  }
  const maxRoundsRaw = values['max-rounds'] || values.maxRounds;
  if (maxRoundsRaw !== undefined) {
    const parsed = Number(maxRoundsRaw);
    if (!Number.isFinite(parsed)) {
      throw new Error(
        `Invalid --max-rounds value: "${maxRoundsRaw}". Must be a number between 1 and ${MAX_ALLOWED_ROUNDS}.`,
      );
    }
  }
  const maxRounds = clamp(Number(maxRoundsRaw || DEFAULT_MAX_ROUNDS), 1, MAX_ALLOWED_ROUNDS);
  // An explicit --max-rounds disables the adaptive harness (the cap is honored
  // exactly); omitting it lets the default budget adapt. Threaded via
  // RunOptions so the lead turn never has to guess default-50 vs explicit-50.
  const explicitMaxRounds = maxRoundsRaw !== undefined;
  const acceptanceChecks = Array.isArray(values.accept) ? values.accept : [];

  const positionalTask = subcommand === 'run' ? positionals.slice(1).join(' ').trim() : '';
  let task = (values.task || positionalTask).trim();
  let runHeadlessMode = values.headless || subcommand === 'run';

  // Non-TTY fallback for bare `push`. If we'd otherwise enter the
  // interactive REPL / TUI without a TTY, fall through to headless: use
  // --task when provided, else read piped stdin as the task. Without
  // this, `cat task.md | push` and `push --task "..." </dev/null`
  // both hard-error on "requires a TTY" further down. Skipped when the
  // user already chose a non-interactive path (`run`, `--headless`),
  // since they don't need a fallback.
  if (subcommand === '' && !runHeadlessMode && !process.stdin.isTTY) {
    if (!task) {
      const piped = await readPipedStdin();
      if (piped) task = piped;
    }
    if (task) {
      runHeadlessMode = true;
    }
  }

  // --skill: expand skill template into the task
  if (values.skill) {
    const skillMap = await loadSkills(cwd);
    const skill = skillMap.get(values.skill);
    if (!skill) {
      const available = [...skillMap.keys()].join(', ') || '(none)';
      throw new Error(`Unknown skill: ${values.skill}. Available: ${available}`);
    }
    const promptTemplate = await getSkillPromptTemplate(skill);
    task = interpolateSkill(promptTemplate, task);
  }

  if (!runHeadlessMode) {
    const ignored = [];
    if (values.task) ignored.push('--task');
    if (values.skill) ignored.push('--skill');
    if (values.accept) ignored.push('--accept');
    if (values.json) ignored.push('--json');
    if (ignored.length > 0) {
      process.stderr.write(
        `${fmt.warn('Warning:')} ${ignored.join(', ')} ignored in interactive mode. Use: push run\n`,
      );
    }
  }
  const requestedModel = values.model || providerConfig.defaultModel;

  // Bare `push` in REPL + TTY with resumable sessions for *this* cwd:
  // offer a picker with a "new" choice rather than always starting fresh.
  // Cross-cwd resume is still available via `push resume`. TUI mode
  // manages its own session flow, so skip the picker when tuiEnabled.
  // `push --session <id>`, `push run`, and `--no-resume-prompt` also
  // bypass (explicit session / headless / opt-out respectively).
  let resumedSessionId = values.session;
  if (
    !resumedSessionId &&
    !runHeadlessMode &&
    subcommand === '' &&
    !tuiEnabled &&
    !parseBoolFlag(values['no-resume-prompt'] ?? values.noResumePrompt, 'no-resume-prompt') &&
    Boolean(process.stdin.isTTY) &&
    Boolean(process.stdout.isTTY)
  ) {
    const here = (await listSessions()).filter((s) => s.cwd === cwd);
    if (here.length > 0) {
      const picked = await promptResumeOrNew(here);
      if (picked === 'cancel') {
        process.stdout.write('Cancelled.\n');
        return 0;
      }
      if (picked !== 'new') {
        resumedSessionId = picked;
      }
    }
  }

  // Pick the origin-surface tag at dispatch time so a freshly created
  // session lands on disk with the right `mode`. The TUI branch below
  // requires a TTY; if that check fails the process throws before any
  // user-visible run starts, so a `'tui'`-tagged but-aborted state on
  // disk is acceptable (it just looks like an unused TUI session).
  const sessionMode = runHeadlessMode
    ? 'headless'
    : subcommand === '' && tuiEnabled && process.stdin.isTTY
      ? 'tui'
      : 'interactive';
  // Opt-in git-worktree sandbox (Phase 1: `push run` headless only). Resolve
  // it before the session is created so the worktree path becomes the session
  // `cwd` — that single redirection is what isolates every tool from the real
  // checkout (cli/worktree.ts).
  const worktreeNameArg = (values['worktree-name'] ?? values.worktreeName) as string | undefined;
  const worktreeEnabled = Boolean(values.worktree) || Boolean(worktreeNameArg?.trim());
  let activeWorktree: WorktreeHandle | null = null;
  let effectiveCwd = cwd;
  if (worktreeEnabled) {
    // Interactive worktree sessions need a TTY (TUI/REPL); headless `push run`
    // does not. With neither there's nothing to run and we'd `process.exit`
    // below (skipping teardown), so refuse up front rather than leak a worktree.
    if (!runHeadlessMode && !process.stdin.isTTY) {
      throw new Error('--worktree needs either `push run` (headless) or an interactive TTY.');
    }
    if (resumedSessionId) {
      throw new Error(
        '--worktree starts a fresh sandbox; to continue an existing one, resume with just --session (its worktree is reused automatically).',
      );
    }
    const gitRoot = await resolveGitRoot(cwd);
    if (!gitRoot) {
      throw new Error(`--worktree requires a git repository, but ${cwd} is not inside one.`);
    }
    const branch = worktreeNameArg?.trim() || autoWorktreeBranchName();
    if (isInvalidGitRef(branch)) {
      throw new Error(`Invalid --worktree-name "${branch}". Use a valid git branch name.`);
    }
    try {
      activeWorktree = await addWorktree({ repoRoot: gitRoot, branch });
    } catch (err) {
      if (err instanceof WorktreeError) throw new Error(err.message);
      throw err;
    }
    effectiveCwd = activeWorktree.path;
    // `[worktree]` status goes to stderr so it never pollutes `--json` stdout
    // (headless JSON mode must stay machine-parseable); it's diagnostic output.
    process.stderr.write(
      `${fmt.dim('[worktree]')} sandbox ready at ${activeWorktree.path} on branch ${fmt.green(branch)}\n`,
    );
  }

  const state = await initSession(
    resumedSessionId,
    provider,
    requestedModel,
    effectiveCwd,
    sessionMode,
  );
  if (values.model && values.model !== state.model) state.model = values.model;
  if (values.provider && values.provider !== state.provider) {
    state.provider = provider;
    state.model = requestedModel;
  }
  // A `--cwd` override is ignored once a worktree owns the session cwd — the
  // worktree path wins, otherwise the session would run outside its sandbox.
  if (!activeWorktree && values.cwd && path.resolve(values.cwd) !== state.cwd) {
    state.cwd = path.resolve(values.cwd);
  }
  if (activeWorktree) {
    state.worktree = {
      path: activeWorktree.path,
      branch: activeWorktree.branch,
      baseSha: activeWorktree.baseSha,
      repoRoot: activeWorktree.repoRoot,
    };
  } else if (state.worktree) {
    // Resume into an existing worktree session: re-root `cwd` at the persisted
    // worktree when it still exists, so a resumed session lands back in its
    // sandbox (and gets the same teardown). If it was cleaned up since, drop
    // the stale pointer and continue in the main tree rather than failing.
    const wt = state.worktree;
    const stillThere = await fs
      .stat(wt.path)
      .then(() => true)
      .catch(() => false);
    if (stillThere) {
      activeWorktree = wt;
      state.cwd = wt.path;
      process.stderr.write(
        `${fmt.dim('[worktree]')} resumed in sandbox ${wt.path} (branch ${fmt.green(wt.branch)})\n`,
      );
    } else {
      // The worktree was cleaned up since the last run. Re-root cwd at the main
      // repo so subsequent tool calls + saves don't target the missing dir, and
      // drop the stale pointer so teardown doesn't try to act on it.
      state.cwd = wt.repoRoot;
      process.stderr.write(
        `${fmt.warn('[worktree]')} previous sandbox ${wt.path} is gone; continuing in ${wt.repoRoot}.\n`,
      );
      delete state.worktree;
    }
  }
  await saveSessionState(state);

  // One teardown site for the worktree across every surface. Headless,
  // bare-push TUI, and the REPL all run in-process and return here, so a single
  // `finally` applies the clean-if-clean lifecycle no matter how the session
  // ends (normal exit, /quit, Ctrl-C, or a thrown error). `return await` is
  // load-bearing: it keeps each surface inside the `try` until it actually
  // exits, so teardown runs after the run — not the instant its promise is made.
  try {
    if (runHeadlessMode) {
      if (!task) {
        throw new Error(
          'Headless mode requires a task. Use: push run --task "..." or push run --skill <name>',
        );
      }
      // Resolve API key late — after all validation — so missing keys
      // don't mask argument or environment errors.
      const apiKey = resolveApiKey(providerConfig);
      const allowExec =
        values['allow-exec'] || values.allowExec || process.env.PUSH_ALLOW_EXEC === 'true';
      const headlessSafePatterns = Array.isArray(runtimeConfig.safeExecPatterns)
        ? runtimeConfig.safeExecPatterns
        : [];
      // Same env-fallback contract as the REPL path: undefined -> env wins,
      // explicit array -> opt-out.
      const headlessDisabledTools = Array.isArray(runtimeConfig.disabledTools)
        ? runtimeConfig.disabledTools
        : undefined;
      const headlessAlwaysAllow = Array.isArray(runtimeConfig.alwaysAllow)
        ? runtimeConfig.alwaysAllow
        : undefined;
      const headlessExecMode = process.env.PUSH_EXEC_MODE || 'auto';
      // Raw (not pre-resolved) so PUSH_AUDITOR_GATE can still override at the
      // tool layer. Default on when unset.
      const headlessAuditorGate =
        typeof runtimeConfig.auditorGate === 'boolean' ? runtimeConfig.auditorGate : undefined;
      const headlessRunOpts = {
        allowExec,
        safeExecPatterns: headlessSafePatterns,
        execMode: headlessExecMode,
        disabledTools: headlessDisabledTools,
        alwaysAllow: headlessAlwaysAllow,
        auditorGate: headlessAuditorGate,
        outputSchema,
        explicitMaxRounds,
      };
      return await runHeadless(
        state,
        providerConfig,
        apiKey,
        task,
        maxRounds,
        values.json,
        values.jsonl,
        acceptanceChecks,
        headlessRunOpts,
      );
    }

    // Default UX: bare "push" opens TUI when enabled.
    // Non-TTY callers were already redirected to headless above when they
    // had a task or piped stdin; reaching here without a TTY means there
    // was nothing to fall back to, so print the friendly hint and exit.
    if (subcommand === '' && tuiEnabled) {
      if (!process.stdin.isTTY) {
        exitNonInteractiveNoTask();
      }
      return await launchTui({
        sessionId: state.sessionId,
        maxRounds,
        explicitMaxRounds,
      });
    }

    if (!process.stdin.isTTY) {
      exitNonInteractiveNoTask();
    }

    const apiKey = resolveApiKey(providerConfig);
    return await runInteractive(state, providerConfig, apiKey, maxRounds, {
      // Resumed sessions (either via --session or via the bare-push picker)
      // already have their state + session_started event on disk; without
      // this runInteractive would lazily re-emit session_started on the
      // first user message.
      alreadyPersisted: !!resumedSessionId,
      explicitMaxRounds,
      runtimeConfig,
    });
  } finally {
    // Clean-if-clean teardown: remove the worktree only when it has no
    // uncommitted changes and no commits beyond base; otherwise keep it and
    // report the path so unpushed work is never silently destroyed.
    if (activeWorktree) {
      try {
        const outcome = await teardownWorktree(activeWorktree);
        if (outcome.removed) {
          process.stderr.write(
            `${fmt.dim('[worktree]')} removed disposable sandbox (branch ${outcome.branch}) — no changes to keep\n`,
          );
        } else {
          process.stderr.write(
            `${fmt.warn('[worktree]')} kept ${outcome.path} (branch ${fmt.green(outcome.branch)}) — ${outcome.reason}.\n` +
              `${fmt.dim('           ')}Commit/push from there, then remove with: git worktree remove ${outcome.path}\n`,
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `${fmt.warn('[worktree]')} teardown check failed (${message}); left ${activeWorktree.path} in place.\n`,
        );
      }
    }
  }
}

// Only run main() when this module is executed directly (not when it's
// imported by a test file or another module). Without this guard, any
// `import { ... } from '../cli.ts'` triggers interactive-mode startup
// and errors out in headless test environments.
//
// Matches the entry basename `cli` with any of the extensions we ship
// under (`.ts` via tsx for dev/tests, `.js`/`.mjs`/`.cjs` for compiled
// output produced by `npm run build:cli`). Handles both POSIX (`/`)
// and Windows (`\\`) path separators so a packaged `push` binary on
// either platform still boots into interactive mode.
//
// Single-executable builds (`bun build --compile`) embed the bundle at a
// virtual path with no extension (`/$bunfs/root/<name>`), so the regex
// can't see them; `import.meta.main` is the authoritative signal there.
// Node under tsx leaves `import.meta.main` undefined for imports, so the
// extra clause never flips the guard on for test imports.
const isDirectRun =
  import.meta.main === true ||
  (typeof process.argv[1] === 'string' && /[/\\]cli\.(ts|mjs|cjs|js)$/.test(process.argv[1]));

if (isDirectRun) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${fmt.error('Error:')} ${message}\n`);
      process.exitCode = 1;
    });
}
