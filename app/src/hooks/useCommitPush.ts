/**
 * useCommitPush — encapsulates the commit + push pipeline for the file browser.
 *
 * No LLM involvement beyond the Auditor. Phase-driven state machine:
 *
 *   idle → fetching-diff → reviewing → auditing → committing → pushing → success
 *                                              ↘ recovering ↗
 *
 * Cold-resume on sandbox death: if `git commit` or `git push` fails because
 * the underlying sandbox is gone, we mint a fresh one via the caller-supplied
 * `onSandboxExpired` callback, replay the captured diff via `git apply`, and
 * re-run commit + push from scratch. The dead container's commit history
 * doesn't survive, so recovery always starts from the diff.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import {
  getSandboxDiff,
  execInSandbox,
  readFromSandbox,
  writeToSandbox,
  type ExecResult,
} from '@/lib/sandbox-client';
import { runAuditor } from '@/lib/auditor-agent';
import { fetchAuditorFileContexts, type AuditorFileContext } from '@/lib/auditor-file-context';
import { getActiveProvider, type ActiveProvider } from '@/lib/orchestrator';
import { parseDiffStats } from '@/lib/diff-utils';
import { isDefinitivelyGoneMessage } from '@/lib/sandbox-error-utils';
import type { DiffPreviewCardData, AuditVerdictCardData } from '@/types';

export type CommitPushPhase =
  | 'idle'
  | 'fetching-diff'
  | 'reviewing'
  | 'auditing'
  | 'committing'
  | 'pushing'
  | 'recovering'
  | 'success'
  | 'error';

interface CommitPushState {
  phase: CommitPushPhase;
  diff: DiffPreviewCardData | null;
  auditVerdict: AuditVerdictCardData | null;
  error: string | null;
  commitMessage: string;
}

const RECOVERY_PATCH_PATH = '/tmp/push-recovery.patch';

type AttemptResult =
  | { status: 'success' }
  | { status: 'expired' }
  | { status: 'failed'; error: string };

function isExecResultGone(result: ExecResult): boolean {
  // exit_code === -1 alone is not proof; isDefinitivelyGoneMessage matches on
  // the specific phrases that prove the container is gone, not transient
  // failures.
  const combined = `${result.error || ''} ${result.stderr || ''} ${result.stdout || ''}`;
  return isDefinitivelyGoneMessage(combined);
}

export function useCommitPush(
  sandboxId: string,
  providerOverride?: ActiveProvider | null,
  modelOverride?: string | null,
  onSandboxExpired?: () => Promise<string | null>,
) {
  const [state, setState] = useState<CommitPushState>({
    phase: 'idle',
    diff: null,
    auditVerdict: null,
    error: null,
    commitMessage: '',
  });

  // Recovery may swap the sandbox mid-pipeline; the ref is the source of
  // truth for in-flight calls so they don't keep targeting the dead one.
  const sandboxIdRef = useRef(sandboxId);
  useEffect(() => {
    sandboxIdRef.current = sandboxId;
  }, [sandboxId]);

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
    setState((s) => ({
      ...s,
      phase: 'fetching-diff',
      error: null,
      diff: null,
      auditVerdict: null,
    }));

    try {
      const result = await getSandboxDiff(sandboxIdRef.current);

      if (!result.diff) {
        setState((s) => ({
          ...s,
          phase: 'error',
          error: 'Nothing to commit — no changes detected.',
        }));
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
  }, []);

  const commitAndPush = useCallback(async () => {
    const message = state.commitMessage.replace(/[\r\n]+/g, ' ').trim();
    if (!message) {
      setState((s) => ({ ...s, phase: 'error', error: 'Commit message is required.' }));
      return;
    }
    const safeCommitMessage = message.replace(/'/g, `'"'"'`);

    const effectiveAuditorProvider = providerOverride || getActiveProvider();
    const effectiveAuditorModel = modelOverride?.trim() || undefined;

    if (effectiveAuditorProvider === 'demo') {
      setState((s) => ({
        ...s,
        phase: 'error',
        error: 'No AI provider configured. Add an API key in Settings to enable the Auditor.',
      }));
      return;
    }

    setState((s) => ({ ...s, phase: 'auditing', auditVerdict: null }));

    try {
      const diffText = state.diff?.diff;
      if (!diffText) {
        setState((s) => ({ ...s, phase: 'error', error: 'No diff available.' }));
        return;
      }

      // Fetch file context for richer Auditor review (graceful — failures degrade to diff-only)
      let fileContexts: AuditorFileContext[] = [];
      try {
        const filePaths = parseDiffStats(diffText).fileNames;
        fileContexts = await fetchAuditorFileContexts(filePaths, async (path) => {
          const result = await readFromSandbox(sandboxIdRef.current, `/workspace/${path}`);
          if (result.error) return null;
          return { content: result.content, truncated: result.truncated };
        });
      } catch {
        // Degrade gracefully — proceed with diff-only
      }

      const auditResult = await runAuditor(
        diffText,
        () => {},
        {
          source: 'working-tree-commit',
          sourceLabel: 'Working tree diff before commit/push',
        },
        undefined,
        {
          providerOverride: effectiveAuditorProvider,
          modelOverride: effectiveAuditorModel,
        },
        fileContexts,
      );

      setState((s) => ({ ...s, auditVerdict: auditResult.card }));

      if (auditResult.verdict === 'unsafe') {
        setState((s) => ({
          ...s,
          phase: 'error',
          error: `Commit blocked by Auditor: ${auditResult.card.summary}`,
        }));
        return;
      }

      const attemptCommitAndPush = async (
        targetSandbox: string,
        applyPatchFirst: boolean,
      ): Promise<AttemptResult> => {
        if (applyPatchFirst) {
          const writeResult = await writeToSandbox(targetSandbox, RECOVERY_PATCH_PATH, diffText);
          if (!writeResult.ok) {
            const errMsg = writeResult.error || 'unknown write failure';
            if (isDefinitivelyGoneMessage(errMsg)) return { status: 'expired' };
            return {
              status: 'failed',
              error: `Failed to stage diff in recovered sandbox: ${errMsg}`,
            };
          }

          const applyResult = await execInSandbox(
            targetSandbox,
            `cd /workspace && git apply --whitespace=nowarn ${RECOVERY_PATCH_PATH}`,
            undefined,
            { markWorkspaceMutated: true },
          );
          if (applyResult.exitCode !== 0) {
            if (isExecResultGone(applyResult)) return { status: 'expired' };
            const detail =
              applyResult.stderr || applyResult.stdout || applyResult.error || 'Unknown error';
            return {
              status: 'failed',
              error: `Failed to apply diff to recovered sandbox: ${detail}`,
            };
          }
        }

        setState((s) => ({ ...s, phase: 'committing' }));
        const commitResult = await execInSandbox(
          targetSandbox,
          `cd /workspace && git add -A && git commit -m '${safeCommitMessage}'`,
          undefined,
          { markWorkspaceMutated: true },
        );
        if (commitResult.exitCode !== 0) {
          if (isExecResultGone(commitResult)) return { status: 'expired' };
          const detail =
            commitResult.stderr || commitResult.stdout || commitResult.error || 'Unknown error';
          return { status: 'failed', error: `Commit failed: ${detail}` };
        }

        setState((s) => ({ ...s, phase: 'pushing' }));
        const pushResult = await execInSandbox(
          targetSandbox,
          'cd /workspace && git push origin HEAD',
          undefined,
          { markWorkspaceMutated: true },
        );
        if (pushResult.exitCode !== 0) {
          if (isExecResultGone(pushResult)) return { status: 'expired' };
          const detail =
            pushResult.stderr || pushResult.stdout || pushResult.error || 'Unknown error';
          return { status: 'failed', error: `Push failed: ${detail}` };
        }

        return { status: 'success' };
      };

      const runWithExpiryCatch = async (
        targetSandbox: string,
        applyPatchFirst: boolean,
      ): Promise<AttemptResult> => {
        try {
          return await attemptCommitAndPush(targetSandbox, applyPatchFirst);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (isDefinitivelyGoneMessage(msg)) return { status: 'expired' };
          return { status: 'failed', error: msg };
        }
      };

      let result = await runWithExpiryCatch(sandboxIdRef.current, false);

      if (result.status === 'expired' && onSandboxExpired) {
        setState((s) => ({ ...s, phase: 'recovering' }));
        const newId = await onSandboxExpired();
        if (!newId) {
          setState((s) => ({
            ...s,
            phase: 'error',
            error: 'Sandbox expired during commit/push and could not be recovered.',
          }));
          return;
        }
        sandboxIdRef.current = newId;
        result = await runWithExpiryCatch(newId, true);
      }

      if (result.status === 'expired') {
        setState((s) => ({
          ...s,
          phase: 'error',
          error: 'Sandbox expired during commit/push.',
        }));
        return;
      }
      if (result.status === 'failed') {
        setState((s) => ({ ...s, phase: 'error', error: result.error }));
        return;
      }

      setState((s) => ({ ...s, phase: 'success' }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setState((s) => ({ ...s, phase: 'error', error: msg }));
    }
  }, [state.commitMessage, state.diff, providerOverride, modelOverride, onSandboxExpired]);

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
