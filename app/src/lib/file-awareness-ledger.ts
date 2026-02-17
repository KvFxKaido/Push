/**
 * File Awareness Ledger — tracks what the model has actually seen of each file.
 *
 * Part of the Truncation-Aware Edit Safety system (Harness Reliability Track B).
 *
 * The ledger is a per-session, harness-level data structure that persists across
 * Orchestrator → Coder handoffs. An edit guard checks the ledger before allowing
 * writes, blocking edits to lines the model never read.
 *
 * Ledger states per file:
 *   never_read   — file exists but model hasn't read it
 *   partial_read  — model has seen specific line ranges (additive)
 *   fully_read    — model has seen the complete file
 *   model_authored — model created this file in the current session
 *   stale          — file modified since last model read
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Inclusive line range [start, end], 1-indexed. */
export interface LineRange {
  start: number;
  end: number;
}

export type FileState =
  | { kind: 'never_read' }
  | { kind: 'partial_read'; ranges: LineRange[] }
  | { kind: 'fully_read'; readAtRound: number }
  | { kind: 'model_authored'; createdAtRound: number }
  | { kind: 'stale'; previousState: Exclude<FileState, { kind: 'stale' }>; staleSinceRound: number };

export type EditGuardVerdict =
  | { allowed: true }
  | { allowed: false; reason: string; missingRanges?: LineRange[] };

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export interface EditGuardMetrics {
  checksTotal: number;
  allowedTotal: number;
  blockedTotal: number;
  blockedByNeverRead: number;
  blockedByPartialRead: number;
  autoExpandAttempts: number;
  autoExpandSuccesses: number;
}

function emptyMetrics(): EditGuardMetrics {
  return {
    checksTotal: 0,
    allowedTotal: 0,
    blockedTotal: 0,
    blockedByNeverRead: 0,
    blockedByPartialRead: 0,
    autoExpandAttempts: 0,
    autoExpandSuccesses: 0,
  };
}

// ---------------------------------------------------------------------------
// Range utilities
// ---------------------------------------------------------------------------

/** Sort ranges by start, then merge overlapping/adjacent ones. */
function mergeRanges(ranges: LineRange[]): LineRange[] {
  if (ranges.length <= 1) return ranges;
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: LineRange[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    const cur = sorted[i];
    // Adjacent or overlapping — merge (end+1 >= start covers adjacency)
    if (cur.start <= last.end + 1) {
      last.end = Math.max(last.end, cur.end);
    } else {
      merged.push({ ...cur });
    }
  }
  return merged;
}

/**
 * Check whether `ranges` fully cover `[targetStart, targetEnd]`.
 * Returns uncovered sub-ranges, or empty array if fully covered.
 */
function findUncoveredRanges(
  ranges: LineRange[],
  targetStart: number,
  targetEnd: number,
): LineRange[] {
  const merged = mergeRanges(ranges);
  const uncovered: LineRange[] = [];
  let cursor = targetStart;

  for (const r of merged) {
    if (r.start > cursor) {
      // Gap before this range
      uncovered.push({ start: cursor, end: Math.min(r.start - 1, targetEnd) });
    }
    cursor = Math.max(cursor, r.end + 1);
    if (cursor > targetEnd) break;
  }

  if (cursor <= targetEnd) {
    uncovered.push({ start: cursor, end: targetEnd });
  }

  return uncovered;
}

// ---------------------------------------------------------------------------
// Signature extraction (Phase 2)
// ---------------------------------------------------------------------------

