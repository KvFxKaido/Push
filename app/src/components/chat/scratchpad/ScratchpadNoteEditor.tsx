import { useEffect, useRef, type CSSProperties } from 'react';
import { Trash2, X } from 'lucide-react';
import { useEscapeAndScrollLock } from '@/hooks/use-escape-and-scroll-lock';
import { DottedGlowBackground } from '@/components/ui/dotted-glow-background';

interface ScratchpadNoteEditorProps {
  /** Note name shown in the header — the memory name, or "Working notes". */
  title: string;
  /** Live meta line under the title (e.g. char count, edited-time). */
  subtitle?: string;
  content: string;
  onChange: (content: string) => void;
  onClose: () => void;
  /** Present only for saved memories; the working-notes draft can't be deleted. */
  onDelete?: () => void;
  /**
   * Shared `view-transition-name` with the source card / preview so the browser
   * morphs the tapped surface into this editor (and back on close). `undefined`
   * when the morph isn't available — the panel just mounts in place.
   */
  morphName?: string;
  /** Glow accent key so each note's header dot field stays visually distinct. */
  glowKey: string;
}

/**
 * Full-screen, keyboard-ready editor for a scratchpad note. Tapping the Working
 * notes field or a saved-note card morphs into this overlay (View Transitions,
 * with an instant fallback) and autofocuses the textarea so the mobile keyboard
 * comes up ready to type. Edits flow straight through `onChange` to the live
 * scratchpad; when a saved memory is the live note the hook writes them back to
 * that memory in place, so this one editor serves both entry points.
 */
export function ScratchpadNoteEditor({
  title,
  subtitle,
  content,
  onChange,
  onClose,
  onDelete,
  morphName,
  glowKey,
}: ScratchpadNoteEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEscapeAndScrollLock(onClose);

  // Bring up the keyboard ready to type: focus the field and drop the caret at
  // the end of the existing text. `preventScroll` keeps the morph from being
  // yanked by a focus-induced scroll. Runs once on mount — the open is driven by
  // a tap, so the focus lands inside that user gesture and the soft keyboard
  // shows. `autoFocus` is the no-JS fallback for the same intent.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, []);

  const headerGlowVars = {
    '--push-glow-dot': 'rgb(var(--push-accent-rgb, 125 211 252) / 0.5)',
    '--push-glow-dot-glow': 'rgb(var(--push-accent-rgb, 125 211 252) / 0.95)',
  } as CSSProperties;

  return (
    <div
      className="fixed inset-0 z-[130] flex flex-col"
      role="dialog"
      aria-modal="true"
      aria-label={`Editing note: ${title}`}
    >
      <button
        type="button"
        aria-label="Close editor"
        onClick={onClose}
        className="scratch-overlay-backdrop absolute inset-0 cursor-default bg-black/60 backdrop-blur-[2px]"
      />
      <div
        style={{ viewTransitionName: morphName } as CSSProperties}
        className="scratch-overlay-panel relative z-10 flex h-full w-full flex-col overflow-hidden border-push-edge bg-push-surface-raised sm:m-auto sm:h-[88dvh] sm:max-w-[640px] sm:rounded-[22px] sm:border sm:shadow-[0_24px_60px_rgba(0,0,0,0.5)]"
      >
        <div
          className="relative overflow-hidden border-b border-push-edge px-4 py-3"
          style={headerGlowVars}
        >
          <DottedGlowBackground
            className="opacity-60 mask-radial-to-85% mask-radial-at-left"
            gap={16}
            radius={1.4}
            colorLightVar="--push-glow-dot"
            glowColorLightVar="--push-glow-dot-glow"
            colorDarkVar="--push-glow-dot"
            glowColorDarkVar="--push-glow-dot-glow"
            colorKey={glowKey}
          />
          <div className="relative flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-push-fg">{title}</p>
              {subtitle && <p className="mt-0.5 text-push-2xs text-push-fg-dim">{subtitle}</p>}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {onDelete && (
                <button
                  type="button"
                  onClick={onDelete}
                  aria-label="Delete note"
                  className="flex h-7 w-7 items-center justify-center rounded-full border border-push-edge bg-black/20 text-push-fg-dim transition-colors hover:border-red-500/40 hover:text-red-400"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
              <button
                type="button"
                onClick={onClose}
                aria-label="Close editor"
                className="flex h-7 w-7 items-center justify-center rounded-full border border-push-edge bg-black/20 text-push-fg-dim transition-colors hover:text-push-fg"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>

        <textarea
          ref={textareaRef}
          value={content}
          onChange={(event) => onChange(event.target.value)}
          autoFocus
          placeholder="Capture notes, requirements, and the pieces you want the model to keep in mind…"
          className="min-h-0 flex-1 resize-none bg-transparent px-4 py-3.5 text-[15px] leading-relaxed text-push-fg outline-none placeholder:text-push-fg-dim"
        />
      </div>
    </div>
  );
}
