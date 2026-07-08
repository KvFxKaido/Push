function unwrapFirstLine(raw: string): string {
  let text = raw.trim();
  const fenceMatch = text.match(/```(?:text)?\s*\n?([\s\S]*?)\n?\s*```/i);
  if (fenceMatch) text = fenceMatch[1].trim();

  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) || ''
  );
}

/** Sanitize branch name: lowercase, spaces to hyphens, strip invalid chars. */
export function sanitizeBranchName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9\-/]/g, '')
    .replace(/\/{2,}/g, '/')
    .replace(/^[-/]+/, '')
    .replace(/[-/]+$/, '');
}

export function getBranchSuggestionPrefix(repoName?: string): string {
  const sanitized = sanitizeBranchName(repoName || 'work').replace(/\//g, '-');
  return sanitized || 'work';
}

export function deriveBranchNameFromCommitMessage(commitMessage: string, prefix: string): string {
  const normalizedPrefix = sanitizeBranchName(prefix).replace(/\//g, '-') || 'work';
  const cleaned = commitMessage
    .trim()
    .replace(/^([a-z]+)(?:\([^)]+\))?:\s*/i, '')
    .replace(/\.$/, '');

  const slug = sanitizeBranchName(cleaned).replace(/\//g, '-');
  return `${normalizedPrefix}/${slug || 'update-workspace'}`;
}

/**
 * Derive a work-branch name from the user's first prompt. Takes the first
 * non-empty line, keeps the leading words within a length budget, slugifies,
 * and namespaces under the repo-derived prefix. Bounded (unlike
 * `deriveBranchNameFromCommitMessage`) because prompt text is free-form and can
 * be arbitrarily long. Used by branch-on-first-prompt to name the branch the
 * moment a session starts, before any diff exists.
 */
export function deriveBranchNameFromPrompt(promptText: string, prefix: string): string {
  const normalizedPrefix = sanitizeBranchName(prefix).replace(/\//g, '-') || 'work';
  const slug = sanitizeBranchName(unwrapFirstLine(promptText))
    .replace(/\//g, '-')
    .split('-')
    .filter(Boolean)
    .slice(0, 8)
    .join('-')
    .slice(0, 48)
    .replace(/-+$/, '');
  return `${normalizedPrefix}/${slug || 'session'}`;
}

/**
 * Normalize a worker/model-suggested first-prompt branch name. Unlike the raw
 * prompt fallback above, this treats the suggestion as an intent summary:
 * strip labels/prefixes, force Push's repo-derived namespace, and apply the
 * same short-topic budget so a verbose response cannot become a bloated ref.
 */
export function deriveBranchNameFromPromptSuggestion(raw: string, prefix: string): string {
  const normalizedPrefix = sanitizeBranchName(prefix).replace(/\//g, '-') || 'work';
  let topic = unwrapFirstLine(raw)
    .replace(/^(branch name|branch)\s*:\s*/i, '')
    .replace(/^refs\/heads\//i, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();

  const ownPrefix = `${normalizedPrefix}/`;
  if (topic.toLowerCase().startsWith(ownPrefix)) {
    topic = topic.slice(ownPrefix.length);
  } else if (topic.includes('/')) {
    topic = topic.split('/').filter(Boolean).at(-1) ?? topic;
  }

  const slug = sanitizeBranchName(topic)
    .replace(/\//g, '-')
    .split('-')
    .filter(Boolean)
    .slice(0, 8)
    .join('-')
    .slice(0, 48)
    .replace(/-+$/, '');

  return `${normalizedPrefix}/${slug || 'session'}`;
}

export function normalizeSuggestedBranchName(raw: string, prefix: string): string {
  const normalizedPrefix = sanitizeBranchName(prefix).replace(/\//g, '-') || 'work';
  const firstLine = unwrapFirstLine(raw)
    .replace(/^(branch name|branch)\s*:\s*/i, '')
    .replace(/^refs\/heads\//i, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();

  const sanitized = sanitizeBranchName(firstLine);
  if (!sanitized) return `${normalizedPrefix}/update-workspace`;
  if (sanitized.includes('/')) return sanitized;
  return `${normalizedPrefix}/${sanitized}`;
}
