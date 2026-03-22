/**
 * Heuristic classifier to detect the intent of a request or response.
 * Primarily used to bias the agent toward the Explorer for discovery tasks.
 */

export type IntentClassification = 'discovery' | 'implementation' | 'other';

/**
 * Patterns that strongly indicate a discovery or investigation task.
 */
const DISCOVERY_PATTERNS = [
  /how does.* work/i,
  /trace (?:the )?(?:flow|logic|path)/i,
  /where (?:is|are)/i,
  /what (?:depends on|calls|uses)/i,
  /why does.* (?:happen|fail)/i,
  /investigate (?:the )?\w+/i,
  /find (?:all )?(?:references|usages|instances) of/i,
  /understand (?:the )?\w+/i,
  /explore (?:the )?\w+/i,
];

/**
 * Patterns that strongly indicate an implementation or coding task.
 */
const IMPLEMENTATION_PATTERNS = [
  /add .* to/i,
  /fix/i,
  /refactor/i,
  /implement/i,
  /create/i,
  /update/i,
  /remove/i,
  /change/i,
  /ship/i,
  /improve/i,
];

/**
 * Classifies the intent of the given text based on heuristic patterns.
 */
export function classifyIntent(text: string): IntentClassification {
  if (!text || text.trim().length < 10) return 'other';

  const normalized = text.trim();

  // Check for discovery intent
  if (DISCOVERY_PATTERNS.some((p) => p.test(normalized))) {
    return 'discovery';
  }

  // Check for implementation intent
  if (IMPLEMENTATION_PATTERNS.some((p) => p.test(normalized))) {
    return 'implementation';
  }

  return 'other';
}
