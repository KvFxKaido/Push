// AGENTS.md / CLAUDE.md / GEMINI.md content is user-controlled (repo owner writes it).
// This module applies TWO controls, and they are not the same kind of thing — the
// distinction matters, because listing them as one list of "defense-in-depth" is what
// made the size cap feel untouchable and kept it 4x tighter than any other agent's:
//
//   1. Delimiter escaping — THE INJECTION-DEFENSE BOUNDARY. A zero-width space breaks
//      any block delimiter the content tries to forge, so repo text cannot escape its
//      labeled envelope and impersonate the harness. This is a security control.
//      Never relax it, never make it conditional, never let a caller opt out.
//
//   2. Size cap — A RESOURCE LIMIT. It bounds context bloat / 413s. It is NOT a
//      security control and never defended against anything: a malicious AGENTS.md
//      fits its payload in the first 200 characters, comfortably inside any cap we
//      would ever set. Treat it as a budget, and set it by budget arithmetic.
//
// Because (2) is not a security boundary, truncation should be *honest* rather than
// merely small: cut on a structure boundary and name what was dropped, so the model
// knows the rulebook is incomplete instead of silently reading half of it as if it
// were the whole. See `truncateOnStructureBoundary` below.
import { SIZE_BUDGETS } from './size-budgets.js';

const MAX_PROJECT_INSTRUCTIONS_SIZE = SIZE_BUDGETS.projectInstructions;

/**
 * Canonical project-instructions block boundaries — the single source of truth
 * shared by the web and CLI orchestrators. The open marker carries an optional
 * `source="<file>"` provenance attribute, so consumers match on the prefix
 * (`[PROJECT_INSTRUCTIONS`) rather than a fixed string. Keeping these here (and
 * having the sanitizer escape the same form) means neither surface can drift on
 * the marker or ship content that forges the boundary.
 */
export const PROJECT_INSTRUCTIONS_OPEN_PREFIX = '[PROJECT_INSTRUCTIONS';
export const PROJECT_INSTRUCTIONS_CLOSE = '[/PROJECT_INSTRUCTIONS]';

/** Markdown ATX heading (`# ` … `###### `) at line start. Setext headings are not
 *  matched: they'd need lookahead and are rare in instruction files. */
