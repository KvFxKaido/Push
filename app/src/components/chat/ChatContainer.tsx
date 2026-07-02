import { useEffect, useMemo, useState } from 'react';
import { ArrowDownToLine, Ban, Check, RotateCcw, Square, X } from 'lucide-react';
import type { RunHostAttachHandle } from '@/hooks/useRunHostAttach';
import type {
  ChatMessage,
  AgentStatus,
  ActiveRepo,
  CardAction,
  RunCheckpoint,
  LoopPhase,
  CIStatus,
  QuickPrompt,
  BranchSwitchSource,
} from '@/types';
import { groupChatMessages } from './tool-call-utils';
import { CIStatusBanner } from './CIStatusBanner';
import { MergeDetectedBanner } from './MergeDetectedBanner';
import { TranscriptList } from './transcript/TranscriptList';
import type { TranscriptHandlers } from './transcript/segment-model';
import { MessageViewStateProvider } from '@/hooks/MessageViewStateProvider';
import { getEmptyStateQuickPrompts } from '@/lib/quick-prompts';
import type { MergeDetectedBannerState } from '@/lib/merge-detected-banner-state';
import { PushMarkIcon } from '@/components/icons/push-custom-icons';
import { getRoleDisplay } from '@push/lib/role-display';
import {
  HUB_MATERIAL_PILL_BUTTON_CLASS,
  HUB_TOP_BANNER_STRIP_CLASS,
} from '@/components/chat/hub-styles';

// --- Resume Banner (Resumable Sessions Phase 2) ---

function phaseLabel(phase: LoopPhase): string {
  switch (phase) {
    case 'streaming_llm':
      return 'mid-response';
    case 'executing_tools':
      return 'mid-tool-execution';
    case 'delegating_coder':
      return `during the ${getRoleDisplay('coder').phase} phase`;
    case 'delegating_explorer':
      return `during the ${getRoleDisplay('explorer').phase} phase`;
    case 'executing_task_graph':
      return 'during task graph execution';
  }
}

function formatCheckpointAge(savedAt: number): string {
  const ageMs = Date.now() - savedAt;
  const ageMin = Math.floor(ageMs / 60_000);
  return ageMin < 1 ? 'just now' : `${ageMin}m ago`;
}

