/**
 * tui-inline.ts — Inline markdown emphasis for the assistant framer.
 *
 * Renders `**bold**`, `` `code` ``, and `[text](url)` links inside prose,
 * bullets, and blockquotes — so the markdown reads styled instead of showing
 * literal `*`/`` ` ``/`[]()` markers. Mirrors the code-fence pattern: produce a
 * pre-styled ANSI string and push it with an identity styleFn, letting the
 * existing ANSI-aware `wordWrap` handle width.
 *
 * Two invariants make this safe:
 *
 * 1. **No colour across a space.** `wordWrap` splits on spaces, so a styled run
 *    that spans a space could leak colour onto the next wrapped line. Every span
 *    is styled per-word (see `styleSafe`), exactly like tui-highlight's
 *    `styleSpan`. Each space-separated token is independently balanced
 *    (open…RESET), so a wrap between words is always safe.
 *
 * 2. **Line-local + pure.** `renderInline` is a pure function of a single line,
 *    so retained and transitional ANSI renderers can reflow it independently:
 *    an unclosed `**` only exists on the current line and resolves when closed.
 *
 * Links use **per-line footnotes**: `[text](url)` renders as `text¹` with the
 * url listed on its own line just below. Numbering resets per line — deliberate,
 * because a message-level counter would behave like a *visible*
 * `jsonFenceOrdinal` and diverge across independently rendered rows (breaking
 * invariant 2). Per-line also keeps the url adjacent to its anchor, which reads better on
 * a narrow / mobile terminal than a list scrolled off at the bottom.
 *
 * v1 scope: bold (`**` / `__`), inline code, links. Deliberately flat — no
 * emphasis is parsed *inside* a span (e.g. a link inside bold renders literally).
 * Italic and strikethrough are deferred: they need theme primitives that don't
 * exist yet (SGR 3/9) and italic carries the messiest CommonMark flanking rules.
 */

import type { Theme, TokenName } from './tui-theme.js';

export interface InlineResult {
  /** Pre-styled main line: markers → ANSI, links → `text` + superscript marker. */
  text: string;
  /** Pre-styled footnote lines (`¹ https://…`) to push under the main line. */
  footnotes: string[];
}

const SUPERSCRIPTS = ['⁰', '¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹'];

function superscript(n: number, unicode: boolean): string {
  if (!unicode) return `[${n}]`;
  return String(n)
    .split('')
    .map((d) => SUPERSCRIPTS[Number(d)])
    .join('');
}

/**
 * Style `text` with `token`, but per-word so colour never stays open across a
 * space (the wrap-safety invariant). Mirror of tui-highlight's `styleSpan`.
 */
function styleSafe(theme: Theme, token: TokenName, text: string): string {
  if (text === '') return '';
  if (text.indexOf(' ') === -1) return theme.style(token, text);
  return text
    .split(' ')
    .map((part) => (part === '' ? '' : theme.style(token, part)))
    .join(' ');
}

/**
 * Bold `text` per-word, keeping the line's base foreground. Bold (SGR 1m) alone
 * drops to the terminal's default fg, which on a dark terminal can read dimmer
 * than the surrounding `fg.primary`/`fg.secondary` prose — so wrap bold in the
 * base colour (colour outer, bold inner → one trailing reset, still balanced).
 */
function boldSafe(theme: Theme, token: TokenName, text: string): string {
  if (text === '') return '';
  const bold = (word: string) => theme.style(token, theme.bold(word));
  if (text.indexOf(' ') === -1) return bold(text);
  return text
    .split(' ')
    .map((part) => (part === '' ? '' : bold(part)))
    .join(' ');
}

// `[text](url)` with an optional ignored title; link text has no `]` or newline,
// url no whitespace. Anchored — matched against the slice starting at a `[`.
const LINK_RE = /^\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/;

/**
 * Render inline markdown in one line. Returns the pre-styled line plus any
 * per-line footnotes. No-op at `tier: 'none'` (no styling capability → leave
 * source markers intact, which also keeps tier-none goldens stable).
 */
export function renderInline(
  theme: Theme,
  text: string,
  baseToken: TokenName = 'fg.primary',
): InlineResult {
  if (theme.tier === 'none') return { text, footnotes: [] };

  const footnotes: string[] = [];
  let out = '';
  let plain = '';
  const flushPlain = () => {
    if (plain) {
      out += styleSafe(theme, baseToken, plain);
      plain = '';
    }
  };

  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];

    // Backslash escape: \* \` \[ \\ → the literal character.
    if (c === '\\' && i + 1 < n && '*`[\\'.includes(text[i + 1])) {
      plain += text[i + 1];
      i += 2;
      continue;
    }

    // Inline code — highest precedence; interior is never re-parsed.
    if (c === '`') {
      const close = text.indexOf('`', i + 1);
      if (close !== -1) {
        flushPlain();
        out += styleSafe(theme, 'accent.secondary', text.slice(i + 1, close));
        i = close + 1;
        continue;
      }
      plain += c; // unterminated → literal backtick
      i += 1;
      continue;
    }

    // Bold: ** … ** or __ … __ (non-empty, flat interior).
    if ((c === '*' && text[i + 1] === '*') || (c === '_' && text[i + 1] === '_')) {
      const marker = text.slice(i, i + 2);
      const close = text.indexOf(marker, i + 2);
      if (close > i + 2) {
        flushPlain();
        out += boldSafe(theme, baseToken, text.slice(i + 2, close));
        i = close + 2;
        continue;
      }
      plain += c; // unbalanced → literal
      i += 1;
      continue;
    }

    // Link: [text](url) → styled text + superscript footnote marker.
    if (c === '[') {
      const m = LINK_RE.exec(text.slice(i));
      if (m) {
        flushPlain();
        const linkText = m[1];
        const url = m[2];
        const num = footnotes.length + 1;
        const marker = superscript(num, Boolean(theme.unicode));
        out += styleLinkWithMarker(theme, linkText, marker);
        footnotes.push(`${theme.dim(marker)} ${styleSafe(theme, 'accent.link', url)}`);
        i += m[0].length;
        continue;
      }
      plain += c; // not a link → literal '['
      i += 1;
      continue;
    }

    plain += c;
    i += 1;
  }
  flushPlain();

  return { text: out, footnotes };
}

/**
 * Style link text in the link colour, with the footnote marker attached to the
 * LAST word (no space) so a wrap can never strand the marker on its own line.
 */
function styleLinkWithMarker(theme: Theme, linkText: string, marker: string): string {
  const styledMarker = theme.dim(marker);
  const words = linkText.split(' ');
  return words
    .map((word, idx) => {
      const styled = word === '' ? '' : theme.style('accent.link', word);
      return idx === words.length - 1 ? styled + styledMarker : styled;
    })
    .join(' ');
}
