export interface FileLedgerEntry {
  status: 'never_read' | 'partial_read' | 'fully_read' | 'model_authored';
  reads: number;
  writes: number;
  updatedAt: number;
  relevance: number;  // search hit count — 0 means never appeared in search results
}

export interface ReadBudget {
  charsReadThisTurn: number;
  turnBudgetChars: number;       // soft cap, surfaced to model
  filesReadThisTurn: number;
}

export interface FileLedger {
  files: Record<string, FileLedgerEntry>;
  readBudget: ReadBudget;
}

interface ReadMeta {
  total_lines?: number | string;
  start_line?: number | string;
  end_line?: number | string;
  path?: string;
}

interface ToolCall {
  tool: string;
}

interface ToolResult {
  ok?: boolean;
  meta?: ReadMeta;
}

function getCoverage(meta: ReadMeta | undefined): 'partial_read' | 'fully_read' {
  const total = Number(meta?.total_lines || 0);
  const start = Number(meta?.start_line || 0);
  const end = Number(meta?.end_line || 0);

  if (!total || !start || !end) return 'partial_read';
  if (start <= 1 && end >= total) return 'fully_read';
  return 'partial_read';
}

const DEFAULT_TURN_BUDGET_CHARS = 80_000;

export function createFileLedger(): FileLedger {
  return {
    files: {},
    readBudget: { charsReadThisTurn: 0, turnBudgetChars: DEFAULT_TURN_BUDGET_CHARS, filesReadThisTurn: 0 },
  };
}

export function resetTurnBudget(ledger: FileLedger): void {
  ledger.readBudget.charsReadThisTurn = 0;
  ledger.readBudget.filesReadThisTurn = 0;
}

function ensureEntry(ledger: FileLedger, path: string): FileLedgerEntry {
  if (!ledger.files[path]) {
    ledger.files[path] = {
      status: 'never_read',
      reads: 0,
      writes: 0,
      updatedAt: Date.now(),
      relevance: 0,
    };
  }
  return ledger.files[path];
}

export function updateFileLedger(ledger: FileLedger, call: ToolCall, result: ToolResult): void {
  // Track search relevance: count matches per file from search_files results
  if (call.tool === 'search_files' && result.ok) {
    const text = (result as any).text || '';
    const fileHits = new Map<string, number>();
    for (const line of text.split('\n')) {
      // ripgrep format: "path/to/file:lineNum:content"
      const colonIdx = line.indexOf(':');
      if (colonIdx > 0) {
        const filePart = line.slice(0, colonIdx);
        if (filePart && !filePart.includes(' ')) {
          fileHits.set(filePart, (fileHits.get(filePart) || 0) + 1);
        }
      }
    }
    for (const [fp, count] of fileHits) {
      const entry = ensureEntry(ledger, fp);
      entry.relevance += count;
      entry.updatedAt = Date.now();
    }
    return;
  }

  const filePath = result?.meta?.path;
  if (!filePath) return;
  const entry = ensureEntry(ledger, filePath);

  if ((call.tool === 'read_file' || call.tool === 'read_symbol') && result.ok) {
    entry.reads += 1;
    entry.status = call.tool === 'read_symbol' ? 'partial_read' : getCoverage(result.meta);
    entry.updatedAt = Date.now();
    // Track read budget
    const chars = (result as any).text?.length || 0;
    ledger.readBudget.charsReadThisTurn += chars;
    ledger.readBudget.filesReadThisTurn += 1;
    return;
  }

  if ((call.tool === 'write_file' || call.tool === 'edit_file') && result.ok) {
    entry.writes += 1;
    entry.status = 'model_authored';
    entry.updatedAt = Date.now();
  }
}

export function getLedgerSummary(ledger: FileLedger): {
  total: number;
  readBudget: ReadBudget;
  files: Array<{ path: string; status: string; reads: number; writes: number; relevance: number }>;
} {
  const entries = Object.entries(ledger.files);
  // Sort by relevance (highest first) then by recency
  entries.sort(([, a], [, b]) => b.relevance - a.relevance || b.updatedAt - a.updatedAt);
  return {
    total: entries.length,
    readBudget: { ...ledger.readBudget },
    files: entries.map(([path, v]) => ({
      path,
      status: v.status,
      reads: v.reads,
      writes: v.writes,
      relevance: v.relevance,
    })),
  };
}
