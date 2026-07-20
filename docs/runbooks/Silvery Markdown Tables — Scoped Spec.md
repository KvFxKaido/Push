# Silvery Markdown Tables — Scoped Spec

Date: 2026-07-20
Status: **Implemented** — shipped in `cli/silvery/markdown.tsx`.
Owner: Push CLI/TUI

## Why this exists

The CLI transcript's `MarkdownBody` supports headings, lists, quotes,
horizontal rules, inline emphasis/code/links, and fenced code, but not tables.
`parseMarkdown` currently classifies each row of a GFM table as ordinary text,
so the user sees the pipes and delimiter row literally:

```text
| Command | Description |
|---------|-------------|
| test    | Run tests   |
```

That fallback is legible and safe. It preserves the source rows exactly, so it
does not corrupt the transcript or clip the frame. The gap is presentation:
small comparison tables and matrices look conspicuously unfinished beside the
rest of the formatted assistant prose.

The web Streamdown path already renders GFM tables. This slice brings the
common generated-table case to the Silvery TUI without importing a markdown
engine or turning `markdown.tsx` into a general CommonMark implementation.

## Decision

Recognize a conservative GFM-table subset and render it as aligned Silvery
rows **only when the complete table fits the measured message-body width**.
When it does not fit, render the original source rows exactly as today.

This fit-or-raw rule is the central constraint:

- A normal table gets real columns, a styled header, and a quiet divider.
- A wide table loses no content to clipping or ellipsis and keeps the current
  ordinary-text markdown treatment.
- The TUI needs no horizontal-scroll interaction inside the transcript.
- The formatted path never wraps, so one source line still occupies one
  visual row.
- The raw fallback retains the existing raw-text wrapping upper bound.

This deliberately differs from the web table, which can use a horizontal
scroller. A terminal transcript has no discoverable, conflict-free horizontal
scroll affordance today; pretending otherwise would make the upgrade less
usable than the fallback.

## Current contracts to preserve

### Markdown is machine-prose-only

`Message` sends assistant, Reviewer/Auditor, and `tool_prose` bodies through
`MarkdownBody`. User, status, and fault text stays literal. Table recognition
must not move that boundary.

### Source lines are never dropped

`parseMarkdown(text).length === text.split(/\r?\n/).length` remains true. A
table is represented as one `MdLine` per source line, not as a replacement
block that silently consumes the delimiter row.

The delimiter source line renders as the visual table divider, so a three-line
source table remains three rendered rows in the formatted path.

### Height remains conservative

The active transcript uses `ListView virtualization="measured"`; Silvery
measures visible item height and no custom `estimateHeight` may be reintroduced.
The older `tailWindow` helper is exported only for its fallback test and is not
on the production render path.

Even so, this feature keeps the stronger original markdown invariant:

- formatted tables render only when their computed display width fits, and
  therefore occupy exactly one visual row per source row;
- over-wide tables use the raw source, whose wrapped height is already covered
  by `countVisualLines`.

No table-specific height estimator is needed. The apparent need for one only
arises if padded columns are allowed to wrap. This spec does not allow that.

### Visual Language v2

Tables use the existing grayscale ramp:

- header cells: body color + bold;
- divider and column separators: `VL_COLOR.muted`;
- body cells: inherited body color;
- inline links: the existing single accent;
- inline code: the existing muted treatment.

There is no table-specific accent, success color, background fill, or second
border color.

## Supported syntax

Recognition happens only outside fenced code blocks. A table begins when two
adjacent source lines satisfy all of the following:

1. The first line is a header row containing at least one unescaped cell pipe.
2. The second line has the same number of cells.
3. Every delimiter cell matches `:?-{3,}:?` after trimming.
4. The pair defines at least two columns.

Examples:

```markdown
| Command | Description |
| --- | --- |

Command | Description
--- | ---

| Left | Center | Right |
| :--- | :---: | ---: |
```

Alignment markers are honored:

- `:---` -> left;
- `:---:` -> center;
- `---:` -> right;
- `---` -> left.

Body rows continue until a blank line or a line with no table-cell pipe. As in
GFM, missing trailing cells are padded with empty cells and excess cells are
ignored. Header/delimiter column-count mismatch rejects the entire candidate;
it falls back to ordinary text rather than guessing.

### Cell splitting

Use a small stateful splitter, not `line.split('|')`:

