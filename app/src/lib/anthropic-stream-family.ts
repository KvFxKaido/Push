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
import { parseProviderError } from './orchestrator-streaming';
import { REQUEST_ID_HEADER, createRequestId } from './request-id';
import { ProviderStreamError } from './stream-error';
import { KNOWN_TOOL_NAMES } from './tool-dispatch';
import { injectTraceHeaders } from './tracing';
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

    const apiKey = (config.getApiKey() ?? '').trim();
    const requestId = createRequestId('chat');
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      [REQUEST_ID_HEADER]: requestId,
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    };
    injectTraceHeaders(headers);

    const runAttempt = async function* (body: typeof baseBody): AsyncIterable<PushStreamEvent> {
      const response = await fetch(config.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: req.signal,
      });

      if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        let detail: string;
        try {
          const parsed = JSON.parse(errBody);
          detail = parseProviderError(parsed, errBody.slice(0, 200), true);
        } catch {
          detail = errBody ? errBody.slice(0, 200) : 'empty body';
        }
        const message = detail.startsWith(`${config.displayName} `)
          ? detail
          : `${config.displayName} ${response.status}: ${detail}`;
        throw new ProviderStreamError(message, { status: response.status });
      }

      if (!response.body) {
        throw new Error(`${config.displayName} response had no body`);
      }

      yield* anthropicEventStream(response, req.signal, (name) => KNOWN_TOOL_NAMES.has(name));
    };

    if (config.pauseTurns === 'continue') {
      yield* continueAnthropicPauseTurns({ baseBody, runAttempt });
      return;
    }

    yield* completeAnthropicStreamWithoutPause(runAttempt(baseBody));
  };
}
