/**
 * Daemon-side `ProviderStreamFn` adapter.
 *
 * Wraps `cli/provider.ts#streamCompletion` into the 12-arg
 * `ProviderStreamFn` envelope that lib/-side agent roles (explorer,
 * reviewer, auditor, coder) call. This is the daemon equivalent of Web's
 * `streamChat` shim — same contract, same generic — but uses the CLI's
 * `PROVIDER_CONFIGS` + `resolveApiKey` instead of Web settings.
 *
 * Policy-free on purpose: the factory takes a resolved provider name
 * from the caller (e.g. `handleDelegateExplorer` resolves role routing
 * first), so per-role routing stays out of this module. API keys are
 * resolved lazily on each call — `resolveApiKey` throws when the env is
 * not configured, and that throw is caught and reported through
 * `onError` rather than rethrown so `streamWithTimeout` callers settle
 * their promises cleanly.
 */

import type { LlmMessage, ProviderStreamFn } from '../lib/provider-contract.ts';
import { PROVIDER_CONFIGS, resolveApiKey, streamCompletion } from './provider.js';

interface ChatMessage {
  role: string;
  content: string;
}

export function createDaemonProviderStream(provider: string, sessionId?: string): ProviderStreamFn {
  const config = PROVIDER_CONFIGS[provider];
  if (!config) {
    throw new Error(`Unknown provider "${provider}" — not configured in PROVIDER_CONFIGS`);
  }

  const daemonStream: ProviderStreamFn = async (
    messages: LlmMessage[],
    onToken: (token: string) => void,
    onDone: () => void,
    onError: (error: Error) => void,
    onThinkingToken?: ((token: string | null) => void) | undefined,
    _workspaceContext?: unknown,
    _hasSandbox?: boolean,
    modelOverride?: string,
    systemPromptOverride?: string,
    _scratchpadContent?: string,
    signal?: AbortSignal,
    _onPreCompact?: (event: {
      totalTokens: number;
      budgetThreshold: number;
      messageCount: number;
    }) => void,
  ): Promise<void> => {
    try {
      const apiKey: string = resolveApiKey(config);

      // lib agents pass user/assistant messages only; the system prompt
      // arrives as the 9th positional arg. See lib/explorer-agent.ts:369
      // — `messages` starts with a user taskPreamble, not a system role.
      const chatMessages: ChatMessage[] = [];
      if (typeof systemPromptOverride === 'string' && systemPromptOverride.trim()) {
        chatMessages.push({ role: 'system', content: systemPromptOverride });
      }
      for (const m of messages) {
        chatMessages.push({ role: m.role, content: m.content });
      }

      const model: string =
        typeof modelOverride === 'string' && modelOverride.trim()
          ? modelOverride
          : config.defaultModel;

      await streamCompletion(
        config,
        apiKey,
        model,
        chatMessages,
        (token: string): void => {
          onToken(token);
        },
        undefined,
        signal ?? null,
        {
          onThinkingToken: onThinkingToken ?? null,
          sessionId,
        },
      );
      onDone();
    } catch (err: unknown) {
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  };

  return daemonStream;
}
