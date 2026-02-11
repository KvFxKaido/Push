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
      className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[#8891a1] transition-all duration-200 hover:text-[#e2e8f0] spring-press disabled:opacity-40"
      aria-label="Open workspace panel"
      title="Workspace"
    >
      <PanelRight className="h-4 w-4" />
      {(scratchpadHasContent || agentActive) && (
        <span
          className={`absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-push-sky ${
            agentActive ? 'animate-pulse shadow-[0_0_6px_rgba(56,189,248,0.5)]' : ''
          }`}
        />
      )}
    </button>
  );
}
