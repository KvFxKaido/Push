import type { ComponentProps } from 'react';
import { LauncherGridIcon, WorkspaceDockIcon } from '@/components/icons/push-custom-icons';
import { ChatContainer } from '@/components/chat/ChatContainer';
import { ChatInput } from '@/components/chat/ChatInput';
import { RepoChatDrawer } from '@/components/chat/RepoChatDrawer';
import { usePerfMark } from '@/hooks/usePerfMark';

type RepoChatDrawerProps = ComponentProps<typeof RepoChatDrawer>;
type ChatContainerProps = ComponentProps<typeof ChatContainer>;
type ChatInputProps = ComponentProps<typeof ChatInput>;

interface ChatSurfaceScreenProps {
  chatShellTransform: string;
  chatShellShadow: string;
  onOpenLauncher: () => void;
  onOpenWorkspaceHub: () => void;
  drawerProps: RepoChatDrawerProps;
  containerProps: ChatContainerProps;
  inputProps: ChatInputProps;
}

const HEADER_PLAIN_INTERACTIVE_CLASS =
  'relative text-push-fg-secondary transition-colors duration-200 hover:text-push-fg active:scale-[0.98]';
const HEADER_ROUND_BUTTON_CLASS =
  `flex h-9 w-9 items-center justify-center ${HEADER_PLAIN_INTERACTIVE_CLASS}`;
const HEADER_PILL_BUTTON_CLASS =
  `pointer-events-auto flex h-9 items-center gap-2 px-1.5 ${HEADER_PLAIN_INTERACTIVE_CLASS}`;

export function ChatSurfaceScreen({
  chatShellTransform,
  chatShellShadow,
  onOpenLauncher,
  onOpenWorkspaceHub,
  drawerProps,
  containerProps,
  inputProps,
}: ChatSurfaceScreenProps) {
  usePerfMark('chat-surface:painted', 'screen:workspace');
  return (
    <div className="relative flex h-dvh flex-col overflow-hidden bg-[#000] safe-area-top safe-area-bottom">
      <div
        className={`relative z-10 flex min-h-0 flex-1 flex-col bg-[#000] transition-[transform,box-shadow] duration-500 ease-in-out will-change-transform ${chatShellShadow}`}
        style={{ transform: chatShellTransform }}
      >
        <header className="relative z-10 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 px-3 pt-3 pb-2">
          <div className="relative z-20 flex min-w-0 items-center gap-2">
            <div className="flex h-[34px] min-w-0 items-center gap-1 pl-0.5 pr-1">
              <RepoChatDrawer {...drawerProps} />
              <div className="-ml-2.5 flex min-w-0 items-center self-stretch">
                <p className="truncate text-sm font-medium leading-tight text-[#f5f7ff]">
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
              onClick={onOpenWorkspaceHub}
              className={HEADER_ROUND_BUTTON_CLASS}
              aria-label="Open chat panel"
              title="Chat panel"
            >
              <WorkspaceDockIcon className="relative z-10 h-3.5 w-3.5" />
            </button>
          </div>
          <div className="pointer-events-none absolute inset-x-0 top-full h-8 bg-gradient-to-b from-black to-transparent" />
        </header>

        <ChatContainer {...containerProps} />
        <ChatInput {...inputProps} />
      </div>
    </div>
  );
}
