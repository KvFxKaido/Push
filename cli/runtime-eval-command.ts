import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_RUNTIME_EVAL_POLICY,
  evaluateRuntimeEvents,
  parseRuntimeEvalPolicy,
  type RuntimeEvalResultV1,
  type RuntimeEvalRunSelector,
} from '../lib/runtime-eval.js';

export interface RuntimeEvalCommandValues {
  json?: boolean;
  policy?: string;
  'run-id'?: string;
  runId?: string;
  'session-id'?: string;
  sessionId?: string;
}

export interface RuntimeEvalCommandDeps {
  cwd?: string;
  write?: (text: string) => void;
}

async function readTextFile(filePath: string, label: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read ${label} ${filePath}: ${message}`);
  }
}

export function parseRuntimeEvalJsonl(source: string, label = 'runtime receipt'): unknown[] {
  const events: unknown[] = [];
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${label} contains invalid JSON on line ${index + 1}: ${message}`);
    }
  }
  if (events.length === 0) throw new Error(`${label} contains no events.`);
  return events;
}

function formatEvidenceLocation(eventIndex: number): string {
  return eventIndex >= 0 ? `event ${eventIndex + 1}` : 'receipt';
}

export function formatRuntimeEvalResult(result: RuntimeEvalResultV1): string {
  const lines = [
    `verdict: ${result.verdict}`,
    `session: ${result.sessionId ?? 'unknown'}`,
    `run: ${result.runId ?? 'unknown'}`,
    'gates:',
  ];
  for (const gate of result.gates) {
    lines.push(`  ${gate.status.toUpperCase()} ${gate.id} — ${gate.message}`);
    if (gate.status === 'fail') {
      for (const item of gate.evidence) {
        lines.push(`    ${formatEvidenceLocation(item.eventIndex)}: ${item.message}`);
      }
    }
  }
  if (result.scores.length > 0) {
    lines.push('scores:');
    for (const score of result.scores) {
      lines.push(
        `  ${score.status.toUpperCase()} ${score.id} — actual ${score.actual}, threshold ${score.threshold}`,
      );
    }
  }
  lines.push(
    `metrics: rounds=${result.metrics.rounds} toolCalls=${result.metrics.toolCalls} durationMs=${result.metrics.durationMs ?? 'unknown'}`,
  );
  return `${lines.join('\n')}\n`;
}

function nonEmptyOption(value: string | undefined, flag: string): string | undefined {
  if (value === undefined) return undefined;
  if (!value.trim()) throw new Error(`${flag} must be a non-empty string.`);
  return value;
}

export async function runRuntimeEvalSubcommand(
  values: RuntimeEvalCommandValues,
  positionals: string[],
  deps: RuntimeEvalCommandDeps = {},
): Promise<number> {
  if (positionals.length !== 2 || !positionals[1]) {
    throw new Error('Usage: push eval <run.jsonl> [--policy <policy.json>] [--json]');
  }

  const cwd = deps.cwd ?? process.cwd();
  const receiptPath = path.resolve(cwd, positionals[1]);
  const receiptSource = await readTextFile(receiptPath, 'runtime receipt');
  const events = parseRuntimeEvalJsonl(receiptSource, `Runtime receipt ${receiptPath}`);

  let policy = DEFAULT_RUNTIME_EVAL_POLICY;
  if (values.policy !== undefined) {
    const policyPath = path.resolve(cwd, nonEmptyOption(values.policy, '--policy')!);
    const policySource = await readTextFile(policyPath, 'runtime eval policy');
    let candidate: unknown;
    try {
      candidate = JSON.parse(policySource);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Runtime eval policy is not valid JSON (${policyPath}): ${message}`);
    }
    policy = parseRuntimeEvalPolicy(candidate);
  }

  const selector: RuntimeEvalRunSelector = {};
  const runId = nonEmptyOption(values['run-id'] ?? values.runId, '--run-id');
  const sessionId = nonEmptyOption(values['session-id'] ?? values.sessionId, '--session-id');
  if (runId) selector.runId = runId;
  if (sessionId) selector.sessionId = sessionId;

  const result = evaluateRuntimeEvents(events, policy, selector);
  const output = values.json
    ? `${JSON.stringify(result, null, 2)}\n`
    : formatRuntimeEvalResult(result);
  (deps.write ?? ((text: string) => process.stdout.write(text)))(output);
  return result.verdict === 'fail' ? 1 : 0;
}
