#!/usr/bin/env npx tsx
/**
 * Provider Compliance Runner
 *
 * Tests that a Push AI backend obeys the execution contract:
 * streaming discipline, tool-call schema, error recovery, multi-round
 * coherence, delegation, and event-stream cleanliness.
 *
 * Usage:
 *   npx tsx scripts/run-provider-compliance.ts --provider ollama
 *   npx tsx scripts/run-provider-compliance.ts --provider openrouter --model anthropic/claude-opus-4.6
 *   npx tsx scripts/run-provider-compliance.ts --provider mistral --json
 *   npx tsx scripts/run-provider-compliance.ts --provider ollama --test tool-call-schema
 *
 * Spec: tests/compliance/SPEC.md
 */

import { parseArgs } from 'node:util';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

interface TestResult {
  name: string;
  passed: boolean;
  duration_ms: number;
  error?: string;
  detail?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Provider configs
// ---------------------------------------------------------------------------

const PROVIDER_CONFIGS = {
  mistral: {
    url: 'https://api.mistral.ai/v1/chat/completions',
    model: 'devstral-small-latest',
    envKey: 'VITE_MISTRAL_API_KEY',
  },
  openrouter: {
    url: 'https://openrouter.ai/api/v1/chat/completions',
    model: 'anthropic/claude-sonnet-4.5',
    envKey: 'VITE_OPENROUTER_API_KEY',
  },
  ollama: {
    url: 'http://localhost:11434/v1/chat/completions',
    model: 'gemini-3-flash-preview',
    envKey: 'VITE_OLLAMA_API_KEY',
  },
} as const;

// ---------------------------------------------------------------------------
// Tool protocol (condensed from TOOL_PROTOCOL + SANDBOX_TOOL_PROTOCOL)
// ---------------------------------------------------------------------------

const TOOL_PROTOCOL = `
TOOL PROTOCOL

When you need to use a tool, output ONLY a fenced JSON block:

\`\`\`json
{"tool": "tool_name", "args": {"param": "value"}}
\`\`\`

Available tools:
- sandbox_read_file(path, start_line?, end_line?) — Read a workspace file
- sandbox_write_file(path, content) — Write or overwrite a workspace file
- sandbox_edit_file(path, edits) — Edit a file using hashline references
- sandbox_exec(command) — Execute a shell command in the workspace
- delegate_coder(task) — Delegate a complex coding task to the Coder agent

CRITICAL: To use a tool, you MUST output the fenced JSON block. Do NOT describe
or narrate tool usage in prose. Output ONLY the JSON block — no explanation before
or after. If a tool call fails, emit a corrected call immediately.
`.trim();

const SYSTEM_PROMPT = `You are Push, an AI coding assistant with access to a sandbox workspace. You help users with coding tasks by reading files, writing code, and executing commands.

${TOOL_PROTOCOL}`;

const CODER_SYSTEM_PROMPT = `You are the Coder agent — a specialist focused on implementing coding tasks. You have direct access to sandbox tools. Complete the task efficiently using the available tools, then confirm when done.

${TOOL_PROTOCOL}`;

// ---------------------------------------------------------------------------
// SSE streaming client
// ---------------------------------------------------------------------------

async function streamCompletion(
  url: string,
  apiKey: string,
  model: string,
  messages: Message[],
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages, stream: true, temperature: 0.1 }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '(no body)');
      throw new Error(`HTTP ${response.status}: ${body}`);
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let accumulated = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        try {
          const chunk = JSON.parse(data);
          const content = chunk.choices?.[0]?.delta?.content;
          if (typeof content === 'string') accumulated += content;
        } catch { /* skip malformed SSE chunks */ }
      }
    }

    return accumulated;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Tool detection (minimal — fenced JSON only)
// ---------------------------------------------------------------------------

function detectToolCall(text: string): ToolCall | null {
  const fenceRegex = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/g;
  let match;
  while ((match = fenceRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (parsed && typeof parsed.tool === 'string' && parsed.args !== undefined) {
        return parsed as ToolCall;
      }
    } catch { /* not valid JSON */ }
  }
  // Bare JSON fallback (no fences)
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed.tool === 'string') return parsed as ToolCall;
    } catch { /* not valid JSON */ }
  }
  return null;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// ---------------------------------------------------------------------------
// Compliance runner
// ---------------------------------------------------------------------------

