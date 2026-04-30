import type { RepoWithActivity, ActiveRepo } from '@/types';
import { getSandboxEnvironment, getSandboxLifecycleEvents } from './sandbox-client';
import { parseGitStatus, MANIFEST_PARSERS, type GitInfo } from '@push/lib/repo-awareness';
import { listDirectory, readFromSandbox, execInSandbox } from './sandbox-client';

export { sanitizeProjectInstructions } from '@push/lib/project-instructions';

export interface WorkspaceContext {
  cwd: string;
  git?: GitInfo;
  project?: string;
  files: string[];
}

// ─── Pure parsing logic (web-friendly) ───

async function getGitSnapshot(sandboxId: string): Promise<GitInfo | null> {
  try {
    const { stdout } = await execInSandbox(sandboxId, 'git status --porcelain -b');
    return parseGitStatus(stdout);
  } catch {
    return null;
  }
}

async function getProjectSummary(sandboxId: string): Promise<string | null> {
  const entries = await listDirectory(sandboxId, '/');
  const files = entries.map((e) => e.name);
  for (const [filename, parser] of Object.entries(MANIFEST_PARSERS)) {
    if (files.includes(filename)) {
      try {
        const { content } = await readFromSandbox(sandboxId, filename);
        const summary = parser(content);
        if (summary) return summary;
      } catch {
        // Skip
      }
    }
  }
  return null;
}

export async function getWorkspaceContext(sandboxId: string): Promise<WorkspaceContext> {
  const entries = await listDirectory(sandboxId, '/');
  const files = entries.map((e) => e.name);
  const [git, project] = await Promise.all([
    getGitSnapshot(sandboxId),
    getProjectSummary(sandboxId),
  ]);

  return {
    cwd: '/',
    git: git || undefined,
    project: project || undefined,
    files: files.filter((f) => !f.startsWith('.')),
  };
}

// ─── Original prompt-building logic ───

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
    stats.push(
      `${repo.activity.recent_commits} commit${repo.activity.recent_commits > 1 ? 's' : ''} this week`,
    );
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

  if (activeRepo) {
    sections.push('WORKSPACE — Active Repository:\n');
    sections.push(formatRepoFull(activeRepo as unknown as RepoWithActivity));

    const otherActive = repos
      .filter((r) => r.activity.has_new_activity && r.id !== activeRepo.id)
      .slice(0, 5);
    if (otherActive.length > 0) {
      sections.push('\nOther active repos:');
      sections.push(otherActive.map((r) => `• ${r.full_name}`).join('\n'));
    }
  } else {
    const active = repos.filter((r) => r.activity.has_new_activity).slice(0, 10);
    const recent = repos.filter((r) => !r.activity.has_new_activity).slice(0, 5);

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
  }

  sections.push('\nUse the tools below to get PR details, commits, or file contents.');

  return sections.join('\n');
}

// ─── Session Diagnostics/Capabilities ───

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
  workspaceContext: { mode: string; includeGitHubTools: boolean },
  hasSandbox?: boolean,
): string {
  const sandboxEnv = hasSandbox ? getSandboxEnvironment() : null;
  const lifecycleEvents = hasSandbox ? getSandboxLifecycleEvents() : [];
  const creationEvent = lifecycleEvents.find((e) => e.message.includes('Workspace created'));
  const ageMs = creationEvent ? Date.now() - creationEvent.timestamp : 0;
  const maxTtlMs = parseDurationToMs(sandboxEnv?.container_ttl);
  const remainingMs = creationEvent && maxTtlMs != null ? Math.max(0, maxTtlMs - ageMs) : null;
  const remainingMinutes = remainingMs != null ? Math.floor(remainingMs / 60_000) : null;

  const formattedEvents = lifecycleEvents.map((e) => {
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
      branchCreation: workspaceContext.mode === 'repo' ? 'tool_available' : 'not_applicable',
      commitTarget: workspaceContext.mode === 'repo' ? 'active_branch' : 'none',
      mergeFlow: workspaceContext.mode === 'repo' ? 'github_pr_only' : 'not_applicable',
    },
    mutationContract: {
      writesReturn: ['touched_files', 'changed_spans', 'new_versions', 'diagnostics'],
    },
  };

  return [
    '[SESSION_CAPABILITIES]',
    JSON.stringify(payload, null, 2),
    '[/SESSION_CAPABILITIES]',
  ].join('\n');
}

export function buildSandboxEnvironmentBlock(hasSandbox?: boolean): string {
  if (!hasSandbox) return '';
  const env = getSandboxEnvironment();
  if (!env) return '';

  const payload = {
    uptime_seconds: env.uptime_seconds,
    container_ttl: env.container_ttl,
  };

  return ['[SANDBOX_ENVIRONMENT]', JSON.stringify(payload, null, 2), '[/SANDBOX_ENVIRONMENT]'].join(
    '\n',
  );
}
