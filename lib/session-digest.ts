/**
 * Session digest — Hermes-shaped structured summary materialized at compaction.
 *
 * When the per-agent compactor fires (currently in `lib/message-context-manager.ts`
 * on the web side and `cli/context-manager.ts` on the CLI side), the rolling
 * tail is the cheapest place to anchor a single high-signal summary of the
 * session so far. Free-text summaries drift between turns and break prompt
 * caching; a typed digest with a fixed schema is byte-stable when its inputs
 * don't change, so the cached prefix from the prior turn keeps hitting.
 *
 * The schema is borrowed verbatim from Hermes Agent's compaction layer
 * (see `docs/decisions/Hermes Agent — Lessons For Push.md` item 2): goal /
 * constraints / progress {done, inProgress, blocked} / decisions / relevant
 * files / next steps / critical context. Only `goal` and `criticalContext`
 * are optional at the type level; the list fields are always present (empty
 * arrays when nothing applies). The render path then omits empty sections so
 * thin digests don't clutter the block with `(none)` lines.
 *
 * Idempotency: subsequent compactions on the same conversation should
 * **merge** into the prior digest rather than emit a new one. The
 * `[SESSION_DIGEST]` / `[/SESSION_DIGEST]` markers in the rendered block let
 * `parseSessionDigest` recover the prior structured value from a message's
 * content; `mergeSessionDigests` then deduplicates against the new inputs.
 * Two of the buckets behave as "current state" rather than "history" and
 * **replace** on merge: `progress.inProgress` (single active phase) and
 * `nextSteps` (open task list). The remaining list buckets accumulate.
 */

import type { CoderWorkingMemory } from './working-memory.ts';
import type { MemoryRecord } from './runtime-contract.ts';

// ---------------------------------------------------------------------------
// Type
// ---------------------------------------------------------------------------

export interface SessionDigest {
  /** Top-level goal — typically the user's current ask (after redirects).
   *  Sourced from the `UserGoalAnchor` when available; falls back to working
   *  memory's `plan` field. */
  goal?: string;
  /** Hard constraints from the user or prior decisions that must be honored
   *  for the duration of the session (e.g. "don't touch the auth module").
   *  Sourced from working memory `assumptions`. */
  constraints: string[];
  /** Progress tracking. Empty inner arrays render as nothing (not "(none)")
   *  so a digest with only a goal stays small. */
  progress: {
    done: string[];
    inProgress: string[];
    blocked: string[];
  };
  /** Important decisions made — typically reasoning the model committed to
   *  that future turns should respect (e.g. "chose Modal over Cloudflare for
   *  the GPU path"). Sourced from `MemoryRecord` rows with `kind: 'decision'`. */
  decisions: string[];
  /** Files materially touched or under active investigation. Union of
   *  `MemoryRecord.relatedFiles[]` across all input records plus working
   *  memory `filesTouched`, deduplicated, capped. */
  relevantFiles: string[];
  /** Immediate next actions. Sourced from working memory `openTasks`. */
  nextSteps: string[];
  /** Catch-all for anything else load-bearing that doesn't fit a bucket.
   *  Kept short — one paragraph at most. */
  criticalContext?: string;
}

// ---------------------------------------------------------------------------
// Markers + caps
// ---------------------------------------------------------------------------

export const SESSION_DIGEST_HEADER = '[SESSION_DIGEST]';
export const SESSION_DIGEST_FOOTER = '[/SESSION_DIGEST]';

/** Per-field item caps. Bounds the rendered block size for predictable
 *  token consumption and keeps the rolling-tail message under the breakpoint
 *  byte budget. */
const DEFAULT_MAX_ITEMS_PER_LIST = 12;
const DEFAULT_MAX_ITEM_CHARS = 240;
const DEFAULT_MAX_FILES = 20;
const DEFAULT_MAX_CRITICAL_CONTEXT_CHARS = 600;

// ---------------------------------------------------------------------------
// Materialization from records + working memory
// ---------------------------------------------------------------------------

