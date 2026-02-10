import { PanelRight } from 'lucide-react';

interface WorkspacePanelButtonProps {
  onClick: () => void;
  scratchpadHasContent: boolean;
  agentActive: boolean;
  disabled?: boolean;
}

export function WorkspacePanelButton({
  onClick,
  scratchpadHasContent,
  agentActive,
  disabled,
}: WorkspacePanelButtonProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#0d0d0d] text-[#52525b] transition-colors hover:text-[#a1a1aa] active:scale-95 disabled:opacity-40"
      aria-label="Open workspace panel"
      title="Workspace"
    >
      <PanelRight className="h-4 w-4" />
      {(scratchpadHasContent || agentActive) && (
        <span
          className={`absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-[#0070f3] ${
            agentActive ? 'animate-pulse' : ''
          }`}
        />
      )}
    </button>
  );
}
