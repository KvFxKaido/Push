/**
 * Detect a response that ends by announcing an imminent tool action without
 * emitting the action. Shared by conversational-lead and Coder policy paths.
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

  const trailingIntent =
    /^(?:(?:so|now|next|then|first|finally|ok(?:ay)?|alright)\b(?:[,:]|\s+[—–-])?\s+)?(?:let'?s|let\s+me|i'?ll|i\s+will|i\s+am\s+going\s+to|i'?m\s+going\s+to|i\s+need\s+to|i\s+should|i\s+want\s+to|we'?ll|we\s+will|we\s+should|we\s+need\s+to)\b(?:\s+(?:now|then|also|quickly|first|next|actually|really|just|go\s+ahead\s+and))*\s+(?:(?:re-?read|read|open|view|inspect|examine|verify|confirm|search|grep|scan|list|fetch|pull|retrieve|explore|investigate|trace|review|execute|diff|cat)\b|dig\s+(?:in|into)\b|check(?!\s+(?:in|back|on)\b)\b|find(?!\s+out\b)\b|run(?!\s+through\b)\b|look\s+(?:at|for|into)\b)/i;

  const sentences = cleaned
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);

  return (sentences.length > 0 ? sentences : [cleaned]).some((sentence) =>
    trailingIntent.test(sentence),
  );
}

/** True when a response explicitly claims that work is complete. */
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
