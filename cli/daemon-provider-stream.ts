/**
 * Daemon-side `PushStream` factory.
 *
 * Returns a `PushStream<LlmMessage>` for the lib-side agent roles (explorer,
 * reviewer, auditor, coder, planner) to consume directly. The CLI daemon
 * equivalent of Web's `getProviderPushStream` — same shape, same per-event
 * contract — but uses the CLI's `PROVIDER_CONFIGS` + `resolveApiKey` instead
 * of Web settings.
 *
 * Policy-free on purpose: the factory takes a resolved provider name from
 * the caller (e.g. `handleDelegateExplorer` resolves role routing first),
 * so per-role routing stays out of this module. API keys are resolved
 * lazily on each invocation — `resolveApiKey` throws when the env is not
 * configured, and that throw surfaces as the iterator throwing.
 */

import type { LlmMessage, PushStream, PushStreamEvent } from '../lib/provider-contract.ts';
import { PROVIDER_CONFIGS, resolveApiKey, streamCompletion } from './provider.js';

interface ChatMessage {
  role: string;
  content: string;
}

export function createDaemonProviderStream(
  provider: string,
  sessionId?: string,
): PushStream<LlmMessage> {
  const config = PROVIDER_CONFIGS[provider];
  if (!config) {
    throw new Error(`Unknown provider "${provider}" — not configured in PROVIDER_CONFIGS`);
  }

  return (req) =>
    (async function* () {
      const queue: PushStreamEvent[] = [];
      let done = false;
      let error: Error | null = null;
      let wake: (() => void) | undefined;
      const notify = () => {
        if (wake) {
          const w = wake;
          wake = undefined;
          w();
        }
      };

      const onToken = (token: string) => {
        if (token.length > 0) queue.push({ type: 'text_delta', text: token });
        notify();
      };
      const onThinkingToken = (token: string | null) => {
        if (token === null) queue.push({ type: 'reasoning_end' });
        else if (token.length > 0) queue.push({ type: 'reasoning_delta', text: token });
        notify();
      };

      const signal = req.signal;
      const onAbort = () => {
        if (!done) {
          queue.push({ type: 'done', finishReason: 'aborted' });
          done = true;
          notify();
        }
      };
      if (signal?.aborted) {
        onAbort();
      } else {
        signal?.addEventListener('abort', onAbort, { once: true });
      }

      const run = (async () => {
        try {
          const apiKey: string = resolveApiKey(config);

          // lib agents pass user/assistant messages only; the system prompt
          // arrives as the request's `systemPromptOverride`. See
          // lib/explorer-agent.ts — `messages` starts with a user
          // taskPreamble, not a system role.
          const chatMessages: ChatMessage[] = [];
          const systemPromptOverride = req.systemPromptOverride;
          if (typeof systemPromptOverride === 'string' && systemPromptOverride.trim()) {
            chatMessages.push({ role: 'system', content: systemPromptOverride });
          }
          for (const m of req.messages) {
            chatMessages.push({ role: m.role, content: m.content });
          }

          const model: string = req.model && req.model.trim() ? req.model : config.defaultModel;

          await streamCompletion(
            config,
            apiKey,
            model,
            chatMessages,
            onToken,
            undefined,
            signal ?? null,
            {
              onThinkingToken,
              sessionId,
            },
          );
          if (!done) {
            queue.push({ type: 'done', finishReason: 'stop' });
            done = true;
            notify();
          }
        } catch (err) {
          error = err instanceof Error ? err : new Error(String(err));
          done = true;
          notify();
        }
      })();

      try {
        while (true) {
          while (queue.length === 0 && !done) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
          while (queue.length > 0) {
            const event = queue.shift()!;
            yield event;
            if (event.type === 'done') return;
          }
          if (done) {
            if (error) throw error;
            return;
          }
        }
      } finally {
        signal?.removeEventListener('abort', onAbort);
        void run.catch(() => {
          /* error already surfaced via the queue */
        });
      }
    })();
}
