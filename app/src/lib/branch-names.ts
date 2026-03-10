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
