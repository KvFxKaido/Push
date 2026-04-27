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
});
