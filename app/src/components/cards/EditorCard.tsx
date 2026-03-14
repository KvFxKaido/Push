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
import { FileCode, Maximize2 } from 'lucide-react';
import type { EditorCardData, CardAction } from '@/types';
import { useCodeMirror } from '@/hooks/useCodeMirror';
import { useExpandable } from '@/hooks/useExpandable';
import { EditorPanel } from './EditorPanel';
import { CARD_SHELL_CLASS, CARD_BADGE_INFO, CARD_ICON_BUTTON_CLASS } from '@/lib/utils';
import { ExpandChevron, ExpandableCardPanel } from './expandable';

interface EditorCardProps {
  data: EditorCardData;
  messageId?: string;
  cardIndex?: number;
  onAction?: (action: CardAction) => void;
}

export function EditorCard({ data, messageId, cardIndex, onAction }: EditorCardProps) {
  const { expanded, toggleExpanded } = useExpandable(true, { collapseOnMobile: true });
  const [panelOpen, setPanelOpen] = useState(false);
  const lineCount = useMemo(() => data.content.split('\n').length, [data.content]);

  return (
    <>
      <div className={CARD_SHELL_CLASS}>
        {/* Header */}
        <div className="flex items-center">
          <button
            onClick={toggleExpanded}
            className="flex min-w-0 flex-1 items-center gap-2 px-3.5 py-3 transition-colors duration-200 hover:bg-white/[0.02]"
          >
            <ExpandChevron expanded={expanded} className="shrink-0" />
            <FileCode className="h-3.5 w-3.5 text-push-fg-secondary shrink-0" />
            <span className="text-push-base text-push-fg font-mono truncate">
              {data.path}
            </span>
            {data.language && (
              <span className={`${CARD_BADGE_INFO} shrink-0 px-1.5 py-0.5 text-push-xs`}>
                {data.language}
              </span>
            )}
            <span className="text-push-xs text-push-fg-dim shrink-0 ml-auto">
              {lineCount} line{lineCount !== 1 ? 's' : ''}
            </span>
          </button>

          {/* Open in Editor button */}
          <button
            onClick={() => setPanelOpen(true)}
            className={`m-2 h-8 w-8 ${CARD_ICON_BUTTON_CLASS}`}
            title="Open in Editor"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* CodeMirror body — read-only in inline card */}
        <ExpandableCardPanel expanded={expanded}>
          <CodeMirrorBody content={data.content} language={data.language} />
          {data.truncated && (
            <div className="px-3 py-1.5 border-t border-push-edge text-push-xs text-push-fg-dim italic">
              Content truncated at 5K characters
            </div>
          )}
        </ExpandableCardPanel>
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