class ComplianceRunner {
  constructor(
    private readonly url: string,
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  private chat(messages: Message[], timeoutMs = 30_000): Promise<string> {
    return streamCompletion(this.url, this.apiKey, this.model, messages, timeoutMs);
  }

  // Test 1 — Streaming Integrity
  async test1_streamingIntegrity(): Promise<TestResult> {
    const start = Date.now();
    const name = 'streaming-integrity';
    try {
      const response = await this.chat([
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: 'Write a 500-word essay about the history of version control systems. Do not use any tools.' },
      ], 30_000);

      const toolCall = detectToolCall(response);
      const words = wordCount(response);
      const endsAbruptly = response.trim().endsWith('...');

      if (toolCall) return fail(name, start, `Tool call emitted despite instruction: ${toolCall.tool}`);
      if (words < 400) return fail(name, start, `Response too short: ${words} words (need ≥ 400)`);
      if (endsAbruptly) return fail(name, start, 'Response appears truncated (ends with "...")');

      return pass(name, start, { word_count: words });
    } catch (e) {
      return fail(name, start, String(e));
    }
  }

  // Test 2 — Tool Call Schema
  async test2_toolCallSchema(): Promise<TestResult> {
    const start = Date.now();
    const name = 'tool-call-schema';
    try {
      const response = await this.chat([
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: 'Read the file /workspace/test.txt using the sandbox_read_file tool.' },
      ]);

      const toolCall = detectToolCall(response);
      if (!toolCall) return fail(name, start, 'No tool call detected');
      if (toolCall.tool !== 'sandbox_read_file') return fail(name, start, `Wrong tool: ${toolCall.tool}`);
      if (typeof toolCall.args.path !== 'string') return fail(name, start, 'Missing required arg: path');

      // Penalise excessive preamble
      const fenceIdx = response.indexOf('```');
      const preamble = fenceIdx > 0 ? response.slice(0, fenceIdx).trim() : '';
      if (preamble.length > 50) {
        return fail(name, start, `Excessive preamble (${preamble.length} chars): "${preamble.slice(0, 60)}..."`);
      }

      return pass(name, start, { tool: toolCall.tool, path: toolCall.args.path });
    } catch (e) {
      return fail(name, start, String(e));
    }
  }

  // Test 3 — Truncated Tool Recovery
  async test3_truncatedRecovery(): Promise<TestResult> {
    const start = Date.now();
    const name = 'truncated-recovery';
    try {
      const response = await this.chat([
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: 'Read the file /workspace/notes.txt' },
        {
          role: 'assistant',
          content: '```json\n{"tool": "sandbox_read_file", "args": {"path": "/workspace/no',
        },
        {
          role: 'user',
          content: '[TOOL_RESULT]\nYour tool call for "sandbox_read_file" was truncated (JSON cut off). Please retry with the complete JSON block.\n[/TOOL_RESULT]',
        },
      ]);

      const toolCall = detectToolCall(response);
      if (!toolCall) return fail(name, start, 'No corrected tool call in response');
      if (toolCall.tool !== 'sandbox_read_file') return fail(name, start, `Wrong tool in correction: ${toolCall.tool}`);
      if (typeof toolCall.args.path !== 'string') return fail(name, start, 'Corrected call missing required arg: path');

      // Penalise excessive apology/explanation
      const fenceIdx = response.indexOf('```');
      const preamble = fenceIdx > 0 ? response.slice(0, fenceIdx).trim() : '';
      if (preamble.length > 100) {
        return fail(name, start, `Extended apology before correction (${preamble.length} chars)`);
      }

      return pass(name, start, { corrected_tool: toolCall.tool, path: toolCall.args.path });
    } catch (e) {
      return fail(name, start, String(e));
    }
  }

  // Test 4 — Multi-Round Coherence
  async test4_multiRoundCoherence(): Promise<TestResult> {
    const start = Date.now();
    const name = 'multi-round-coherence';

    const MOCK: Record<string, string> = {
      sandbox_read_file: 'File contents:\n10 20 30',
      sandbox_write_file: 'File written successfully.',
      sandbox_edit_file: 'File edited successfully.',
      sandbox_exec: 'Command completed with exit code 0.',
    };

    const messages: Message[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: 'Read /workspace/numbers.txt, sum all the numbers, then write the result to /workspace/result.txt.',
      },
    ];

    const seenCalls = new Set<string>();
    let resultWritten = false;

    try {
      for (let round = 1; round <= 4; round++) {
        const response = await this.chat(messages);
        messages.push({ role: 'assistant', content: response });

        const toolCall = detectToolCall(response);
        if (!toolCall) {
          // Model considers itself done
          if (!resultWritten) return fail(name, start, 'Task ended without writing result.txt');
          return pass(name, start, { rounds });
        }

        // Loop detection
        const callKey = `${toolCall.tool}:${JSON.stringify(toolCall.args)}`;
        if (seenCalls.has(callKey)) {
          return fail(name, start, `Repeated identical tool call: ${toolCall.tool}`);
        }
        seenCalls.add(callKey);

        // Verify correct result written
        if (
          (toolCall.tool === 'sandbox_write_file' || toolCall.tool === 'sandbox_edit_file') &&
          String(toolCall.args.path ?? '').includes('result.txt')
        ) {
          const written = String(toolCall.args.content ?? toolCall.args.edits ?? '');
          if (!written.includes('60')) {
            return fail(name, start, `Wrong sum written to result.txt: "${written.slice(0, 40)}"`);
          }
          resultWritten = true;
        }

        const mockResult = MOCK[toolCall.tool] ?? 'OK';
        messages.push({ role: 'user', content: `[TOOL_RESULT]\n${mockResult}\n[/TOOL_RESULT]` });
      }

      return fail(name, start, 'Task not completed within 4 rounds');
    } catch (e) {
      return fail(name, start, String(e));
    }
  }

  // Test 5a — Delegation Signal
  async test5a_delegationSignal(): Promise<TestResult> {
    const start = Date.now();
    const name = 'delegation-signal';
    try {
      const response = await this.chat([
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: 'Create a Python script at /workspace/hello.py that prints "Hello from Push".',
        },
      ]);

      const toolCall = detectToolCall(response);
      if (!toolCall) return fail(name, start, 'No tool call detected');
      if (toolCall.tool !== 'delegate_coder') {
        return fail(name, start, `Expected delegate_coder, got: ${toolCall.tool}`);
      }

      const task = String(toolCall.args.task ?? toolCall.args.tasks ?? '');
      if (!task || task.length < 10) {
        return fail(name, start, 'Delegation task description missing or too short');
      }

      return pass(name, start, { task: task.slice(0, 100) });
    } catch (e) {
      return fail(name, start, String(e));
    }
  }

  // Test 5b — Sandbox Execution (Coder role)
  async test5b_sandboxExecution(): Promise<TestResult> {
    const start = Date.now();
    const name = 'sandbox-execution';

    const messages: Message[] = [
      { role: 'system', content: CODER_SYSTEM_PROMPT },
      {
        role: 'user',
        content:
          'Create a Python script at /workspace/hello.py that prints "Hello from Push". Write the file using sandbox_write_file.',
      },
    ];

    try {
      for (let round = 1; round <= 3; round++) {
        const response = await this.chat(messages, 30_000);
        messages.push({ role: 'assistant', content: response });

        const toolCall = detectToolCall(response);
        if (!toolCall) return fail(name, start, 'Coder did not emit a tool call');

        if (toolCall.tool === 'sandbox_write_file') {
          const path = String(toolCall.args.path ?? '');
          const content = String(toolCall.args.content ?? '');

          if (!path.endsWith('hello.py')) return fail(name, start, `Wrong file path: ${path}`);
          if (!content.includes('Hello from Push')) {
            return fail(name, start, 'File content missing "Hello from Push"');
          }
          return pass(name, start, { path, round });
        }

        if (toolCall.tool === 'sandbox_exec') {
          // Accept exec as an alternative (e.g. `echo '...' > hello.py`)
          messages.push({ role: 'user', content: '[TOOL_RESULT]\nCommand executed.\n[/TOOL_RESULT]' });
          continue;
        }

        // Some other tool — allow it and continue
        messages.push({ role: 'user', content: '[TOOL_RESULT]\nOK\n[/TOOL_RESULT]' });
      }

      return fail(name, start, 'hello.py not created within 3 rounds');
    } catch (e) {
      return fail(name, start, String(e));
    }
  }

  // Test 6 — Event Stream Clean
  async test6_eventStreamClean(): Promise<TestResult> {
    const start = Date.now();
    const name = 'event-stream-clean';
    try {
      const response = await this.chat([
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content:
            'Briefly explain what a config file is (2 sentences), then read /workspace/config.json.',
        },
      ]);

      const toolCall = detectToolCall(response);
      if (!toolCall) return fail(name, start, 'No tool call detected');
      if (toolCall.tool !== 'sandbox_read_file') {
        return fail(name, start, `Expected sandbox_read_file, got: ${toolCall.tool}`);
      }

      const fenceIdx = response.indexOf('```');
      const textBefore = fenceIdx > 0 ? response.slice(0, fenceIdx).trim() : '';

      if (textBefore.length < 20) {
        return fail(name, start, 'No meaningful text before tool call — model skipped explanation');
      }
      if (/\{\s*"tool"\s*:/.test(textBefore)) {
        return fail(name, start, 'Raw tool JSON found in text content before fence');
      }

      return pass(name, start, { text_chars: textBefore.length, tool: toolCall.tool });
    } catch (e) {
      return fail(name, start, String(e));
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pass(name: string, start: number, detail?: Record<string, unknown>): TestResult {
  return { name, passed: true, duration_ms: Date.now() - start, detail };
}

function fail(name: string, start: number, error: string): TestResult {
  return { name, passed: false, duration_ms: Date.now() - start, error };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      provider: { type: 'string' },
      model: { type: 'string' },
      json: { type: 'boolean', default: false },
      test: { type: 'string' },
    },
  });

  const providerName = values.provider as string | undefined;
  if (!providerName) {
    console.error('Usage: npx tsx scripts/run-provider-compliance.ts --provider <name> [--model <model>] [--json] [--test <name>]');
    console.error('Providers:', Object.keys(PROVIDER_CONFIGS).join(', '));
    process.exit(1);
  }

  const config = PROVIDER_CONFIGS[providerName as keyof typeof PROVIDER_CONFIGS];
  if (!config) {
    console.error(`Unknown provider: ${providerName}`);
    console.error('Available:', Object.keys(PROVIDER_CONFIGS).join(', '));
    process.exit(1);
  }

  const apiKey = process.env[config.envKey] ?? '';
  if (!apiKey) {
    console.error(`Missing API key — set ${config.envKey}`);
    process.exit(1);
  }

  const model = (values.model as string | undefined) ?? config.model;
  const jsonMode = values.json as boolean;
  const singleTest = values.test as string | undefined;

  if (!jsonMode) {
    console.log(`Provider: ${providerName}`);
    console.log(`Model:    ${model}`);
    console.log('');
  }

  const runner = new ComplianceRunner(config.url, apiKey, model);

  const ALL_TESTS = [
    { name: 'streaming-integrity',  fn: () => runner.test1_streamingIntegrity() },
    { name: 'tool-call-schema',     fn: () => runner.test2_toolCallSchema() },
    { name: 'truncated-recovery',   fn: () => runner.test3_truncatedRecovery() },
    { name: 'multi-round-coherence',fn: () => runner.test4_multiRoundCoherence() },
    { name: 'delegation-signal',    fn: () => runner.test5a_delegationSignal() },
    { name: 'sandbox-execution',    fn: () => runner.test5b_sandboxExecution() },
    { name: 'event-stream-clean',   fn: () => runner.test6_eventStreamClean() },
  ];

  const toRun = singleTest
    ? ALL_TESTS.filter(t => t.name === singleTest)
    : ALL_TESTS;

  if (singleTest && toRun.length === 0) {
    console.error(`Unknown test: ${singleTest}`);
    console.error('Available:', ALL_TESTS.map(t => t.name).join(', '));
    process.exit(1);
  }

  const results: TestResult[] = [];

  for (const { name, fn } of toRun) {
    if (!jsonMode) process.stdout.write(`  ${name.padEnd(26)}`);
    const result = await fn();
    results.push(result);

    if (!jsonMode) {
      const status = result.passed ? 'PASS' : 'FAIL';
      const ms = `(${result.duration_ms}ms)`;
      const detail = result.detail ? `  ${JSON.stringify(result.detail)}` : '';
      const err = result.error ? `  — ${result.error}` : '';
      console.log(`${status}  ${ms}${detail}${err}`);
    }
  }

  const allPassed = results.every(r => r.passed);
  const failures = results.filter(r => !r.passed);

  if (jsonMode) {
    const output = {
      provider: providerName,
      model,
      timestamp: new Date().toISOString(),
      spec_version: '1.0.0',
      eligible: allPassed,
      tests: results,
      failures: failures.map(r => ({ name: r.name, error: r.error })),
    };
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log('');
    if (allPassed) {
      console.log(`→ ELIGIBLE`);
    } else {
      console.log(`→ NOT ELIGIBLE  (${failures.length} failure${failures.length !== 1 ? 's' : ''})`);
    }
  }

  process.exit(allPassed ? 0 : 1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
