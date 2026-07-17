/**
 * Surface-neutral request intent used by the conversational lead policy.
 *
 * The Coder's task-only guards assume a turn must end with implementation or
 * concrete evidence. That is wrong for conversational turns such as "explain
 * the diff" or "were you looping?". The classifier keeps those guards quiet
 * without weakening delegated/task runs.
 *
 * Misclassification is intentionally asymmetric: a coding request classified
 * as conversational still reaches the full lead and can use tools, while a
 * conversational request classified as a task can receive an implementer-only
 * correction. Ambiguous input therefore remains task-shaped and only clearly
 * conversational input opts out.
 */

export type TurnIntent = 'conversational' | 'task';

/** Opinion/advice framing wins over coding keywords such as "refactor". */
const ADVICE_OPENER =
  /^(should (i|we)|do you think|would it be|is it worth|what do you think|any (thoughts|ideas)|thoughts on|how would you|what's the best|whats the best)\b/;

/** Polite and sequencing lead-ins that may precede a coding imperative. */
const LEAD_IN =
  "(?:please|pls|plz|kindly|now|go|then|also|and|ok|okay|let'?s|lets|can you|could you|would you|will you|i (?:need|want|'?d like)(?: you)? to)";

/**
 * Coding imperatives anchor at the start after lead-ins. This avoids treating
 * the product name "Push" or a phrase like "what changed" as command verbs.
 */
const CODING_IMPERATIVE = new RegExp(
  `^(?:${LEAD_IN}\\s+)*(implement|fix|refactor|rename|reorganize|delete|remove|create|write|build|compile|update|change|edit|modify|migrate|bump|upgrade|downgrade|install|uninstall|wire|hook up|set ?up|configure|revert|undo|debug|patch|optimi[sz]e|lint|commit|push|merge|rebase|deploy|scaffold|extract|replace|split|generate|add|move|drop)\\b`,
);

/** Code-shaped nouns that imply work even without an imperative verb. */
const CODING_OBJECT = /\b(the bug|failing tests?|this error|type error|stack ?trace|regression)\b/;
/** Read-only explanatory asks are conversational even after a polite opener. */
const EXPLANATORY =
  /\b(eli5|explain|clarify|summari[sz]e|recap|describe|walk me through|go over|tldr|tl;dr)\b/;
/** Read-only review avoids task guards unless chained to a mutating follow-up. */
const READ_ONLY_REVIEW =
  /^(?:can you|could you|would you|please|pls|plz)?\s*(?:take a look at|look over|review|inspect|check out)\b.*\b(diff|pr|pull request|change|changes)\b/;
const MUTATING_FOLLOWUP =
  /\b(?:and|then)\s+(?:fix|address|update|change|edit|modify|implement|add|remove|delete|commit|push)\b/;
/** Direct response/read requests have no coding completion to ground. */
const RESPONSE_ONLY_IMPERATIVE = new RegExp(
  `^(?:${LEAD_IN}\\s+)*(?:say|answer|respond|report|read|return)\\b`,
);
/** Interrogatives, control phrases, acknowledgements, and greetings. */
const CONVERSATIONAL_SIGNAL =
  /^(what|why|how|when|who|where|which|explain|eli5|tell me|summari[sz]e|describe|walk me through|can you explain|could you explain|is (it|that|this|there)|are (you|there|we)|did you|do you|does (it|this|that)|just (making sure|checking)|are you (looping|stuck)|you (looping|stuck)|what('?s| is| are) (you|going)|stop|wait|hold on|nvm|never ?mind|thanks|thank you|ty\b|cool|ok|okay|got it|nice|great|hi|hey|hello|yo|gm|good (morning|evening))\b/;

/**
 * Classify synchronously in the send hot path. Empty/attachment-only input is
 * task-shaped; only clearly conversational text disables task-only guards.
 */
export function classifyTurnIntent(text: string): TurnIntent {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return 'task';
  if (ADVICE_OPENER.test(normalized)) return 'conversational';
  if (CODING_IMPERATIVE.test(normalized)) return 'task';
  if (EXPLANATORY.test(normalized) || CONVERSATIONAL_SIGNAL.test(normalized)) {
    return 'conversational';
  }
  if (READ_ONLY_REVIEW.test(normalized) && !MUTATING_FOLLOWUP.test(normalized)) {
    return 'conversational';
  }
  if (RESPONSE_ONLY_IMPERATIVE.test(normalized) && !MUTATING_FOLLOWUP.test(normalized)) {
    return 'conversational';
  }
  if (CODING_OBJECT.test(normalized)) return 'task';
  if (normalized.endsWith('?')) return 'conversational';
  return 'task';
}
