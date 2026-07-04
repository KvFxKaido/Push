import type { Conversation } from '@/types';

// Repo tag for a Recents row — the disambiguator that replaced the dropped
// branch stamp (chat titles duplicate hard across a repo). Prefers the repo's
// display name, falls back to the `owner/repo` tail, then the raw full name;
// unscoped chats tag by workspace mode. Pure + isolated for unit coverage and
// to keep RepoChatDrawer a component-only module (react-refresh).
export function chatDrawerRepoTag(
  chat: Pick<Conversation, 'repoFullName' | 'mode'>,
  repoNameByFullName: Map<string, string>,
): string {
  if (chat.repoFullName) {
    const fromMap = repoNameByFullName.get(chat.repoFullName);
    if (fromMap) return fromMap;
    // `||` (not `??`) so a trailing-slash form like "owner/" — whose tail is
    // the empty string, not undefined — falls back to the raw full name.
    return chat.repoFullName.split('/').pop() || chat.repoFullName;
  }
  if (chat.mode === 'chat') return 'Chat';
  if (chat.mode === 'relay') return 'Remote';
  return 'Unscoped';
}
