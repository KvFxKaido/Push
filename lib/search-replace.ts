export interface SearchReplaceArgs {
  search: string;
  replace: string;
  replace_all?: boolean;
}

export interface SearchReplaceMatch {
  start: number;
  end: number;
  resultStart: number;
}

export type SearchReplaceResult =
  | { content: string; count: number; matches: SearchReplaceMatch[] }
  | {
      error: string;
      occurrences?: number;
      /** Raw byte ranges, included when ambiguity diagnostics need locations. */
      locations?: Array<{ start: number; end: number }>;
    };

type LineEndingStyle = 'none' | 'lf' | 'crlf' | 'mixed';

function lineEndingStyle(value: string): LineEndingStyle {
  let hasLf = false;
  let hasCrlf = false;
  let hasBareCr = false;

  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === '\r') {
      if (value[i + 1] === '\n') {
        hasCrlf = true;
        i += 1;
      } else {
        hasBareCr = true;
      }
    } else if (value[i] === '\n') {
      hasLf = true;
    }
  }

  if (hasBareCr || (hasLf && hasCrlf)) return 'mixed';
  if (hasCrlf) return 'crlf';
  if (hasLf) return 'lf';
  return 'none';
}

function findOccurrences(content: string, search: string): Array<{ start: number; end: number }> {
  const matches: Array<{ start: number; end: number }> = [];
  let offset = 0;

  while (offset <= content.length - search.length) {
    const start = content.indexOf(search, offset);
    if (start === -1) break;
    matches.push({ start, end: start + search.length });
    offset = start + search.length;
  }

  return matches;
}

function normalizeCrlfWithBoundaries(value: string): { content: string; boundaries: number[] } {
  let content = '';
  const boundaries = [0];

  for (let rawOffset = 0; rawOffset < value.length; rawOffset += 1) {
    if (value[rawOffset] === '\r' && value[rawOffset + 1] === '\n') {
      content += '\n';
      rawOffset += 1;
    } else {
      content += value[rawOffset];
    }
    boundaries.push(rawOffset + 1);
  }

  return { content, boundaries };
}

function normalizedOccurrences(
  content: string,
  search: string,
): Array<{ start: number; end: number }> {
  const normalizedContent = normalizeCrlfWithBoundaries(content);
  const normalizedSearch = normalizeCrlfWithBoundaries(search).content;

  return findOccurrences(normalizedContent.content, normalizedSearch).map(({ start, end }) => ({
    start: normalizedContent.boundaries[start],
    end: normalizedContent.boundaries[end],
  }));
}

function normalizeReplacement(replacement: string, contentStyle: LineEndingStyle): string {
  if (contentStyle === 'crlf') {
    return replacement.replace(/\r?\n/g, '\r\n');
  }
  if (contentStyle === 'lf') {
    return replacement.replace(/\r\n/g, '\n');
  }
  return replacement;
}

/**
 * Apply an exact search/replace while preserving untouched bytes.
 *
 * Both the CLI and web edit handlers consume this function. The runtime shells
 * retain their own guards, persistence, diagnostics, and result presentation;
 * only deterministic matching and line-ending behavior lives here.
 */
export function applySearchReplace(content: string, args: SearchReplaceArgs): SearchReplaceResult {
  if (args.search.length === 0) {
    return { error: 'search must be non-empty' };
  }

  const contentStyle = lineEndingStyle(content);
  let matches = findOccurrences(content, args.search);

  if (matches.length === 0) {
    const searchStyle = lineEndingStyle(args.search);
    const lineEndingsDiffer =
      (contentStyle === 'crlf' && searchStyle === 'lf') ||
      (contentStyle === 'lf' && searchStyle === 'crlf');

    if (lineEndingsDiffer) {
      matches = normalizedOccurrences(content, args.search);
    }
  }

  if (matches.length === 0) {
    return { error: 'search text was not found', occurrences: 0 };
  }

  if (matches.length > 1 && args.replace_all !== true) {
    return {
      error: `search text matched ${matches.length} occurrences; add surrounding context or set replace_all to true`,
      occurrences: matches.length,
      locations: matches,
    };
  }

  const selectedMatches = args.replace_all === true ? matches : matches.slice(0, 1);
  const replacement = normalizeReplacement(args.replace, contentStyle);
  const appliedMatches: SearchReplaceMatch[] = [];
  let result = '';
  let rawOffset = 0;

  for (const match of selectedMatches) {
    result += content.slice(rawOffset, match.start);
    const resultStart = result.length;
    result += replacement;
    appliedMatches.push({ ...match, resultStart });
    rawOffset = match.end;
  }
  result += content.slice(rawOffset);

  return { content: result, count: selectedMatches.length, matches: appliedMatches };
}
