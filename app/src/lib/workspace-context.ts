import type { RepoWithActivity } from '@/types';

/**
 * Builds a compact workspace summary for injection into the system prompt.
 * Gives the LLM awareness of the user's GitHub repos without consuming
 * much of the context window (~1-2KB for a typical user).
 */

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w ago`;
}

function formatRepo(repo: RepoWithActivity): string {
  const parts: string[] = [];

  // Name + language
  let line = `• ${repo.full_name}`;
  if (repo.language) line += ` (${repo.language})`;
  if (repo.private) line += ' [private]';
  parts.push(line);

  // Activity summary
  const stats: string[] = [];
  if (repo.activity.open_prs > 0) {
    stats.push(`${repo.activity.open_prs} open PR${repo.activity.open_prs > 1 ? 's' : ''}`);
  }
  if (repo.activity.recent_commits > 0) {
    stats.push(`${repo.activity.recent_commits} commit${repo.activity.recent_commits > 1 ? 's' : ''} this week`);
  }
  stats.push(`pushed ${relativeTime(repo.pushed_at)}`);

  parts.push(`  ${stats.join(', ')}`);

  // Description if present
  if (repo.description) {
    parts.push(`  ${repo.description}`);
  }

  return parts.join('\n');
}

export function buildWorkspaceContext(repos: RepoWithActivity[]): string {
  if (repos.length === 0) {
    return 'WORKSPACE — No GitHub repos connected. Ask the user to connect their GitHub account in settings.';
  }

  const active = repos.filter((r) => r.activity.has_new_activity).slice(0, 10);
  const recent = repos
    .filter((r) => !r.activity.has_new_activity)
    .slice(0, 5);

  const sections: string[] = ['WORKSPACE — GitHub repos for this user:\n'];

  if (active.length > 0) {
    sections.push('ACTIVE:');
    sections.push(active.map(formatRepo).join('\n'));
  }

  if (recent.length > 0) {
    if (active.length > 0) sections.push('');
    sections.push('RECENT:');
    sections.push(recent.map(formatRepo).join('\n'));
  }

  // If all repos are inactive (no "active" ones)
  if (active.length === 0 && recent.length === 0) {
    sections.push('REPOS:');
    sections.push(repos.slice(0, 10).map(formatRepo).join('\n'));
  }

  sections.push('\nUse the tools below to get PR details, commits, or file contents.');

  return sections.join('\n');
}
