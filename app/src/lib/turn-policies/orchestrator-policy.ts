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
 * Detect whether an Orchestrator response *ends* by announcing an imminent
 * tool action ("Let's read README.md", "I'll search the docs") without having
 * emitted the tool call. This is the "announce then dead-end" failure mode:
 * the model narrates its next step but stops, so the recovery layer finds no
 * malformed call to retry and the loop would break with the work undone.
 *
 * Deliberately conservative to keep the parser strict and avoid false
 * positives:
 *   - Only the FINAL non-empty line is inspected. The dead-end signature is
 *     an announced action as the last thing said, not an incidental mention
 *     mid-message — so prose that merely *describes* tools (e.g. explaining
 *     `create_branch` / `switch_branch`) earlier in the turn can't trip it.
 *   - The intent phrase must anchor at the start of that line, immediately
 *     followed by an investigative/tool action verb.
 *   - Questions and offers ("should I read X?", "let me know if…") return
 *     false: the model is handing control back, not forgetting to act.
 *   - Ambiguous verbs are constrained to their tool sense so conversational
 *     sign-offs don't trip the guard: "check in/back", "look forward",
 *     "run through", and "find out" are excluded, while "check the logs",
 *     "look at X", "run the tests" still match.
 *
 * Note: the announced action is intentionally NOT required to be the last
 * substantive content of the line. The real failure this guards against ends
 * with a long trailing clause ("…to see if any design docs should be
 * added/updated, or if there is a PUSH.md file"), so a "short suffix" rule
 * would miss it. A compound plan with no emitted call ("I'll read X, then
 * delegate to Coder") is itself a dead-end and is correctly nudged.
 */
export function detectTrailingActionIntent(response: string): boolean {
  const trimmed = response.trim();
  if (trimmed.length === 0) return false;

  const lines = trimmed.split('\n');
  let lastLine = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    const candidate = lines[i].trim();
    if (candidate.length > 0) {
      lastLine = candidate;
      break;
    }
  }
  if (!lastLine) return false;

  // Strip leading markdown decoration (list markers, task-list checkboxes,
  // blockquote, heading, bold/italic) so the intent phrase can anchor at the
  // start — models often plan steps as `- [ ] Let's read …`.
  const cleaned = lastLine
    .replace(/^(?:[-*>#]+\s*|\d+[.)]\s*|\[[ xX]?\]\s*|\*\*|__|_|\*)+/, '')
    .trim();

  // A question or an offer hands control back to the user — not a dead-end.
  if (/\?\s*$/.test(cleaned)) return false;
  if (
    /\b(let me know|would you like|do you want|if you(?:'d| would| want| wish| prefer)|shall i|should i|want me to)\b/i.test(
      cleaned,
    )
  ) {
    return false;
  }

  // Verbs are split into two groups. Unambiguous tool verbs match bare;
  // ambiguous ones carry a negative lookahead so conversational idioms
  // ("check in", "look forward", "run through", "find out") don't match while
  // their tool sense ("check the logs", "look at X", "run the tests") does.
  const trailingIntent =
    /^(?:so,?\s+|now,?\s+|next,?\s+|then,?\s+|first,?\s+|finally,?\s+|ok(?:ay)?,?\s+|alright[,:]?\s*(?:[—–-]\s*)?)?(?:let'?s|let\s+me|i'?ll|i\s+will|i\s+am\s+going\s+to|i'?m\s+going\s+to|i\s+need\s+to|i\s+should|i\s+want\s+to|we'?ll|we\s+will|we\s+should|we\s+need\s+to)\b(?:\s+(?:now|then|also|quickly|first|next|actually|really|just|go\s+ahead\s+and))*\s+(?:(?:re-?read|read|open|view|inspect|examine|verify|confirm|search|grep|scan|list|fetch|pull|retrieve|explore|investigate|trace|review|execute|diff|cat|dig(?:\s+into)?)\b|check(?!\s+(?:in|back|on)\b)\b|find(?!\s+out\b)\b|run(?!\s+through\b)\b|look\s+(?:at|for|into)\b)/i;

  return trailingIntent.test(cleaned);
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
