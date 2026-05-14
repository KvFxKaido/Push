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

describe('renderEntryLines: status / error / warning / reasoning', () => {
  it('renders status with star marker', () => {
    assert.deepEqual(render({ role: 'status', text: 'connected' }), ['* connected']);
  });

  it('renders error with bullet (no badge)', () => {
    assert.deepEqual(render({ role: 'error', text: 'boom' }), ['• boom']);
  });

  it('renders warning with bullet (no badge)', () => {
    assert.deepEqual(render({ role: 'warning', text: 'careful' }), ['• careful']);
  });

  it('renders reasoning as star + thinking', () => {
    assert.deepEqual(render({ role: 'reasoning' }), ['* thinking']);
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

describe('renderEntryLines: unknown role', () => {
  it('produces no output for an unrecognized role', () => {
    assert.deepEqual(render({ role: 'mystery', text: 'x' }), []);
  });
});
