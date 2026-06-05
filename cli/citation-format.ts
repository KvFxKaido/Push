/**
 * Shared formatting helpers for native web-search citations in the terminal.
 *
 * Both CLI render surfaces — the transcript REPL (`cli.ts`) and the TUI
 * framer (`tui-framers.ts`) — go through these so the http(s) hardening,
 * control-char stripping, and hostname display stay identical, mirroring the
 * web app's `SourcesFooter`.
 */

import type { UrlCitation } from '../lib/provider-contract.ts';

/**
 * Parse a citation URL, returning null for anything that isn't a plain
 * http(s) link. Citation URLs come from upstream web-search results, so a
 * hostile or malformed entry could carry a `javascript:` / `data:` scheme —
 * those must never be surfaced as a clickable/echoed source.
 */
export function safeCitationUrl(url: string): URL | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null;
  } catch {
    return null;
  }
}

/** Display hostname for a parsed citation URL (drops a leading `www.`). */
export function citationHost(parsed: URL): string {
  return parsed.hostname.replace(/^www\./, '');
}

// C0 (0x00–0x1F) + DEL (0x7F) + C1 (0x80–0x9F) control chars, incl. the ANSI
// escape `ESC` (0x1B). Built from a string so no literal control bytes live in
// source (and to sidestep the control-char regex-literal lint).
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f]', 'g');

/**
 * Strip terminal control characters from upstream text before echoing it to
 * the terminal. Citation titles come from arbitrary web pages, so a hostile
 * title could otherwise inject escape sequences that move the cursor or
 * recolor the terminal. URLs don't need this — the `URL` parser already
 * percent-encodes control bytes.
 */
export function sanitizeCitationText(text: string): string {
  return text.replace(CONTROL_CHARS, ' ').trim();
}

/**
 * Filter a citation list down to the entries with a safe http(s) URL,
 * paired with the parsed `URL` so callers don't re-parse. Order preserved.
 */
export function safeCitations(citations: UrlCitation[]): { citation: UrlCitation; url: URL }[] {
  const out: { citation: UrlCitation; url: URL }[] = [];
  for (const citation of citations) {
    const url = safeCitationUrl(citation.url);
    if (url) out.push({ citation, url });
  }
  return out;
}
