import { memo, useMemo, useState, useCallback } from 'react';
import { ChevronRight, FileCode, FileText, Copy, Check } from 'lucide-react';
import type { ChatMessage, CardAction, AttachmentData } from '@/types';
import { CardRenderer } from '@/components/cards/CardRenderer';

interface MessageBubbleProps {
  message: ChatMessage;
  onCardAction?: (action: CardAction) => void;
}

function isToolCallJson(code: string): boolean {
  try {
    const trimmed = code.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return false;
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && 'tool' in parsed;
  } catch {
    return false;
  }
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
        const fullCode = codeLines.join('\n');
        // Hide raw JSON tool call blocks from chat
        if (!isToolCallJson(fullCode)) {
          parts.push(
            <pre
              key={`code-${codeKey++}`}
              className="my-2 rounded-lg bg-[#0a0a0c] border border-[#1a1a1a] px-3 py-2.5 overflow-x-auto"
            >
              <code className="font-mono text-[13px] text-[#e4e4e7] leading-relaxed">
                {fullCode}
              </code>
            </pre>,
          );
        }
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
    const fullCode = codeLines.join('\n');
    if (!isToolCallJson(fullCode)) {
      parts.push(
        <pre
          key={`code-${codeKey}`}
          className="my-2 rounded-lg bg-[#0a0a0c] border border-[#1a1a1a] px-3 py-2.5 overflow-x-auto"
        >
          <code className="font-mono text-[13px] text-[#e4e4e7] leading-relaxed">
            {fullCode}
          </code>
        </pre>,
      );
    }
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
          className="font-mono text-[13px] bg-[#0d0d0d] border border-[#1a1a1a] rounded px-1.5 py-0.5 text-[#e4e4e7]"
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

function ThinkingBlock({ thinking, isStreaming }: { thinking: string; isStreaming: boolean }) {
  const [expanded, setExpanded] = useState(false);

  // Truncate preview to ~80 chars from the end of thinking
  const preview = thinking.length > 80 ? '\u2026' + thinking.slice(-80).trim() : thinking.trim();

  return (
    <div className="mb-2">
      <button
        onClick={() => setExpanded((e) => !e)}
        className="flex items-center gap-1 text-[11px] text-[#52525b] hover:text-[#888] transition-colors duration-150 group"
      >
        <ChevronRight
          className={`h-3 w-3 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
        />
        <span className="font-medium">
          {isStreaming ? 'Reasoning' : 'Thought process'}
        </span>
        {isStreaming && (
          <span className="inline-block w-1 h-1 rounded-full bg-[#52525b] animate-pulse ml-0.5" />
        )}
      </button>

      {!expanded && !isStreaming && (
        <p className="text-[12px] text-[#3a3a3e] leading-relaxed mt-1 ml-4 line-clamp-2 italic">
          {preview}
        </p>
      )}

      {expanded && (
        <div className="mt-1.5 ml-4 pl-3 border-l border-[#1a1a1a] max-h-[300px] overflow-y-auto">
          <p className="text-[12px] text-[#52525b] leading-relaxed whitespace-pre-wrap break-words">
            {thinking}
          </p>
        </div>
      )}

      {isStreaming && !expanded && thinking && (
        <div className="mt-1.5 ml-4 pl-3 border-l border-[#1a1a1a]">
          <p className="text-[12px] text-[#3a3a3e] leading-relaxed whitespace-pre-wrap break-words line-clamp-3">
            {thinking.slice(-200)}
          </p>
        </div>
      )}
    </div>
  );
}

function AttachmentBadge({ attachment }: { attachment: AttachmentData }) {
  const [expanded, setExpanded] = useState(false);

  if (attachment.type === 'image') {
    return (
      <>
        <button
          onClick={() => setExpanded(true)}
          className="block rounded-lg overflow-hidden border border-[#27272a] hover:border-[#3f3f46] transition-colors"
        >
          <img
            src={attachment.thumbnail || attachment.content}
            alt={attachment.filename}
            className="h-16 w-16 object-cover"
          />
        </button>
        {expanded && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
            onClick={() => setExpanded(false)}
          >
            <img
              src={attachment.content}
              alt={attachment.filename}
              className="max-w-full max-h-full object-contain rounded-lg"
            />
          </div>
        )}
      </>
    );
  }

  const Icon = attachment.type === 'code' ? FileCode : FileText;
  return (
    <div className="flex items-center gap-1.5 rounded-lg bg-[#0d0d0d]/50 border border-[#27272a] px-2 py-1">
      <Icon className="h-3.5 w-3.5 text-[#71717a]" />
      <span className="text-[12px] text-[#a1a1aa] truncate max-w-[120px]">
        {attachment.filename}
      </span>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [text]);

  return (
    <button
      onClick={handleCopy}
      className="p-1.5 rounded-md text-[#52525b] hover:text-[#a1a1aa] hover:bg-[#1a1a1a] transition-colors duration-150"
      title={copied ? 'Copied!' : 'Copy to clipboard'}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-[#22c55e]" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </button>
  );
}

export const MessageBubble = memo(function MessageBubble({
  message,
  onCardAction,
}: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const isError = message.status === 'error';
  const isStreaming = message.status === 'streaming';
  const hasThinking = Boolean(message.thinking);
  const hasContent = Boolean(message.content);

  const content = useMemo(
    () => formatContent(message.content),
    [message.content],
  );

  // Hide tool result messages — they now live in the VIGIL drawer
  if (message.isToolResult || (message.role as string) === 'tool') {
    return null;
  }

  // Hide tool call messages — they now live in the VIGIL drawer
  if (message.isToolCall) {
    return null;
  }

  if (isUser) {
    const hasAttachments = message.attachments && message.attachments.length > 0;

    return (
      <div className="flex justify-end px-4 py-1 group/user">
        <div className="opacity-0 group-hover/user:opacity-100 transition-opacity duration-150 flex items-start pt-2 mr-1">
          <CopyButton text={message.content} />
        </div>
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-[#1a1a2e] px-4 py-2.5">
          {hasAttachments && (
            <div className="flex flex-wrap gap-2 mb-2">
              {message.attachments!.map((att) => (
                <AttachmentBadge key={att.id} attachment={att} />
              ))}
            </div>
          )}
          {message.content && (
            <p className="text-[15px] leading-relaxed text-[#fafafa] whitespace-pre-wrap break-words">
              {message.content}
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2.5 px-4 py-1 group/assistant">
      <div className="mt-1.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#0d0d0d] border border-[#1a1a1a]">
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
        {hasThinking && (
          <ThinkingBlock
            thinking={message.thinking!}
            isStreaming={isStreaming && !hasContent}
          />
        )}
        <div
          className={`text-[15px] leading-relaxed break-words ${
            isError ? 'text-red-400' : 'text-[#d4d4d8]'
          }`}
        >
          {content}
          {isStreaming && (
            <span className="inline-block w-[6px] h-[16px] bg-[#0070f3] ml-0.5 align-text-bottom animate-blink" />
          )}
        </div>
        {hasContent && !isStreaming && (
          <div className="opacity-0 group-hover/assistant:opacity-100 transition-opacity duration-150 mt-1">
            <CopyButton text={message.content} />
          </div>
        )}
        {message.cards && message.cards.length > 0 && (
          <div className="mt-1">
            {message.cards.map((card, i) => (
              <CardRenderer
                key={i}
                card={card}
                messageId={message.id}
                cardIndex={i}
                onAction={onCardAction}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
});
