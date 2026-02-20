#!/usr/bin/env node
import { parseArgs, promisify } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';

const execFileAsync = promisify(execFile);

const MAX_TOOL_OUTPUT_CHARS = 24_000;
const DEFAULT_MAX_ROUNDS = 8;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_SEARCH_RESULTS = 120;

const PROVIDER_CONFIGS = {
  ollama: {
    id: 'ollama',
    url: process.env.PUSH_OLLAMA_URL || process.env.OLLAMA_API_URL || 'http://localhost:11434/v1/chat/completions',
    defaultModel: process.env.PUSH_OLLAMA_MODEL || 'gemini-3-flash-preview',
    apiKeyEnv: ['PUSH_OLLAMA_API_KEY', 'OLLAMA_API_KEY', 'VITE_OLLAMA_API_KEY'],
    requiresKey: false,
  },
  mistral: {
    id: 'mistral',
    url: process.env.PUSH_MISTRAL_URL || 'https://api.mistral.ai/v1/chat/completions',
    defaultModel: process.env.PUSH_MISTRAL_MODEL || 'devstral-small-latest',
    apiKeyEnv: ['PUSH_MISTRAL_API_KEY', 'MISTRAL_API_KEY', 'VITE_MISTRAL_API_KEY'],
    requiresKey: true,
  },
  openrouter: {
    id: 'openrouter',
    url: process.env.PUSH_OPENROUTER_URL || 'https://openrouter.ai/api/v1/chat/completions',
    defaultModel: process.env.PUSH_OPENROUTER_MODEL || 'anthropic/claude-sonnet-4.6',
    apiKeyEnv: ['PUSH_OPENROUTER_API_KEY', 'OPENROUTER_API_KEY', 'VITE_OPENROUTER_API_KEY'],
    requiresKey: true,
  },
};

const TOOL_PROTOCOL = `TOOL PROTOCOL

When you need a tool, output ONLY a fenced JSON block:
\`\`\`json
{"tool":"tool_name","args":{"key":"value"}}
\`\`\`

Available tools:
- read_file(path, start_line?, end_line?) — read a file from the workspace
- list_dir(path?) — list files/directories
- search_files(pattern, path?, max_results?) — text search in workspace
- exec(command, timeout_ms?) — run a shell command
- write_file(path, content) — write file content

Rules:
- Paths are relative to workspace root unless absolute inside workspace.
- Never attempt paths outside workspace.
- If a tool fails, correct the call and retry when appropriate.
- Do not describe a tool call in prose. Emit only the JSON block.`;

function buildSystemPrompt(workspaceRoot) {
  return `You are Push CLI, a coding assistant running in a local workspace.
Workspace root: ${workspaceRoot}

You can read files, run commands, and write files using tools.
Use tools for facts; do not invent file contents or command outputs.

${TOOL_PROTOCOL}`;
}

function truncateText(text, max = MAX_TOOL_OUTPUT_CHARS) {
  if (text.length <= max) return text;
  const extra = text.length - max;
  return `${text.slice(0, max)}\n\n[truncated ${extra} chars]`;
}

function asString(value, field) {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  return value;
}

function asOptionalNumber(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function detectToolCall(text) {
  const fenceRegex = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/g;
  let match;
  while ((match = fenceRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (typeof parsed.tool === 'string' && parsed.args && typeof parsed.args === 'object') {
        return { tool: parsed.tool, args: parsed.args };
      }
    } catch {
      // ignore parse errors in non-JSON fences
    }
  }

  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed.tool === 'string' && parsed.args && typeof parsed.args === 'object') {
        return { tool: parsed.tool, args: parsed.args };
      }
    } catch {
      // ignore
    }
  }

  return null;
}

function resolveApiKey(config) {
  for (const key of config.apiKeyEnv) {
    const value = process.env[key];
    if (value && value.trim()) return value.trim();
  }
  if (config.requiresKey) {
    throw new Error(`Missing API key for ${config.id}. Set one of: ${config.apiKeyEnv.join(', ')}`);
  }
  return '';
}

