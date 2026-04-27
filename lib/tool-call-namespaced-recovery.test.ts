import { describe, it, expect } from 'vitest';
import { recoverNamespacedToolCalls } from './tool-call-namespaced-recovery.js';

describe('recoverNamespacedToolCalls', () => {
  // The exact captured assistant string from session sess_mogit6qt_447633
  // (kimi-k2.6 via blackbox). Three calls vanished silently before this
  // recovery existed.
  const KIMI_CAPTURED =
    ' Hey! Let me check the current state of the project — TODO, roadmap, and what\'s on the branch — so I can give you a useful take.   functions.read_file:0  {"path": "TODO.md"}   functions.read_file:1  {"path": "ROADMAP.md"}   functions.git_status:2  {}  ';

  it('recovers all three calls from the captured Kimi/Blackbox session', () => {
    const recovered = recoverNamespacedToolCalls(KIMI_CAPTURED);
    expect(recovered).toEqual([
      expect.objectContaining({ tool: 'read_file', args: { path: 'TODO.md' } }),
      expect.objectContaining({ tool: 'read_file', args: { path: 'ROADMAP.md' } }),
      expect.objectContaining({ tool: 'git_status', args: {} }),
    ]);
  });

  it('preserves textual order via the offset field', () => {
    const recovered = recoverNamespacedToolCalls(KIMI_CAPTURED);
    for (let i = 1; i < recovered.length; i++) {
      expect(recovered[i].offset).toBeGreaterThan(recovered[i - 1].offset);
    }
  });

  it('treats empty `{}` as empty args (zero-arg tools like git_status)', () => {
    const recovered = recoverNamespacedToolCalls('functions.git_status:0  {}');
    expect(recovered).toEqual([{ tool: 'git_status', args: {}, offset: 0 }]);
  });

  it('treats `null` after the prefix as empty args', () => {
    const recovered = recoverNamespacedToolCalls('functions.git_status:0  null');
    expect(recovered).toEqual([{ tool: 'git_status', args: {}, offset: 0 }]);
  });

  it('does not recover prose mentions of the prefix without trailing JSON', () => {
    const text = 'See the `functions.read_file:0` helper for an example.';
    expect(recoverNamespacedToolCalls(text)).toEqual([]);
  });

  it('skips a prefix whose args object is malformed past repair', () => {
    const text = 'functions.read_file:0  {not_json}';
    expect(recoverNamespacedToolCalls(text)).toEqual([]);
  });

  it('does not pair a prefix with a JSON object that is far away in the text', () => {
    // 100+ chars of prose between prefix and JSON exceeds MAX_PREFIX_TO_ARGS_GAP.
    const filler = ' '.repeat(80);
    const text = `functions.read_file:0${filler}{"path": "TODO.md"}`;
    expect(recoverNamespacedToolCalls(text)).toEqual([]);
  });

  it('ignores nested braces inside string values when finding the object end', () => {
    const text = 'functions.exec:0  {"command": "echo \\"} hi\\""}';
    const recovered = recoverNamespacedToolCalls(text);
    expect(recovered).toEqual([{ tool: 'exec', args: { command: 'echo "} hi"' }, offset: 0 }]);
  });

  it('recovers consecutive calls without leaking the first into the second', () => {
    const text = 'functions.read_file:0  {"path": "a"}  functions.read_file:1  {"path": "b"}';
    const recovered = recoverNamespacedToolCalls(text);
    expect(recovered).toEqual([
      { tool: 'read_file', args: { path: 'a' }, offset: 0 },
      expect.objectContaining({ tool: 'read_file', args: { path: 'b' } }),
    ]);
    expect(recovered[1].offset).toBeGreaterThan(recovered[0].offset);
  });

  it('emits zero recoveries on text with no namespaced prefix', () => {
    const text = 'Plain prose with a `{"path": "TODO.md"}` example object.';
    expect(recoverNamespacedToolCalls(text)).toEqual([]);
  });

  it('rejects single prose mention even when followed by valid JSON', () => {
    // Codex P1: without the trailing-context gate, this would recover as
    // a real exec call — exactly the rm -rf risk the gate exists to block.
    const text = 'Note: ignore functions.exec:0 {"command":"rm -rf /"} mention is just prose.';
    expect(recoverNamespacedToolCalls(text)).toEqual([]);
  });

  it('accepts a recovered call followed only by trailing whitespace', () => {
    const text = 'functions.read_file:0 {"path": "TODO.md"}   ';
    const recovered = recoverNamespacedToolCalls(text);
    expect(recovered).toHaveLength(1);
    expect(recovered[0].tool).toBe('read_file');
  });

  it('accepts batched calls followed by trailing whitespace at the end', () => {
    const text = 'functions.read_file:0 {"path": "a"}  functions.read_file:1 {"path": "b"}   ';
    expect(recoverNamespacedToolCalls(text)).toHaveLength(2);
  });

  it('repairs args with trailing commas via shape-agnostic repair', () => {
    const text = 'functions.read_file:0 {"path": "TODO.md",}';
    const recovered = recoverNamespacedToolCalls(text);
    expect(recovered).toEqual([{ tool: 'read_file', args: { path: 'TODO.md' }, offset: 0 }]);
  });

  it('rejects an args object that itself carries a "tool" key', () => {
    // Ambiguous: was the model trying to nest a canonical wrapper inside a
    // namespaced trace? Drop rather than misinterpret.
    const text = 'functions.read_file:0 {"tool": "exec", "command": "rm -rf /"}';
    expect(recoverNamespacedToolCalls(text)).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Truncation auto-close — the deferred Gemini orange from PR #422
  // -------------------------------------------------------------------------

  it('recovers a truncated args object missing one closing brace', () => {
    const text = 'functions.read_file:0 {"path": "TODO.md"';
    expect(recoverNamespacedToolCalls(text)).toEqual([
      { tool: 'read_file', args: { path: 'TODO.md' }, offset: 0 },
    ]);
  });

  it('recovers a truncated args object with nested braces missing closers', () => {
    const text = 'functions.exec:0 {"command": "ls", "env": {"DEBUG": "1"';
    expect(recoverNamespacedToolCalls(text)).toEqual([
      { tool: 'exec', args: { command: 'ls', env: { DEBUG: '1' } }, offset: 0 },
    ]);
  });

  it('rejects truncation that ends inside an open string (false-positive guard)', () => {
    // Codex P1 on PR #423: without the in-string gate, this could
    // also "recover" prose like `... functions.exec:0 {"command":"rm`
    // followed by ordinary text — auto-closing inside an open string
    // would either fabricate a value or sweep prose into args. Both
    // failure modes are real-tool-execution risks; we drop the
    // ambiguous case rather than guess.
    const text = 'functions.read_file:0 {"path": "TODO';
    expect(recoverNamespacedToolCalls(text)).toEqual([]);
  });

  it('rejects truncation where an open string runs into prose', () => {
    // The exact false-positive Codex flagged: brace opened, string
    // opened, then natural-language prose continues without a closing
    // quote. Auto-close would package the prose as a path arg.
    const text = 'Hmm, let me think. functions.read_file:0 {"path": "TODO but I changed my mind';
    expect(recoverNamespacedToolCalls(text)).toEqual([]);
  });

  it('does not auto-close when truncation contains a second functions.* prefix', () => {
    // The first call's args is truncated and the second call's prefix
    // appears inside the broken region. Sweeping the second prefix into
    // the first's args would misinterpret two calls as one mangled one,
    // so we drop the broken first and let the regex find the second.
    const text = 'functions.read_file:0 {"path": "TODO.md" functions.list_dir:1 {"path": "."}';
    const recovered = recoverNamespacedToolCalls(text);
    expect(recovered).toEqual([
      { tool: 'list_dir', args: { path: '.' }, offset: expect.any(Number) },
    ]);
  });

  it('does not auto-close when truncation depth exceeds three openers', () => {
    // Deeply nested truncation often signals more serious malformation
    // — autoClose's depth cap (matches the canonical helper's cap of 3)
    // bails rather than guess wildly.
    const text = 'functions.exec:0 {"a": {"b": {"c": {"d": "value"';
    expect(recoverNamespacedToolCalls(text)).toEqual([]);
  });

  it('treats functions.* inside a string literal as data, not as a second call', () => {
    // Copilot review on PR #423: without string-aware scanning, the
    // prefix inside the string value would falsely suppress the
    // truncation recovery. The args contain a literal mention of the
    // namespaced format (e.g., a docs example) but the call itself is
    // a clean truncation of one read_file call.
    const text =
      'functions.read_file:0 {"path": "docs/examples.md", "note": "see functions.foo:1 for an example"';
    const recovered = recoverNamespacedToolCalls(text);
    expect(recovered).toEqual([
      {
        tool: 'read_file',
        args: {
          path: 'docs/examples.md',
          note: 'see functions.foo:1 for an example',
        },
        offset: 0,
      },
    ]);
  });
});
