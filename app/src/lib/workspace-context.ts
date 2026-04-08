import type { RepoWithActivity, ActiveRepo, WorkspaceContext } from '@/types';
import { getSandboxEnvironment, getSandboxLifecycleEvents } from './sandbox-client';

export { sanitizeProjectInstructions } from '@push/lib/project-instructions';

/**
 * Builds a compact workspace summary for injection into the system prompt.
 * Gives the LLM awareness of the user's GitHub repos without consuming
 * much of the context window (~1-2KB for a typical user).
 *
 * When activeRepo is set, it gets detailed treatment while others
 * are listed as compact one-liners.
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

function formatRepoFull(repo: RepoWithActivity): string {
  const parts: string[] = [];

  let line = `• ${repo.full_name}`;
  if (repo.language) line += ` (${repo.language})`;
  if (repo.private) line += ' [private]';
  parts.push(line);

  const stats: string[] = [];
  if (repo.activity.open_prs > 0) {
    stats.push(`${repo.activity.open_prs} open PR${repo.activity.open_prs > 1 ? 's' : ''}`);
  }
  if (repo.activity.recent_commits > 0) {
    stats.push(`${repo.activity.recent_commits} commit${repo.activity.recent_commits > 1 ? 's' : ''} this week`);
  }
  stats.push(`pushed ${relativeTime(repo.pushed_at)}`);

  parts.push(`  ${stats.join(', ')}`);

  if (repo.description) {
    parts.push(`  ${repo.description}`);
  }

  return parts.join('\n');
}

export function buildWorkspaceContext(
  repos: RepoWithActivity[],
  activeRepo?: ActiveRepo | null,
): string {
  if (repos.length === 0) {
    return 'WORKSPACE — No GitHub repos connected. Ask the user to connect their GitHub account in settings.';
  }

  const sections: string[] = [];

  // When an active repo is set, ONLY include that repo — no others
  if (activeRepo) {
    const focused = repos.find((r) => r.id === activeRepo.id);

    sections.push(`REPO — ${activeRepo.full_name}:\n`);
    
    // Show branch context
    const branchContext = activeRepo.current_branch || activeRepo.default_branch;
    const branchIndicator = activeRepo.current_branch 
      ? " (current: " + activeRepo.current_branch + ")"
      : " (default: " + activeRepo.default_branch + ")";
    sections.push("Branch: " + branchContext + branchIndicator + "\n");

    if (focused) {
      sections.push(formatRepoFull(focused));
    } else {
      sections.push(`• ${activeRepo.full_name} (${activeRepo.default_branch})`);
    }
  } else {
    // No active repo — list all with full detail for active ones
    const active = repos.filter((r) => r.activity.has_new_activity).slice(0, 10);
    const recent = repos
      .filter((r) => !r.activity.has_new_activity)
      .slice(0, 5);

    sections.push('WORKSPACE — GitHub repos for this user:\n');

    if (active.length > 0) {
      sections.push('ACTIVE:');
      sections.push(active.map(formatRepoFull).join('\n'));
    }

    if (recent.length > 0) {
      if (active.length > 0) sections.push('');
      sections.push('RECENT:');
      sections.push(recent.map(formatRepoFull).join('\n'));
    }

    if (active.length === 0 && recent.length === 0) {
      sections.push('REPOS:');
      sections.push(repos.slice(0, 10).map(formatRepoFull).join('\n'));
    }
  }

  sections.push('\nUse the tools below to get PR details, commits, or file contents.');

  return sections.join('\n');
}

function parseDurationToMs(raw: string | null | undefined): number | null {
  if (!raw) return null;

  const matches = [...raw.matchAll(/(\d+)\s*([smhd])/gi)];
  if (matches.length === 0) return null;

  const normalized = raw.replace(/\s+/g, '').toLowerCase();
  const consumed = matches.map((match) => match[0].replace(/\s+/g, '').toLowerCase()).join('');
  if (normalized !== consumed) return null;

  let total = 0;
  for (const [, amount, unit] of matches) {
    const value = Number.parseInt(amount, 10);
    if (!Number.isFinite(value)) return null;
    if (unit.toLowerCase() === 's') total += value * 1000;
    else if (unit.toLowerCase() === 'm') total += value * 60_000;
    else if (unit.toLowerCase() === 'h') total += value * 3_600_000;
    else if (unit.toLowerCase() === 'd') total += value * 86_400_000;
  }

  return total > 0 ? total : null;
}

export function buildSessionCapabilityBlock(
  workspaceContext: Pick<WorkspaceContext, 'mode' | 'includeGitHubTools'>,
  hasSandbox?: boolean,
): string {
  const sandboxEnv = hasSandbox ? getSandboxEnvironment() : null;
  const lifecycleEvents = hasSandbox ? getSandboxLifecycleEvents() : [];
  const creationEvent = lifecycleEvents.find(e => e.message.includes('Workspace created'));
  const ageMs = creationEvent ? Date.now() - creationEvent.timestamp : 0;
  const maxTtlMs = parseDurationToMs(sandboxEnv?.container_ttl);
  const remainingMs = creationEvent && maxTtlMs != null ? Math.max(0, maxTtlMs - ageMs) : null;
  const remainingMinutes = remainingMs != null ? Math.floor(remainingMs / 60_000) : null;
  
  const formattedEvents = lifecycleEvents.map(e => {
    const d = new Date(e.timestamp);
    return `[${d.toISOString()}] ${e.message}`;
  });

  const payload = {
    workspaceMode: workspaceContext.mode,
    githubTools: workspaceContext.includeGitHubTools,
    sandbox: {
      available: Boolean(hasSandbox),
      writableRoot: sandboxEnv?.writable_root ?? (hasSandbox ? '/workspace' : null),
      gitAvailable: sandboxEnv?.git_available ?? null,
      containerTtl: sandboxEnv?.container_ttl ?? null,
      containerTtlRemaining: remainingMinutes != null ? `${remainingMinutes}m` : null,
      lifecycleEvents: formattedEvents,
      toolVersions: sandboxEnv?.tools ?? {},
      projectMarkers: sandboxEnv?.project_markers?.slice(0, 8) ?? [],
      scripts: sandboxEnv?.scripts ? Object.keys(sandboxEnv.scripts).sort() : [],
      readiness: sandboxEnv?.readiness ?? null,
      warnings: sandboxEnv?.warnings?.slice(0, 4) ?? [],
    },
    workflow: {
      branchSwitching: workspaceContext.mode === 'repo' ? 'explicit_ui_only' : 'not_applicable',
      commitTarget: workspaceContext.mode === 'repo' ? 'active_branch' : 'none',
      mergeFlow: workspaceContext.mode === 'repo' ? 'github_pr_only' : 'not_applicable',
    },
    mutationContract: {
      writesReturn: ['touched_files', 'changed_spans', 'new_versions', 'diagnostics'],
    },
  };

  return ['[SESSION_CAPABILITIES]', JSON.stringify(payload, null, 2), '[/SESSION_CAPABILITIES]'].join('\n');
}
