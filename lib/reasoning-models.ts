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
 *   - `lib/deep-reviewer-agent.ts`— unconditional first-token grace for every
 *                                   model (DEEP_REVIEW_FIRST_TOKEN_GRACE_MS).
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
 *
 * Invariant: the families are mutually exclusive — no model id contains two of
 * `glm-5` / `kimi-k2` / `deepseek-r1` at once — so table *order is irrelevant*.
 * `isReasoningHeavyModel` is a `.some()` disjunction (order can't change a
 * boolean OR), and `reasoningHeavyFamily` returns the only match. Reordering
 * the table is therefore safe; no entry can shadow another.
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
    family: 'kimi-k3',
    pattern: /(?:^|[^a-z0-9])kimi-k3(?:[.p]\d+)?(?:[^0-9]|$)/,
    note: 'Moonshot Kimi-K3 — emitted a reasoning_content preamble on every gateway probe, including trivial prompts (first contact 2026-07-20). Native tool_calls were clean; the K2.x reasoning-channel burying was not observed but the recovery nudge stays as backstop.',
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

/**
 * Canonical first-token grace: how long an activity timer waits for the FIRST
 * sign of life before tightening to the per-round window. Sized for the slowest
 * legitimate start — connect/cold-queue plus a heavy reasoner's reasoning
 * preamble, which together run well past the 60s inter-token window on large
 * transcripts (proved out on glm-5.x).
 *
 * Single source of truth for that window, consumed two ways:
 *   - the Coder applies it *unconditionally* to every model — slow time-to-first-
 *     token (Workers AI kimi/glm) is not exclusive to registry-matched reasoners;
 *   - `reasoningHeavyStreamOpts` applies it only to registry-matched heavy
 *     reasoners, where the others (deep-reviewer, explorer) would otherwise give
 *     no grace at all.
 */
export const REASONING_HEAVY_FIRST_TOKEN_GRACE_MS = 90_000;

/**
 * `iteratePushStreamText` opts for an agent round that treats reasoning as
 * progress. Two layered concerns, deliberately split by which one may depend on
 * table completeness (see the module header):
 *
 *   - `reasoningResetsActivityTimer` is ALWAYS `true` here, model or not. A
 *     non-reasoner never emits `reasoning_delta`, so it's a no-op for them;
 *     gating it on the registry would silently re-expose a *reasoning* model
 *     not yet listed to the "unresponsive" kill. Liveness correctness must not
 *     depend on the table.
 *   - `firstTokenGraceMs` is the additive part, gated on the registry: a known
 *     heavy reasoner gets a wider window to produce its first token; every other
 *     model keeps the caller's single window (omitted ⇒ `iteratePushStreamText`
 *     falls back to `timeoutMs`). This can only *widen* a window, never tighten
 *     one, so an unlisted model is never worse off than before.
 *
 * Call sites that want an unconditional grace for ALL models intentionally do
 * NOT use this helper — both the Coder (`CODER_FIRST_TOKEN_GRACE_MS`) and the
 * deep reviewer (`DEEP_REVIEW_FIRST_TOKEN_GRACE_MS`) pass the grace inline for
 * every model, because slow time-to-first-token isn't exclusive to registry
 * reasoners (a non-heavy fugu round-7 review hit the flat 60s window, #1242).
 * Routing them through here would tighten their non-heavy models from 90s to the
 * per-round window, a regression.
 */
export function reasoningHeavyStreamOpts(modelId: string | null | undefined): {
  reasoningResetsActivityTimer: true;
  firstTokenGraceMs?: number;
} {
  return isReasoningHeavyModel(modelId)
    ? {
        reasoningResetsActivityTimer: true,
        firstTokenGraceMs: REASONING_HEAVY_FIRST_TOKEN_GRACE_MS,
      }
    : { reasoningResetsActivityTimer: true };
}

// ---------------------------------------------------------------------------
// Sparse-streaming model registry — a DISTINCT axis from reasoning-heavy.
// ---------------------------------------------------------------------------

