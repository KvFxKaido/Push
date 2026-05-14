/**
 * App compatibility wrapper for the shared deep reviewer agent.
 *
 * The canonical module now lives in `lib/deep-reviewer-agent.ts`. This
 * wrapper preserves the Web-side public API so existing call sites — the
 * `HubReviewTab` chat integration and `deep-reviewer-agent.test.ts` — keep
 * working unchanged. It injects the six DI points the lib kernel needs at
 * the call boundary:
 *
 * 1. `userProfile`           — `getUserProfile()` from `@/hooks/useUserProfile`
 * 2. `resolveRuntimeContext` — `buildReviewerRuntimeContext` from `./role-memory-context`
 * 3. `toolExec`              — curried `executeReadOnlyTool` over per-run bindings
 * 4. `detectAllToolCalls`    — real function from `./tool-dispatch`
 * 5. `detectAnyToolCall`     — real function from `./tool-dispatch`
 * 6. `webSearchToolProtocol` — `WEB_SEARCH_TOOL_PROTOCOL` from `./web-search-tools`
 *
 * The `'demo'` provider guard stays here — the lib kernel assumes a real
 * provider and rejecting demo is a Web-layer concern.
 */

import {
  runDeepReviewer as runDeepReviewerLib,
  type DeepReviewerOptions as LibDeepReviewerOptions,
} from '@push/lib/deep-reviewer-agent';
import type { ChatCard, DeepReviewCallbacks, ReviewResult } from '@/types';
import { getUserProfile } from '@/hooks/useUserProfile';
import { detectAllToolCalls, detectAnyToolCall, type AnyToolCall } from './tool-dispatch';
import { createExplorerToolHooks } from './explorer-agent';
import { buildReviewerRuntimeContext } from './role-memory-context';
import { executeReadOnlyTool } from './agent-loop-utils';
import { WEB_SEARCH_TOOL_PROTOCOL } from './web-search-tools';
import type { LlmMessage, PushStream } from '@push/lib/provider-contract';
import { getProviderPushStream, type ActiveProvider } from './orchestrator';
import type { ReviewerPromptContext } from './role-context';

export interface DeepReviewerOptions {
  provider: ActiveProvider;
  modelId: string;
  context?: ReviewerPromptContext;
  sandboxId?: string;
  allowedRepo: string;
  branchContext?: {
    activeBranch: string;
    defaultBranch: string;
    protectMain: boolean;
  };
  projectInstructions?: string;
  instructionFilename?: string;
}

export async function runDeepReviewer(
  diff: string,
  options: DeepReviewerOptions,
  callbacks: DeepReviewCallbacks,
): Promise<ReviewResult> {
  if (options.provider === 'demo') {
    throw new Error('No AI provider configured. Add an API key in Settings.');
  }

  // Per-run bindings — the tool executor needs allowedRepo / sandboxId /
  // activeProvider / modelId / hooks, so these must be constructed inside
  // `runDeepReviewer` at call time (same pattern Phase 3 reviewer uses).
  const allowedRepo = options.allowedRepo;
  const sandboxId = options.sandboxId ?? null;
  const activeProvider = options.provider as Exclude<ActiveProvider, 'demo'>;
  const modelId = options.modelId;
  const hooks = createExplorerToolHooks();

  const libOptions: LibDeepReviewerOptions<AnyToolCall, ChatCard> = {
    provider: options.provider,
    stream: getProviderPushStream(options.provider) as unknown as PushStream<LlmMessage>,
    modelId: options.modelId,
    context: options.context,
    sandboxId: options.sandboxId,
    allowedRepo: options.allowedRepo,
    branchContext: options.branchContext,
    projectInstructions: options.projectInstructions,
    instructionFilename: options.instructionFilename,
    userProfile: getUserProfile(),
    resolveRuntimeContext: buildReviewerRuntimeContext,
    toolExec: (call) =>
      executeReadOnlyTool(call, allowedRepo, sandboxId, activeProvider, modelId, hooks, {
        role: 'reviewer',
      }),
    detectAllToolCalls,
    detectAnyToolCall,
    webSearchToolProtocol: WEB_SEARCH_TOOL_PROTOCOL,
  };

  return runDeepReviewerLib(diff, libOptions, callbacks);
}
