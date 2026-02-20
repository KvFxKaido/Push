#!/usr/bin/env node
import { parseArgs, promisify } from 'node:util';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';

import { PROVIDER_CONFIGS, resolveApiKey } from './provider.mjs';
import { makeSessionId, saveSessionState, appendSessionEvent, loadSessionState, listSessions } from './session-store.mjs';
import { buildSystemPrompt, runAssistantLoop, DEFAULT_MAX_ROUNDS } from './engine.mjs';
import { loadConfig, saveConfig, applyConfigToEnv, getConfigPath, maskSecret } from './config-store.mjs';

const execFileAsync = promisify(execFile);

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function printHelp() {
  process.stdout.write(
    `Push CLI (bootstrap)

Usage:
  push                          Start interactive session
  push --session <id>           Resume interactive session
  push run --task "..."         Run once in headless mode
  push run "..."                Run once in headless mode
  push sessions                 List saved sessions
  push config show              Show saved CLI config
  push config init              Interactive setup wizard
  push config set ...           Save provider config defaults

Options:
  --provider <name>             ollama | mistral | openrouter (default: ollama)
  --model <name>                Override model
  --url <endpoint>              Override provider endpoint URL
  --api-key <secret>            Set provider API key (for push config set/init)
  --cwd <path>                  Workspace root (default: current directory)
  --session <id>                Resume session id
  --task <text>                 Task text for headless mode
  --accept <cmd>                Acceptance check command (repeatable)
  --max-rounds <n>              Tool-loop cap per user prompt (default: 8)
  --json                        JSON output in headless mode / sessions
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

async function runHeadless(state, providerConfig, apiKey, task, maxRounds, jsonOutput, acceptanceChecks) {
  state.messages.push({ role: 'user', content: task });
  await appendSessionEvent(state, 'user_message', { chars: task.length, preview: task.slice(0, 280) });

  try {
    const result = await runAssistantLoop(state, providerConfig, apiKey, maxRounds, false);
    await saveSessionState(state);
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
        process.stdout.write(`\nAcceptance checks: ${acceptance.passed ? 'PASS' : 'FAIL'}\n`);
        for (const check of acceptance.checks) {
          process.stdout.write(`- [${check.ok ? 'ok' : 'fail'}] ${check.command} (exit ${check.exitCode})\n`);
        }
      }
    }

    return success ? 0 : 1;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await appendSessionEvent(state, 'error', { message });
    await saveSessionState(state);

    if (jsonOutput) {
      process.stdout.write(`${JSON.stringify({ sessionId: state.sessionId, outcome: 'error', error: message }, null, 2)}\n`);
    } else {
      process.stderr.write(`Error: ${message}\n`);
    }
    return 1;
  }
}

function makeInteractiveApprovalFn(rl) {
  return async (tool, detail) => {
    process.stdout.write(`\n[!] High-risk operation detected:\n    ${tool}: ${detail}\n`);
    const answer = await rl.question('    Allow? (y/N) ');
    return answer.trim().toLowerCase() === 'y';
  };
}

async function runInteractive(state, providerConfig, apiKey, maxRounds) {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  const approvalFn = makeInteractiveApprovalFn(rl);

  process.stdout.write(
    `Push CLI\n` +
    `session: ${state.sessionId}\n` +
    `provider: ${providerConfig.id} | model: ${state.model}\n` +
    `endpoint: ${providerConfig.url}\n` +
    `workspace: ${state.cwd}\n` +
    `Type /help for commands.\n`,
  );

  try {
    while (true) {
      const line = (await rl.question('\n> ')).trim();
      if (!line) continue;

      if (line === '/exit' || line === '/quit') break;
      if (line === '/help') {
        process.stdout.write(
          `Commands:
  /help                Show this help
  /provider            Show provider config
  /session             Print session id
  /exit | /quit        Exit
`,
        );
        continue;
      }
      if (line === '/provider') {
        process.stdout.write(
          `provider: ${providerConfig.id}\n` +
          `model: ${state.model}\n` +
          `endpoint: ${providerConfig.url}\n`,
        );
        continue;
      }
      if (line === '/session') {
        process.stdout.write(`session: ${state.sessionId}\n`);
        continue;
      }

      state.messages.push({ role: 'user', content: line });
      await appendSessionEvent(state, 'user_message', { chars: line.length, preview: line.slice(0, 280) });

      try {
        const result = await runAssistantLoop(state, providerConfig, apiKey, maxRounds, true, { approvalFn });
        await saveSessionState(state);
        if (result.outcome !== 'success') {
          process.stdout.write(`[warn] ${result.finalAssistantText}\n`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await appendSessionEvent(state, 'error', { message });
        await saveSessionState(state);
        process.stderr.write(`Error: ${message}\n`);
      }
    }
  } finally {
    rl.close();
    await saveSessionState(state);
  }

  return 0;
}

async function initSession(sessionId, provider, model, cwd) {
  if (sessionId) {
    return loadSessionState(sessionId);
  }

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
    messages: [{ role: 'system', content: buildSystemPrompt(cwd) }],
  };
  await appendSessionEvent(state, 'session_started', {
    sessionId: newSessionId,
    state: 'idle',
    mode: 'interactive',
    provider,
    sandboxProvider: 'local',
  });
  await saveSessionState(state);
  return state;
}

function parseProvider(raw) {
  const provider = (raw || process.env.PUSH_PROVIDER || 'ollama').toLowerCase();
  if (provider === 'ollama' || provider === 'mistral' || provider === 'openrouter') return provider;
  throw new Error(`Unsupported provider: ${raw}`);
}

function sanitizeConfig(config) {
  const redactProvider = (obj) => {
    const out = { ...obj };
    if (out.apiKey) out.apiKey = maskSecret(out.apiKey);
    return out;
  };
  return {
    provider: config.provider || null,
    ollama: config.ollama ? redactProvider(config.ollama) : {},
    mistral: config.mistral ? redactProvider(config.mistral) : {},
    openrouter: config.openrouter ? redactProvider(config.openrouter) : {},
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
    const providerDefault = parseProvider(values.provider || config.provider || 'ollama');

    let provider = providerDefault;
    if (!values.provider) {
      while (true) {
        const input = (await rl.question(`Provider (ollama/mistral/openrouter) [${providerDefault}]: `)).trim();
        const candidate = input || providerDefault;
        try {
          provider = parseProvider(candidate);
          break;
        } catch {
          process.stdout.write('Invalid provider. Choose: ollama, mistral, openrouter.\n');
        }
      }
    }

    const providerConfig = PROVIDER_CONFIGS[provider];
    const current = config[provider] && typeof config[provider] === 'object' ? config[provider] : {};

    const defaultModel = values.model || current.model || providerConfig.defaultModel;
    const defaultUrl = values.url || current.url || providerConfig.url;

    const modelInput = values.model
      ? values.model
      : (await rl.question(`Model [${defaultModel}]: `)).trim();
    const urlInput = values.url
      ? values.url
      : (await rl.question(`Endpoint URL [${defaultUrl}]: `)).trim();

    const model = modelInput || defaultModel;
    const url = urlInput || defaultUrl;

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

    const next = { ...config, provider };
    const branch = { ...(next[provider] || {}) };
    branch.model = model;
    branch.url = url;
    if (apiKey !== undefined) branch.apiKey = apiKey;
    next[provider] = branch;

    const configPath = await saveConfig(next);
    process.stdout.write(
      `\nSaved config to ${configPath}\n` +
      `provider: ${provider}\n` +
      `model: ${branch.model}\n` +
      `url: ${branch.url}\n` +
      `apiKey: ${branch.apiKey ? maskSecret(branch.apiKey) : '(not set)'}\n`,
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

  next[provider] = branch;

  if (!changed) {
    throw new Error('No config changes provided. Use one or more of: --provider, --model, --url, --api-key');
  }

  const configPath = await saveConfig(next);
  process.stdout.write(
    `Saved config to ${configPath}\n` +
    `provider: ${next.provider}\n` +
    `model: ${next[provider]?.model || '(unchanged)'}\n` +
    `url: ${next[provider]?.url || '(unchanged)'}\n` +
    `apiKey: ${next[provider]?.apiKey ? maskSecret(next[provider].apiKey) : '(unchanged)'}\n`,
  );
  return 0;
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
      cwd: { type: 'string' },
      session: { type: 'string' },
      task: { type: 'string' },
      accept: { type: 'string', multiple: true },
      'max-rounds': { type: 'string' },
      maxRounds: { type: 'string' },
      json: { type: 'boolean', default: false },
      headless: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) {
    printHelp();
    return 0;
  }

  // Apply persisted defaults before resolving runtime config; shell env still wins.
  const persistedConfig = await loadConfig();
  applyConfigToEnv(persistedConfig);

  const subcommand = positionals[0] || '';
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

  const provider = parseProvider(values.provider);
  const providerConfig = PROVIDER_CONFIGS[provider];
  const apiKey = resolveApiKey(providerConfig);
  const cwd = path.resolve(values.cwd || process.cwd());
  const maxRoundsRaw = values['max-rounds'] || values.maxRounds;
  const maxRounds = clamp(Number(maxRoundsRaw || DEFAULT_MAX_ROUNDS), 1, 30);
  const acceptanceChecks = Array.isArray(values.accept) ? values.accept : [];

  const positionalTask = subcommand === 'run'
    ? positionals.slice(1).join(' ').trim()
    : '';
  const task = (values.task || positionalTask).trim();
  const runHeadlessMode = values.headless || subcommand === 'run';
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
      throw new Error('Headless mode requires a task. Use: push run --task "..."');
    }
    return runHeadless(state, providerConfig, apiKey, task, maxRounds, values.json, acceptanceChecks);
  }

  return runInteractive(state, providerConfig, apiKey, maxRounds);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 1;
  });
