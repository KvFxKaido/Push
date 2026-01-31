import { memo, useMemo } from 'react';
import type { ChatMessage } from '@/types';

interface MessageBubbleProps {
  message: ChatMessage;
}

function formatContent(content: string): React.ReactNode[] {
  if (!content) return [];

  const parts: React.ReactNode[] = [];
  const lines = content.split('\n');
  let inCodeBlock = false;
  let codeLines: string[] = [];
  let codeKey = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('```')) {
      if (inCodeBlock) {
        // End code block
        parts.push(
          <pre
            key={`code-${codeKey++}`}
            className="my-2 rounded-lg bg-[#0a0a0c] border border-[#1a1a1e] px-3 py-2.5 overflow-x-auto"
          >
            <code className="font-mono text-[13px] text-[#e4e4e7] leading-relaxed">
              {codeLines.join('\n')}
            </code>
          </pre>,
        );
        codeLines = [];
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    // Render regular line with inline formatting
    parts.push(
      <span key={`line-${i}`}>
        {i > 0 && !inCodeBlock && <br />}
        {formatInline(line)}
      </span>,
    );
  }

  // Handle unclosed code blocks
  if (inCodeBlock && codeLines.length > 0) {
    parts.push(
      <pre
        key={`code-${codeKey}`}
        className="my-2 rounded-lg bg-[#0a0a0c] border border-[#1a1a1e] px-3 py-2.5 overflow-x-auto"
      >
        <code className="font-mono text-[13px] text-[#e4e4e7] leading-relaxed">
          {codeLines.join('\n')}
        </code>
      </pre>,
    );
  }

  return parts;
}

function formatInline(text: string): React.ReactNode[] {
  const result: React.ReactNode[] = [];
  // Match bold (**text**), inline code (`text`), and plain text
  const regex = /(\*\*(.+?)\*\*)|(`([^`]+?)`)|([^*`]+)/g;
  let match;
  let key = 0;

  while ((match = regex.exec(text)) !== null) {
    if (match[2]) {
      // Bold
      result.push(
        <strong key={key++} className="font-semibold text-[#fafafa]">
          {match[2]}
        </strong>,
      );
    } else if (match[4]) {
      // Inline code
      result.push(
        <code
          key={key++}
          className="font-mono text-[13px] bg-[#111113] border border-[#1a1a1e] rounded px-1.5 py-0.5 text-[#e4e4e7]"
        >
          {match[4]}
        </code>,
      );
    } else if (match[5]) {
      result.push(<span key={key++}>{match[5]}</span>);
    }
  }

  return result;
}

export const MessageBubble = memo(function MessageBubble({
  message,
}: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const isError = message.status === 'error';

  const content = useMemo(
    () => formatContent(message.content),
    [message.content],
  );

  if (isUser) {
    return (
      <div className="flex justify-end px-4 py-1">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-[#1a1a2e] px-4 py-2.5">
          <p className="text-[15px] leading-relaxed text-[#fafafa] whitespace-pre-wrap break-words">
            {message.content}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2.5 px-4 py-1">
      <div className="mt-1.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#111113] border border-[#1a1a1e]">
        <svg
          width="10"
          height="10"
          viewBox="0 0 16 16"
          fill="none"
          className="text-[#0070f3]"
        >
          <path
            d="M8 1L14.5 5V11L8 15L1.5 11V5L8 1Z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <div className="min-w-0 max-w-[85%]">
        <div
          className={`text-[15px] leading-relaxed break-words ${
            isError ? 'text-red-400' : 'text-[#d4d4d8]'
          }`}
        >
          {content}
          {message.status === 'streaming' && (
            <span className="inline-block w-[6px] h-[16px] bg-[#0070f3] ml-0.5 align-text-bottom animate-blink" />
          )}
        </div>
      </div>
    </div>
  );
});
