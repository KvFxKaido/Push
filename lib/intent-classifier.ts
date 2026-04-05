/**
 * Heuristic classifier to detect the intent of a request or response.
 * Primarily used to bias the agent toward the Explorer for discovery tasks.
 */

export type IntentClassification = 'discovery' | 'implementation' | 'other';

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

export function classifyIntent(text: string): IntentClassification {
  if (!text || text.trim().length < 10) return 'other';

  const normalized = text.trim();

  if (DISCOVERY_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return 'discovery';
  }

  if (IMPLEMENTATION_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return 'implementation';
  }

  return 'other';
}
