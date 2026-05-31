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
 * Scope: per-block content *truncation* caps. Intentionally excluded —
 *   (a) aggregate budgets like coder's `MAX_TOTAL_CONTEXT_SIZE` (a whole-message
 *       size limit / context meter, not a single-block cap); and
 *   (b) diff-chunking limits (`DIFF_LIMIT` feeding `chunkDiffByFile` in the
 *       reviewer / deep-reviewer / auditor) — their own family with its own
 *       duplication: 40k in both reviewer-agent.ts and deep-reviewer-agent.ts,
 *       30k in auditor-agent.ts. TODO(size-budgets): consolidate in a follow-up.
 *   The `auditorDiff` entry below is the auditor's single-block diff *display*
 *   truncation, which is this category; the chunking `DIFF_LIMIT`s are not.
 *
 * Lib-owned only for now. The web `app/src/lib/agent-loop-utils.ts` copy already
 * imports the read-only tool-result cap from here transitively; the CLI's own
 * instruction/memory caps in `cli/workspace-context.ts` are a deliberate
 * follow-up (CLI surface, separate truncation path).
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
  /** REVIEW.md reviewer guidance — primary repo-specific review input. */
  reviewGuidance: 8_000,
  /** Tool-result truncation for the read-only investigation agents. */
  toolResultReadOnly: 8_000,
  /** Tool-result truncation for the Coder — larger window (~400 lines/read). */
  toolResultCoder: 24_000,
  /** Auditor sandbox-diff display cap. */
  auditorDiff: 15_000,
} as const);
