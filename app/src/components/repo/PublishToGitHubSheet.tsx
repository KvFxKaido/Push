import { useCallback, useState } from 'react';
import { Globe2, Loader2, Lock, Rocket } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  HUB_MATERIAL_INPUT_CLASS,
  HUB_MATERIAL_PILL_BUTTON_CLASS,
  HUB_PANEL_SUBTLE_SURFACE_CLASS,
  HubControlGlow,
} from '@/components/chat/hub-styles';

interface PublishToGitHubSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (args: { repoName: string; description?: string; isPrivate: boolean }) => Promise<void>;
}

const ACTION_BUTTON_CLASS = `${HUB_MATERIAL_PILL_BUTTON_CLASS} h-11 flex-1 gap-2 px-3 text-sm disabled:opacity-60`;

const VISIBILITY_OPTION_CLASS = `${HUB_PANEL_SUBTLE_SURFACE_CLASS} flex cursor-pointer items-start gap-3 px-3.5 py-3 transition-all duration-200`;

const ERROR_PANEL_CLASS =
  'rounded-[18px] border border-red-500/20 bg-[linear-gradient(180deg,rgba(70,23,23,0.18)_0%,rgba(31,11,11,0.34)_100%)] px-3.5 py-3';

function cleanToolMessage(message: string): string {
  return message
    .replace(/^\[Tool Error\]\s*/i, '')
    .replace(/^\[Tool Result.*?\]\s*/i, '')
    .trim();
}

export function PublishToGitHubSheet({ open, onOpenChange, onSubmit }: PublishToGitHubSheetProps) {
  const [repoName, setRepoName] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<'private' | 'public'>('private');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedRepoName = repoName.trim();
  const isValid = trimmedRepoName.length > 0;

  const resetState = useCallback(() => {
    setRepoName('');
    setDescription('');
    setVisibility('private');
    setSubmitting(false);
    setError(null);
  }, []);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (next) {
        resetState();
      }
      onOpenChange(next);
    },
    [onOpenChange, resetState],
  );

  const handleSubmit = useCallback(async () => {
    if (!isValid || submitting) return;

    setSubmitting(true);
    setError(null);

    try {
      await onSubmit({
        repoName: trimmedRepoName,
        description: description.trim() || undefined,
        isPrivate: visibility === 'private',
      });
      resetState();
      onOpenChange(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to publish workspace to GitHub.';
      setError(cleanToolMessage(message));
    } finally {
      setSubmitting(false);
    }
  }, [
    description,
    isValid,
    onOpenChange,
    onSubmit,
    resetState,
    submitting,
    trimmedRepoName,
    visibility,
  ]);

  const handleCancel = useCallback(() => {
    resetState();
    onOpenChange(false);
  }, [onOpenChange, resetState]);

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        side="bottom"
        className="max-h-[84dvh] overflow-y-auto rounded-t-2xl border-t border-push-edge bg-push-grad-panel px-5 pb-8 pt-0 text-push-fg"
      >
        <SheetHeader className="pb-1 pt-5">
          <SheetTitle className="flex items-center gap-2 text-sm font-semibold text-push-fg">
            <Rocket className="h-4 w-4 text-push-fg-dim" />
            Publish to GitHub
          </SheetTitle>
          <SheetDescription className="text-xs text-push-fg-dim">
            Create a repository and keep this workspace on GitHub.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-5">
          <div className="space-y-2">
            <Label htmlFor="publish-repo-name" className="text-xs text-push-fg-secondary">
              Repository name
            </Label>
            <Input
              id="publish-repo-name"
              placeholder="my-new-repo"
              value={repoName}
              onChange={(event) => {
                setRepoName(event.target.value);
                setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && isValid && !submitting) {
                  event.preventDefault();
                  void handleSubmit();
                }
              }}
              autoFocus
              disabled={submitting}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              className={`${HUB_MATERIAL_INPUT_CLASS} h-11 rounded-[18px] text-sm`}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="publish-description" className="text-xs text-push-fg-secondary">
              Description <span className="text-push-fg-dim">(optional)</span>
            </Label>
            <Textarea
              id="publish-description"
              placeholder="What is this workspace for?"
              value={description}
              onChange={(event) => {
                setDescription(event.target.value);
                setError(null);
              }}
              disabled={submitting}
              className={`${HUB_MATERIAL_INPUT_CLASS} min-h-[88px] rounded-[18px] px-3 py-2 text-sm resize-none`}
            />
          </div>

          <div className="space-y-2.5">
            <Label className="text-xs text-push-fg-secondary">Visibility</Label>
            <RadioGroup
              value={visibility}
              onValueChange={(value) => {
                setVisibility(value === 'public' ? 'public' : 'private');
                setError(null);
              }}
              className="gap-3"
            >
              <label
                className={`${VISIBILITY_OPTION_CLASS} ${
                  visibility === 'private'
                    ? 'border-push-edge-hover bg-push-grad-input shadow-[0_10px_24px_rgba(0,0,0,0.22)]'
                    : 'hover:border-push-edge-hover/80'
                }`}
              >
                <RadioGroupItem value="private" className="mt-0.5 border-[#3f3f46] text-push-sky" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-sm text-push-fg">
                    <Lock className="h-3.5 w-3.5 text-push-fg-dim" />
                    Private
                  </span>
                  <span className="mt-0.5 block text-push-xs text-push-fg-dim">
                    Only you and collaborators can see this repository.
                  </span>
                </span>
              </label>
              <label
                className={`${VISIBILITY_OPTION_CLASS} ${
                  visibility === 'public'
                    ? 'border-push-edge-hover bg-push-grad-input shadow-[0_10px_24px_rgba(0,0,0,0.22)]'
                    : 'hover:border-push-edge-hover/80'
                }`}
              >
                <RadioGroupItem value="public" className="mt-0.5 border-[#3f3f46] text-push-sky" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-sm text-push-fg">
                    <Globe2 className="h-3.5 w-3.5 text-push-fg-dim" />
                    Public
                  </span>
                  <span className="mt-0.5 block text-push-xs text-push-fg-dim">
                    Public repositories are visible to anyone on GitHub.
                  </span>
                </span>
              </label>
            </RadioGroup>
          </div>

          {error && (
            <div className={ERROR_PANEL_CLASS}>
              <p className="text-xs text-red-300">{error}</p>
            </div>
          )}

          <div className="rounded-[18px] border border-push-edge bg-black/20 px-3.5 py-3">
            <p className="text-xs text-push-fg-dim">
              Push will create the repository first, then try to push the current workspace branch.
              If there are no commits yet, the repository will still be created and connected.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleCancel}
              disabled={submitting}
              className={`${ACTION_BUTTON_CLASS} text-push-fg-secondary`}
            >
              <HubControlGlow />
              <span className="relative z-10">Cancel</span>
            </button>
            <button
              type="button"
              onClick={() => {
                void handleSubmit();
              }}
              disabled={!isValid || submitting}
              className={`${ACTION_BUTTON_CLASS} text-push-fg`}
            >
              <HubControlGlow />
              {submitting ? (
                <Loader2 className="relative z-10 h-4 w-4 animate-spin" />
              ) : (
                <Rocket className="relative z-10 h-4 w-4" />
              )}
              <span className="relative z-10">Create repository</span>
            </button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
