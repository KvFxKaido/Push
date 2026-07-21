// Must stay first: direct runs must not write backups or state into the real Push home.
import './setup-test-home-isolation.mjs';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { calculateContentVersion, calculateLineHash } from '../hashline.ts';
import { applySearchReplace } from '../search-replace.ts';
import { executeToolCall as executeRawToolCall } from '../tools.ts';

const executeToolCall = (call, root) =>
  executeRawToolCall(call, root, { role: 'coder', postEditDiagnostics: false });

async function withTempWorkspace(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'push-search-replace-'));
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function expectSuccess(result) {
  assert.equal('error' in result, false, 'expected search/replace to succeed');
  return result;
}

describe('applySearchReplace', () => {
  it('reports no match for an empty file', () => {
    assert.deepEqual(applySearchReplace('', { search: 'x', replace: 'y' }), {
      error: 'search text was not found',
      occurrences: 0,
    });
  });

  it('edits a single line with no trailing newline', () => {
    const result = expectSuccess(
      applySearchReplace('alpha beta', { search: 'beta', replace: 'BETA' }),
    );
    assert.equal(result.content, 'alpha BETA');
    assert.equal(result.count, 1);
  });

  it('preserves exactly one versus multiple trailing newlines', () => {
    for (const content of ['alpha\n', 'alpha\n\n']) {
      const result = expectSuccess(applySearchReplace(content, { search: 'alpha', replace: 'A' }));
      assert.equal(result.content, content.replace('alpha', 'A'));
    }
  });

  it('matches the last line at EOF', () => {
    const result = expectSuccess(
      applySearchReplace('first\nlast', { search: 'last', replace: 'LAST' }),
    );
    assert.equal(result.content, 'first\nLAST');
  });

  it('matches a uniform-LF file exactly', () => {
    const result = expectSuccess(
      applySearchReplace('one\ntwo\nthree\n', {
        search: 'two\nthree',
        replace: 'TWO\nTHREE',
      }),
    );
    assert.equal(result.content, 'one\nTWO\nTHREE\n');
  });

  it('matches CRLF search against a uniform-LF file without normalizing untouched bytes', () => {
    const result = expectSuccess(
      applySearchReplace('head\nold one\nold two\ntail\n', {
        search: 'old one\r\nold',
        replace: 'new one\r\nnew',
      }),
    );
    assert.equal(result.content, 'head\nnew one\nnew two\ntail\n');
    assert.equal(result.content.includes('\r\n'), false);
  });

  it('matches LF search against uniform CRLF and canonicalizes an LF replacement', () => {
    const content = 'head\r\nold one\r\nold two\r\ntail\r\nfooter\r\n';
    const result = expectSuccess(
      applySearchReplace(content, {
        search: 'old one\nold',
        replace: 'new one\nnew',
      }),
    );
    assert.equal(result.content, 'head\r\nnew one\r\nnew two\r\ntail\r\nfooter\r\n');
    assert.equal(result.content.match(/\r\n/g)?.length, 5);
    assert.equal(result.content.match(/(?<!\r)\n/g), null);
  });

  it('canonicalizes a CRLF replacement for a uniform-LF file', () => {
    const result = expectSuccess(
      applySearchReplace('head\ntarget\ntail\n', {
        search: 'target',
        replace: 'new one\r\nnew two',
      }),
    );
    assert.equal(result.content, 'head\nnew one\nnew two\ntail\n');
    assert.equal(result.content.includes('\r\n'), false);
  });

  it('canonicalizes an LF replacement on the exact-match path for a uniform-CRLF file', () => {
    const result = expectSuccess(
      applySearchReplace('head\r\ntarget\r\ntail\r\n', {
        search: 'target',
        replace: 'new one\nnew two',
      }),
    );
    assert.equal(result.content, 'head\r\nnew one\r\nnew two\r\ntail\r\n');
    assert.equal(result.content.match(/(?<!\r)\n/g), null);
  });

  it('does not use normalized fallback for a mixed-endings file', () => {
    const content = 'a\r\nb\nc\r\n';
    assert.deepEqual(applySearchReplace(content, { search: 'a\nb\nc', replace: 'x' }), {
      error: 'search text was not found',
      occurrences: 0,
    });

    const exact = expectSuccess(applySearchReplace(content, { search: 'b\nc', replace: 'B\nC' }));
    assert.equal(exact.content, 'a\r\nB\nC\r\n');
  });

  it('splices an LF replacement verbatim into mixed endings and preserves untouched bytes', () => {
    const prefix = 'before\r\n';
    const suffix = '\nafter\r\n';
    const replacement = 'new one\nnew two';
    const result = expectSuccess(
      applySearchReplace(`${prefix}target${suffix}`, { search: 'target', replace: replacement }),
    );
    assert.equal(result.content, `${prefix}${replacement}${suffix}`);
    assert.equal(result.content.slice(0, prefix.length), prefix);
    assert.equal(result.content.slice(-suffix.length), suffix);
  });

  it('reports the occurrence count when a non-unique match omits replace_all', () => {
    const result = applySearchReplace('x x x', { search: 'x', replace: 'y' });
    assert.equal('error' in result, true);
    assert.equal(result.occurrences, 3);
    assert.match(result.error, /surrounding context/);
    assert.match(result.error, /replace_all/);
  });

  it('replaces every occurrence when replace_all is true', () => {
    const result = expectSuccess(
      applySearchReplace('x x x', { search: 'x', replace: 'y', replace_all: true }),
    );
    assert.equal(result.content, 'y y y');
    assert.equal(result.count, 3);
  });

  it('rejects an empty search', () => {
    assert.deepEqual(applySearchReplace('abc', { search: '', replace: 'x' }), {
      error: 'search must be non-empty',
    });
  });

  it('replaces the whole file content', () => {
    const result = expectSuccess(
      applySearchReplace('whole\nfile\n', { search: 'whole\nfile\n', replace: 'replacement' }),
    );
    assert.equal(result.content, 'replacement');
  });

  it('supports deletion via an empty replacement', () => {
    const result = expectSuccess(
      applySearchReplace('before DELETE after', { search: ' DELETE', replace: '' }),
    );
    assert.equal(result.content, 'before after');
  });
});

