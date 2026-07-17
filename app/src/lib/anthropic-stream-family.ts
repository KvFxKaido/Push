/**
 * Client-side transport-family adapter for providers that expose Anthropic
 * Messages semantics through a Push Worker proxy.
 *
 * Provider leaves keep endpoint, credentials, native-search availability, and
 * pause policy declarative. The cross-shell replay state machine lives in
 * `lib/anthropic-pause-continuation.ts`, separate from this web transport.
 */

import type { ChatMessage, WorkspaceContext } from '@/types';
import {
  completeAnthropicStreamWithoutPause,
  continueAnthropicPauseTurns,
} from '@push/lib/anthropic-pause-continuation';
import { anthropicEventStream } from '@push/lib/anthropic-bridge';
import type {
  AIProviderType,
  PushStreamEvent,
  PushStreamRequest,
} from '@push/lib/provider-contract';
import { toPushStreamWire } from '@push/lib/provider-wire';
import { resolvePushCapabilityProfile } from './model-catalog';
import { toLLMMessages } from './orchestrator';
import { buildProviderStreamHeaders, postProviderStream } from './provider-stream-fetch';
import { KNOWN_TOOL_NAMES } from './tool-dispatch';
import { isNativeWebSearchEnabled } from './web-search-mode';

export type AnthropicFamilyProvider = Extract<AIProviderType, 'anthropic' | 'deepseek'>;

export interface AnthropicStreamFamilyConfig {
  provider: AnthropicFamilyProvider;
  endpoint: string;
  displayName: string;
  getApiKey: () => string | null | undefined;
  nativeWebSearch: 'anthropic' | 'none';
  pauseTurns: 'continue' | 'complete-without-pause';
}

export function createAnthropicFamilyStream(config: AnthropicStreamFamilyConfig) {
  return async function* anthropicFamilyStream(
    req: PushStreamRequest<ChatMessage>,
  ): AsyncIterable<PushStreamEvent> {
    const workspaceContext = req.workspaceContext as WorkspaceContext | undefined;
    const capabilityProfile = resolvePushCapabilityProfile(config.provider, req.model);
    const llmMessages = toLLMMessages(req.messages, {
      workspaceContext,
      hasSandbox: req.hasSandbox,
      systemPromptOverride: req.systemPromptOverride,
      scratchpadContent: req.scratchpadContent,
      providerType: config.provider,
      providerModel: req.model,
      onPreCompact: req.onPreCompact,
      todoContent: req.todoContent,
      sessionDigestOptions: {
        records: req.sessionDigestRecords,
        prior: req.priorSessionDigest,
        onEmit: req.onSessionDigestEmitted,
      },
      linkedLibraryContent: req.linkedLibraryContent,
      emitContentBlocks: capabilityProfile.contentBlocks,
    });

    const anthropicWebSearch =
      config.nativeWebSearch === 'anthropic' &&
      (req.anthropicWebSearch ?? isNativeWebSearchEnabled('anthropic', req.model));
    // Neutral `push.stream.v1` wire body. Sampling scalars and the web-search
    // flag ride as neutral fields; the Worker's dual-accept neutral branch
    // serializes them to Anthropic Messages. System-prompt prefix caching is
    // preserved unchanged: the cacheable `toLLMMessages` output already bakes
    // `cache_control` into the system message's content-part array, which
    // rides through the wire and is honored by `toAnthropicMessages`. The
    // separate `cacheBreakpointIndices` rolling-tail mechanism is intentionally
    // NOT sent — the legacy OpenAI-shape body never carried it on this path,
    // so enabling it is a deliberate change, not a cleanup.
    const baseBody = toPushStreamWire(llmMessages, {
      provider: config.provider,
      model: req.model,
      maxTokens: req.maxTokens,
      temperature: req.temperature,
      topP: req.topP,
      ...(anthropicWebSearch ? { anthropicWebSearch: true } : {}),
      ...(req.tools && req.tools.length > 0 ? { tools: req.tools } : {}),
      ...(req.responseFormat ? { responseFormat: req.responseFormat } : {}),
    });

    // Built once and reused across pause-turn attempts, so every continuation
    // request carries the same request id (matching the pre-family behavior).
    const headers = buildProviderStreamHeaders(config.getApiKey());

    const runAttempt = async function* (body: typeof baseBody): AsyncIterable<PushStreamEvent> {
      const response = await postProviderStream({
        endpoint: config.endpoint,
        headers,
        body,
        signal: req.signal,
        displayName: config.displayName,
        errorPrefix: 'preserve-worker-prefix',
      });

      yield* anthropicEventStream(response, req.signal, (name) => KNOWN_TOOL_NAMES.has(name));
    };

    if (config.pauseTurns === 'continue') {
      yield* continueAnthropicPauseTurns({ baseBody, runAttempt });
      return;
    }

    yield* completeAnthropicStreamWithoutPause(runAttempt(baseBody));
  };
}