async function streamCompletion(config, apiKey, model, messages, onToken, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const headers = {
    'Content-Type': 'application/json',
  };

  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (config.id === 'openrouter') {
    headers['HTTP-Referer'] = process.env.PUSH_OPENROUTER_REFERER || 'https://push.local';
    headers['X-Title'] = 'Push CLI';
  }

  try {
    const response = await fetch(config.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        temperature: 0.1,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '(no body)');
      throw new Error(`Provider error ${response.status}: ${body.slice(0, 400)}`);
    }

    if (!response.body) {
      const fallbackJson = await response.json().catch(() => null);
      return fallbackJson?.choices?.[0]?.message?.content || '';
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let accumulated = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);
          const token =
            parsed.choices?.[0]?.delta?.content ??
            parsed.choices?.[0]?.message?.content ??
            '';
          if (token) {
            accumulated += token;
            if (onToken) onToken(token);
          }
        } catch {
          // ignore malformed SSE chunks
        }
      }
    }

    return accumulated;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error(`Request timed out after ${Math.floor(timeoutMs / 1000)}s`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function ensureInsideWorkspace(workspaceRoot, rawPath) {
  const trimmed = rawPath.trim();
  if (!trimmed) throw new Error('path is required');
  const resolved = path.resolve(workspaceRoot, trimmed);
  const root = path.resolve(workspaceRoot);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error('path escapes workspace root');
  }
  return resolved;
}

function formatExecOutput(stdout, stderr, exitCode, timedOut = false) {
  const parts = [`exit_code: ${exitCode}`];
  if (timedOut) parts.push('timed_out: true');
  if (stdout.trim()) parts.push(`stdout:\n${stdout}`);
  if (stderr.trim()) parts.push(`stderr:\n${stderr}`);
  if (!stdout.trim() && !stderr.trim()) parts.push('stdout:\n<empty>');
  return parts.join('\n\n');
}

async function executeSearch(pattern, searchRoot, maxResults) {
  try {
    const { stdout } = await execFileAsync('rg', [
      '--line-number',
      '--no-heading',
      '--color',
      'never',
      '--max-count',
      String(maxResults),
      pattern,
      searchRoot,
    ], { maxBuffer: 2_000_000 });
    return stdout.trim() || 'No matches';
  } catch (err) {
    if (err.code === 1) return (err.stdout || '').trim() || 'No matches';
    if (err.code === 'ENOENT') {
      try {
        const { stdout } = await execFileAsync('grep', [
          '-RIn',
          '--binary-files=without-match',
          '--',
          pattern,
          searchRoot,
        ], { maxBuffer: 2_000_000 });
        return stdout.trim() || 'No matches';
      } catch (grepErr) {
        if (grepErr.code === 1) return (grepErr.stdout || '').trim() || 'No matches';
        throw new Error(`Search failed: ${grepErr.message}`);
      }
    }
    throw new Error(`Search failed: ${err.message}`);
  }
}

async function executeToolCall(call, workspaceRoot) {
  try {
    switch (call.tool) {
      case 'read_file': {
        const filePath = ensureInsideWorkspace(workspaceRoot, asString(call.args.path, 'path'));
        const raw = await fs.readFile(filePath, 'utf8');
        const startLine = asOptionalNumber(call.args.start_line);
        const endLine = asOptionalNumber(call.args.end_line);
        if (startLine !== undefined || endLine !== undefined) {
          const lines = raw.split(/\r?\n/);
          const start = clamp(startLine ?? 1, 1, lines.length || 1);
          const end = clamp(endLine ?? lines.length, start, lines.length || start);
          const slice = lines.slice(start - 1, end);
          const numbered = slice.map((line, idx) => `${start + idx}: ${line}`).join('\n');
          return {
            ok: true,
            text: truncateText(numbered || '<empty file>'),
            meta: { path: filePath, start_line: start, end_line: end, lines: slice.length },
          };
        }
        return {
          ok: true,
          text: truncateText(raw || '<empty file>'),
          meta: { path: filePath, bytes: raw.length },
        };
      }
      case 'list_dir': {
        const dirArg = typeof call.args.path === 'string' ? call.args.path : '.';
        const dirPath = ensureInsideWorkspace(workspaceRoot, dirArg);
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        const mapped = entries
          .map((entry) => ({
            name: entry.name,
            type: entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : 'other',
          }))
          .sort((a, b) => {
            if (a.type === b.type) return a.name.localeCompare(b.name);
            if (a.type === 'dir') return -1;
            if (b.type === 'dir') return 1;
            return a.name.localeCompare(b.name);
          })
          .slice(0, 300);
        const text = mapped.map((entry) => `${entry.type === 'dir' ? 'd' : 'f'} ${entry.name}`).join('\n');
        return {
          ok: true,
          text: text || '<empty directory>',
          meta: { path: dirPath, count: mapped.length },
        };
      }
      case 'search_files': {
        const pattern = asString(call.args.pattern, 'pattern').trim();
        if (!pattern) throw new Error('pattern cannot be empty');
        const searchPath = typeof call.args.path === 'string' ? ensureInsideWorkspace(workspaceRoot, call.args.path) : workspaceRoot;
        const maxResults = clamp(asOptionalNumber(call.args.max_results) ?? DEFAULT_SEARCH_RESULTS, 1, 1000);
        const output = await executeSearch(pattern, searchPath, maxResults);
        return {
          ok: true,
          text: truncateText(output),
          meta: { path: searchPath, max_results: maxResults },
        };
      }
      case 'exec': {
        const command = asString(call.args.command, 'command');
        const timeoutMs = clamp(asOptionalNumber(call.args.timeout_ms) ?? 90_000, 1_000, 180_000);
        try {
          const { stdout, stderr } = await execFileAsync('/bin/bash', ['-lc', command], {
            cwd: workspaceRoot,
            timeout: timeoutMs,
            maxBuffer: 4_000_000,
          });
          return {
            ok: true,
            text: truncateText(formatExecOutput(stdout, stderr, 0)),
          };
        } catch (err) {
          const exitCode = typeof err.code === 'number' ? err.code : 1;
          return {
            ok: false,
            text: truncateText(formatExecOutput(err.stdout || '', err.stderr || err.message, exitCode, Boolean(err.killed))),
          };
        }
      }
      case 'write_file': {
        const filePath = ensureInsideWorkspace(workspaceRoot, asString(call.args.path, 'path'));
        const content = asString(call.args.content, 'content');
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, content, 'utf8');
        return {
          ok: true,
          text: `Wrote ${content.length} bytes to ${path.relative(workspaceRoot, filePath) || '.'}`,
          meta: { path: filePath, bytes: content.length },
        };
      }
      default:
        return {
          ok: false,
          text: `Unknown tool: ${call.tool}. Available: read_file, list_dir, search_files, exec, write_file`,
        };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, text: `Tool error: ${message}` };
  }
}