- an optional leading and trailing pipe is structural;
- surrounding cell whitespace is trimmed;
- `\|` is a literal pipe in cell content;
- pipes inside backtick code spans are literal;
- backslash escapes are resolved only for the structural pipe decision, then
  the cell content continues through the existing `parseInline` path.

Cells support only the inline grammar `parseInline` already owns: plain text,
asterisk emphasis, inline code, and links. Block constructs, multiline cells,
HTML, nested tables, and row/column spans are not part of this slice.

## Parse representation

Extend `MdLineKind` with a single `table` kind and add table-specific fields to
`MdLine` (or a discriminated `MdTableLine` subtype):

```ts
type TableAlignment = 'left' | 'center' | 'right';
type TableRowRole = 'header' | 'divider' | 'body';

interface MdTableLayout {
  columnWidths: number[];
  alignments: TableAlignment[];
  formattedWidth: number;
}

interface MdTableLine {
  kind: 'table';
  role: TableRowRole;
  cells: InlineSpan[][];
  raw: string;
  table: MdTableLayout;
}
```

All lines in one table share the same immutable `MdTableLayout`. Keeping one
output object per source line preserves the parser's public shape and avoids a
broad `MdLine[]` -> block-tree migration for one construct.

`columnWidths` are terminal display-cell widths, not JavaScript string
lengths. Compute them from the actual visible cell output after inline parsing,
including a displayed link URL when `Spans` would append it. Use Silvery's
cell-aware width primitive (`displayWidth`) so CJK, combining characters, and
wide graphemes align correctly.

`formattedWidth` includes all column widths plus the exact separator padding.
It is the value used by the fit decision; the renderer must not independently
re-derive it.

## Rendering

### Shape

Use a minimal grid with no outer box:

```text
Command  │ Description
─────────┼────────────
test     │ Run tests
```

ASCII fallback:

```text
Command  | Description
---------+------------
test     | Run tests
```

The absence of top/bottom/outer rails is intentional. Adding them would create
rows with no source-line owner and would turn a small prose table into a heavy
card. The header delimiter already supplies enough structure in a monospace
transcript.

Use `detectUnicode()` through the existing `marksFor` seam. Add table column
and junction glyphs there rather than probing Unicode a second time.

### Alignment and padding

- Separate columns with one padding cell, the muted rail, and one padding cell
  (`" │ "` / `" | "`).
- Pad each visible cell to its table-wide `columnWidths[index]`.
- Left alignment puts all padding after content; right puts it before; center
  splits it with the extra cell after content.
- The divider row fills each column width with `─` (Unicode) or `-` (ASCII)
  and joins columns with `─┼─` / `-+-`.
- Empty cells still occupy their assigned width.

Render a fitted row as one non-wrapping Silvery row assembled from `<Text>`
spans. Do not use Silvery's generic `<Table>` component: it introduces a
nested `ListView`, defaults the header to the accent, sizes strings by code
units, and truncates cells. Those are the wrong contracts for transcript
markdown.

### Fit decision

`MarkdownBody` needs the actual content width, not a terminal-width guess.
Measure the body `<Box>` through Silvery's layout callback/ref seam and retain
the committed width in component state. Until a positive width is known,
render raw rows; this makes first paint safe and avoids an optimistic overflow.

For each parsed table:

```text
formattedWidth <= measuredBodyWidth  -> aligned table rows
formattedWidth >  measuredBodyWidth  -> original raw rows
```

The decision is per complete table, never per row. A resize may switch the
whole table between aligned and raw rendering; mixed aligned/raw rows are not
allowed.

The raw path must feed `line.raw` through the same `parseInline` / `Spans` path
an ordinary text line uses today. That keeps pipes, dashes, and author-supplied
spacing visible while preserving existing inline emphasis/link handling and
decorative-emoji stripping. It must not render parsed table cells with padding
or reconstruct the source from normalized cells.

## Streaming behavior

Do not recognize a table until the delimiter row is complete and valid.

- Header-only partial input renders as ordinary text.
- When the delimiter arrives, the parser may promote the header + delimiter to
  a table in one render.
- Later body rows join the same table as they stream.
- A malformed or partially typed delimiter remains ordinary text.

This creates at most one local reflow when the table becomes provable. It is
preferable to speculative formatting that flickers or misclassifies prose with
pipes. The table remains part of the containing message item, so measured
virtualization handles the update without a custom list estimate.

## Failure and fallback rules

Table support must fail open to the current rendering. In particular, render
the original lines as text for:

