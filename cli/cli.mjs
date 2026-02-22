#!/usr/bin/env node
import { parseArgs, promisify } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';

import { PROVIDER_CONFIGS, resolveApiKey, resolveNativeFC, getProviderList } from './provider.mjs';
import { getCuratedModels, DEFAULT_MODELS } from './model-catalog.mjs';
import { makeSessionId, saveSessionState, appendSessionEvent, loadSessionState, listSessions } from './session-store.mjs';
import { buildSystemPrompt, runAssistantLoop, DEFAULT_MAX_ROUNDS } from './engine.mjs';
import { loadConfig, saveConfig, applyConfigToEnv, getConfigPath, maskSecret } from './config-store.mjs';
import { aggregateStats, formatStats } from './stats.mjs';
import { getToolCallMetrics } from './tool-call-metrics.mjs';
import { getSocketPath, getPidPath } from './pushd.mjs';
import { loadSkills, interpolateSkill } from './skill-loader.mjs';
import { createCompleter } from './completer.mjs';
import { fmt, Spinner } from './format.mjs';

const execFileAsync = promisify(execFile);

const VERSION = '0.1.0';

const KNOWN_OPTIONS = new Set([
  'provider', 'model', 'url', 'api-key', 'apiKey', 'cwd', 'session',
  'tavily-key', 'tavilyKey', 'search-backend', 'searchBackend',
  'task', 'accept', 'max-rounds', 'maxRounds', 'json', 'headless',
  'allow-exec', 'allowExec', 'skill',
  'help', 'sandbox', 'no-sandbox', 'version',
]);

const KNOWN_SUBCOMMANDS = new Set(['', 'run', 'config', 'sessions', 'skills', 'stats', 'daemon', 'attach', 'tui']);
const SEARCH_BACKENDS = new Set(['auto', 'tavily', 'ollama', 'duckduckgo']);

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function truncateText(text, maxLength = 100) {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '...';
}

