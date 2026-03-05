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

/** Kind of symbol read from a file. */
export type SymbolKind = 'function' | 'class' | 'interface' | 'export' | 'type';

/**
 * A symbol (function, class, interface, export) that the model has read.
 * Used for semantic edit guard - we can block edits to symbols never read.
 */
export interface SymbolRead {
  name: string;
  kind: SymbolKind;
  lineRange: LineRange;
}

export type FileState =
  | { kind: 'never_read' }
  | { kind: 'partial_read'; ranges: LineRange[]; symbols: SymbolRead[] }
  | { kind: 'fully_read'; readAtRound: number; symbols?: SymbolRead[] }
  | { kind: 'model_authored'; createdAtRound: number }
  | { kind: 'stale'; previousState: Exclude<FileState, { kind: 'stale' }>; staleSinceRound: number };

export type EditGuardVerdict =
  | { allowed: true }
  | { allowed: false; reason: string };

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export interface EditGuardMetrics {
  checksTotal: number;
  allowedTotal: number;
  blockedTotal: number;
  blockedByNeverRead: number;
  blockedByPartialRead: number;
  blockedByUnknownSymbol: number;
  autoExpandAttempts: number;
  autoExpandSuccesses: number;
  symbolsReadTotal: number;
  symbolBlocks: number;
  symbolAutoExpands: number;
}

