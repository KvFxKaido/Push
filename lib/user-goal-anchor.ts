/**
 * User-goal anchor injected near the recent tail after context compaction.
 *
 * Push's compactor preserves the first user turn through every drop/summarize
 * pass, so the seed ask is never lost. What *is* lost is *proximity*: after a
 * compaction the model sees the seed adjacent to a [CONTEXT DIGEST] block, with
 * ~15 recent turns between it and the current user message. By the time the
 * model reads the latest ask the original goal is far behind.
 *
 * This module produces a small synthetic block — `[USER_GOAL]` — that the
 * context transformer drops in just before the last message whenever
 * compaction has run (this turn or previously). The model gets a fresh goal
 * reminder at maximum recency.
 *
 * v1 derives the goal verbatim from the first user turn (truncated). v2 adds
 * a user-editable `goal.md` file backing — see `cli/user-goal-file.ts`. The
 * anchor block shape grows backward-compatibly: v1 transcripts' anchor text
 * stays a prefix of v2's, preserving prompt-cache stability when a
 * conversation upgrades mid-flight. Format pin lives in
 * `user-goal-anchor.test.ts`; extend it when fields are added.
 */

export const USER_GOAL_HEADER = '[USER_GOAL]';
export const USER_GOAL_FOOTER = '[/USER_GOAL]';

/** Marker the context manager emits when it compacts. Used to detect that a
 *  prior turn ran compaction even when the current turn didn't. */
export const USER_GOAL_COMPACTION_MARKER = '[CONTEXT DIGEST]';

/** Cap on the initial-ask line so the anchor stays small relative to the
 *  recent tail. ~500 chars matches the smallest packed-memory budget in
 *  `lib/context-memory-packing.ts`. */
export const USER_GOAL_MAX_INITIAL_ASK_CHARS = 500;

/** Section headings used in `goal.md`. Order is the canonical render order
 *  for the markdown file; the in-block anchor uses a parallel order with
 *  inline labels. Exported so the file writer + parser + format-pin tests
 *  share one vocabulary. */
export const GOAL_FILE_SECTION_TITLES = {
  initialAsk: 'Initial ask',
  currentWorkingGoal: 'Current working goal',
  constraints: 'Constraints',
  doNot: 'Do not',
  lastRefreshed: 'Last refreshed',
} as const;

const ELLIPSIS = '...';

export interface UserGoalAnchorInputs {
  /** First non-tool-result user turn from the transcript. Both surfaces have
   *  their own helpers to identify this; we accept the raw string so this
   *  module stays message-shape-agnostic. */
  firstUserTurn?: string | null;
  /** Active repo + branch context, when known. Web has this on the
   *  Conversation; CLI has it on the workspace snapshot. Both fields are
   *  individually optional. */
  branch?: {
    repoFullName?: string | null;
    name?: string | null;
  } | null;
}

export interface UserGoalAnchor {
  initialAsk: string;
  branchLabel?: string;
  /** Free-form description of where the conversation actually is right now,
   *  as opposed to where it started. v2 auto-seeds this from the first
   *  compaction digest; the user owns subsequent edits. */
  currentWorkingGoal?: string;
  /** Things the agent must respect — guardrails the user wants surfaced. */
  constraints?: string[];
  /** Anti-goals — explicit things the agent should avoid. Kept separate
   *  from `constraints` because the model treats negatives differently
   *  from positives and the distinction is load-bearing in practice. */
  doNot?: string[];
  /** ISO-8601 timestamp of the last write. Lets the model judge staleness
   *  ("the goal was set 40 turns ago — has it drifted?") and gives the
   *  user something concrete to look at when deciding whether to rewrite. */
  lastRefreshedAt?: string;
}

/**
 * Build a UserGoalAnchor from seed inputs. Returns null when there is no
 * usable seed — callers should treat null as "no anchor for this turn"
 * and skip injection rather than emit an empty block.
 */
export function deriveUserGoalAnchor(inputs: UserGoalAnchorInputs): UserGoalAnchor | null {
  const seed = (inputs.firstUserTurn ?? '').trim();
  if (!seed) return null;

  const initialAsk = truncateInitialAsk(seed);
  const branchLabel = formatBranchLabel(inputs.branch);

  return branchLabel ? { initialAsk, branchLabel } : { initialAsk };
}