- a header with no valid following delimiter;
- mismatched header/delimiter column counts;
- delimiter cells with fewer than three dashes;
- a one-column candidate;
- a candidate inside a fenced code block;
- any internal parser inconsistency.

No malformed table should throw, disappear, consume the following paragraph,
or partially adopt table styling.

## Implementation slice

This is one bounded CLI-only slice:

1. **Parser** — add the table row splitter, conservative header/delimiter
   recognition, body-row collection, alignments, and shared intrinsic layout in
   `cli/silvery/markdown.tsx`.
2. **Renderer** — add table glyphs, fitted aligned rows, the measured-width
   fit gate, and verbatim raw fallback in the same module.
3. **Contract comments** — revise the module-level invariant commentary to
   name fit-or-raw tables explicitly; do not imply arbitrary padded blocks are
   width-non-increasing.
4. **Tests** — extend `cli/tests/markdown.test.mjs` for pure parsing and add
   Silvery render fixtures in `cli/tests/silvery-tui-p0.test.mjs` only where a
   component render is required.
5. **Decision-doc status** — none. This runbook is the implementation spec;
   no live architecture decision changes until the behavior ships. Mark this
   runbook implemented/archive it in the delivery PR rather than leaving a
   perpetual Draft beside shipped code.

No shared `lib/` vocabulary is needed. Tables are a presentation feature of
the CLI markdown sink; the web already owns its renderer and no protocol or
wire envelope changes.

## Test matrix

### Parser

- canonical leading/trailing-pipe table;
- pipe-less outer edges (`A | B`);
- left/center/right delimiter markers;
- escaped pipe and pipe inside inline code;
- inline emphasis, code, and link cells;
- short body row pads missing cells;
- long body row ignores excess cells;
- CRLF input;
- table-like text inside a fence remains `code`;
- malformed delimiter and count mismatch remain `text`;
- one `MdLine` per source line still holds across mixed prose, tables, and
  fences;
- visible column widths use terminal display cells rather than `.length`.

### Render

- a fitting table renders aligned columns and no literal `|---|` delimiter;
- Unicode and ASCII marks produce the specified shapes;
- header is bold, rails/divider are muted, and no new accent is introduced;
- right and center alignment pad correctly;
- exact-fit width formats; one cell narrower renders every row through the
  ordinary-text fallback;
- raw fallback preserves pipes, spacing, full cell content, and the existing
  inline-markdown/emoji behavior;
- resize switches the entire table atomically;
- formatted output has exactly the source table's row count;
- streaming header stays raw until the valid delimiter arrives.

### Regression

- existing headings, lists, quotes, rules, fences, syntax highlighting, emoji
  stripping, and user-literal rendering remain unchanged;
- no `ListView estimateHeight` or nested table `ListView` is introduced;
- a table near the transcript tail cannot displace or clip the composer/footer.

## Validation

Focused while iterating:

```bash
TMPDIR=/tmp TEMP=/tmp TMP=/tmp node --import tsx --test cli/tests/markdown.test.mjs
```

Delivery gate from the repository contract:

```bash
TMPDIR=/tmp TEMP=/tmp TMP=/tmp pnpm run test:cli
pnpm run typecheck:all
```

## Acceptance criteria

- Common two-or-more-column GFM tables render as aligned tables when they fit.
- Wide or malformed tables remain fully readable through the current raw-pipe
  ordinary-text rendering.
- No table content is clipped, truncated, or silently discarded.
- The source-line count and transcript-frame height guarantees remain true.
- Styling stays within Visual Language v2's one-accent budget.
- Table parsing remains a contained extension of `markdown.tsx`, with no new
  markdown dependency and no cross-surface protocol work.

## Non-goals

- Full CommonMark/GFM compliance.
- HTML tables, captions, nested tables, multiline cells, row spans, or column
  spans.
- Interactive sorting, selection, copy modes, or horizontal scrolling.
- Making the web and CLI renderers share an AST or component implementation.
- Replacing the current markdown parser with Streamdown, `marked-terminal`, or
  another general markdown library.
- Changing model prompts to discourage or encourage tables.

## Deferred follow-up

If real transcripts show that useful tables frequently exceed the available
width, the next decision is not "wrap the columns." It is whether the
transcript should gain a general horizontal-pan/inspect affordance for wide
structured content (tables, diffs, logs, and code). That is a surface-level
interaction decision and should not be smuggled into this parser slice.
