import { describe, it, expect } from 'vitest';
import { recoverTokenDelimitedToolCalls } from './tool-call-token-recovery.js';

// DeepSeek native control tokens use the full-width pipe `｜` (U+FF5C) and
// the SentencePiece underscore `▁` (U+2581). Helper keeps the test bodies
// readable while exercising the real delimiters.
const ds = {
  callsBegin: '<｜tool▁calls▁begin｜>',
  callsEnd: '<｜tool▁calls▁end｜>',
  callBegin: '<｜tool▁call▁begin｜>',
  callEnd: '<｜tool▁call▁end｜>',
  sep: '<｜tool▁sep｜>',
};

function dsCall(name: string, argsJson: string): string {
  return `${ds.callBegin}function${ds.sep}${name}\n\`\`\`json\n${argsJson}\n\`\`\`${ds.callEnd}`;
}

describe('recoverTokenDelimitedToolCalls — Mistral [TOOL_CALLS]', () => {
  it('recovers the pre-v11 JSON-array shape', () => {
    const text = '[TOOL_CALLS] [{"name": "get_weather", "arguments": {"city": "SF"}}]';
    expect(recoverTokenDelimitedToolCalls(text)).toEqual([
      expect.objectContaining({
        tool: 'get_weather',
        args: { city: 'SF' },
        format: 'mistral',
      }),
    ]);
  });

  it('recovers the v11+ name-glued-to-object shape', () => {
    const text = '[TOOL_CALLS]get_weather{"city": "SF"}';
    expect(recoverTokenDelimitedToolCalls(text)).toEqual([
      expect.objectContaining({ tool: 'get_weather', args: { city: 'SF' }, format: 'mistral' }),
    ]);
  });

  it('expands multiple array elements into separate calls in order', () => {
    const text =
      '[TOOL_CALLS] [{"name": "read", "arguments": {"path": "a"}}, {"name": "diff", "arguments": {}}]';
    const recovered = recoverTokenDelimitedToolCalls(text);
    expect(recovered.map((r) => r.tool)).toEqual(['read', 'diff']);
    expect(recovered[0].args).toEqual({ path: 'a' });
    expect(recovered[1].args).toEqual({});
  });

  it('accepts `parameters` as an alias for `arguments`', () => {
    const text = '[TOOL_CALLS] [{"name": "read", "parameters": {"path": "a"}}]';
    expect(recoverTokenDelimitedToolCalls(text)[0].args).toEqual({ path: 'a' });
  });

  it('accepts a JSON-encoded string for arguments', () => {
    const text = '[TOOL_CALLS] [{"name": "read", "arguments": "{\\"path\\": \\"a\\"}"}]';
    expect(recoverTokenDelimitedToolCalls(text)[0].args).toEqual({ path: 'a' });
  });

  it('accepts the OpenAI-echoing `function: {name, arguments}` nesting', () => {
    const text = '[TOOL_CALLS] [{"function": {"name": "read", "arguments": {"path": "a"}}}]';
    expect(recoverTokenDelimitedToolCalls(text)[0]).toMatchObject({
      tool: 'read',
      args: { path: 'a' },
    });
  });

  it('drops an element whose arguments is not an object/string', () => {
    const text = '[TOOL_CALLS] [{"name": "exec", "arguments": 42}]';
    expect(recoverTokenDelimitedToolCalls(text)).toEqual([]);
  });

  it('ignores a sentinel not followed by a recoverable payload (prose mention)', () => {
    const text = 'The Mistral [TOOL_CALLS] token marks the start of a call.';
    expect(recoverTokenDelimitedToolCalls(text)).toEqual([]);
  });

  it('anchors the offset to the sentinel', () => {
    const text = 'Sure.\n[TOOL_CALLS] [{"name": "read", "arguments": {"path": "a"}}]';
    expect(recoverTokenDelimitedToolCalls(text)[0].offset).toBe(text.indexOf('[TOOL_CALLS]'));
  });
});

describe('recoverTokenDelimitedToolCalls — DeepSeek native', () => {
  it('recovers a single fenced-args call inside the wrapper', () => {
    const text = `${ds.callsBegin}${dsCall('get_weather', '{"city": "SF"}')}${ds.callsEnd}`;
    expect(recoverTokenDelimitedToolCalls(text)).toEqual([
      expect.objectContaining({ tool: 'get_weather', args: { city: 'SF' }, format: 'deepseek' }),
    ]);
  });

  it('expands multiple call blocks in order', () => {
    const text =
      ds.callsBegin + dsCall('read', '{"path": "a"}') + '\n' + dsCall('diff', '{}') + ds.callsEnd;
    const recovered = recoverTokenDelimitedToolCalls(text);
    expect(recovered.map((r) => r.tool)).toEqual(['read', 'diff']);
    expect(recovered[0].args).toEqual({ path: 'a' });
    expect(recovered[1].args).toEqual({});
  });

  it('treats a call block with no args object as a zero-arg call', () => {
    const text = `${ds.callsBegin}${ds.callBegin}function${ds.sep}git_status${ds.callEnd}${ds.callsEnd}`;
    expect(recoverTokenDelimitedToolCalls(text)).toEqual([
      expect.objectContaining({ tool: 'git_status', args: {}, format: 'deepseek' }),
    ]);
  });

  it('tolerates the ASCII-fallback delimiters (`|` / `_`) some detokenizers emit', () => {
    const text =
      '<|tool_calls_begin|><|tool_call_begin|>function<|tool_sep|>read\n' +
      '```json\n{"path": "a"}\n```<|tool_call_end|><|tool_calls_end|>';
    expect(recoverTokenDelimitedToolCalls(text)).toEqual([
      expect.objectContaining({ tool: 'read', args: { path: 'a' }, format: 'deepseek' }),
    ]);
  });

  it('requires the calls wrapper — a bare call block alone does not promote', () => {
    const text = dsCall('exec', '{"command": "rm -rf /"}');
    expect(recoverTokenDelimitedToolCalls(text)).toEqual([]);
  });

  it('anchors offset/endOffset to the call block, not the wrapper', () => {
    const text = `${ds.callsBegin}${dsCall('read', '{"path": "a"}')}${ds.callsEnd}`;
    const [r] = recoverTokenDelimitedToolCalls(text);
    expect(r.offset).toBe(text.indexOf(ds.callBegin));
    expect(r.endOffset).toBe(text.indexOf(ds.callEnd) + ds.callEnd.length);
  });
});

describe('recoverTokenDelimitedToolCalls — mixed + ordering', () => {
  it('merges Mistral and DeepSeek calls in textual order', () => {
    const text =
      '[TOOL_CALLS] [{"name": "first", "arguments": {}}]\n' +
      `${ds.callsBegin}${dsCall('second', '{}')}${ds.callsEnd}`;
    const recovered = recoverTokenDelimitedToolCalls(text);
    expect(recovered.map((r) => r.tool)).toEqual(['first', 'second']);
    expect(recovered[0].offset).toBeLessThan(recovered[1].offset);
  });

  it('returns nothing for plain prose with neither sentinel', () => {
    expect(recoverTokenDelimitedToolCalls('Just a normal sentence.')).toEqual([]);
  });
});
