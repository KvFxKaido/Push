import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseFileReferences,
  buildFileReferenceContextMessage,
  appendUserMessageWithFileReferences,
  MAX_FILE_REFERENCE_COUNT,
} from '../file-references.mjs';

let tmpDir;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'push-file-refs-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('parseFileReferences', () => {
  it('parses file refs with optional line ranges', () => {
    const { refs, skippedDueToLimit } = parseFileReferences('Check @src/a.ts and @src/b.ts:10 and @src/c.ts:20-30');
    assert.equal(skippedDueToLimit, 0);
    assert.deepEqual(refs.map((r) => [r.path, r.startLine, r.endLine, r.invalidRange]), [
      ['src/a.ts', null, null, false],
      ['src/b.ts', 10, 10, false],
      ['src/c.ts', 20, 30, false],
    ]);
  });

  it('ignores emails and escaped @@ mentions', () => {
    const { refs } = parseFileReferences('email foo@bar.com @@README.md but keep @README.md');
    assert.deepEqual(refs.map((r) => r.path), ['README.md']);
  });

  it('dedupes refs and trims trailing punctuation', () => {
    const { refs } = parseFileReferences('See (@src/x.ts:5-7), then again @src/x.ts:5-7.');
    assert.equal(refs.length, 1);
    assert.equal(refs[0].path, 'src/x.ts');
    assert.equal(refs[0].startLine, 5);
    assert.equal(refs[0].endLine, 7);
  });

  it('caps number of refs', () => {
    const text = Array.from({ length: MAX_FILE_REFERENCE_COUNT + 2 }, (_, i) => `@f${i}.txt`).join(' ');
    const { refs, skippedDueToLimit } = parseFileReferences(text);
    assert.equal(refs.length, MAX_FILE_REFERENCE_COUNT);
    assert.equal(skippedDueToLimit, 2);
  });

  it('marks invalid descending ranges', () => {
    const { refs } = parseFileReferences('bad @src/x.ts:10-2');
    assert.equal(refs.length, 1);
    assert.equal(refs[0].invalidRange, true);
  });
});

describe('buildFileReferenceContextMessage', () => {
  it('returns null message when no refs are present', async () => {
    const result = await buildFileReferenceContextMessage('no refs here', tmpDir);
    assert.equal(result.message, null);
    assert.equal(result.parsedCount, 0);
  });

  it('resolves refs and renders anchored file content', async () => {
    await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'src', 'demo.ts'), 'alpha\nbeta\ngamma\n', 'utf8');

    const result = await buildFileReferenceContextMessage('inspect @src/demo.ts:2-3', tmpDir);

    assert.equal(result.resolvedCount, 1);
    assert.equal(result.errorCount, 0);
    assert.ok(result.message.includes('[REFERENCED_FILES]'));
    assert.ok(result.message.includes('"path":"src/demo.ts"'));
    assert.ok(result.message.includes('2|'));
    assert.ok(result.message.includes('| beta'));
    assert.ok(result.message.includes('3|'));
    assert.ok(result.message.includes('| gamma'));
  });

  it('reports missing files and invalid ranges', async () => {
    const result = await buildFileReferenceContextMessage('use @missing.ts and @bad.ts:9-2', tmpDir);
    assert.equal(result.resolvedCount, 0);
    assert.equal(result.errorCount, 2);
    assert.ok(result.message.includes('[FILE_REFERENCE_ERROR]'));
    assert.ok(result.message.includes('"code":"NOT_FOUND"'));
    assert.ok(result.message.includes('"code":"INVALID_RANGE"'));
  });
});

describe('appendUserMessageWithFileReferences', () => {
  it('keeps user message unchanged and appends synthetic ref block', async () => {
    await fs.writeFile(path.join(tmpDir, 'README.md'), 'hello\nworld\n', 'utf8');
    const state = { messages: [] };
    const userText = 'Please review @README.md';

    const info = await appendUserMessageWithFileReferences(state, userText, tmpDir);

    assert.equal(info.resolvedCount, 1);
    assert.equal(state.messages.length, 2);
    assert.deepEqual(state.messages[0], { role: 'user', content: userText });
    assert.equal(state.messages[1].role, 'user');
    assert.ok(state.messages[1].content.startsWith('[REFERENCED_FILES]'));
  });

  it('can parse refs from a different source text than the expanded message', async () => {
    await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'src', 'x.ts'), 'one\ntwo\n', 'utf8');
    const state = { messages: [] };
    const prompt = 'Expanded skill prompt with no file refs in body.';
    const rawArgs = 'Investigate @src/x.ts';

    const info = await appendUserMessageWithFileReferences(state, prompt, tmpDir, { referenceSourceText: rawArgs });

    assert.equal(info.resolvedCount, 1);
    assert.equal(state.messages.length, 2);
    assert.equal(state.messages[0].content, prompt);
    assert.ok(state.messages[1].content.includes('"path":"src/x.ts"'));
  });
});