/**
 * Sparse-streaming models are *live but quiet*: they orchestrate server-side
 * between user-visible tokens and stream output sparsely, with no
 * `reasoning_delta` during the gaps. Sakana Fugu is the case — multi-agent
 * orchestration behind a single `/v1/responses` endpoint — but the property,
 * not the name, is what matters.
 *
 * Why this is a separate table from reasoning-heavy: a heavy reasoner *streams
 * its thinking* (`reasoning_delta` resets the activity timer, so the
 * unconditional `reasoningResetsActivityTimer` keeps it alive). A sparse
 * streamer streams *nothing* during its gaps — the orchestration never reaches
 * us as reasoning — so reasoning-reset can't help. For these models an
 * inter-token activity timeout is the wrong tool entirely: a 60s gap is the
 * model *working*, not a hung stream, and we have no way to tell the two apart
 * from the wire. The per-round **wall-clock** is the only meaningful bound.
 *
 * This drives a LIVENESS-relevant relaxation, which the module header says must
 * not depend on table completeness. `effectiveActivityTimeoutMs` keeps that
 * invariant by being **widen-only**: an unlisted model is never worse off (it
 * keeps the default tight timeout), and the table only *improves* listed models
 * — it never tightens, so liveness correctness never *depends* on the table.
 * Same additive shape as `firstTokenGraceMs`.
 */
export interface SparseStreamingMatcher {
  family: string;
  pattern: RegExp;
  note: string;
}

export const SPARSE_STREAMING_MODEL_MATCHERS: readonly SparseStreamingMatcher[] = [
  {
    family: 'fugu',
    // Matches `fugu`, `fugu-ultra`, vendor-prefixed `sakana/fugu`. The lead-in /
    // tail guards keep it from matching inside an unrelated token.
    pattern: /(?:^|[^a-z0-9])fugu(?:[^a-z0-9]|$)/,
    note: 'Sakana Fugu — multi-agent orchestration behind /v1/responses; streams output_text sparsely with no reasoning_delta during server-side orchestration gaps, so the inter-token activity timeout killed otherwise-progressing deep-review rounds (#1242 round-7; the round-11 60s-activity death that prompted this).',
  },
];

/**
 * True when `modelId` names a known sparse-streaming (opaque-orchestration)
 * model. Defensive on a null/empty id (returns `false` — the conservative
 * default keeps the tight timeout). Case-insensitive, substring-anchored, so
 * vendor-prefixed and suffixed ids resolve the same as bare ones.
 */
export function isSparseStreamingModel(modelId: string | null | undefined): boolean {
  if (!modelId) return false;
  const normalized = modelId.toLowerCase();
  return SPARSE_STREAMING_MODEL_MATCHERS.some((m) => m.pattern.test(normalized));
}

/**
 * The effective per-round activity timeout for a model. **Widen-only:** a
 * sparse streamer relaxes its activity window up to the wall-clock so the
 * wall-clock becomes the sole per-round bound (inter-token silence is not a
 * stall for it); every other model keeps `defaultActivityMs`. Because it can
 * only RAISE the timeout (never lower it — `wallClockMs` is always the larger
 * value at the call sites), an unlisted model is never worse off and liveness
 * correctness never depends on table completeness. See the registry note above.
 */
export function effectiveActivityTimeoutMs(
  modelId: string | null | undefined,
  defaultActivityMs: number,
  wallClockMs: number,
): number {
  if (!isSparseStreamingModel(modelId)) return defaultActivityMs;
  return Math.max(defaultActivityMs, wallClockMs);
}

/**
 * The effective FIRST-TOKEN grace for a model — the companion to
 * `effectiveActivityTimeoutMs`. `iteratePushStreamText` uses a *separate*
 * window (`firstTokenGraceMs`) until the first activity, then the activity
 * timeout between tokens. A sparse streamer's worst case is *silence before
 * the first token* (it orchestrates server-side before emitting anything —
 * the forced-output synthesis round especially), so relaxing only the
 * post-first-token activity window leaves that quiet start bounded by the
 * default grace. Widen the grace to the wall-clock too, so BOTH windows
 * collapse onto the wall-clock and it's genuinely the sole per-round bound.
 * **Widen-only** (same invariant as the activity helper): every other model
 * keeps `defaultGraceMs`.
 */
export function effectiveFirstTokenGraceMs(
  modelId: string | null | undefined,
  defaultGraceMs: number,
  wallClockMs: number,
): number {
  if (!isSparseStreamingModel(modelId)) return defaultGraceMs;
  return Math.max(defaultGraceMs, wallClockMs);
}
