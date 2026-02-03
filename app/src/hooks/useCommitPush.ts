/**
 * useCommitPush — encapsulates the commit + push pipeline for the file browser.
 *
 * No LLM involvement. Directly calls sandbox client functions
 * and the Auditor agent. Phase-driven state machine:
 *
 *   idle → fetching-diff → reviewing → auditing → committing → pushing → success | error
 */

import { useState, useCallback } from 'react';
import { getSandboxDiff, execInSandbox } from '@/lib/sandbox-client';
import { runAuditor } from '@/lib/auditor-agent';
import { getMoonshotKey } from '@/hooks/useMoonshotKey';
import type { DiffPreviewCardData, AuditVerdictCardData } from '@/types';

export type CommitPushPhase =
  | 'idle'
  | 'fetching-diff'
  | 'reviewing'
  | 'auditing'
  | 'committing'
  | 'pushing'
  | 'success'
  | 'error';

interface CommitPushState {
  phase: CommitPushPhase;
  diff: DiffPreviewCardData | null;
  auditVerdict: AuditVerdictCardData | null;
  error: string | null;
  commitMessage: string;
}

function parseDiffStats(diff: string): { filesChanged: number; additions: number; deletions: number } {
  const files = new Set<string>();
  let additions = 0;
  let deletions = 0;

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git')) {
      const match = line.match(/b\/(.+)$/);
      if (match) files.add(match[1]);
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      additions++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      deletions++;
    }
  }

  return { filesChanged: files.size, additions, deletions };
}

export function useCommitPush(sandboxId: string) {
  const [state, setState] = useState<CommitPushState>({
    phase: 'idle',
    diff: null,
    auditVerdict: null,
    error: null,
    commitMessage: '',
  });

  const setCommitMessage = useCallback((msg: string) => {
    setState((s) => ({ ...s, commitMessage: msg }));
  }, []);

  const reset = useCallback(() => {
    setState({
      phase: 'idle',
      diff: null,
      auditVerdict: null,
      error: null,
      commitMessage: '',
    });
  }, []);

  const fetchDiff = useCallback(async () => {
    setState((s) => ({ ...s, phase: 'fetching-diff', error: null, diff: null, auditVerdict: null }));

    try {
      const result = await getSandboxDiff(sandboxId);

      if (!result.diff) {
        setState((s) => ({ ...s, phase: 'error', error: 'Nothing to commit — no changes detected.' }));
        return;
      }

      const stats = parseDiffStats(result.diff);
      const diffData: DiffPreviewCardData = {
        diff: result.diff,
        filesChanged: stats.filesChanged,
        additions: stats.additions,
        deletions: stats.deletions,
        truncated: result.truncated,
      };

      setState((s) => ({ ...s, phase: 'reviewing', diff: diffData }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setState((s) => ({ ...s, phase: 'error', error: msg }));
    }
  }, [sandboxId]);

  const commitAndPush = useCallback(async () => {
    const message = state.commitMessage.trim();
    if (!message) {
      setState((s) => ({ ...s, phase: 'error', error: 'Commit message is required.' }));
      return;
    }

    // Check Kimi key for Auditor
    if (!getMoonshotKey()) {
      setState((s) => ({
        ...s,
        phase: 'error',
        error: 'Auditor requires a Kimi API key. Add one in Settings.',
      }));
      return;
    }

    // Phase: Auditing
    setState((s) => ({ ...s, phase: 'auditing', auditVerdict: null }));

    try {
      const diffText = state.diff?.diff;
      if (!diffText) {
        setState((s) => ({ ...s, phase: 'error', error: 'No diff available.' }));
        return;
      }

      const auditResult = await runAuditor(diffText, () => {});

      setState((s) => ({ ...s, auditVerdict: auditResult.card }));

      if (auditResult.verdict === 'unsafe') {
        setState((s) => ({
          ...s,
          phase: 'error',
          error: `Commit blocked by Auditor: ${auditResult.card.summary}`,
        }));
        return;
      }

      // Phase: Committing
      setState((s) => ({ ...s, phase: 'committing' }));

      const commitResult = await execInSandbox(
        sandboxId,
        `cd /workspace && git add -A && git commit -m "${message.replace(/"/g, '\\"')}"`,
      );

      if (commitResult.exitCode !== 0) {
        // Git may write errors to stdout (e.g., "nothing to commit") or stderr
        const errorDetail = commitResult.stderr || commitResult.stdout || 'Unknown error';
        setState((s) => ({
          ...s,
          phase: 'error',
          error: `Commit failed: ${errorDetail}`,
        }));
        return;
      }

      // Phase: Pushing
      setState((s) => ({ ...s, phase: 'pushing' }));

      const pushResult = await execInSandbox(sandboxId, 'cd /workspace && git push origin HEAD');

      if (pushResult.exitCode !== 0) {
        const errorDetail = pushResult.stderr || pushResult.stdout || 'Unknown error';
        setState((s) => ({
          ...s,
          phase: 'error',
          error: `Push failed: ${errorDetail}`,
        }));
        return;
      }

      // Success
      setState((s) => ({ ...s, phase: 'success' }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setState((s) => ({ ...s, phase: 'error', error: msg }));
    }
  }, [sandboxId, state.commitMessage, state.diff]);

  return {
    phase: state.phase,
    diff: state.diff,
    auditVerdict: state.auditVerdict,
    error: state.error,
    commitMessage: state.commitMessage,
    setCommitMessage,
    fetchDiff,
    commitAndPush,
    reset,
  };
}