function printHelp() {
  process.stdout.write(
    `Push CLI (bootstrap)

Usage:
  push                          Start TUI when enabled, otherwise interactive session
  push --session <id>           Resume session (TUI when enabled, otherwise interactive)
  push run --task "..."         Run once in headless mode
  push run "..."                Run once in headless mode
  push sessions                 List saved sessions
  push skills                   List available skills
  push stats                    Show provider compliance stats
  push daemon start             Start background daemon
  push daemon stop              Stop background daemon
  push daemon status            Check daemon status
  push tui                       Start full-screen TUI
  push tui --session <id>        Resume session in TUI
  push attach <session-id>      Attach to a running daemon session
  push config show              Show saved CLI config
  push config init              Interactive setup wizard
  push config set ...           Save provider config defaults

Options:
  --provider <name>             ollama | mistral | openrouter | zai | google | zen (default: ollama)
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
  --json                        JSON output in headless mode / sessions
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
      const { stdout, stderr } = await execFileAsync('/bin/bash', ['-lc', command], {
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

function makeCLIEventHandler() {
  let isThinking = false;
  const spinner = new Spinner();

  return (event) => {
    switch (event.type) {
      case 'tool_call':
        if (isThinking) {
          process.stdout.write('\n');
          isThinking = false;
        }
        spinner.stop();
        process.stdout.write(`${fmt.dim('[tool]')} ${event.payload.toolName}\n`);
        spinner.start(event.payload.toolName);
        break;
      case 'tool_result': {
        spinner.stop();
        const ok = !event.payload.isError;
        const text = truncateText(event.payload.text, 420);
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
        if (!isThinking) {
          process.stdout.write(`\n${fmt.bold(fmt.cyan('assistant>'))} `);
          isThinking = true;
        }
        process.stdout.write(event.payload.text);
        break;
      case 'assistant_done':
        if (isThinking) {
          process.stdout.write('\n');
          isThinking = false;
        }
        break;
      case 'warning':
        spinner.stop();
        process.stdout.write(`\n${fmt.warn('[warning]')} ${event.payload.message || event.payload.code}\n`);
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

async function runHeadless(state, providerConfig, apiKey, task, maxRounds, jsonOutput, acceptanceChecks, { allowExec = false } = {}) {
  state.messages.push({ role: 'user', content: task });
  await appendSessionEvent(state, 'user_message', { chars: task.length, preview: task.slice(0, 280) });

  const ac = new AbortController();
  const onSigint = () => ac.abort();
  process.on('SIGINT', onSigint);

  try {
    // Headless run is silent during execution unless we want to wire up a log listener later
    const result = await runAssistantLoop(state, providerConfig, apiKey, maxRounds, {
      signal: ac.signal,
      emit: null,
      allowExec,
    });
    await saveSessionState(state);

    // Non-throw abort path (engine returned outcome: 'aborted' without throwing)
    if (result.outcome === 'aborted') {
      if (jsonOutput) {
        process.stdout.write(`${JSON.stringify({ sessionId: state.sessionId, runId: result.runId || null, outcome: 'aborted' }, null, 2)}\n`);
      } else {
        process.stderr.write(`${fmt.yellow('[aborted]')}\n`);
      }
      return 130;
    }

    let acceptance = null;

    if (Array.isArray(acceptanceChecks) && acceptanceChecks.length > 0) {
      acceptance = await runAcceptanceChecks(state.cwd, acceptanceChecks);
      await appendSessionEvent(state, 'acceptance_complete', {
        passed: acceptance.passed,
        checks: acceptance.checks.map((check) => ({
          command: check.command,
          ok: check.ok,
          exitCode: check.exitCode,
          durationMs: check.durationMs,
        })),
      }, result.runId || null);
      await saveSessionState(state);
    }

    const success = result.outcome === 'success' && (!acceptance || acceptance.passed);

    if (jsonOutput) {
      process.stdout.write(`${JSON.stringify({
        sessionId: state.sessionId,
        runId: result.runId || null,
        outcome: success ? 'success' : acceptance && !acceptance.passed ? 'acceptance_failed' : result.outcome,
        rounds: result.rounds,
        assistant: result.finalAssistantText,
        acceptance,
      }, null, 2)}\n`);
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
        process.stdout.write(`${JSON.stringify({ sessionId: state.sessionId, outcome: 'aborted' }, null, 2)}\n`);
      } else {
        process.stderr.write(`${fmt.yellow('[aborted]')}\n`);
      }
      return 130;
    }

    const message = err instanceof Error ? err.message : String(err);
    await appendSessionEvent(state, 'error', { message });
    await saveSessionState(state);

    if (jsonOutput) {
      process.stdout.write(`${JSON.stringify({ sessionId: state.sessionId, outcome: 'error', error: message }, null, 2)}\n`);
    } else {
      process.stderr.write(`${fmt.error('Error:')} ${message}\n`);
    }
    return 1;
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}

function makeInteractiveApprovalFn(rl) {
  return async (tool, detail) => {
    process.stdout.write(`\n${fmt.yellow('[!]')} ${fmt.warn('High-risk operation detected:')}\n    ${tool}: ${detail}\n`);
    const answer = await rl.question('    Allow? (y/N) ');
    return answer.trim().toLowerCase() === 'y';
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
    target = (num >= 1 && num <= models.length) ? models[num - 1] : arg;
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
  await appendSessionEvent(state, 'model_switched', { model: target, provider: ctx.providerConfig.id });
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
      const fc = p.supportsNativeFC ? 'native FC' : 'prompt FC';
      process.stdout.write(`  ${i + 1}. ${p.id}  [${keyStatus}] [${fc}] default: ${p.defaultModel}${current}\n`);
    }
    process.stdout.write('Use /provider <name|#> to switch.\n');
    return;
  }

  // Resolve by number (digits only) or name
  let target;
  if (/^\d+$/.test(arg)) {
    const num = parseInt(arg, 10);
    target = (num >= 1 && num <= providers.length) ? providers[num - 1] : null;
  } else {
    target = providers.find((p) => p.id === arg.toLowerCase());
  }

  if (!target) {
    process.stdout.write(`Unknown provider: ${arg}. Use: ollama, mistral, openrouter, zai, google, zen\n`);
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
    process.stdout.write(`Cannot switch to ${target.id}: no API key found.\nSet one of: ${newConfig.apiKeyEnv.join(', ')}\n`);
    return;
  }

  const oldFC = resolveNativeFC(ctx.providerConfig);
  const newFC = resolveNativeFC(newConfig);

  // Update mutable context
  ctx.providerConfig = newConfig;
  ctx.apiKey = newApiKey;
  state.provider = target.id;
  state.model = config[target.id]?.model || newConfig.defaultModel;

  // Rebuild system prompt if FC mode changed
  if (oldFC !== newFC) {
    state.messages[0] = { role: 'system', content: await buildSystemPrompt(state.cwd, { useNativeFC: newFC }) };
    process.stdout.write(`[system prompt rebuilt — nativeFC: ${oldFC} → ${newFC}]\n`);
  }

  // Persist
  config.provider = target.id;
  await saveConfig(config);
  await appendSessionEvent(state, 'provider_switched', { provider: target.id, model: state.model, nativeFC: newFC });
  process.stdout.write(`Switched to ${target.id} | model: ${state.model}\n`);
}

async function runInteractive(state, providerConfig, apiKey, maxRounds) {
  // Mutable context — allows mid-session provider/model switching
  const ctx = { providerConfig, apiKey };
  const config = await loadConfig();
  const skills = await loadSkills(state.cwd);

  const completer = createCompleter({ ctx, skills, getCuratedModels, getProviderList });
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    completer,
  });

  const approvalFn = makeInteractiveApprovalFn(rl);
  const onEvent = makeCLIEventHandler();

  const nativeFC = resolveNativeFC(ctx.providerConfig);
  process.stdout.write(
    `${fmt.bold('Push CLI')}\n` +
    `${fmt.dim('session:')} ${state.sessionId}\n` +
    `${fmt.dim('provider:')} ${ctx.providerConfig.id} ${fmt.dim('|')} ${fmt.dim('model:')} ${state.model}\n` +
    `${fmt.dim('endpoint:')} ${ctx.providerConfig.url}\n` +
    `${fmt.dim('workspace:')} ${state.cwd}\n` +
    `${fmt.dim('localSandbox:')} ${process.env.PUSH_LOCAL_SANDBOX === 'true'}\n` +
    `${fmt.dim('nativeFC:')} ${nativeFC}\n` +
    `${fmt.dim('Type /help for commands.')}\n`,
  );

  try {
    while (true) {
      const line = (await rl.question('\n> ')).trim();
      if (!line) continue;

      if (line === '/exit' || line === '/quit') break;
      if (line === '/help') {
        process.stdout.write(
          `Commands:\n` +
          `  ${fmt.bold('/model')}               Show current model + available models\n` +
          `  ${fmt.bold('/model')} <name|#>      Switch model\n` +
          `  ${fmt.bold('/provider')}            Show all providers with status\n` +
          `  ${fmt.bold('/provider')} <name|#>   Switch provider\n` +
          `  ${fmt.bold('/skills')}              List available skills\n` +
          `  ${fmt.bold('/<skill>')} [args]      Run a skill (e.g. /commit, /review src/app.ts)\n` +
          `  ${fmt.bold('/session')}             Print session id\n` +
          `  ${fmt.bold('/exit')} | ${fmt.bold('/quit')}        Exit\n`,
        );
        continue;
      }
      if (line === '/session') {
        process.stdout.write(`session: ${state.sessionId}\n`);
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
      if (line === '/skills') {
        if (skills.size === 0) {
          process.stdout.write('No skills loaded.\n');
        } else {
          for (const [name, skill] of skills) {
            const tag = skill.source === 'workspace' ? fmt.dim(' (workspace)') : '';
            process.stdout.write(`  ${fmt.bold('/' + name)}  ${skill.description}${tag}\n`);
          }
        }
        continue;
      }

      // /<name> [args] — skill dispatch
      if (line.startsWith('/')) {
        const spaceIdx = line.indexOf(' ');
        const cmdName = (spaceIdx === -1 ? line.slice(1) : line.slice(1, spaceIdx));
        const skill = skills.get(cmdName);
        if (skill) {
          const args = spaceIdx === -1 ? '' : line.slice(spaceIdx + 1).trim();
          const prompt = interpolateSkill(skill.promptTemplate, args);
          state.messages.push({ role: 'user', content: prompt });
          await appendSessionEvent(state, 'user_message', { chars: prompt.length, preview: prompt.slice(0, 280), skill: cmdName });

          const ac = new AbortController();
          const onSigint = () => ac.abort();
          process.on('SIGINT', onSigint);

          try {
            const result = await runAssistantLoop(state, ctx.providerConfig, ctx.apiKey, maxRounds, {
              approvalFn,
              signal: ac.signal,
              emit: onEvent,
            });
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
            process.removeListener('SIGINT', onSigint);
          }
          continue;
        }

        // Unknown /command — hint
        process.stdout.write(fmt.warn(`Unknown command: ${line.split(' ')[0]}. Type /help for commands or /skills for skills.`) + '\n');
        continue;
      }

      state.messages.push({ role: 'user', content: line });
      await appendSessionEvent(state, 'user_message', { chars: line.length, preview: line.slice(0, 280) });

      const ac = new AbortController();
      const onSigint = () => ac.abort();
      process.on('SIGINT', onSigint);

      try {
        const result = await runAssistantLoop(state, ctx.providerConfig, ctx.apiKey, maxRounds, {
          approvalFn,
          signal: ac.signal,
          emit: onEvent,
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
        process.removeListener('SIGINT', onSigint);
      }
    }
  } finally {
    rl.close();
    await saveSessionState(state);
  }

  // End-of-session metrics summary
  const metrics = getToolCallMetrics();
  const malformedTotal = Object.values(metrics.malformed).reduce((a, b) => a + b, 0);
  if (malformedTotal > 0) {
    const reasons = Object.entries(metrics.malformed).map(([k, v]) => `${k}:${v}`).join(', ');
    process.stdout.write(`\n${fmt.dim('[stats]')} ${fmt.yellow(String(malformedTotal))} malformed tool call(s) this session: ${reasons}\n`);
  }

  return 0;
}