function ResumeBanner({
  checkpoint,
  onResume,
  onDismiss,
}: {
  checkpoint: RunCheckpoint;
  onResume: () => void;
  onDismiss: () => void;
}) {
  const [ageLabel, setAgeLabel] = useState('just now');

  useEffect(() => {
    // Use setInterval for both initial and periodic updates — avoids synchronous
    // setState in effect body which trips the react-hooks/set-state-in-effect rule.
    const timer = setInterval(() => setAgeLabel(formatCheckpointAge(checkpoint.savedAt)), 30_000);
    // Fire the first update asynchronously via setTimeout(0)
    const initial = setTimeout(() => setAgeLabel(formatCheckpointAge(checkpoint.savedAt)), 0);
    return () => {
      clearInterval(timer);
      clearTimeout(initial);
    };
  }, [checkpoint.savedAt]);

  return (
    <div
      className={`mx-4 mt-5 mb-1 flex items-center justify-between gap-3 px-1 py-2.5 ${HUB_TOP_BANNER_STRIP_CLASS} border-amber-500/25`}
    >
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-amber-200">
          Session interrupted {phaseLabel(checkpoint.phase)}
        </p>
        <p className="text-push-xs text-amber-200/60 mt-0.5">
          Round {checkpoint.round + 1} &middot; {ageLabel}
          {checkpoint.coderDelegationActive ? ' &middot; Coder was active' : ''}
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button
          onClick={onResume}
          className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} gap-1.5 px-3 text-amber-200`}
        >
          <RotateCcw className="h-3 w-3" />
          <span>Resume</span>
        </button>
        <button
          onClick={onDismiss}
          className="flex h-7 w-7 items-center justify-center rounded-full text-amber-200/40 transition-colors hover:bg-amber-900/20 hover:text-amber-200/70 active:scale-95"
          aria-label="Dismiss"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

// --- Run-host attach banner (Durable Runs Phase 3) ---

/**
 * Surface for a run that lived on (or finished) server-side while this
 * client was away. The transcript is hydrated automatically by
 * `useRunHostAttach`; this banner is the control surface — approve/deny a
 * paused gate, stop the server-side run, or pull it back local.
 */
function RunHostAttachBanner({ attach }: { attach: RunHostAttachHandle }) {
  const run = attach.hostRun;
  if (!run) return null;

  const paused = run.state === 'adopted' && run.pausedForApproval ? run.pausedForApproval : null;
  const ended = run.state === 'ended' || !run.midFlight;

  const title = paused
    ? (paused.title ?? 'Approval required')
    : ended
      ? 'Run finished server-side'
      : run.state === 'adopted'
        ? 'Run continuing server-side'
        : 'Run waiting server-side';
  const detail = paused
    ? (paused.summary ?? paused.kind)
    : ended
      ? `Transcript synced · round ${run.round + 1}`
      : run.lastError
        ? run.lastError
        : `Round ${run.round + 1} · transcript follows live`;

  const pill = `${HUB_MATERIAL_PILL_BUTTON_CLASS} gap-1.5 px-3 text-sky-200 disabled:opacity-50`;
  return (
    <div
      className={`mx-4 mt-5 mb-1 flex items-center justify-between gap-3 px-1 py-2.5 ${HUB_TOP_BANNER_STRIP_CLASS} border-sky-500/25`}
    >
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-sky-200">{title}</p>
        <p className="text-push-xs text-sky-200/60 mt-0.5 truncate">{detail}</p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {paused && (
          <>
            <button onClick={attach.approveHostGate} disabled={run.busy} className={pill}>
              <Check className="h-3 w-3" />
              <span>Approve</span>
            </button>
            <button onClick={attach.denyHostGate} disabled={run.busy} className={pill}>
              <Ban className="h-3 w-3" />
              <span>Deny</span>
            </button>
          </>
        )}
        {!ended && (
          <button onClick={attach.pullHostRunLocal} disabled={run.busy} className={pill}>
            <ArrowDownToLine className="h-3 w-3" />
            <span>Continue here</span>
          </button>
        )}
        {!ended && !paused && (
          <button
            onClick={attach.stopHostRun}
            disabled={run.busy}
            className={pill}
            aria-label="Stop server-side run"
          >
            <Square className="h-3 w-3" />
            <span>Stop</span>
          </button>
        )}
        <button
          onClick={attach.dismissHostRun}
          className="flex h-7 w-7 items-center justify-center rounded-full text-sky-200/40 transition-colors hover:bg-sky-900/20 hover:text-sky-200/70 active:scale-95"
          aria-label="Dismiss"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

interface ChatContainerProps {
  messages: ChatMessage[];
  agentStatus: AgentStatus;
  activeRepo?: ActiveRepo | null;
  hasSandbox?: boolean;
  isChat?: boolean;
  onSuggestion?: (prompt: QuickPrompt) => void;
  onCardAction?: (action: CardAction) => void;
  onPin?: (content: string, messageId: string) => void;
  interruptedCheckpoint?: RunCheckpoint | null;
  onResumeRun?: () => void;
  onDismissResume?: () => void;
  /** Durable Runs Phase 3 — attach/viewer controls for a server-side run. */
  runHostAttach?: RunHostAttachHandle | null;
  ciStatus?: CIStatus | null;
  onDiagnoseCI?: () => void;
  mergeDetected?: MergeDetectedBannerState | null;
  mergeBranchInUI?: (
    toBranch: string,
    opts?: { from?: string; prNumber?: number; source?: BranchSwitchSource },
  ) => Promise<{ ok: boolean; errorMessage?: string } | void> | void;
  onDismissMergeDetected?: () => void;
  onEditUserMessage?: (messageId: string) => void;
  onRegenerateLastResponse?: () => void;
}

function EmptyState({
  activeRepo,
  hasSandbox,
  isChat,
  onSuggestion,
}: {
  activeRepo?: ActiveRepo | null;
  hasSandbox?: boolean;
  isChat?: boolean;
  onSuggestion?: (prompt: QuickPrompt) => void;
}) {
  const [hexTap, setHexTap] = useState(false);

  const handleHexTap = () => {
    setHexTap(false);
    // Force reflow so re-adding the class restarts the animation
    requestAnimationFrame(() => setHexTap(true));
  };

  const suggestions = useMemo(
    () => (isChat ? [] : getEmptyStateQuickPrompts(activeRepo, hasSandbox)),
    [activeRepo, hasSandbox, isChat],
  );

  return (
    <div className="flex flex-1 items-center justify-center px-8">
      <div className="text-center max-w-sm">
        {!isChat && (
          <>
            <button
              type="button"
              onClick={handleHexTap}
              className="mx-auto mb-5 flex h-12 w-12 cursor-pointer items-center justify-center rounded-xl border border-push-edge bg-push-grad-icon shadow-[0_12px_30px_rgba(0,0,0,0.55)] active:scale-95 transition-transform"
            >
              <PushMarkIcon
                className={`text-push-accent transition-colors ${hexTap ? 'hex-tap' : ''}`}
                pathClassName={`transition-all duration-300 ${hexTap ? 'fill-push-accent/20' : 'fill-transparent'}`}
                height={22}
                onAnimationEnd={() => setHexTap(false)}
                width={22}
              />
            </button>
            <h2 className="mb-2.5 text-push-2xl font-display font-semibold text-push-fg">
              {activeRepo ? activeRepo.name : hasSandbox ? 'Workspace' : 'Push'}
            </h2>
          </>
        )}
        {isChat && (
          <h2 className="mb-3 text-push-2xl font-display font-semibold text-push-fg">
            Start a conversation
          </h2>
        )}
        <p className="text-sm leading-relaxed text-push-fg-secondary">
          {isChat
            ? 'Think through ideas, ask questions, or plan your next move.'
            : activeRepo
              ? `Focused on ${activeRepo.full_name}. Ask about PRs, recent changes, or the codebase.`
              : hasSandbox
                ? 'Ephemeral workspace — write code, run commands, and prototype ideas from scratch.'
                : 'AI coding agent with direct repo access. Review PRs, explore codebases, and ship changes — all from here.'}
        </p>
        {suggestions.length > 0 && (
          <div className="mt-6 flex flex-col gap-2.5 stagger-in">
            {suggestions.map((suggestion) => (
              <button
                key={suggestion.label}
                onClick={() => onSuggestion?.(suggestion)}
                className="cursor-pointer rounded-xl border border-push-edge bg-push-grad-card px-4 py-3 text-left text-sm text-push-fg-secondary shadow-push-card card-hover spring-press hover:border-push-edge-hover hover:text-push-fg hover:shadow-push-card-hover"
              >
                {suggestion.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function ChatContainer({
  messages,
  agentStatus,
  activeRepo,
  hasSandbox,
  isChat,
  onSuggestion,
  onCardAction,
  onPin,
  interruptedCheckpoint,
  onResumeRun,
  onDismissResume,
  runHostAttach,
  ciStatus,
  onDiagnoseCI,
  mergeDetected,
  mergeBranchInUI,
  onDismissMergeDetected,
  onEditUserMessage,
  onRegenerateLastResponse,
}: ChatContainerProps) {
  // Split messages into settled (all but the active streaming tail) and active.
  // The settled set is grouped once and memoized so streaming chunks — which
  // only mutate the tail — don't re-group or re-render the settled segments.
  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
  const isLastStreaming = lastMessage?.status === 'streaming';
  const settledMessages = useMemo(
    () => (isLastStreaming ? messages.slice(0, -1) : messages),
    [isLastStreaming, messages],
  );
  const activeMessage = isLastStreaming ? lastMessage : null;
  // The streaming loop clones `messages` every token, so this regroups
  // mid-stream — but grouping is a cheap O(n) pass. The expensive part (settled
  // MessageBubble re-renders: markdown, syntax highlighting, mermaid) is
  // prevented by SegmentView's content-based memo, which compares the underlying
  // message refs that stay stable while only the tail changes.
  const segments = useMemo(() => groupChatMessages(settledMessages), [settledMessages]);

  // The last *real* user turn (excluding synthetic tool-result messages). The
  // plain transcript anchors this near the top of the viewport — on load, so a
  // reopened chat lands on the last thing the reader said rather than the
  // absolute bottom (shadcn point 11), and on each new turn, so the answer
  // streams into the space below it (points 4–5). Its id only changes when a new
  // user turn arrives or a different chat loads — never per streaming token.
  const lastUserMessageId = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message.role === 'user' && !message.isToolResult) return message.id;
    }
    return null;
  }, [messages]);

  const regeneratableAssistantMessageId = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message.role !== 'assistant') continue;
      if (message.status === 'streaming' || message.status === 'error') continue;
      if (message.isToolCall || message.isMalformed) continue;
      // Display-only messages (tool_prose narration, branch/compaction
      // dividers) aren't real turns — regenerating one would replay the
      // wrong anchor.
      if (message.visibleToModel === false) continue;
      return message.id;
    }
    return null;
  }, [messages]);

  // One memoized handler bundle for both transcript paths — its stable identity
  // is what lets settled segments skip re-rendering while the tail streams.
  const handlers = useMemo<TranscriptHandlers>(
    () => ({
      onCardAction,
      onPin,
      onEditUserMessage,
      regeneratableAssistantMessageId,
      onRegenerateLastResponse,
    }),
    [
      onCardAction,
      onPin,
      onEditUserMessage,
      regeneratableAssistantMessageId,
      onRegenerateLastResponse,
    ],
  );

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 flex-col overflow-hidden">
        {runHostAttach?.hostRun && <RunHostAttachBanner attach={runHostAttach} />}
        {!runHostAttach?.hostRun && interruptedCheckpoint && onResumeRun && onDismissResume && (
          <ResumeBanner
            checkpoint={interruptedCheckpoint}
            onResume={onResumeRun}
            onDismiss={onDismissResume}
          />
        )}
        {ciStatus && onDiagnoseCI && <CIStatusBanner status={ciStatus} onDiagnose={onDiagnoseCI} />}
        {mergeDetected && mergeBranchInUI && onDismissMergeDetected && (
          <MergeDetectedBanner
            {...mergeDetected}
            mergeBranchInUI={mergeBranchInUI}
            onDismiss={onDismissMergeDetected}
          />
        )}

        <EmptyState
          activeRepo={activeRepo}
          hasSandbox={hasSandbox}
          isChat={isChat}
          onSuggestion={onSuggestion}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {runHostAttach?.hostRun && <RunHostAttachBanner attach={runHostAttach} />}
      {!runHostAttach?.hostRun && interruptedCheckpoint && onResumeRun && onDismissResume && (
        <ResumeBanner
          checkpoint={interruptedCheckpoint}
          onResume={onResumeRun}
          onDismiss={onDismissResume}
        />
      )}
      {ciStatus && onDiagnoseCI && <CIStatusBanner status={ciStatus} onDiagnose={onDiagnoseCI} />}
      {mergeDetected && mergeBranchInUI && onDismissMergeDetected && (
        <MergeDetectedBanner
          {...mergeDetected}
          mergeBranchInUI={mergeBranchInUI}
          onDismiss={onDismissMergeDetected}
        />
      )}

      {/* Holds per-message UI toggles (action row / reasoning / sources) above
          the virtualization boundary so they survive the streaming→settled
          handoff and Virtuoso remounts. */}
      <MessageViewStateProvider>
        <TranscriptList
          segments={segments}
          activeMessage={activeMessage}
          agentStatus={agentStatus}
          handlers={handlers}
          lastMessage={lastMessage}
          lastUserMessageId={lastUserMessageId}
        />
      </MessageViewStateProvider>
    </div>
  );
}
