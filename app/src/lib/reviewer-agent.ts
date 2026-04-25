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
 * Phase 9 of the PushStream gateway migration: the Web shim now resolves
 * the PushStream from `getProviderPushStream(provider)` directly — the lib
 * kernel's `reviewCoalesceKey` is keyed on the PushStream identity, and
 * `getProviderPushStream` returns the same provider PushStream factory for
 * a given `ActiveProvider` per call site, so concurrent identical reviews
 * still dedupe without a per-shim WeakMap cache.
 */

import {
  runReviewer as runReviewerLib,
  type ReviewerOptions as LibReviewerOptions,
} from '@push/lib/reviewer-agent';
import { buildReviewerRuntimeContext } from './role-memory-context';
import { readSymbolsFromSandbox } from './sandbox-client';
import type { ReviewResult } from '@/types';
import type { LlmMessage, PushStream } from '@push/lib/provider-contract';
import { getProviderPushStream, type ActiveProvider } from './orchestrator';
import type { ReviewerPromptContext } from './role-context';

export { annotateDiffWithLineNumbers, REVIEWER_CRITERIA_BLOCK } from '@push/lib/reviewer-agent';
export type { SandboxSymbol } from '@push/lib/reviewer-agent';

export interface ReviewerOptions {
  provider: ActiveProvider;
  modelId: string;
  context?: ReviewerPromptContext;
  sandboxId?: string;
}

export async function runReviewer(
  diff: string,
  options: ReviewerOptions,
  onStatus: (phase: string) => void,
): Promise<ReviewResult> {
  const libOptions: LibReviewerOptions = {
    provider: options.provider,
    stream: getProviderPushStream(options.provider) as unknown as PushStream<LlmMessage>,
    modelId: options.modelId,
    context: options.context,
    sandboxId: options.sandboxId,
    resolveRuntimeContext: buildReviewerRuntimeContext,
    readSymbols: readSymbolsFromSandbox,
  };
  return runReviewerLib(diff, libOptions, onStatus);
}
