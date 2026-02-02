/**
 * React hook that manages a CodeMirror 6 EditorView lifecycle.
 *
 * Handles:
 * - Creating/destroying the EditorView on mount/unmount
 * - Line numbers, syntax highlighting, custom theme
 * - Read-only vs editable mode
 * - Lazy language loading (async, swapped via compartment)
 */

import { useEffect, useRef, useState } from 'react';
import { EditorView, lineNumbers, drawSelection, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { defaultHighlightStyle, syntaxHighlighting, bracketMatching } from '@codemirror/language';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { keymap } from '@codemirror/view';
import { diffEditorTheme, diffHighlighting } from '@/lib/codemirror-theme';
import { loadLanguage } from '@/lib/codemirror-langs';

interface UseCodeMirrorOptions {
  doc: string;
  language?: string;
  readOnly?: boolean;
  onDocChange?: (doc: string) => void;
}

export function useCodeMirror({ doc, language, readOnly = true, onDocChange }: UseCodeMirrorOptions) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const langCompartment = useRef(new Compartment());
  const readOnlyCompartment = useRef(new Compartment());
  const [ready, setReady] = useState(false);

  // Create EditorView on mount
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged && onDocChange) {
        onDocChange(update.state.doc.toString());
      }
    });

    const state = EditorState.create({
      doc,
      extensions: [
        lineNumbers(),
        drawSelection(),
        bracketMatching(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        diffEditorTheme,
        diffHighlighting,
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        langCompartment.current.of([]),
        readOnlyCompartment.current.of(EditorState.readOnly.of(readOnly)),
        updateListener,
        EditorView.lineWrapping,
      ],
    });

    const view = new EditorView({ state, parent: container });
    viewRef.current = view;
    setReady(true);

    return () => {
      view.destroy();
      viewRef.current = null;
      setReady(false);
    };
    // Only run on mount/unmount — doc and readOnly are handled by separate effects
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load language async and reconfigure
  useEffect(() => {
    if (!viewRef.current || !language) return;

    let cancelled = false;
    loadLanguage(language).then((lang) => {
      if (cancelled || !viewRef.current) return;
      viewRef.current.dispatch({
        effects: langCompartment.current.reconfigure(lang ? [lang] : []),
      });
    });

    return () => { cancelled = true; };
  }, [language, ready]);

  // Sync readOnly changes
  useEffect(() => {
    if (!viewRef.current) return;
    viewRef.current.dispatch({
      effects: readOnlyCompartment.current.reconfigure(EditorState.readOnly.of(readOnly)),
    });
  }, [readOnly, ready]);

  // Sync doc from outside (e.g., when card data changes)
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const currentDoc = view.state.doc.toString();
    if (currentDoc !== doc) {
      view.dispatch({
        changes: { from: 0, to: currentDoc.length, insert: doc },
      });
    }
  }, [doc, ready]);

  return { containerRef, view: viewRef, ready };
}
