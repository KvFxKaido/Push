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
 * Detect whether an Orchestrator response claims task completion
 * without grounding in a delegation result or artifact.
 *
 * Heuristic: if the response says "done/completed/implemented" but
 * the recent conversation has no delegation result, diff card, or
 * commit/PR reference, it's likely a false claim.
 */
function detectUngroundedCompletion(
  response: string,
  messages: readonly ChatMessage[],
): boolean {
  const trimmed = response.trim();

  // Must contain completion language
  const hasCompletionClaim =
    /\b(done|completed|finished|implemented|all\s+changes?\s+(are|have been)\s+made)\b/i.test(trimmed);
  if (!hasCompletionClaim) return false;

  // Check if this is a question or conditional
  const isConditional =
    /\b(if|would you|shall I|should I|do you want|let me know)\b/i.test(trimmed);
  if (isConditional) return false;

  // Look for grounding evidence in the response itself
  const hasArtifactInResponse =
    /\b(PR|pull request|commit|merge|branch|diff|sandbox_diff|sandbox_prepare_commit|sandbox_push)\b/i.test(trimmed)
    || /\b(file|\.ts|\.js|\.py)\b.*\b(modified|created|updated|changed)\b/i.test(trimmed)
    || /\b(modified|created|updated|changed)\b.*\b(file|\.ts|\.js|\.py)\b/i.test(trimmed);
  if (hasArtifactInResponse) return false;

  // Look for delegation results in recent messages (last 6)
  const recent = messages.slice(-6);
  const hasDelegationResult = recent.some((m) =>
    m.role === 'user'
    && (m.content.includes('[Tool Result — delegate_coder]')
      || m.content.includes('[Tool Result — delegate_explorer]')
      || m.content.includes('[TOOL_RESULT')
      || m.content.includes('[Coder completed')
      || m.content.includes('[CODER_RESULT]')
      || m.content.includes('[Explorer completed')
      || m.content.includes('[EXPLORER_RESULT]')
      || m.content.includes('sandbox_diff')
      || m.content.includes('Acceptance Criteria]')),
  );
  if (hasDelegationResult) return false;

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
