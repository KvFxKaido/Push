import type { AttachmentData } from '@/types';
import type { LlmContentPart } from '@push/lib/provider-contract';

export function buildAttachmentContentParts(
  text: string,
  attachments: AttachmentData[] | undefined,
): LlmContentPart[] | undefined {
  if (!attachments || attachments.length === 0) return undefined;

  const contentParts: LlmContentPart[] = [];
  if (text) {
    contentParts.push({ type: 'text', text });
  }

  for (const att of attachments) {
    if (att.type === 'image') {
      contentParts.push({
        type: 'image_url',
        image_url: { url: att.content },
      });
    } else {
      contentParts.push({
        type: 'text',
        text: `[Attached file: ${att.filename}]\n\`\`\`\n${att.content}\n\`\`\``,
      });
    }
  }

  return contentParts;
}

/** Recent prior turns whose attachments ride along; bounds the per-turn image
 *  bloat a long chat would otherwise accumulate. Overflow is reported, never
 *  silently dropped. */
export const MAX_PRIOR_ATTACHMENT_TURNS = 4;

interface PriorAttachmentTurn {
  role: string;
  attachments?: AttachmentData[];
}

/**
 * Build the multimodal content for an inline/lead task message: the text
 * preamble, then attachments from recent prior turns, then the current turn's
 * attachments. Prior-turn attachments are carried so a multi-image-history
 * turn ("compare this with the earlier screenshot") keeps the earlier pixels
 * instead of flattening them to preamble text (#938). The kernel collapses
 * history into one task message, so these ride as labeled parts on it rather
 * than as separate multimodal turns.
 *
 * Returns `undefined` when nothing carries attachments (the text preamble then
 * suffices as the message's `content`). Prior-attachment turns are bounded to
 * the most recent {@link MAX_PRIOR_ATTACHMENT_TURNS}; any overflow is reported
 * via `onPriorTruncate` (no silent cap).
 */
export function buildLeadTurnContentParts(
  taskPreamble: string,
  priorMessages: ReadonlyArray<PriorAttachmentTurn>,
  currentAttachments: AttachmentData[] | undefined,
  onPriorTruncate?: (omittedTurns: number) => void,
): LlmContentPart[] | undefined {
  const withAttachments = priorMessages.filter((m) => m.attachments && m.attachments.length > 0);
  const windowed = withAttachments.slice(-MAX_PRIOR_ATTACHMENT_TURNS);
  const omittedTurns = withAttachments.length - windowed.length;
  if (omittedTurns > 0) onPriorTruncate?.(omittedTurns);

  const priorParts: LlmContentPart[] = [];
  for (const m of windowed) {
    const parts = buildAttachmentContentParts(
      `[Attachment(s) from an earlier ${m.role} turn]`,
      m.attachments,
    );
    if (parts) priorParts.push(...parts);
  }

  const currentParts = buildAttachmentContentParts('', currentAttachments) ?? [];
  if (priorParts.length === 0 && currentParts.length === 0) return undefined;

  return [{ type: 'text', text: taskPreamble }, ...priorParts, ...currentParts];
}
