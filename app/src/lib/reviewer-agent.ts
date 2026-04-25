/**
 * App compatibility wrapper for the shared reviewer agent.
 *
 * The canonical module now lives in `lib/reviewer-agent.ts`. This wrapper
 * preserves the Web-side public API (no `resolveRuntimeContext` / `readSymbols`
 * fields in `ReviewerOptions`) by injecting the real implementations at the
 * call boundary. Existing Web call sites — including `reviewer-agent.test.ts`'s
 * `vi.mock('./role-memory-context')` and `vi.mock('./sandbox-client')` — keep
 * working unchanged because the mocks intercept this file's imports.
 *
 * Phase 6 of the PushStream gateway migration replaced the lib-side
 * `streamFn: ProviderStreamFn` option with `stream: PushStream<LlmMessage>`.
 * This wrapper bridges Web's existing `StreamChatFn` (a `ProviderStreamFn`-
 * shaped callback) into a PushStream, caching the result by underlying
 * streamFn identity so concurrent reviews share the same PushStream object —
 * keeps the lib's `reviewCoalesceKey` deduplication working across calls.
 */

import {
  runReviewer as runReviewerLib,
  type ReviewerOptions as LibReviewerOptions,
} from '@push/lib/reviewer-agent';
import {
  providerStreamFnToPushStream,
  type LlmMessage,
  type ProviderStreamFn,
  type PushStream,
} from '@push/lib/provider-contract';
import { buildReviewerRuntimeContext } from './role-memory-context';
import { readSymbolsFromSandbox } from './sandbox-client';
import type { AIProviderType, ReviewResult } from '@/types';
import type { StreamChatFn } from './orchestrator-provider-routing';
import type { ReviewerPromptContext } from './role-context';

export { annotateDiffWithLineNumbers, REVIEWER_CRITERIA_BLOCK } from '@push/lib/reviewer-agent';
export type { SandboxSymbol } from '@push/lib/reviewer-agent';

export interface ReviewerOptions {
  provider: AIProviderType;
  streamFn: StreamChatFn;
  modelId: string;
  context?: ReviewerPromptContext;
  sandboxId?: string;
}

const pushStreamCache = new WeakMap<ProviderStreamFn, PushStream<LlmMessage>>();
function bridgeStreamFn(streamFn: StreamChatFn): PushStream<LlmMessage> {
  // Contravariance-unsafe cast: Web's StreamChatFn carries ChatMessage but
  // reviewer only constructs LlmMessage values, and streamSSEChat reads
  // every ChatMessage-only field via optional chaining. See
  // lib/provider-contract.ts for the full runtime-safety rationale.
  const fn = streamFn as unknown as ProviderStreamFn<LlmMessage>;
  let push = pushStreamCache.get(fn);
  if (!push) {
    push = providerStreamFnToPushStream(fn);
    pushStreamCache.set(fn, push);
  }
  return push;
}

export async function runReviewer(
  diff: string,
  options: ReviewerOptions,
  onStatus: (phase: string) => void,
): Promise<ReviewResult> {
  const libOptions: LibReviewerOptions = {
    provider: options.provider,
    stream: bridgeStreamFn(options.streamFn),
    modelId: options.modelId,
    context: options.context,
    sandboxId: options.sandboxId,
    resolveRuntimeContext: buildReviewerRuntimeContext,
    readSymbols: readSymbolsFromSandbox,
  };
  return runReviewerLib(diff, libOptions, onStatus);
}
