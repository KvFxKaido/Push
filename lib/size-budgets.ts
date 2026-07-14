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
 * (the 32K `projectInstructions` below), and its workspace free-text
 * memory cap is now `workspaceMemory` here too. The CLI's entry-COUNT caps
 * (`MAX_TREE_ENTRIES`, `MAX_STRUCTURED_ENTRIES` in `cli/workspace-context.ts`)
 * stay local on purpose — they bound a *number of items*, not characters, so
 * they're out of this char-budget module's scope.
 *
 * Pure module — no imports, no I/O. Safe for both Web and CLI.
 */
export const SIZE_BUDGETS = Object.freeze({
  /**
   * Project instructions (AGENTS.md / CLAUDE.md / PUSH.md / GEMINI.md) — ONE budget
   * for every role that reads them.
   *
   * 32_000 aligns with the only hard cap that exists anywhere in this ecosystem:
   * Codex's `project_doc_max_bytes` (32 KiB, applied to the whole instruction chain,
   * and truncated *silently*). Everyone else declines to cap at all — Claude Code's
   * own docs say CLAUDE.md is "loaded in full regardless of length" (it warns at
   * ~40k chars and suggests <200 lines, but drops nothing); Cursor's "<500 lines" is
   * advice; Gemini CLI concatenates GEMINI.md into every prompt; Aider and the
   * agents.md spec say nothing about size. So 32k is not a compromise between
   * standards — it is the tightest real ceiling a cross-tool repo already has to
   * respect, which makes it the one number worth matching.
   *
   * Was three numbers (8k orchestrator / 12k read-only agents / 8k Coder). The split
   * was incoherent: a Coder and an Explorer would read *different halves* of the same
   * AGENTS.md, and the role that MUTATES the repo got less of the rulebook than the
   * role that cannot change a line. Every role should see the same file.
   *
   * At 8k this repo's own CLAUDE.md kept 29%, cut mid-sentence, losing every
   * convention section — Tool protocol, "Behavior lives in code", symmetric
   * structured logs, decision-doc discipline, the new-feature checklist, and the PR
   * self-review pass (section 12 of 14, so structurally unreachable under the cap).
   * The checklist that exists to catch our recurring defect classes could never be
   * delivered to the agent expected to follow it.
   *
   * The cost this was guarding against does not survive contact with arithmetic.
   * Project instructions ride the SYSTEM PROMPT, which Push tags with `cache_control`
   * — so the block sits in the cached prefix, written once and billed at cache-read
   * rates thereafter. 8k -> 32k adds ~6k tokens: ~4% of a 200k window, ~$0.009/turn
   * cached, ~$0.55 across a 50-turn session. That is the entire price of the thing
   * the old "it bills every repo/user every turn" rule was protecting.
   *
   * NOT a licence for a bloated AGENTS.md — shorter files demonstrably produce better
   * adherence, and ours is 88 lines on purpose. Authoring guidance belongs in the
   * authoring guidance. A truncator's job is to be honest when a file overflows, not
   * to enforce brevity by deleting the back half of someone's conventions.
   */
  projectInstructions: 32_000,
  /** Reviewer/Auditor compact project-policy hints — a distilled side block, NOT the
   *  instruction file itself, so it keeps its own (much smaller) budget. Deliberately
   *  not folded into `projectInstructions`: different content, different job. */
  roleProjectHints: 2_500,
  /** CLI workspace-context free-text memory block (`.push/memory.md`) folded
   *  into the prompt (`cli/workspace-context.ts`). */
  workspaceMemory: 4_000,
  /**
   * REVIEW.md reviewer guidance — primary repo-specific review input.
   *
   * Sized to hold REVIEW.md **whole**, with headroom, and `size-budgets.test.ts`
   * fails when it stops doing so. That test is the point of this number: at
   * 8,000 the file (11,967 chars) had silently overflowed, and the reviewers had
   * been running for an unknown stretch without the delivery rules, provider
   * routing, decision-doc discipline, the per-turn tool budget, or the
   * validation expectations — the tail of their own rulebook. Nothing failed,
   * because a truncated rulebook reads exactly like a complete one.
   *
   * So: do not treat this as a ceiling to trim REVIEW.md toward. If the file
   * grows past it, the test goes red and you raise this — deliberately — or cut
   * the file. What must never happen again is the cap eating the guidance in
   * silence. (Found when adding two defect classes to REVIEW.md evicted three
   * other sections; Codex caught it on #1477.)
   */
  reviewGuidance: 16_000,
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
