/**
 * edit-diff.ts — structured line diff for file-mutation tool results.
 *
 * `computeEditDiff` turns a before/after content pair into a compact,
 * display-oriented diff: hunks of context/add/delete lines with 1-based
 * line numbers on both sides. The CLI executor attaches it to
 * `edit_file` / `write_file` results (`meta.editDiff`), the coder kernel
 * forwards it on `tool.execution_complete` as the optional `diff` field,
 * and the TUI renders it as a Claude-Code-style edit card (line-number
 * gutter, +/- markers, tinted backgrounds).
 *
 * The output is bounded by design — it rides a run event that fans out
 * over WebSocket to attached clients, so both the line count and the
 * per-line length are capped and the `truncated` flag says so. Line text
 * is display-scrubbed (tabs expanded, C0 controls stripped) because it
 * is written raw into terminal cells; consumers must not treat it as a
 * byte-faithful patch. `git diff` remains the source of truth for
 * applying/reviewing changes.
 */

/** Canonical line-kind vocabulary — the JSON schema enum is built from this
 *  constant (lib/protocol-json-schema.ts) so the two can't drift. */
export const EDIT_DIFF_LINE_KINDS = ['add', 'del', 'ctx'] as const;

export type EditDiffLineKind = (typeof EDIT_DIFF_LINE_KINDS)[number];

export interface EditDiffLine {
  kind: EditDiffLineKind;
  /** 1-based line number in the old file. Absent on `add` lines. */
  oldLine?: number;
  /** 1-based line number in the new file. Absent on `del` lines. */
  newLine?: number;
  /** Display-scrubbed line content (tabs expanded, control chars stripped). */
  text: string;
  /** Set when the line text itself was cut at MAX_LINE_CHARS. */
  textTruncated?: boolean;
}

export interface EditDiff {
  /** Workspace-relative path of the edited file. */
  path: string;
  /** Total added lines across the whole change (not just the emitted window). */
  adds: number;
  /** Total deleted lines across the whole change. */
  dels: number;
  /** Hunk lines, oldest first. Hunk boundaries are implicit: a jump in
   *  line numbers between consecutive entries means skipped context. */
  lines: EditDiffLine[];
  /** True when `lines` was cut at MAX_DIFF_LINES (adds/dels stay accurate). */
  truncated?: boolean;
}

/** Context lines kept on each side of a change run. */
export const EDIT_DIFF_CONTEXT_LINES = 2;
/** Hard cap on emitted diff lines (context + adds + dels). */
export const EDIT_DIFF_MAX_LINES = 80;
/** Hard cap on emitted per-line characters (after tab expansion). */
export const EDIT_DIFF_MAX_LINE_CHARS = 300;
/** Files beyond this many lines on either side skip diff computation. */
export const EDIT_DIFF_MAX_FILE_LINES = 40_000;
/** LCS matrix budget: middles bigger than this fall back to block replace. */
const LCS_CELL_BUDGET = 4_000_000;

/** Scrub a raw file line for terminal display: expand tabs, drop other
 *  C0 controls (a stray ESC would corrupt every transcript row after it),
 *  and cut at MAX_LINE_CHARS. */
function scrubLine(raw: string): { text: string; textTruncated: boolean } {
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/\t/g, '  ').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
  if (cleaned.length <= EDIT_DIFF_MAX_LINE_CHARS) {
    return { text: cleaned, textTruncated: false };
  }
  return { text: cleaned.slice(0, EDIT_DIFF_MAX_LINE_CHARS), textTruncated: true };
}

/** Split content into diffable lines. A trailing newline produces a final
 *  empty element from split('\n'); drop it so "file ends with \n" doesn't
 *  register as a phantom empty last line. A lone trailing-'\r' (CRLF file)
 *  stays in the raw value for comparison but is scrubbed for display. */
