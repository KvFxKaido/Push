/**
 * Drift-detector for the artifact scope encoder.
 *
 * Per `CLAUDE.md` "New feature checklist" #3: any new shared envelope
 * needs a single canonical definition and a pin test in the same PR.
 * This file is the pin — it locks the key shape so a refactor can't
 * silently change the on-disk encoding and orphan existing artifacts.
 */

import { describe, expect, it } from 'vitest';

import { buildScopeKeys, primaryStorageKey, scopesMatchForListing } from './scope.js';
import { ALL_ARTIFACT_KINDS, isArtifactKind } from './types.js';

describe('artifact scope encoding', () => {
  it('pins the prefix and component order', () => {
    const keys = buildScopeKeys({
      repoFullName: 'acme/widgets',
      branch: 'main',
      chatId: 'chat_123',
    });

    expect(keys.repo).toBe('artifact:acme%2Fwidgets');
    expect(keys.branch).toBe('artifact:acme%2Fwidgets:main');
    expect(keys.chat).toBe('artifact:acme%2Fwidgets:main:chat_123');
  });

  it('substitutes a sentinel when the workspace has no branch', () => {
    const keys = buildScopeKeys({ repoFullName: 'acme/widgets', branch: null });

    expect(keys.branch).toBe('artifact:acme%2Fwidgets:_no_branch');
    expect(keys.chat).toBeNull();
  });

  it('files CLI-shape scopes (no chatId) under the branch key', () => {
    const key = primaryStorageKey({ repoFullName: 'acme/widgets', branch: 'feat/x' }, 'art_001');
    expect(key).toBe('artifact:acme%2Fwidgets:feat%2Fx:art_001');
  });

  it('files web-shape scopes under the chat key', () => {
    const key = primaryStorageKey(
      { repoFullName: 'acme/widgets', branch: 'main', chatId: 'chat_123' },
      'art_001',
    );
    expect(key).toBe('artifact:acme%2Fwidgets:main:chat_123:art_001');
  });

  it('treats omitted and explicit-undefined chatId as the same listing', () => {
    expect(
      scopesMatchForListing(
        { repoFullName: 'acme/widgets', branch: 'main' },
        { repoFullName: 'acme/widgets', branch: 'main', chatId: undefined },
      ),
    ).toBe(true);
  });
});

describe('artifact kind taxonomy', () => {
  it('pins the canonical set of artifact kinds', () => {
    expect([...ALL_ARTIFACT_KINDS].sort()).toEqual([
      'file-tree',
      'live-preview',
      'mermaid',
      'static-html',
      'static-react',
    ]);
  });

  it('rejects unknown kinds via the type guard', () => {
    expect(isArtifactKind('static-html')).toBe(true);
    expect(isArtifactKind('react-component')).toBe(false);
    expect(isArtifactKind(undefined)).toBe(false);
  });
});
