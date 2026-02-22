import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractAtReferenceCompletionTarget, listReferencePathCompletionsSync } from '../path-completion.mjs';

let tmpDir;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'push-path-complete-'));
  await fsp.mkdir(path.join(tmpDir, 'src', 'api'), { recursive: true });
  await fsp.writeFile(path.join(tmpDir, 'src', 'app.ts'), 'export {};\n', 'utf8');
  await fsp.writeFile(path.join(tmpDir, 'README.md'), '# Test\n', 'utf8');
  await fsp.writeFile(path.join(tmpDir, 'has space.txt'), 'x\n', 'utf8');
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe('extractAtReferenceCompletionTarget', () => {
  it('extracts trailing @path fragment from plain text', () => {
    const target = extractAtReferenceCompletionTarget('review @src/ap');
    assert.deepEqual(target && { token: target.token, fragment: target.fragment }, {
      token: '@src/ap',
      fragment: 'src/ap',
    });
  });

  it('extracts from skill args and punctuation boundaries', () => {
    const target = extractAtReferenceCompletionTarget('/review (@README');
    assert.equal(target?.token, '@README');
  });

  it('ignores emails, escapes, and line refs', () => {
    assert.equal(extractAtReferenceCompletionTarget('foo@bar.com'), null);
    assert.equal(extractAtReferenceCompletionTarget('@@README'), null);
    assert.equal(extractAtReferenceCompletionTarget('look @src/app.ts:12'), null);
  });
});

describe('listReferencePathCompletionsSync', () => {
  it('lists root-level matches and marks directories', () => {
    const hits = listReferencePathCompletionsSync(tmpDir, 's');
    assert.deepEqual(hits, ['src/']);
  });

  it('lists nested matches for partial path', () => {
    const hits = listReferencePathCompletionsSync(tmpDir, 'src/a');
    assert.deepEqual(hits, ['src/api/', 'src/app.ts']);
  });

  it('supports empty fragment and excludes unsupported space names', () => {
    const hits = listReferencePathCompletionsSync(tmpDir, '');
    assert.ok(hits.includes('README.md'));
    assert.ok(hits.includes('src/'));
    assert.ok(!hits.includes('has space.txt'));
  });

  it('rejects traversal attempts', () => {
    const hits = listReferencePathCompletionsSync(tmpDir, '../');
    assert.deepEqual(hits, []);
  });
});

