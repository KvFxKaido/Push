/**
 * Orchestrator Turn Policy — prevents false completion claims.
 *
 * The Orchestrator cannot declare implementation success without
 * artifact evidence (delegation result, diff, commit, or PR).
 *
 * This is the "no fake completion" guard at the conversation level,
 * complementing the Coder's per-delegation guard.
 */

import type { ChatMessage } from '@/types';
import type { TurnPolicy, TurnContext } from '../turn-policy';

/**
 * Detect whether an Orchestrator response claims task completion.
 *
 * Detection is intentionally broad: bare past-tense self-claims like
 * "Implemented the fix" or "I completed the task" must qualify so the
 * verification gate can evaluate them. False positives from narrative
 * summaries (e.g. "Implemented X via PR #470") are filtered downstream
 * by `hasArtifactInResponse` and `hasGroundingEvidence`, which the
 * gates apply before deciding to nudge.
 */
export function responseClaimsCompletion(response: string): boolean {
  const trimmed = response.trim();

  // Question / conditional framing is never a completion claim
  const isConditional = /\b(if|would you|shall I|should I|do you want|let me know)\b/i.test(
    trimmed,
  );
  if (isConditional) return false;

  // Standalone short completion ("Done.", "All done.", "Complete.")
  if (/^\s*(all\s+)?(done|complete|completed|finished)[.!\s]*$/i.test(trimmed)) return true;

  // Sentence-initial bare past tense — "Implemented the fix.", "Fixed Y.",
  // "Completed Z.", "Done! ...", "Shipped W.", "Finished N."
  if (/^\s*(implemented|completed|finished|fixed|shipped|done)\b/i.test(trimmed)) return true;

  // First-person self-claim — auxiliary is optional so bare past tense
  // ("I implemented X", "We fixed Y") still matches alongside the
  // longer "I have completed X" / "We've shipped Y" forms.
  if (
    /\b(I|we)\s+(?:(?:have|'ve|am|'m|are|'re|just)\s+)?(?:now\s+)?(done|completed|finished|implemented|shipped|fixed|made\s+the\s+changes?)\b/i.test(
      trimmed,
    )
  ) {
    return true;
  }

  // Subject-claim: "(the) task|work|change|fix|feature|everything|... (is|are|has been|have been) done|completed|implemented|..."
  if (
    /\b(the\s+)?(task|work|change|changes|fix|feature|implementation|migration|refactor|patch|everything)\s+(is|are|has been|have been)\s+(now\s+)?(done|complete|completed|finished|implemented|shipped|ready|in\s+place)\b/i.test(
      trimmed,
    )
  ) {
    return true;
  }

  // "All (changes|tasks|work|edits) (are|have been) (made|done|completed|...)"
  if (
    /\ball\s+(changes?|tasks?|work|edits?)\s+(are|is|have been|has been)\s+(made|done|complete|completed|finished|implemented)\b/i.test(
      trimmed,
    )
  ) {
    return true;
  }

  return false;
}

/**
 * True when the response itself cites an artifact (PR/commit/diff
 * reference, or a file path paired with a mutation verb). Used by
 * the gates to skip nudging when the model is plausibly summarizing
 * concrete work output.
 */
export function hasArtifactInResponse(response: string): boolean {
  const trimmed = response.trim();
  return (
    /\b(PR|pull request|commit|merge|branch|diff|sandbox_diff|sandbox_prepare_commit|sandbox_push)\b/i.test(
      trimmed,
    ) ||
    /\b(file|\.ts|\.js|\.py)\b.*\b(modified|created|updated|changed)\b/i.test(trimmed) ||
    /\b(modified|created|updated|changed)\b.*\b(file|\.ts|\.js|\.py)\b/i.test(trimmed)
  );
}

/**
 * True when the recent conversation contains tool-result grounding
 * (delegation results, sandbox diffs, coder/explorer completions).
 *
 * Both the orchestrator policy and the verification gate use this to
 * skip completion enforcement on read-only Q&A turns where the model
 * is summarizing tool output rather than claiming fresh work.
 */
export function hasGroundingEvidence(messages: readonly ChatMessage[]): boolean {
  const recent = messages.slice(-6);
  return recent.some(
    (m) =>
      m.role === 'user' &&
      (m.content.includes('[Tool Result — delegate_coder]') ||
        m.content.includes('[Tool Result — delegate_explorer]') ||
        m.content.includes('[TOOL_RESULT') ||
        m.content.includes('[Coder completed') ||
        m.content.includes('[CODER_RESULT]') ||
        m.content.includes('[Explorer completed') ||
        m.content.includes('[EXPLORER_RESULT]') ||
        m.content.includes('sandbox_diff') ||
        m.content.includes('Acceptance Criteria]')),
  );
}

function detectUngroundedCompletion(response: string, messages: readonly ChatMessage[]): boolean {
  const trimmed = response.trim();

  if (!responseClaimsCompletion(trimmed)) return false;
  if (hasArtifactInResponse(trimmed)) return false;
  if (hasGroundingEvidence(messages)) return false;

  // Completion claim with no grounding → ungrounded
  return true;
}

export function createOrchestratorPolicy(): TurnPolicy {
  return {
    name: 'orchestrator-core',
    role: 'orchestrator',

    afterModelCall: [
      (response: string, messages: readonly ChatMessage[], ctx: TurnContext) => {
        if (!detectUngroundedCompletion(response, messages)) return null;

        return {
          action: 'inject' as const,
          message: {
            id: `policy-ungrounded-completion-${ctx.round}`,
            role: 'user' as const,
            content: [
              '[POLICY: UNGROUNDED_COMPLETION]',
              'Your response claims task completion but there is no evidence of:',
              '- A delegation result from Coder or Explorer',
              '- A diff, commit, or PR reference',
              '- Changed files with specific paths',
              '',
              'Either delegate the work, verify the changes exist, or clarify what was actually done.',
              '[/POLICY]',
            ].join('\n'),
            timestamp: Date.now(),
          },
        };
      },
    ],
  };
}