/**
 * Format an anchor as the `[USER_GOAL] ... [/USER_GOAL]` text block.
 *
 * Order is fixed:
 *   Initial ask (always first)
 *   Branch (optional, v1)
 *   Current working goal (optional, v2)
 *   Constraints (optional, v2)
 *   Do not (optional, v2)
 *   Last refreshed (optional, v2)
 *
 * v2 fields slot in *after* v1 fields so an upgraded transcript's anchor
 * remains a prefix of the v2 anchor — providers caching on the prompt
 * prefix keep hitting cache when only v2 fields are appended.
 */
export function formatUserGoalBlock(anchor: UserGoalAnchor): string {
  const lines: string[] = [USER_GOAL_HEADER];
  lines.push(`Initial ask: ${anchor.initialAsk}`);
  if (anchor.branchLabel) lines.push(`Branch: ${anchor.branchLabel}`);
  if (anchor.currentWorkingGoal) {
    lines.push(`Current working goal: ${anchor.currentWorkingGoal}`);
  }
  if (anchor.constraints && anchor.constraints.length > 0) {
    lines.push(`Constraints: ${anchor.constraints.join('; ')}`);
  }
  if (anchor.doNot && anchor.doNot.length > 0) {
    lines.push(`Do not: ${anchor.doNot.join('; ')}`);
  }
  if (anchor.lastRefreshedAt) {
    lines.push(`Last refreshed: ${anchor.lastRefreshedAt}`);
  }
  lines.push(USER_GOAL_FOOTER);
  return lines.join('\n');
}

/**
 * Render an anchor as the on-disk `goal.md` markdown. Inverse of
 * `parseUserGoalMarkdown` for canonical content. Empty optional fields
 * still emit their heading + blank body so the user has a visible slot to
 * fill in when they open the file.
 */
export function formatUserGoalMarkdown(anchor: UserGoalAnchor): string {
  const out: string[] = ['# Goal', ''];

  out.push(`## ${GOAL_FILE_SECTION_TITLES.initialAsk}`, '', anchor.initialAsk, '');

  out.push(
    `## ${GOAL_FILE_SECTION_TITLES.currentWorkingGoal}`,
    '',
    anchor.currentWorkingGoal ?? '',
    '',
  );

  out.push(`## ${GOAL_FILE_SECTION_TITLES.constraints}`, '');
  if (anchor.constraints && anchor.constraints.length > 0) {
    for (const item of anchor.constraints) out.push(`- ${item}`);
  }
  out.push('');

  out.push(`## ${GOAL_FILE_SECTION_TITLES.doNot}`, '');
  if (anchor.doNot && anchor.doNot.length > 0) {
    for (const item of anchor.doNot) out.push(`- ${item}`);
  }
  out.push('');

  if (anchor.lastRefreshedAt) {
    out.push(`## ${GOAL_FILE_SECTION_TITLES.lastRefreshed}`, '', anchor.lastRefreshedAt, '');
  }

  // Trim trailing blank lines but keep one terminating newline.
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  out.push('');
  return out.join('\n');
}

/**
 * Parse a `goal.md` file. Lenient: unknown sections are ignored, missing
 * sections become undefined, list bodies parse as bullet items, prose
 * bodies join with single newlines. Returns null when the file has no
 * `Initial ask` section — without that the anchor would have no seed and
 * we'd rather fall back to runtime derivation than emit a half-built
 * block.
 *
 * Round-trip stability: `parseUserGoalMarkdown(formatUserGoalMarkdown(a))`
 * equals `a` for canonical content (no extra whitespace, list items have
 * no nested blank lines). The format-pin test pins one canonical example.
 */
