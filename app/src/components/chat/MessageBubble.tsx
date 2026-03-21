import { memo, useMemo, useState, useCallback } from 'react';
import { ChevronRight, FileCode, FileText, Copy, Check, Pin, Pencil, RefreshCw } from 'lucide-react';
import type { ChatMessage, CardAction, AttachmentData } from '@/types';
import { CardRenderer } from '@/components/cards/CardRenderer';
import { PushMarkIcon } from '@/components/icons/push-custom-icons';
import {
  looksLikeToolCall,
  ONLY_BRACKETS_RE,
  stripToolCallPayload,
  stripToolResultEnvelopes,
} from './message-content';

interface MessageBubbleProps {
  message: ChatMessage;
  onCardAction?: (action: CardAction) => void;
  onPin?: (content: string, messageId: string) => void;
  onEdit?: (messageId: string) => void;
  onRegenerate?: () => void;
  canRegenerate?: boolean;
}

function isToolCallObject(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.tool === 'string';
}

function isToolCallJson(code: string): boolean {
  try {
    const trimmed = code.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return false;
    const parsed = JSON.parse(trimmed);
    return isToolCallObject(parsed);
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
              className="my-2 overflow-x-auto rounded-lg border border-push-edge bg-push-surface px-3 py-2.5"
            >
              <code className="font-mono text-push-base text-[#e2e8f0] leading-relaxed">
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
        <hr key={`hr-${i}`} className="my-3 border-0 border-t border-push-edge" />,
      );
      continue;
    }

    // --- Headings ---
    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const headingText = headingMatch[2];
      const styles: Record<number, string> = {
        1: 'text-[18px] font-semibold text-push-fg mt-4 mb-1.5',
        2: 'text-[16px] font-semibold text-push-fg mt-3 mb-1',
        3: 'text-push-lg font-medium text-[#e2e8f0] mt-2.5 mb-0.5',
        4: 'text-[14px] font-medium text-[#8891a1] mt-2 mb-0.5 uppercase tracking-wide',
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
          className="border-l-2 border-push-edge pl-3 my-1 text-[#8891a1] italic"
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
          <span className="shrink-0 mt-[9px] block w-1 h-1 rounded-full bg-push-fg-dim" />
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
          <span className="text-push-fg-dim text-push-base font-mono shrink-0 min-w-[1.25rem] text-right mt-px">
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
          className="my-2 overflow-x-auto rounded-lg border border-push-edge bg-push-surface px-3 py-2.5"
        >
          <code className="font-mono text-push-base text-[#e2e8f0] leading-relaxed">
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
    /(\*\*(.+?)\*\*)|(\*([^*]+?)\*)|(`([^`]+?)`)|(\[([^\]]+)]\(([^)]+)\))|([^*`[]+|[*`[])/g;
  let match;
  let key = 0;

  while ((match = regex.exec(text)) !== null) {
    if (match[2]) {
      // Bold **text**
      result.push(
        <strong key={key++} className="font-semibold text-push-fg">
          {match[2]}
        </strong>,
      );
    } else if (match[4]) {
      // Italic *text*
      result.push(
        <em key={key++} className="italic text-[#d1d8e6]">
          {match[4]}
        </em>,
      );
    } else if (match[6]) {
      // Inline code `text`
      result.push(
        <code
          key={key++}
          className="rounded border border-push-edge bg-push-surface px-1.5 py-0.5 font-mono text-push-base text-[#e2e8f0]"
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
          className="text-push-accent hover:text-[#3291ff] underline underline-offset-2 decoration-push-accent/30 hover:decoration-[#3291ff]/50 transition-colors"
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
        className="flex items-center gap-1 text-push-xs text-push-fg-dim hover:text-[#8891a1] transition-colors duration-150 group"
      >
        <ChevronRight
          className={`h-3 w-3 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
        />
        <span className="font-medium">
          {isStreaming ? 'Reasoning' : 'Thought process'}
        </span>
        {isStreaming && (
          <span className="inline-block w-1 h-1 rounded-full bg-push-fg-dim animate-pulse ml-0.5" />
        )}
      </button>

      {!expanded && !isStreaming && (
        <p className="text-push-sm text-[#4a5568] leading-relaxed mt-1 ml-4 line-clamp-2 italic">
          {preview}
        </p>
      )}

      {expanded && (
        <div className="mt-1.5 ml-4 pl-3 border-l border-push-edge max-h-[300px] overflow-y-auto expand-in">
          <p className="text-push-sm text-push-fg-dim leading-relaxed whitespace-pre-wrap break-words">
            {thinking}
          </p>
        </div>
      )}

      {isStreaming && !expanded && thinking && (
        <div className="mt-1.5 ml-4 pl-3 border-l border-push-edge">
          <p className="text-push-sm text-[#4a5568] leading-relaxed whitespace-pre-wrap break-words line-clamp-3">
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
          className="block rounded-lg overflow-hidden border border-push-edge hover:border-push-edge-hover transition-colors"
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
    <div className="flex items-center gap-1.5 rounded-lg bg-push-surface/50 border border-push-edge px-2 py-1">
      <Icon className="h-3.5 w-3.5 text-push-fg-muted" />
      <span className="text-push-sm text-[#8891a1] truncate max-w-[120px]">
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
      className="rounded-md p-1.5 text-push-fg-dim transition-colors duration-150 hover:bg-push-surface-active hover:text-[#d1d8e6]"
      title={copied ? 'Copied!' : 'Copy to clipboard'}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-push-status-success" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </button>
  );
}

export const MessageBubble = memo(function MessageBubble({
  message,
  onCardAction,
  onPin,
  onEdit,
  onRegenerate,
  canRegenerate = false,
}: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const isError = message.status === 'error';
  const isStreaming = message.status === 'streaming';
  const hasThinking = Boolean(message.thinking);
  const displayContentText = useMemo(
    () => {
      if (isUser) {
        return message.displayContent ?? message.content;
      }
      let text = message.content;
      // Always strip leaked tool-result envelopes (safe — only targets our exact format)
      text = stripToolResultEnvelopes(text);
      // Aggressive tool-call JSON stripping for flagged tool calls AND streaming
      // messages (prevents visual flash of raw JSON while model is still outputting).
      // For streaming, gate on a cheap marker check to avoid regex/brace-scan cost
      // on every token update when the response is just plain text.
      // Always apply tool-call stripping to assistant messages if they look like tool calls.
      // This acts as a fail-safe even if the background parser missed a malformed call
      // or the streaming state has finished.
      if (message.isToolCall || looksLikeToolCall(text)) {
        text = stripToolCallPayload(text);
      }
      // Strip bracket-only artifacts, but only when we believe the content
      // originated from a tool call / tool JSON, to avoid erasing legitimate
      // minimal JSON-like replies such as "[]" or "{}".
      if ((message.isToolCall || looksLikeToolCall(text)) && ONLY_BRACKETS_RE.test(text)) {
        text = '';
      }
      return text;
    },
    [isUser, message.content, message.displayContent, message.isToolCall, isStreaming],
  );
  const hasContent = Boolean(displayContentText.trim());

  const visibleCards = useMemo(
    () => (message.cards || []).filter((card) => card.type !== 'sandbox-state'),
    [message.cards],
  );

  const content = useMemo(
    () => formatContent(displayContentText),
    [displayContentText],
  );

  // Hide tool result messages — they now live in the Console drawer
  if (message.isToolResult || (message.role as string) === 'tool') {
    return null;
  }

  // Hide tool call messages only when they have no cards.
  // If the model included user-facing text before the JSON call, keep it visible.
  if (message.isToolCall && !hasContent && visibleCards.length === 0) {
    return null;
  }

  if (isUser) {
    const hasAttachments = message.attachments && message.attachments.length > 0;

    return (
      <div className="flex justify-end px-4 py-1.5 group/user animate-fade-in-up">
        <div className="opacity-0 group-hover/user:opacity-100 transition-opacity duration-200 flex items-start gap-0.5 pt-2 mr-1.5">
          <CopyButton text={displayContentText} />
          {onEdit && (
            <button
              onClick={() => onEdit(message.id)}
              className="rounded-md p-1.5 text-push-fg-dim transition-colors duration-150 hover:bg-push-surface-active hover:text-[#d1d8e6]"
              title="Edit and resend"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <div className="chat-user-bubble max-w-[85%] rounded-2xl rounded-br-md border px-4 py-3 shadow-push-md">
          {hasAttachments && (
            <div className="flex flex-wrap gap-2 mb-2">
              {message.attachments!.map((att) => (
                <AttachmentBadge key={att.id} attachment={att} />
              ))}
            </div>
          )}
          {hasContent && (
            <p className="whitespace-pre-wrap break-words text-push-lg leading-relaxed text-push-fg">
              {displayContentText}
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2.5 px-4 py-1.5 group/assistant animate-fade-in">
      <div className="mt-1.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-[#1e2634] bg-push-grad-icon">
        <PushMarkIcon className="h-[10px] w-[10px] text-push-accent" />
      </div>
      <div className="min-w-0 max-w-[85%]">
        {hasThinking && (
          <ThinkingBlock
            thinking={message.thinking!}
            isStreaming={isStreaming && !hasContent}
          />
        )}
        {hasContent && (
          <div
            className={`text-push-lg leading-relaxed break-words ${
              isError ? 'text-red-400' : 'text-[#d1d8e6]'
            }`}
          >
            {content}
            {isStreaming && (
              <span className="inline-block w-[6px] h-[16px] bg-push-accent ml-0.5 align-text-bottom animate-blink" />
            )}
          </div>
        )}
        {hasContent && !isStreaming && (
          <div className="opacity-0 group-hover/assistant:opacity-100 transition-opacity duration-200 mt-1.5 flex items-center gap-0.5">
            <CopyButton text={displayContentText} />
            {canRegenerate && onRegenerate && (
              <button
                onClick={onRegenerate}
                className="rounded-md p-1.5 text-push-fg-dim transition-colors duration-150 hover:bg-push-surface-active hover:text-[#d1d8e6]"
                title="Regenerate response"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
            )}
            {onPin && (
              <button
                onClick={() => onPin(displayContentText, message.id)}
                className="rounded-md p-1.5 text-push-fg-dim transition-colors duration-150 hover:bg-push-surface-active hover:text-[#d1d8e6]"
                title="Pin to Kept"
              >
                <Pin className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        )}
        {visibleCards.length > 0 && (
          <div className="mt-1.5">
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
