import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createApprovalPane } from '../tui-approval-pane.ts';

// Minimal theme stub: identity styling, ascii box glyphs.
const theme = {
  bold: (s) => s,
  style: (_token, s) => s,
  glyphs: {
    horizontal: '-',
    vertical: '|',
    topLeft: '+',
    topRight: '+',
    bottomLeft: '+',
    bottomRight: '+',
  },
};

function makeBuf() {
  const writes = [];
  return {
    writes,
    writeLine(row, col, text) {
      writes.push({ row, col, text });
    },
    text() {
      return writes.map((w) => w.text).join('\n');
    },
  };
}

function makeActions() {
  const calls = [];
  return {
    calls,
    approve: () => calls.push('approve'),
    alwaysApprove: () => calls.push('always'),
    persistPrefix: () => calls.push('persist'),
    deny: () => calls.push('deny'),
  };
}

function key(name, mods = {}) {
  return { name, ctrl: false, shift: false, meta: false, sequence: '', ch: '', ...mods };
}

describe('createApprovalPane.render', () => {
  it('draws the kind, summary, and shortcut line', () => {
    const buf = makeBuf();
    const pane = createApprovalPane({ kind: 'exec', summary: 'rm -rf /tmp/foo' }, makeActions());
    // Modal width caps at min(60, cols-8); a wide terminal lets the full
    // shortcut row render without truncation so the assertions are stable.
    pane.render(buf, 24, 80, theme);
    const out = buf.text();
    assert.match(out, /Approval Required/);
    assert.match(out, /exec/);
    assert.match(out, /rm -rf \/tmp\/foo/);
    assert.match(out, /approve/);
  });

  it('includes the suggested prefix when present', () => {
    const buf = makeBuf();
    const pane = createApprovalPane(
      { kind: 'exec', summary: 'git push --force', suggestedPrefix: 'git push' },
      makeActions(),
    );
    pane.render(buf, 24, 80, theme);
    assert.match(buf.text(), /prefix:/);
    assert.match(buf.text(), /git push/);
  });
});

describe('createApprovalPane.handleKey', () => {
  let actions;
  let pane;

  beforeEach(() => {
    actions = makeActions();
    pane = createApprovalPane({ kind: 'exec', summary: 's' }, actions);
  });

  it('routes bare y/a/p/n to the matching action', () => {
    assert.equal(pane.handleKey(key('y')), true);
    assert.equal(pane.handleKey(key('a')), true);
    assert.equal(pane.handleKey(key('p')), true);
    assert.equal(pane.handleKey(key('n')), true);
    assert.deepEqual(actions.calls, ['approve', 'always', 'persist', 'deny']);
  });

  it('routes Esc to deny', () => {
    assert.equal(pane.handleKey(key('escape')), true);
    assert.deepEqual(actions.calls, ['deny']);
  });

  it('routes Ctrl+Y to approve and Ctrl+N to deny', () => {
    assert.equal(pane.handleKey(key('y', { ctrl: true })), true);
    assert.equal(pane.handleKey(key('n', { ctrl: true })), true);
    assert.deepEqual(actions.calls, ['approve', 'deny']);
  });

  it('swallows bare letter keys when meta is held without firing an action', () => {
    // Approval is hard-modal: every key returns true, but only the explicit
    // shortcuts (handled separately) actually invoke an action.
    assert.equal(pane.handleKey(key('y', { meta: true })), true);
    assert.equal(pane.handleKey(key('n', { meta: true })), true);
    assert.deepEqual(actions.calls, []);
  });

  it('swallows unrelated keys without firing an action', () => {
    assert.equal(pane.handleKey(key('q')), true);
    assert.equal(pane.handleKey(key('return')), true);
    assert.deepEqual(actions.calls, []);
  });
});
