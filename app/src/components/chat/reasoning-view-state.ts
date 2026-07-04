import type { MessageViewState } from '@/hooks/useMessageViewState';

/**
 * Policy for the reasoning disclosure's open state, extracted so it's testable
 * without a DOM (the suite is SSR-only). The pane auto-follows streaming until
 * the user toggles it, after which their choice is pinned — see
 * `useMessageViewState.reasoningUserSet`.
 */

/** Effective open state: the user's pinned choice, else follow streaming. */
export function reasoningPaneOpen(
  view: Pick<MessageViewState, 'reasoningUserSet' | 'reasoningExpanded'>,
  isStreaming: boolean,
): boolean {
  return view.reasoningUserSet ? view.reasoningExpanded : isStreaming;
}

/**
 * The view-state patch for a manual toggle. Always sets `reasoningUserSet` so
 * the choice pins and the streaming auto-open stops fighting it — dropping that
 * pin is the regression this shape guards against.
 */
export function reasoningTogglePatch(
  open: boolean,
): Pick<MessageViewState, 'reasoningExpanded' | 'reasoningUserSet'> {
  return { reasoningExpanded: open, reasoningUserSet: true };
}
