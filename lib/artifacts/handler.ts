/**
 * Pure handler for the `create_artifact` tool.
 *
 * Validates a model-supplied `CreateArtifactArgs` shape, then constructs
 * a fully-formed `ArtifactRecord` with `id`, `scope`, `author`, and
 * timestamps stamped by the runtime. No persistence here — surface
 * dispatch (web worker route, CLI tool exec) calls this and then hands
 * the record to its store.
 *
 * Validation is structural, not semantic: we check that required fields
 * exist and have plausible types/sizes, but don't try to parse the file
 * content or run the React code. Bad code crashes at render time, which
 * is the renderer's job.
 *
 * Live-preview is not handled here — `create_live_preview` is a sibling
 * tool because the runtime, not the model, supplies sandbox-side fields.
 */

import { createId } from '../id-utils.js';
import type {
  ArtifactAuthor,
  ArtifactFile,
  ArtifactRecord,
  ArtifactScope,
  CreateArtifactArgs,
} from './types.js';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Caps on payload size — reject up front rather than blow up the store. */
const MAX_TITLE_CHARS = 200;
const MAX_FILES_PER_ARTIFACT = 64;
const MAX_FILE_BYTES = 256 * 1024; // 256 KiB per file
const MAX_TOTAL_BYTES = 1024 * 1024; // 1 MiB total per artifact
const MAX_MERMAID_CHARS = 64 * 1024; // 64 KiB
const MAX_DEPENDENCY_COUNT = 32;

export type ArtifactValidationFailure = {
  ok: false;
  code:
    | 'MISSING_FIELD'
    | 'INVALID_KIND'
    | 'INVALID_TYPE'
    | 'TOO_LARGE'
    | 'TOO_MANY_FILES'
    | 'EMPTY_FILES'
    | 'DUPLICATE_FILE_PATH';
  field: string;
  message: string;
};

export type ArtifactValidationSuccess = {
  ok: true;
  args: CreateArtifactArgs;
};

export type ArtifactValidationResult = ArtifactValidationSuccess | ArtifactValidationFailure;

/**
 * Validate a raw object claiming to be `CreateArtifactArgs`.
 *
 * Returns the narrowed args on success or a structured failure the
 * caller can surface to the model. The shape mirrors the
 * `structuredError` envelope used elsewhere in the CLI tool path.
 */
