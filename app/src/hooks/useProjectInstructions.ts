import { useState, useCallback, useEffect } from 'react';
import { toast } from 'sonner';
import { execInSandbox, writeToSandbox } from '@/lib/sandbox-client';
import { fileLedger } from '@/lib/file-awareness-ledger';
import { fetchProjectInstructions } from '@/lib/github-tools';
import { syncProjectInstructionsFromSandbox } from '@/lib/project-instructions-utils';
import { buildEffectiveProjectInstructions } from '@/lib/push-built-in-context';
import { buildWorkspaceContext, sanitizeProjectInstructions } from '@/lib/workspace-context';
import type { ActiveRepo, RepoWithActivity, WorkspaceContext, WorkspaceSession } from '@/types';
import type { SandboxStatus } from '@/hooks/useSandbox';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AGENTS_MD_TEMPLATE = `# AGENTS.md

## Project Overview
- What this project does:
- Primary users:
- Current priorities:

## Tech Stack
- Runtime/frameworks:
- Build/test tools:
- Deployment target:

## Architecture Notes
- Key directories:
- Important services/modules:
- Data flow summary:

## Coding Conventions
- Style/linting rules:
- Type/validation expectations:
- Error handling patterns:

## Testing
- Run unit tests:
- Run integration/e2e tests:
- Definition of done:

## Agent Guidance
- Preferred workflow for edits:
- Files/components to read first:
- Things to avoid:
`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProjectInstructionsManager {
  agentsMdContent: string | null;
  instructionFilename: string | null;
  projectInstructionsChecked: boolean;
  projectInstructionsCheckFailed: boolean;
  creatingAgentsMd: boolean;
  creatingAgentsMdWithAI: boolean;
  handleCreateAgentsMd: () => Promise<void>;
  handleCreateAgentsMdWithAI: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useProjectInstructions(
  activeRepo: ActiveRepo | null,
  repos: RepoWithActivity[],
  workspaceSession: WorkspaceSession | null,
  sandbox: {
    sandboxId: string | null;
    status: SandboxStatus;
    start: (repo: string, branch: string) => Promise<string | null>;
  },
  setAgentsMd: (content: string | null) => void,
  setInstructionFilename: (filename: string | null) => void,
  setWorkspaceContext: (ctx: WorkspaceContext | null) => void,
  sendMessage: (message: string) => void,
  isStreaming: boolean,
  setShowFileBrowser: (show: boolean) => void,
  markSnapshotActivity: () => void,
): ProjectInstructionsManager {
  const [agentsMdContent, setAgentsMdContent] = useState<string | null>(null);
  const [instructionFilename, setInstructionFilenameState] = useState<string | null>(null);
  const [projectInstructionsChecked, setProjectInstructionsChecked] = useState(false);
  const [projectInstructionsCheckFailed, setProjectInstructionsCheckFailed] = useState(false);
  const [creatingAgentsMd, setCreatingAgentsMd] = useState(false);
  const [creatingAgentsMdWithAI, setCreatingAgentsMdWithAI] = useState(false);

  const applyEffectiveInstructions = useCallback((rawContent: string | null) => {
    const effective = buildEffectiveProjectInstructions(activeRepo?.full_name, rawContent);
    setAgentsMdContent(effective);
    setAgentsMd(effective);
  }, [activeRepo?.full_name, setAgentsMd]);

  // Helpers
  const refreshProjectInstructionsFromSandbox = useCallback(async (sandboxId: string): Promise<string | null> => {
    return syncProjectInstructionsFromSandbox(sandboxId, {
      applyEffectiveInstructions,
      setInstructionFilenameState,
      setInstructionFilename,
    });
  }, [applyEffectiveInstructions, setInstructionFilename]);

  const autoCommitAgentsMdInSandbox = useCallback(async (sandboxId: string): Promise<{ ok: boolean; message: string }> => {
    const commitResult = await execInSandbox(
      sandboxId,
      `cd /workspace && if [ ! -d .git ]; then git init >/dev/null 2>&1; fi && git add AGENTS.md && if git diff --cached --quiet; then echo "__PUSH_NO_CHANGES__"; else git commit -m "Add project instructions"; fi`,
      undefined,
      { markWorkspaceMutated: true },
    );

    if (commitResult.exitCode !== 0) {
      const detail = commitResult.stderr || commitResult.stdout || 'unknown git error';
      return { ok: false, message: `AGENTS.md created, but commit failed: ${detail}` };
    }

    if ((commitResult.stdout || '').includes('__PUSH_NO_CHANGES__')) {
      return { ok: true, message: 'AGENTS.md already up to date in git.' };
    }

    return { ok: true, message: 'AGENTS.md created and committed.' };
  }, []);

  // Phase A — GitHub API fetch (immediate)
  useEffect(() => {
    if (!activeRepo) {
      setAgentsMdContent(null);
      setAgentsMd(null);
      setInstructionFilenameState(null);
      setInstructionFilename(null);
      setProjectInstructionsChecked(false);
      return;
    }
    setProjectInstructionsChecked(false);
    setProjectInstructionsCheckFailed(false);
    let cancelled = false;
    fetchProjectInstructions(activeRepo.full_name)
      .then((result) => {
        if (cancelled) return;
        applyEffectiveInstructions(result?.content ?? null);
        const filename = result?.filename ?? null;
        setInstructionFilenameState(filename);
        setInstructionFilename(filename);
        setProjectInstructionsChecked(true);
      })
      .catch(() => {
        if (cancelled) return;
        applyEffectiveInstructions(null);
        setInstructionFilenameState(null);
        setInstructionFilename(null);
        setProjectInstructionsChecked(true);
        setProjectInstructionsCheckFailed(true);
      });
    return () => { cancelled = true; };
  }, [activeRepo, applyEffectiveInstructions, setAgentsMd, setInstructionFilename]);

  // Phase B — Sandbox upgrade (overrides Phase A when sandbox is ready)
  useEffect(() => {
    if (sandbox.status !== 'ready' || !sandbox.sandboxId) return;
    let cancelled = false;
    syncProjectInstructionsFromSandbox(sandbox.sandboxId, {
      applyEffectiveInstructions: (content) => {
        if (cancelled) return;
        applyEffectiveInstructions(content);
      },
      setInstructionFilenameState: (filename) => {
        if (cancelled) return;
        setInstructionFilenameState(filename);
      },
      setInstructionFilename: (filename) => {
        if (cancelled) return;
        setInstructionFilename(filename);
      },
    })
      .catch(() => {
        // Sandbox read failed — keep Phase A content
      });
    return () => { cancelled = true; };
  }, [sandbox.status, sandbox.sandboxId, applyEffectiveInstructions, setInstructionFilename]);

  // Build workspace context
  useEffect(() => {
    if (!workspaceSession) {
      // No workspace yet (home/onboarding)
      setWorkspaceContext(null);
      return;
    }
    if (workspaceSession.kind === 'scratch') {
      // Scratch workspace — provide workspace description, no GitHub tools
      const description = 'You are working in an ephemeral workspace at /workspace with no GitHub repo connected.'
        + ' You have full access to the sandbox filesystem and can create, edit, and run files freely.'
        + ' Nothing is saved or committed unless the user explicitly downloads their work.'
        + ' Be a collaborative thinking partner: surface assumptions, propose structure, iterate freely.';
      setWorkspaceContext({ description, includeGitHubTools: false, mode: 'scratch' });
      return;
    }
    if (repos.length > 0) {
      let description = buildWorkspaceContext(repos, activeRepo);
      if (agentsMdContent) {
        const safe = sanitizeProjectInstructions(agentsMdContent);
        description += '\n\n[PROJECT INSTRUCTIONS]\n' + safe + '\n[/PROJECT INSTRUCTIONS]';
      }
      setWorkspaceContext({ description, includeGitHubTools: true, mode: 'repo' });
    } else {
      setWorkspaceContext(null);
    }
  }, [repos, activeRepo, agentsMdContent, workspaceSession, setWorkspaceContext]);

  // Create template AGENTS.md
  const handleCreateAgentsMd = useCallback(async () => {
    if (!activeRepo || creatingAgentsMd) return;
    setCreatingAgentsMd(true);
    try {
      let id = sandbox.sandboxId;
      if (!id) {
        id = await sandbox.start(activeRepo.full_name, activeRepo.current_branch || activeRepo.default_branch);
      }
      if (!id) {
        toast.error('Sandbox is not ready yet. Try again in a moment.');
        return;
      }

      const existing = await refreshProjectInstructionsFromSandbox(id);
      if (existing) {
        toast.error('Project instructions already exist. Use "Create with AI" to update them.');
        return;
      }

      const writeResult = await writeToSandbox(id, '/workspace/AGENTS.md', AGENTS_MD_TEMPLATE);
      if (writeResult.ok) fileLedger.recordMutation('/workspace/AGENTS.md', 'user');
      if (!writeResult.ok) {
        toast.error(writeResult.error || 'Failed to create AGENTS.md');
        return;
      }

      const refreshed = await refreshProjectInstructionsFromSandbox(id);
      if (!refreshed) {
        toast.error('AGENTS.md was written but could not be re-read.');
        return;
      }

      const commitStatus = await autoCommitAgentsMdInSandbox(id);
      if (commitStatus.ok) {
        toast.success(commitStatus.message);
      } else {
        toast.warning(commitStatus.message);
      }
      setProjectInstructionsCheckFailed(false);
      setShowFileBrowser(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create AGENTS.md';
      toast.error(message);
    } finally {
      setCreatingAgentsMd(false);
    }
  }, [activeRepo, creatingAgentsMd, sandbox, refreshProjectInstructionsFromSandbox, autoCommitAgentsMdInSandbox, setShowFileBrowser]);

  // Create AGENTS.md with AI
  const handleCreateAgentsMdWithAI = useCallback(async () => {
    if (!activeRepo || creatingAgentsMdWithAI || isStreaming) return;
    setCreatingAgentsMdWithAI(true);
    markSnapshotActivity();
    try {
      const prompt = [
        `Create an AGENTS.md file for this repository (${activeRepo.full_name}).`,
        'Use sandbox tools to inspect the repo quickly (README, package.json/pyproject, key folders), then write /workspace/AGENTS.md.',
        'Keep it concise and practical, with sections for: Project Overview, Tech Stack, Architecture Notes, Coding Conventions, Testing, Agent Guidance.',
        'If AGENTS.md already exists, overwrite it with an improved version.',
        'After writing the file, commit it with message "Add project instructions".',
        'If there are no staged changes, state that clearly.',
        'After commit, summarize what you included in 5 bullets.',
      ].join('\n');

      await sendMessage(prompt);
      const id = sandbox.sandboxId;
      if (!id) {
        toast.warning('AGENTS.md draft may be ready, but sandbox session is unavailable to refresh context.');
        return;
      }

      const refreshed = await refreshProjectInstructionsFromSandbox(id);
      if (!refreshed) {
        toast.warning('AGENTS.md was not detected after AI run. You can retry or use Create Template.');
        return;
      }

      const commitStatus = await autoCommitAgentsMdInSandbox(id);
      if (commitStatus.ok) {
        toast.success(commitStatus.message);
      } else {
        toast.warning(commitStatus.message);
      }
      setShowFileBrowser(true);
    } finally {
      setCreatingAgentsMdWithAI(false);
    }
  }, [activeRepo, creatingAgentsMdWithAI, isStreaming, markSnapshotActivity, sendMessage, sandbox.sandboxId, refreshProjectInstructionsFromSandbox, autoCommitAgentsMdInSandbox, setShowFileBrowser]);

  return {
    agentsMdContent,
    instructionFilename,
    projectInstructionsChecked,
    projectInstructionsCheckFailed,
    creatingAgentsMd,
    creatingAgentsMdWithAI,
    handleCreateAgentsMd,
    handleCreateAgentsMdWithAI,
  };
}
