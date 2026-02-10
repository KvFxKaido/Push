/**
 * FileEditor — full-screen mobile file editor.
 *
 * Simple textarea-based editor optimized for mobile:
 * - Line numbers
 * - Character count with size warnings
 * - Save/discard with git-style diff preview
 * - Basic syntax highlighting via CSS classes
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { ArrowLeft, Save, RotateCcw, AlertCircle, Check, FileCode } from 'lucide-react';
import { toast } from 'sonner';
import { getFileEditability, isBinaryContent, formatFileSize } from '@/lib/file-utils';
import { readFromSandbox } from '@/lib/sandbox-client';
import type { FileEntry } from '@/types';

interface FileEditorProps {
  file: FileEntry;
  sandboxId: string;
  onBack: () => void;
  onSave: (path: string, content: string) => Promise<void>;
}

const MAX_FILE_SIZE = 1024 * 1024; // 1MB
const WARNING_SIZE = 50 * 1024; // 50KB

export function FileEditor({ file, sandboxId, onBack, onSave }: FileEditorProps) {
  const [content, setContent] = useState<string>('');
  const [originalContent, setOriginalContent] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [showDiff, setShowDiff] = useState(false);

  const editability = useMemo(() => getFileEditability(file.path, file.size), [file]);
  const language = editability.language || 'text';
  const isLargeFile = file.size > WARNING_SIZE;

  const loadFile = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const data = await readFromSandbox(sandboxId, file.path) as { content?: string };
      
      if (!data.content) {
        throw new Error('File is empty or could not be read');
      }

      // Check for binary content
      if (isBinaryContent(data.content)) {
        throw new Error('This file appears to be binary and cannot be edited');
      }

      // Check size after loading
      const byteLength = new Blob([data.content]).size;
      if (byteLength > MAX_FILE_SIZE) {
        throw new Error(`File too large (${formatFileSize(byteLength)}). Maximum editable size is 1MB.`);
      }

      setContent(data.content);
      setOriginalContent(data.content);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load file';
      setError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }, [sandboxId, file.path]);

  // Load file content on mount
  useEffect(() => {
    loadFile();
  }, [loadFile]);

  // Track changes
  useEffect(() => {
    setHasChanges(content !== originalContent);
  }, [content, originalContent]);

  const handleSave = async () => {
    if (!hasChanges) {
      onBack();
      return;
    }

    setSaving(true);
    try {
      await onSave(file.path, content);
      toast.success('File saved');
      onBack();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save file';
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = () => {
    if (hasChanges) {
      const confirmed = window.confirm('Discard unsaved changes?');
      if (!confirmed) return;
    }
    onBack();
  };

  const handleReset = () => {
    if (!hasChanges) return;
    const confirmed = window.confirm('Revert to original? All changes will be lost.');
    if (confirmed) {
      setContent(originalContent);
    }
  };

  // Simple line-based diff for preview
  const diffLines = useMemo(() => {
    if (!showDiff) return [];
    const original = originalContent.split('\n');
    const current = content.split('\n');
    const lines: { type: 'same' | 'added' | 'removed'; content: string; num: number }[] = [];
    
    // Simple LCS-based diff would be better, but this is a quick visual indicator
    let origIdx = 0;
    let currIdx = 0;
    
    while (origIdx < original.length || currIdx < current.length) {
      const origLine = original[origIdx];
      const currLine = current[currIdx];
      
      if (origLine === currLine) {
        lines.push({ type: 'same', content: origLine || '', num: currIdx + 1 });
        origIdx++;
        currIdx++;
      } else if (current.includes(origLine, currIdx) || !original.includes(currLine, origIdx)) {
        // Line added in current
        lines.push({ type: 'added', content: currLine || '', num: currIdx + 1 });
        currIdx++;
      } else {
        // Line removed from original
        lines.push({ type: 'removed', content: origLine || '', num: origIdx + 1 });
        origIdx++;
      }
      
      // Safety limit
      if (lines.length > 1000) break;
    }
    
    return lines;
  }, [showDiff, content, originalContent]);

  if (error) {
    return (
      <div className="flex h-dvh flex-col bg-[#000] safe-area-top">
        <header className="flex items-center gap-2 px-3 py-3 border-b border-[#1a1a1a]">
          <button
            onClick={onBack}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-[#a1a1aa] transition-colors hover:text-[#fafafa] hover:bg-[#0d0d0d]"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <h1 className="text-sm font-medium text-[#fafafa] flex-1 truncate">{file.name}</h1>
        </header>
        
        <div className="flex-1 flex flex-col items-center justify-center gap-4 px-6 text-center">
          <AlertCircle className="h-8 w-8 text-[#ef4444]/70" />
          <div>
            <p className="text-[#a1a1aa] text-sm mb-1">Cannot open file</p>
            <p className="text-[#52525b] text-xs">{error}</p>
          </div>
          <button
            onClick={onBack}
            className="px-4 py-2 rounded-lg bg-[#1a1a1a] text-[#fafafa] text-sm hover:bg-[#252525] transition-colors"
          >
            Go back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-dvh flex-col bg-[#000] safe-area-top">
      {/* Header */}
      <header className="flex items-center gap-2 px-3 py-3 border-b border-[#1a1a1a]">
        <button
          onClick={handleDiscard}
          disabled={saving}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-[#a1a1aa] transition-colors hover:text-[#fafafa] hover:bg-[#0d0d0d] disabled:opacity-40"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        
        <div className="flex-1 min-w-0">
          <h1 className="text-sm font-medium text-[#fafafa] truncate flex items-center gap-2">
            <FileCode className="h-3.5 w-3.5 text-push-accent" />
            {file.name}
          </h1>
          <p className="text-[10px] text-[#52525b]">
            {language} • {formatFileSize(new Blob([content]).size)}
            {isLargeFile && <span className="text-[#f59e0b] ml-1">large file</span>}
            {hasChanges && <span className="text-[#f59e0b] ml-1">• unsaved</span>}
          </p>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1">
          {hasChanges && (
            <button
              onClick={handleReset}
              disabled={saving}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-[#a1a1aa] transition-colors hover:text-[#fafafa] hover:bg-[#0d0d0d]"
              title="Revert changes"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
          )}
          
          <button
            onClick={() => setShowDiff(!showDiff)}
            disabled={saving}
            className={`flex h-8 px-3 items-center gap-1.5 rounded-lg text-xs transition-colors ${
              showDiff 
                ? 'bg-push-accent/20 text-push-accent' 
                : 'text-[#a1a1aa] hover:text-[#fafafa] hover:bg-[#0d0d0d]'
            } disabled:opacity-40`}
          >
            <Check className="h-3.5 w-3.5" />
            Diff
          </button>

          <button
            onClick={handleSave}
            disabled={saving || (!hasChanges && content === originalContent)}
            className="flex h-8 px-3 items-center gap-1.5 rounded-lg bg-[#22c55e] text-white text-xs font-medium transition-colors hover:bg-[#16a34a] disabled:opacity-40"
          >
            {saving ? (
              <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            Save
          </button>
        </div>
      </header>

      {/* Editor / Diff view */}
      <div className="flex-1 overflow-hidden relative">
        {loading ? (
          <div className="flex h-full items-center justify-center text-[#52525b]">
            <div className="flex flex-col items-center gap-3">
              <span className="w-5 h-5 border-2 border-[#52525b] border-t-push-accent rounded-full animate-spin" />
              <span className="text-xs">Loading...</span>
            </div>
          </div>
        ) : showDiff ? (
          <DiffView lines={diffLines} />
        ) : (
          <CodeEditor 
            content={content} 
            onChange={setContent} 
            language={language}
            disabled={saving}
          />
        )}
      </div>

      {/* Footer - character count */}
      <footer className="px-3 py-2 border-t border-[#1a1a1a] flex items-center justify-between text-[10px] text-[#52525b]">
        <span>{content.length.toLocaleString()} chars</span>
        <span>{content.split('\n').length.toLocaleString()} lines</span>
      </footer>
    </div>
  );
}

// --- Sub-components ---

interface CodeEditorProps {
  content: string;
  onChange: (value: string) => void;
  language: string;
  disabled?: boolean;
}

function CodeEditor({ content, onChange, disabled }: CodeEditorProps) {
  const lines = content.split('\n');
  
  return (
    <div className="flex h-full">
      {/* Line numbers */}
      <div className="flex-shrink-0 w-12 bg-[#0a0a0a] border-r border-[#1a1a1a] py-2 overflow-hidden select-none">
        {lines.map((_, i) => (
          <div 
            key={i} 
            className="min-h-[1.5em] px-2 text-right text-[10px] text-[#52525b] leading-[1.5em] font-mono"
          >
            {i + 1}
          </div>
        ))}
      </div>
      
      {/* Textarea */}
      <textarea
        value={content}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        className="flex-1 h-full bg-[#000] text-[#fafafa] p-2 text-xs font-mono leading-[1.5em] resize-none border-none outline-none focus:outline-none disabled:opacity-50"
        style={{ tabSize: 2 }}
      />
    </div>
  );
}

interface DiffLine {
  type: 'same' | 'added' | 'removed';
  content: string;
  num: number;
}

interface DiffViewProps {
  lines: DiffLine[];
}

function DiffView({ lines }: DiffViewProps) {
  return (
    <div className="h-full overflow-auto bg-[#0d0d0d] p-2 font-mono text-xs">
      {lines.length === 0 ? (
        <p className="text-[#52525b] text-center py-8">No changes</p>
      ) : (
        lines.map((line, i) => (
          <div
            key={i}
            className={`flex ${
              line.type === 'added' ? 'bg-[#22c55e]/10' : 
              line.type === 'removed' ? 'bg-[#ef4444]/10' : 
              ''
            }`}
          >
            <span className={`w-6 shrink-0 text-right pr-2 select-none ${
              line.type === 'added' ? 'text-[#22c55e]' : 
              line.type === 'removed' ? 'text-[#ef4444]' : 
              'text-[#52525b]'
            }`}>
              {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
            </span>
            <span className={`flex-1 whitespace-pre ${
              line.type === 'added' ? 'text-[#4ade80]' : 
              line.type === 'removed' ? 'text-[#f87171]' : 
              'text-[#a1a1aa]'
            }`}>
              {line.content || ' '}
            </span>
          </div>
        ))
      )}
    </div>
  );
}
