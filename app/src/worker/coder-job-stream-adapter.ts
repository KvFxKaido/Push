/**
 * Provider stream-fn adapter for the CoderJob Durable Object.
 *
 * Same adapter-seam pattern as the detector and executor adapters in
 * this directory. The DO consumes `ProviderStreamFn` through a single
 * injection point so PR #3 can swap a stubbed stream for a real one
 * without touching the DO class.
 *
 * PR #2 ships a production stub that immediately fails via `onError`
 * with a clear diagnostic. Real provider streaming from a DO requires
 * an absolute-URL SSE reader (fetch + ReadableStream → chunks) targeted
 * at `/api/<provider>/chat` on the Worker's own origin. That's ~80
 * lines of stream-parsing code that belongs in a shared `lib/`
 * module so Web and DO share one implementation — scheduled for PR #4
 * alongside the detector + executor extractions.
 *
 * Tests inject a `ProviderStreamFn` stub directly and do not exercise
 * this production path.
 */

import type { AIProviderType, ProviderStreamFn } from '@push/lib/provider-contract';
import type { ChatMessage } from '@/types';

export interface CoderJobStreamAdapterArgs {
  origin: string;
  provider: AIProviderType;
  modelId: string | undefined;
}

export function createWebStreamAdapter(
  args: CoderJobStreamAdapterArgs,
): ProviderStreamFn<ChatMessage> {
  void args;

  // PR #2: hard-fails via onError so a caller who accidentally runs a
  // real job before PR #3 gets a clear error instead of a silent hang.
  return async (_messages, _onToken, _onDone, onError) => {
    onError(
      new Error(
        'Background-job provider streaming not yet wired (Phase 1 PR #2). ' +
          'Real streamFn lands in PR #4 as part of the lib/provider-stream extraction.',
      ),
    );
  };
}
