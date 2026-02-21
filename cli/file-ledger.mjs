function getCoverage(meta) {
  const total = Number(meta?.total_lines || 0);
  const start = Number(meta?.start_line || 0);
  const end = Number(meta?.end_line || 0);

  if (!total || !start || !end) return 'partial_read';
  if (start <= 1 && end >= total) return 'fully_read';
  return 'partial_read';
}

export function createFileLedger() {
  return {
    files: {},
  };
}

function ensureEntry(ledger, path) {
  if (!ledger.files[path]) {
    ledger.files[path] = {
      status: 'never_read',
      reads: 0,
      writes: 0,
      updatedAt: Date.now(),
    };
  }
  return ledger.files[path];
}

export function updateFileLedger(ledger, call, result) {
  const filePath = result?.meta?.path;
  if (!filePath) return;
  const entry = ensureEntry(ledger, filePath);

  if (call.tool === 'read_file' && result.ok) {
    entry.reads += 1;
    entry.status = getCoverage(result.meta);
    entry.updatedAt = Date.now();
    return;
  }

  if ((call.tool === 'write_file' || call.tool === 'edit_file') && result.ok) {
    entry.writes += 1;
    entry.status = 'model_authored';
    entry.updatedAt = Date.now();
  }
}

export function getLedgerSummary(ledger) {
  const entries = Object.entries(ledger.files);
  return {
    total: entries.length,
    files: entries.map(([path, v]) => ({
      path,
      status: v.status,
      reads: v.reads,
      writes: v.writes,
    })),
  };
}
