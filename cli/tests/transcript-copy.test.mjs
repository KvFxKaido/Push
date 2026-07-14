/**
 * transcript-copy — copy the row's CONTENT, not the screen rectangle under it.
 *
 * The TUI holds the mouse (alt-screen + tracking), so a terminal's Shift+drag
 * escape hatch yields gutters, wrap artifacts and chrome. These tests pin the
 * thing that makes copy worth having: a tool row copies its *declared*
 * structure — the diff you can `git apply`, the card the renderer drew from —
 * rather than the prose that happened to be painted.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  copyLastResponse,
  copyTextForRow,
  lastAssistantRow,
  boundCopyText,
  MAX_COPY_CHARS,
} from '../transcript-copy.ts';

const message = (text, role = 'assistant', extra = {}) => ({
  id: `m-${text.slice(0, 6)}`,
  kind: 'message',
  role,
  text,
  ...extra,
});

describe('copyTextForRow — structure beats prose', () => {
  it('copies a tool row as a unified diff you can paste into git apply', () => {
    const { text, label } = copyTextForRow({
      id: 't1',
      kind: 'tool',
      role: 'coder',
      text: 'Edited lib/tool-cards.ts',
      toolName: 'edit_file',
      resultPreview: 'wrote 2 lines',
      diff: {
        path: 'lib/tool-cards.ts',
        adds: 1,
        dels: 1,
        lines: [
          { kind: 'ctx', text: 'export type ToolCard =', oldLine: 1, newLine: 1 },
          { kind: 'del', text: '  | { type: "pr" }', oldLine: 2 },
          { kind: 'add', text: '  | { type: "pr"; data: PRCardData }', newLine: 2 },
        ],
      },
    });

    assert.equal(label, 'diff');
    assert.equal(
      text,
      [
        '--- a/lib/tool-cards.ts',
        '+++ b/lib/tool-cards.ts',
        ' export type ToolCard =',
        '-  | { type: "pr" }',
        '+  | { type: "pr"; data: PRCardData }',
      ].join('\n'),
    );
    // The prose and the preview both lose to the structure.
    assert.doesNotMatch(text, /Edited lib|wrote 2 lines/);
  });

  it('copies a declared card as the same structure the renderer draws', () => {
    const { text, label } = copyTextForRow({
      id: 't2',
      kind: 'tool',
      role: 'assistant',
      text: 'checked CI',
      toolName: 'ci_status',
      resultPreview: '3 checks',
      card: {
        type: 'ci-status',
        data: {
          repo: 'KvFxKaido/Push',
          checks: [
            { name: 'typecheck', conclusion: 'success' },
            { name: 'app-build', conclusion: 'failure' },
          ],
        },
      },
    });

    assert.equal(label, 'CI Status');
    // Crucially: the FAILING check survives the copy. "3 checks" would not.
    assert.match(text, /app-build · failure/);
    assert.match(text, /Repo: KvFxKaido\/Push/);
  });

  it('falls back to the result preview, then the prose', () => {
    assert.equal(
      copyTextForRow({
        id: 't3',
        kind: 'tool',
        role: 'assistant',
        text: 'ran it',
        toolName: 'exec',
        resultPreview: 'exit 0',
      }).text,
      'exit 0',
    );
    assert.equal(
      copyTextForRow({ id: 't4', kind: 'tool', role: 'assistant', text: 'ran it' }).text,
      'ran it',
    );
  });

  it('ignores a malformed card rather than copying garbage', () => {
    const { text } = copyTextForRow({
      id: 't5',
      kind: 'tool',
      role: 'assistant',
      text: 'prose',
      resultPreview: 'preview',
      card: { nope: true },
    });
    assert.equal(text, 'preview');
  });
});

describe('lastAssistantRow — what "the last response" means', () => {
  it('skips the user, narration, status rows, and pending output', () => {
    const rows = [
      message('the real answer'),
      message('my question', 'user'),
      { id: 'p', kind: 'tool_prose', role: 'assistant', text: 'let me check that' },
      { id: 's', kind: 'status', role: 'status', text: 'Copied to clipboard' },
      message('still streaming', 'assistant', { pending: true }),
    ];
    assert.equal(lastAssistantRow(rows).text, 'the real answer');
  });

  it('skips blank rows and reports nothing to copy on an empty transcript', () => {
    assert.equal(lastAssistantRow([message('   ')]), null);
    assert.equal(lastAssistantRow([]), null);
    assert.equal(copyLastResponse([]), null);
  });

  it('takes the most recent assistant message, not the first', () => {
    const rows = [message('older'), message('my turn', 'user'), message('newer')];
    assert.equal(copyLastResponse(rows).text, 'newer');
  });

  it('copies a delegated role response too (coder/reviewer are not the user)', () => {
    assert.equal(copyLastResponse([message('coder said this', 'coder')]).text, 'coder said this');
  });
});

describe('the OSC 52 ceiling is reported, never silent', () => {
  // A terminal drops an oversized OSC 52 sequence on the floor — no error, no
  // partial write. An unreported cap would look exactly like a successful copy.
  it('flags truncation instead of quietly copying a prefix', () => {
    const payload = boundCopyText('x'.repeat(MAX_COPY_CHARS + 1), 'response');
    assert.equal(payload.truncated, true);
    assert.equal(payload.text.length, MAX_COPY_CHARS);
  });

  it('does not flag a payload that fits', () => {
    const payload = boundCopyText('x'.repeat(MAX_COPY_CHARS), 'response');
    assert.equal(payload.truncated, false);
    assert.equal(payload.text.length, MAX_COPY_CHARS);
  });

  it('carries the cap through the copyLastResponse path', () => {
    const payload = copyLastResponse([message('y'.repeat(MAX_COPY_CHARS + 500))]);
    assert.equal(payload.truncated, true);
    assert.equal(payload.text.length, MAX_COPY_CHARS);
  });
});
