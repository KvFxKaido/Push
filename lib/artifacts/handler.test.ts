/**
 * Validation + construction tests for the create_artifact handler.
 *
 * These pin the per-kind required-fields contract so a model that omits
 * a field gets a stable, structured error code rather than a thrown
 * exception or a half-built record.
 */

import { describe, expect, it } from 'vitest';

import { buildArtifactRecord, summarizeArtifact, validateCreateArtifactArgs } from './handler.js';
import type { ArtifactAuthor, ArtifactScope } from './types.js';

const SCOPE: ArtifactScope = { repoFullName: 'acme/widgets', branch: 'main', chatId: 'chat_1' };
const AUTHOR: ArtifactAuthor = {
  surface: 'cli',
  role: 'orchestrator',
  runId: 'run_test',
  createdAt: 1_700_000_000_000,
};
const FROZEN_NOW = 1_700_000_000_000;
const FROZEN_ID = 'art_test_001';

describe('validateCreateArtifactArgs', () => {
  it('accepts a minimal mermaid artifact', () => {
    const result = validateCreateArtifactArgs({
      kind: 'mermaid',
      title: 'Flow',
      source: 'graph TD; A-->B',
    });
    expect(result.ok).toBe(true);
  });

  it('rejects an unknown kind with INVALID_KIND', () => {
    const result = validateCreateArtifactArgs({ kind: 'wat', title: 'x' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('INVALID_KIND');
    expect(result.field).toBe('kind');
  });

  it('rejects live-preview at validation time and steers to the sibling tool', () => {
    const result = validateCreateArtifactArgs({ kind: 'live-preview', title: 'demo' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/create_live_preview/);
  });

  it('requires a non-empty title', () => {
    const result = validateCreateArtifactArgs({ kind: 'mermaid', title: '', source: 'x' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe('title');
  });

  it('requires non-empty files for static-html', () => {
    const result = validateCreateArtifactArgs({
      kind: 'static-html',
      title: 'page',
      files: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('EMPTY_FILES');
  });

  it('rejects duplicate file paths', () => {
    const result = validateCreateArtifactArgs({
      kind: 'static-react',
      title: 'app',
      files: [
        { path: '/App.js', content: 'a' },
        { path: '/App.js', content: 'b' },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('DUPLICATE_FILE_PATH');
  });

  it('rejects oversized file content', () => {
    const huge = 'x'.repeat(300 * 1024); // 300 KiB > 256 KiB cap
    const result = validateCreateArtifactArgs({
      kind: 'static-html',
      title: 'big',
      files: [{ path: '/index.html', content: huge }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('TOO_LARGE');
  });

  it('accepts optional dependencies on static-react', () => {
    const result = validateCreateArtifactArgs({
      kind: 'static-react',
      title: 'app',
      files: [{ path: '/App.js', content: 'export default () => null' }],
      dependencies: { react: '18.0.0' },
    });
    expect(result.ok).toBe(true);
  });

  it('rejects oversized dependency count with TOO_MANY_DEPENDENCIES', () => {
    const tooMany: Record<string, string> = {};
    for (let i = 0; i < 33; i++) tooMany[`dep_${i}`] = '1.0.0';
    const result = validateCreateArtifactArgs({
      kind: 'static-react',
      title: 'app',
      files: [{ path: '/App.js', content: '...' }],
      dependencies: tooMany,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('TOO_MANY_DEPENDENCIES');
  });

  it('caps total bytes across dependency keys + values', () => {
    // One dep, but the value is huge (> 16 KiB cap). Bypassing the
    // file-byte budget via dependencies was the Codex P2 finding.
    const result = validateCreateArtifactArgs({
      kind: 'static-react',
      title: 'app',
      files: [{ path: '/App.js', content: '...' }],
      dependencies: { react: 'x'.repeat(20 * 1024) },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('TOO_LARGE');
    expect(result.field).toBe('dependencies');
  });

  it('trims leading and trailing whitespace from the title', () => {
    const result = validateCreateArtifactArgs({
      kind: 'mermaid',
      title: '   Spaced Out   ',
      source: 'graph TD; A-->B',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.args.title).toBe('Spaced Out');
  });
});

describe('buildArtifactRecord', () => {
  it('stamps id, scope, author, status=ready, and updatedAt', () => {
    const record = buildArtifactRecord(
      { kind: 'mermaid', title: 'Flow', source: 'graph TD; A-->B' },
      { scope: SCOPE, author: AUTHOR, idOverride: FROZEN_ID, nowOverride: FROZEN_NOW },
    );
    expect(record.id).toBe(FROZEN_ID);
    expect(record.scope).toBe(SCOPE);
    expect(record.author).toBe(AUTHOR);
    expect(record.status).toBe('ready');
    expect(record.updatedAt).toBe(FROZEN_NOW);
  });

  it('defaults file-tree storage to mode: inline', () => {
    const record = buildArtifactRecord(
      {
        kind: 'file-tree',
        title: 'snapshot',
        files: [{ path: '/a.txt', content: 'hello' }],
      },
      { scope: SCOPE, author: AUTHOR, idOverride: FROZEN_ID, nowOverride: FROZEN_NOW },
    );
    if (record.kind !== 'file-tree') throw new Error('expected file-tree');
    expect(record.storage).toEqual({ mode: 'inline' });
  });

  it('passes static-react entry and dependencies through verbatim', () => {
    const record = buildArtifactRecord(
      {
        kind: 'static-react',
        title: 'app',
        files: [{ path: '/App.js', content: '...' }],
        entry: '/App.js',
        dependencies: { react: '18.0.0' },
      },
      { scope: SCOPE, author: AUTHOR, idOverride: FROZEN_ID, nowOverride: FROZEN_NOW },
    );
    if (record.kind !== 'static-react') throw new Error('expected static-react');
    expect(record.entry).toBe('/App.js');
    expect(record.dependencies).toEqual({ react: '18.0.0' });
  });
});

describe('summarizeArtifact', () => {
  it('produces a stable single-line summary including id, kind, and title', () => {
    const record = buildArtifactRecord(
      {
        kind: 'static-react',
        title: 'Counter demo',
        files: [{ path: '/App.js', content: '...' }],
      },
      { scope: SCOPE, author: AUTHOR, idOverride: FROZEN_ID, nowOverride: FROZEN_NOW },
    );
    expect(summarizeArtifact(record)).toBe(
      'Artifact created: art_test_001 — static-react "Counter demo" (1 file).',
    );
  });

  it('omits file count for kinds without files', () => {
    const record = buildArtifactRecord(
      { kind: 'mermaid', title: 'Flow', source: 'graph TD; A-->B' },
      { scope: SCOPE, author: AUTHOR, idOverride: FROZEN_ID, nowOverride: FROZEN_NOW },
    );
    expect(summarizeArtifact(record)).toBe('Artifact created: art_test_001 — mermaid "Flow".');
  });
});
