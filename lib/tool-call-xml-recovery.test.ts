import { describe, it, expect } from 'vitest';
import { recoverXmlToolCalls } from './tool-call-xml-recovery.js';

describe('recoverXmlToolCalls — Shape A (Hermes/Qwen JSON inside tag)', () => {
  it('recovers a single `{name, arguments}` body', () => {
    const text = '<tool_call>{"name": "read_file", "arguments": {"path": "TODO.md"}}</tool_call>';
    expect(recoverXmlToolCalls(text)).toEqual([
      { tool: 'read_file', args: { path: 'TODO.md' }, offset: 0 },
    ]);
  });

  it('accepts the Push-canonical `{tool, args}` body shape too', () => {
    // Some finetunes use Push's own wrapper keys inside the XML tag —
    // we accept both rather than forcing the model to pick one.
    const text = '<tool_call>{"tool": "git_status", "args": {}}</tool_call>';
    expect(recoverXmlToolCalls(text)).toEqual([{ tool: 'git_status', args: {}, offset: 0 }]);
  });

  it('tolerates whitespace and newlines around the JSON body', () => {
    const text = '<tool_call>\n  {"name": "list_dir", "arguments": {"path": "."}}\n</tool_call>';
    const recovered = recoverXmlToolCalls(text);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ tool: 'list_dir', args: { path: '.' } });
  });

  it('repairs trailing commas inside the JSON body via shape-agnostic repair', () => {
    const text = '<tool_call>{"name": "read_file", "arguments": {"path": "TODO.md",}}</tool_call>';
    expect(recoverXmlToolCalls(text)).toEqual([
      { tool: 'read_file', args: { path: 'TODO.md' }, offset: 0 },
    ]);
  });

  it('drops a JSON body whose arguments is not an object', () => {
    const text = '<tool_call>{"name": "exec", "arguments": "rm -rf /"}</tool_call>';
    expect(recoverXmlToolCalls(text)).toEqual([]);
  });
});

describe('recoverXmlToolCalls — Shape B (XML arg_key/arg_value pairs)', () => {
  // Captured shape from the mobile-app bug report: the model emits the
  // tool name as bare text right after `<tool_call>`, then alternating
  // `<arg_key>` / `<arg_value>` pairs, closed with `</tool_call>`.
  const MOBILE_BUG_CAPTURE = [
    '<tool_call>commits',
    '<arg_key>count</arg_key>',
    '<arg_value>10</arg_value>',
    '<arg_key>repo</arg_key>',
    '<arg_value>KvFxKaido/Push</arg_value>',
    '</tool_call>',
  ].join('\n');

  it('recovers the exact mobile-app bug capture', () => {
    expect(recoverXmlToolCalls(MOBILE_BUG_CAPTURE)).toEqual([
      {
        tool: 'commits',
        args: { count: 10, repo: 'KvFxKaido/Push' },
        offset: 0,
      },
    ]);
  });

  it('coerces numeric values via JSON.parse but keeps bare identifiers as strings', () => {
    // `10` → number, `KvFxKaido/Push` → string (parses fail, fall
    // back to raw). Validates the coerceArgValue behavior end-to-end.
    const result = recoverXmlToolCalls(MOBILE_BUG_CAPTURE);
    expect(result[0].args.count).toBe(10);
    expect(result[0].args.repo).toBe('KvFxKaido/Push');
  });

  it('coerces booleans and null in arg values', () => {
    const text = [
      '<tool_call>sandbox_run_tests',
      '<arg_key>verbose</arg_key>',
      '<arg_value>true</arg_value>',
      '<arg_key>only</arg_key>',
      '<arg_value>null</arg_value>',
      '</tool_call>',
    ].join('\n');
    const recovered = recoverXmlToolCalls(text);
    expect(recovered).toHaveLength(1);
    expect(recovered[0].args).toEqual({ verbose: true, only: null });
  });

  it('preserves a quoted string value without the wrapping quotes', () => {
    const text = [
      '<tool_call>write_file',
      '<arg_key>path</arg_key>',
      '<arg_value>"src/index.ts"</arg_value>',
      '</tool_call>',
    ].join('\n');
    expect(recoverXmlToolCalls(text)[0].args).toEqual({ path: 'src/index.ts' });
  });

  it('drops malformed arg pairs (stray arg_key with no matching arg_value)', () => {
    const text = [
      '<tool_call>read_file',
      '<arg_key>orphan</arg_key>',
      '<arg_key>path</arg_key>',
      '<arg_value>TODO.md</arg_value>',
      '</tool_call>',
    ].join('\n');
    expect(recoverXmlToolCalls(text)[0].args).toEqual({ path: 'TODO.md' });
  });

  it('accepts an empty body (zero-arg tool name with no children)', () => {
    const text = '<tool_call>git_status</tool_call>';
    expect(recoverXmlToolCalls(text)).toEqual([{ tool: 'git_status', args: {}, offset: 0 }]);
  });

  it('rejects a tool name that is not a valid identifier', () => {
    const text = '<tool_call>123abc<arg_key>k</arg_key><arg_value>v</arg_value></tool_call>';
    expect(recoverXmlToolCalls(text)).toEqual([]);
  });
});

