/**
 * Shared formatting helpers for native web-search citations in the terminal.
 *
 * Both CLI render surfaces — the transcript REPL (`cli.ts`) and the TUI
 * framer (`tui-framers.ts`) — go through these so the http(s) hardening,
 * control-char stripping, and hostname display stay identical, mirroring the
 * web app's `SourcesFooter`.
 */

import type { UrlCitation } from '../lib/provider-contract.ts';

// Characters that must never reach the terminal verbatim from upstream text:
//   - C0 (0x00–0x1F) + DEL (0x7F) + C1 (0x80–0x9F) controls, incl. ANSI ESC.
//   - soft hyphen (00AD), zero-width + directional marks (200B–200F),
//     line/paragraph separators (2028–2029), Bidi overrides (202A–202E,
//     2066–2069), and the BOM/ZWNBSP (FEFF).
// Bidi/zero-width chars enable visual spoofing (reordering or hiding text)
// even though they aren't "control codes" in the C0/C1 sense. Built from a
// string so no literal control bytes live in source (and to sidestep the
// control-char regex-literal lint).
const UNSAFE_TERMINAL_CHAR_CLASS =
  '[\\u0000-\\u001f\\u007f-\\u009f\\u00ad\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069\\ufeff]';
const UNSAFE_TERMINAL_CHAR = new RegExp(UNSAFE_TERMINAL_CHAR_CLASS);
const UNSAFE_TERMINAL_CHARS = new RegExp(UNSAFE_TERMINAL_CHAR_CLASS, 'g');

function parseHttpUrl(url: string): URL | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Parse a citation URL, returning null for anything that isn't a plain
 * http(s) link. Citation URLs come from upstream web-search results, so a
 * hostile or malformed entry could carry a `javascript:` / `data:` scheme —
 * those must never be surfaced as a clickable/echoed source.
 */
export function safeCitationUrl(url: string): URL | null {
  return parseHttpUrl(url);
}

/**
 * Validate a URL before placing it into terminal hyperlink metadata. Unlike a
 * citation URL that is only echoed as text, an OSC 8 target rejects invisible
 * and control characters outright rather than relying on URL percent-encoding.
 */
export function safeTerminalUrl(url: string): URL | null {
  if (!url || url !== url.trim() || UNSAFE_TERMINAL_CHAR.test(url)) return null;
  return parseHttpUrl(url);
}

/** Display hostname for a parsed citation URL (drops a leading `www.`). */
export function citationHost(parsed: URL): string {
  return parsed.hostname.replace(/^www\./, '');
}

/**
 * Strip terminal control characters from upstream text before echoing it to
 * the terminal. Citation titles come from arbitrary web pages, so a hostile
 * title could otherwise inject escape sequences that move the cursor or
 * recolor the terminal. URLs don't need this — the `URL` parser already
 * percent-encodes control bytes.
 */
export function sanitizeCitationText(text: string): string {
  return text.replace(UNSAFE_TERMINAL_CHARS, ' ').trim();
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
