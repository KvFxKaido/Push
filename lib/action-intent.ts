/**
 * Detect a response that ends by announcing an imminent tool action without
 * emitting the action. Shared by conversational-lead and Coder policy paths.
 *
 * Deliberately conservative:
 * - only the final non-empty line is inspected, so an earlier discussion of a
 *   tool is not mistaken for a dead-end;
 * - every sentence on that line is checked, catching both a prose lead-in and
 *   a closing remark around the announced action;
 * - the intent phrase must start a sentence and immediately lead into an
 *   investigative/tool verb;
 * - questions and offers hand control back to the user and never match;
 * - ambiguous verbs exclude conversational idioms such as "check in",
 *   "find out", "run through", and "look forward".
 *
 * The action does not have to be the final clause. Real dead-ends often carry
 * a long explanation after "I'll read X", and a compound plan with no emitted
 * call is still a dead-end.
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

  // Models commonly wrap plan steps in list, task-list, quote, or emphasis
  // markers. Strip those before applying the sentence-start anchor.
  const cleaned = lastLine
    .replace(/^(?:[-*>#]+\s*|\d+[.)]\s*|\[[ xX]?\]\s*|\*\*|__|_|\*)+/, '')
    .trim();

  if (/\?\s*$/.test(cleaned)) return false;
  if (
    /\b(let me know|would you like|do you want|if you(?:'d| would| want| wish| prefer)|shall i|should i|want me to)\b/i.test(
      cleaned,
    )
  ) {
    return false;
  }

  // Unambiguous tool verbs match bare. Ambiguous verbs use lookaheads so their
  // conversational senses stay excluded while their tool senses still match.
  const trailingIntent =
    /^(?:(?:so|now|next|then|first|finally|ok(?:ay)?|alright)\b(?:[,:]|\s+[—–-])?\s+)?(?:let'?s|let\s+me|i'?ll|i\s+will|i\s+am\s+going\s+to|i'?m\s+going\s+to|i\s+need\s+to|i\s+should|i\s+want\s+to|we'?ll|we\s+will|we\s+should|we\s+need\s+to)\b(?:\s+(?:now|then|also|quickly|first|next|actually|really|just|go\s+ahead\s+and))*\s+(?:(?:re-?read|read|open|view|inspect|examine|verify|confirm|search|grep|scan|list|fetch|pull|retrieve|explore|investigate|trace|review|execute|diff|cat)\b|dig\s+(?:in|into)\b|check(?!\s+(?:in|back|on)\b)\b|find(?!\s+out\b)\b|run(?!\s+through\b)\b|look\s+(?:at|for|into)\b)/i;

  // Sentence splitting is intentionally simple and case-agnostic. Testing the
  // fragments independently makes harmless over-splitting preferable to
  // missing "Found the bug. let me verify the fix."
  const sentences = cleaned
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);

  return (sentences.length > 0 ? sentences : [cleaned]).some((sentence) =>
    trailingIntent.test(sentence),
  );
}

/**
 * True when a response explicitly claims that work is complete.
 *
 * Detection is broad because downstream consumers own grounding: bare
 * past-tense claims ("Implemented the fix") must qualify, while artifact and
 * transcript evidence filters decide whether the claim is actually safe.
 */
export function responseClaimsCompletion(response: string): boolean {
  const trimmed = response.trim();
  if (/\b(if|would you|shall I|should I|do you want|let me know)\b/i.test(trimmed)) return false;
  if (/^\s*(all\s+)?(done|complete|completed|finished)[.!\s]*$/i.test(trimmed)) return true;
  if (/^\s*(implemented|completed|finished|fixed|shipped|done)\b/i.test(trimmed)) return true;
  if (
    /\b(I|we)\s+(?:(?:have|'ve|am|'m|are|'re|just)\s+)?(?:now\s+)?(done|completed|finished|implemented|shipped|fixed|made\s+the\s+changes?)\b/i.test(
      trimmed,
    )
  ) {
    return true;
  }
  if (
    /\b(the\s+)?(task|work|change|changes|fix|feature|implementation|migration|refactor|patch|everything)\s+(is|are|has been|have been)\s+(now\s+)?(done|complete|completed|finished|implemented|shipped|ready|in\s+place)\b/i.test(
      trimmed,
    )
  ) {
    return true;
  }
  return /\ball\s+(changes?|tasks?|work|edits?)\s+(are|is|have been|has been)\s+(made|done|complete|completed|finished|implemented)\b/i.test(
    trimmed,
  );
}
