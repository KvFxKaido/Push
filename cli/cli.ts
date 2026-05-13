#!/usr/bin/env node
// @ts-nocheck — gradual typing in progress for this large module
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { PROVIDER_CONFIGS, resolveApiKey, getProviderList } from './provider.js';
import { matchingRiskPatternIndex, suggestApprovalPrefix } from './tools.js';
import { getCuratedModels, DEFAULT_MODELS } from './model-catalog.js';
import {
  makeSessionId,
  saveSessionState,
  appendSessionEvent,
  loadSessionState,
  listSessions,
  rewriteMessagesLog,
} from './session-store.js';
import { runCheckpointCommand } from './checkpoint-command.js';
import {
  buildSystemPromptBase,
  ensureSystemPromptReady,
  runAssistantLoop,
  DEFAULT_MAX_ROUNDS,
} from './engine.js';
import {
  loadConfig,
  saveConfig,
  applyConfigToEnv,
  getConfigPath,
  maskSecret,
} from './config-store.js';
import { aggregateStats, formatStats } from './stats.js';
import { getToolCallMetrics } from './tool-call-metrics.js';
import { getSocketPath, getPidPath, getLogPath } from './pushd.js';
import { loadSkills, interpolateSkill, getSkillPromptTemplate } from './skill-loader.js';
import { createCompleter } from './completer.js';
import { fmt, formatRelativeTime, Spinner } from './format.js';
import { appendUserMessageWithFileReferences } from './file-references.js';
import { compactContext } from './context-manager.js';
import { buildHeadlessTaskBrief } from './task-brief.js';
import { createDelegationTranscriptRenderer, isDelegationEvent } from './tui-delegation-events.js';
import { runCommandInResolvedShell } from './shell.js';
import { ensureRepoCommandsSeeded } from './repo-commands.js';
import {
  readClientAttachState,
  writeClientAttachState,
  makeDebouncedClientAttachWriter,
} from './client-attach-state.js';

const VERSION = '0.1.0';
export const ATTACH_CLIENT_CAPABILITIES = Object.freeze(['event_v2']);

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
  'headless',
  'allow-exec',
  'allowExec',
  'skill',
  'mode',
  'help',
  'sandbox',
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
  'delegate',
  'deep',
  'origin',
]);

