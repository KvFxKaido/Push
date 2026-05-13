import type { RepoWithActivity, ActiveRepo, WorkspaceContext } from '@/types';
import { getSandboxEnvironment, getSandboxLifecycleEvents } from './sandbox-client';
import { parseGitStatus, MANIFEST_PARSERS, type GitInfo } from '@push/lib/repo-awareness';
import { listDirectory, readFromSandbox, execInSandbox } from './sandbox-client';

export { sanitizeProjectInstructions } from '@push/lib/project-instructions';

export interface SandboxWorkspaceContext {
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
  const entries = await listDirectory(sandboxId, '/workspace');
  const files = entries.map((e) => e.name);
  for (const [filename, parser] of Object.entries(MANIFEST_PARSERS)) {
    if (files.includes(filename)) {
      try {
        const { content } = await readFromSandbox(sandboxId, `/workspace/${filename}`);
        const summary = parser(content);
        if (summary) return summary;
      } catch {
        // Skip
      }
    }
  }
  return null;
}

export async function getWorkspaceContext(sandboxId: string): Promise<SandboxWorkspaceContext> {
  const entries = await listDirectory(sandboxId, '/workspace');
  const files = entries.map((e) => e.name);
  const [git, project] = await Promise.all([
    getGitSnapshot(sandboxId),
    getProjectSummary(sandboxId),
  ]);

  return {
    cwd: '/workspace',
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

function formatActiveRepo(active: ActiveRepo, repos: RepoWithActivity[]): string {
  const match = repos.find((r) => r.id === active.id);
  if (match) return formatRepoFull(match);
  // Fallback: render from ActiveRepo fields only (no activity stats available).
  let line = `• ${active.full_name}`;
  if (active.private) line += ' [private]';
  return `${line}
  (${active.default_branch})`;
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
    sections.push(formatActiveRepo(activeRepo, repos));

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

/**
 * Workspace description for a `kind: 'local-pc'` session.
 *
 * Without this block, the orchestrator's environment section is empty
 * for local-pc and the model falls back to cloud-sandbox priors —
 * `/workspace/` paths, GitHub repo exploration, Explorer-delegation
 * reflexes. This block establishes the local-pc facts explicitly.
 *
 * NOTE: this block alone is not sufficient. The orchestrator also
 * needs `LOCAL_PC_TOOL_PROTOCOL` (the local-pc-shaped tool protocol)
 * in place of `SANDBOX_TOOL_PROTOCOL`, otherwise the cloud sandbox
 * protocol — which mentions `/workspace` 9+ times and lists remote-
 * bound tools (promote, push, prepare_commit) — fights this context
 * for the model's attention. See `orchestrator.ts`'s mode branch.
 *
 * Smoke-tested 2026-05-13 after PR 3c.2: without this block the model
 * rewrote `/tmp/foo` → `/workspace/foo` on writes and reflexively
 * delegated Explorer to "trace auth flow in src/auth.ts" (which is
 * literally the canonical example in the explorer tool registry —
 * the model parrots it back when it has no other context).
 */
export function buildLocalPcWorkspaceContext(): string {
  return [
    'WORKSPACE — Paired Local PC (pushd daemon):',
    '',
    "You are connected to a local daemon (pushd) running on the user's machine.",
    "The daemon's current working directory IS the workspace root — relative paths",
    'resolve against it. Absolute paths are REAL host filesystem paths.',
    '',
    'PATH RULES (load-bearing):',
    '• Do NOT rewrite absolute paths into a `/workspace/` prefix. `/tmp/foo` means',
    '  `/tmp/foo` on the host, not `/workspace/foo`. There is no `/workspace/` here.',
    "• The daemon enforces a repo allowlist: writes must land inside the daemon's",
    '  cwd (or another configured allowed root). If a write to an absolute path',
    '  outside the allowlist is rejected (`PATH_OUTSIDE_WORKSPACE`), retry with a',
    '  relative path or surface the constraint to the user — do NOT invent a',
    '  `/workspace/` path to substitute.',
    '• Relative paths (`./src/foo.ts`, `package.json`) resolve against the cwd and',
    '  are the simplest shape for most operations.',
    '',
    'NO GITHUB REPO is bound to this workspace.',
    '• Do NOT delegate to the Explorer agent — its tooling depends on GitHub repo',
    "  context that doesn't exist here. The Explorer summary will be confused or",
    '  empty and the user will see a useless answer.',
    '• Do NOT call `commit`, `push`, `pr`, `promote_to_github`, or remote-bound',
    '  tools — there is no remote.',
    '',
    'AVAILABLE TOOLS for filesystem and command work (see the local-pc protocol',
    'block below for the full signatures):',
    '• `sandbox_exec` — run a shell command on the host (cwd = workspace root)',
    '• `sandbox_read_file` — read a file by absolute or relative path',
    '• `sandbox_write_file` — write a file by absolute or relative path',
    '• `sandbox_list_dir` — list a directory',
    '• `sandbox_get_diff` (alias `sandbox_diff`) — show git diff for the workspace',
    '',
    'When the user asks a simple one-shot question (e.g. "what\'s my pwd?"), call',
    'ONE tool and answer with the result. Do not delegate or fan out exploration',
    'for short questions.',
  ].join('\n');
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
  workspaceContext: Pick<WorkspaceContext, 'mode' | 'includeGitHubTools'>,
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