export interface BuildSessionDigestInputs {
  /** Memory records scoped to the current chat / repo / branch. Caller is
   *  responsible for the scope query — the digest builder is pure. */
  records: ReadonlyArray<MemoryRecord>;
  /** Optional Coder working memory snapshot. When present, fills `goal`
   *  (from `plan`), `constraints` (from `assumptions`), `progress.done`
   *  (from `completedPhases`), `progress.inProgress` (from `currentPhase`),
   *  `progress.blocked` (from `errorsEncountered`), `nextSteps` (from
   *  `openTasks`), and contributes to `relevantFiles` (from `filesTouched`). */
  workingMemory?: CoderWorkingMemory;
  /** Optional goal override — wins over `workingMemory.plan` when both
   *  are present. Typically populated from `UserGoalAnchor` so the anchor
   *  and digest agree on the current ask. */
  goal?: string;
  /** Optional caps. Defaults are conservative — the digest stays readable
   *  and stays under the token budget for the rolling-tail breakpoint. */
  maxItemsPerList?: number;
  maxItemChars?: number;
  maxFiles?: number;
}

export function buildSessionDigest(inputs: BuildSessionDigestInputs): SessionDigest {
  const maxItems = inputs.maxItemsPerList ?? DEFAULT_MAX_ITEMS_PER_LIST;
  const maxChars = inputs.maxItemChars ?? DEFAULT_MAX_ITEM_CHARS;
  const maxFiles = inputs.maxFiles ?? DEFAULT_MAX_FILES;

  const wm = inputs.workingMemory;

  const decisions: string[] = [];
  const recordFiles: string[] = [];
  const recordOutcomesDone: string[] = [];
  const recordOutcomesBlocked: string[] = [];

  for (const record of inputs.records) {
    if (record.freshness === 'expired') continue;
    if (record.kind === 'decision') {
      decisions.push(record.summary);
    } else if (record.kind === 'task_outcome') {
      // `task_outcome` records are written by the delegation layer in
      // `lib/context-memory.ts:recordTaskOutcome` with `tags: [outcome.status]`
      // where status is the `DelegationStatus` enum (`complete` | `incomplete`
      // | `inconclusive`). Use the structured tag as the source of truth;
      // fall back to summary substring only when tags are absent (legacy
      // records or non-delegation outcomes).
      if (isCompleteOutcome(record)) {
        recordOutcomesDone.push(record.summary);
      } else {
        recordOutcomesBlocked.push(record.summary);
      }
    } else if (record.kind === 'verification_result') {
      // Verification results carry structured `pass`/`fail` tags from
      // `writeCoderMemory` in `lib/context-memory.ts`. Read tags first
      // for the same reason as `task_outcome`: substring tone can lie
      // (a check id like `error-handling` or `failover` is a `pass`).
      // Substring fallback only when tags are absent.
      if (isPassedVerification(record)) {
        recordOutcomesDone.push(record.summary);
      } else {
        recordOutcomesBlocked.push(record.summary);
      }
    }
    if (record.relatedFiles && record.relatedFiles.length > 0) {
      recordFiles.push(...record.relatedFiles);
    }
  }

  const goalCandidate = inputs.goal ?? wm?.plan;
  // Cap the goal scalar to the same per-item char limit as list entries.
  // Without a cap, `coder_update_state.plan` can write an arbitrarily long
  // value that lands in the safety-net-protected `[SESSION_DIGEST]` message
  // — an oversized goal then becomes a non-droppable prompt block and
  // forces real history to be trimmed in its place (PR #574 review).
  let goal: string | undefined;
  if (goalCandidate) {
    const trimmed = goalCandidate.trim();
    if (trimmed) {
      goal = trimmed.length > maxChars ? `${trimmed.slice(0, maxChars - 1)}…` : trimmed;
    }
  }

  const constraints = capList(wm?.assumptions, maxItems, maxChars);

  const done = capList([...(wm?.completedPhases ?? []), ...recordOutcomesDone], maxItems, maxChars);
  const inProgress = wm?.currentPhase ? capList([wm.currentPhase], maxItems, maxChars) : [];
  const blocked = capList(
    [...(wm?.errorsEncountered ?? []), ...recordOutcomesBlocked],
    maxItems,
    maxChars,
  );

  const decisionsCapped = capList(decisions, maxItems, maxChars);

  const filesCombined = [...(wm?.filesTouched ?? []), ...recordFiles];
  const relevantFiles = capList(filesCombined, maxFiles, maxChars);

  const nextSteps = capList(wm?.openTasks, maxItems, maxChars);

  return {
    ...(goal ? { goal } : {}),
    constraints,
    progress: { done, inProgress, blocked },
    decisions: decisionsCapped,
    relevantFiles,
    nextSteps,
  };
}

