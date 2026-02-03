/**
 * Custom CodeMirror 6 dark theme matching Push's app palette.
 *
 * Colors pulled from the existing card/chat UI:
 * - bg: #111113 (card body), #0c0c0e (editor gutter)
 * - border: #1a1a1e
 * - text: #e4e4e7 (zinc-200)
 * - muted: #52525b (zinc-600), #3a3a3e
 * - accent: #a78bfa (violet-400) for keywords
 */

import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';

export const diffEditorTheme = EditorView.theme(
  {
    '&': {
      backgroundColor: '#111113',
      color: '#e4e4e7',
      fontSize: '13px',
      fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", ui-monospace, monospace',
    },
    '&.cm-focused': {
      outline: 'none',
    },
    '.cm-content': {
      caretColor: '#a78bfa',
      padding: '8px 0',
      lineHeight: '1.6',
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: '#a78bfa',
      borderLeftWidth: '2px',
    },
    '.cm-selectionBackground, ::selection': {
      backgroundColor: '#a78bfa26',
    },
    '&.cm-focused .cm-selectionBackground': {
      backgroundColor: '#a78bfa33',
    },
    '.cm-activeLine': {
      backgroundColor: '#ffffff06',
    },
    '.cm-gutters': {
      backgroundColor: '#0c0c0e',
      color: '#3a3a3e',
      border: 'none',
      borderRight: '1px solid #1a1a1e',
      minWidth: '40px',
    },
    '.cm-activeLineGutter': {
      backgroundColor: '#ffffff06',
      color: '#52525b',
    },
    '.cm-lineNumbers .cm-gutterElement': {
      padding: '0 8px 0 4px',
      fontSize: '12px',
      lineHeight: '1.6',
    },
    '.cm-foldGutter': {
      width: '12px',
    },
    // Scrollbar
    '.cm-scroller': {
      overflow: 'auto',
    },
    '.cm-scroller::-webkit-scrollbar': {
      width: '4px',
      height: '4px',
    },
    '.cm-scroller::-webkit-scrollbar-thumb': {
      background: '#1a1a1e',
      borderRadius: '2px',
    },
    '.cm-scroller::-webkit-scrollbar-thumb:hover': {
      background: '#27272a',
    },
    '.cm-scroller::-webkit-scrollbar-track': {
      background: 'transparent',
    },
  },
  { dark: true },
);

const highlightColors = HighlightStyle.define([
  // Keywords, control flow
  { tag: tags.keyword, color: '#a78bfa' },            // violet-400
  { tag: tags.controlKeyword, color: '#a78bfa' },
  { tag: tags.operatorKeyword, color: '#a78bfa' },

  // Functions
  { tag: tags.function(tags.variableName), color: '#67e8f9' },  // cyan-300
  { tag: tags.function(tags.definition(tags.variableName)), color: '#67e8f9' },

  // Strings
  { tag: tags.string, color: '#86efac' },              // green-300
  { tag: tags.special(tags.string), color: '#86efac' },

  // Numbers, booleans
  { tag: tags.number, color: '#fbbf24' },              // amber-400
  { tag: tags.bool, color: '#fbbf24' },

  // Comments
  { tag: tags.comment, color: '#52525b', fontStyle: 'italic' },  // zinc-600
  { tag: tags.lineComment, color: '#52525b', fontStyle: 'italic' },
  { tag: tags.blockComment, color: '#52525b', fontStyle: 'italic' },

  // Types, classes
  { tag: tags.typeName, color: '#fca5a5' },            // red-300
  { tag: tags.className, color: '#fca5a5' },
  { tag: tags.namespace, color: '#fca5a5' },

  // Variables, properties
  { tag: tags.variableName, color: '#e4e4e7' },
  { tag: tags.propertyName, color: '#93c5fd' },        // blue-300
  { tag: tags.definition(tags.propertyName), color: '#93c5fd' },

  // Operators, punctuation
  { tag: tags.operator, color: '#a1a1aa' },            // zinc-400
  { tag: tags.punctuation, color: '#71717a' },         // zinc-500
  { tag: tags.bracket, color: '#a1a1aa' },

  // Tags (HTML/JSX)
  { tag: tags.tagName, color: '#f87171' },             // red-400
  { tag: tags.attributeName, color: '#93c5fd' },       // blue-300
  { tag: tags.attributeValue, color: '#86efac' },

  // Regex
  { tag: tags.regexp, color: '#fb923c' },              // orange-400

  // Meta, annotations
  { tag: tags.meta, color: '#a1a1aa' },
  { tag: tags.annotation, color: '#c4b5fd' },          // violet-300

  // Headings (markdown)
  { tag: tags.heading, color: '#fafafa', fontWeight: 'bold' },
  { tag: tags.heading1, color: '#fafafa', fontWeight: 'bold' },
  { tag: tags.heading2, color: '#e4e4e7', fontWeight: 'bold' },

  // Links
  { tag: tags.link, color: '#67e8f9', textDecoration: 'underline' },
  { tag: tags.url, color: '#67e8f9' },

  // Emphasis
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: 'bold' },
]);

export const diffHighlighting = syntaxHighlighting(highlightColors);
