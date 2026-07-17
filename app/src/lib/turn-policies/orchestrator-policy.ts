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
import { ANNOUNCED_NO_ACTION_POLICY_MARKER } from '../tool-call-recovery';
import { detectTrailingActionIntent, responseClaimsCompletion } from '@push/lib/action-intent';

// Re-exported so existing consumers (`chat-no-tool-path.ts`, `coder-policy.ts`)
// keep importing it from this module — the value's canonical home is
// `lib/tool-call-recovery.ts` so root-`lib/` consumers can read it too.
export { ANNOUNCED_NO_ACTION_POLICY_MARKER };
export { detectTrailingActionIntent };
export { responseClaimsCompletion };

// Completion-claim and announced-action detection are pure shared semantics;
// this module retains only the Orchestrator-specific grounding checks below.
/**
 * True when the response itself cites an artifact (PR/commit/diff
 * reference, or a file path paired with a mutation verb). Used by
 * the gates to skip nudging when the model is plausibly summarizing
 * concrete work output.
 */
export function hasArtifactInResponse(response: string): boolean {
  const trimmed = response.trim();
  return (
    /\b(PR|pull request|commit|merge|branch|diff|sandbox_diff|sandbox_commit|prepare_push|sandbox_push)\b/i.test(
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
