/**
 * Comment Checker — deterministic pre-pass that flags low-signal comment
 * patterns on added lines of a unified diff.
 *
 * Runs before the Auditor so the LLM sees a precomputed [COMMENT CHECK] block
 * instead of rederiving hygiene issues. Separating the signal keeps the
 * Auditor focused on security and gives us a cheap, stable noise gate.
 *
 * High precision over recall: we flag patterns that strongly indicate
 * AI-generated narration (`// added X`, `// NEW:`, trivial docblocks) and
 * deliberately skip ambiguous cases like "comment restates the next line,"
 * which would produce too many false positives without semantic analysis.
 *
 * Comment dialects: line comments beginning with `//` (JS/TS/C/Go/Rust/Java)
 * and `#` (Python/Shell/Ruby). Block comments are out of scope — diff line
 * boundaries make them hard to reason about without a real parser.
 */

export type CommentCheckKind = 'operation-narration' | 'meta-artifact' | 'trivial-docblock';

export interface CommentFinding {
  path: string;
  /** The offending added line, trimmed, without the diff `+` marker. */
  line: string;
  kind: CommentCheckKind;
  reason: string;
}

export interface CommentCheckOptions {
  /** Cap on findings to prevent runaway reports on very large diffs. */
  maxFindings?: number;
}

const DEFAULT_MAX_FINDINGS = 20;

// ---------------------------------------------------------------------------
// Pattern tables
// ---------------------------------------------------------------------------

/**
 * Operation narration — the comment describes a mechanical edit rather than
 * intent. We exempt "by <name>" so legitimate attribution like "added by
 * John" is not flagged.
 */
const OPERATION_NARRATION_PATTERNS: RegExp[] = [
  /^(?:added?|adding)\b(?!\s+by\b)/i,
  /^(?:removed?|removing)\b(?!\s+by\b)/i,
  /^(?:changed?|changing)\b(?!\s+by\b)/i,
  /^(?:updated?|updating)\b(?!\s+by\b)/i,
  /^new\s*:/i,
  /^new\s*$/i,
  /^(?:fixed?|fixing)\s*:/i,
  /\btodo\(claude\)/i,
  /\bby\s+claude\b/i,
];

/** Meta artifacts — structural markers that only make sense as AI scaffolding. */
const META_ARTIFACT_PATTERNS: RegExp[] = [
  /^-{2,}\s*(?:begin|end|new code|modified|original)\b/i,
  /^\[AI\]/i,
  /^claude:/i,
];

/**
 * Trivial docblock openings — comments that restate the signature in English
 * rather than explaining intent. Gated on the comment being the whole line
 * (no code prefix) to keep precision high.
 */
const TRIVIAL_DOCBLOCK_PATTERNS: RegExp[] = [
  /^this\s+(?:function|method|class|component|module|file)\s+/i,
  /^(?:function|method|helper)\s+to\s+/i,
  /^helper\s+(?:function|method)\s+(?:to|that)\s+/i,
];

// ---------------------------------------------------------------------------
// Line parsing
// ---------------------------------------------------------------------------

/**
 * Extract the comment body from an added diff line, or null if the line is
 * not a pure comment. Inline trailing comments (`foo(); // added`) are
 * ignored for MVP because they are much more likely to be legitimate.
 */
function extractCommentBody(addedLine: string): string | null {
  // Drop the diff `+` prefix. Caller guarantees startsWith('+').
  const line = addedLine.slice(1);
  const trimmed = line.trimStart();
  if (trimmed.length === 0) return null;

  // `//` — must dominate the line (no code before it).
  if (trimmed.startsWith('//')) {
    return trimmed.slice(2).trim();
  }

  // `#` — exclude shebangs, preprocessor directives, and language markers.
  if (trimmed.startsWith('#')) {
    const directivePrefixes = [
      '#!',
      '#include',
      '#define',
      '#if',
      '#ifdef',
      '#ifndef',
      '#else',
      '#elif',
      '#endif',
      '#pragma',
      '#region',
      '#endregion',
      '#undef',
    ];
    if (directivePrefixes.some((p) => trimmed.startsWith(p))) return null;
    return trimmed.slice(1).trim();
  }

  return null;
}

function classifyCommentBody(body: string): CommentCheckKind | null {
  if (body.length === 0) return null;
  for (const re of OPERATION_NARRATION_PATTERNS) {
    if (re.test(body)) return 'operation-narration';
  }
  for (const re of META_ARTIFACT_PATTERNS) {
    if (re.test(body)) return 'meta-artifact';
  }
  for (const re of TRIVIAL_DOCBLOCK_PATTERNS) {
    if (re.test(body)) return 'trivial-docblock';
  }
  return null;
}

function reasonFor(kind: CommentCheckKind): string {
  switch (kind) {
    case 'operation-narration':
      return 'Comment narrates a code operation instead of explaining intent.';
    case 'meta-artifact':
      return 'Comment looks like an AI scaffolding marker.';
    case 'trivial-docblock':
      return 'Docblock restates the signature instead of explaining intent.';
  }
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * Scan a unified diff and return findings for low-signal comments on added
 * lines. Deterministic, no IO.
 */
export function detectAiCommentPatterns(
  diff: string,
  options: CommentCheckOptions = {},
): CommentFinding[] {
  const maxFindings = options.maxFindings ?? DEFAULT_MAX_FINDINGS;
  const findings: CommentFinding[] = [];

  let currentPath: string | null = null;

  for (const raw of diff.split('\n')) {
    if (findings.length >= maxFindings) break;

    if (raw.startsWith('diff --git')) {
      const match = raw.match(/b\/(.+)$/);
      currentPath = match ? match[1] : null;
      continue;
    }

    // Skip diff headers, hunk headers, and non-added lines.
    if (raw.startsWith('+++') || raw.startsWith('---')) continue;
    if (raw.startsWith('@@')) continue;
    if (!raw.startsWith('+')) continue;

    const body = extractCommentBody(raw);
    if (body === null) continue;

    const kind = classifyCommentBody(body);
    if (kind === null) continue;

    findings.push({
      path: currentPath ?? 'unknown',
      line: raw.slice(1).trim(),
      kind,
      reason: reasonFor(kind),
    });
  }

  return findings;
}

/**
 * Render findings as a `[COMMENT CHECK]` block for inclusion in the Auditor's
 * user message. Returns an empty string when there is nothing to report so
 * callers can concatenate unconditionally.
 */
export function formatCommentCheckBlock(findings: CommentFinding[]): string {
  if (findings.length === 0) return '';
  const lines = findings.map((f) => `- ${f.path}: ${f.reason}\n    ${f.line}`);
  return [
    '[COMMENT CHECK]',
    `Deterministic pre-pass flagged ${findings.length} added comment(s) as potential AI noise.`,
    'Treat each as a LOW-risk hygiene item unless it explains non-obvious intent.',
    'Do not flip the verdict to UNSAFE based on comment noise alone.',
    ...lines,
    '[/COMMENT CHECK]',
  ].join('\n');
}
