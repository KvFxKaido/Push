/**
 * Artifact types — model-emitted renderable surfaces.
 *
 * An artifact is a typed payload the model produces alongside chat that
 * Push renders in a dedicated panel: an HTML/React snippet, a Mermaid
 * diagram, a snapshot of generated files, or a token-scoped iframe URL
 * pointing at a dev server inside the active sandbox container.
 *
 * The shape lives in `lib/` so both surfaces (web renderer in
 * `app/src/components/artifacts/*`, CLI export in `cli/artifacts.ts`)
 * import from one place. Storage scoping uses `MemoryScope`'s
 * `repoFullName + branch + chatId` triple — durable across CLI restarts
 * by design (see `CLAUDE.md` "New feature checklist" #1).
 *
 * Naming: we keep the user-facing word "Artifact" because the
 * discriminated `kind` field disambiguates each variant cleanly.
 * Internal collisions with Cloudflare Artifacts (the git-storage
 * product) are addressed contextually — when CF Artifacts lands as a
 * persistence backend for `kind: 'file-tree'`, that backend is named
 * `CloudflareArtifactStore`, not `Artifact`.
 */

import type { AgentRole } from '../runtime-contract.js';

// ---------------------------------------------------------------------------
// Scope — the storage key
// ---------------------------------------------------------------------------

/**
 * The durable identity an artifact is filed under.
 *
 * Mirrors the `MemoryScope` triple (`repoFullName + branch + chatId`)
 * deliberately: chat-scoped artifacts on the web survive a CLI restart
 * because retrieval falls back to `repoFullName + branch` when `chatId`
 * isn't available. CLI-only callers pass `chatId: undefined` and read
 * the branch-wide artifact list.
 *
 * `repoFullName` is required; `branch` is required when present in the
 * workspace (CLI sessions outside a git repo pass `branch: null`).
 */
export interface ArtifactScope {
  repoFullName: string;
  branch: string | null;
  /** Web `chatId` is durable; CLI omits this field. */
  chatId?: string;
}

// ---------------------------------------------------------------------------
// Authorship — who created this artifact
// ---------------------------------------------------------------------------

/**
 * Surface-aware authorship record.
 *
 * Web has stable `messageId`s; CLI sessions are per-run with `runId`s.
 * Capturing both keeps the record meaningful regardless of which surface
 * created it without forcing one shape onto the other.
 */