function makeSessionId() {
  return `sess_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
}

function getSessionRoot() {
  return process.env.PUSH_SESSION_DIR || path.join(process.cwd(), '.push', 'sessions');
}

function getSessionDir(sessionId) {
  return path.join(getSessionRoot(), sessionId);
}

function getStatePath(sessionId) {
  return path.join(getSessionDir(sessionId), 'state.json');
}

function getEventsPath(sessionId) {
  return path.join(getSessionDir(sessionId), 'events.jsonl');
}

async function ensureSessionDir(sessionId) {
  await fs.mkdir(getSessionDir(sessionId), { recursive: true });
}

async function saveSessionState(state) {
  state.updatedAt = Date.now();
  await ensureSessionDir(state.sessionId);
  await fs.writeFile(getStatePath(state.sessionId), JSON.stringify(state, null, 2), 'utf8');
}

async function appendSessionEvent(state, type, payload) {
  state.eventSeq += 1;
  state.updatedAt = Date.now();
  const event = {
    ts: Date.now(),
    seq: state.eventSeq,
    type,
    payload,
  };
  await ensureSessionDir(state.sessionId);
  await fs.appendFile(getEventsPath(state.sessionId), `${JSON.stringify(event)}\n`, 'utf8');
}

async function loadSessionState(sessionId) {
  const raw = await fs.readFile(getStatePath(sessionId), 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || parsed.sessionId !== sessionId || !Array.isArray(parsed.messages)) {
    throw new Error(`Invalid session state: ${sessionId}`);
  }
  return parsed;
}

async function listSessions() {
  const root = getSessionRoot();
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const rows = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const statePath = path.join(root, entry.name, 'state.json');
      try {
        const raw = await fs.readFile(statePath, 'utf8');
        const state = JSON.parse(raw);
        rows.push({
          sessionId: state.sessionId,
          updatedAt: state.updatedAt,
          provider: state.provider,
          model: state.model,
          cwd: state.cwd,
        });
      } catch {
        // ignore malformed sessions
      }
    }
    return rows.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

function buildToolResultMessage(call, result) {
  const payload = {
    tool: call.tool,
    ok: result.ok,
    output: result.text,
    meta: result.meta || null,
  };
  return `[TOOL_RESULT]\n${JSON.stringify(payload, null, 2)}\n[/TOOL_RESULT]`;
}

async function runAssistantLoop(state, providerConfig, apiKey, maxRounds, streamToStdout) {
  let finalAssistantText = '';
  const repeatedCalls = new Map();

  for (let round = 1; round <= maxRounds; round++) {
    if (streamToStdout) process.stdout.write('\nassistant> ');

    const assistantText = await streamCompletion(
      providerConfig,
      apiKey,
      state.model,
      state.messages,
      (token) => {
        if (streamToStdout) process.stdout.write(token);
      },
    );

    if (streamToStdout) process.stdout.write('\n');

    finalAssistantText = assistantText.trim();
    state.messages.push({ role: 'assistant', content: assistantText });
    state.rounds += 1;

    await appendSessionEvent(state, 'assistant_done', {
      round,
      chars: assistantText.length,
      preview: assistantText.slice(0, 280),
    });

    const toolCall = detectToolCall(assistantText);
    if (!toolCall) {
      await appendSessionEvent(state, 'run_complete', { outcome: 'success', rounds: round });
      return { outcome: 'success', finalAssistantText, rounds: round };
    }

    const callKey = JSON.stringify(toolCall);
    const seen = (repeatedCalls.get(callKey) || 0) + 1;
    repeatedCalls.set(callKey, seen);
    if (seen >= 3) {
      const loopText = `Detected repeated tool call loop for ${toolCall.tool}. Stopping run.`;
      state.messages.push({ role: 'user', content: `[TOOL_RESULT]\n{"tool":"${toolCall.tool}","ok":false,"output":"${loopText}"}\n[/TOOL_RESULT]` });
      await appendSessionEvent(state, 'error', { message: loopText });
      return { outcome: 'error', finalAssistantText: loopText, rounds: round };
    }

    if (streamToStdout) {
      process.stdout.write(`[tool] ${toolCall.tool}\n`);
    }
    await appendSessionEvent(state, 'tool_call', {
      round,
      tool: toolCall.tool,
      args: toolCall.args,
    });

    const result = await executeToolCall(toolCall, state.cwd);
    await appendSessionEvent(state, 'tool_result', {
      round,
      tool: toolCall.tool,
      ok: result.ok,
      preview: result.text.slice(0, 280),
    });

    if (streamToStdout) {
      process.stdout.write(`[tool:${result.ok ? 'ok' : 'error'}] ${truncateText(result.text, 420)}\n`);
    }

    state.messages.push({ role: 'user', content: buildToolResultMessage(toolCall, result) });
    await saveSessionState(state);
  }

  const warning = `Reached max rounds (${maxRounds}) before completion.`;
  await appendSessionEvent(state, 'run_complete', { outcome: 'max_rounds', rounds: maxRounds });
  return { outcome: 'max_rounds', finalAssistantText: warning, rounds: maxRounds };
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

Options:
  --provider <name>             ollama | mistral | openrouter (default: ollama)
  --model <name>                Override model
  --cwd <path>                  Workspace root (default: current directory)
  --session <id>                Resume session id
  --task <text>                 Task text for headless mode
  --max-rounds <n>              Tool-loop cap per user prompt (default: 8)
  --json                        JSON output in headless mode
  -h, --help                    Show help
`,
  );
}

