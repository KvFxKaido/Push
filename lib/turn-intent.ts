/** Surface-neutral request intent used by the conversational lead policy. */

export type TurnIntent = 'conversational' | 'task';

const ADVICE_OPENER =
  /^(should (i|we)|do you think|would it be|is it worth|what do you think|any (thoughts|ideas)|thoughts on|how would you|what's the best|whats the best)\b/;

const LEAD_IN =
  "(?:please|pls|plz|kindly|now|go|then|also|and|ok|okay|let'?s|lets|can you|could you|would you|will you|i (?:need|want|'?d like)(?: you)? to)";

const CODING_IMPERATIVE = new RegExp(
  `^(?:${LEAD_IN}\\s+)*(implement|fix|refactor|rename|reorganize|delete|remove|create|write|build|compile|update|change|edit|modify|migrate|bump|upgrade|downgrade|install|uninstall|wire|hook up|set ?up|configure|revert|undo|debug|patch|optimi[sz]e|lint|commit|push|merge|rebase|deploy|scaffold|extract|replace|split|generate|add|move|drop)\\b`,
);

const CODING_OBJECT = /\b(the bug|failing tests?|this error|type error|stack ?trace|regression)\b/;
const EXPLANATORY =
  /\b(eli5|explain|clarify|summari[sz]e|recap|describe|walk me through|go over|tldr|tl;dr)\b/;
const READ_ONLY_REVIEW =
  /^(?:can you|could you|would you|please|pls|plz)?\s*(?:take a look at|look over|review|inspect|check out)\b.*\b(diff|pr|pull request|change|changes)\b/;
const MUTATING_FOLLOWUP =
  /\b(?:and|then)\s+(?:fix|address|update|change|edit|modify|implement|add|remove|delete|commit|push)\b/;
const CONVERSATIONAL_SIGNAL =
  /^(what|why|how|when|who|where|which|explain|eli5|tell me|summari[sz]e|describe|walk me through|can you explain|could you explain|is (it|that|this|there)|are (you|there|we)|did you|do you|does (it|this|that)|just (making sure|checking)|are you (looping|stuck)|you (looping|stuck)|what('?s| is| are) (you|going)|stop|wait|hold on|nvm|never ?mind|thanks|thank you|ty\b|cool|ok|okay|got it|nice|great|hi|hey|hello|yo|gm|good (morning|evening))\b/;

/**
 * Classify a lead turn. Ambiguous input remains task-shaped; only clearly
 * conversational input disables task-only policy guards.
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
  if (CODING_OBJECT.test(normalized)) return 'task';
  if (normalized.endsWith('?')) return 'conversational';
  return 'task';
}
