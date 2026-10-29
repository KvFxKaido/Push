/**
 * Sandpack-backed renderer for `static-html` and `static-react` artifacts.
 *
 * Both kinds share a Sandpack instance — only the `template`, `entry`,
 * and (for React) `customSetup.dependencies` differ. The iframe is
 * height-capped to ~400px in the inline card so the artifact doesn't
 * dominate the chat; an "Expand" button opens the same preview in a
 * Radix Dialog at full height.
 *
 * Sandpack runs everything in an isolated iframe sandboxed by the same
 * cross-origin rules the codesandbox.io player uses. We forward the
 * model-supplied `dependencies` map verbatim — the renderer doesn't
 * curate a default set so the model can pin whatever it needs (Sandpack
 * defaults already cover React 18/19 for `static-react`).
 */

import { useState } from 'react';
import {
  Sandpack,
  type SandpackFiles,
  type SandpackPredefinedTemplate,
} from '@codesandbox/sandpack-react';
import { Maximize2, Code2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import type { ArtifactRecord, ArtifactFile } from '@push/lib/artifacts/types';

const INLINE_HEIGHT_PX = 400;
const EXPANDED_HEIGHT_PX = 720;

interface StaticPreviewProps {
  record: Extract<ArtifactRecord, { kind: 'static-html' | 'static-react' }>;
}

function toSandpackFiles(files: ArtifactFile[]): SandpackFiles {
  const out: SandpackFiles = {};
  for (const file of files) {
    // Sandpack expects keys to start with `/`. Normalize so authors can
    // pass either `App.js` or `/App.js` and get the same result.
    const key = file.path.startsWith('/') ? file.path : `/${file.path}`;
    out[key] = { code: file.content };
  }
  return out;
}

function resolveTemplate(record: StaticPreviewProps['record']): {
  template: SandpackPredefinedTemplate;
  entry: string;
} {
  if (record.kind === 'static-html') {
    return { template: 'static', entry: record.entry ?? '/index.html' };
  }
  // React: default entry is /App.js to match Sandpack's react template.
  return { template: 'react', entry: record.entry ?? '/App.js' };
}

interface PreviewBodyProps {
  record: StaticPreviewProps['record'];
  height: number;
}

function PreviewBody({ record, height }: PreviewBodyProps) {
  const { template, entry } = resolveTemplate(record);
  const files = toSandpackFiles(record.files);
  const dependencies =
    record.kind === 'static-react' ? (record.dependencies ?? undefined) : undefined;

  return (
    <Sandpack
      template={template}
      files={files}
      options={{
        showNavigator: false,
        showTabs: true,
        showLineNumbers: true,
        editorHeight: height,
        activeFile: entry,
      }}
      customSetup={dependencies ? { dependencies } : undefined}
    />
  );
}

export function StaticPreview({ record }: StaticPreviewProps) {
  const [open, setOpen] = useState(false);
  const fileCount = record.files.length;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 px-1">
        <div className="flex min-w-0 items-center gap-2 text-push-xs text-push-fg-dim">
          <Code2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="truncate">
            {record.kind === 'static-html' ? 'Static HTML' : 'React'}
            {' • '}
            {fileCount} file{fileCount === 1 ? '' : 's'}
          </span>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-full border border-push-edge-subtle bg-push-grad-input px-2.5 py-1 text-push-2xs font-medium text-push-fg-dim transition-colors duration-150 hover:border-push-edge-hover hover:text-push-fg"
              aria-label="Expand artifact preview"
            >
              <Maximize2 className="h-3 w-3" aria-hidden />
              <span>Expand</span>
            </button>
          </DialogTrigger>
          <DialogContent className="max-w-[90vw] sm:max-w-[1100px]">
            <DialogHeader>
              <DialogTitle>{record.title}</DialogTitle>
            </DialogHeader>
            <div className="mt-2">
              <PreviewBody record={record} height={EXPANDED_HEIGHT_PX} />
            </div>
          </DialogContent>
        </Dialog>
      </div>
      <PreviewBody record={record} height={INLINE_HEIGHT_PX} />
    </div>
  );
}

export default StaticPreview;
