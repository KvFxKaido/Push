/**
 * Substrate abstraction for *acquiring* project instructions.
 *
 * Push reads an orientation file (AGENTS.md / CLAUDE.md / …) on two surfaces
 * with genuinely different ground truth:
 *
 *   - CLI runs on a checked-out repo — the file is a cheap, trusted, local read
 *     available at turn zero.
 *   - Web/mobile has nothing until a remote sandbox boots, so it fetches the
 *     file over GitHub REST from an arbitrary repo/branch before any sandbox
 *     exists — untrusted, async, cold-start, and potentially authored by a PR
 *     contributor rather than the operator.
 *
 * That difference is real and irreducible, so it gets ONE seam: `read()`. Every
 * other concern — capping, delimiter escaping, envelope formatting, provenance
 * labeling — is substrate-agnostic and already lives in
 * `formatProjectInstructionsBlock`. A source MUST return raw bytes and MUST NOT
 * cap or escape; `loadProjectInstructions` funnels everything through the single
 * defended chokepoint so the two surfaces can't drift on budget or escaping
 * (the exact bug this module retires: the web path used a bespoke
 * `.slice(0, 5_000)` with no escaping and a different marker than the CLI).
 *
 * Mirrors the `SandboxProvider` shape: interface here in `lib/`, concrete
 * implementations per surface (local-fs in `cli/`, GitHub REST in `app/`).
 */

import { formatProjectInstructionsBlock } from './project-instructions.js';

/**
 * Canonical, ordered candidate filenames — first found wins. SINGLE source of
 * truth for both surfaces. Previously this list was hand-copied into
 * `app/src/lib/github-tools.ts` (web) and `cli/workspace-context.ts` (CLI) with
 * only a prose "keep these in sync" comment guarding the duplication. Every
 * `ProjectInstructionsSource` MUST iterate this array so precedence can't
 * disagree across surfaces; `project-instructions-source.test.ts` pins it.
 */
export const PROJECT_INSTRUCTION_FILENAMES = [
  'PUSH.md',
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
] as const;

export type ProjectInstructionFilename = (typeof PROJECT_INSTRUCTION_FILENAMES)[number];

/** Raw, unbounded, unescaped instructions as acquired from a substrate. */
export interface RawProjectInstructions {
  /** File contents exactly as read — NOT capped or escaped. */
  content: string;
  /** Which candidate won, for provenance (e.g. `"AGENTS.md"`). */
  filename: string;
}

/**
 * The one surface-specific seam: WHERE the instruction bytes come from. An
 * implementation resolves the first existing candidate from
 * `PROJECT_INSTRUCTION_FILENAMES` and returns its raw content, or `null` when
 * none exist. It must not truncate, escape, or wrap — that is the chokepoint's
 * job, kept in exactly one place.
 */
export interface ProjectInstructionsSource {
  read(): Promise<RawProjectInstructions | null>;
}

export interface LoadedProjectInstructions {
  /** Sanitized (capped + delimiter-escaped), envelope-wrapped, ready to inject. */
  block: string;
  /** Which candidate file the block came from. */
  filename: string;
}

/**
 * Acquire and defend project instructions through the single chokepoint. The
 * only entry point an orchestrator should call: it reads raw bytes from the
 * substrate, then funnels them through `formatProjectInstructionsBlock` so
 * size-capping and delimiter-escaping happen once, identically, regardless of
 * surface. `maxSize` overrides the shared sanitizer budget — pass a tighter cap
 * for delegated roles (see `SIZE_BUDGETS.agentsMdCoder`, `roleProjectHints`).
 */
export async function loadProjectInstructions(
  source: ProjectInstructionsSource,
  options: { maxSize?: number } = {},
): Promise<LoadedProjectInstructions | null> {
  const raw = await source.read();
  if (!raw) return null;

  const block = formatProjectInstructionsBlock(raw.content, {
    source: raw.filename,
    maxSize: options.maxSize,
  });
  return { block, filename: raw.filename };
}