describe('edit_file search/replace integration', () => {
  it('accepts search/replace and returns versions plus diff metadata', async () => {
    await withTempWorkspace(async (root) => {
      const rel = 'deepseek.txt';
      const before = 'alpha\nbeta\ngamma\n';
      await fs.writeFile(path.join(root, rel), before, 'utf8');

      const result = await executeToolCall(
        {
          tool: 'edit_file',
          args: {
            path: rel,
            search: 'beta',
            replace: 'BETA',
            expected_version: calculateContentVersion(before),
          },
        },
        root,
      );

      assert.equal(result.ok, true);
      assert.equal(result.meta.version_before, calculateContentVersion(before));
      assert.notEqual(result.meta.version_after, result.meta.version_before);
      assert.equal(result.meta.editDiff.adds, 1);
      assert.equal(result.meta.editDiff.dels, 1);
      assert.equal(result.meta.card.type, 'diff-preview');
      assert.match(result.text, /Applied search\/replace edit .*\(1 occurrence\)/);
      assert.equal(await fs.readFile(path.join(root, rel), 'utf8'), 'alpha\nBETA\ngamma\n');
    });
  });

  it('accepts old_string/new_string aliases with replace_all', async () => {
    await withTempWorkspace(async (root) => {
      const rel = 'kimi.txt';
      const before = 'old and old\n';
      await fs.writeFile(path.join(root, rel), before, 'utf8');

      const result = await executeToolCall(
        {
          tool: 'edit_file',
          args: { path: rel, old_string: 'old', new_string: 'new', replace_all: true },
        },
        root,
      );

      assert.equal(result.ok, true);
      assert.equal(result.meta.version_before, calculateContentVersion(before));
      assert.equal(result.meta.version_after, calculateContentVersion('new and new\n'));
      assert.match(result.text, /\(2 occurrences\)/);
      assert.equal(await fs.readFile(path.join(root, rel), 'utf8'), 'new and new\n');
    });
  });

  it('keeps the hashline edits shape working unchanged', async () => {
    await withTempWorkspace(async (root) => {
      const rel = 'hashline.txt';
      const before = 'alpha\nbeta\n';
      await fs.writeFile(path.join(root, rel), before, 'utf8');

      const result = await executeToolCall(
        {
          tool: 'edit_file',
          args: {
            path: rel,
            edits: [{ op: 'replace_line', ref: `2:${calculateLineHash('beta')}`, content: 'BETA' }],
          },
        },
        root,
      );

      assert.equal(result.ok, true);
      assert.equal(result.meta.version_before, calculateContentVersion(before));
      assert.equal(result.meta.version_after, calculateContentVersion('alpha\nBETA\n'));
      assert.match(result.text, /Applied 1 hashline edits/);
    });
  });

  it('returns structured edit errors for no-match and ambiguous calls', async () => {
    await withTempWorkspace(async (root) => {
      const rel = 'errors.txt';
      await fs.writeFile(path.join(root, rel), 'same same\n', 'utf8');

      const noMatch = await executeToolCall(
        { tool: 'edit_file', args: { path: rel, search: 'missing', replace: 'x' } },
        root,
      );
      assert.equal(noMatch.ok, false);
      assert.equal(noMatch.structuredError.code, 'EDIT_NO_MATCH');
      assert.equal(noMatch.structuredError.retryable, true);

      const ambiguous = await executeToolCall(
        { tool: 'edit_file', args: { path: rel, search: 'same', replace: 'x' } },
        root,
      );
      assert.equal(ambiguous.ok, false);
      assert.equal(ambiguous.structuredError.code, 'EDIT_AMBIGUOUS');
      assert.equal(ambiguous.meta.occurrences, 2);

      const bothShapes = await executeToolCall(
        {
          tool: 'edit_file',
          args: { path: rel, edits: [], search: 'same', replace: 'x' },
        },
        root,
      );
      assert.equal(bothShapes.ok, false);
      assert.equal(bothShapes.structuredError.code, 'EDIT_AMBIGUOUS');
      assert.equal(bothShapes.structuredError.retryable, true);
    });
  });

  it('does not let a failed edit shadow the undo backup of the last successful one', async () => {
    await withTempWorkspace(async (root) => {
      const rel = 'undo.txt';
      const original = 'alpha\nbeta\ngamma\n';
      await fs.writeFile(path.join(root, rel), original, 'utf8');

      const edit = await executeToolCall(
        { tool: 'edit_file', args: { path: rel, search: 'beta', replace: 'BETA' } },
        root,
      );
      assert.equal(edit.ok, true);

      // A failed edit (no match) must not create a newer backup of the
      // already-edited content — undo_edit restores the newest .bak, so that
      // backup would turn undo into a no-op.
      const failed = await executeToolCall(
        { tool: 'edit_file', args: { path: rel, search: 'missing', replace: 'x' } },
        root,
      );
      assert.equal(failed.ok, false);
      assert.equal(failed.structuredError.code, 'EDIT_NO_MATCH');

      const backups = await fs.readdir(path.join(root, '.push', 'backups'));
      assert.equal(backups.length, 1, 'failed edit must not add a backup');

      const undo = await executeToolCall({ tool: 'undo_edit', args: { path: rel } }, root);
      assert.equal(undo.ok, true);
      assert.equal(await fs.readFile(path.join(root, rel), 'utf8'), original);
    });
  });
});
