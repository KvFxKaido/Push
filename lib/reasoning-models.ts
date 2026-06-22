/**
 * Reasoning-heavy model registry — the single source of truth for "is this a
 * model that thinks for a long time before it speaks?"
 *
 * Heavy reasoners (the GLM-5 and Kimi-K2 families, DeepSeek-R1) legitimately
 * stream on the reasoning channel for tens of seconds — sometimes >60s on
 * large-transcript rounds — before the first user-visible `text_delta`. That
 * behavior was, until this module, encoded only as scattered prose in code
 * comments next to the spots that had to cope with it:
 *
 *   - `lib/coder-agent.ts`        — heavy-reasoner timer opt-in + the
 *                                   reasoning-answer promotion salvage.
 *   - `lib/deep-reviewer-agent.ts`— same timer opt-in; wrap-up pressure for an
 *                                   "investigation-hungry" glm-5.1.
 *   - `app/src/worker/run-host-do.ts` — TTFT measured off reasoning, not text.
 *
 * Centralizing the *which models* knowledge here means a new model family is a
 * one-line table edit with a test, not a fresh comment grafted onto each call
 * site. Consumers ask `isReasoningHeavyModel(modelId)`.
 *
 * What this predicate does and does NOT drive:
 *   - It DRIVES presentation affordances that should be more patient for a
 *     model known to think out loud — e.g. the "Thinking" status bar rotates a
 *     liveness verb during reasoning dead air instead of freezing on a static
 *     label (see `app/src/hooks/chat-stream-round.ts`).
 *   - It does NOT gate the stream activity-timer opt-in
 *     (`reasoningResetsActivityTimer`). That stays unconditionally on at the
 *     heavy-reasoner call sites: a non-reasoning model never emits
 *     `reasoning_delta`, so counting reasoning as activity is a no-op for it,
 *     whereas gating on this list would silently re-expose a *reasoning* model
 *     not yet in the table to the "model may be unresponsive" kill. Liveness
 *     correctness must not depend on table completeness; legibility may.
 *
 * Data-only + dependency-free so both the web app and CLI can import it without
 * pulling in surface-specific catalog logic (mirrors `lib/provider-models.ts`).
 */

/**
 * One entry per reasoning-heavy model family. `pattern` is matched against the
 * lower-cased model id; `family` is a stable handle for tests/logs; `note`
 * records why the family is here so the table stays self-documenting.
 *
 * Matching tolerates the id shapes Push actually sees across providers:
 *   - bare           `glm-5.1`, `kimi-k2.6`, `deepseek-r1`
 *   - vendor-prefixed `z-ai/glm-5.1:nitro`, `moonshotai/kimi-k2.5:nitro`
 *   - Fireworks `p`-decimals `glm-5p1`, `kimi-k2p7-code` (no dot in the slug)
 *   - bare family    `glm-5`, `glm-5-turbo`, `kimi-k2`
 *
 * The `(?:^|[^a-z0-9])` lead-in keeps `glm-5` from matching inside an unrelated
 * token, and the `(?:[.p]\d+)?(?:[^0-9]|$)` tail accepts a `.`/`p` minor
 * version (or none) without letting `glm-5` match `glm-50`. Crucially it does
 * NOT match the older `glm-4.x` line, which is not a heavy reasoner.
 */
export interface ReasoningHeavyMatcher {
  family: string;
  pattern: RegExp;
  note: string;
}

export const REASONING_HEAVY_MODEL_MATCHERS: readonly ReasoningHeavyMatcher[] = [
  {
    family: 'glm-5',
    pattern: /(?:^|[^a-z0-9])glm-5(?:[.p]\d+)?(?:[^0-9]|$)/,
    note: 'Zhipu GLM-5.x — streams reasoning >60s before first text on large rounds (PR #907/#908). Excludes glm-4.x.',
  },
  {
    family: 'kimi-k2',
    pattern: /(?:^|[^a-z0-9])kimi-k2(?:[.p]\d+)?(?:[^0-9]|$)/,
    note: 'Moonshot Kimi-K2.x — heavy reasoner; occasionally strands its answer in the reasoning channel (coder/deep-reviewer salvage).',
  },
  {
    family: 'deepseek-r1',
    pattern: /(?:^|[^a-z0-9])deepseek-r1(?:[^0-9]|$)/,
    note: 'DeepSeek-R1 — explicit reasoning model. deepseek-v3/v4 are deliberately NOT matched here (add on observed evidence).',
  },
];

/**
 * True when `modelId` names a known reasoning-heavy model family.
 *
 * Defensive on input: a null/undefined/empty id (provider not yet resolved,
 * free-text field left blank) returns `false` — the conservative default, so a
 * missing id never trips reasoning-heavy affordances. Matching is
 * case-insensitive and substring-anchored (see `REASONING_HEAVY_MODEL_MATCHERS`),
 * so vendor-prefixed and `:nitro`-suffixed ids resolve the same as bare ones.
 */
export function isReasoningHeavyModel(modelId: string | null | undefined): boolean {
  if (!modelId) return false;
  const normalized = modelId.toLowerCase();
  return REASONING_HEAVY_MODEL_MATCHERS.some((m) => m.pattern.test(normalized));
}

/**
 * The matched family handle for a model id, or `null` when none matches.
 * Useful for structured logs/telemetry that want to attribute a behavior to a
 * specific family rather than a bare boolean.
 */
export function reasoningHeavyFamily(modelId: string | null | undefined): string | null {
  if (!modelId) return null;
  const normalized = modelId.toLowerCase();
  return REASONING_HEAVY_MODEL_MATCHERS.find((m) => m.pattern.test(normalized))?.family ?? null;
}
