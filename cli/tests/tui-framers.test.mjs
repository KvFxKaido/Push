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

import { renderEntryLines } from '../tui-framers.ts';
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

describe('renderEntryLines: user', () => {
  it('renders short text with YOU badge prefix', () => {
    assert.deepEqual(render({ role: 'user', text: 'hello' }), [' YOU  hello']);
  });

  it('wraps long text with continuation indent matching badge width', () => {
    const long = 'a '.repeat(50).trim(); // 99 chars; wraps under 80-col window
    const lines = render({ role: 'user', text: long });
    assert.ok(lines.length >= 2, 'expected wrap to produce 2+ lines');
    assert.ok(lines[0].startsWith(' YOU  '));
    for (let i = 1; i < lines.length; i++) {
      assert.ok(lines[i].startsWith('      '), `line ${i} should have 6-space indent`);
    }
  });
});

describe('renderEntryLines: tool_call', () => {
  it('renders pending call with ellipsis status and TOOL badge', () => {
    const lines = render({
      role: 'tool_call',
      text: 'Read',
      args: { path: 'src/foo.ts' },
    });
    assert.deepEqual(lines, [' TOOL  … Read src/foo.ts']);
  });

  it('renders successful call with check, duration, and result preview', () => {
    const lines = render({
      role: 'tool_call',
      text: 'Read',
      args: { path: 'src/foo.ts' },
      duration: 42,
      resultPreview: 'first line of output\nrest ignored',
    });
    assert.deepEqual(lines, [' TOOL  ✓ Read src/foo.ts 42ms', '       first line of output']);
  });

  it('renders errored call with cross mark', () => {
    const lines = render({
      role: 'tool_call',
      text: 'Bash',
      args: { command: 'false' },
      error: true,
      duration: 5,
    });
    assert.deepEqual(lines, [' TOOL  ✗ Bash false 5ms']);
  });

  it('skips trailer when result preview is empty', () => {
    const lines = render({
      role: 'tool_call',
      text: 'Read',
      args: { path: 'a' },
      duration: 1,
      resultPreview: '',
    });
    assert.deepEqual(lines, [' TOOL  ✓ Read a 1ms']);
  });
});

describe('renderEntryLines: status / error / warning', () => {
  it('renders status with INFO badge', () => {
    assert.deepEqual(render({ role: 'status', text: 'connected' }), [' INFO  connected']);
  });

  it('renders error with ERR badge', () => {
    assert.deepEqual(render({ role: 'error', text: 'boom' }), [' ERR  boom']);
  });

  it('renders warning with WARN badge', () => {
    assert.deepEqual(render({ role: 'warning', text: 'careful' }), [' WARN  careful']);
  });
});

describe('renderEntryLines: reasoning / verdict / divider', () => {
  it('renders reasoning as a single THINK line', () => {
    assert.deepEqual(render({ role: 'reasoning' }), [' THINK  thinking']);
  });

  it('renders APPROVED verdict with check icon and 2-space indent', () => {
    assert.deepEqual(render({ role: 'verdict', verdict: 'APPROVED' }), ['   ✓ APPROVED ']);
  });

  it('renders DENIED verdict with cross icon, kind, and summary', () => {
    assert.deepEqual(
      render({
        role: 'verdict',
        verdict: 'DENIED',
        kind: 'commit',
        summary: 'unsafe diff',
      }),
      ['   ✗ DENIED  commit  unsafe diff'],
    );
  });

  it('renders divider as 40 horizontal glyphs', () => {
    assert.deepEqual(render({ role: 'divider' }), ['─'.repeat(40)]);
  });
});

describe('renderEntryLines: assistant', () => {
  it('renders plain text with AI badge', () => {
    assert.deepEqual(render({ role: 'assistant', text: 'hello' }), [' AI  hello']);
  });

  it('renders heading without # markers', () => {
    assert.deepEqual(render({ role: 'assistant', text: '# Title' }), [' AI  Title']);
  });

  it('renders bullet list keeping marker', () => {
    assert.deepEqual(render({ role: 'assistant', text: '- item' }), [' AI  - item']);
  });

  it('renders numbered list keeping marker', () => {
    assert.deepEqual(render({ role: 'assistant', text: '1. item' }), [' AI  1. item']);
  });

  it('strips leading > from blockquotes', () => {
    assert.deepEqual(render({ role: 'assistant', text: '> quoted' }), [' AI  quoted']);
  });

  it('renders horizontal rule as 24 dashes', () => {
    assert.deepEqual(render({ role: 'assistant', text: '---' }), [' AI  ' + '─'.repeat(24)]);
  });

  it('renders code fence with language label and indented body', () => {
    assert.deepEqual(render({ role: 'assistant', text: '```js\nconst x = 1;\n```' }), [
      ' AI  code (js)',
      '     const x = 1;',
    ]);
  });

  it('renders JSON tool-call fence as collapsed payload header + summary', () => {
    const lines = render({
      role: 'assistant',
      text: '```json\n{"tool":"Read","args":{"path":"a.ts"}}\n```',
    });
    assert.deepEqual(lines, [' AI  ▸ JSON payload · 1 tool call · collapsed', '     → Read  a.ts']);
  });
});