const KNOWN_SUBCOMMANDS = new Set([
  '',
  'run',
  'config',
  'resume',
  'sessions',
  'skills',
  'stats',
  'daemon',
  'attach',
  'tui',
  'theme',
  'animate',
  'spinner',
  'init-deep',
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
  push resume                   Pick a session and attach (TTY); list only when piped
  push resume --no-attach       List resumable sessions without prompting (script-friendly)
  push sessions                 List resumable sessions (never prompts; alias for scripts)
  push skills                   List available skills
  push stats                    Show provider compliance stats
  push daemon start             Start background daemon
  push daemon stop              Stop background daemon
  push daemon status            Check daemon status
  push daemon pair              Mint a device token (loopback-only)
  push daemon pair --origin <url>
                                Mint a device token bound to an exact origin
  push daemon tokens            List device tokens (no secrets)
  push daemon revoke <tokenId>  Revoke a device token
  push tui                       Start full-screen TUI
  push tui --session <id>        Resume session in TUI
  push attach <session-id>      Attach to a running daemon session
  push init-deep                Generate AGENTS.md skeletons for significant directories
  push init-deep --dry-run      Preview the init-deep plan without writing files
  push init-deep --force        Overwrite existing AGENTS.md files
  push config show              Show saved CLI config
  push config init              Interactive setup wizard
  push config set ...           Save provider config defaults
  push theme                    Show current TUI theme
  push theme list               List available TUI themes
  push theme preview [<name>]   Preview swatches for a theme (all themes if omitted)
  push theme set <name>         Set TUI theme (default|neon|metallic|mono|solarized|forest)
  push animate                  Show pinned TUI animation (or "follow-theme")
  push animate list             List animation effects
  push animate set <name>       Pin TUI animation (off|pulse|shimmer|rainbow)
  push animate follow-theme     Unpin: use each theme's default animation
  push spinner                  Show pinned Braille spinner
  push spinner list             List spinners (with frame previews)
  push spinner set <name>       Pin spinner (off|braille|orbit|breathe|pulse|helix)
  push spinner unpin            Unpin: revert to static status dot

Options:
  --provider <name>             ollama | openrouter | zen | nvidia (default: ollama)
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
  --max-rounds <n>              Tool-loop cap per user prompt (default: 8)
  --allow-exec                  Allow exec tool in headless mode (blocked by default)
  --mode <strict|auto|yolo>     Exec approval mode: strict=prompt all, auto=prompt high-risk (default), yolo=no prompts
  --json                        JSON output in headless mode / resume
  --no-attach                   Resume: list sessions without prompting (script-friendly)
  --no-resume-prompt            Bare push: skip the "resume or new" prompt and start a new session
  --delegate                    Headless: plan the task and run it as a task graph (spike)
  --sandbox                     Enable local Docker sandbox
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
      const { stdout, stderr } = await runCommandInResolvedShell(command, {
        cwd,
        timeout: 120_000,
        maxBuffer: 4_000_000,
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
        const text = truncateText(event.payload.text || event.payload.preview || '', 420);
        if (ok) {
          process.stdout.write(`${fmt.green('[tool:ok]')} ${fmt.dim(text)}\n`);
        } else {
          process.stdout.write(`${fmt.red('[tool:error]')} ${text}\n`);
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

async function runHeadless(
  state,
  providerConfig,
  apiKey,
  task,
  maxRounds,
  jsonOutput,
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
  } = {},
) {
  const taskPrompt = buildHeadlessTaskBrief(task, acceptanceChecks);
  await appendUserMessageWithFileReferences(state, taskPrompt, state.cwd, {
    referenceSourceText: task,
  });
  await appendSessionEvent(state, 'user_message', {
    chars: task.length,
    preview: task.slice(0, 280),
  });

  const ac = new AbortController();
  const onSigint = () => ac.abort();
  process.on('SIGINT', onSigint);

  try {
    // Headless run is silent during execution unless we want to wire up a log listener later
    const result = await runAssistantLoop(state, providerConfig, apiKey, maxRounds, {
      signal: ac.signal,
      emit: null,
      allowExec,
      safeExecPatterns,
      execMode,
      disabledTools,
      alwaysAllow,
    });
    await saveSessionState(state);

    // Non-throw abort path (engine returned outcome: 'aborted' without throwing)
    if (result.outcome === 'aborted') {
      if (jsonOutput) {
        process.stdout.write(
          `${JSON.stringify({ sessionId: state.sessionId, runId: result.runId || null, outcome: 'aborted' }, null, 2)}\n`,
        );
      } else {
        process.stderr.write(`${fmt.yellow('[aborted]')}\n`);
      }
      return 130;
    }

    let acceptance = null;

    if (Array.isArray(acceptanceChecks) && acceptanceChecks.length > 0) {
      acceptance = await runAcceptanceChecks(state.cwd, acceptanceChecks);
      await appendSessionEvent(
        state,
        'acceptance_complete',
        {
          passed: acceptance.passed,
          checks: acceptance.checks.map((check) => ({
            command: check.command,
            ok: check.ok,
            exitCode: check.exitCode,
            durationMs: check.durationMs,
          })),
        },
        result.runId || null,
      );
      await saveSessionState(state);
    }

    const success = result.outcome === 'success' && (!acceptance || acceptance.passed);

    if (jsonOutput) {
      process.stdout.write(
        `${JSON.stringify(
          {
            sessionId: state.sessionId,
            runId: result.runId || null,
            outcome: success
              ? 'success'
              : acceptance && !acceptance.passed
                ? 'acceptance_failed'
                : result.outcome,
            rounds: result.rounds,
            assistant: result.finalAssistantText,
            acceptance,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      process.stdout.write(`${result.finalAssistantText}\n`);
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
      if (jsonOutput) {
        process.stdout.write(
          `${JSON.stringify({ sessionId: state.sessionId, outcome: 'aborted' }, null, 2)}\n`,
        );
      } else {
        process.stderr.write(`${fmt.yellow('[aborted]')}\n`);
      }
      return 130;
    }

    const message = err instanceof Error ? err.message : String(err);
    await appendSessionEvent(state, 'error', { message });
    await saveSessionState(state);

    if (jsonOutput) {
      process.stdout.write(
        `${JSON.stringify({ sessionId: state.sessionId, outcome: 'error', error: message }, null, 2)}\n`,
      );
    } else {
      process.stderr.write(`${fmt.error('Error:')} ${message}\n`);
    }
    return 1;
  } finally {
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
    process.stdout.write(`Unknown provider: ${arg}. Use: ollama, openrouter, zen, nvidia\n`);
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
  { alreadyPersisted = false } = {},
) {
  // Mutable context — allows mid-session provider/model switching
  const ctx = { providerConfig, apiKey };
  const config = await loadConfig();
  if (!Array.isArray(config.safeExecPatterns)) {
    config.safeExecPatterns = [];
  }
  const safeExecPatterns = config.safeExecPatterns;
  // Pass undefined (not []) when the key is absent so `executeToolCall`'s
  // env-var fallback (`PUSH_DISABLED_TOOLS` / `PUSH_ALWAYS_ALLOW`) actually
  // applies. An explicit empty array is an opt-out and would mask the env.
  const disabledTools = Array.isArray(config.disabledTools) ? config.disabledTools : undefined;
  const alwaysAllow = Array.isArray(config.alwaysAllow) ? config.alwaysAllow : undefined;

  // Lazy session creation: defer disk writes until first user message.
  let sessionPersisted = alreadyPersisted;
  async function ensureSessionPersisted() {
    if (sessionPersisted) return;
    sessionPersisted = true;
    await appendSessionEvent(state, 'session_started', {
      sessionId: state.sessionId,
      state: 'idle',
      mode: 'interactive',
      provider: state.provider,
      sandboxProvider: process.env.PUSH_LOCAL_SANDBOX === 'true' ? 'local' : 'modal',
    });
    await saveSessionState(state);
  }
  const skills = await loadSkills(state.cwd);

  async function reloadSkillsMap() {
    const fresh = await loadSkills(state.cwd);
    skills.clear();
    for (const [name, skill] of fresh) {
      skills.set(name, skill);
    }
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
    skills,
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
      `${fmt.dim('localSandbox:')} ${process.env.PUSH_LOCAL_SANDBOX === 'true'}\n` +
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
            `  ${fmt.bold('/new')}                 Start a new session (same provider/model/cwd)\n` +
            `  ${fmt.bold('/model')}               Show current model + available models\n` +
            `  ${fmt.bold('/model')} <name|#>      Switch model\n` +
            `  ${fmt.bold('/provider')}            Show all providers with status\n` +
            `  ${fmt.bold('/provider')} <name|#>   Switch provider\n` +
            `  ${fmt.bold('/skills')}              List available skills\n` +
            `  ${fmt.bold('/skills')} reload       Reload workspace + Claude skills\n` +
            `  ${fmt.bold('/compact')} [turns]     Compact older context (default keep ${DEFAULT_COMPACT_TURNS} turns)\n` +
            `  ${fmt.bold('/checkpoint')}           Snapshot/rollback (create | list | load | delete)\n` +
            `  ${fmt.bold('/<skill>')} [args]      Run a skill (e.g. /commit, /review src/app.ts)\n` +
            `  ${fmt.dim('@path[:line[-end]]')}     Preload file refs into context (e.g. @src/app.ts:10-40)\n` +
            `  ${fmt.bold('/session')}             Print session id\n` +
            `  ${fmt.bold('/session')} rename <name>  Rename current session (${fmt.dim('--clear')} to unset)\n` +
            `  ${fmt.bold('/exit')} | ${fmt.bold('/quit')}        Exit\n`,
        );
        continue;
      }
      if (line === '/new') {
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

      // /skills — list loaded skills
      if (line === '/skills' || line.startsWith('/skills ')) {
        const arg = line.slice('/skills'.length).trim();
        if (!arg) {
          if (skills.size === 0) {
            process.stdout.write('No skills loaded.\n');
          } else {
            for (const [name, skill] of skills) {
              const tag =
                skill.source === 'workspace'
                  ? fmt.dim(' (workspace)')
                  : skill.source === 'claude'
                    ? fmt.dim(' (claude)')
                    : '';
              process.stdout.write(`  ${fmt.bold('/' + name)}  ${skill.description}${tag}\n`);
            }
          }
          continue;
        }
        if (arg === 'reload') {
          const count = await reloadSkillsMap();
          process.stdout.write(`Reloaded skills: ${count}\n`);
          continue;
        }
        process.stdout.write('Usage: /skills | /skills reload\n');
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
            const result = await runAssistantLoop(
              state,
              ctx.providerConfig,
              ctx.apiKey,
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
        const result = await runAssistantLoop(state, ctx.providerConfig, ctx.apiKey, maxRounds, {
          approvalFn,
          askUserFn,
          signal: ac.signal,
          emit: onEvent,
          safeExecPatterns,
          execMode,
          disabledTools,
          alwaysAllow,
        });
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
  const metrics = getToolCallMetrics();
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

async function initSession(sessionId, provider, model, cwd) {
  if (sessionId) {
    try {
      const resumed = await loadSessionState(sessionId);
      // Seed validation commands on resumed sessions too — covers users who
      // upgrade the CLI after starting a session that pre-dates the field.
      // ensureRepoCommandsSeeded is defensive about a missing workingMemory.
      ensureRepoCommandsSeeded(resumed);
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

  const providerConfig = PROVIDER_CONFIGS[provider];
  const newSessionId = makeSessionId();
  const now = Date.now();
  const state = {
    sessionId: newSessionId,
    createdAt: now,
    updatedAt: now,
    provider,
    model,
    cwd,
    rounds: 0,
    eventSeq: 0,
    workingMemory: {
      plan: '',
      openTasks: [],
      filesTouched: [],
      assumptions: [],
      errorsEncountered: [],
      currentPhase: '',
      completedPhases: [],
    },
    messages: [{ role: 'system', content: buildSystemPromptBase(cwd) }],
  };
  // Start enriching the system prompt in the background — will be
  // awaited before the first LLM call in runAssistantLoop.
  ensureSystemPromptReady(state);
  // Seed repo validation commands (test/lint/typecheck/...) into working
  // memory in the background. Best-effort: failures don't block the session.
  ensureRepoCommandsSeeded(state);
  // Disk writes are deferred to first user message (lazy session creation).
  // The caller is responsible for calling appendSessionEvent('session_started') + saveSessionState
  // before the first user_message event.
  return state;
}

const DEPRECATED_PROVIDERS = {
  mistral: 'openrouter',
  zai: 'openrouter',
  google: 'openrouter',
  minimax: 'openrouter',
};

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
  return {
    provider: config.provider || null,
    localSandbox: config.localSandbox ?? null,
    tavilyApiKey: config.tavilyApiKey ? maskSecret(config.tavilyApiKey) : null,
    webSearchBackend: config.webSearchBackend || null,
    safeExecPatterns: Array.isArray(config.safeExecPatterns) ? config.safeExecPatterns : [],
    disabledTools: Array.isArray(config.disabledTools) ? config.disabledTools : [],
    alwaysAllow: Array.isArray(config.alwaysAllow) ? config.alwaysAllow : [],
    ollama: config.ollama ? redactProvider(config.ollama) : {},
    openrouter: config.openrouter ? redactProvider(config.openrouter) : {},
    zen: config.zen ? redactProvider(config.zen) : {},
    nvidia: config.nvidia ? redactProvider(config.nvidia) : {},
  };
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

async function runConfigSubcommand(values, positionals) {
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

  if (action === 'init') {
    return runConfigInit(values, config);
  }

  if (action !== 'set') {
    throw new Error(
      `Unknown config action: ${action}. Use: push config show | push config init | push config set ...`,
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
      'No config changes provided. Use one or more of: --provider, --model, --url, --api-key, --tavily-key, --search-backend, --sandbox, --no-sandbox, --exec-mode',
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
  const { THEME_NAMES, VARIANTS, isThemeName, renderThemePreview } = await import('./tui-theme.js');
  const config = await loadConfig();
  const current = isThemeName(config.theme) ? config.theme : 'default';
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

async function runAnimateSubcommand(positionals) {
  const { ANIMATION_EFFECTS, ANIMATION_DESCRIPTIONS, isAnimationEffect, isReducedMotion } =
    await import('./tui-animator.js');
  const config = await loadConfig();
  const action = (positionals[1] || 'show').toLowerCase();

  // `isAnimationEffect` rather than `typeof === 'string'` so an invalid
  // saved value (from hand-edited config) reports as unpinned rather than
  // masquerading as a pin the runtime would then ignore.
  const pinnedEffect = isAnimationEffect(config.animation) ? config.animation : null;

  if (action === 'show') {
    const shown = pinnedEffect ?? 'follow-theme';
    const suffix = isReducedMotion() ? ' (reduced-motion active — forced off)' : '';
    process.stdout.write(`${shown}${suffix}\n`);
    return 0;
  }

  if (action === 'list') {
    for (const name of ANIMATION_EFFECTS) {
      const marker = name === pinnedEffect ? '*' : ' ';
      process.stdout.write(
        `${marker} ${fmt.bold(name.padEnd(10))} ${fmt.dim(ANIMATION_DESCRIPTIONS[name])}\n`,
      );
    }
    const followMarker = pinnedEffect === null ? '*' : ' ';
    process.stdout.write(
      `${followMarker} ${fmt.bold('follow-theme')} ${fmt.dim('Unpin: use each theme’s default animation')}\n`,
    );
    return 0;
  }

  // `push animate <name>` and `push animate set <name>` both pin the effect.
  // `push animate follow-theme` / `push animate unpin` clear the pin.
  // Normalize case/whitespace so `push animate set RAINBOW` matches the
  // TUI's `/animate RAINBOW` behaviour.
  const rawValue = action === 'set' ? positionals[2] : action;
  const value = (rawValue || '').toLowerCase().trim();
  if (value === 'follow-theme' || value === 'unpin') {
    const next = { ...config };
    delete next.animation;
    const configPath = await saveConfig(next);
    process.stdout.write(`Saved: animation follows theme → ${fmt.dim(configPath)}\n`);
    return 0;
  }
  if (!value || !isAnimationEffect(value)) {
    throw new Error(
      `Unknown animation effect: ${value || '(missing)'}. Available: ${ANIMATION_EFFECTS.join(', ')}. Use 'follow-theme' to unpin.`,
    );
  }
  const next = { ...config, animation: value };
  const configPath = await saveConfig(next);
  process.stdout.write(`Saved animation: ${fmt.bold(value)} → ${fmt.dim(configPath)}\n`);
  return 0;
}

async function runSpinnerSubcommand(positionals) {
  const { SPINNER_NAMES, SPINNERS, isSpinnerName } = await import('./tui-spinner.js');
  const { isReducedMotion } = await import('./tui-animator.js');
  const config = await loadConfig();
  const action = (positionals[1] || 'show').toLowerCase();

  // `isSpinnerName` rather than `typeof === 'string'` so a stale or hand-
  // edited config with an unknown spinner cleanly reports as unpinned
  // instead of pretending to be pinned to something the TUI will ignore.
  const pinned = isSpinnerName(config.spinner) ? config.spinner : null;

  if (action === 'show') {
    const shown = pinned ?? 'off';
    const suffix = isReducedMotion() ? ' (reduced-motion active — forced off)' : '';
    process.stdout.write(`${shown}${suffix}\n`);
    return 0;
  }

  if (action === 'list') {
    for (const name of SPINNER_NAMES) {
      const marker = name === pinned ? '*' : ' ';
      const preview = name === 'off' ? ' ' : (SPINNERS[name].frames[0] ?? ' ');
      process.stdout.write(
        `${marker} ${preview}  ${fmt.bold(name.padEnd(10))} ${fmt.dim(SPINNERS[name].description)}\n`,
      );
    }
    return 0;
  }

  // `push spinner <name>` and `push spinner set <name>` both pin.
  // `push spinner unpin` clears the pin.
  const rawValue = action === 'set' ? positionals[2] : action;
  const value = (rawValue || '').toLowerCase().trim();
  if (value === 'unpin') {
    const next = { ...config };
    delete next.spinner;
    const configPath = await saveConfig(next);
    process.stdout.write(`Saved: spinner unpinned → ${fmt.dim(configPath)}\n`);
    return 0;
  }
  if (!value || !isSpinnerName(value)) {
    throw new Error(
      `Unknown spinner: ${value || '(missing)'}. Available: ${SPINNER_NAMES.join(', ')}. Use 'unpin' to clear.`,
    );
  }
  // Reduced-motion is a hard guard: refuse to persist a non-'off' spinner
  // when PUSH_REDUCED_MOTION / REDUCED_MOTION is set, matching the TUI
  // path (`handleSpinnerCommand` in tui.ts). Saving 'off' is still allowed
  // — that's the intended behaviour under reduced-motion anyway.
  if (isReducedMotion() && value !== 'off') {
    throw new Error(
      "Spinner disabled: reduced-motion is set (PUSH_REDUCED_MOTION / REDUCED_MOTION). Unset it to save a non-'off' spinner.",
    );
  }
  const next = { ...config, spinner: value };
  const configPath = await saveConfig(next);
  process.stdout.write(`Saved spinner: ${fmt.bold(value)} → ${fmt.dim(configPath)}\n`);
  return 0;
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
    // Use fileURLToPath so percent-encoded chars (spaces, etc.) decode correctly
    // and Windows paths don't get a leading slash from URL.pathname.
    const currentExt = import.meta.url.match(/\.(m?[jt]s)$/)?.[1] ?? 'mjs';
    const pushdPath = fileURLToPath(new URL(`./pushd.${currentExt}`, import.meta.url));

    // When the parent is running under tsx (currentExt === 'ts'), the child
    // also needs the tsx loader — plain `node pushd.ts` dies with
    // "Unknown file extension .ts" at module-load time. Pass `--import tsx`
    // so the child registers the same ESM loader the parent is using. This
    // mirrors `dev:cli` in package.json.
    const nodeArgs = currentExt === 'ts' ? ['--import', 'tsx', pushdPath] : [pushdPath];

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

  throw new Error(
    `Unknown daemon action: ${action}. Use: push daemon start|stop|restart|status [--deep] | pair [--origin <url>] | revoke <tokenId> | tokens | allow <path> | deny <path> | allowlist | devices | attach-tokens | revoke-attach <tokenId> | audit [--tail N] [--since DATE] [--type TYPE] [--json]`,
  );
}

async function runDaemonPair(values: Record<string, unknown>): Promise<number> {
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
    `Paste this token in the Push web app's "Pair Local PC" flow. Revoke with:\n`,
  );
  process.stdout.write(`  push daemon revoke ${tokenId}\n`);
  return 0;
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
    process.stdout.write('no device tokens (pair with: push daemon pair [--origin <url>])\n');
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
    const who = e.deviceId ? `device=${e.deviceId}` : 'device=-';
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
 * Behavior contract (see ROADMAP.md "`pushd` Attach + Event Stream UX"):
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
  // event that tripped the renderer.
  const observingHandler = (event) => {
    if (typeof event.seq === 'number' && event.seq > lastSeenSeq) {
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
      headless: { type: 'boolean', default: false },
      'allow-exec': { type: 'boolean' },
      allowExec: { type: 'boolean' },
      mode: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      sandbox: { type: 'boolean' },
      'exec-mode': { type: 'string' },
      'no-sandbox': { type: 'boolean' },
      'no-resume': { type: 'boolean' },
      'no-attach': { type: 'boolean' },
      'no-resume-prompt': { type: 'boolean' },
      delegate: { type: 'boolean', default: false },
      version: { type: 'boolean', short: 'v' },
      deep: { type: 'boolean' },
      origin: { type: 'string' },
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

  if (values.help) {
    printHelp();
    return 0;
  }

  // Apply persisted defaults before resolving runtime config; shell env still wins.
  const persistedConfig = await loadConfig();
  applyConfigToEnv(persistedConfig);

  // Resolve final localSandbox state: flags > env > config
  if (values.sandbox && values['no-sandbox']) {
    throw new Error('Conflicting flags: --sandbox and --no-sandbox cannot both be set.');
  }
  const envSandbox =
    process.env.PUSH_LOCAL_SANDBOX === 'true'
      ? true
      : process.env.PUSH_LOCAL_SANDBOX === 'false'
        ? false
        : undefined;
  const flagSandbox = values.sandbox ? true : values['no-sandbox'] ? false : undefined;
  const localSandbox = flagSandbox ?? envSandbox ?? persistedConfig.localSandbox;
  if (localSandbox !== undefined) {
    process.env.PUSH_LOCAL_SANDBOX = String(localSandbox);
  }

  const searchBackendArg = getSearchBackendArg(values);
  if (searchBackendArg) {
    process.env.PUSH_WEB_SEARCH_BACKEND = parseSearchBackend(searchBackendArg);
  }

  // --mode flag wins over config (config was already applied to env via applyConfigToEnv)
  const VALID_EXEC_MODES = new Set(['strict', 'auto', 'yolo']);
  if (values.mode) {
    if (!VALID_EXEC_MODES.has(values.mode)) {
      throw new Error(`Invalid --mode "${values.mode}". Valid values: strict, auto, yolo`);
    }
    process.env.PUSH_EXEC_MODE = values.mode;
  }

  const subcommand = positionals[0] || '';
  const tuiEnabled =
    process.env.PUSH_TUI_ENABLED === '1' || process.env.PUSH_TUI_ENABLED === 'true';
  if (subcommand === 'config') {
    return runConfigSubcommand(values, positionals);
  }

  if (subcommand === 'theme') {
    return runThemeSubcommand(positionals);
  }

  if (subcommand === 'animate') {
    return runAnimateSubcommand(positionals);
  }

  if (subcommand === 'spinner') {
    return runSpinnerSubcommand(positionals);
  }

  if (subcommand === 'resume' || subcommand === 'sessions') {
    const sessionsCmd = positionals[1] || '';
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
      throw new Error(`Unknown resume subcommand: ${sessionsCmd}. Supported: rename`);
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
    const skills = await loadSkills(cwd);
    if (values.json) {
      const arr = [...skills.values()].map(({ name, description, source, filePath }) => ({
        name,
        description,
        source,
        filePath,
      }));
      process.stdout.write(`${JSON.stringify(arr, null, 2)}\n`);
      return 0;
    }
    if (skills.size === 0) {
      process.stdout.write('No skills found.\n');
      return 0;
    }
    for (const [name, skill] of skills) {
      const tag =
        skill.source === 'workspace'
          ? fmt.dim(' (workspace)')
          : skill.source === 'claude'
            ? fmt.dim(' (claude)')
            : '';
      process.stdout.write(`  ${fmt.bold('/' + name)}  ${skill.description}${tag}\n`);
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
      throw new Error('TUI is behind a feature flag. Set PUSH_TUI_ENABLED=1 to enable it.');
    }
    if (!process.stdin.isTTY) {
      throw new Error('TUI requires a TTY terminal.');
    }
    const { runTUI } = await import('./tui.js');
    return runTUI({
      sessionId: values.session,
      provider: values.provider,
      model: values.model,
      cwd: values.cwd ? path.resolve(values.cwd) : undefined,
      maxRounds:
        values['max-rounds'] || values.maxRounds
          ? clamp(Number(values['max-rounds'] || values.maxRounds || DEFAULT_MAX_ROUNDS), 1, 30)
          : undefined,
    });
  }

  if (!KNOWN_SUBCOMMANDS.has(subcommand)) {
    throw new Error(
      `Unknown command: ${subcommand}. Known commands: run, config, sessions, skills, stats, daemon, attach, tui, theme, animate, spinner, init-deep. See: push --help`,
    );
  }

  const provider = parseProvider(values.provider, persistedConfig.provider);
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
        `Invalid --max-rounds value: "${maxRoundsRaw}". Must be a number between 1 and 30.`,
      );
    }
  }
  const maxRounds = clamp(Number(maxRoundsRaw || DEFAULT_MAX_ROUNDS), 1, 30);
  const acceptanceChecks = Array.isArray(values.accept) ? values.accept : [];

  const positionalTask = subcommand === 'run' ? positionals.slice(1).join(' ').trim() : '';
  let task = (values.task || positionalTask).trim();
  const runHeadlessMode = values.headless || subcommand === 'run';

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

  const state = await initSession(resumedSessionId, provider, requestedModel, cwd);
  if (values.model && values.model !== state.model) state.model = values.model;
  if (values.provider && values.provider !== state.provider) {
    state.provider = provider;
    state.model = requestedModel;
  }
  if (values.cwd && path.resolve(values.cwd) !== state.cwd) {
    state.cwd = path.resolve(values.cwd);
  }
  await saveSessionState(state);

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
    const headlessSafePatterns = Array.isArray(persistedConfig.safeExecPatterns)
      ? persistedConfig.safeExecPatterns
      : [];
    // Same env-fallback contract as the REPL path: undefined -> env wins,
    // explicit array -> opt-out.
    const headlessDisabledTools = Array.isArray(persistedConfig.disabledTools)
      ? persistedConfig.disabledTools
      : undefined;
    const headlessAlwaysAllow = Array.isArray(persistedConfig.alwaysAllow)
      ? persistedConfig.alwaysAllow
      : undefined;
    const headlessExecMode = process.env.PUSH_EXEC_MODE || 'auto';
    const headlessRunOpts = {
      allowExec,
      safeExecPatterns: headlessSafePatterns,
      execMode: headlessExecMode,
      disabledTools: headlessDisabledTools,
      alwaysAllow: headlessAlwaysAllow,
    };
    if (values.delegate) {
      const { runDelegatedHeadless } = await import('./delegation-entry.js');
      return runDelegatedHeadless(
        state,
        providerConfig,
        apiKey,
        task,
        maxRounds,
        values.json,
        acceptanceChecks,
        headlessRunOpts,
      );
    }
    return runHeadless(
      state,
      providerConfig,
      apiKey,
      task,
      maxRounds,
      values.json,
      acceptanceChecks,
      headlessRunOpts,
    );
  }

  // Default UX: bare "push" opens TUI when enabled.
  if (subcommand === '' && tuiEnabled) {
    if (!process.stdin.isTTY) {
      throw new Error('TUI requires a TTY terminal.');
    }
    const { runTUI } = await import('./tui.js');
    return runTUI({
      sessionId: state.sessionId,
      maxRounds,
    });
  }

  if (!process.stdin.isTTY) {
    throw new Error(
      'Interactive mode requires a TTY. For scripted use, run: push run --task "your task here"',
    );
  }

  const apiKey = resolveApiKey(providerConfig);
  return runInteractive(state, providerConfig, apiKey, maxRounds, {
    // Resumed sessions (either via --session or via the bare-push picker)
    // already have their state + session_started event on disk; without
    // this runInteractive would lazily re-emit session_started on the
    // first user message.
    alreadyPersisted: !!resumedSessionId,
  });
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
const isDirectRun =
  typeof process.argv[1] === 'string' && /[/\\]cli\.(ts|mjs|cjs|js)$/.test(process.argv[1]);

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
