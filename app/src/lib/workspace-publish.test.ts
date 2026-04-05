import { describe, expect, it } from 'vitest';
import { cleanWorkspacePublishMessage } from './workspace-publish';

describe('cleanWorkspacePublishMessage', () => {
  it('removes tool error prefixes', () => {
    expect(cleanWorkspacePublishMessage('[Tool Error] GitHub auth required.')).toBe('GitHub auth required.');
  });

  it('removes tool result headers and preserves the message body', () => {
    expect(
      cleanWorkspacePublishMessage('[Tool Result — promote_to_github]\nRepository created: ishaw/demo'),
    ).toBe('Repository created: ishaw/demo');
  });
});
