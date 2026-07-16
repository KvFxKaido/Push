/**
 * Routine activation — the shared vocabulary that maps a delivered event onto
 * the routines that want it.
 *
 * Design: docs/decisions/Watch-Schedule Activation — Proactive Routines Feed the Lead.md
 *
 * Two things live here and nowhere else:
 *
 *   1. `RoutineWatchEvent` — the closed vocabulary a routine's `watch:` list is
 *      written against. Event names are not free-form strings: a routine that
 *      watches something outside this union is a load error, not a routine that
 *      silently never fires.
 *   2. Classification and matching, both pure. Classification maps a delivered
 *      GitHub webhook (event name + payload shape) onto the vocabulary; matching
 *      is a lookup over declared `watch:` lists.
 *
 * Purity is the point. The webhook receiver is contractually cheap and
 * synchronous — it gates a delivery and hands off inside GitHub's ~10s budget
 * (see the `github-webhook.ts` header) — so anything it calls per delivery must
 * do no I/O. Both functions here are total and allocation-light for that reason.
 * When routines are sourced from repo-committed `.push/routines/*.md`, matching
 * needs a base-ref fetch and moves behind a Durable Object; this vocabulary is
 * what survives that move unchanged, which is why it lives in `lib/` rather than
 * beside the worker that is its only caller today.
 *
 * Deliberately NOT here:
 *
 *   - Authorization. Classification is payload-shape-only: `pr_comment` means "a
 *     comment landed on a PR", never "a comment we trust". Who may spend a
 *     routine stays the routine's own gate (`selectReviewableComment` checks
 *     `author_association`), and which installation may trigger one stays the
 *     receiver's. Folding either in here would put an auth decision behind a
 *     function whose name promises only a lookup.
 *   - The `capabilities` ceiling. It maps onto `lib/capabilities.ts` — the real
 *     permission vocabulary — and lands with the runtime that enforces it. An
 *     unenforced ceiling parsed into a field nothing reads is worse than no
 *     ceiling: it reads as a control that is in fact decorative.
 */

/**
 * The closed set of events a routine may declare in `watch:`.
 *
 * Coarse on purpose. These name *what happened*, not *what to do about it* —
 * `pr_comment` covers every comment on a PR, leaving "does this one carry the
 * trigger phrase, from someone allowed to spend a review" to the routine that
 * watches it. Classification stays a pure payload-shape read that way, and the
 * fine-grained decisions stay next to the routine that owns them.
 *
 * Grows only alongside a consumer. An event name nothing watches is vocabulary
 * that cannot be exercised, and the first routine to want it is the thing that
 * proves its payload mapping is right.
 */
export type RoutineWatchEvent = 'pr_opened' | 'pr_reopened' | 'pr_ready_for_review' | 'pr_comment';

/** All known watch events (for validation and iteration). */
export const ALL_ROUTINE_WATCH_EVENTS: readonly RoutineWatchEvent[] = [
  'pr_opened',
  'pr_reopened',
  'pr_ready_for_review',
  'pr_comment',
];

export function isRoutineWatchEvent(value: unknown): value is RoutineWatchEvent {
  return (
    typeof value === 'string' && (ALL_ROUTINE_WATCH_EVENTS as readonly string[]).includes(value)
  );
}

/**
 * `pull_request` actions that map onto the vocabulary.
 *
 * Deliberately excludes `synchronize` (a new commit pushed to the head branch).
 * A routine fires on a PR's first open — and on reopen / draft-becomes-ready,
 * which are the "first" moment for those flows — but not on every subsequent
 * commit. Re-firing per push is noisy, and the follow-up bots (and the author)
 * don't reliably re-read follow-up output anyway.
 *
 * This is the single source of truth for that exclusion: the webhook receiver's
 * reviewable-action check reads it rather than keeping a parallel set.
 *
 * A Map, not an object literal: the key is attacker-shaped (it is `action` off
 * an inbound payload), and plain-object lookup walks the prototype chain — so
 * `action: "constructor"` would resolve to a truthy `Function` and classify as
 * a valid event. `Map#get` has no prototype chain to walk.
 */
const PULL_REQUEST_ACTION_EVENTS: ReadonlyMap<string, RoutineWatchEvent> = new Map([
  ['opened', 'pr_opened'],
  ['reopened', 'pr_reopened'],
  ['ready_for_review', 'pr_ready_for_review'],
]);

/** Comment events that can carry an @-mention trigger. */
const COMMENT_EVENT_NAMES: ReadonlySet<string> = new Set([
  'issue_comment',
  'pull_request_review_comment',
]);

/**
 * Map a `pull_request` action onto the vocabulary, or null when the action is
 * one no routine can watch. Exported so the receiver's action gate and this
 * table can't drift apart.
 */
export function classifyPullRequestAction(
  action: string | null | undefined,
): RoutineWatchEvent | null {
  if (!action) return null;
  return PULL_REQUEST_ACTION_EVENTS.get(action) ?? null;
}

/**
 * The result of classifying a delivery. The `reason` on the miss arm is the
 * operator-facing skip string — it reaches GitHub's delivery log, which is the
 * one sink an operator can actually read (see the receiver's skip-body comment),
 * so it names *which* event or action was dropped rather than just "skipped".
 */
export type RoutineEventClassification =
  | { ok: true; event: RoutineWatchEvent }
  | { ok: false; reason: string };

/**
 * Classify a delivered GitHub webhook into the watch vocabulary.
 *
 * Pure: reads the event name and the payload's shape, touches no network, and
 * makes no trust decision. A miss carries the reason rather than a bare null so
 * the caller can name it without re-deriving why.
 */
export function classifyWebhookEvent(
  eventName: string | null | undefined,
  payload: unknown,
): RoutineEventClassification {
  if (!eventName) return { ok: false, reason: 'event:none' };

  if (COMMENT_EVENT_NAMES.has(eventName)) return { ok: true, event: 'pr_comment' };

  if (eventName === 'pull_request') {
    const action = (payload as { action?: string } | null | undefined)?.action ?? '';
    const event = classifyPullRequestAction(action);
    // `action:` with an empty tail is a real, distinct case (a `pull_request`
    // delivery with no action at all) and reads correctly in a delivery log.
    return event ? { ok: true, event } : { ok: false, reason: `action:${action}` };
  }

  return { ok: false, reason: `event:${eventName}` };
}

/**
 * A routine's machine contract — the frontmatter half of a `.push/routines/*.md`
 * file, and the shape a built-in routine declares in code.
 *
 * Carries only fields the runtime reads today. `capabilities` / `approval` /
 * `chat` from the design doc arrive with the code that enforces them.
 */
export interface RoutineDescriptor {
  /** Stable identifier; the filename stem for repo-sourced routines. */
  name: string;
  description: string;
  /** Events that fire this routine. Empty means it never activates on `watch`. */
  watch: readonly RoutineWatchEvent[];
}

/** Anything carrying a descriptor can be matched — built-ins attach a handler. */
export interface RoutineLike {
  descriptor: RoutineDescriptor;
}

/**
 * Every routine in `registry` that watches `event`, in registry order.
 *
 * Total on the miss arms — an unmatched event yields an empty array rather than
 * throwing — because "no routine wanted this" is an ordinary, loggable outcome
 * of a receiver that sees every delivery the App is subscribed to.
 */
export function matchRoutines<T extends RoutineLike>(
  event: RoutineWatchEvent,
  registry: readonly T[],
): T[] {
  return registry.filter((routine) => routine.descriptor.watch.includes(event));
}
