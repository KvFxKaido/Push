import { createHash } from 'node:crypto';

function sha1(input) {
  return createHash('sha1').update(input).digest('hex');
}

export function calculateLineHash(line) {
  return sha1(String(line)).slice(0, 7);
}

export function calculateContentVersion(content) {
  return sha1(String(content)).slice(0, 12);
}

function parseRef(ref) {
  const raw = String(ref || '').trim();
  if (!raw) throw new Error('ref is required');

  // Supported forms:
  // - "abc1234"
  // - "12:abc1234"
  // - "12|abc1234"
  const m = raw.match(/^(?:(\d+)[:|])?([a-f0-9]{7,40})$/i);
  if (!m) throw new Error(`invalid ref format: ${raw}`);
  const lineNo = m[1] ? Number(m[1]) : null;
  const hash = m[2].slice(0, 7).toLowerCase();
  return { lineNo, hash };
}

function computeLineHashes(lines) {
  return lines.map((line) => calculateLineHash(line));
}

function resolveLineRef(lines, ref) {
  const { lineNo, hash } = parseRef(ref);
  const hashes = computeLineHashes(lines);

  if (lineNo !== null) {
    const idx = lineNo - 1;
    if (idx < 0 || idx >= lines.length) {
      throw new Error(`stale ref: line ${lineNo} is out of range`);
    }
    if (hashes[idx] !== hash) {
      throw new Error(`stale ref at line ${lineNo}: expected ${hash}, found ${hashes[idx]}`);
    }
    return idx;
  }

  const matches = [];
  for (let i = 0; i < hashes.length; i++) {
    if (hashes[i] === hash) matches.push(i);
  }
  if (matches.length === 0) {
    throw new Error(`stale ref: ${hash} not found`);
  }
  if (matches.length > 1) {
    throw new Error(`ambiguous ref: ${hash} matched ${matches.length} lines; use line-qualified ref like "12:${hash}"`);
  }
  return matches[0];
}

export function renderAnchoredRange(content, startLine = 1, endLine = null) {
  const lines = String(content).split(/\r?\n/);
  const totalLines = lines.length || 1;
  const start = Math.max(1, Math.min(Number(startLine) || 1, totalLines));
  const end = Math.max(start, Math.min(Number(endLine) || totalLines, totalLines));
  const hashes = computeLineHashes(lines);

  const out = [];
  for (let i = start - 1; i < end; i++) {
    out.push(`${i + 1}|${hashes[i]}| ${lines[i]}`);
  }

  return {
    text: out.join('\n') || '<empty file>',
    startLine: start,
    endLine: end,
    totalLines,
  };
}

export function applyHashlineEdits(content, edits) {
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new Error('edits must be a non-empty array');
  }

  const lines = String(content).split(/\r?\n/);
  const applied = [];

  for (const rawEdit of edits) {
    const edit = rawEdit && typeof rawEdit === 'object' ? rawEdit : null;
    if (!edit) throw new Error('invalid edit object');
    const op = String(edit.op || '').trim();
    const ref = String(edit.ref || '').trim();

    if (!op) throw new Error('edit.op is required');
    if (!ref) throw new Error('edit.ref is required');

    const idx = resolveLineRef(lines, ref);

    if (op === 'replace_line') {
      if (typeof edit.content !== 'string') throw new Error('replace_line requires string content');
      lines[idx] = edit.content;
      applied.push({ op, line: idx + 1 });
      continue;
    }

    if (op === 'delete_line') {
      lines.splice(idx, 1);
      applied.push({ op, line: idx + 1 });
      continue;
    }

    if (op === 'insert_after') {
      if (typeof edit.content !== 'string') throw new Error('insert_after requires string content');
      lines.splice(idx + 1, 0, edit.content);
      applied.push({ op, line: idx + 2 });
      continue;
    }

    if (op === 'insert_before') {
      if (typeof edit.content !== 'string') throw new Error('insert_before requires string content');
      lines.splice(idx, 0, edit.content);
      applied.push({ op, line: idx + 1 });
      continue;
    }

    throw new Error(`unsupported edit op: ${op}`);
  }

  return {
    content: lines.join('\n'),
    applied,
  };
}