/** Positive markers that indicate an outcome actually succeeded — used by
 *  the untagged fallback paths. Conservative-by-default: any record without
 *  a structured tag AND without one of these markers routes to blocked.
 *  That's stricter than the previous "anything not containing fail/blocked
 *  is done" heuristic, which misclassified "Could not finish before
 *  timeout", "timed out", "incomplete", "Build broken" etc. into
 *  `progress.done` (PR #574 review). The flip-side cost is that legacy
 *  records with neutral summaries (e.g. "deployed v1.2") now land in
 *  blocked — acceptable for an untagged fallback since (a) modern writes
 *  carry structured tags, and (b) the conservative direction is safer for
 *  the model: a real success surfaced as blocked nudges follow-up, a real
 *  failure surfaced as done invites premature closure. */
const POSITIVE_OUTCOME_MARKERS = ['passed', 'completed', 'success', 'succeeded'];

function hasPositiveMarker(summary: string): boolean {
  const lower = summary.toLowerCase();
  return POSITIVE_OUTCOME_MARKERS.some((m) => lower.includes(m));
}

/** True iff the record's structured status indicates the task actually
 *  completed. Reads `record.tags` against the `DelegationStatus` enum
 *  (`complete` | `incomplete` | `inconclusive`) — only `complete` counts as
 *  done. When tags are absent (legacy records, non-delegation sources),
 *  falls back to a conservative positive-marker check: needs an explicit
 *  success word to count as done; otherwise lands in blocked. */
function isCompleteOutcome(record: MemoryRecord): boolean {
  if (record.tags && record.tags.length > 0) {
    return record.tags.includes('complete');
  }
  return hasPositiveMarker(record.summary);
}

/** True iff the verification record passed. Reads `record.tags` for the
 *  `pass`/`fail` markers written by `writeCoderMemory`. When tags absent,
 *  falls back to the same conservative positive-marker check used for
 *  task_outcome: needs "passed" / "completed" / "success" / "succeeded"
 *  in the summary to count as done. */
function isPassedVerification(record: MemoryRecord): boolean {
  if (record.tags && record.tags.length > 0) {
    return record.tags.includes('pass');
  }
  return hasPositiveMarker(record.summary);
}

/** Collapse a rendered field value to a single line so the line-oriented
 *  `[SESSION_DIGEST]` block parses back round-trip. MemoryRecord summaries
 *  and working-memory fields can contain embedded newlines — left raw they'd
 *  parse as fresh list items, labels, or footers in `parseSessionDigest`,
 *  breaking merge-in-place. Replace any line break with a single space, then
 *  collapse runs of whitespace. Also strip stray digest markers so a value
 *  containing `[SESSION_DIGEST]` can't terminate the surrounding block. */
