import { useState, type ComponentProps, type CSSProperties } from 'react';
import { Palette } from 'lucide-react';
import { LauncherGridIcon, WorkspaceDockIcon } from '@/components/icons/push-custom-icons';
import { ChatBackgroundGlow } from '@/components/chat/ChatBackgroundGlow';
import { ChatContainer } from '@/components/chat/ChatContainer';
import { ChatInput } from '@/components/chat/ChatInput';
import { RepoChatDrawer } from '@/components/chat/RepoChatDrawer';
import { HEADER_PILL_BUTTON_CLASS, HEADER_ROUND_BUTTON_CLASS } from '@/components/chat/hub-styles';
import { RepoAppearanceSheet } from '@/components/repo/RepoAppearanceSheet';
import { usePerfMark } from '@/hooks/usePerfMark';
import type { RepoAppearance } from '@/lib/repo-appearance';

type RepoChatDrawerProps = ComponentProps<typeof RepoChatDrawer>;
type ChatContainerProps = ComponentProps<typeof ChatContainer>;
type ChatInputProps = ComponentProps<typeof ChatInput>;

interface ChatSurfaceScreenProps {
  chatShellTransform: string;
  chatShellShadow: string;
  /** Extra inline style for the chat shell (pager-mode opacity/filter/transition). */
  chatShellStyle?: CSSProperties;
  onOpenLauncher: () => void;
  onOpenWorkspaceHub: () => void;
  drawerProps: RepoChatDrawerProps;
  containerProps: ChatContainerProps;
  inputProps: ChatInputProps;
  appearance: RepoAppearance;
  accentHex: string;
  onSaveAppearance: (appearance: RepoAppearance) => void;
  onResetAppearance: () => void;
}

export function ChatSurfaceScreen({
  chatShellTransform,
  chatShellShadow,
  chatShellStyle,
  onOpenLauncher,
  onOpenWorkspaceHub,
  drawerProps,
  containerProps,
  inputProps,
  appearance,
  accentHex,
  onSaveAppearance,
  onResetAppearance,
}: ChatSurfaceScreenProps) {
  usePerfMark('chat-surface:painted', 'surface:chat');
  const [appearanceSheetOpen, setAppearanceSheetOpen] = useState(false);
  return (
    <div className="relative flex h-dvh flex-col overflow-hidden bg-push-surface-inset safe-area-top safe-area-bottom">
      <div
        className={`relative z-10 isolate flex min-h-0 flex-1 flex-col bg-push-surface-inset transition-[transform,box-shadow] duration-500 ease-in-out will-change-transform ${chatShellShadow}`}
        style={{ transform: chatShellTransform, ...chatShellStyle }}
      >
        <ChatBackgroundGlow
          active={appearance.glowEnabled}
          color={accentHex}
          variant={appearance.glowStyle}
        />
        <header className="relative z-10 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 px-3 pt-3 pb-2">
          <div className="relative z-20 flex min-w-0 items-center gap-2">
            <div className="flex h-[34px] min-w-0 items-center gap-1 pl-0.5 pr-1">
              <RepoChatDrawer {...drawerProps} />
              <div className="-ml-2.5 flex min-w-0 items-center self-stretch">
                <p className="truncate text-sm font-medium leading-tight text-push-fg">
                  <span className="hidden sm:inline">Chat</span>
                </p>
              </div>
            </div>
          </div>

          <div className="flex min-w-0 justify-center">
            <button
              onClick={onOpenLauncher}
              className={`${HEADER_PILL_BUTTON_CLASS} group min-w-0 max-w-full`}
              aria-label="Open launcher"
              title="Launcher"
            >
              <LauncherGridIcon className="relative z-10 h-3.5 w-3.5 text-push-fg-secondary transition-colors group-hover:text-push-fg" />
              <span className="relative z-10 max-w-[92px] truncate text-xs font-medium text-push-fg-secondary transition-colors group-hover:text-push-fg sm:max-w-[128px]">
                Launcher
              </span>
            </button>
          </div>

          <div className="relative z-20 flex min-w-0 items-center justify-end gap-2">
            <button
              onClick={() => setAppearanceSheetOpen(true)}
              className={HEADER_ROUND_BUTTON_CLASS}
              aria-label="Customize chat appearance"
              title="Customize chat"
            >
              <Palette className="relative z-10 h-3.5 w-3.5" />
            </button>
            <button
              onClick={onOpenWorkspaceHub}
              className={HEADER_ROUND_BUTTON_CLASS}
              aria-label="Open chat panel"
              title="Chat panel"
            >
              <WorkspaceDockIcon className="relative z-10 h-3.5 w-3.5" />
            </button>
          </div>
        </header>

        <ChatContainer {...containerProps} />
        <ChatInput {...inputProps} />
      </div>
      {appearanceSheetOpen && (
        <RepoAppearanceSheet
          open={appearanceSheetOpen}
          onOpenChange={setAppearanceSheetOpen}
          repoName="Chat"
          appearance={appearance}
          onSave={onSaveAppearance}
          onReset={onResetAppearance}
          description="Pick a quiet accent color for chat mode on this device."
        />
      )}
    </div>
  );
}
