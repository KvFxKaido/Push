/**
 * Inline chat card with a read-only CodeMirror editor.
 *
 * Mirrors FileCard's header pattern (collapsible, shows path + language + line count)
 * but replaces the raw <pre> body with a CodeMirror instance for syntax highlighting
 * and line numbers.
 *
 * "Open in Editor" button opens the full-screen EditorPanel.
 */

import { useState, useMemo } from 'react';
import { FileCode, ChevronRight, Maximize2 } from 'lucide-react';
import type { EditorCardData, CardAction } from '@/types';
import { useCodeMirror } from '@/hooks/useCodeMirror';
import { EditorPanel } from './EditorPanel';
import { CARD_SHELL_CLASS } from '@/lib/utils';

interface EditorCardProps {
  data: EditorCardData;
  messageId?: string;
  cardIndex?: number;
  onAction?: (action: CardAction) => void;
}

export function EditorCard({ data, messageId, cardIndex, onAction }: EditorCardProps) {
  const [expanded, setExpanded] = useState(true);
  const [panelOpen, setPanelOpen] = useState(false);
  const lineCount = useMemo(() => data.content.split('\n').length, [data.content]);

  return (
    <>
      <div className={CARD_SHELL_CLASS}>
        {/* Header */}
        <div className="flex items-center">
          <button
            onClick={() => setExpanded((e) => !e)}
            className="flex-1 px-3.5 py-3 flex items-center gap-2 hover:bg-[#151517] transition-colors duration-200 min-w-0"
          >
            <ChevronRight
              className={`h-3 w-3 text-push-fg-dim shrink-0 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
            />
            <FileCode className="h-3.5 w-3.5 text-push-fg-secondary shrink-0" />
            <span className="text-[13px] text-push-fg font-mono truncate">
              {data.path}
            </span>
            {data.language && (
              <span className="text-[11px] text-push-fg-dim bg-[#111624] px-1.5 py-0.5 rounded shrink-0">
                {data.language}
              </span>
            )}
            <span className="text-[11px] text-[#5f6b80] shrink-0 ml-auto">
              {lineCount} line{lineCount !== 1 ? 's' : ''}
            </span>
          </button>

          {/* Open in Editor button */}
          <button
            onClick={() => setPanelOpen(true)}
            className="px-2 py-2 hover:bg-[#151517] transition-colors border-l border-push-edge"
            title="Open in Editor"
          >
            <Maximize2 className="h-3.5 w-3.5 text-push-fg-dim hover:text-push-fg-secondary" />
          </button>
        </div>

        {/* CodeMirror body — read-only in inline card */}
        {expanded && (
          <div className="border-t border-push-edge expand-in">
            <CodeMirrorBody content={data.content} language={data.language} />
            {data.truncated && (
              <div className="px-3 py-1.5 border-t border-push-edge text-[11px] text-push-fg-dim italic">
                Content truncated at 5K characters
              </div>
            )}
          </div>
        )}
      </div>

      {/* Full-screen panel */}
      <EditorPanel
        data={data}
        open={panelOpen}
        onOpenChange={setPanelOpen}
        messageId={messageId}
        cardIndex={cardIndex}
        onAction={onAction}
      />
    </>
  );
}

/**
 * Inner component so the CodeMirror hook only mounts when expanded.
 */
function CodeMirrorBody({ content, language }: { content: string; language: string }) {
  const { containerRef } = useCodeMirror({
    doc: content,
    language,
    readOnly: true,
  });

  return (
    <div
      ref={containerRef}
      className="max-h-[400px] overflow-hidden [&_.cm-editor]:max-h-[400px] [&_.cm-scroller]:!overflow-auto"
    />
  );
}
