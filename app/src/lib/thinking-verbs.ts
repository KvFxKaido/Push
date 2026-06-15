/**
 * Thinking-phase spinner verbs.
 *
 * Deliberately minimal: the status bar rotates between these while the model
 * is in pre-response "dead air", and switches to the static "Responding…"
 * phase once tokens start landing. This replaced the per-repo themed "vibe
 * verbs" — a classification layer (`repo-vibe-verbs`) whose only job was
 * picking cute language/domain-specific verbs we no longer show.
 *
 * Shared array — callers rotate over it and must not mutate.
 */
export const THINKING_VERBS: string[] = ['Thinking…', 'Reasoning…'];