function sanitizeFieldValue(value: string): string {
  return value
    .replace(new RegExp(escapeRegExp(SESSION_DIGEST_FOOTER), 'g'), '')
    .replace(new RegExp(escapeRegExp(SESSION_DIGEST_HEADER), 'g'), '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Deduplicate (preserve first occurrence), trim each entry to `maxChars`,
 *  cap the list at `maxItems`. Empty / whitespace-only entries dropped.
 *  Each value is sanitized for the single-line render format before dedupe. */
function capList(
  values: ReadonlyArray<string> | undefined,
  maxItems: number,
  maxChars: number,
): string[] {
  if (!values) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    if (typeof raw !== 'string') continue;
    const sanitized = sanitizeFieldValue(raw);
    if (!sanitized) continue;
    const clamped =
      sanitized.length > maxChars ? `${sanitized.slice(0, maxChars - 1)}…` : sanitized;
    if (seen.has(clamped)) continue;
    seen.add(clamped);
    out.push(clamped);
    if (out.length >= maxItems) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/** Render a digest to its canonical block form. Empty fields are omitted so
 *  thin digests stay readable; the block is byte-stable for the same inputs
 *  (deterministic field order + deduplication) so prompt caching can hit. */
export function renderSessionDigest(digest: SessionDigest): string {
  const lines: string[] = [SESSION_DIGEST_HEADER];

  // Sanitize the scalar value the same way list entries are sanitized —
  // the goal comes from working memory or the user-goal anchor, both of
  // which can carry embedded newlines or stray marker substrings. Left raw,
  // those would corrupt the line-oriented block and break later parse+merge.
  if (digest.goal) {
    const sanitizedGoal = sanitizeFieldValue(digest.goal);
    if (sanitizedGoal) lines.push(`Goal: ${sanitizedGoal}`);
  }

  if (digest.constraints.length > 0) {
    lines.push('Constraints:');
    for (const c of digest.constraints) lines.push(`  - ${c}`);
  }

  const { done, inProgress, blocked } = digest.progress;
  if (done.length > 0 || inProgress.length > 0 || blocked.length > 0) {
    lines.push('Progress:');
    if (done.length > 0) {
      lines.push('  Done:');
      for (const d of done) lines.push(`    - ${d}`);
    }
    if (inProgress.length > 0) {
      lines.push('  In progress:');
      for (const i of inProgress) lines.push(`    - ${i}`);
    }
    if (blocked.length > 0) {
      lines.push('  Blocked:');
      for (const b of blocked) lines.push(`    - ${b}`);
    }
  }

  if (digest.decisions.length > 0) {
    lines.push('Decisions:');
    for (const d of digest.decisions) lines.push(`  - ${d}`);
  }

  if (digest.relevantFiles.length > 0) {
    lines.push('Relevant files:');
    for (const f of digest.relevantFiles) lines.push(`  - ${f}`);
  }

  if (digest.nextSteps.length > 0) {
    lines.push('Next steps:');
    for (const n of digest.nextSteps) lines.push(`  - ${n}`);
  }

  if (digest.criticalContext) {
    lines.push('Critical context:');
    lines.push(`  ${digest.criticalContext}`);
  }

  lines.push(SESSION_DIGEST_FOOTER);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

/** Find and parse a `[SESSION_DIGEST]…[/SESSION_DIGEST]` block out of a
 *  message's content. Returns `null` if no block is present or the block
 *  is malformed. Tolerates extra whitespace; ignores unknown field labels
 *  (forward compat). */
export function parseSessionDigest(content: string): SessionDigest | null {
  const start = content.indexOf(SESSION_DIGEST_HEADER);
  if (start === -1) return null;
  const end = content.indexOf(SESSION_DIGEST_FOOTER, start + SESSION_DIGEST_HEADER.length);
  if (end === -1) return null;

  const body = content.slice(start + SESSION_DIGEST_HEADER.length, end);
  const lines = body.split('\n').map((l) => l.replace(/\s+$/, ''));

  const digest: SessionDigest = {
    constraints: [],
    progress: { done: [], inProgress: [], blocked: [] },
    decisions: [],
    relevantFiles: [],
    nextSteps: [],
  };

  type ListTarget =
    | 'constraints'
    | 'decisions'
    | 'relevantFiles'
    | 'nextSteps'
    | 'progress.done'
    | 'progress.inProgress'
    | 'progress.blocked';
  let listTarget: ListTarget | null = null;
  let inProgressBlock = false;
  let inCriticalContext = false;
  const criticalContextLines: string[] = [];

  for (const raw of lines) {
    const line = raw;
    if (!line.trim()) {
      // Blank inside the block ends a critical-context capture but not a list.
      if (inCriticalContext) inCriticalContext = false;
      continue;
    }

    // Top-level field labels — case-sensitive to keep the parser narrow.
    const goalMatch = line.match(/^Goal:\s*(.+)$/);
    if (goalMatch) {
      digest.goal = goalMatch[1].trim();
      listTarget = null;
      inProgressBlock = false;
      inCriticalContext = false;
      continue;
    }
    if (line === 'Constraints:') {
      listTarget = 'constraints';
      inProgressBlock = false;
      inCriticalContext = false;
      continue;
    }
    if (line === 'Progress:') {
      inProgressBlock = true;
      listTarget = null;
      inCriticalContext = false;
      continue;
    }
    if (inProgressBlock) {
      if (line === '  Done:') {
        listTarget = 'progress.done';
        continue;
      }
      if (line === '  In progress:') {
        listTarget = 'progress.inProgress';
        continue;
      }
      if (line === '  Blocked:') {
        listTarget = 'progress.blocked';
        continue;
      }
      // Falling out of Progress when a new top-level label is seen below.
    }
    if (line === 'Decisions:') {
      listTarget = 'decisions';
      inProgressBlock = false;
      inCriticalContext = false;
      continue;
    }
    if (line === 'Relevant files:') {
      listTarget = 'relevantFiles';
      inProgressBlock = false;
      inCriticalContext = false;
      continue;
    }
    if (line === 'Next steps:') {
      listTarget = 'nextSteps';
      inProgressBlock = false;
      inCriticalContext = false;
      continue;
    }
    if (line === 'Critical context:') {
      inCriticalContext = true;
      listTarget = null;
      inProgressBlock = false;
      continue;
    }

    // List entries: nested progress is `    - x`; top-level lists are `  - x`.
    const topMatch = line.match(/^  - (.+)$/);
    const nestedMatch = line.match(/^    - (.+)$/);
    if (nestedMatch && listTarget?.startsWith('progress.')) {
      appendToTarget(digest, listTarget, nestedMatch[1]);
      continue;
    }
    if (topMatch && listTarget && !listTarget.startsWith('progress.')) {
      appendToTarget(digest, listTarget, topMatch[1]);
      continue;
    }

    if (inCriticalContext) {
      const trimmed = line.startsWith('  ') ? line.slice(2) : line;
      criticalContextLines.push(trimmed);
      continue;
    }

    // Unknown top-level label (forward compat). Detected by the heuristic
    // "non-indented line that ends with a colon and isn't a recognized
    // label above." Clear the active list target so any `  - x` entries
    // that follow don't bleed into the previous section — that bleed is
    // what would corrupt parse+merge when a future digest version adds a
    // new section between two known ones.
    if (/^[A-Za-z][^\n]*:\s*$/.test(line)) {
      listTarget = null;
      inProgressBlock = false;
      inCriticalContext = false;
      continue;
    }

    // Unrecognized line shape — ignore.
  }

  if (criticalContextLines.length > 0) {
    digest.criticalContext = criticalContextLines.join('\n').trim();
  }

  return digest;
}

function appendToTarget(digest: SessionDigest, target: string, value: string): void {
  switch (target) {
    case 'constraints':
      digest.constraints.push(value);
      break;
    case 'decisions':
      digest.decisions.push(value);
      break;
    case 'relevantFiles':
      digest.relevantFiles.push(value);
      break;
    case 'nextSteps':
      digest.nextSteps.push(value);
      break;
    case 'progress.done':
      digest.progress.done.push(value);
      break;
    case 'progress.inProgress':
      digest.progress.inProgress.push(value);
      break;
    case 'progress.blocked':
      digest.progress.blocked.push(value);
      break;
  }
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/**
 * Merge a newly-materialized digest into a prior one. Two merge semantics
 * by field role:
 *
 *   **Accumulating** (history of what happened):
 *   `constraints`, `progress.done`, `progress.blocked`, `decisions`,
 *   `relevantFiles` — preserve prior entries, append new ones not seen
 *   before (string equality after sanitize+trim).
 *
 *   **Current-state** (snapshot, not history):
 *   `progress.inProgress`, `nextSteps` — replace from `next` when defined,
 *   else keep prior. A task that moved from in-progress to done should not
 *   appear in both buckets; an open task that's been completed should drop
 *   out of `nextSteps`.
 *
 * Scalars (`goal`, `criticalContext`) — newer wins when set, else prior.
 *
 * Per-list caps from `BuildSessionDigestInputs` are reapplied after the
 * union so a long session doesn't unbound the rendered block.
 */
export interface MergeSessionDigestOptions {
  maxItemsPerList?: number;
  maxFiles?: number;
}

export function mergeSessionDigests(
  prior: SessionDigest,
  next: SessionDigest,
  options: MergeSessionDigestOptions = {},
): SessionDigest {
  const maxItems = options.maxItemsPerList ?? DEFAULT_MAX_ITEMS_PER_LIST;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  return {
    ...(next.goal || prior.goal ? { goal: next.goal ?? prior.goal } : {}),
    constraints: mergeList(prior.constraints, next.constraints, maxItems),
    progress: {
      done: mergeList(prior.progress.done, next.progress.done, maxItems),
      // Current-state buckets: replace from `next` (the freshly-materialized
      // snapshot of what's open right now). Prior entries survive only when
      // the new digest doesn't define this bucket at all (e.g. a build call
      // that didn't touch working memory). See header comment.
      inProgress: replaceList(prior.progress.inProgress, next.progress.inProgress, maxItems),
      blocked: mergeList(prior.progress.blocked, next.progress.blocked, maxItems),
    },
    decisions: mergeList(prior.decisions, next.decisions, maxItems),
    relevantFiles: mergeList(prior.relevantFiles, next.relevantFiles, maxFiles),
    nextSteps: replaceList(prior.nextSteps, next.nextSteps, maxItems),
    ...(next.criticalContext || prior.criticalContext
      ? {
          criticalContext: clampCriticalContext(next.criticalContext ?? prior.criticalContext),
        }
      : {}),
  };
}

/** Current-state merge: always use `next` (which IS the current snapshot
 *  per the build contract — `buildSessionDigest` populates each current-
 *  state bucket from working memory or empty). Sanitizes + dedupes + caps.
 *  Explicit empties from the build (user cleared `openTasks`, no
 *  `currentPhase`) intentionally wipe prior values; otherwise stale state
 *  lingers forever. The "keep prior when next is empty" fallback was
 *  appealing but wrong: it loses the explicit-clear case (Copilot review
 *  on PR #574). The "fresh build with no working memory" worry is moot —
 *  that build would emit `next.X === []`, which IS the current snapshot
 *  for that turn. */
function replaceList(_prior: string[], next: string[], cap: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of next) {
    const sanitized = sanitizeFieldValue(value);
    if (!sanitized || seen.has(sanitized)) continue;
    seen.add(sanitized);
    out.push(sanitized);
    if (out.length >= cap) break;
  }
  return out;
}

function mergeList(prior: string[], next: string[], cap: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of [...prior, ...next]) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= cap) break;
  }
  return out;
}

function clampCriticalContext(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.length <= DEFAULT_MAX_CRITICAL_CONTEXT_CHARS) return value;
  return `${value.slice(0, DEFAULT_MAX_CRITICAL_CONTEXT_CHARS - 1)}…`;
}