const HEADING_LINE_RE = /^(#{1,6}) +(.+)$/;
/** A fenced-code delimiter (``` or ~~~), possibly indented, possibly with an info string. */
const FENCE_LINE_RE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * The minimum share of the budget a heading cut must preserve to be worth taking.
 *
 * Without this floor, a file shaped `# Title` + one huge `## Rules` section cuts at
 * `## Rules` and injects SEVEN CHARACTERS of a 32,000-char budget — the whole rulebook
 * traded for a tidy boundary. The hard-slice fallback did not catch it, because a
 * heading *did* fit; only its content didn't. (Codex, PR #1475.)
 *
 * So: spend at most HALF the budget buying a clean boundary. Beyond that, a mid-section
 * cut that delivers the rules beats a tidy cut that delivers a title.
 *
 * Half rather than something stricter because the floor is here to catch the
 * pathological case (Codex's example retains 0.02% of the budget), not to second-guess
 * ordinary cuts: a section large enough to cost more than half a 32k budget is already
 * unusual, while a section costing 20–40% is routine and still worth cutting cleanly.
 */
const MIN_BOUNDARY_RETENTION = 0.5;

/** Headings OUTSIDE fenced code blocks, with their start offsets.
 *
 *  Fence-aware because this repo's own AGENTS.md puts `# setup:` / `# test:` /
 *  `# typecheck:` shell comments inside a ```bash fence — line-start `# `, and so
 *  indistinguishable from an H1 to a naive scan. Treating those as headings would
 *  let the truncator cut INSIDE the fence, leaving it unterminated so the marker
 *  renders as code, and would name shell comments as "omitted sections".
 *  (Codex, PR #1475.) */
function scanHeadings(raw: string): Array<{ index: number; title: string }> {
  const headings: Array<{ index: number; title: string }> = [];
  let offset = 0;
  let fence: string | null = null;
  for (const line of raw.split('\n')) {
    const fenceMatch = FENCE_LINE_RE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      // An opening fence is closed only by a fence of the SAME character.
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
    } else if (fence === null) {
      const heading = HEADING_LINE_RE.exec(line);
      if (heading) headings.push({ index: offset, title: line.trim() });
    }
    offset += line.length + 1; // +1 for the '\n' consumed by split
  }
  return headings;
}

/** True when `text` ends with an unterminated code fence. */
function hasOpenFence(text: string): boolean {
  let fence: string | null = null;
  for (const line of text.split('\n')) {
    const m = FENCE_LINE_RE.exec(line);
    if (!m) continue;
    const marker = m[1][0];
    if (fence === null) fence = marker;
    else if (fence === marker) fence = null;
  }
  return fence !== null;
}

/**
 * Cut `raw` to at most `cap` chars, preferring the last heading boundary that fits —
 * but never at the price of the budget itself (see {@link MIN_BOUNDARY_RETENTION}).
 *
 * A blind `slice(0, cap)` lands mid-sentence, and a model reading a rulebook that
 * stops mid-clause has no way to know the rest existed. Cutting on a heading keeps
 * every surviving section whole, and lets the marker NAME the sections it dropped —
 * so an incomplete rulebook announces itself instead of passing as a complete one.
 *
 * Falls back to a hard slice when no heading boundary is available (an unstructured
 * file) or when taking one would cost too much of the budget: losing a tail is still
 * better than losing the content, and the marker still says so. A hard slice can land
 * inside a fenced block, so it closes the fence rather than leave the marker rendering
 * as code.
 */
export function truncateOnStructureBoundary(
  raw: string,
  cap: number,
): { content: string; omittedChars: number; droppedSections: string[] } {
  if (raw.length <= cap) return { content: raw, omittedChars: 0, droppedSections: [] };

  const headings = scanHeadings(raw);

  // The last heading starting at-or-before the cap is the first one we must drop; cut
  // immediately before it so the section above survives whole. Index 0 is never a valid
  // cut (it would empty the block), and a cut that keeps less than MIN_BOUNDARY_RETENTION
  // of the budget is a worse deal than a mid-section slice.
  const lastFitting = headings.filter((h) => h.index > 0 && h.index <= cap).pop();
  const cutAt =
    lastFitting && lastFitting.index >= cap * MIN_BOUNDARY_RETENTION ? lastFitting.index : cap;

  let content = raw.slice(0, cutAt).trimEnd();
  // A hard slice can sever a fenced block. Close it, or the truncation marker below —
  // and everything after it — renders as code in the model's view of the block.
  if (hasOpenFence(content)) content += '\n```';

  return {
    content,
    omittedChars: raw.length - cutAt,
    droppedSections: headings.filter((h) => h.index >= cutAt).map((h) => h.title),
  };
}

/**
 * Bounds on the truncation marker's dropped-section roll-call.
 *
 * BOTH are load-bearing. Capping the COUNT alone left the marker unbounded, because a
 * heading is `.+` to end-of-line: one pathological 30,000-char heading could ride into
 * the marker under a 100-char cap, so the branch that enforces the budget was the
 * branch that blew it — and it fires only on files already over budget. (fugu, PR #1475.)
 *
 * With both caps the marker is bounded by roughly
 * `MAX_LISTED × (MAX_TITLE + 3) + ~180` ≈ 1KB, regardless of input.
 */
const MAX_LISTED_DROPPED_SECTIONS = 12;
const MAX_DROPPED_TITLE_CHARS = 60;

/** One dropped-section title, bounded — see {@link MAX_DROPPED_TITLE_CHARS}. */
function clampTitle(title: string): string {
  return title.length <= MAX_DROPPED_TITLE_CHARS
    ? title
    : `${title.slice(0, MAX_DROPPED_TITLE_CHARS - 1)}…`;
}

/**
 * Sanitize project instructions before injection into prompts: cap the size, then
 * escape delimiter sequences so the content cannot break out of its labeled block.
 * `maxSize` lets each consumer pass its own budget while sharing the one escaping
 * implementation (see the two-controls note at the top of this file — the escaping is
 * the security boundary; the cap is a budget).
 */
export function sanitizeProjectInstructions(
  raw: string,
  maxSize: number = MAX_PROJECT_INSTRUCTIONS_SIZE,
): string {
  // Defensive clamp on the public injection-defense boundary. Floor first, then
  // require a strictly-positive integer — otherwise fall back to the default
  // budget so the cap stays predictable. This rejects the whole degenerate
  // class in one check: NaN/±Infinity (disable truncation, `len > NaN` is
  // always false), negatives (negative-index slice), and anything that floors
  // to 0 — explicit 0/-0 *and* fractions like 0.5 — which would otherwise
  // collapse every input to an empty "truncated" block.
  const flooredMax = Number.isFinite(maxSize) ? Math.floor(maxSize) : 0;
  const cap = flooredMax > 0 ? flooredMax : MAX_PROJECT_INSTRUCTIONS_SIZE;
  let content = raw;

  if (content.length > cap) {
    const cut = truncateOnStructureBoundary(raw, cap);
    // Name what was lost. A truncated rulebook that doesn't say which rules are
    // missing reads exactly like a complete one — which is how "the model ignored
    // our conventions" turns out to mean "we never sent them".
    const listed = cut.droppedSections.slice(0, MAX_LISTED_DROPPED_SECTIONS).map(clampTitle);
    const overflow = cut.droppedSections.length - listed.length;
    const sectionNote = listed.length
      ? `\nSections omitted: ${listed.join(' | ')}${overflow > 0 ? ` | …and ${overflow} more` : ''}`
      : '';
    content =
      `${cut.content}\n\n[Project instructions truncated — ${cut.omittedChars} chars omitted.` +
      ` This file is INCOMPLETE; do not assume the conventions you can see are all of them.${sectionNote}]`;
  }

  // Break any block boundary the content tries to forge — both the canonical
  // underscore envelope (including an attribute-bearing open tag like
  // `[PROJECT_INSTRUCTIONS source="x"]`) and the legacy space form, so neither
  // surface's marker can be spoofed regardless of which one is in use.
  content = content
    .replace(/\[PROJECT_INSTRUCTIONS/gi, '[PROJECT_INSTRUCTIONS\u200B')
    .replace(/\[\/PROJECT_INSTRUCTIONS\]/gi, '[/PROJECT_INSTRUCTIONS\u200B]')
    .replace(/\[PROJECT INSTRUCTIONS\]/gi, '[PROJECT INSTRUCTIONS\u200B]')
    .replace(/\[\/PROJECT INSTRUCTIONS\]/gi, '[/PROJECT INSTRUCTIONS\u200B]');

  return content;
}

/** Strip characters that would let a `source` label break out of the
 *  `source="..."` attribute (filenames are safe in practice; defensive). */
function sanitizeSourceLabel(source: string | null | undefined): string | null {
  const trimmed = source?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/["\]\r\n]/g, '');
}

/**
 * Format a project-instructions block in the canonical envelope, with the
 * content sanitized (size-capped + delimiter-escaped). The single formatter
 * shared by the web and CLI orchestrators so both emit an identical, equally
 * defended block — previously the CLI wrapped raw content in the underscore
 * marker without escaping, while the web used a different (space) marker and
 * the delegated-role agents used a bespoke prose header with no escaping at all.
 * `source` records provenance (e.g. "AGENTS.md") when known; `maxSize` overrides
 * the default sanitizer budget for consumers with their own cap.
 */
export function formatProjectInstructionsBlock(
  rawContent: string,
  options: { source?: string | null; maxSize?: number } = {},
): string {
  const safe = sanitizeProjectInstructions(rawContent, options.maxSize);
  const source = sanitizeSourceLabel(options.source);
  const open = source
    ? `${PROJECT_INSTRUCTIONS_OPEN_PREFIX} source="${source}"]`
    : `${PROJECT_INSTRUCTIONS_OPEN_PREFIX}]`;
  return `${open}\n${safe}\n${PROJECT_INSTRUCTIONS_CLOSE}`;
}
