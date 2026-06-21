/**
 * Provider failover decision kernel (shared web + CLI).
 *
 * Push locks one provider/model per chat (Orchestrator locks on first send;
 * Coder/Explorer inherit — see ARCHITECTURE.md). That lock is correct for
 * steady state, but it means a *single* transient upstream failure — a gateway
 * 5xx, a 429, an expired key — kills the whole turn even when other configured
 * providers could have served it. new-api (QuantumNous/new-api), a Go LLM
 * gateway, treats this as table stakes: weighted multi-channel routing with
 * automatic failover. This kernel is Push's lock-respecting analogue.
 *
 * Scope (v1): failover rescues the CURRENT round only. It does NOT mutate the
 * chat lock. Rationale: the lock encodes user intent plus capability guarantees
 * (e.g. Anthropic signed-reasoning round-trip). Permanently swapping the user's
 * chosen provider because of one blip is surprising; round-scoped failover is
 * the minimal, least-surprising recovery. If the primary stays down, the next
 * round re-tries it first (cheap if it recovered) and fails over again.
 *
 * This module is intentionally PURE and free of app-side types: callers pass a
 * pre-extracted `StreamErrorClassification` (so it never imports the app-side
 * `ProviderStreamError`) and a pre-filtered, capability-checked candidate list
 * (so the reasoning-block compatibility hazard — never send Anthropic signed
 * thinking to an OpenAI-shaped provider — is resolved at the call site that has
 * the message history, not here). Keeping both seams at the boundary is what
 * lets the same kernel back the web round loop and the CLI lead turn.
 *
 * One source of truth per vocabulary (CLAUDE.md new-feature checklist rule 3):
 * the failover decision lives here; `provider-failover.test.ts` pins it.
 */

/**
 * Pre-extracted classification of a provider stream failure. Mirrors the two
 * structured fields the app's `ProviderStreamError` already exposes
 * (`retryable`, `status`) so the caller hands those over verbatim rather than
 * re-deriving from message text (the fragile HTTP-status anti-pattern called
 * out in CLAUDE.md).
 */
export interface StreamErrorClassification {
  /**
   * Transient — the SAME provider may recover on retry (5xx / 429 / 408 / 425,
   * or a stall/timeout the stream iterator flagged). Drives `retry-same`.
   */
  readonly retryable: boolean;
  /** HTTP status when the failure came from a provider HTTP error, else undefined. */
  readonly status?: number;
}

/**
 * Whether a DIFFERENT provider could plausibly survive this error even when
 * retrying the same one is pointless.
 *
 * - Every transient error (`retryable`) is failover-worthy: if provider A's
 *   gateway is down or rate-limited, provider B's may not be.
 * - Auth (401/403): the failing key/credential is per-provider, so another
 *   provider with its own key is unaffected.
 * - Not-found (404): typically a model absent on THIS provider; another may
 *   carry an equivalent model.
 *
 * Excluded: 400 / 422 (malformed/invalid request). That's a defect in the
 * request body itself and fails identically everywhere — failing over just
 * burns a second provider's quota to reproduce the same error.
 */
export function isFailoverWorthy(c: StreamErrorClassification): boolean {
  if (c.retryable) return true;
  if (c.status == null) return false;
  return c.status === 401 || c.status === 403 || c.status === 404;
}

export type FailoverDecision =
  | { readonly action: 'retry-same'; readonly delayMs: number }
  | { readonly action: 'failover'; readonly provider: string }
  | { readonly action: 'give-up'; readonly reason: GiveUpReason };

/**
 * Why we stopped. Surfaced for the structured log so ops can distinguish a
 * user cancel from an exhausted-candidates dead end from a non-failover-worthy
 * terminal error — three branches the caller otherwise can't tell apart.
 */
export type GiveUpReason =
  | 'aborted' // user cancelled
  | 'has-output' // tokens already streamed this round — re-attempt would duplicate
  | 'terminal-error' // not failover-worthy (e.g. 400/422)
  | 'candidates-exhausted'; // failover-worthy, but every candidate was already tried

export interface FailoverInput {
  readonly classification: StreamErrorClassification;
  /** User cancelled (during the attempt or a backoff window). */
  readonly aborted: boolean;
  /**
   * Any assistant-visible side effect already landed this round (streamed text,
   * thinking, signed reasoning blocks, citations). When true, NO re-attempt is
   * safe on any provider — it would duplicate/rewrite visible output or strand
   * a signed-thinking sidecar. Same constraint the existing same-provider retry
   * enforces in `shouldRetryStreamRound`.
   */
  readonly hasOutput: boolean;
  /** 0-based count of attempts ALREADY made on the current provider this round. */
  readonly sameProviderAttempt: number;
  /** Max same-provider retries before we consider failing over. */
  readonly sameProviderMax: number;
  /**
   * Providers already attempted this round, including the locked one. The
   * locked provider MUST be present so we never fail over back onto it.
   */
  readonly tried: ReadonlySet<string>;
  /**
   * Ordered, pre-filtered failover candidates: configured (has key) AND
   * capability-compatible with the message history (the caller resolves both).
   * First not-yet-tried entry wins.
   */
  readonly candidates: readonly string[];
  /** Backoff to apply before a same-provider retry at this attempt. */
  readonly retryDelayMs: number;
}

/**
 * Decide what to do after a provider stream failure: retry the same provider,
 * fail over to the next candidate, or give up.
 *
 * Order of precedence:
 *   1. Unsafe-to-reattempt guards (abort / output-already-streamed) → give-up.
 *   2. Same-provider transient retry while budget remains → retry-same
 *      (cheapest recovery, preserves the lock).
 *   3. Failover-worthy error with an untried candidate → failover.
 *   4. Otherwise → give-up (terminal error, or candidates exhausted).
 */
export function decideStreamFailover(input: FailoverInput): FailoverDecision {
  const { classification, aborted, hasOutput } = input;

  if (aborted) return { action: 'give-up', reason: 'aborted' };
  if (hasOutput) return { action: 'give-up', reason: 'has-output' };

  // Same-provider transient retry first.
  if (classification.retryable && input.sameProviderAttempt < input.sameProviderMax) {
    return { action: 'retry-same', delayMs: input.retryDelayMs };
  }

  // Failover only for errors a different provider could plausibly survive.
  if (isFailoverWorthy(classification)) {
    const next = input.candidates.find((p) => !input.tried.has(p));
    if (next) return { action: 'failover', provider: next };
    return { action: 'give-up', reason: 'candidates-exhausted' };
  }

  return { action: 'give-up', reason: 'terminal-error' };
}
