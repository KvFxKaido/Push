/**
 * tui-fuzzy.mjs — Fuzzy filtering utilities for the Push TUI.
 * Simple fuzzy matching for session picker and other searchable lists.
 */

/**
 * Calculate a fuzzy match score for a query against a target string.
 * Returns { score: number, matches: [start, end][] } or null if no match.
 * 
 * Scoring:
 * - Exact substring match: high score
 * - Character-by-character match (in order): decreasing score based on gaps
 * - Start of word bonus
 * - Consecutive match bonus
 */
export function fuzzyMatch(query, target) {
  if (!query) return { score: 1, matches: [[0, target.length]] };
  if (!target) return null;
  
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  
  // First try exact substring match
  const substrIdx = t.indexOf(q);
  if (substrIdx !== -1) {
    return {
      score: 100 + (substrIdx === 0 ? 50 : 0),
      matches: [[substrIdx, substrIdx + q.length]],
    };
  }
  
  // Try character-by-character matching
  let qIdx = 0;
  let tIdx = 0;
  const matches = [];
  let matchStart = -1;
  let lastMatchEnd = -1;
  let score = 0;
  let gapPenalty = 0;
  
  while (qIdx < q.length && tIdx < t.length) {
    if (q[qIdx] === t[tIdx]) {
      if (matchStart === -1) {
        matchStart = tIdx;
        // Bonus for start of word
        if (tIdx === 0 || t[tIdx - 1] === ' ' || t[tIdx - 1] === '-' || t[tIdx - 1] === '_') {
          score += 10;
        }
        // Penalty for gaps
        if (lastMatchEnd !== -1) {
          gapPenalty += (matchStart - lastMatchEnd);
        }
      }
      qIdx++;
    } else if (matchStart !== -1) {
      // End of a match segment
      matches.push([matchStart, tIdx]);
      lastMatchEnd = tIdx;
      matchStart = -1;
    }
    tIdx++;
  }
  
  // Close final match segment
  if (matchStart !== -1) {
    matches.push([matchStart, tIdx]);
  }
  
  // Did we match all query characters?
  if (qIdx < q.length) return null;
  
  // Calculate final score
  score = Math.max(1, 50 - gapPenalty + (matches.length === 1 ? 20 : 0));
  
  return { score, matches };
}

/**
 * Filter an array of items using fuzzy matching.
 * Each item can be a string or an object with a `text` property.
 * Returns array of { item, score, matches } sorted by score descending.
 */
export function fuzzyFilter(items, query, options = {}) {
  const { key = null, maxResults = Infinity } = options;
  
  if (!query || !query.trim()) {
    return items.map(item => ({ item, score: 1, matches: [] }));
  }
  
  const results = [];
  const q = query.toLowerCase().trim();
  
  for (const item of items) {
    const text = key ? item[key] : (typeof item === 'string' ? item : item.text || '');
    const result = fuzzyMatch(q, String(text));
    if (result) {
      results.push({ item, score: result.score, matches: result.matches });
    }
  }
  
  // Sort by score descending
  results.sort((a, b) => b.score - a.score);
  
  if (maxResults !== Infinity) {
    return results.slice(0, maxResults);
  }
  return results;
}

/**
 * Highlight matched portions of a string with ANSI colors.
 * Returns the highlighted string.
 */
export function highlightMatches(text, matches, theme) {
  if (!matches || matches.length === 0) return text;
  
  let result = '';
  let lastEnd = 0;
  
  for (const [start, end] of matches) {
    // Add unmatched portion
    if (start > lastEnd) {
      result += text.slice(lastEnd, start);
    }
    // Add highlighted match
    result += theme.style('accent.primary', text.slice(start, end));
    lastEnd = end;
  }
  
  // Add remaining unmatched portion
  if (lastEnd < text.length) {
    result += text.slice(lastEnd);
  }
  
  return result;
}

/**
 * Simple filter for session picker - matches against session name, id, provider, model, or cwd.
 */
export function filterSessions(sessions, query) {
  if (!query || !query.trim()) {
    return sessions.map(s => ({ item: s, score: 1, matches: [] }));
  }
  
  const q = query.toLowerCase().trim();
  const results = [];
  
  for (const session of sessions) {
    // Build searchable text from all relevant fields
    const searchableFields = [
      session.sessionName || '',
      session.sessionId || '',
      session.provider || '',
      session.model || '',
      session.cwd || '',
    ];
    
    // Try matching against each field
    let bestScore = 0;
    for (const field of searchableFields) {
      const result = fuzzyMatch(q, field);
      if (result && result.score > bestScore) {
        bestScore = result.score;
      }
    }
    
    if (bestScore > 0) {
      results.push({ item: session, score: bestScore, matches: [] });
    }
  }
  
  results.sort((a, b) => b.score - a.score);
  return results;
}