describe('renderEntryLines: unknown role', () => {
  it('produces no output for an unrecognized role', () => {
    assert.deepEqual(render({ role: 'mystery', text: 'x' }), []);
  });
});

// ─── Quiet layout ───────────────────────────────────────────────────
// Bullet-led, badge-free shapes. Same dispatcher, different framer table.

function renderQuiet(entry, ctx = {}) {
  const out = [];
  renderEntryLines(out, entry, WIDTH, makeTheme(), { ...ctx, layout: 'quiet' });
  return out;
}

describe('renderEntryLines (quiet): user / assistant', () => {
  it('renders user with accent bullet', () => {
    assert.deepEqual(renderQuiet({ role: 'user', text: 'hello' }), ['• hello']);
  });

  it('renders assistant plain text with muted bullet', () => {
    assert.deepEqual(renderQuiet({ role: 'assistant', text: 'hello' }), ['• hello']);
  });

  it('keeps markdown handling under quiet prefix', () => {
    assert.deepEqual(renderQuiet({ role: 'assistant', text: '# Title' }), ['• Title']);
    assert.deepEqual(renderQuiet({ role: 'assistant', text: '- item' }), ['• - item']);
  });

  it('renders code fence with bullet on label, 2-space indent on body', () => {
    assert.deepEqual(renderQuiet({ role: 'assistant', text: '```js\nconst x = 1;\n```' }), [
      '• code (js)',
      '  const x = 1;',
    ]);
  });
});

describe('renderEntryLines (quiet): tool_call', () => {
  it('renders pending call with bullet, status icon, and parens-wrapped args', () => {
    const lines = renderQuiet({
      role: 'tool_call',
      text: 'Read',
      args: { path: 'src/foo.ts' },
    });
    assert.deepEqual(lines, ['• … Read(src/foo.ts)']);
  });

  it('renders successful call with branch-line trailer for result preview', () => {
    const lines = renderQuiet({
      role: 'tool_call',
      text: 'Read',
      args: { path: 'src/foo.ts' },
      duration: 42,
      resultPreview: 'first line of output\nrest ignored',
    });
    assert.deepEqual(lines, ['• ✓ Read(src/foo.ts) 42ms', '  └─ first line of output']);
  });

  it('renders errored call with cross icon, no trailer', () => {
    const lines = renderQuiet({
      role: 'tool_call',
      text: 'Bash',
      args: { command: 'false' },
      error: true,
      duration: 5,
    });
    assert.deepEqual(lines, ['• ✗ Bash(false) 5ms']);
  });
});

describe('renderEntryLines (quiet): status / error / warning / reasoning', () => {
  it('renders status with star marker', () => {
    assert.deepEqual(renderQuiet({ role: 'status', text: 'connected' }), ['* connected']);
  });

  it('renders error with bullet (no badge)', () => {
    assert.deepEqual(renderQuiet({ role: 'error', text: 'boom' }), ['• boom']);
  });

  it('renders warning with bullet (no badge)', () => {
    assert.deepEqual(renderQuiet({ role: 'warning', text: 'careful' }), ['• careful']);
  });

  it('renders reasoning as star + thinking', () => {
    assert.deepEqual(renderQuiet({ role: 'reasoning' }), ['* thinking']);
  });
});

describe('renderEntryLines (quiet): verdict / divider', () => {
  it('renders APPROVED verdict without badge wrapper', () => {
    assert.deepEqual(renderQuiet({ role: 'verdict', verdict: 'APPROVED' }), ['  ✓ APPROVED']);
  });

  it('renders DENIED verdict with kind and summary', () => {
    assert.deepEqual(
      renderQuiet({
        role: 'verdict',
        verdict: 'DENIED',
        kind: 'commit',
        summary: 'unsafe diff',
      }),
      ['  ✗ DENIED commit  unsafe diff'],
    );
  });

  it('renders divider identically to standard layout', () => {
    assert.deepEqual(renderQuiet({ role: 'divider' }), ['─'.repeat(40)]);
  });
});