async function initSession(sessionId, provider, model, cwd) {
  if (sessionId) {
    try {
      return await loadSessionState(sessionId);
    } catch (err) {
      if (err.code === 'ENOENT' || (err.message && err.message.includes('ENOENT'))) {
        throw new Error(`Session not found: ${sessionId}. Use "push sessions" to list available sessions.`);
      }
      throw err;
    }
  }

  const providerConfig = PROVIDER_CONFIGS[provider];
  const useNativeFC = resolveNativeFC(providerConfig);

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
    },
    messages: [{ role: 'system', content: await buildSystemPrompt(cwd, { useNativeFC }) }],
  };
  await appendSessionEvent(state, 'session_started', {
    sessionId: newSessionId,
    state: 'idle',
    mode: 'interactive',
    provider,
    nativeFC: useNativeFC,
    sandboxProvider: process.env.PUSH_LOCAL_SANDBOX === 'true' ? 'local' : 'modal',
  });
  await saveSessionState(state);
  return state;
}

function parseProvider(raw) {
  const provider = (raw || process.env.PUSH_PROVIDER || 'ollama').toLowerCase();
  if (provider === 'ollama' || provider === 'mistral' || provider === 'openrouter' || provider === 'zai' || provider === 'google' || provider === 'zen') return provider;
  throw new Error(`Unsupported provider: ${raw}`);
}

