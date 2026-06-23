import { describe, it, expect } from 'vitest';
import { PASS_THROUGH_CLI_SOURCE, createToolDispatcher } from './tool-dispatch.js';

/**
 * Format-coverage matrix — a single, enumerated record of which on-the-wire
 * tool-call formats Push recovers, routed end-to-end through the real
 * dispatcher (canonical detection + the phase-3 recovery layer). It exists
 * so new formats are added deliberately, with a row here, rather than
 * discovered one screenshot at a time.
 *
 * Reference for the format set: vLLM's per-model tool parsers
 * (https://docs.vllm.ai/en/latest/features/tool_calling/) and llama.cpp's
 * function-calling docs. When we add support for a `skip: true` row, flip
 * it and add a real assertion in the same change.
 *
 * `expect: 'recover'` rows must surface the named tool through the
 * dispatcher with no malformed reports. `skip` rows document formats we
 * intentionally do NOT parse yet (e.g. pythonic expression calls, which
 * need a distinct non-JSON parser) — they assert zero calls so the day we
 * add one, this test forces the row to flip.
 */

const ds = {
  callsBegin: '<｜tool▁calls▁begin｜>',
  callsEnd: '<｜tool▁calls▁end｜>',
  callBegin: '<｜tool▁call▁begin｜>',
  callEnd: '<｜tool▁call▁end｜>',
  sep: '<｜tool▁sep｜>',
};

interface MatrixRow {
  /** Model family / format label. */
  format: string;
  /** Representative wire sample as it would leak into the content stream. */
  sample: string;
  /** Expected outcome. */
  expect: 'recover' | 'skip';
  /** For `recover`: the tool name(s) that must come out, in order. */
  tools?: string[];
}

const MATRIX: MatrixRow[] = [
  {
    format: 'OpenAI / Push canonical (bare JSON)',
    sample: '{"tool":"read_file","args":{"path":"a"}}',
    expect: 'recover',
    tools: ['read_file'],
  },
  {
    format: 'OpenAI / Push canonical (fenced JSON)',
    sample: '```json\n{"tool":"read_file","args":{"path":"a"}}\n```',
    expect: 'recover',
    tools: ['read_file'],
  },
  {
    format: 'Hermes / Qwen (<tool_call> JSON)',
    sample: '<tool_call>{"name":"read_file","arguments":{"path":"a"}}</tool_call>',
    expect: 'recover',
    tools: ['read_file'],
  },
  {
    format: 'Hermes arg_key/arg_value pairs',
    sample: '<tool_call>read_file<arg_key>path</arg_key><arg_value>a</arg_value></tool_call>',
    expect: 'recover',
    tools: ['read_file'],
  },
  {
    format: 'Anthropic function_calls/invoke/parameter',
    sample:
      '<function_calls><invoke name="read_file"><parameter name="path">a</parameter></invoke></function_calls>',
    expect: 'recover',
    tools: ['read_file'],
  },
  {
    format: 'Anthropic standalone invoke (no wrapper, x-ai/grok-code-fast-1)',
    sample: '<invoke name="read_file"><parameter name="path">a</parameter></invoke>',
    expect: 'recover',
    tools: ['read_file'],
  },
  {
    format: 'Namespaced functions.<name>:<id> (Kimi/Blackbox)',
    sample: 'functions.read_file:0 {"path":"a"}',
    expect: 'recover',
    tools: ['read_file'],
  },
  {
    format: 'DSML namespace-wrapped invoke (Shape D)',
    sample:
      '<|DSML|tool_calls><|DSML|invoke name="read_file"><|DSML|parameter name="path">a</|DSML|parameter></|DSML|invoke></|DSML|tool_calls>',
    expect: 'recover',
    tools: ['read_file'],
  },
  {
    format: 'Mistral [TOOL_CALLS] array',
    sample: '[TOOL_CALLS] [{"name":"read_file","arguments":{"path":"a"}}]',
    expect: 'recover',
    tools: ['read_file'],
  },
  {
    format: 'Mistral [TOOL_CALLS] name-glued',
    sample: '[TOOL_CALLS]read_file{"path":"a"}',
    expect: 'recover',
    tools: ['read_file'],
  },
  {
    format: 'DeepSeek V3/R1 native tokens',
    sample: `${ds.callsBegin}${ds.callBegin}function${ds.sep}read_file\n\`\`\`json\n{"path":"a"}\n\`\`\`${ds.callEnd}${ds.callsEnd}`,
    expect: 'recover',
    tools: ['read_file'],
  },
  {
    // Pythonic calls (Llama 3.2/4, xLAM) are a distinct expression-syntax
    // parser, intentionally out of scope. This row asserts we drop it
    // cleanly — flip it the day we add a pythonic parser.
    format: 'Pythonic expression call (Llama 3.2/4, xLAM) — UNSUPPORTED',
    sample: '[read_file(path="a")]',
    expect: 'skip',
  },
];

describe('tool-call format coverage matrix', () => {
  const dispatcher = createToolDispatcher([PASS_THROUGH_CLI_SOURCE]);

  for (const row of MATRIX) {
    if (row.expect === 'recover') {
      it(`recovers: ${row.format}`, () => {
        const result = dispatcher.detectAllToolCalls(row.sample);
        expect(result.calls.map((c) => c.tool)).toEqual(row.tools);
        expect(result.malformed).toEqual([]);
      });
    } else {
      it(`skips (unsupported): ${row.format}`, () => {
        const result = dispatcher.detectAllToolCalls(row.sample);
        expect(result.calls).toEqual([]);
      });
    }
  }
});