// ---------------------------------------------------------------------------
// Detection helper
// ---------------------------------------------------------------------------

/** Does any message in the array carry a `[SESSION_DIGEST]` block in its
 *  content? Mirrors `hasCompactionMarker` in `context-transformer.ts` — used
 *  by the transformer stage to detect prior digests and trigger merge-in-place
 *  rather than emit a new synthetic message. */
export function hasSessionDigest<M extends { content?: unknown }>(
  messages: ReadonlyArray<M>,
): boolean {
  return messages.some((m) => {
    const c = (m as { content?: unknown }).content;
    return typeof c === 'string' && c.includes(SESSION_DIGEST_HEADER);
  });
}

/**
 * True iff the message was generated by the transformer's digest stage —
 * detected by the `synthetic: true` flag on the message, NOT by content
 * text-shape. Text-based detection is fundamentally spoofable: a user or
 * tool message whose content is exactly the digest block (zero surrounding
 * prose) would pass any `startsWith/endsWith` check and could be mistaken
 * for the transformer's own emission, causing merge-in-place to rewrite
 * user content and the persistence sink to store user-controlled state as
 * the next turn's prior (PR #574 review). The flag is set by both surface
 * factories (`app/src/lib/orchestrator.ts:createSessionDigestMessage` and
 * the CLI engine's analogous factory) and cannot be set from user input
 * since user-facing message constructors don't expose it.
 *
 * Messages without the flag — whether legacy transcripts from before the
 * flag existed or user content quoting a digest block — return false. The
 * fallout for legacy: a session that compacted before this change won't
 * merge in place on the next turn, only the new option-based
 * `priorSessionDigest` carries continuity. Acceptable; the alternative
 * (keeping text-shape detection as a fallback) reopens the spoof.
 */
export function isSyntheticDigestMessage<M>(msg: M): boolean {
  return (msg as { synthetic?: boolean })?.synthetic === true;
}
