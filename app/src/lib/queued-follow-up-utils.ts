// Pure helpers for shaping queued follow-up / pending-steer payloads and
// deriving their preview strings. Extracted from useChat.ts so the round
// loop can reuse them without dragging hook dependencies, and so the
// truncation/attachment-label rules are unit-testable in isolation.

import type { AttachmentData, QueuedFollowUp, QueuedFollowUpOptions } from '@/types';
import type { PendingSteerRequest } from '@/hooks/usePendingSteer';

export function getQueuedFollowUpOptions(
  options?: Partial<QueuedFollowUpOptions>,
): QueuedFollowUpOptions | undefined {
  const queuedOptions = {
    provider: options?.provider ?? undefined,
    model: options?.model ?? undefined,
    displayText: options?.displayText?.trim() || undefined,
  };

  return Object.values(queuedOptions).some(Boolean) ? queuedOptions : undefined;
}

export function summarizeQueuedInputPreview(
  text: string,
  attachments?: AttachmentData[],
  displayText?: string,
  maxLength = 96,
): string {
  const candidate = displayText?.trim() || text.trim();
  const attachmentCount = attachments?.length ?? 0;
  const attachmentLabel =
    attachmentCount > 0 ? `${attachmentCount} attachment${attachmentCount === 1 ? '' : 's'}` : '';

  const base = candidate
    ? attachmentLabel
      ? `${candidate} (+${attachmentLabel})`
      : candidate
    : attachmentLabel || '[no text]';

  return base.length <= maxLength ? base : `${base.slice(0, maxLength - 1).trimEnd()}...`;
}

export function toQueuedFollowUp(
  text: string,
  attachments?: AttachmentData[],
  options?: Partial<QueuedFollowUpOptions>,
): QueuedFollowUp {
  return {
    text,
    attachments,
    options: getQueuedFollowUpOptions(options),
    queuedAt: Date.now(),
  };
}

export function toPendingSteerRequest(
  text: string,
  attachments?: AttachmentData[],
  options?: Partial<QueuedFollowUpOptions>,
): PendingSteerRequest {
  return {
    text,
    attachments,
    options: getQueuedFollowUpOptions(options),
    requestedAt: Date.now(),
  };
}
