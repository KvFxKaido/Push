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