function splitDiffLines(content: string): string[] {
  const text = String(content);
  // Empty content is zero lines, not one empty line — "all content deleted"
  // must diff as pure deletions, and a brand-new file as pure additions.
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

interface ChangeRegion {
  /** 0-based index into oldLines where the change starts. */
  oldStart: number;
  oldCount: number;
  /** 0-based index into newLines where the change starts. */
  newStart: number;
  newCount: number;
}

/**
 * Minimal change regions between two line arrays: trim the common
 * prefix/suffix, then LCS the middle when it fits the cell budget.
 * Oversized middles collapse to one whole-block replace region — coarse
 * but bounded, and the caps below trim it for display anyway.
 */
function computeChangeRegions(oldLines: string[], newLines: string[]): ChangeRegion[] {
  let prefix = 0;
  const maxPrefix = Math.min(oldLines.length, newLines.length);
  while (prefix < maxPrefix && oldLines[prefix] === newLines[prefix]) prefix++;

  let suffix = 0;
  const maxSuffix = Math.min(oldLines.length, newLines.length) - prefix;
  while (
    suffix < maxSuffix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const oldMid = oldLines.slice(prefix, oldLines.length - suffix);
  const newMid = newLines.slice(prefix, newLines.length - suffix);
  if (oldMid.length === 0 && newMid.length === 0) return [];

  if (
    oldMid.length === 0 ||
    newMid.length === 0 ||
    oldMid.length * newMid.length > LCS_CELL_BUDGET
  ) {
    return [
      { oldStart: prefix, oldCount: oldMid.length, newStart: prefix, newCount: newMid.length },
    ];
  }

  // Full LCS table (kept for the traceback walk below). Bounded by
  // LCS_CELL_BUDGET, so worst case is ~16MB of Uint32 rows.
  // table[j][i] = LCS length of newMid[j..] vs oldMid[i..], built bottom-up.
  const cols = oldMid.length + 1;
  const table: Uint32Array[] = new Array(newMid.length + 1);
  table[newMid.length] = new Uint32Array(cols);
  for (let j = newMid.length - 1; j >= 0; j--) {
    const prev = table[j + 1];
    const curr = new Uint32Array(cols);
    for (let i = oldMid.length - 1; i >= 0; i--) {
      curr[i] = oldMid[i] === newMid[j] ? prev[i + 1] + 1 : Math.max(prev[i], curr[i + 1]);
    }
    table[j] = curr;
  }

  // Walk the table, coalescing non-matches into change regions.
  const regions: ChangeRegion[] = [];
  let i = 0;
  let j = 0;
  let openRegion: ChangeRegion | null = null;
  const closeRegion = (): void => {
    if (openRegion) {
      regions.push(openRegion);
      openRegion = null;
    }
  };
  const extend = (delOld: boolean): void => {
    if (!openRegion) {
      openRegion = { oldStart: prefix + i, oldCount: 0, newStart: prefix + j, newCount: 0 };
    }
    if (delOld) {
      openRegion.oldCount++;
      i++;
    } else {
      openRegion.newCount++;
      j++;
    }
  };
  while (i < oldMid.length && j < newMid.length) {
    if (oldMid[i] === newMid[j]) {
      closeRegion();
      i++;
      j++;
    } else if (table[j][i + 1] >= table[j + 1][i]) {
      extend(true);
    } else {
      extend(false);
    }
  }
  while (i < oldMid.length) extend(true);
  while (j < newMid.length) extend(false);
  closeRegion();
  return regions;
}

export interface ComputeEditDiffOptions {
  /** Cap on emitted diff lines. Defaults to EDIT_DIFF_MAX_LINES. */
  maxLines?: number;
}

/** Line count matching `splitDiffLines` semantics without allocating the
 *  array — used by the budget probe so the skip-log path doesn't re-split
 *  multi-MB content that computeEditDiff already split and rejected. */
function countDiffLines(content: string): number {
  const text = String(content);
  if (text === '') return 0;
  let count = 1;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) count++;
  // Mirror splitDiffLines: a trailing newline does not open a final line.
  if (count > 1 && text.endsWith('\n')) count--;
  return count;
}

/** True when either side exceeds the per-file line budget — the same guard
 *  computeEditDiff applies internally. Exported so callers can tell the
 *  "too large to diff" null apart from the "no changes" null (and log it;
 *  see `edit_diff_skipped` in cli/tools.ts). */
export function overEditDiffLineBudget(before: string, after: string): boolean {
  return (
    countDiffLines(before) > EDIT_DIFF_MAX_FILE_LINES ||
    countDiffLines(after) > EDIT_DIFF_MAX_FILE_LINES
  );
}

/**
 * Stateful hunk-gap detector shared by the TUI card renderer and the
 * plain-text renderer. Feeding lines in order returns true when the line
 * starts a new hunk (skipped context between it and the previous line).
 *
 * Tracks the old- and new-file positions independently — comparing a
 * `del` row's oldLine against a prior `add` row's newLine (the previous
 * single-cursor heuristic) could miss a real gap after a deletion-heavy
 * hunk, where the next hunk's new-file numbers sit below the old-file
 * numbers already seen. A jump in either coordinate is a hunk boundary;
 * within a hunk each row advances its coordinate(s) by at most one.
 */
export function createEditDiffGapTracker(): (line: EditDiffLine) => boolean {
  let prevOld: number | null = null;
  let prevNew: number | null = null;
  return (line: EditDiffLine): boolean => {
    const oldJump = line.oldLine !== undefined && prevOld !== null && line.oldLine > prevOld + 1;
    const newJump = line.newLine !== undefined && prevNew !== null && line.newLine > prevNew + 1;
    if (line.oldLine !== undefined) prevOld = line.oldLine;
    if (line.newLine !== undefined) prevNew = line.newLine;
    return oldJump || newJump;
  };
}

/**
 * Compute the structured diff between two file contents.
 *
 * Returns `null` when there is nothing renderable: identical content, a
 * newline-at-EOF-only change, or a file too large to diff within budget
 * (callers log the skip — see the `edit_diff_skipped` line in cli/tools.ts).
 */
export function computeEditDiff(
  path: string,
  before: string,
  after: string,
  options: ComputeEditDiffOptions = {},
): EditDiff | null {
  const maxLines = Math.max(1, options.maxLines ?? EDIT_DIFF_MAX_LINES);
  const oldLines = splitDiffLines(before);
  const newLines = splitDiffLines(after);
  if (oldLines.length > EDIT_DIFF_MAX_FILE_LINES || newLines.length > EDIT_DIFF_MAX_FILE_LINES) {
    return null;
  }

  const regions = computeChangeRegions(oldLines, newLines);
  if (regions.length === 0) return null;

  let adds = 0;
  let dels = 0;
  for (const region of regions) {
    adds += region.newCount;
    dels += region.oldCount;
  }

  const lines: EditDiffLine[] = [];
  let truncated = false;
  const pushLine = (line: EditDiffLine): boolean => {
    if (lines.length >= maxLines) {
      truncated = true;
      return false;
    }
    lines.push(line);
    return true;
  };
  const pushContent = (kind: EditDiffLineKind, raw: string, oldNo?: number, newNo?: number) => {
    const { text, textTruncated } = scrubLine(raw);
    return pushLine({
      kind,
      ...(oldNo !== undefined ? { oldLine: oldNo } : {}),
      ...(newNo !== undefined ? { newLine: newNo } : {}),
      text,
      ...(textTruncated ? { textTruncated: true } : {}),
    });
  };

  // Emit hunks: leading context, dels, adds, trailing context. Consecutive
  // regions whose context windows touch simply merge by continuing line
  // numbers; the renderer detects gaps via number jumps.
  let lastEmittedOld = 0; // 1-based old line number already covered
  outer: for (let r = 0; r < regions.length; r++) {
    const region = regions[r];
    // Trailing context must stop before the next region's first changed old
    // line — regions can sit one matching line apart, and running past that
    // boundary would emit the next region's deletions as context here and
    // again as `del` on the next iteration.
    const nextChangeOld = r + 1 < regions.length ? regions[r + 1].oldStart : oldLines.length;
    const ctxStart = Math.max(lastEmittedOld, region.oldStart - EDIT_DIFF_CONTEXT_LINES);
    for (let k = ctxStart; k < region.oldStart; k++) {
      const newNo = k + (region.newStart - region.oldStart) + 1;
      if (!pushContent('ctx', oldLines[k], k + 1, newNo)) break outer;
    }
    for (let k = 0; k < region.oldCount; k++) {
      const oldNo = region.oldStart + k + 1;
      if (!pushContent('del', oldLines[region.oldStart + k], oldNo, undefined)) break outer;
    }
    for (let k = 0; k < region.newCount; k++) {
      const newNo = region.newStart + k + 1;
      if (!pushContent('add', newLines[region.newStart + k], undefined, newNo)) break outer;
    }
    const trailEnd = Math.min(
      nextChangeOld,
      region.oldStart + region.oldCount + EDIT_DIFF_CONTEXT_LINES,
    );
    for (let k = region.oldStart + region.oldCount; k < trailEnd; k++) {
      const newNo = k + (region.newStart + region.newCount - region.oldStart - region.oldCount) + 1;
      if (!pushContent('ctx', oldLines[k], k + 1, newNo)) break outer;
    }
    lastEmittedOld = trailEnd;
  }

  return {
    path,
    adds,
    dels,
    lines,
    ...(truncated ? { truncated: true } : {}),
  };
}

/**
 * Plain-text rendering of an EditDiff for the *model-visible* tool result
 * (the TUI has its own styled renderer in cli/tui-framers.ts). Line shape
 * mirrors the `N| text` convention edit_file's context preview already
 * uses, with a +/- marker column for changed lines and `---` rows where
 * hunks skip lines:
 *
 *   1 -| /remote setup <deployment-url>
 *   1 +| /remote setup [<deployment-url>]
 *   2  | Enable relay
 *
 * Bounded by `maxLines` on top of the diff's own caps so a full-file
 * rewrite doesn't flood the model's context.
 */
export function renderEditDiffText(diff: EditDiff, options: { maxLines?: number } = {}): string {
  const maxLines = Math.max(1, options.maxLines ?? diff.lines.length);
  const shown = diff.lines.slice(0, maxLines);
  const out: string[] = [];
  const startsNewHunk = createEditDiffGapTracker();
  for (const line of shown) {
    const num = line.kind === 'del' ? line.oldLine : (line.newLine ?? line.oldLine);
    if (startsNewHunk(line)) out.push('---');
    const marker = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
    const suffix = line.textTruncated ? '…' : '';
    out.push(`${num ?? ''} ${marker}| ${line.text}${suffix}`);
  }
  if (diff.truncated || shown.length < diff.lines.length) {
    out.push(`... (diff truncated; totals: +${diff.adds} -${diff.dels})`);
  }
  return out.join('\n');
}

/** Loose runtime guard for an EditDiff arriving off the wire (run events
 *  cross the daemon WebSocket as JSON). Deep-validates far enough that the
 *  renderer can trust field types without re-checking per line. */
export function isEditDiff(value: unknown): value is EditDiff {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const d = value as Record<string, unknown>;
  if (typeof d.path !== 'string' || !d.path) return false;
  if (typeof d.adds !== 'number' || !Number.isFinite(d.adds)) return false;
  if (typeof d.dels !== 'number' || !Number.isFinite(d.dels)) return false;
  if (!Array.isArray(d.lines)) return false;
  for (const line of d.lines) {
    if (!line || typeof line !== 'object') return false;
    const l = line as Record<string, unknown>;
    if (l.kind !== 'add' && l.kind !== 'del' && l.kind !== 'ctx') return false;
    if (typeof l.text !== 'string') return false;
    if (l.oldLine !== undefined && typeof l.oldLine !== 'number') return false;
    if (l.newLine !== undefined && typeof l.newLine !== 'number') return false;
  }
  return true;
}
