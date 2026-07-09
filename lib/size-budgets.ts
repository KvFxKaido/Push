/**
 * Canonical character budgets for content folded into agent prompts.
 *
 * One inventory so per-role caps stop being duplicated magic numbers scattered
 * across agent modules — the 12k project-instructions cap was previously defined
 * identically in two agents, and tool-result caps lived in three places. Note
 * that centralizing the *declaration* does not collapse the *values*: each
 * consumer's budget is intentionally distinct (a Coder carries more context than
 * a read-only investigator; a side hint gets less room than primary guidance),
 * and the rationale lives here next to the number rather than in scattered
 * inline comments.
 *
 * Scope: per-block content *truncation* caps, plus the diff-chunking limits
 * (`DIFF_LIMIT` feeding `chunkDiffByFile` in the reviewer / deep-reviewer /
 * auditor — see `reviewerDiffChunk` / `auditorDiffChunk` below). Intentionally
 * excluded: aggregate budgets like coder's `MAX_TOTAL_CONTEXT_SIZE` (a
 * whole-message size limit / context meter, not a single-block cap).
 *
 * Two distinct diff families live here, don't conflate them: `auditorDiff` is
 * the auditor's single-block diff *display* truncation; the `*DiffChunk`
 * entries are the per-file chunking caps fed to `chunkDiffByFile`.
 *
 * Lib-owned. The web `app/src/lib/agent-loop-utils.ts` copy imports the
 * read-only tool-result cap from here transitively. The CLI's project-
 * instruction cap routes through the shared `formatProjectInstructionsBlock`
 * (the 8K `projectInstructionsDefault` below), and its workspace free-text
 * memory cap is now `workspaceMemory` here too. The CLI's entry-COUNT caps
 * (`MAX_TREE_ENTRIES`, `MAX_STRUCTURED_ENTRIES` in `cli/workspace-context.ts`)
 * stay local on purpose — they bound a *number of items*, not characters, so
 * they're out of this char-budget module's scope.
 *
 * Pure module — no imports, no I/O. Safe for both Web and CLI.
 */
export const SIZE_BUDGETS = Object.freeze({
  /** Default cap for the shared project-instructions sanitizer when a caller
   *  passes no explicit budget (the web + CLI orchestrators). */
  projectInstructionsDefault: 8_000,
  /** Per-run project-instructions budget for the read-only investigation agents
   *  (Explorer, Deep Reviewer) — looser than the orchestrator default. */
  projectInstructionsAgent: 12_000,
  /** Coder's AGENTS.md budget — tighter, since the Coder already carries the
   *  most other context and the full file stays readable in the sandbox. */
  agentsMdCoder: 4_000,
  /** Reviewer/Auditor compact project-policy hints — side guidance, not the
   *  primary input, so it gets the smallest budget. */
  roleProjectHints: 2_500,
  /** CLI workspace-context free-text memory block (`.push/memory.md`) folded
   *  into the prompt (`cli/workspace-context.ts`). */
  workspaceMemory: 4_000,
  /** REVIEW.md reviewer guidance — primary repo-specific review input. */
  reviewGuidance: 8_000,
  /** Prior-review findings block fed to a re-review (cross-review memory) —
   *  supporting context for diffing against the previous pass, so it gets
   *  less room than the primary REVIEW.md guidance. */
  priorReviewFindings: 6_000,
  /** Tool-result truncation for the read-only investigation agents. */
  toolResultReadOnly: 8_000,
  /** Tool-result truncation for the Coder — larger window (~400 lines/read). */
  toolResultCoder: 24_000,
  /** Auditor sandbox-diff display cap. */
  auditorDiff: 15_000,
  /** Reviewer + Deep Reviewer diff-chunking cap fed to `chunkDiffByFile` (the
   *  per-file budget before later hunks are dropped). Looser than the
   *  auditor's — a full advisory review wants more of the diff than a binary
   *  safety gate does. */
  reviewerDiffChunk: 40_000,
  /** Auditor diff-chunking cap fed to `chunkDiffByFile`. Tighter than the
   *  reviewers': the auditor also carries per-file context blocks and a
   *  security-focused prompt, so it trades diff breadth for prompt headroom. */
  auditorDiffChunk: 30_000,
} as const);
