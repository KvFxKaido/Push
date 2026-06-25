import type { ChatMessage } from '@/types';
import { buildAttachmentContentBlocks } from './attachment-content-parts';
import type { CoderLoopMessage } from '@push/lib/coder-agent';

/**
 * Build the inline lead's conversational seed: the visible transcript mapped to
 * the kernel's loop-message shape.
 *
 * Deliberately does NOT run the context transform (compaction / `[USER_GOAL]` /
 * `[SESSION DIGEST]` / safety net). The provider stream's `toLLMMessages`
 * already runs exactly those stages on `req.messages` every round, so
 * transforming here would double-process the transcript — and the second pass,
 * operating on messages whose `synthetic` / `isToolResult` flags were stripped
 * by the `LlmMessage` projection, is not idempotent (it can re-compact or
 * re-emit a session digest). Instead the caller threads the digest inputs
 * (records / prior digest / onEmit) through to the stream request, so the
 * single stream-side transform owns history management — exactly how the
 * Orchestrator loop works.
 *
 * Two things the seed preserves so that one transform has what it needs:
 *   - visibility is pre-filtered here (display-only messages never reach the
 *     wire), since `LlmMessage` can't carry `visibleToModel` for the stream's
 *     own filter stage;
 *   - `isToolResult` rides through (`CoderLoopMessage` carries it) so the
 *     stream's compaction treats prior tool output correctly.
 * Attachments (including linked-library images already spliced into the latest
 * user turn) render into `contentBlocks` unless the message already carries
 * explicit `contentParts`.
 */
export function buildInlineConversationSeed(
  apiMessages: readonly ChatMessage[],
): CoderLoopMessage[] {
  return apiMessages.filter((m) => m.visibleToModel !== false).map(toSeedMessage);
}

function toSeedMessage(message: ChatMessage): CoderLoopMessage {
  const contentParts =
    message.contentParts && message.contentParts.length > 0 ? message.contentParts : undefined;
  const contentBlocks =
    contentParts || message.role !== 'user'
      ? undefined
      : buildAttachmentContentBlocks(message.content, message.attachments);

  return {
    id: message.id,
    role: message.role,
    content: message.content,
    timestamp: message.timestamp,
    ...(contentParts && contentParts.length > 0 ? { contentParts } : {}),
    ...(contentBlocks && contentBlocks.length > 0 ? { contentBlocks } : {}),
    ...(message.reasoningBlocks && message.reasoningBlocks.length > 0
      ? { reasoningBlocks: message.reasoningBlocks }
      : {}),
    ...(message.isToolResult ? { isToolResult: true } : {}),
  };
}