describe('recoverXmlToolCalls — multiple calls, ordering, prose tolerance', () => {
  it('recovers multiple sequential calls and preserves textual order', () => {
    const text = [
      '<tool_call>{"name": "read_file", "arguments": {"path": "a"}}</tool_call>',
      '<tool_call>read_file',
      '<arg_key>path</arg_key>',
      '<arg_value>b</arg_value>',
      '</tool_call>',
    ].join('\n');
    const recovered = recoverXmlToolCalls(text);
    expect(recovered.map((r) => ({ tool: r.tool, args: r.args }))).toEqual([
      { tool: 'read_file', args: { path: 'a' } },
      { tool: 'read_file', args: { path: 'b' } },
    ]);
    expect(recovered[1].offset).toBeGreaterThan(recovered[0].offset);
  });

  it('ignores `<tool_call>` mentions in prose without closing tags', () => {
    const text = 'Use `<tool_call>` to make a call — but I will not write one now.';
    expect(recoverXmlToolCalls(text)).toEqual([]);
  });

  it('rejects a single `<tool_call>` block surrounded by prose (Codex P1)', () => {
    // The exact false-positive Codex flagged: a closed `<tool_call>`
    // sitting inside prose explaining what NOT to do. Without the
    // whole-message gap gate the dispatcher would promote this to a
    // real exec.
    const text =
      'Do not run <tool_call>exec<arg_key>command</arg_key><arg_value>rm -rf /</arg_value></tool_call> on production.';
    expect(recoverXmlToolCalls(text)).toEqual([]);
  });

  it('rejects an XML block preceded by prose', () => {
    const text =
      'Earlier I called <tool_call>read_file<arg_key>path</arg_key><arg_value>x</arg_value></tool_call>';
    expect(recoverXmlToolCalls(text)).toEqual([]);
  });

  it('rejects an XML block followed by trailing prose', () => {
    const text =
      '<tool_call>read_file<arg_key>path</arg_key><arg_value>x</arg_value></tool_call> — but actually skip this.';
    expect(recoverXmlToolCalls(text)).toEqual([]);
  });

  it('rejects two XML blocks separated by prose', () => {
    const text = [
      '<tool_call>read_file<arg_key>path</arg_key><arg_value>a</arg_value></tool_call>',
      'and then maybe',
      '<tool_call>read_file<arg_key>path</arg_key><arg_value>b</arg_value></tool_call>',
    ].join(' ');
    expect(recoverXmlToolCalls(text)).toEqual([]);
  });

  it('accepts an XML-only message with a stray `json`/`tool` language marker', () => {
    // Mirrors the bare-object eligibility gate's tolerance for a
    // language marker on its own line — some models prefix tool blocks
    // with the language hint even when the wrapper is XML.
    const text = [
      'tool',
      '<tool_call>read_file<arg_key>path</arg_key><arg_value>x</arg_value></tool_call>',
    ].join('\n');
    expect(recoverXmlToolCalls(text)).toEqual([
      { tool: 'read_file', args: { path: 'x' }, offset: 5 },
    ]);
  });

  it('emits zero recoveries on text with no `<tool_call>` tags at all', () => {
    expect(recoverXmlToolCalls('Plain prose. No tags.')).toEqual([]);
  });

  it('tolerates attributes on the opening tag', () => {
    const text = '<tool_call id="0"><arg_key>k</arg_key><arg_value>v</arg_value></tool_call>';
    // No tool name (head text before first child tag is empty), so
    // Shape B's name capture rejects it. The recovery returns empty
    // rather than executing a no-name call.
    expect(recoverXmlToolCalls(text)).toEqual([]);
  });

  it('tolerates an attribute-bearing opening tag when a tool name is present', () => {
    const text =
      '<tool_call id="0">read_file<arg_key>path</arg_key><arg_value>x</arg_value></tool_call>';
    expect(recoverXmlToolCalls(text)).toEqual([
      { tool: 'read_file', args: { path: 'x' }, offset: 0 },
    ]);
  });
});