function parseSearchBackend(raw, fallback = 'auto') {
  const value = String(raw || '').trim().toLowerCase();
  if (!value) return fallback;
  if (SEARCH_BACKENDS.has(value)) return value;
  throw new Error(`Unsupported --search-backend value: ${raw}. Expected one of: auto, tavily, ollama, duckduckgo`);
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
    ollama: config.ollama ? redactProvider(config.ollama) : {},
    mistral: config.mistral ? redactProvider(config.mistral) : {},
    openrouter: config.openrouter ? redactProvider(config.openrouter) : {},
    zai: config.zai ? redactProvider(config.zai) : {},
    google: config.google ? redactProvider(config.google) : {},
    zen: config.zen ? redactProvider(config.zen) : {},
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
    const current = config[provider] && typeof config[provider] === 'object' ? config[provider] : {};

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
          model = (num >= 1 && num <= models.length) ? models[num - 1] : modelInput;
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
      const input = await rl.question(`Web search backend [${currentBackend}] (auto|tavily|ollama|duckduckgo): `);
      const trimmed = input.trim();
      webSearchBackend = trimmed ? parseSearchBackend(trimmed) : currentBackend;
    }

    // --- Local sandbox ---
    const localSandboxDefault = config.localSandbox ?? true;
    const localSandboxInput = await rl.question(`Local Docker sandbox (y/n) [${localSandboxDefault ? 'y' : 'n'}]: `);
    const localSandbox = localSandboxInput ? localSandboxInput.toLowerCase() === 'y' : localSandboxDefault;

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
      `${fmt.dim('└────────────────────────────────')}\n`
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
    process.stdout.write(`${JSON.stringify({
      path: getConfigPath(),
      config: sanitizeConfig(config),
    }, null, 2)}\n`);
    return 0;
  }

  if (action === 'init') {
    return runConfigInit(values, config);
  }

  if (action !== 'set') {
    throw new Error(`Unknown config action: ${action}. Use: push config show | push config init | push config set ...`);
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

  next[provider] = branch;

  if (!changed) {
    throw new Error('No config changes provided. Use one or more of: --provider, --model, --url, --api-key, --tavily-key, --search-backend, --sandbox, --no-sandbox');
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
    `${fmt.dim('localSandbox:')} ${next.localSandbox ?? '(unchanged)'}\n`
  );
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

async function runDaemonSubcommand(positionals) {
  const action = (positionals[1] || 'status').toLowerCase();

  if (action === 'status') {
    const pid = await readPidFile();
    const socketPath = getSocketPath();
    if (pid && isProcessRunning(pid)) {
      process.stdout.write(`pushd is running (pid: ${pid})\nsocket: ${socketPath}\n`);
    } else {
      process.stdout.write('pushd is not running\n');
      if (pid) {
        // Stale PID file
        try { await fs.unlink(getPidPath()); } catch { /* ignore */ }
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

    // Launch pushd as a detached child process
    const { spawn } = await import('node:child_process');
    const pushdPath = new URL('./pushd.mjs', import.meta.url).pathname;
    const child = spawn(process.execPath, [pushdPath], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    });
    child.unref();
    process.stdout.write(`pushd started (pid: ${child.pid})\nsocket: ${getSocketPath()}\n`);
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

  throw new Error(`Unknown daemon action: ${action}. Use: push daemon start|stop|status`);
}

async function runAttach(sessionId) {
  const pid = await readPidFile();
  if (!pid || !isProcessRunning(pid)) {
    throw new Error('pushd is not running. Start it with: push daemon start');
  }

  const socketPath = getSocketPath();
  const net = await import('node:net');
  const { PROTOCOL_VERSION } = await import('./session-store.mjs');

  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath, () => {
      // Send attach request
      const req = {
        v: PROTOCOL_VERSION,
        kind: 'request',
        requestId: `req_${Date.now().toString(36)}`,
        type: 'attach_session',
        payload: { sessionId, lastSeenSeq: 0 },
      };
      socket.write(JSON.stringify(req) + '\n');
    });

    let buffer = '';
    const onEvent = makeCLIEventHandler();
    let attached = false;

    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);

          if (msg.kind === 'response' && msg.type === 'attach_session') {
            if (!msg.ok) {
              process.stderr.write(`${fmt.error('Attach failed:')} ${msg.error?.message || 'unknown error'}\n`);
              socket.end();
              resolve(1);
              return;
            }
            attached = true;
            process.stdout.write(
              `Attached to ${sessionId}\n` +
              `Replay: seq ${msg.payload.replay.fromSeq}–${msg.payload.replay.toSeq}\n`,
            );
          } else if (msg.kind === 'event') {
            onEvent(msg);
          }
        } catch {
          // ignore parse errors
        }
      }
    });

    socket.on('end', () => {
      process.stdout.write('\n[disconnected]\n');
      resolve(attached ? 0 : 1);
    });

    socket.on('error', (err) => {
      process.stderr.write(`${fmt.error('Connection error:')} ${err.message}\n`);
      resolve(1);
    });

    // Allow Ctrl+C to detach
    process.on('SIGINT', () => {
      process.stdout.write('\n[detached]\n');
      socket.end();
      resolve(0);
    });
  });
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
      help: { type: 'boolean', short: 'h' },
      sandbox: { type: 'boolean' },
      'no-sandbox': { type: 'boolean' },
      version: { type: 'boolean', short: 'v' },
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
  const envSandbox = process.env.PUSH_LOCAL_SANDBOX === 'true' ? true : process.env.PUSH_LOCAL_SANDBOX === 'false' ? false : undefined;
  const flagSandbox = values.sandbox ? true : values['no-sandbox'] ? false : undefined;
  const localSandbox = flagSandbox ?? envSandbox ?? persistedConfig.localSandbox;
  if (localSandbox !== undefined) {
    process.env.PUSH_LOCAL_SANDBOX = String(localSandbox);
  }

  const searchBackendArg = getSearchBackendArg(values);
  if (searchBackendArg) {
    process.env.PUSH_WEB_SEARCH_BACKEND = parseSearchBackend(searchBackendArg);
  }

  const subcommand = positionals[0] || '';
  const tuiEnabled = process.env.PUSH_TUI_ENABLED === '1' || process.env.PUSH_TUI_ENABLED === 'true';
  if (subcommand === 'config') {
    return runConfigSubcommand(values, positionals);
  }

  if (subcommand === 'sessions') {
    const sessions = await listSessions();
    if (values.json) {
      process.stdout.write(`${JSON.stringify(sessions, null, 2)}\n`);
      return 0;
    }
    if (sessions.length === 0) {
      process.stdout.write('No sessions found.\n');
      return 0;
    }
    for (const row of sessions) {
      process.stdout.write(
        `${row.sessionId}  ${new Date(row.updatedAt).toISOString()}  ${row.provider}/${row.model}  ${row.cwd}\n`,
      );
    }
    return 0;
  }

  if (subcommand === 'skills') {
    const cwd = path.resolve(values.cwd || process.cwd());
    const skills = await loadSkills(cwd);
    if (values.json) {
      const arr = [...skills.values()].map(({ name, description, source, filePath }) => ({ name, description, source, filePath }));
      process.stdout.write(`${JSON.stringify(arr, null, 2)}\n`);
      return 0;
    }
    if (skills.size === 0) {
      process.stdout.write('No skills found.\n');
      return 0;
    }
    for (const [name, skill] of skills) {
      const tag = skill.source === 'workspace' ? fmt.dim(' (workspace)') : '';
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
    return runDaemonSubcommand(positionals);
  }

  if (subcommand === 'attach') {
    const sessionId = positionals[1];
    if (!sessionId) throw new Error('Usage: push attach <session-id>');
    return runAttach(sessionId);
  }

  if (subcommand === 'tui') {
    if (!tuiEnabled) {
      throw new Error('TUI is behind a feature flag. Set PUSH_TUI_ENABLED=1 to enable it.');
    }
    if (!process.stdin.isTTY) {
      throw new Error('TUI requires a TTY terminal.');
    }
    const { runTUI } = await import('./tui.mjs');
    return runTUI({
      sessionId: values.session,
      provider: values.provider,
      model: values.model,
      cwd: values.cwd ? path.resolve(values.cwd) : undefined,
      maxRounds: values['max-rounds'] || values.maxRounds
        ? clamp(Number(values['max-rounds'] || values.maxRounds || DEFAULT_MAX_ROUNDS), 1, 30)
        : undefined,
    });
  }

  if (!KNOWN_SUBCOMMANDS.has(subcommand)) {
    throw new Error(`Unknown command: ${subcommand}. Known commands: run, config, sessions, skills, stats, daemon, attach, tui. See: push --help`);
  }

  const provider = parseProvider(values.provider);
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
      throw new Error(`Invalid --max-rounds value: "${maxRoundsRaw}". Must be a number between 1 and 30.`);
    }
  }
  const maxRounds = clamp(Number(maxRoundsRaw || DEFAULT_MAX_ROUNDS), 1, 30);
  const acceptanceChecks = Array.isArray(values.accept) ? values.accept : [];

  const positionalTask = subcommand === 'run'
    ? positionals.slice(1).join(' ').trim()
    : '';
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
    task = interpolateSkill(skill.promptTemplate, task);
  }

  if (!runHeadlessMode) {
    const ignored = [];
    if (values.task) ignored.push('--task');
    if (values.skill) ignored.push('--skill');
    if (values.accept) ignored.push('--accept');
    if (values.json) ignored.push('--json');
    if (ignored.length > 0) {
      process.stderr.write(`${fmt.warn('Warning:')} ${ignored.join(', ')} ignored in interactive mode. Use: push run\n`);
    }
  }
  const requestedModel = values.model || providerConfig.defaultModel;

  const state = await initSession(values.session, provider, requestedModel, cwd);
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
      throw new Error('Headless mode requires a task. Use: push run --task "..." or push run --skill <name>');
    }
    // Resolve API key late — after all validation — so missing keys
    // don't mask argument or environment errors.
    const apiKey = resolveApiKey(providerConfig);
    const allowExec = values['allow-exec'] || values.allowExec || process.env.PUSH_ALLOW_EXEC === 'true';
    return runHeadless(state, providerConfig, apiKey, task, maxRounds, values.json, acceptanceChecks, { allowExec });
  }

  // Default UX: bare "push" opens TUI when enabled.
  if (subcommand === '' && tuiEnabled) {
    if (!process.stdin.isTTY) {
      throw new Error('TUI requires a TTY terminal.');
    }
    const { runTUI } = await import('./tui.mjs');
    return runTUI({
      sessionId: state.sessionId,
      maxRounds,
    });
  }

  if (!process.stdin.isTTY) {
    throw new Error('Interactive mode requires a TTY. For scripted use, run: push run --task "your task here"');
  }

  const apiKey = resolveApiKey(providerConfig);
  return runInteractive(state, providerConfig, apiKey, maxRounds);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${fmt.error('Error:')} ${message}\n`);
    process.exitCode = 1;
  });