function emptyMetrics(): EditGuardMetrics {
  return {
    checksTotal: 0,
    allowedTotal: 0,
    blockedTotal: 0,
    blockedByNeverRead: 0,
    blockedByPartialRead: 0,
    blockedByUnknownSymbol: 0,
    autoExpandAttempts: 0,
    autoExpandSuccesses: 0,
    symbolsReadTotal: 0,
    symbolBlocks: 0,
    symbolAutoExpands: 0,
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

// ---------------------------------------------------------------------------
// Signature extraction
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
  const seen = new Set<string>();
  const hits: string[] = [];
  for (const pattern of SIGNATURE_PATTERNS) {
    // Reset lastIndex for each use (patterns have /g flag)
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const full = match[0].trim();
      if (full && !seen.has(full)) {
        seen.add(full);
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

/**
 * Extract structural signatures from content WITH line numbers.
 * Used to populate the ledger with symbol information for semantic edit guard.
 */
export function extractSignaturesWithLines(content: string, contentStartLine: number = 1): SymbolRead[] {
  const symbols: SymbolRead[] = [];
  const seen = new Set<string>(); // deduplicate by name+kind

  // Pattern definitions with their kind and regex (allow leading whitespace like SIGNATURE_PATTERNS)
  const patternDefs = [
    { kind: 'function' as SymbolKind, regex: /^[ \t]*(?:export\s+)?(?:async\s+)?function\s+(\w+)/ },
    { kind: 'class' as SymbolKind, regex: /^[ \t]*(?:export\s+)?class\s+(\w+)/ },
    { kind: 'interface' as SymbolKind, regex: /^[ \t]*(?:export\s+)?interface\s+(\w+)/ },
    { kind: 'type' as SymbolKind, regex: /^[ \t]*(?:export\s+)?type\s+(\w+)\s*=/ },
    { kind: 'export' as SymbolKind, regex: /^[ \t]*export\s+default\s+(?:function\s+)?(\w+)?/ },
    { kind: 'function' as SymbolKind, regex: /^[ \t]*def\s+(\w+)/ },
    { kind: 'class' as SymbolKind, regex: /^[ \t]*class\s+(\w+)\s*[:(]/ },
  ];

  const lines = content.split('\n');
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    const lineNumber = contentStartLine + lineIdx;

    for (const { kind, regex } of patternDefs) {
      const match = line.match(regex);
      if (match && match[1]) {
        const name = match[1];
        const key = `${kind}:${name}`;
        if (!seen.has(key)) {
          seen.add(key);
          symbols.push({
            name,
            kind,
            lineRange: { start: lineNumber, end: lineNumber },
          });
        }
      }
    }
  }

  return symbols;
}

/**
 * Deduplicate symbols by name + kind.
 */
function deduplicateSymbols(symbols: SymbolRead[]): SymbolRead[] {
  const seen = new Set<string>();
  const unique: SymbolRead[] = [];
  for (const sym of symbols) {
    const key = `${sym.kind}:${sym.name}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(sym);
    }
  }
  return unique;
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
      symbols?: SymbolRead[];
    } = {},
  ): void {
    const key = this.normalizePath(path);
    const existing = this.entries.get(key);

    // If model authored this file, keep that state (it knows the full content)
    if (existing?.kind === 'model_authored') return;

    // Unwrap stale state — a fresh read cures staleness
    const base = existing?.kind === 'stale' ? existing.previousState : existing;

    const isFullRead = !opts.startLine && !opts.endLine && !opts.truncated;
    const newSymbols = deduplicateSymbols(opts.symbols ?? []);

    // Update symbol metrics
    if (newSymbols.length > 0) {
      this._metrics.symbolsReadTotal += newSymbols.length;
    }

    if (isFullRead) {
      this.entries.set(key, { 
        kind: 'fully_read', 
        readAtRound: this.currentRound,
        symbols: newSymbols.length > 0 ? newSymbols : undefined,
      });
      return;
    }

    // Range or truncated read — compute the range covered
    const start = opts.startLine ?? 1;
    const end = opts.endLine ?? (opts.totalLines ?? 999_999);

    const newRange: LineRange = { start, end };

    if (base?.kind === 'partial_read') {
      const combined = mergeRanges([...base.ranges, newRange]);
      const combinedSymbols = deduplicateSymbols([...base.symbols, ...newSymbols]);
      this.entries.set(key, { 
        kind: 'partial_read', 
        ranges: combined,
        symbols: combinedSymbols,
      });
    } else if (base?.kind === 'fully_read') {
      // Already fully read — no downgrade, but merge symbols if provided
      if (newSymbols.length > 0) {
        const existingSymbols = base.symbols ?? [];
        const mergedSymbols = deduplicateSymbols([...existingSymbols, ...newSymbols]);
        this.entries.set(key, { 
          kind: 'fully_read', 
          readAtRound: base.readAtRound,
          symbols: mergedSymbols,
        });
      }
      return;
    } else {
      this.entries.set(key, { 
        kind: 'partial_read', 
        ranges: [newRange],
        symbols: newSymbols,
      });
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
   * For sandbox_write_file (which replaces the entire file), we check
   * whether the model has read the file at all.
   */
  checkWriteAllowed(path: string): EditGuardVerdict {
    this._metrics.checksTotal++;
    const key = this.normalizePath(path);
    const entry = this.entries.get(key);

    if (!entry || entry.kind === 'never_read') {
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
        this._metrics.blockedTotal++;
        this._metrics.blockedByPartialRead++;
        return {
          allowed: false,
          reason: `File "${path}" was only partially read. Read the full file (or the remaining ranges) with sandbox_read_file before writing.`,
        };

      default:
        this._metrics.allowedTotal++;
        return { allowed: true };
    }
  }

  /**
   * Extract symbols that an edit touches from the edit content.
   */
  private extractSymbolsFromEdit(editContent: string): { name: string; kind: SymbolKind }[] {
    const touched: { name: string; kind: SymbolKind }[] = [];
    const seen = new Set<string>();

    const editPatterns = [
      { kind: 'function' as SymbolKind, regex: /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g },
      { kind: 'class' as SymbolKind, regex: /(?:export\s+)?class\s+(\w+)/g },
      { kind: 'interface' as SymbolKind, regex: /(?:export\s+)?interface\s+(\w+)/g },
      { kind: 'type' as SymbolKind, regex: /(?:export\s+)?type\s+(\w+)\s*=/g },
      { kind: 'export' as SymbolKind, regex: /export\s+default\s+(?:function\s+)?(\w+)/g },
      { kind: 'function' as SymbolKind, regex: /def\s+(\w+)/g },
      { kind: 'class' as SymbolKind, regex: /class\s+(\w+)\s*[:(]/g },
    ];

    for (const { kind, regex } of editPatterns) {
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(editContent)) !== null) {
        if (match[1]) {
          const key = `${kind}:${match[1]}`;
          if (!seen.has(key)) {
            seen.add(key);
            touched.push({ name: match[1], kind });
          }
        }
      }
    }

    return touched;
  }

  /**
   * Check if an edit is allowed based on symbols the model has read.
   * Falls back to line-based check if no symbols detected in edit.
   */
  checkSymbolicEditAllowed(path: string, editContent: string): EditGuardVerdict {
    const key = this.normalizePath(path);
    const entry = this.entries.get(key);

    // No ledger entry or never_read - delegate fully (checkWriteAllowed counts its own metrics)
    if (!entry || entry.kind === 'never_read') {
      return this.checkWriteAllowed(path);
    }

    // Unwrap stale
    const base = entry.kind === 'stale' ? entry.previousState : entry;

    // Get symbols the model has read
    let readSymbols: SymbolRead[] = [];
    if (base.kind === 'partial_read') {
      readSymbols = base.symbols;
    } else if (base.kind === 'fully_read') {
      readSymbols = base.symbols ?? [];
    } else if (base.kind === 'model_authored') {
      this._metrics.allowedTotal++;
      return { allowed: true };
    }

    // Extract symbols from the edit content
    const editSymbols = this.extractSymbolsFromEdit(editContent);

    // If no symbols in edit, fall back to line-based check
    if (editSymbols.length === 0) {
      return this.checkWriteAllowed(path);
    }

    // Count this check now (not double-counted — checkWriteAllowed fallbacks above handle their own)
    this._metrics.checksTotal++;

    // Check if all edit symbols have been read (match by name+kind for precision)
    const readSymbolKeys = new Set(readSymbols.map(s => `${s.kind}:${s.name}`));
    const unknownSymbols: string[] = [];

    for (const editSym of editSymbols) {
      const editKey = `${editSym.kind}:${editSym.name}`;
      if (!readSymbolKeys.has(editKey)) {
        unknownSymbols.push(editSym.name);
      }
    }

    if (unknownSymbols.length > 0) {
      this._metrics.blockedTotal++;
      this._metrics.blockedByUnknownSymbol++;
      this._metrics.symbolBlocks++;
      return {
        allowed: false,
        reason: `Read symbol '${unknownSymbols[0]}' before editing. Use sandbox_read_file to read the file first.`,
      };
    }

    this._metrics.allowedTotal++;
    return { allowed: true };
  }

  /**
   * Get the stale warning for a file, if applicable.
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

  /** Get a concise summary of currently fresh (non-stale) file context. */
  getAwarenessSummary(): string | null {
    const parts: string[] = [];
    for (const [path, state] of this.entries.entries()) {
      if (state.kind === 'fully_read') {
        parts.push(`${path} (full)`);
      } else if (state.kind === 'model_authored') {
        parts.push(`${path} (authored)`);
      } else if (state.kind === 'partial_read') {
        const rangeStr = state.ranges.map(r => `${r.start}-${r.end}`).join(', ');
        parts.push(`${path} (lines ${rangeStr})`);
      }
    }
    if (parts.length === 0) return null;
    return `Fresh context for: ${parts.join(', ')}`;
  }

  getState(path: string): FileState | undefined {
    return this.entries.get(this.normalizePath(path));
  }

  /** Check if the ledger has any entry for the given path. */
  hasEntry(path: string): boolean {
    return this.entries.has(this.normalizePath(path));
  }

  /**
   * Register a file as existing (seen in a listing, search, etc.)
   * without recording a read.
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

  /** Record a symbol-based auto-expand. */
  recordSymbolAutoExpand(): void {
    this._metrics.symbolAutoExpands++;
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