export function validateCreateArtifactArgs(raw: unknown): ArtifactValidationResult {
  if (!isRecord(raw)) {
    return fail('INVALID_TYPE', 'args', 'Tool args must be an object.');
  }

  const kindResult = validateKind(raw.kind);
  if (!kindResult.ok) return kindResult;

  const titleResult = validateTitle(raw.title);
  if (!titleResult.ok) return titleResult;

  switch (kindResult.kind) {
    case 'mermaid': {
      const sourceResult = validateMermaidSource(raw.source);
      if (!sourceResult.ok) return sourceResult;
      return {
        ok: true,
        args: { kind: 'mermaid', title: titleResult.title, source: sourceResult.source },
      };
    }
    case 'static-html': {
      const filesResult = validateFiles(raw.files);
      if (!filesResult.ok) return filesResult;
      return {
        ok: true,
        args: {
          kind: 'static-html',
          title: titleResult.title,
          files: filesResult.files,
          entry: optionalString(raw.entry),
        },
      };
    }
    case 'static-react': {
      const filesResult = validateFiles(raw.files);
      if (!filesResult.ok) return filesResult;
      const dependenciesResult = validateDependencies(raw.dependencies);
      if (!dependenciesResult.ok) return dependenciesResult;
      return {
        ok: true,
        args: {
          kind: 'static-react',
          title: titleResult.title,
          files: filesResult.files,
          entry: optionalString(raw.entry),
          dependencies: dependenciesResult.dependencies,
        },
      };
    }
    case 'file-tree': {
      const filesResult = validateFiles(raw.files);
      if (!filesResult.ok) return filesResult;
      return {
        ok: true,
        args: { kind: 'file-tree', title: titleResult.title, files: filesResult.files },
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export interface CreateArtifactContext {
  scope: ArtifactScope;
  author: ArtifactAuthor;
  /** Optional id override for tests; production callers omit. */
  idOverride?: string;
  /** Optional `updatedAt` override for tests; production callers omit. */
  nowOverride?: number;
}

/**
 * Build an `ArtifactRecord` from validated args + runtime context.
 *
 * Pure: same input → same output. The id and updatedAt come from `ctx`
 * overrides when provided so callers can pin them in tests.
 */
export function buildArtifactRecord(
  args: CreateArtifactArgs,
  ctx: CreateArtifactContext,
): ArtifactRecord {
  const id = ctx.idOverride ?? createId();
  const updatedAt = ctx.nowOverride ?? Date.now();
  const base = {
    id,
    scope: ctx.scope,
    author: ctx.author,
    title: args.title,
    status: 'ready' as const,
    updatedAt,
  };

  switch (args.kind) {
    case 'mermaid':
      return { ...base, kind: 'mermaid', source: args.source };
    case 'static-html':
      return { ...base, kind: 'static-html', files: args.files, entry: args.entry };
    case 'static-react':
      return {
        ...base,
        kind: 'static-react',
        files: args.files,
        entry: args.entry,
        dependencies: args.dependencies,
      };
    case 'file-tree':
      return {
        ...base,
        kind: 'file-tree',
        files: args.files,
        storage: { mode: 'inline' },
      };
  }
}

/**
 * One-line summary suitable for the tool result text shown to the model.
 * Stable so the model can reliably reference an artifact id in
 * follow-ups.
 */
export function summarizeArtifact(record: ArtifactRecord): string {
  const fileCount = recordFileCount(record);
  const detail = fileCount === null ? '' : ` (${fileCount} file${fileCount === 1 ? '' : 's'})`;
  return `Artifact created: ${record.id} — ${record.kind} "${record.title}"${detail}.`;
}

function recordFileCount(record: ArtifactRecord): number | null {
  switch (record.kind) {
    case 'static-html':
    case 'static-react':
    case 'file-tree':
      return record.files.length;
    case 'mermaid':
    case 'live-preview':
      return null;
  }
}

// ---------------------------------------------------------------------------
// Internal validators
// ---------------------------------------------------------------------------

function validateKind(
  raw: unknown,
):
  | { ok: true; kind: 'static-html' | 'static-react' | 'mermaid' | 'file-tree' }
  | ArtifactValidationFailure {
  if (typeof raw !== 'string') {
    return fail('MISSING_FIELD', 'kind', 'Field "kind" is required.');
  }
  if (raw !== 'static-html' && raw !== 'static-react' && raw !== 'mermaid' && raw !== 'file-tree') {
    return fail(
      'INVALID_KIND',
      'kind',
      `Unknown kind "${raw}". Expected one of: static-html, static-react, mermaid, file-tree. Use create_live_preview for live previews.`,
    );
  }
  return { ok: true, kind: raw };
}

function validateTitle(raw: unknown): { ok: true; title: string } | ArtifactValidationFailure {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return fail('MISSING_FIELD', 'title', 'Field "title" is required and must be a string.');
  }
  if (raw.length > MAX_TITLE_CHARS) {
    return fail('TOO_LARGE', 'title', `Title is ${raw.length} chars; max is ${MAX_TITLE_CHARS}.`);
  }
  return { ok: true, title: raw };
}

function validateMermaidSource(
  raw: unknown,
): { ok: true; source: string } | ArtifactValidationFailure {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return fail('MISSING_FIELD', 'source', 'Mermaid artifacts require a non-empty "source" field.');
  }
  if (raw.length > MAX_MERMAID_CHARS) {
    return fail(
      'TOO_LARGE',
      'source',
      `Mermaid source is ${raw.length} chars; max is ${MAX_MERMAID_CHARS}.`,
    );
  }
  return { ok: true, source: raw };
}

function validateFiles(
  raw: unknown,
): { ok: true; files: ArtifactFile[] } | ArtifactValidationFailure {
  if (!Array.isArray(raw) || raw.length === 0) {
    return fail('EMPTY_FILES', 'files', 'Field "files" must be a non-empty array.');
  }
  if (raw.length > MAX_FILES_PER_ARTIFACT) {
    return fail(
      'TOO_MANY_FILES',
      'files',
      `Got ${raw.length} files; max is ${MAX_FILES_PER_ARTIFACT}.`,
    );
  }

  const seen = new Set<string>();
  let totalBytes = 0;
  const files: ArtifactFile[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (!isRecord(entry)) {
      return fail('INVALID_TYPE', `files[${i}]`, 'Each file must be an object.');
    }
    const filePath = entry.path;
    const content = entry.content;
    if (typeof filePath !== 'string' || filePath.length === 0) {
      return fail(
        'MISSING_FIELD',
        `files[${i}].path`,
        'Each file requires a non-empty string "path".',
      );
    }
    if (typeof content !== 'string') {
      return fail(
        'MISSING_FIELD',
        `files[${i}].content`,
        'Each file requires a string "content" field.',
      );
    }
    if (seen.has(filePath)) {
      return fail('DUPLICATE_FILE_PATH', `files[${i}].path`, `Duplicate file path "${filePath}".`);
    }
    seen.add(filePath);

    const byteLength = Buffer.byteLength(content, 'utf8');
    if (byteLength > MAX_FILE_BYTES) {
      return fail(
        'TOO_LARGE',
        `files[${i}].content`,
        `File "${filePath}" is ${byteLength} bytes; per-file max is ${MAX_FILE_BYTES}.`,
      );
    }
    totalBytes += byteLength;
    if (totalBytes > MAX_TOTAL_BYTES) {
      return fail('TOO_LARGE', 'files', `Total file size exceeds ${MAX_TOTAL_BYTES} bytes.`);
    }
    files.push({ path: filePath, content });
  }
  return { ok: true, files };
}

function validateDependencies(
  raw: unknown,
): { ok: true; dependencies: Record<string, string> | undefined } | ArtifactValidationFailure {
  if (raw === undefined || raw === null) return { ok: true, dependencies: undefined };
  if (!isRecord(raw)) {
    return fail(
      'INVALID_TYPE',
      'dependencies',
      'Field "dependencies" must be an object of name → version strings.',
    );
  }
  const entries = Object.entries(raw);
  if (entries.length > MAX_DEPENDENCY_COUNT) {
    return fail(
      'TOO_MANY_FILES',
      'dependencies',
      `Got ${entries.length} dependencies; max is ${MAX_DEPENDENCY_COUNT}.`,
    );
  }
  const deps: Record<string, string> = {};
  for (const [name, version] of entries) {
    if (typeof version !== 'string' || version.length === 0) {
      return fail(
        'INVALID_TYPE',
        `dependencies.${name}`,
        'Dependency versions must be non-empty strings.',
      );
    }
    deps[name] = version;
  }
  return { ok: true, dependencies: deps };
}

function optionalString(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(
  code: ArtifactValidationFailure['code'],
  field: string,
  message: string,
): ArtifactValidationFailure {
  return { ok: false, code, field, message };
}
