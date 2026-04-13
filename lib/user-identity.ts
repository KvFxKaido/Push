/**
 * User-identity system-prompt block.
 *
 * Every agent role composes a `[USER IDENTITY]` / `[/USER IDENTITY]` bracketed
 * section into its system prompt when a profile is present. The block is
 * injected verbatim by the caller — the builder here is pure, takes the
 * profile as an argument, and returns a plain string so lib/-side agents
 * don't have to reach into Web's `@/hooks/useUserProfile` module.
 */

/** Minimal user-profile shape used by lib/-side prompt builders. */
export interface UserProfile {
  displayName: string;
  githubLogin?: string;
  bio: string;
  /** Longer-form instructions for plain chat mode (not the short bio). */
  chatInstructions?: string;
}

export function buildUserIdentityBlock(profile?: UserProfile): string {
  const hasName = Boolean(profile?.displayName?.trim());
  const hasGitHub = Boolean(profile?.githubLogin?.trim());
  const hasBio = Boolean(profile?.bio?.trim());
  if (!profile || (!hasName && !hasGitHub && !hasBio)) return '';

  const lines = ['## User Identity'];
  if (hasName) {
    lines.push(`Name: ${profile.displayName.trim()}`);
  }
  if (hasGitHub) {
    lines.push(`GitHub: @${profile.githubLogin}`);
  }
  if (hasBio) {
    // Escape delimiter-breaking attempts (same pattern as scratchpad)
    const escaped = profile.bio
      .trim()
      .replace(/\[USER IDENTITY\]/gi, '[USER IDENTITY\u200B]')
      .replace(/\[\/USER IDENTITY\]/gi, '[/USER IDENTITY\u200B]');
    lines.push(`Context: ${escaped}`);
  }
  return lines.join('\n');
}
