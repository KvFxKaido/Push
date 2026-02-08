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

    // --- Fenced code blocks ---
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

    // --- Horizontal rule (---, ***, ___) ---
    if (/^(\s*[-*_]\s*){3,}$/.test(line) && line.trim().length >= 3) {
      parts.push(
        <hr key={`hr-${i}`} className="my-3 border-0 border-t border-[#1a1a1a]" />,
      );
      continue;
    }

    // --- Headings ---
    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const headingText = headingMatch[2];
      const styles: Record<number, string> = {
        1: 'text-[18px] font-semibold text-[#fafafa] mt-4 mb-1.5',
        2: 'text-[16px] font-semibold text-[#fafafa] mt-3 mb-1',
        3: 'text-[15px] font-medium text-[#e4e4e7] mt-2.5 mb-0.5',
        4: 'text-[14px] font-medium text-[#a1a1aa] mt-2 mb-0.5 uppercase tracking-wide',
      };
      parts.push(
        <div key={`heading-${i}`} className={styles[level]}>
          {formatInline(headingText)}
        </div>,
      );
      continue;
    }

    // --- Blockquote ---
    if (line.startsWith('> ') || line === '>') {
      const quoteText = line.startsWith('> ') ? line.slice(2) : '';
      parts.push(
        <div
          key={`bq-${i}`}
          className="border-l-2 border-[#27272a] pl-3 my-1 text-[#a1a1aa] italic"
        >
          {quoteText ? formatInline(quoteText) : '\u00A0'}
        </div>,
      );
      continue;
    }

    // --- Unordered list item (- or *) ---
    const ulMatch = line.match(/^(\s*)[-*]\s+(.+)$/);
    if (ulMatch) {
      const indent = Math.min(Math.floor(ulMatch[1].length / 2), 3);
      const itemText = ulMatch[2];
      parts.push(
        <div
          key={`ul-${i}`}
          className="flex items-start gap-2 my-0.5"
          style={{ paddingLeft: `${indent * 16 + 4}px` }}
        >
          <span className="shrink-0 mt-[9px] block w-1 h-1 rounded-full bg-[#52525b]" />
          <span className="flex-1 min-w-0">{formatInline(itemText)}</span>
        </div>,
      );
      continue;
    }

    // --- Ordered list item (1. 2. etc.) ---
    const olMatch = line.match(/^(\s*)(\d+)\.\s+(.+)$/);
    if (olMatch) {
      const indent = Math.min(Math.floor(olMatch[1].length / 2), 3);
      const num = olMatch[2];
      const itemText = olMatch[3];
      parts.push(
        <div
          key={`ol-${i}`}
          className="flex items-start gap-2 my-0.5"
          style={{ paddingLeft: `${indent * 16 + 4}px` }}
        >
          <span className="text-[#52525b] text-[13px] font-mono shrink-0 min-w-[1.25rem] text-right mt-px">
            {num}.
          </span>
          <span className="flex-1 min-w-0">{formatInline(itemText)}</span>
        </div>,
      );
      continue;
    }

    // --- Empty line ---
    if (line.trim() === '') {
      parts.push(<div key={`empty-${i}`} className="h-2" />);
      continue;
    }

    // --- Default: plain text line ---
    parts.push(
      <div key={`line-${i}`}>
        {formatInline(line)}
      </div>,
    );
  }

  // Handle unclosed code blocks (streaming)
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
  // Match bold, italic, inline code, links, and plain text
  // Bold before italic so ** is tried before *
  const regex =
    /(\*\*(.+?)\*\*)|(\*([^*]+?)\*)|(`([^`]+?)`)|(\[([^\]]+)\]\(([^)]+)\))|([^*`\[]+|[*`\[])/g;
  let match;
  let key = 0;

  while ((match = regex.exec(text)) !== null) {
    if (match[2]) {
      // Bold **text**
      result.push(
        <strong key={key++} className="font-semibold text-[#fafafa]">
          {match[2]}
        </strong>,
      );
    } else if (match[4]) {
      // Italic *text*
      result.push(
        <em key={key++} className="italic text-[#d4d4d8]">
          {match[4]}
        </em>,
      );
    } else if (match[6]) {
      // Inline code `text`
      result.push(
        <code
          key={key++}
          className="font-mono text-[13px] bg-[#0d0d0d] border border-[#1a1a1a] rounded px-1.5 py-0.5 text-[#e4e4e7]"
        >
          {match[6]}
        </code>,
      );
    } else if (match[8]) {
      // Link [text](url)
      result.push(
        <a
          key={key++}
          href={match[9]}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[#0070f3] hover:text-[#3291ff] underline underline-offset-2 decoration-[#0070f3]/30 hover:decoration-[#3291ff]/50 transition-colors"
        >
          {match[8]}
        </a>,
      );
    } else if (match[10]) {
      // Plain text
      result.push(<span key={key++}>{match[10]}</span>);
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

  const visibleCards = useMemo(
    () => (message.cards || []).filter((card) => card.type !== 'sandbox-state'),
    [message.cards],
  );

  const content = useMemo(
    () => formatContent(message.content),
    [message.content],
  );

  // Hide tool result messages — they now live in the Console drawer
  if (message.isToolResult || (message.role as string) === 'tool') {
    return null;
  }

  // Hide tool call messages only when they have no cards.
  // Some tools (e.g. browser screenshots) attach cards to the tool-call
  // message itself; keep those visible so the card can render.
  if (message.isToolCall && visibleCards.length === 0) {
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
        {!message.isToolCall && (
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
        )}
        {!message.isToolCall && hasContent && !isStreaming && (
          <div className="opacity-0 group-hover/assistant:opacity-100 transition-opacity duration-150 mt-1">
            <CopyButton text={message.content} />
          </div>
        )}
        {visibleCards.length > 0 && (
          <div className="mt-1">
            {visibleCards.map((card, i) => (
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
