/**
 * turn-intent.ts — request-side intent classification for turn routing.
 *
 * The web inline lane (`chat-send-inline.ts`) runs the shared **Coder** kernel
 * for a turn, including the coder turn-policy whose no-fake-completion guard
 * assumes every turn is a coding task that must end with changed files / a
 * blocked report / acceptance-criteria results (`turn-policies/coder-policy.ts`).
 * That assumption is false for the lead's *conversational* turns ("what
 * changed?", "eli5 the diff", "just making sure you weren't looping"): a short
 * reply with no file evidence trips the guard, which injects an
 * `[POLICY: INCOMPLETE_COMPLETION]` nudge the model then "answers" in the
 * user-visible channel — the third-person self-narration artifact.
 *
 * Until the inline lane and the Orchestrator loop fully converge onto one
 * conversational lead (CLAUDE.md §"single conversational lead"), the pragmatic
 * split is: route clearly-conversational turns to the Orchestrator loop (which
 * already carves out read-only summarization in `chat-no-tool-path.ts`) and
 * keep coding turns on the inline Coder lane.
 *
 * Safety of a misclassification: a turn classified `conversational` falls
 * through to `runRoundLoop` — the full Orchestrator, which can still call tools
 * and delegate to the Coder. So a coding request mistakenly tagged
 * conversational still *works*, just via the orchestrator rather than the
 * collapsed inline coder. That asymmetry is why the classifier defaults
 * ambiguous input to `task` (preserve today's inline behavior) and only
 * downgrades input that is *clearly* conversational.
 */

export type TurnIntent = 'conversational' | 'task';

/**
 * Asking for an opinion about a change ("should I refactor this?") reads as a
 * coding imperative by keyword but is conversational by intent. Checked before
 * the imperative scan so the advice framing wins.
 */
const ADVICE_OPENER =
  /^(should (i|we)|do you think|would it be|is it worth|what do you think|any (thoughts|ideas)|thoughts on|how would you|what's the best|whats the best)\b/;

/**
 * Polite / sequencing lead-ins a command may open with before the verb
 * ("can you fix …", "please add …", "let's refactor …").
 */
const LEAD_IN =
  "(?:please|pls|plz|kindly|now|go|then|also|and|ok|okay|let'?s|lets|can you|could you|would you|will you|i (?:need|want|'?d like)(?: you)? to)";

/**
 * Imperative coding language, anchored to the **start** of the message (after
 * any lead-ins). Commands lead with the verb, so anchoring avoids the false
 * positives a bare word scan produces — most notably "Push" (the product name)
 * matching the git `push` verb, and "what changed …" matching `change`. A
 * declarative coding request that buries the verb mid-sentence still falls to
 * the `task` default below; only questions / meta phrasing pull it
 * conversational.
 */
const CODING_IMPERATIVE = new RegExp(
  `^(?:${LEAD_IN}\\s+)*(implement|fix|refactor|rename|reorganize|delete|remove|create|write|build|compile|update|change|edit|modify|migrate|bump|upgrade|downgrade|install|uninstall|wire|hook up|set ?up|configure|revert|undo|debug|patch|optimi[sz]e|lint|commit|push|merge|rebase|deploy|scaffold|extract|replace|split|generate|add|move|drop)\\b`,
);

/** Code-ish nouns that imply work even without an imperative verb. */
const CODING_OBJECT = /\b(the bug|failing tests?|this error|type error|stack ?trace|regression)\b/;

/** Explanatory requests anywhere in the message ("could you eli5 …", "walk me
 *  through the diff") — conversational even when not the opening word. */
const EXPLANATORY = /\b(eli5|explain|clarify|walk me through|tldr|tl;dr)\b/;

/**
 * Conversational signals: interrogatives, explanatory asks, meta / control
 * phrases, acknowledgements, and greetings. Only consulted after the imperative
 * scan, so "fix the bug" never reaches here.
 */
const CONVERSATIONAL_SIGNAL =
  /^(what|why|how|when|who|where|which|explain|eli5|tell me|summari[sz]e|describe|walk me through|can you explain|could you explain|is (it|that|this|there)|are (you|there|we)|did you|do you|does (it|this|that)|just (making sure|checking)|are you (looping|stuck)|you (looping|stuck)|what('?s| is| are) (you|going)|stop|wait|hold on|nvm|never ?mind|thanks|thank you|ty\b|cool|ok|okay|got it|nice|great|hi|hey|hello|yo|gm|good (morning|evening))\b/;

/**
 * Classify a user message as a coding `task` (→ inline Coder lane) or a
 * `conversational` lead turn (→ Orchestrator loop). Heuristic and synchronous —
 * this runs in the send hot path, so no model call. Empty/whitespace input is
 * `task` (no text to judge; attachment-only turns stay on the inline lane).
 */
export function classifyTurnIntent(text: string): TurnIntent {
  const t = text.trim().toLowerCase();
  if (!t) return 'task';
  // Advice framing wins over an imperative keyword ("should I refactor this?").
  if (ADVICE_OPENER.test(t)) return 'conversational';
  // A leading coding command is unambiguously a task.
  if (CODING_IMPERATIVE.test(t)) return 'task';
  // Explanatory / interrogative / meta phrasing → conversational. Checked
  // before the looser noun-based task signal so "what's the bug you fixed?"
  // stays conversational while "there's a regression in X" routes to a task.
  if (EXPLANATORY.test(t) || CONVERSATIONAL_SIGNAL.test(t)) return 'conversational';
  if (CODING_OBJECT.test(t)) return 'task';
  if (t.endsWith('?')) return 'conversational';
  return 'task';
}
