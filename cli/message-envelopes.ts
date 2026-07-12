/**
 * message-envelopes.ts — vocabulary for runtime-injected message-content
 * envelopes (`[TOOL_RESULT]…[/TOOL_RESULT]`, `[PROJECT_INSTRUCTIONS …]…`,
 * `[CONTEXT DIGEST]…`), extracted from `session-store.ts`.
 *
 * Why its own module: this is a pure predicate over message *content* — a
 * client-side rendering concern (which persisted user turns are real human
 * input vs. runtime plumbing), not session persistence. Keeping it out of
 * `session-store.ts` lets transcript renderers (`tui-history.ts`) consume it
 * without importing the disk store, which the TUI import-boundary ratchet
 * (`cli/tests/tui-import-boundary.test.mjs`) forbids: a thin protocol client
 * needs this predicate to render previews, but must not need the store.
 */

/**
 * Is this message content a runtime-injected paired envelope rather than
 * human input? `messages` entries with `role: "user"` can hold tool-result
 * envelopes (`[TOOL_RESULT]...[/TOOL_RESULT]`), project-context blocks
 * (`[PROJECT_INSTRUCTIONS source="..."]...[/PROJECT_INSTRUCTIONS]`),
 * digests (`[CONTEXT DIGEST]...[/CONTEXT DIGEST]`), and other paired
 * internal envelopes — none of which make useful previews or transcript rows.
 *
 * Filtering rule: match only when the content opens with a paired envelope
 * tag — `^[NAME ...]...[/NAME]` where NAME is uppercase / underscore /
 * space. Blanket "starts with [" would drop legitimate human prompts like
 * `[WIP] refactor auth` or markdown checklists `[ ] fix flaky tests`;
 * paired-tag matching keeps those visible. Callers pass pre-trimmed content.
 */
export function isInternalEnvelope(trimmed: string): boolean {
  if (!trimmed.startsWith('[')) return false;
  const openMatch = trimmed.match(/^\[([^\]]+)\]/);
  if (!openMatch) return false;
  // Strip HTML/XML-style attributes (name="value") to recover the bare
  // tag name. PROJECT_INSTRUCTIONS is the only production envelope
  // that uses them today, but future envelopes may follow suit.
  const tagName = openMatch[1].replace(/\s+[A-Za-z_][\w-]*="[^"]*"/g, '').trim();
  if (!/^[A-Z_][A-Z_ 0-9]*$/.test(tagName)) return false;
  return trimmed.includes(`[/${tagName}]`);
}
