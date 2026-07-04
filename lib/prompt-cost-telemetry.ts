/**
 * Prompt-composition cost telemetry.
 *
 * Instrumentation pass behind the "MCP/tool schema deferral" decision
 * (`docs/decisions/Claude Code In-App Patterns — Lessons For Push.md`, §5).
 * Before inventing a names-only manifest + on-hit schema loading, we need
 * two numbers from real deployments:
 *
 *   1. **Savings side** — how many bytes/tokens the always-injected GitHub
 *      tool protocol and the per-turn project-instructions block actually
 *      cost in the system prompt. Emitted as `prompt_composition_cost`,
 *      one line per orchestrator prompt build.
 *   2. **Tax side** — how often a repo-mode turn that paid for the GitHub
 *      protocol actually calls a GitHub tool. Deferral trades a smaller
 *      prompt for a "schema needed" round-trip on first use, so the win is
 *      only real if a meaningful fraction of turns never touch the tools.
 *      Emitted as the symmetric pair `github_tool_turn_used` ↔
 *      `github_tool_turn_idle`, one line per repo turn.
 *
 * The two streams share `chatId` + `round`, so a consumer can join cost to
 * usage per turn (or just compare counts per chat for the fraction).
 *
 * These are structured **ops logs** (`console.log(JSON.stringify(...))`),
 * not protocol envelopes or run events — they don't cross the web/CLI wire,
 * so they live here as a single canonical emitter shared by both surfaces
 * rather than as a protocol-schema type. Event names are pinned by
 * `prompt-cost-telemetry.test`.
 */

/** Per-turn byte + token breakdown of the always-on prompt blocks under
 *  scrutiny. Bytes are exact (`String.length`); tokens are the caller's
 *  estimate (provider-agnostic heuristic) — directional, not billing. */
export interface PromptCompositionCost {
  /** Total system-prompt size, all sections. */
  systemPromptBytes: number;
  /** Size of the injected GitHub tool protocol block, 0 when absent
   *  (chat/scratch mode, or GitHub tools disabled). */
  githubProtocolBytes: number;
  /** Size of the `[PROJECT_INSTRUCTIONS …]…[/PROJECT_INSTRUCTIONS]` block
   *  folded into the environment section, 0 when no instructions loaded. */
  projectInstructionsBytes: number;
  systemPromptTokens: number;
  githubProtocolTokens: number;
  projectInstructionsTokens: number;
}

/** Canonical event names. Pinned by the drift test so the measurement
 *  vocabulary stays greppable across deployments. */
export const PROMPT_COST_EVENT = 'prompt_composition_cost' as const;
export const GITHUB_TOOL_TURN_USED_EVENT = 'github_tool_turn_used' as const;
export const GITHUB_TOOL_TURN_IDLE_EVENT = 'github_tool_turn_idle' as const;

/**
 * Extract a marker-delimited block from `text`, including the markers
 * themselves (that's the real injected cost). Returns null when either
 * marker is absent or they're mis-ordered.
 *
 * Used to isolate the `[PROJECT_INSTRUCTIONS …]` block from the rest of the
 * environment section without threading its length through the caller —
 * the block is composed upstream (web: `useProjectInstructions`) and folded
 * into the workspace description before the prompt builder sees it. Returning
 * the substring (not just its length) lets the caller token-estimate the real
 * text instead of guessing tokens from bytes.
 */
export function extractMarkedBlock(
  text: string,
  openMarker: string,
  closeMarker: string,
): string | null {
  if (!text) return null;
  const start = text.indexOf(openMarker);
  if (start === -1) return null;
  const end = text.indexOf(closeMarker, start + openMarker.length);
  if (end === -1) return null;
  return text.slice(start, end + closeMarker.length);
}

/** Context shared by both emitters so cost and usage join per turn, and so a
 *  single consumer can aggregate across surfaces. */
export interface PromptTurnRef {
  /** Which surface emitted this — disambiguates how `scopeId` and `mode` are
   *  interpreted (web caps project instructions at 5k, CLI at 8k, so the
   *  byte-cost question is surface-sensitive). */
  surface: 'web' | 'cli';
  /** Durable per-conversation/run identifier to group by. Web passes the
   *  `chatId`; CLI passes the `sessionId`. */
  scopeId: string;
  round: number;
  /** Workspace mode. Web: `repo` / `chat` / `scratch` / `relay`.
   *  CLI: the local workspace mode label. Disambiguates which turns carried
   *  the GitHub protocol. */
  mode: string;
}

/**
 * Emit the per-turn prompt-composition cost. One line per orchestrator
 * prompt build, including turns where the GitHub/project blocks are absent
 * (zeros) — the absence is itself signal, not a branch to suppress.
 */
export function emitPromptCompositionCost(ref: PromptTurnRef, cost: PromptCompositionCost): void {
  console.log(
    JSON.stringify({
      level: 'info',
      event: PROMPT_COST_EVENT,
      surface: ref.surface,
      scopeId: ref.scopeId,
      round: ref.round,
      mode: ref.mode,
      systemPromptBytes: cost.systemPromptBytes,
      githubProtocolBytes: cost.githubProtocolBytes,
      projectInstructionsBytes: cost.projectInstructionsBytes,
      systemPromptTokens: cost.systemPromptTokens,
      githubProtocolTokens: cost.githubProtocolTokens,
      projectInstructionsTokens: cost.projectInstructionsTokens,
    }),
  );
}

/**
 * Emit the per-turn GitHub-tool usage verdict for a repo turn that carried
 * the protocol. Symmetric pair — `used` when the model called ≥1 GitHub
 * tool this turn, `idle` otherwise — so neither outcome is invisible and
 * the deferral round-trip tax can be sized from counts:
 * `used / (used + idle)` is the fraction of protocol-paying turns that
 * actually needed a GitHub tool.
 *
 * Call only for turns where the protocol was injected — otherwise the
 * `idle` denominator is polluted by turns that never had the tools.
 */
export function emitGithubToolTurnUsage(
  ref: PromptTurnRef,
  counts: { githubCalls: number; totalCalls: number },
): void {
  console.log(
    JSON.stringify({
      level: 'info',
      event: counts.githubCalls > 0 ? GITHUB_TOOL_TURN_USED_EVENT : GITHUB_TOOL_TURN_IDLE_EVENT,
      surface: ref.surface,
      scopeId: ref.scopeId,
      round: ref.round,
      mode: ref.mode,
      githubCalls: counts.githubCalls,
      totalCalls: counts.totalCalls,
    }),
  );
}
