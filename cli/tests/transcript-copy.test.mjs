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

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  copyLastResponse,
  copyTextForRow,
  lastCopyableRow,
  boundCopyText,
  MAX_COPY_BYTES,
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
        '@@ -1,2 +1,2 @@',
        ' export type ToolCard =',
        '-  | { type: "pr" }',
        '+  | { type: "pr"; data: PRCardData }',
      ].join('\n'),
    );
    // The prose and the preview both lose to the structure.
    assert.doesNotMatch(text, /Edited lib|wrote 2 lines/);
  });

  it('produces a patch that REAL git apply accepts', () => {
    // The claim was "you can git apply this". I asserted it in a PR body without
    // ever running it; the output had no @@ headers and git rejected it outright
    // ("No valid patches in input"). Codex caught it. A shape assertion could not
    // have — only running the actual tool can falsify a claim about the tool.
    const dir = mkdtempSync(join(tmpdir(), 'push-copy-apply-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir });
      writeFileSync(join(dir, 'app.ts'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
      execFileSync('git', ['add', '-A'], { cwd: dir });

      const { text } = copyTextForRow({
        id: 't',
        kind: 'tool',
        role: 'coder',
        text: 'edited',
        diff: {
          path: 'app.ts',
          adds: 1,
          dels: 1,
          lines: [
            { kind: 'ctx', text: 'const a = 1;', oldLine: 1, newLine: 1 },
            { kind: 'del', text: 'const b = 2;', oldLine: 2 },
            { kind: 'add', text: 'const b = 22;', newLine: 2 },
            { kind: 'ctx', text: 'const c = 3;', oldLine: 3, newLine: 3 },
          ],
        },
      });

      writeFileSync(join(dir, 'copied.patch'), `${text}\n`);
      // --check parses AND validates against the worktree. Throws on rejection.
      execFileSync('git', ['apply', '--check', 'copied.patch'], { cwd: dir });
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it('emits a separate hunk when the diff skips context', () => {
    // EditDiff encodes hunk boundaries implicitly — a jump in line numbers means
    // skipped context. One @@ header per contiguous run, or the patch is a lie.
    const { text } = copyTextForRow({
      id: 't',
      kind: 'tool',
      role: 'coder',
      text: 'edited',
      diff: {
        path: 'app.ts',
        adds: 2,
        dels: 0,
        lines: [
          { kind: 'ctx', text: 'top', oldLine: 1, newLine: 1 },
          { kind: 'add', text: 'near top', newLine: 2 },
          // ── jump: lines 3..99 skipped ──
          { kind: 'ctx', text: 'bottom', oldLine: 100, newLine: 101 },
          { kind: 'add', text: 'near bottom', newLine: 102 },
        ],
      },
    });
    const hunks = text.split('\n').filter((l) => l.startsWith('@@'));
    assert.equal(hunks.length, 2, `expected two hunks, got:\n${text}`);
    assert.equal(hunks[0], '@@ -1,1 +1,2 @@');
    assert.equal(hunks[1], '@@ -100,1 +101,2 @@');
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

describe('lastCopyableRow — the production command must REACH the tool path', () => {
  const toolRow = (extra) => ({
    id: 'tool-row',
    kind: 'tool',
    role: 'coder',
    text: 'Edited app.ts',
    toolName: 'edit_file',
    ...extra,
  });

  it('copies the DIFF when the turn ended in an edit', () => {
    // THE regression. The first version filtered `kind !== 'message'`, so every
    // diff/card branch of copyTextForRow was unreachable from copyLastResponse:
    // Ctrl+O after an edit copied an older message, or nothing. Unit tests on
    // copyTextForRow stayed green throughout — they called it directly. Both
    // Codex and the Push reviewer caught this on #1474. This test is the path.
    const rows = [
      message('I will fix that', 'assistant'),
      toolRow({
        diff: {
          path: 'app.ts',
          adds: 1,
          dels: 0,
          lines: [{ kind: 'add', text: 'const fixed = true;', newLine: 1 }],
        },
      }),
    ];
    const payload = copyLastResponse(rows);
    assert.equal(payload.label, 'diff');
    assert.match(payload.text, /^--- a\/app\.ts/);
    assert.match(payload.text, /^@@ /m, 'must be a real patch, not a bare line list');
    assert.doesNotMatch(payload.text, /I will fix that/);
  });

  it('copies the CARD when the turn ended in a tool result', () => {
    const rows = [
      message('checking CI', 'assistant'),
      toolRow({
        toolName: 'ci_status',
        card: { type: 'ci-status', data: { checks: [{ name: 'build', conclusion: 'failure' }] } },
      }),
    ];
    const payload = copyLastResponse(rows);
    assert.equal(payload.label, 'CI Status');
    assert.match(payload.text, /build · failure/);
  });

  it('still prefers a later message over an earlier tool row', () => {
    const rows = [toolRow({ resultPreview: 'exit 0' }), message('all done, it passes')];
    assert.equal(copyLastResponse(rows).text, 'all done, it passes');
  });

  it('skips the user, narration, status rows, and pending output', () => {
    const rows = [
      message('the real answer'),
      message('my question', 'user'),
      { id: 'p', kind: 'tool_prose', role: 'assistant', text: 'let me check that' },
      // Our own "Copied …" line must never become the next copy target.
      { id: 's', kind: 'status', role: 'status', text: 'Copied response to clipboard' },
      message('still streaming', 'assistant', { pending: true }),
      toolRow({ pending: true, resultPreview: 'running…' }),
    ];
    assert.equal(lastCopyableRow(rows).text, 'the real answer');
  });

  it('skips blank rows and reports nothing to copy on an empty transcript', () => {
    assert.equal(lastCopyableRow([message('   ')]), null);
    assert.equal(lastCopyableRow([]), null);
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

describe('the OSC 52 ceiling is measured in BYTES, and reported, never silent', () => {
  // A terminal drops an oversized OSC 52 sequence on the floor — no error, no
  // partial write. An unreported cap looks exactly like a successful copy.
  const bytes = (s) => Buffer.byteLength(s, 'utf8');

  it('flags truncation instead of quietly copying a prefix', () => {
    const payload = boundCopyText('x'.repeat(MAX_COPY_BYTES + 1), 'response');
    assert.equal(payload.truncated, true);
    assert.ok(bytes(payload.text) <= MAX_COPY_BYTES);
  });

  it('does not flag a payload that fits', () => {
    const payload = boundCopyText('x'.repeat(MAX_COPY_BYTES), 'response');
    assert.equal(payload.truncated, false);
  });

  it('caps multi-byte text by BYTES, not string length', () => {
    // The bug Codex caught: capping String#length let 3-byte CJK through at 3x
    // the intended wire size with truncated:false — over the terminal ceiling,
    // silently dropped, and the status line still said "Copied".
    const cjk = '漢'.repeat(MAX_COPY_BYTES); // 3 bytes each → 3x over budget
    assert.ok(cjk.length < MAX_COPY_BYTES * 3, 'sanity: string length < byte length');
    const payload = boundCopyText(cjk, 'response');
    assert.equal(payload.truncated, true, 'a 3x-oversize payload must NOT pass as fitting');
    assert.ok(
      bytes(payload.text) <= MAX_COPY_BYTES,
      `wire size must respect the ceiling, got ${bytes(payload.text)}`,
    );
  });

  it('never splits a surrogate pair when it cuts', () => {
    // Slicing at a byte-derived index can land mid-pair and emit a lone half,
    // which base64s fine and pastes as U+FFFD.
    const emoji = '🧬'.repeat(MAX_COPY_BYTES); // 4 bytes, 2 UTF-16 code units
    const payload = boundCopyText(emoji, 'response');
    assert.equal(payload.truncated, true);
    assert.doesNotMatch(payload.text, /[\uD800-\uDFFF]/u, 'no lone surrogate may survive the cut');
    // Round-trips through the same encode osc52Copy performs.
    const roundTrip = Buffer.from(payload.text, 'utf8').toString('utf8');
    assert.equal(roundTrip, payload.text);
    assert.doesNotMatch(roundTrip, /�/, 'no replacement char — the cut was clean');
  });

  it('carries the cap through the copyLastResponse path', () => {
    const payload = copyLastResponse([message('y'.repeat(MAX_COPY_BYTES + 500))]);
    assert.equal(payload.truncated, true);
    assert.ok(bytes(payload.text) <= MAX_COPY_BYTES);
  });
});
