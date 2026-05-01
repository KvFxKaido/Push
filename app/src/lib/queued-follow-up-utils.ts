// Pure helpers for shaping queued follow-up / pending-steer payloads and
// deriving their preview strings. Extracted from useChat.ts so the round
// loop can reuse them without dragging hook dependencies, and so the
// truncation/attachment-label rules are unit-testable in isolation.

import type {
  AttachmentData,
  PendingSteerRequest,
  QueuedFollowUp,
  QueuedFollowUpOptions,
} from '@/types';

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

  if (base.length <= maxLength) return base;
  const ellipsis = '...';
  // Defensive: if the cap is too small to fit the ellipsis itself, truncate
  // hard. Practical callers all use the 96 default, but the fallback keeps
  // the contract `result.length <= maxLength` honest.
  if (maxLength <= ellipsis.length) return base.slice(0, maxLength);
  return `${base.slice(0, maxLength - ellipsis.length).trimEnd()}${ellipsis}`;
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
