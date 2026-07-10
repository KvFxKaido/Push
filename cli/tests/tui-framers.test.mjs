/**
 * tui-framers.test.mjs — Per-role transcript framer snapshots.
 *
 * These goldens are the regression net for the framer extraction. Every
 * supported entry role is rendered with `tier: 'none'` (so no ANSI escapes
 * leak into the output) and asserted line-for-line. If a framer's shape
 * changes the assertions here must change in the same PR — that's the
 * point.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { renderEntryLines, looksLikeUnifiedDiff } from '../tui-framers.ts';
import { createTheme } from '../tui-theme.ts';

const WIDTH = 80;

function makeTheme() {
  return createTheme({ tier: 'none', unicode: true, name: 'default' });
}

function render(entry, ctx = {}) {
  const out = [];
  renderEntryLines(out, entry, WIDTH, makeTheme(), ctx);
  return out;
}

// Bullet-led, badge-free shapes. Single framer table since the original
// "standard" badge-led variant was retired.

describe('renderEntryLines: user / assistant', () => {
  it('renders user with accent bullet', () => {
    assert.deepEqual(render({ role: 'user', text: 'hello' }), ['• hello']);
  });

  it('renders assistant plain text with muted bullet', () => {
    assert.deepEqual(render({ role: 'assistant', text: 'hello' }), ['• hello']);
  });

  it('keeps markdown handling under the bullet prefix', () => {
    assert.deepEqual(render({ role: 'assistant', text: '# Title' }), ['• Title']);
    assert.deepEqual(render({ role: 'assistant', text: '- item' }), ['• - item']);
  });

  it('renders code fence with bullet on label, 2-space indent on body', () => {
    assert.deepEqual(render({ role: 'assistant', text: '```js\nconst x = 1;\n```' }), [
      '• code (js)',
      '  const x = 1;',
    ]);
  });

  it('renders JSON tool-call fence as collapsed payload header + summary', () => {
    // The collapsed-payload path lives in renderAssistantEntryLines; the
    // pre-cleanup version had a snapshot for it under the badge-led
    // standard layout. Copilot review on PR #552: this assertion was lost
    // in the deletion. Pinning under the bullet-led renderer keeps the
    // JSON-fence path covered.
    const lines = render({
      role: 'assistant',
      text: '```json\n{"tool":"Read","args":{"path":"a.ts"}}\n```',
    });
    assert.deepEqual(lines, ['• ▸ JSON payload · 1 tool call · collapsed', '  → Read  a.ts']);
  });

  it('wraps long user text with bullet on first line, 2-space continuation indent', () => {
    // The earlier badge-led test pinned wrap behavior via the 6-space
    // continuation indent for the ` YOU ` badge. Bullet-led continuation
    // is 2 spaces; this snapshot pins that under the surviving renderer.
    const long = 'a '.repeat(50).trim(); // 99 chars; wraps under 80-col window
    const lines = render({ role: 'user', text: long });
    assert.ok(lines.length >= 2, 'expected wrap to produce 2+ lines');
    assert.ok(lines[0].startsWith('•'));
    for (let i = 1; i < lines.length; i++) {
      assert.ok(lines[i].startsWith('  '), `line ${i} should have 2-space indent`);
    }
  });
});

describe('renderEntryLines: tool_call', () => {
  it('renders pending call with bullet, status icon, and parens-wrapped args', () => {
    const lines = render({
      role: 'tool_call',
      text: 'Read',
      args: { path: 'src/foo.ts' },
    });
    assert.deepEqual(lines, ['• … Read(src/foo.ts)']);
  });

  it('renders successful call with branch-line trailer for result preview', () => {
    const lines = render({
      role: 'tool_call',
      text: 'Read',
      args: { path: 'src/foo.ts' },
      duration: 42,
      resultPreview: 'first line of output\nrest ignored',
    });
    assert.deepEqual(lines, ['• ✓ Read(src/foo.ts) 42ms', '  └─ first line of output']);
  });

  it('renders errored call with cross icon, no trailer', () => {
    const lines = render({
      role: 'tool_call',
      text: 'Bash',
      args: { command: 'false' },
      error: true,
      duration: 5,
    });
    assert.deepEqual(lines, ['• ✗ Bash(false) 5ms']);
  });
});

describe('renderEntryLines: tool_call edit card (structured editDiff)', () => {
  const editDiff = {
    path: 'src/foo.ts',
    adds: 1,
    dels: 1,
    lines: [
      { kind: 'ctx', oldLine: 1, newLine: 1, text: 'alpha' },
      { kind: 'del', oldLine: 2, text: 'old line' },
      { kind: 'add', newLine: 2, text: 'new line' },
      { kind: 'ctx', oldLine: 3, newLine: 3, text: 'omega' },
    ],
  };

  it('replaces the preview trailer with a line-numbered diff card', () => {
    const lines = render({
      role: 'tool_call',
      text: 'edit_file',
      args: { path: 'src/foo.ts' },
      duration: 12,
      resultPreview: 'Applied 1 hashline edits to src/foo.ts',
      editDiff,
    });
    assert.deepEqual(lines, [
      '• ✓ edit_file(src/foo.ts) 12ms',
      '  └─ +1 -1',
      '     1   alpha',
      '     2 - old line',
      '     2 + new line',
      '     3   omega',
    ]);
  });

  it('summarizes pure additions as "Added N lines" and renders hunk gaps', () => {
    const lines = render({
      role: 'tool_call',
      text: 'edit_file',
      args: { path: 'a.md' },
      duration: 3,
      editDiff: {
        path: 'a.md',
        adds: 2,
        dels: 0,
        lines: [
          { kind: 'add', newLine: 2, text: 'first' },
          { kind: 'ctx', oldLine: 9, newLine: 10, text: 'far away' },
          { kind: 'add', newLine: 11, text: 'second' },
        ],
      },
    });
    assert.deepEqual(lines, [
      '• ✓ edit_file(a.md) 3ms',
      '  └─ Added 2 lines',
      '      2 + first',
      '        ⋮',
      '     10   far away',
      '     11 + second',
    ]);
  });

  it('marks a payload-truncated diff', () => {
    const lines = render({
      role: 'tool_call',
      text: 'write_file',
      args: { path: 'big.txt' },
      duration: 7,
      editDiff: {
        path: 'big.txt',
        adds: 500,
        dels: 0,
        lines: [{ kind: 'add', newLine: 1, text: 'head' }],
        truncated: true,
      },
    });
    assert.deepEqual(lines, [
      '• ✓ write_file(big.txt) 7ms',
      '  └─ Added 500 lines',
      '     1 + head',
      '     … diff truncated',
    ]);
  });

  it('ignores a malformed editDiff and falls back to the preview trailer', () => {
    const lines = render({
      role: 'tool_call',
      text: 'edit_file',
      args: { path: 'x.ts' },
      duration: 2,
      resultPreview: 'Applied 1 hashline edits to x.ts',
      editDiff: { path: 'x.ts', lines: 'nope' },
    });
    assert.deepEqual(lines, ['• ✓ edit_file(x.ts) 2ms', '  └─ Applied 1 hashline edits to x.ts']);
  });

  it('keeps the plain error rendering when the call failed', () => {
    const lines = render({
      role: 'tool_call',
      text: 'edit_file',
      args: { path: 'x.ts' },
      duration: 2,
      error: true,
      editDiff,
    });
    assert.deepEqual(lines, ['• ✗ edit_file(x.ts) 2ms']);
  });
});

describe('renderEntryLines: activity_group', () => {
  const editDiff = {
    path: 'src/foo.ts',
    adds: 1,
    dels: 1,
    lines: [
      { kind: 'del', oldLine: 2, text: 'old line' },
      { kind: 'add', newLine: 2, text: 'new line' },
    ],
  };

  it('renders a chronological compact work log while keeping edits visible', () => {
    assert.deepEqual(
      render({
        role: 'activity_group',
        expanded: true,
        items: [
          { kind: 'thought', duration: 800, text: 'private reasoning' },
          {
            kind: 'tool',
            text: 'read_file',
            args: { path: 'src/foo.ts' },
            duration: 42,
            resultPreview: 'file contents stay folded',
          },
          {
            kind: 'tool',
            text: 'edit_file',
            args: { path: 'src/foo.ts' },
            duration: 12,
            editDiff,
          },
        ],
      }),
      [
        '▾ 3 steps · 1 edit',
        '  ◆ Thought for 800ms',
        '  ◆ Read src/foo.ts  42ms',
        '  ◆ Edit src/foo.ts  12ms',
        '  └─ +1 -1',
        '     2 - old line',
        '     2 + new line',
      ],
    );
  });

  it('folds a whole phase to one aggregate row', () => {
    assert.deepEqual(
      render({
        role: 'activity_group',
        expanded: false,
        items: [
          { kind: 'thought', duration: 1200 },
          { kind: 'tool', text: 'exec', args: { command: 'npm test' }, duration: 500 },
        ],
      }),
      ['▸ 2 steps'],
    );
  });

  it('automatically exposes failed result context', () => {
    assert.deepEqual(
      render({
        role: 'activity_group',
        expanded: true,
        items: [
          {
            kind: 'tool',
            text: 'exec',
            args: { command: 'npm test' },
            duration: 1400,
            error: true,
            resultPreview: '2 tests failed',
          },
        ],
      }),
      ['▾ 1 step · 1 failed', '  ✗ Run npm test  1.4s', '      2 tests failed'],
    );
  });
});

describe('renderEntryLines: diff fences', () => {
  it('renders a ```diff fence with a gutter, summary, and stripped markers', () => {
    assert.deepEqual(
      render({
        role: 'assistant',
        text: '```diff\n@@ -1,2 +1,2 @@\n-old line\n+new line\n context\n```',
      }),
      ['• diff (+1 -1)', '    @@ -1,2 +1,2 @@', '  - old line', '  + new line', '    context'],
    );
  });

  it('auto-detects an untagged fence whose body is a unified diff', () => {
    assert.deepEqual(render({ role: 'assistant', text: '```\n@@ -1,1 +1,1 @@\n-a\n+b\n```' }), [
      '• diff (+1 -1)',
      '    @@ -1,1 +1,1 @@',
      '  - a',
      '  + b',
    ]);
  });

  it('does not mistake ordinary prose for a diff', () => {
    assert.equal(looksLikeUnifiedDiff('a line with + and - chars\nbut no hunk header'), false);
    assert.equal(looksLikeUnifiedDiff('@@ -1,2 +1,2 @@ ctx'), true);
  });
});

describe('renderEntryLines: status / error / warning / reasoning', () => {
  it('renders status with hexagon marker', () => {
    assert.deepEqual(render({ role: 'status', text: 'connected' }), ['⬡ connected']);
  });

  it('renders error with bullet (no badge)', () => {
    assert.deepEqual(render({ role: 'error', text: 'boom' }), ['• boom']);
  });

  it('renders warning with bullet (no badge)', () => {
    assert.deepEqual(render({ role: 'warning', text: 'careful' }), ['• careful']);
  });

  it('renders reasoning as hexagon + thinking', () => {
    assert.deepEqual(render({ role: 'reasoning' }), ['⬡ thinking']);
  });
});

describe('renderEntryLines: verdict / divider', () => {
  it('renders APPROVED verdict without badge wrapper', () => {
    assert.deepEqual(render({ role: 'verdict', verdict: 'APPROVED' }), ['  ✓ APPROVED']);
  });

  it('renders DENIED verdict with kind and summary', () => {
    assert.deepEqual(
      render({
        role: 'verdict',
        verdict: 'DENIED',
        kind: 'commit',
        summary: 'unsafe diff',
      }),
      ['  ✗ DENIED commit  unsafe diff'],
    );
  });

  it('renders divider as 40 horizontal glyphs', () => {
    assert.deepEqual(render({ role: 'divider' }), ['─'.repeat(40)]);
  });
});

describe('renderEntryLines: sources', () => {
  it('renders a header plus numbered title/URL pairs', () => {
    assert.deepEqual(
      render({
        role: 'sources',
        citations: [
          { url: 'https://a.test', title: 'A', content: '', startIndex: 0, endIndex: 0 },
          { url: 'https://b.test/x', title: 'B', content: '', startIndex: 0, endIndex: 0 },
        ],
      }),
      ['⬡ sources', '  1. A', '     https://a.test/', '  2. B', '     https://b.test/x'],
    );
  });

  it('falls back to the hostname when a citation has no title', () => {
    assert.deepEqual(
      render({
        role: 'sources',
        citations: [
          {
            url: 'https://www.example.com/page',
            title: '',
            content: '',
            startIndex: 0,
            endIndex: 0,
          },
        ],
      }),
      ['⬡ sources', '  1. example.com', '     https://www.example.com/page'],
    );
  });

  it('drops citations whose URL is not http(s) and renders nothing when all are unsafe', () => {
    assert.deepEqual(
      render({
        role: 'sources',
        citations: [
          { url: 'javascript:alert(1)', title: 'evil', content: '', startIndex: 0, endIndex: 0 },
        ],
      }),
      [],
    );
  });

  it('produces no output for an empty citations list', () => {
    assert.deepEqual(render({ role: 'sources', citations: [] }), []);
  });
});

describe('renderEntryLines: unknown role', () => {
  it('produces no output for an unrecognized role', () => {
    assert.deepEqual(render({ role: 'mystery', text: 'x' }), []);
  });
});