export interface ArtifactAuthor {
  surface: 'web' | 'cli';
  role: AgentRole;
  /** Web message ID that emitted the tool call. */
  messageId?: string;
  /** CLI run ID — present on CLI, absent on web. */
  runId?: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Lifecycle status
// ---------------------------------------------------------------------------

export type ArtifactStatus =
  | 'draft' // model is still streaming files into it
  | 'ready' // renderable
  | 'error' // creation failed; `errorMessage` populated
  | 'expired'; // live-preview only — preview token past its TTL

// ---------------------------------------------------------------------------
// Variant payloads — the discriminated union
// ---------------------------------------------------------------------------

/** A file blob inside an artifact. Files are stored verbatim. */
export interface ArtifactFile {
  path: string;
  content: string;
}

/** Static HTML/CSS/JS snippet rendered in a Sandpack `static` client. */
export interface StaticHtmlArtifact extends ArtifactRecordBase {
  kind: 'static-html';
  files: ArtifactFile[];
  /** Defaults to `index.html`. */
  entry?: string;
}

/** React component bundled in-browser by Sandpack `runtime` client. */
export interface StaticReactArtifact extends ArtifactRecordBase {
  kind: 'static-react';
  files: ArtifactFile[];
  /** Defaults to `/App.js`. */
  entry?: string;
  /** npm dependencies Sandpack should fetch. */
  dependencies?: Record<string, string>;
}

/** Mermaid diagram source. Renderer is the Mermaid component, not Sandpack. */
export interface MermaidArtifact extends ArtifactRecordBase {
  kind: 'mermaid';
  source: string;
}

/**
 * Storage discriminator — where the file payload actually lives.
 *
 * v1 ships with `mode: 'inline'`; the field exists now so callers can
 * branch on it without a schema migration when external storage lands.
 * `external` is reserved for Cloudflare Artifacts (Git-compatible
 * versioned storage on Durable Objects, public beta May 2026); when it
 * arrives, the type widens additively — existing inline records stay
 * valid.
 */
export type FileTreeStorage = { mode: 'inline' } | { mode: 'external'; repoUri: string };

/**
 * A snapshot of generated files persisted as a tree.
 *
 * `files` is always present at runtime — for `mode: 'external'` it acts
 * as a synced cache pulled from `repoUri`. Keeping the field on both
 * variants means the renderer doesn't branch on storage mode.
 */
export interface FileTreeArtifact extends ArtifactRecordBase {
  kind: 'file-tree';
  files: ArtifactFile[];
  storage: FileTreeStorage;
}

/**
 * Live preview pointing at a dev server inside the active sandbox container.
 *
 * The Worker mints `previewToken` for each artifact and proxies
 * `https://preview.<host>/<previewToken>/*` to `localhost:<port>` inside
 * the sandbox identified by `sandboxId`. Tokens are session-scoped and
 * expire at `expiresAt`; a refresh tool re-issues a token when the user
 * keeps interacting past TTL.
 *
 * This kind is the genuinely Push-native artifact — Sandpack and CF
 * Artifacts can't reach into a running container. The shape is committed
 * here so callers can target it; the Worker route lands in a follow-up.
 */
export interface LivePreviewArtifact extends ArtifactRecordBase {
  kind: 'live-preview';
  sandboxId: string;
  port: number;
  previewToken: string;
  expiresAt: number;
  /** Optional command the sandbox ran to start the dev server. */
  startCommand?: string;
}

interface ArtifactRecordBase {
  id: string;
  scope: ArtifactScope;
  author: ArtifactAuthor;
  title: string;
  status: ArtifactStatus;
  /** ISO-8601 string for human readability; ms-since-epoch in `author.createdAt`. */
  updatedAt: number;
  errorMessage?: string;
}

export type ArtifactRecord =
  | StaticHtmlArtifact
  | StaticReactArtifact
  | MermaidArtifact
  | FileTreeArtifact
  | LivePreviewArtifact;

export type ArtifactKind = ArtifactRecord['kind'];

export const ALL_ARTIFACT_KINDS: readonly ArtifactKind[] = [
  'static-html',
  'static-react',
  'mermaid',
  'file-tree',
  'live-preview',
];

// ---------------------------------------------------------------------------
// Tool args — what the model emits in `create_artifact` calls
// ---------------------------------------------------------------------------

/**
 * Arguments the model passes to `create_artifact`. The handler validates
 * the shape, generates `id`, fills in `author`/`scope`/`updatedAt`, and
 * returns a fully-formed `ArtifactRecord`.
 *
 * `live-preview` is intentionally excluded — that variant is created by a
 * separate `create_live_preview` tool because it requires sandbox-side
 * orchestration (start the dev server, mint a token, register the proxy
 * route). Modeling it as the same tool would force callers to supply
 * fields they can't possibly know (`sandboxId`, `previewToken`).
 */
export type CreateArtifactArgs =
  | { kind: 'static-html'; title: string; files: ArtifactFile[]; entry?: string }
  | {
      kind: 'static-react';
      title: string;
      files: ArtifactFile[];
      entry?: string;
      dependencies?: Record<string, string>;
    }
  | { kind: 'mermaid'; title: string; source: string }
  | { kind: 'file-tree'; title: string; files: ArtifactFile[] };

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export function isArtifactKind(value: unknown): value is ArtifactKind {
  return typeof value === 'string' && (ALL_ARTIFACT_KINDS as readonly string[]).includes(value);
}

export function artifactRequiresFiles(kind: ArtifactKind): boolean {
  return kind === 'static-html' || kind === 'static-react' || kind === 'file-tree';
}

// ---------------------------------------------------------------------------
// Live-preview TTL policy
// ---------------------------------------------------------------------------

/**
 * Token-scoped iframe URLs for live-preview artifacts expire so a stale
 * preview link can't be replayed against a long-running sandbox. The
 * default TTL covers an active iteration loop; the max lifetime caps a
 * single preview's total reachability across renewals so an abandoned
 * tab can't keep a sandbox port exposed indefinitely.
 *
 * Renewal policy: while the originating session is active, the runtime
 * may issue a fresh token resetting `expiresAt` to `now + DEFAULT_TTL`,
 * up to `MAX_LIFETIME` from the original creation. Past that, the
 * artifact transitions to `status: 'expired'` and a new artifact must
 * be created.
 */
export const LIVE_PREVIEW_DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 min
export const LIVE_PREVIEW_MAX_LIFETIME_MS = 4 * 60 * 60 * 1000; // 4 h