/** Language-agnostic regex patterns for structural signatures. */
const SIGNATURE_PATTERNS: RegExp[] = [
  /^[ \t]*(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm,         // JS/TS functions
  /^[ \t]*(?:export\s+)?class\s+(\w+)/gm,                          // JS/TS classes
  /^[ \t]*(?:export\s+)?interface\s+(\w+)/gm,                      // TS interfaces
  /^[ \t]*(?:export\s+)?type\s+(\w+)\s*=/gm,                       // TS type aliases
  /^[ \t]*export\s+default\s+(?:function\s+)?(\w+)?/gm,            // default exports
  /^[ \t]*def\s+(\w+)/gm,                                           // Python functions
  /^[ \t]*class\s+(\w+)\s*[:(]/gm,                                  // Python classes
];

/**
 * Extract structural signatures from a block of source code.
 * Returns a compact summary string, or null if nothing found.
 *
 * Not a parser — regex-based, ~70% accurate. Value: the model can make
 * a targeted range read on the first try instead of guessing.
 */
export function extractSignatures(content: string): string | null {
  const hits: string[] = [];
  for (const pattern of SIGNATURE_PATTERNS) {
    // Reset lastIndex for each use (patterns have /g flag)
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const full = match[0].trim();
      if (full && !hits.includes(full)) {
        hits.push(full);
      }
    }
  }
  if (hits.length === 0) return null;
  // Cap at 8 signatures to keep the notice compact
  const capped = hits.slice(0, 8);
  const suffix = hits.length > 8 ? `, +${hits.length - 8} more` : '';
  return `contains: ${capped.join(', ')}${suffix}`;
}

// ---------------------------------------------------------------------------
// Ledger class
// ---------------------------------------------------------------------------

export class FileAwarenessLedger {
  private entries = new Map<string, FileState>();
  private currentRound = 0;
  private _metrics: EditGuardMetrics = emptyMetrics();

  /** Normalize paths for consistent lookup (strip leading /workspace/). */
  private normalizePath(path: string): string {
    return path.replace(/^\/workspace\//, '');
  }

  /** Advance the round counter (called each tool-loop iteration). */
  advanceRound(): void {
    this.currentRound++;
  }

  getRound(): number {
    return this.currentRound;
  }

  // -----------------------------------------------------------------------
  // Recording reads
  // -----------------------------------------------------------------------

  /**
   * Record that the model has read a file (or a range of it).
   * Range tracking is additive — multiple reads accumulate coverage.
   */
  recordRead(
    path: string,
    opts: {
      startLine?: number;
      endLine?: number;
      truncated?: boolean;
      totalLines?: number;
    } = {},
  ): void {
    const key = this.normalizePath(path);
    const existing = this.entries.get(key);

    // If model authored this file, keep that state (it knows the full content)
    if (existing?.kind === 'model_authored') return;

    // Unwrap stale state — a fresh read cures staleness
    const base = existing?.kind === 'stale' ? existing.previousState : existing;

    const isFullRead = !opts.startLine && !opts.endLine && !opts.truncated;

    if (isFullRead) {
      this.entries.set(key, { kind: 'fully_read', readAtRound: this.currentRound });
      return;
    }

    // Range or truncated read — compute the range covered
    const start = opts.startLine ?? 1;
    // For truncated full reads, we don't know the actual end — estimate from content
    // For range reads, use the requested end (or a large sentinel)
    const end = opts.endLine ?? (opts.totalLines ?? 999_999);

    const newRange: LineRange = { start, end };

    if (base?.kind === 'partial_read') {
      const combined = mergeRanges([...base.ranges, newRange]);
      this.entries.set(key, { kind: 'partial_read', ranges: combined });
    } else if (base?.kind === 'fully_read') {
      // Already fully read — no downgrade
      return;
    } else {
      this.entries.set(key, { kind: 'partial_read', ranges: [newRange] });
    }
  }

  /**
   * Record that the model created a new file (always allowed for edits).
   */
  recordCreation(path: string): void {
    const key = this.normalizePath(path);
    this.entries.set(key, { kind: 'model_authored', createdAtRound: this.currentRound });
  }

  /**
   * Record that a file was modified externally (e.g. by sandbox_exec).
   * Marks the file as stale so the model gets a soft warning.
   */
  markStale(path: string): void {
    const key = this.normalizePath(path);
    const existing = this.entries.get(key);
    if (!existing || existing.kind === 'never_read' || existing.kind === 'stale') return;
    this.entries.set(key, {
      kind: 'stale',
      previousState: existing as Exclude<FileState, { kind: 'stale' }>,
      staleSinceRound: this.currentRound,
    });
  }

  // -----------------------------------------------------------------------
  // Edit guard
  // -----------------------------------------------------------------------

  /**
   * Check whether the model has sufficient read coverage to edit a file.
   *
   * For sandbox_write_file (which replaces the entire file), we check
   * whether the model has read the file at all. The model needs to have
   * seen the file to produce a correct replacement.
   */
  checkWriteAllowed(path: string): EditGuardVerdict {
    this._metrics.checksTotal++;
    const key = this.normalizePath(path);
    const entry = this.entries.get(key);

    // New file creation — always allowed
    if (!entry || entry.kind === 'never_read') {
      // If the file doesn't exist in the ledger at all, it's likely a new file.
      // But if the entry is explicitly never_read, the file exists but wasn't read.
      if (!entry) {
        this._metrics.allowedTotal++;
        return { allowed: true };
      }
      // File exists but was never read — block
      this._metrics.blockedTotal++;
      this._metrics.blockedByNeverRead++;
      return {
        allowed: false,
        reason: `File "${path}" has not been read yet. Use sandbox_read_file to read it before writing.`,
      };
    }

    // Unwrap stale for guard purposes (stale is a warning, not a block)
    const base = entry.kind === 'stale' ? entry.previousState : entry;

    switch (base.kind) {
      case 'fully_read':
      case 'model_authored':
        this._metrics.allowedTotal++;
        return { allowed: true };

      case 'partial_read':
        // For whole-file writes, partial read is risky — the model may be
        // improvising content it never saw. Block with guidance.
        this._metrics.blockedTotal++;
        this._metrics.blockedByPartialRead++;
        return {
          allowed: false,
          reason: `File "${path}" was only partially read. Read the full file (or the remaining ranges) with sandbox_read_file before writing.`,
          missingRanges: undefined, // We don't know total file length for whole-file writes
        };

      default:
        this._metrics.allowedTotal++;
        return { allowed: true };
    }
  }

  /**
   * Get the stale warning for a file, if applicable.
   * Returns a warning string or null.
   */
  getStaleWarning(path: string): string | null {
    const key = this.normalizePath(path);
    const entry = this.entries.get(key);
    if (entry?.kind !== 'stale') return null;
    const roundsAgo = this.currentRound - entry.staleSinceRound;
    return `Warning: You last saw "${path}" ${roundsAgo} round(s) ago; it may have changed since then. Consider re-reading before editing.`;
  }

  // -----------------------------------------------------------------------
  // State inspection
  // -----------------------------------------------------------------------

  getState(path: string): FileState | undefined {
    return this.entries.get(this.normalizePath(path));
  }

  /** Check if the ledger has any entry for the given path. */
  hasEntry(path: string): boolean {
    return this.entries.has(this.normalizePath(path));
  }

  /**
   * Register a file as existing (seen in a listing, search, etc.)
   * without recording a read. Sets to never_read if not already tracked.
   */
  registerFile(path: string): void {
    const key = this.normalizePath(path);
    if (!this.entries.has(key)) {
      this.entries.set(key, { kind: 'never_read' });
    }
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /** Reset the ledger (on branch switch, sandbox teardown, etc.). */
  reset(): void {
    this.entries.clear();
    this.currentRound = 0;
    this._metrics = emptyMetrics();
  }

  /** Get current metrics snapshot. */
  getMetrics(): EditGuardMetrics {
    return { ...this._metrics };
  }

  /** Record an auto-expand attempt. */
  recordAutoExpandAttempt(): void {
    this._metrics.autoExpandAttempts++;
  }

  /** Record a successful auto-expand. */
  recordAutoExpandSuccess(): void {
    this._metrics.autoExpandSuccesses++;
  }

  /** Get number of tracked files. */
  get size(): number {
    return this.entries.size;
  }
}

// ---------------------------------------------------------------------------
// Singleton instance (harness-level, persists across agent handoffs)
// ---------------------------------------------------------------------------

export const fileLedger = new FileAwarenessLedger();
