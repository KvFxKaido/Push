import { describe, it, expect } from 'vitest';
import { recoverXmlToolCalls } from './tool-call-xml-recovery.js';

describe('recoverXmlToolCalls — Shape A (Hermes/Qwen JSON inside tag)', () => {
  it('recovers a single `{name, arguments}` body', () => {
    const text = '<tool_call>{"name": "read_file", "arguments": {"path": "TODO.md"}}</tool_call>';
    expect(recoverXmlToolCalls(text)).toEqual([
      expect.objectContaining({ tool: 'read_file', args: { path: 'TODO.md' }, offset: 0 }),
    ]);
  });

  it('accepts the Push-canonical `{tool, args}` body shape too', () => {
    // Some finetunes use Push's own wrapper keys inside the XML tag —
    // we accept both rather than forcing the model to pick one.
    const text = '<tool_call>{"tool": "git_status", "args": {}}</tool_call>';
    expect(recoverXmlToolCalls(text)).toEqual([
      expect.objectContaining({ tool: 'git_status', args: {}, offset: 0 }),
    ]);
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
      expect.objectContaining({ tool: 'read_file', args: { path: 'TODO.md' }, offset: 0 }),
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
      expect.objectContaining({
        tool: 'commits',
        args: { count: 10, repo: 'KvFxKaido/Push' },
        offset: 0,
      }),
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
    expect(recoverXmlToolCalls(text)).toEqual([
      expect.objectContaining({ tool: 'git_status', args: {}, offset: 0 }),
    ]);
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
      expect.objectContaining({ tool: 'read_file', args: { path: 'x' }, offset: 5 }),
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
      expect.objectContaining({ tool: 'read_file', args: { path: 'x' }, offset: 0 }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// Shape C — Anthropic's documented `<function_calls>` + `<invoke>` +
// `<parameter>` format. Visible in the wild from models trained on the
// public Claude tool-use protocol; before this recovery existed they
// fell through entirely (extractBareToolJsonObjects sees no JSON, the
// `<tool_call>` regex doesn't match), so the Explorer terminated with
// zero tool execution on a turn that contained a legitimate intent.
// ---------------------------------------------------------------------------
describe('recoverXmlToolCalls — Shape C (Anthropic function_calls/invoke/parameter)', () => {
  it('recovers a single invoke with one parameter', () => {
    const text = [
      '<function_calls>',
      '<invoke name="read">',
      '<parameter name="path">/workspace/README.md</parameter>',
      '</invoke>',
      '</function_calls>',
    ].join('\n');
    const recovered = recoverXmlToolCalls(text);
    expect(recovered).toHaveLength(1);
    expect(recovered[0].tool).toBe('read');
    expect(recovered[0].args).toEqual({ path: '/workspace/README.md' });
  });

  it('expands multiple invoke children of one function_calls wrapper into separate calls', () => {
    const text = [
      '<function_calls>',
      '<invoke name="read"><parameter name="path">/a</parameter></invoke>',
      '<invoke name="diff"></invoke>',
      '</function_calls>',
    ].join('\n');
    const recovered = recoverXmlToolCalls(text);
    expect(recovered.map((r) => r.tool)).toEqual(['read', 'diff']);
    expect(recovered[0].args).toEqual({ path: '/a' });
    expect(recovered[1].args).toEqual({});
  });

  it('coerces JSON-shaped parameter values (numbers, booleans, arrays)', () => {
    const text = [
      '<function_calls>',
      '<invoke name="edit_range">',
      '<parameter name="path">/a</parameter>',
      '<parameter name="start_line">10</parameter>',
      '<parameter name="end_line">12</parameter>',
      '<parameter name="content">replacement</parameter>',
      '</invoke>',
      '</function_calls>',
    ].join('\n');
    const recovered = recoverXmlToolCalls(text);
    expect(recovered).toHaveLength(1);
    expect(recovered[0].args).toEqual({
      path: '/a',
      start_line: 10,
      end_line: 12,
      content: 'replacement',
    });
  });

  it('tolerates single-quoted or unquoted name attributes', () => {
    const text = [
      "<function_calls><invoke name='read'><parameter name=path>/a</parameter></invoke></function_calls>",
    ].join('\n');
    const recovered = recoverXmlToolCalls(text);
    // `<invoke>` is at position 16 (after the opening `<function_calls>`
    // tag) — pre-PR #683 fix this would have asserted `offset: 0` which
    // pinned the off-by-N bug Copilot caught.
    const expectedOffset = text.indexOf('<invoke');
    expect(recovered).toEqual([
      expect.objectContaining({ tool: 'read', args: { path: '/a' }, offset: expectedOffset }),
    ]);
  });

  it('rejects a function_calls block embedded in prose (eligibility gate)', () => {
    // Mirrors the Shape A/B gate: a stray mention in prose must not
    // execute. Without this, "do not run <function_calls>...</function_calls>"
    // would slip through.
    const text =
      'Do not run <function_calls><invoke name="read"><parameter name="path">/a</parameter></invoke></function_calls> in production.';
    expect(recoverXmlToolCalls(text)).toEqual([]);
  });

  it('returns offsets anchored to each invoke so dispatcher ordering is preserved', () => {
    const text = [
      '<function_calls>',
      '<invoke name="a"><parameter name="x">1</parameter></invoke>',
      '<invoke name="b"><parameter name="y">2</parameter></invoke>',
      '</function_calls>',
    ].join('\n');
    const recovered = recoverXmlToolCalls(text);
    expect(recovered).toHaveLength(2);
    expect(recovered[0].offset).toBeLessThan(recovered[1].offset);
  });

  it('mixes with `<tool_call>` blocks in the same message and preserves textual order', () => {
    const text = [
      '<tool_call>{"name":"first","arguments":{}}</tool_call>',
      '<function_calls><invoke name="second"></invoke></function_calls>',
    ].join('\n');
    const recovered = recoverXmlToolCalls(text);
    expect(recovered.map((r) => r.tool)).toEqual(['first', 'second']);
  });

  it('emits nothing for a function_calls block with no invoke children — the hybrid JSON case is handled upstream', () => {
    // The model in the original failure log emitted
    //   <function_calls>{"tool":"sandbox","args":{...}}</function_calls>
    // The bare JSON is found by extractBareToolJsonObjects and surfaces
    // as a dropped candidate (no source claims "sandbox"). This recovery
    // intentionally does NOT also emit a call from the same payload —
    // otherwise we'd double-report.
    const text =
      '<function_calls>{"tool":"sandbox","args":{"command":"read","path":"/a"}}</function_calls>';
    expect(recoverXmlToolCalls(text)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Shape D — namespace-token-wrapped tags. DeepSeek-family finetunes emit
// the Anthropic invoke/parameter shape with each tag wrapped in a
// chat-template namespace token (`<|DSML|invoke …>` / `</|DSML|invoke>`),
// using a `tool_calls` (plural) wrapper. Before this recovery the call
// leaked into visible content verbatim and never executed — the exact
// capture below is the mobile-app screenshot that motivated the fix.
// ---------------------------------------------------------------------------
describe('recoverXmlToolCalls — Shape D (namespace-token-wrapped invoke/parameter)', () => {
  it('recovers the exact DeepSeek `<|DSML|…>` screenshot capture', () => {
    const text =
      '<|DSML|tool_calls><|DSML|invoke name="openrouter_web_search">' +
      '<|DSML|parameter name="query" string="true">github.com/KvFxKaido/Push</|DSML|parameter>' +
      '</|DSML|invoke></|DSML|tool_calls>';
    expect(recoverXmlToolCalls(text)).toEqual([
      expect.objectContaining({
        tool: 'openrouter_web_search',
        args: { query: 'github.com/KvFxKaido/Push' },
      }),
    ]);
  });

  it('tolerates the full-width pipe `｜` (U+FF5C) delimiter open-weight templates use', () => {
    const text =
      '<｜DSML｜tool_calls><｜DSML｜invoke name="read">' +
      '<｜DSML｜parameter name="path">/workspace/README.md</｜DSML｜parameter>' +
      '</｜DSML｜invoke></｜DSML｜tool_calls>';
    const recovered = recoverXmlToolCalls(text);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ tool: 'read', args: { path: '/workspace/README.md' } });
  });

  it('recovers the doubled full-width DeepSeek V4 Pro DSML batch after an assistant preamble', () => {
    const text = [
      "Let me pull up the open issues so I can give you a real read on what's ripe.",
      '',
      '<｜｜DSML｜｜tool_calls>',
      '<｜｜DSML｜｜invoke name="issue">',
      '<｜｜DSML｜｜parameter name="repo" string="true">KvFxKaido/Push</｜｜DSML｜｜parameter>',
      '<｜｜DSML｜｜parameter name="issue_number" string="true">1260</｜｜DSML｜｜parameter>',
      '</｜｜DSML｜｜invoke>',
      '<｜｜DSML｜｜invoke name="issue">',
      '<｜｜DSML｜｜parameter name="repo" string="true">KvFxKaido/Push</｜｜DSML｜｜parameter>',
      '<｜｜DSML｜｜parameter name="issue_number" string="true">1226</｜｜DSML｜｜parameter>',
      '</｜｜DSML｜｜invoke>',
      '<｜｜DSML｜｜invoke name="issue">',
      '<｜｜DSML｜｜parameter name="repo" string="true">KvFxKaido/Push</｜｜DSML｜｜parameter>',
      '<｜｜DSML｜｜parameter name="issue_number" string="true">1190</｜｜DSML｜｜parameter>',
      '</｜｜DSML｜｜invoke>',
      '<｜｜DSML｜｜invoke name="issue">',
      '<｜｜DSML｜｜parameter name="repo" string="true">KvFxKaido/Push</｜｜DSML｜｜parameter>',
      '<｜｜DSML｜｜parameter name="issue_number" string="true">1169</｜｜DSML｜｜parameter>',
      '</｜｜DSML｜｜invoke>',
      '<｜｜DSML｜｜invoke name="issue">',
      '<｜｜DSML｜｜parameter name="repo" string="true">KvFxKaido/Push</｜｜DSML｜｜parameter>',
      '<｜｜DSML｜｜parameter name="issue_number" string="true">1048</｜｜DSML｜｜parameter>',
      '</｜｜DSML｜｜invoke>',
      '</｜｜DSML｜｜tool_calls>',
    ].join('\n');

    const recovered = recoverXmlToolCalls(text);
    expect(recovered).toHaveLength(5);
    expect(recovered.map((r) => r.tool)).toEqual(['issue', 'issue', 'issue', 'issue', 'issue']);
    expect(recovered.map((r) => r.args)).toEqual([
      { repo: 'KvFxKaido/Push', issue_number: 1260 },
      { repo: 'KvFxKaido/Push', issue_number: 1226 },
      { repo: 'KvFxKaido/Push', issue_number: 1190 },
      { repo: 'KvFxKaido/Push', issue_number: 1169 },
      { repo: 'KvFxKaido/Push', issue_number: 1048 },
    ]);
    expect(recovered[0].offset).toBe(text.indexOf('<｜｜DSML｜｜invoke'));
  });

  it('expands multiple namespaced invoke children of one tool_calls wrapper', () => {
    const text =
      '<|DSML|tool_calls>' +
      '<|DSML|invoke name="read"><|DSML|parameter name="path">/a</|DSML|parameter></|DSML|invoke>' +
      '<|DSML|invoke name="diff"></|DSML|invoke>' +
      '</|DSML|tool_calls>';
    const recovered = recoverXmlToolCalls(text);
    expect(recovered.map((r) => r.tool)).toEqual(['read', 'diff']);
    expect(recovered[0].args).toEqual({ path: '/a' });
    expect(recovered[1].args).toEqual({});
  });

  it('ignores stray attributes on the namespaced parameter tag (e.g. `string="true"`)', () => {
    const text =
      '<|DSML|tool_calls><|DSML|invoke name="exec">' +
      '<|DSML|parameter name="command" string="true">ls -la</|DSML|parameter>' +
      '</|DSML|invoke></|DSML|tool_calls>';
    expect(recoverXmlToolCalls(text)[0].args).toEqual({ command: 'ls -la' });
  });

  it('anchors offsets to the original text despite the namespace prefix', () => {
    const text =
      '<|DSML|tool_calls><|DSML|invoke name="read">' +
      '<|DSML|parameter name="path">/a</|DSML|parameter>' +
      '</|DSML|invoke></|DSML|tool_calls>';
    const [r] = recoverXmlToolCalls(text);
    // offset/endOffset bound the `<|DSML|invoke>` child, not the wrapper,
    // and are positions in the *original* string — not a normalized copy.
    expect(r.offset).toBe(text.indexOf('<|DSML|invoke'));
    expect(r.endOffset).toBe(text.indexOf('</|DSML|invoke>') + '</|DSML|invoke>'.length);
  });

  it('rejects a namespaced block embedded in prose (eligibility gate still applies)', () => {
    const text =
      'Do not run <|DSML|tool_calls><|DSML|invoke name="exec">' +
      '<|DSML|parameter name="command">rm -rf /</|DSML|parameter>' +
      '</|DSML|invoke></|DSML|tool_calls> in production.';
    expect(recoverXmlToolCalls(text)).toEqual([]);
  });

  it('keeps rejecting non-action prose before a wrapped namespaced block', () => {
    const text =
      'For example:\n\n<|DSML|tool_calls><|DSML|invoke name="exec">' +
      '<|DSML|parameter name="command">rm -rf /</|DSML|parameter>' +
      '</|DSML|invoke></|DSML|tool_calls>';
    expect(recoverXmlToolCalls(text)).toEqual([]);
  });

  it('still recovers a plain (non-namespaced) function_calls block — NS is optional', () => {
    const text =
      '<function_calls><invoke name="read"><parameter name="path">/a</parameter></invoke></function_calls>';
    expect(recoverXmlToolCalls(text)).toEqual([
      expect.objectContaining({ tool: 'read', args: { path: '/a' } }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// Shape E — standalone `<invoke>` elements with no `<function_calls>` /
// `<tool_calls>` wrapper. Observed from x-ai/grok-code-fast-1, which emits
// the Anthropic invoke/parameter shape but drops the outer wrapper, so a
// single `<invoke name="search"><parameter …></invoke>` leaks into the
// content stream and previously matched no recovery shape at all.
// ---------------------------------------------------------------------------
describe('recoverXmlToolCalls — Shape E (standalone invoke, no wrapper)', () => {
  it('recovers a wrapperless invoke with one parameter', () => {
    const text = '<invoke name="search"><parameter name="query">forestore</parameter></invoke>';
    const recovered = recoverXmlToolCalls(text);
    expect(recovered).toHaveLength(1);
    expect(recovered[0].tool).toBe('search');
    expect(recovered[0].args).toEqual({ query: 'forestore' });
  });

  it('anchors offset/endOffset to the standalone invoke element', () => {
    const text = '<invoke name="search"><parameter name="query">a</parameter></invoke>';
    const recovered = recoverXmlToolCalls(text);
    expect(recovered).toHaveLength(1);
    expect(recovered[0].offset).toBe(text.indexOf('<invoke'));
    expect(recovered[0].endOffset).toBe(text.length);
  });

  it('recovers multiple sibling wrapperless invokes in textual order', () => {
    const text = [
      '<invoke name="read"><parameter name="path">/a</parameter></invoke>',
      '<invoke name="diff"></invoke>',
    ].join('\n');
    const recovered = recoverXmlToolCalls(text);
    expect(recovered.map((r) => r.tool)).toEqual(['read', 'diff']);
    expect(recovered[0].args).toEqual({ path: '/a' });
    expect(recovered[1].args).toEqual({});
    expect(recovered[0].offset).toBeLessThan(recovered[1].offset);
  });

  it('does NOT double-count an invoke that sits inside a function_calls wrapper', () => {
    // The wrapper path already expands this invoke; the standalone scan
    // must filter it out so the dispatcher does not see it twice.
    const text =
      '<function_calls><invoke name="read"><parameter name="path">/a</parameter></invoke></function_calls>';
    const recovered = recoverXmlToolCalls(text);
    expect(recovered).toHaveLength(1);
    expect(recovered[0].tool).toBe('read');
  });

  it('rejects a standalone invoke embedded in prose (eligibility gate)', () => {
    const text =
      'Do not run <invoke name="exec"><parameter name="command">rm -rf /</parameter></invoke> in production.';
    expect(recoverXmlToolCalls(text)).toEqual([]);
  });

  it('coerces JSON-shaped parameter values on a wrapperless invoke', () => {
    const text =
      '<invoke name="edit_range"><parameter name="start_line">10</parameter><parameter name="enabled">true</parameter></invoke>';
    const recovered = recoverXmlToolCalls(text);
    expect(recovered).toHaveLength(1);
    expect(recovered[0].args).toEqual({ start_line: 10, enabled: true });
  });

  // The standalone scan reuses INVOKE_TAG_REGEX, whose `NS` prefix is
  // optional, so a namespace-token-wrapped standalone invoke (the Shape D
  // tag style emitted WITHOUT its usual <｜DSML｜tool_calls｜> wrapper) is
  // recovered too — both the ASCII-pipe and full-width-pipe delimiters.
  it('recovers a namespace-token-wrapped standalone invoke (ASCII pipe)', () => {
    const text =
      '<|DSML|invoke name="search"><|DSML|parameter name="query">a</|DSML|parameter></|DSML|invoke>';
    const recovered = recoverXmlToolCalls(text);
    expect(recovered).toHaveLength(1);
    expect(recovered[0].tool).toBe('search');
    expect(recovered[0].args).toEqual({ query: 'a' });
  });

  it('recovers a namespace-token-wrapped standalone invoke (full-width pipe)', () => {
    const text =
      '<｜DSML｜invoke name="search"><｜DSML｜parameter name="query">a</｜DSML｜parameter></｜DSML｜invoke>';
    const recovered = recoverXmlToolCalls(text);
    expect(recovered).toHaveLength(1);
    expect(recovered[0].tool).toBe('search');
    expect(recovered[0].args).toEqual({ query: 'a' });
  });
});

// ---------------------------------------------------------------------------
// Nested-wrapper regression — Codex P1 review on PR #600. A literal
// `<function_calls>...</function_calls>` string embedded inside a
// `<tool_call>` arg value (e.g. documentation snippets in an edit_file
// `content` arg) used to bypass the eligibility gate's suffix check and
// drop the outer call. The dedupe pass keeps the outer wrapper and
// ignores the inner.
// ---------------------------------------------------------------------------
describe('recoverXmlToolCalls — nested wrappers do not break the outer call', () => {
  it('keeps a tool_call whose arg value literally contains a <function_calls> block', () => {
    const text = [
      '<tool_call>write_file',
      '<arg_key>path</arg_key>',
      '<arg_value>/workspace/docs/tools.md</arg_value>',
      '<arg_key>content</arg_key>',
      '<arg_value>Example tool call: <function_calls><invoke name="read"><parameter name="path">/foo</parameter></invoke></function_calls></arg_value>',
      '</tool_call>',
    ].join('\n');
    const recovered = recoverXmlToolCalls(text);
    expect(recovered).toHaveLength(1);
    expect(recovered[0].tool).toBe('write_file');
    expect(recovered[0].args).toMatchObject({ path: '/workspace/docs/tools.md' });
    // The nested function_calls inside the arg value must NOT have
    // produced its own recovered call — otherwise the dispatcher would
    // execute the docs example as a real read.
    expect(recovered).toHaveLength(1);
  });

  it('keeps a function_calls call whose parameter value embeds a tool_call literal', () => {
    const text = [
      '<function_calls>',
      '<invoke name="write_file">',
      '<parameter name="path">/workspace/docs/tools.md</parameter>',
      '<parameter name="content">Hermes shape: <tool_call>{"name":"read","arguments":{"path":"/foo"}}</tool_call></parameter>',
      '</invoke>',
      '</function_calls>',
    ].join('\n');
    const recovered = recoverXmlToolCalls(text);
    expect(recovered).toHaveLength(1);
    expect(recovered[0].tool).toBe('write_file');
  });
});

// ---------------------------------------------------------------------------
// endOffset — exact `[offset, endOffset)` region for the recovered call,
// so callers can detect when a bare JSON object found by their own scan
// is actually the args portion of this recovery. Replaces the regex
// lookback that PR #681 used. PR #683 follow-up.
// ---------------------------------------------------------------------------

describe('recoverXmlToolCalls — endOffset', () => {
  it('endOffset for a `<tool_call>` block ends one past `</tool_call>`', () => {
    const text = '<tool_call>{"name": "read_file", "arguments": {"path": "a.txt"}}</tool_call>';
    const [r] = recoverXmlToolCalls(text);
    expect(r.offset).toBe(0);
    expect(r.endOffset).toBe(text.length);
  });

  it('endOffset for a `<function_calls>` invoke child bounds the `<invoke>`, not the wrapper', () => {
    const text = [
      '<function_calls>',
      '<invoke name="read"><parameter name="path">/a</parameter></invoke>',
      '<invoke name="write"><parameter name="path">/b</parameter></invoke>',
      '</function_calls>',
    ].join('\n');
    const [read, write] = recoverXmlToolCalls(text);
    // ABSOLUTE positions — text.indexOf nails the actual `<invoke` /
    // `</invoke>` positions in the source string, so a bug that
    // shifted offsets earlier (Copilot review on PR #683 caught this:
    // `m.blockStart + invoke.innerOffset` undercounted by the opening
    // `<function_calls>` tag's length) would fail these assertions.
    // Pre-fix, this test passed with relative-only checks.
    expect(read.offset).toBe(text.indexOf('<invoke name="read"'));
    expect(read.endOffset).toBe(text.indexOf('</invoke>', read.offset) + '</invoke>'.length);
    expect(write.offset).toBe(text.indexOf('<invoke name="write"'));
    expect(write.endOffset).toBe(text.indexOf('</invoke>', write.offset) + '</invoke>'.length);
    // Sanity invariants — also caught the absolute bug in isolation.
    expect(read.offset).toBeLessThan(read.endOffset);
    expect(read.endOffset).toBeLessThanOrEqual(write.offset);
    expect(write.endOffset).toBeLessThan(text.length);
  });

  it('endOffset for back-to-back `<tool_call>` blocks bounds each one independently', () => {
    const first = '<tool_call>{"name": "read_file", "arguments": {"path": "a"}}</tool_call>';
    const second = '<tool_call>{"name": "read_file", "arguments": {"path": "b"}}</tool_call>';
    const text = `${first}\n${second}`;
    const [r1, r2] = recoverXmlToolCalls(text);
    expect(r1.endOffset).toBeLessThan(r2.offset);
    expect(r2.endOffset).toBe(text.length);
  });
});
