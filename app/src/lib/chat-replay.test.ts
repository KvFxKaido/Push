import { describe, expect, it } from 'vitest';
import type { AttachmentData, ChatMessage } from '@/types';
import { buildEditedReplay, buildRegeneratedReplay } from './chat-replay';

function msg(
  id: string,
  role: ChatMessage['role'],
  content: string,
  extras: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id,
    role,
    content,
    timestamp: 1,
    status: 'done',
    ...extras,
  };
}

describe('buildRegeneratedReplay', () => {
  it('keeps history through the last replayable user message and drops later assistant output', () => {
    const messages: ChatMessage[] = [
      msg('u1', 'user', 'First prompt'),
      msg('a1', 'assistant', 'First answer'),
      msg('u2', 'user', 'Second prompt'),
      msg('a2', 'assistant', 'Second answer'),
    ];

    const replay = buildRegeneratedReplay(messages);

    expect(replay).toEqual({
      baseMessages: messages.slice(0, 3),
      existingUserMessage: messages[2],
    });
  });
});

describe('buildEditedReplay', () => {
  it('replaces the target user turn and truncates later messages', () => {
    const attachments: AttachmentData[] = [
      {
        id: 'att-1',
        type: 'code',
        filename: 'demo.ts',
        mimeType: 'text/plain',
        sizeBytes: 12,
        content: 'console.log(1)',
      },
    ];
    const messages: ChatMessage[] = [
      msg('u1', 'user', 'Original prompt'),
      msg('a1', 'assistant', 'Original answer'),
      msg('u2', 'user', 'Follow-up'),
      msg('a2', 'assistant', 'Follow-up answer'),
    ];

    const replay = buildEditedReplay(messages, 'u1', 'Edited prompt', attachments);

    expect(replay).toEqual({
      baseMessages: [
        {
          ...messages[0],
          content: 'Edited prompt',
          attachments,
          timestamp: expect.any(Number),
        },
      ],
      existingUserMessage: {
        ...messages[0],
        content: 'Edited prompt',
        attachments,
        timestamp: expect.any(Number),
      },
    });
  });

  it('returns null for missing or non-user targets', () => {
    const messages: ChatMessage[] = [
      msg('u1', 'user', 'Prompt'),
      msg('tool-1', 'user', '[TOOL_RESULT]', { isToolResult: true }),
    ];

    expect(buildEditedReplay(messages, 'missing', 'Edited')).toBeNull();
    expect(buildEditedReplay(messages, 'tool-1', 'Edited')).toBeNull();
  });
});
