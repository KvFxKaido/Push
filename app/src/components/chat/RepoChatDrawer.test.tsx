import { describe, expect, it } from 'vitest';
import { chatDrawerRepoTag } from '@/components/chat/repo-chat-drawer-utils';

const repoNames = new Map<string, string>([['kvfxkaido/push', 'Push']]);

describe('chatDrawerRepoTag — Recents repo tag (replaces the branch stamp)', () => {
  it('prefers the repo display name when the full name is known', () => {
    expect(chatDrawerRepoTag({ repoFullName: 'kvfxkaido/push' }, repoNames)).toBe('Push');
  });

  it('falls back to the owner/repo tail when the repo is not in the map', () => {
    expect(chatDrawerRepoTag({ repoFullName: 'someone/other-repo' }, repoNames)).toBe('other-repo');
  });

  it('falls back to the raw full name when there is no slash to split', () => {
    expect(chatDrawerRepoTag({ repoFullName: 'bare-name' }, repoNames)).toBe('bare-name');
  });

  it('falls back to the raw full name for a trailing-slash form (empty tail)', () => {
    expect(chatDrawerRepoTag({ repoFullName: 'owner/' }, repoNames)).toBe('owner/');
  });

  it('tags unscoped chats by workspace mode', () => {
    expect(chatDrawerRepoTag({ mode: 'chat' }, repoNames)).toBe('Chat');
    expect(chatDrawerRepoTag({ mode: 'relay' }, repoNames)).toBe('Remote');
    expect(chatDrawerRepoTag({}, repoNames)).toBe('Unscoped');
  });

  it('does not surface a branch anywhere in the tag', () => {
    // The tag is repo/mode-derived only — branch is no longer a drawer concept.
    expect(chatDrawerRepoTag({ repoFullName: 'kvfxkaido/push' }, repoNames)).not.toMatch(
      /main|dev/,
    );
  });
});