async function runHeadless(state, providerConfig, apiKey, task, maxRounds, jsonOutput) {
  state.messages.push({ role: 'user', content: task });
  await appendSessionEvent(state, 'user_message', { chars: task.length, preview: task.slice(0, 280) });

  try {
    const result = await runAssistantLoop(state, providerConfig, apiKey, maxRounds, false);
    await saveSessionState(state);

    if (jsonOutput) {
      process.stdout.write(`${JSON.stringify({
        sessionId: state.sessionId,
        outcome: result.outcome,
        rounds: result.rounds,
        assistant: result.finalAssistantText,
      }, null, 2)}\n`);
    } else {
      process.stdout.write(`${result.finalAssistantText}\n`);
    }

    return result.outcome === 'success' ? 0 : 1;
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

async function runInteractive(state, providerConfig, apiKey, maxRounds) {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  process.stdout.write(
    `Push CLI\n` +
    `session: ${state.sessionId}\n` +
    `provider: ${providerConfig.id} | model: ${state.model}\n` +
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
  /session             Print session id
  /exit | /quit        Exit
`,
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
        const result = await runAssistantLoop(state, providerConfig, apiKey, maxRounds, true);
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
    messages: [{ role: 'system', content: buildSystemPrompt(cwd) }],
  };
  await ensureSessionDir(state.sessionId);
  await appendSessionEvent(state, 'session_started', {
    provider,
    model,
    cwd,
  });
  await saveSessionState(state);
  return state;
}

function parseProvider(raw) {
  const provider = (raw || process.env.PUSH_PROVIDER || 'ollama').toLowerCase();
  if (provider === 'ollama' || provider === 'mistral' || provider === 'openrouter') return provider;
  throw new Error(`Unsupported provider: ${raw}`);
}

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: false,
    options: {
      provider: { type: 'string' },
      model: { type: 'string' },
      cwd: { type: 'string' },
      session: { type: 'string' },
      task: { type: 'string' },
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

  const subcommand = positionals[0] || '';
  if (subcommand === 'sessions') {
    const sessions = await listSessions();
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
  const maxRounds = clamp(Number(values.maxRounds || DEFAULT_MAX_ROUNDS), 1, 30);

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
    return runHeadless(state, providerConfig, apiKey, task, maxRounds, values.json);
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
