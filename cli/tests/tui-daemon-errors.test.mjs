import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  DEFAULT_LOG_TAIL_LINES,
  DEFAULT_LOG_TAIL_LINE_CHARS,
  classifyDaemonSpawnError,
  formatPushdLogTail,
  readPushdLogTail,
} from '../tui-daemon-errors.ts';

describe('classifyDaemonSpawnError', () => {
  function makeErr(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
  }

  it('classifies EACCES with an actionable hint', () => {
    const result = classifyDaemonSpawnError(makeErr('EACCES', 'permission denied, open ...'));
    assert.equal(result.code, 'EACCES');
    assert.match(result.headline, /EACCES/);
    assert.match(result.headline, /permission denied/);
    assert.ok(result.hint);
    assert.match(result.hint, /~\/\.push\/run|mode 700/);
  });

  it('classifies EADDRINUSE with a stale-socket hint', () => {
    const result = classifyDaemonSpawnError(makeErr('EADDRINUSE', 'address already in use'));
    assert.equal(result.code, 'EADDRINUSE');
    assert.match(result.headline, /EADDRINUSE/);
    assert.match(result.hint, /pushd.sock|daemon status/);
  });

  it('classifies ENOENT with a $HOME hint', () => {
    const result = classifyDaemonSpawnError(makeErr('ENOENT', 'no such file or directory'));
    assert.equal(result.code, 'ENOENT');
    assert.match(result.hint, /HOME|~\/\.push/);
  });

  it('classifies EPERM and EMFILE separately', () => {
    const eperm = classifyDaemonSpawnError(makeErr('EPERM', 'operation not permitted'));
    assert.equal(eperm.code, 'EPERM');
    assert.match(eperm.hint, /chown/);

    const emfile = classifyDaemonSpawnError(makeErr('EMFILE', 'too many open files'));
    assert.equal(emfile.code, 'EMFILE');
    assert.match(emfile.hint, /ulimit/);
  });

  it('detects missing tsx loader from the error message', () => {
    const result = classifyDaemonSpawnError(
      new Error("Cannot find package 'tsx' imported from /home/user/Push"),
    );
    assert.equal(result.code, 'TSX_LOADER_MISSING');
    assert.match(result.hint, /npm install|built binary/);
  });

  it('detects Node OOM from the error message', () => {
    const result = classifyDaemonSpawnError(
      new Error('FATAL ERROR: JavaScript heap out of memory'),
    );
    assert.equal(result.code, 'NODE_OOM');
    assert.match(result.hint, /max-old-space-size/);
  });

  it('falls through to UNKNOWN with the original message preserved', () => {
    const result = classifyDaemonSpawnError(new Error('something nobody anticipated'));
    assert.equal(result.code, 'UNKNOWN');
    assert.match(result.headline, /something nobody anticipated/);
    // No misleading hint when we don't have a real one.
    assert.equal(result.hint, undefined);
  });

  it('survives non-Error inputs without throwing', () => {
    // The spawn path can in theory reject with a string or an
    // object — `classifyDaemonSpawnError` must degrade gracefully.
    const fromString = classifyDaemonSpawnError('weird raw string');
    assert.equal(fromString.code, 'UNKNOWN');
    assert.match(fromString.headline, /weird raw string/);

    const fromNull = classifyDaemonSpawnError(null);
    assert.equal(fromNull.code, 'UNKNOWN');
  });
});

describe('formatPushdLogTail', () => {
  it('returns "empty" for an empty input', () => {
    assert.equal(formatPushdLogTail(''), 'Daemon log is empty.');
    assert.equal(formatPushdLogTail('   \n\n  \n'), 'Daemon log is empty.');
  });

  it('returns the full log when smaller than maxLines', () => {
    const log = ['line 1', 'line 2', 'line 3'].join('\n');
    const tail = formatPushdLogTail(log);
    assert.match(tail, /^Daemon log \(last 3 lines\):/);
    assert.match(tail, /line 1\nline 2\nline 3$/);
    assert.doesNotMatch(tail, /elided/);
  });

  it('slices to the last maxLines when the log is larger', () => {
    const log = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
    const tail = formatPushdLogTail(log);
    assert.match(tail, /Daemon log \(last 12 lines\)/);
    assert.match(tail, /\(38 earlier lines elided\)/);
    // Last line should be present, first line should NOT.
    assert.match(tail, /line 50$/);
    assert.doesNotMatch(tail, /^line 1\n/m);
  });

  it('respects a custom maxLines', () => {
    const log = ['a', 'b', 'c', 'd', 'e'].join('\n');
    const tail = formatPushdLogTail(log, { maxLines: 2 });
    assert.match(tail, /Daemon log \(last 2 lines\)/);
    assert.match(tail, /d\ne$/);
  });

  it('truncates over-long lines with an ellipsis', () => {
    const long = 'x'.repeat(500);
    const tail = formatPushdLogTail(`short\n${long}`, { maxLineChars: 50 });
    // 49 x's then ellipsis (49 + 1 = 50 total).
    assert.match(tail, /xx*…/);
    const ellipsisLine = tail.split('\n').find((l) => l.endsWith('…'));
    assert.ok(ellipsisLine, 'expected an ellipsis-terminated line');
    assert.equal(ellipsisLine.length, 50);
  });

  it('strips trailing blank lines so the count is honest', () => {
    const log = 'real line\n\n\n';
    const tail = formatPushdLogTail(log);
    // Tail should report 1 line, not 3.
    assert.match(tail, /Daemon log \(last 1 lines?\)/);
    assert.match(tail, /real line$/);
  });

  it('exports tunable defaults', () => {
    assert.equal(DEFAULT_LOG_TAIL_LINES, 12);
    assert.equal(DEFAULT_LOG_TAIL_LINE_CHARS, 200);
  });
});

describe('readPushdLogTail', () => {
  it('returns null when the file does not exist', async () => {
    const tail = await readPushdLogTail('/this/path/should/never/exist.log');
    assert.equal(tail, null);
  });

  it('reads + formats a real log file', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pushd-log-tail-'));
    const logPath = path.join(tmpDir, 'pushd.log');
    try {
      await fs.writeFile(logPath, 'one\ntwo\nthree\n', 'utf8');
      const tail = await readPushdLogTail(logPath);
      assert.ok(tail);
      assert.match(tail, /Daemon log \(last 3 lines\)/);
      assert.match(tail, /one\ntwo\nthree$/);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('applies options through to the formatter', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pushd-log-tail-'));
    const logPath = path.join(tmpDir, 'pushd.log');
    try {
      await fs.writeFile(logPath, 'a\nb\nc\nd\ne\n', 'utf8');
      const tail = await readPushdLogTail(logPath, { maxLines: 2 });
      assert.match(tail, /Daemon log \(last 2 lines\)/);
      assert.match(tail, /d\ne$/);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