export function parseUserGoalMarkdown(content: string): UserGoalAnchor | null {
  const sections = splitMarkdownSections(content);
  const initialAskRaw = sections.get(GOAL_FILE_SECTION_TITLES.initialAsk);
  // A present but whitespace-only `## Initial ask` section parses as ''
  // after collapse — null out so callers fall back to the v1 runtime
  // derivation instead of emitting an empty `[USER_GOAL]` block.
  const initialAskTrimmed = initialAskRaw ? collapseProseBody(initialAskRaw) : '';
  if (!initialAskTrimmed) return null;

  // Apply the same cap to file-parsed seeds that runtime derivation
  // applies, so a user-edited `goal.md` (or stale auto-seed from before
  // the cap was enforced) can't blow the anchor budget.
  const anchor: UserGoalAnchor = {
    initialAsk: truncateInitialAsk(initialAskTrimmed),
  };

  const currentWorkingGoal = sections.get(GOAL_FILE_SECTION_TITLES.currentWorkingGoal);
  if (currentWorkingGoal) {
    const body = collapseProseBody(currentWorkingGoal);
    if (body) anchor.currentWorkingGoal = body;
  }

  const constraints = sections.get(GOAL_FILE_SECTION_TITLES.constraints);
  if (constraints) {
    const items = extractBulletItems(constraints);
    if (items.length > 0) anchor.constraints = items;
  }

  const doNot = sections.get(GOAL_FILE_SECTION_TITLES.doNot);
  if (doNot) {
    const items = extractBulletItems(doNot);
    if (items.length > 0) anchor.doNot = items;
  }

  const lastRefreshed = sections.get(GOAL_FILE_SECTION_TITLES.lastRefreshed);
  if (lastRefreshed) {
    const body = collapseProseBody(lastRefreshed);
    if (body) anchor.lastRefreshedAt = body;
  }

  return anchor;
}

/**
 * Cap an initial-ask string to `USER_GOAL_MAX_INITIAL_ASK_CHARS`, appending
 * an ellipsis when truncation occurs. Shared between runtime derivation,
 * file parsing, and file seeding so every code path that produces an
 * `initialAsk` honours the same budget.
 */
export function truncateInitialAsk(seed: string): string {
  if (seed.length <= USER_GOAL_MAX_INITIAL_ASK_CHARS) return seed;
  const sliceLen = USER_GOAL_MAX_INITIAL_ASK_CHARS - ELLIPSIS.length;
  return seed.slice(0, sliceLen).trimEnd() + ELLIPSIS;
}

function formatBranchLabel(branch: UserGoalAnchorInputs['branch']): string | undefined {
  if (!branch) return undefined;
  const repo = (branch.repoFullName ?? '').trim();
  const name = (branch.name ?? '').trim();
  if (!repo && !name) return undefined;
  if (repo && name) return `${repo}@${name}`;
  return name || repo;
}

/**
 * Split a markdown document into a Map<sectionTitle, body>, keyed by the
 * exact heading text after `## `. The H1 (`# Goal`) is ignored. Unknown
 * sections are kept (the caller filters); leading/trailing blank lines in
 * bodies are stripped but interior blank lines survive.
 */
function splitMarkdownSections(content: string): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  let currentTitle: string | null = null;
  let currentBody: string[] = [];

  const flush = () => {
    if (currentTitle === null) return;
    // Strip leading + trailing blank lines from the body.
    while (currentBody.length > 0 && currentBody[0].trim() === '') currentBody.shift();
    while (currentBody.length > 0 && currentBody[currentBody.length - 1].trim() === '') {
      currentBody.pop();
    }
    sections.set(currentTitle, currentBody.join('\n'));
  };

  for (const line of lines) {
    if (line.startsWith('## ')) {
      flush();
      currentTitle = line.slice(3).trim();
      currentBody = [];
    } else if (line.startsWith('# ')) {
      // H1 — ignored; resets section state defensively.
      flush();
      currentTitle = null;
      currentBody = [];
    } else if (currentTitle !== null) {
      currentBody.push(line);
    }
  }
  flush();

  return sections;
}

function collapseProseBody(body: string): string {
  return body.trim();
}

function extractBulletItems(body: string): string[] {
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('-') || line.startsWith('*'))
    .map((line) => line.replace(/^[-*]\s*/, '').trim())
    .filter((line) => line.length > 0);
}
