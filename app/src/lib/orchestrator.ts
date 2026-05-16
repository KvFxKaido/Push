import type { ChatMessage, WorkspaceContext } from '@/types';
import { formatVerificationPolicyBlock } from './verification-policy';
import { TOOL_PROTOCOL } from './github-tools';
import { LOCAL_PC_TOOL_PROTOCOL, getSandboxToolProtocol } from './sandbox-tools';
import { SCRATCHPAD_TOOL_PROTOCOL, buildScratchpadContext } from './scratchpad-tools';
import { TODO_TOOL_PROTOCOL } from './todo-tools';
import { WEB_SEARCH_TOOL_PROTOCOL } from './web-search-tools';
import { ASK_USER_TOOL_PROTOCOL } from './ask-user-tools';
import { getUserProfile } from '@/hooks/useUserProfile';
import type { UserProfile } from '@/types';
import { buildUserIdentityBlock } from '@push/lib/user-identity';
import { buildModelCapabilityAwarenessBlock } from './model-capabilities';
import { getApprovalMode, buildApprovalModeBlock } from './approval-mode';
import { buildSessionCapabilityBlock, buildSandboxEnvironmentBlock } from './workspace-context';
import { workspaceModeToExecutionMode } from '@push/lib/capabilities';
import { diffSnapshots, formatSnapshotDiff, type PromptSnapshot } from './system-prompt-builder';
import {
  buildOrchestratorBaseBuilder,
  buildOrchestratorBasePrompt,
} from './orchestrator-prompt-builder';
import { manageContext } from './message-context-manager';
import { transformContextBeforeLLM } from '@push/lib/context-transformer';
import { deriveUserGoalAnchor } from '@push/lib/user-goal-anchor';
import { estimateContextTokens } from './orchestrator-context';
import { estimateTokens as estimateRawTokens } from '@push/lib/context-budget';
import { isSyntheticDigestMessage, parseSessionDigest } from '@push/lib/session-digest';
import { getZenGoTransport } from './zen-go';
import { getVertexModelTransport } from './vertex-provider';

/** Whether a `(provider, model)` route lands on the Anthropic Messages API
 *  via the Worker bridge (`buildAnthropicMessagesRequest` →
 *  `createAnthropicTranslatedStream`). Only routes that pass through the
 *  bridge can consume the Push-private `reasoning_blocks` sidecar — all
 *  other paths forward the OpenAI-shape body verbatim and a strict
 *  upstream (Azure, OpenAI Chat, legacy Vertex) may reject the unknown
 *  field. Default false so new providers don't silently leak the sidecar. */
function routesThroughAnthropicBridge(
  provider: Exclude<ActiveProvider, 'demo'> | undefined,
  model: string | undefined,
): boolean {
  if (!provider || !model) return false;
  if (provider === 'zen') return getZenGoTransport(model) === 'anthropic';
  if (provider === 'vertex') return getVertexModelTransport(model) === 'anthropic';
  return false;
}
// --- Re-exports from orchestrator-streaming (break circular dependency) ---
export {
  parseProviderError,
  type StreamUsage,
  type ChunkMetadata,
} from './orchestrator-streaming';

import type { ChunkMetadata } from './orchestrator-streaming';
import type { ActiveProvider } from './orchestrator-provider-routing';

// --- Imports from extracted modules ---
import { getContextBudget } from './orchestrator-context';

// --- Barrel re-exports (preserve existing consumer import paths) ---
export {
  getContextMode,
  setContextMode,
  getContextBudget,
  estimateContextTokens,
  type ContextMode,
  type ContextBudget,
} from './orchestrator-context';

export {
  type ActiveProvider,
  getActiveProvider,
  isProviderAvailable,
  getProviderPushStream,
  streamChat,
} from './orchestrator-provider-routing';

// ---------------------------------------------------------------------------
// Shared: system prompt, demo text, message builder
// ---------------------------------------------------------------------------

/**
 * Exported for backwards compatibility (tests reference this).
 *
 * Context management helpers (`manageContext`, `classifySummarizationCause`,
 * `buildContextDigest`) now live in `lib/message-context-manager.ts` and are
 * imported via the `./message-context-manager` shim.
 *
 * Orchestrator prompt builders (`buildOrchestratorGuidelines`,
 * `buildOrchestratorToolInstructions`, `buildOrchestratorDelegation`,
 * `buildOrchestratorBaseBuilder`, `buildOrchestratorBasePrompt`) now live in
 * `lib/orchestrator-prompt-builder.ts` and are imported via the
 * `./orchestrator-prompt-builder` shim.
 */
export const ORCHESTRATOR_SYSTEM_PROMPT = buildOrchestratorBasePrompt();

/**
 * Last prompt snapshot per conversation-ish key. Two readers:
 *
 *   - The dev-only diff log inside `toLLMMessages` (previous-vs-current
 *     section-level diff, console-printed).
 *   - The `peekLastPromptSnapshot` accessor used by `chat-stream-round`
 *     to emit an `assistant.prompt_snapshot` run event per turn so a
 *     debug surface can answer "what exactly went to the model on turn
 *     N?" without re-running the prompt build. The accessor is the
 *     production wire — gating the populate behind `import.meta.env.DEV`
 *     would silently leave production turns without an audit trail.
 *
 * `consumed` prevents stale-snapshot misattribution: if a round resolved
 * without rebuilding the prompt (stream aborted before the PushStream
 * prelude ran, or a future `systemPromptOverride` mid-conversation),
 * `peekLastPromptSnapshot` would otherwise return the *previous* turn's
 * snapshot and the caller would emit it tagged with the wrong round.
 * Consume-on-peek closes that gap: the first peek after a populate
 * returns the entry and flips it consumed; subsequent peeks return null
 * until the next populate.
 *
 * `MAX_ENTRIES` caps process-lifetime growth. The Map is insertion-
 * ordered so iterating `keys()` gives FIFO and we evict the oldest
 * conversation when the cap is hit. 64 entries is enough to keep diff
 * context across multi-chat sessions while bounding worst-case
 * retention to a handful of KB of hash/size metadata.
 */
const MAX_PROMPT_SNAPSHOT_ENTRIES = 64;

interface PromptSnapshotEntry {
  snapshot: PromptSnapshot;
  totalChars: number;
  consumed: boolean;
}

const _lastPromptSnapshots = new Map<string, PromptSnapshotEntry>();

function recordPromptSnapshot(key: string, snapshot: PromptSnapshot, totalChars: number): void {
  if (_lastPromptSnapshots.has(key)) {
    _lastPromptSnapshots.delete(key);
  } else if (_lastPromptSnapshots.size >= MAX_PROMPT_SNAPSHOT_ENTRIES) {
    const oldestKey = _lastPromptSnapshots.keys().next().value;
    if (oldestKey !== undefined) _lastPromptSnapshots.delete(oldestKey);
  }
  _lastPromptSnapshots.set(key, { snapshot, totalChars, consumed: false });
}

function getPromptSnapshotKey(
  messages: ChatMessage[],
  workspaceContext?: WorkspaceContext,
): string {
  const firstUserMessage = messages.find(
    (message) => message.role === 'user' && !message.isToolResult,
  );
  if (firstUserMessage) {
    return `user:${firstUserMessage.id}`;
  }
  if (workspaceContext) {
    return `workspace:${workspaceContext.mode}:${workspaceContext.description}`;
  }
  return 'global';
}

/**
 * Read back the most recent system-prompt snapshot for the conversation
 * keyed by `(messages, workspaceContext)`. Used by `chat-stream-round`
 * to emit `assistant.prompt_snapshot` events without re-running the
 * prompt build. Returns null when no snapshot has been captured yet
 * (e.g. the caller passed a `systemPromptOverride` so the orchestrator
 * builder was skipped), or when the latest snapshot has already been
 * peeked. Consume-on-peek prevents stale snapshots from being
 * misattributed to a later turn when the orchestrator prompt build
 * was skipped this round.
 */
export function peekLastPromptSnapshot(
  messages: ChatMessage[],
  workspaceContext?: WorkspaceContext,
): { snapshot: PromptSnapshot; totalChars: number } | null {
  const key = getPromptSnapshotKey(messages, workspaceContext);
  const entry = _lastPromptSnapshots.get(key);
  if (!entry || entry.consumed) return null;
  entry.consumed = true;
  return { snapshot: entry.snapshot, totalChars: entry.totalChars };
}

// Multimodal content types (OpenAI-compatible)
interface LLMMessageContentText {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

interface LLMMessageContentImage {
  type: 'image_url';
  image_url: { url: string };
}

type LLMMessageContent = LLMMessageContentText | LLMMessageContentImage;

/** Push-private extension. Sent only on assistant messages routed through
 *  the Anthropic bridge; other backends ignore the field. See
 *  `chat-request-guardrails.ts` `OpenAIReasoningBlock` and
 *  `lib/provider-contract.ts` `ReasoningBlock` for the canonical shape. */
type LLMReasoningBlock =
  | { type: 'thinking'; text: string; signature: string }
  | { type: 'redacted_thinking'; data: string };

interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | LLMMessageContent[];
  intentHint?: string | null;
  reasoning_blocks?: LLMReasoningBlock[];
}

/** djb2 over the goal-anchor content keeps the synthetic id stable across
 *  calls so the transform stays a pure function of (messages, options).
 *  Mirrors `digestIdHash` in `message-context-manager.ts`; not factored out
 *  to keep the wire-facing wrapper modules dependency-free. */
function goalIdHash(content: string): string {
  let hash = 5381;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) + hash + content.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

function isNonEmptyContent(content: string | LLMMessageContent[]): boolean {
  if (Array.isArray(content)) {
    return content.length > 0;
  }
  return content.trim().length > 0;
}

/**
 * Build a chat instructions block for the system prompt.
 * Only used in chat mode — workspace mode uses project instructions (AGENTS.md) instead.
 */
export function buildChatInstructionsBlock(profile?: UserProfile): string {
  const instructions = profile?.chatInstructions?.trim();
  if (!instructions) return '';
  const escaped = instructions
    .replace(/\[CHAT INSTRUCTIONS\]/gi, '[CHAT INSTRUCTIONS\u200B]')
    .replace(/\[\/CHAT INSTRUCTIONS\]/gi, '[/CHAT INSTRUCTIONS\u200B]');
  return `## Chat Instructions\n${escaped}`;
}

export { buildUserIdentityBlock };

/**
 * Exported so PushStream implementations (`openrouter-stream.ts`,
 * `cloudflare-stream.ts`, etc.) can compose messages client-side via the
 * same prompt-assembly path. Not part of the public runtime API.
 */
/** Optional inputs for the session-digest transformer stage. Each piece is
 *  pre-resolved by the caller because the production memory stores return
 *  Promises from `list()` and `toLLMMessages` is synchronous. See
 *  `lib/session-digest.ts` for the digest contract and
 *  `lib/context-transformer.ts` for the stage's resolution order. */
export interface SessionDigestOptions {
  /** Scope-filtered `MemoryRecord` rows for the current chat/repo/branch.
   *  Caller awaits `store.list(predicate)` and passes the result. */
  records?: ReadonlyArray<import('@push/lib/runtime-contract').MemoryRecord>;
  /** Most-recent digest from the previous turn — caller-persisted, since
   *  the synthetic digest message in `transformed.messages` is not written
   *  back into the canonical transcript. */
  prior?: import('@push/lib/session-digest').SessionDigest;
  /** Invoked after the transform with the digest the model actually sees
   *  (post-merge with prior, if any), or null when no digest was emitted
   *  this turn. Caller persists this as the next turn's `prior` to make
   *  cross-turn accumulation reach production. */
  onEmit?: (digest: import('@push/lib/session-digest').SessionDigest | null) => void;
}

export function toLLMMessages(
  messages: ChatMessage[],
  workspaceContext?: WorkspaceContext,
  hasSandbox?: boolean,
  systemPromptOverride?: string,
  scratchpadContent?: string,
  providerType?: Exclude<ActiveProvider, 'demo'>,
  providerModel?: string,
  onPreCompact?: (event: import('@/types').PreCompactEvent) => void,
  intentHint?: string | null,
  todoContent?: string,
  sessionDigestOptions?: SessionDigestOptions,
): LLMMessage[] {
  // When a systemPromptOverride is provided (Auditor, Coder), the caller has already
  // composed a complete system prompt — don't append Orchestrator-specific protocols.
  let systemContent: string;
  const promptSnapshotKey = getPromptSnapshotKey(messages, workspaceContext);

  if (systemPromptOverride) {
    systemContent = systemPromptOverride;
    _lastPromptSnapshots.delete(promptSnapshotKey);
  } else {
    // Build the full orchestrator prompt using the sectioned builder.
    // Start from the shared base and layer in runtime-dependent blocks.
    //
    // `isLocalDaemon` switches the base tool-instructions + per-turn
    // budget between two grant shapes: cloud orchestrator (no
    // sandbox:exec, no repo:write → delegate everything) vs local-daemon
    // orchestrator (wider grant, drives sandbox tools directly). The
    // capability gate reads the same answer through
    // `getExecutionMode(context)` — both ends funnel through
    // `workspaceModeToExecutionMode` so the prompt cannot advertise a
    // wider grant than the runtime allows.
    const isLocalDaemon = workspaceModeToExecutionMode(workspaceContext?.mode) === 'local-daemon';
    const builder = buildOrchestratorBaseBuilder({ isLocalDaemon });

    // Chat mode — strip orchestrator tool instructions and delegation (plain
    // conversation). Web search is layered back in below so chat can still
    // ground answers on fresh information.
    if (workspaceContext?.mode === 'chat') {
      builder.set('tool_instructions', null);
      builder.set('delegation', null);
    }

    // Local-daemon modes (local-pc + relay) — strip the cloud
    // delegation block. The base `delegation` section advertises
    // delegate_coder / delegate_explorer with the literal "Trace the
    // auth flow / src/auth.ts" example that the model was parroting
    // verbatim in pwd-only conversations. The local-pc tool protocol
    // (injected below) tells the model NOT to delegate, but the
    // contradictory base block reduces the signal — strip it cleanly,
    // the same way chat does. Relay shares the same protocol — the
    // strip extends to it for the same reason. Copilot flagged this
    // as a low-confidence concern on PR #527; verified load-bearing
    // on inspection.
    if (isLocalDaemon) {
      builder.set('delegation', null);
    }

    // User identity (name, bio) when configured
    const profile = getUserProfile();
    const identityBlock = buildUserIdentityBlock(profile);
    const approvalBlock = buildApprovalModeBlock(getApprovalMode());
    const chatInstructionsBlock =
      workspaceContext?.mode === 'chat' ? buildChatInstructionsBlock(profile) : '';
    builder.set(
      'user_context',
      [identityBlock, chatInstructionsBlock, approvalBlock].filter(Boolean).join('\n\n'),
    );

    // Model capability awareness
    if (providerType && providerModel) {
      const hasImageAttachments = messages.some((message) =>
        Boolean(message.attachments?.some((attachment) => attachment.type === 'image')),
      );
      builder.set(
        'capabilities',
        buildModelCapabilityAwarenessBlock(providerType, providerModel, {
          hasImageAttachments,
        }),
      );
    }

    // Workspace description + GitHub tool protocol
    if (workspaceContext) {
      let envContent = workspaceContext.description;
      const capabilityBlock = buildSessionCapabilityBlock(workspaceContext, hasSandbox);
      if (capabilityBlock) {
        envContent += '\n\n' + capabilityBlock;
      }
      if (workspaceContext.includeGitHubTools) {
        envContent += '\n' + TOOL_PROTOCOL;
      }
      builder.set('environment', envContent);

      if (hasSandbox) {
        builder.set('sandbox_environment', buildSandboxEnvironmentBlock(true));
      }
    }

    // Session-level verification policy (from workspace context)
    const verificationPolicyBlock = formatVerificationPolicyBlock(
      workspaceContext?.verificationPolicy,
    );
    if (verificationPolicyBlock) {
      builder.append('guidelines', verificationPolicyBlock);
    }

    // Tool protocols — session-stable instructions about how to use tools.
    // Chat mode gets only the web_search protocol — no sandbox, delegation,
    // scratchpad, or ask_user — so it stays a plain conversation that can
    // still look things up on the web when the user asks.
    // Use set() to replace the base tool_instructions with the full set,
    // avoiding duplication if this code path runs more than once.
    if (workspaceContext?.mode === 'chat') {
      builder.set('tool_instructions', WEB_SEARCH_TOOL_PROTOCOL);
    } else {
      const baseToolInstructions = builder.get('tool_instructions') ?? '';
      const toolProtocols: string[] = [];
      // Local-daemon sessions (local-pc + relay) get a tailored tool
      // protocol: no `/workspace` path prior, no remote-bound tools
      // (commit/push/promote/draft), no Explorer/Coder delegation. The
      // cloud SANDBOX_TOOL_PROTOCOL fights the workspace-context block
      // otherwise — it mentions `/workspace` 9+ times and lists
      // remote-bound tools that the daemon can't service. Both modes
      // share the same daemon-backed transport (loopback vs Worker
      // relay) so the protocol shape is the same. Smoke-tested
      // 2026-05-13 for local-pc; relay extension addresses the Codex
      // P2 from PR #554 where relay was falling through to the cloud
      // protocol after the delegation strip widened.
      if (isLocalDaemon) {
        toolProtocols.push(LOCAL_PC_TOOL_PROTOCOL);
      } else if (hasSandbox) {
        toolProtocols.push(getSandboxToolProtocol());
      }
      toolProtocols.push(SCRATCHPAD_TOOL_PROTOCOL);
      toolProtocols.push(TODO_TOOL_PROTOCOL);
      toolProtocols.push(WEB_SEARCH_TOOL_PROTOCOL);
      toolProtocols.push(ASK_USER_TOOL_PROTOCOL);
      builder.set('tool_instructions', baseToolInstructions + '\n' + toolProtocols.join('\n'));

      // Memory block — the model's working-memory surfaces. Scratchpad holds
      // user-visible notes/context; todo holds the current step plan. Both
      // are volatile and change between turns.
      const memoryBlocks: string[] = [];
      if (scratchpadContent !== undefined) {
        memoryBlocks.push(buildScratchpadContext(scratchpadContent));
      }
      if (todoContent !== undefined) {
        memoryBlocks.push(todoContent);
      }
      if (memoryBlocks.length > 0) {
        builder.set('memory', memoryBlocks.join('\n\n'));
      }
    }

    // Intent hint (last so it overrides)
    builder.set('last_instructions', intentHint);

    systemContent = builder.build();

    // Always capture the snapshot (dev + prod). The accessor
    // `peekLastPromptSnapshot` reads this entry to emit per-turn
    // `assistant.prompt_snapshot` run events for debug surfaces.
    // Read the previous entry *before* recordPromptSnapshot overwrites
    // it so the DEV diff log still shows previous-vs-current sections.
    const currentSnap = builder.snapshot();
    const previousEntry = _lastPromptSnapshots.get(promptSnapshotKey);
    recordPromptSnapshot(promptSnapshotKey, currentSnap, systemContent.length);

    // --- Log prompt-size breakdown and section diffs (dev only) ---
    if (import.meta.env.DEV) {
      const fmt = (n: number) => n.toLocaleString();
      const sizes = builder.sizes();
      const parts = Object.entries(sizes)
        .map(([k, v]) => `${k}=${fmt(v)}`)
        .join(' ');
      console.log(`[Context Budget] System prompt: ${fmt(systemContent.length)} chars (${parts})`);

      if (previousEntry) {
        const diff = diffSnapshots(previousEntry.snapshot, currentSnap);
        const diffStr = formatSnapshotDiff(diff);
        if (diffStr) console.log(diffStr);
      }
    }
  }

  // Prompt caching: wrap the system message as a content-array with cache_control
  // for providers that support it (currently OpenRouter/Anthropic). Other
  // providers harmlessly ignore the extra field.
  const cacheable = providerType === 'openrouter';
  const llmMessages: LLMMessage[] = [
    cacheable
      ? {
          role: 'system',
          content: [
            { type: 'text', text: systemContent, cache_control: { type: 'ephemeral' } },
          ] as LLMMessageContent[],
        }
      : { role: 'system', content: systemContent },
  ];

  // Single boundary transform: visibility filter + smart context management.
  // Both stages were previously inline here. Consolidating into one pure
  // function keeps the prefix sent to the LLM byte-stable across turns when
  // only new messages were appended (cache hit rate). Pipeline order is
  // fixed inside the transformer; we cannot reorder filter vs. compaction
  // from this call site.
  const contextBudget = getContextBudget(providerType, providerModel);
  // Anchor the user's goal near the recent tail whenever compaction has
  // happened. v1 seeds the anchor from the first non-tool-result user turn;
  // null when there's no usable seed (e.g., empty transcript on first send).
  // Passing the full ordered user-turn list lets the anchor populate
  // `currentWorkingGoal` from an explicit redirect so the seed doesn't
  // over-pin the original ask. See `lib/user-goal-anchor.ts` for the
  // format pin.
  const userTurnContents = messages
    .filter((m) => m.role === 'user' && !m.isToolResult)
    .map((m) => (typeof m.content === 'string' ? m.content : ''));
  const firstUserTurn = userTurnContents[0];
  const userGoalAnchor =
    deriveUserGoalAnchor({ firstUserTurn, recentUserTurns: userTurnContents }) ?? undefined;

  // Records for the session-digest stage come from the caller, pre-fetched
  // and scope-filtered. The earlier sync `getDefaultMemoryStore().list()`
  // call here was a no-op in production: the policy-enforced IndexedDB
  // store returns a Promise, so `Array.isArray()` was always false and
  // the digest never saw any persisted MemoryRecord rows. Callers (the
  // stream wrappers under `app/src/lib/*-stream.ts`) now hydrate records
  // out-of-band — typically the chat round loop awaiting `store.list(scope)`
  // — and pass them on `PushStreamRequest.sessionDigestRecords`.
  const scopedRecords = sessionDigestOptions?.records ?? [];

  const transformed = transformContextBeforeLLM<ChatMessage>(messages, {
    surface: 'web',
    manageContext: (msgs) => {
      const result = manageContext(msgs, contextBudget, providerType, onPreCompact);
      // Don't infer compaction from array identity — manageContext may return
      // a fresh array (`[...messages]`) without rewriting any element, e.g.
      // when every message is already under the compaction threshold.
      // Detect actual structural change.
      const compactionApplied =
        result.length !== msgs.length || result.some((m, i) => m !== msgs[i]);
      return { messages: result, compactionApplied };
    },
    userGoalAnchor,
    createGoalMessage: (content): ChatMessage => ({
      id: `user-goal-anchor-${goalIdHash(content)}`,
      role: 'user',
      content,
      timestamp: 0,
      status: 'done',
      // Hidden in the UI; still sent to the model. Same trick as the
      // digest message factory in `message-context-manager.ts`.
      isToolResult: true,
    }),
    // Session digest stage (Hermes item 2). Materialized from caller-
    // provided `MemoryRecord` rows, with the active user-goal carried
    // through so the digest's `goal` field matches the anchor. Working
    // memory is the Coder's per-delegation state and isn't available at
    // the orchestrator boundary — the records path covers the cross-
    // session "decisions / files touched / outcomes" view.
    sessionDigestInputs: {
      records: scopedRecords,
      goal: userGoalAnchor?.currentWorkingGoal ?? userGoalAnchor?.initialAsk,
    },
    // Cross-turn merge anchor — see the option's JSDoc on
    // `TransformContextOptions`. When the caller persists the last emitted
    // digest, this is what makes the digest accumulate across turns
    // instead of churning per compaction.
    priorSessionDigest: sessionDigestOptions?.prior,
    createSessionDigestMessage: (content): ChatMessage => ({
      id: `session-digest-${goalIdHash(content)}`,
      role: 'user',
      content,
      timestamp: 0,
      status: 'done',
      // Hidden in the UI; visible to the model. Same isToolResult trick as
      // the goal-anchor and context-digest messages.
      isToolResult: true,
    }),
    // 85% gateway safety net: catches over-budget bodies that slip past
    // the per-agent compactor. Hermes documents this at 0.85 of the
    // request budget. Note the ceiling here is `0.85 * contextBudget.maxTokens`
    // — `maxTokens` is already ~92% of the model window, so the effective
    // ceiling is ~78% of the real window. Target sizes from `manageContext`
    // (88K of 100K maxTokens for the typical 100K budget = 88%) are above
    // this ceiling, so the net is reachable in normal operation, not just
    // pathological overshoots. The protected pins (system, first user task,
    // anchor/digest markers, tail window) keep load-bearing messages safe.
    //
    // `fixedOverheadTokens` accounts for the system prompt: the transformer
    // sees only the message array, but the wire request also carries
    // `systemContent` (project instructions + tool protocols + workspace
    // context — often 5K-15K tokens). Without subtracting that overhead the
    // 85% ceiling undercounts and large system prompts can push the real
    // request past the gateway budget even when the message body alone fits.
    safetyNet: {
      estimateTokens: (msgs) => estimateContextTokens(msgs as ChatMessage[]),
      budget: contextBudget.maxTokens,
      threshold: 0.85,
      preserveTail: 4,
      fixedOverheadTokens: estimateRawTokens(systemContent),
    },
  });
  const windowedMessages = transformed.messages;

  // Surface the emitted digest to the caller so they can persist it for
  // the next turn's `priorSessionDigest`. The transformer doesn't return
  // the structured digest separately — it embeds it in the message stream
  // — so we recover it. Narrow on `isSyntheticDigestMessage` (exact-block
  // shape, not just substring includes) so a real user/tool message that
  // quotes a digest block can't spoof the persistence sink. `null` when
  // no digest was emitted this turn (no compaction in play).
  if (sessionDigestOptions?.onEmit) {
    const digestMsg = windowedMessages.find((m) => isSyntheticDigestMessage(m));
    const digestContent = typeof digestMsg?.content === 'string' ? digestMsg.content : null;
    const parsed = digestContent ? parseSessionDigest(digestContent) : null;
    sessionDigestOptions.onEmit(parsed);
  }

  // Only emit `reasoning_blocks` on the wire when the route lands on the
  // Anthropic bridge. Other backends would forward the sidecar verbatim
  // to a strict OpenAI-compatible upstream (Azure, OpenAI Chat, legacy
  // Vertex), which may reject the unknown field. The persisted blocks
  // stay on the ChatMessage either way — when the user later switches
  // back to an Anthropic-bridge route, future turns pick them up again.
  const emitReasoningBlocks = routesThroughAnthropicBridge(providerType, providerModel);

  for (const msg of windowedMessages) {
    // Anthropic requires signed thinking blocks to be re-sent verbatim on
    // the assistant turn that produced them, ahead of any text/tool_use.
    // The wire field rides as a sidecar on the assistant LLMMessage; the
    // bridge layer (worker → openai-anthropic-bridge.ts) prepends them to
    // the upstream `content[]`.
    const reasoningBlocks =
      emitReasoningBlocks &&
      msg.role === 'assistant' &&
      msg.reasoningBlocks &&
      msg.reasoningBlocks.length > 0
        ? msg.reasoningBlocks
        : undefined;

    // Check for attachments (multimodal message)
    if (msg.attachments && msg.attachments.length > 0) {
      const contentParts: LLMMessageContent[] = [];

      // Add text first (if any)
      if (msg.content) {
        contentParts.push({ type: 'text', text: msg.content });
      }

      // Add attachments
      for (const att of msg.attachments) {
        if (att.type === 'image') {
          // Image: use image_url format with base64 data URL
          contentParts.push({
            type: 'image_url',
            image_url: { url: att.content },
          });
        } else {
          // Code/document: embed as text block
          contentParts.push({
            type: 'text',
            text: `[Attached file: ${att.filename}]\n\`\`\`\n${att.content}\n\`\`\``,
          });
        }
      }

      llmMessages.push({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: contentParts,
        ...(reasoningBlocks ? { reasoning_blocks: reasoningBlocks } : {}),
      });
    } else {
      // Simple text message (existing behavior)
      // Guard against provider-side validation errors:
      // some OpenAI-compatible backends reject empty assistant turns.
      // Exception: an assistant turn with no text but with signed
      // reasoning blocks is legitimate (Anthropic returns this when the
      // model thinks then immediately tool_uses) — keep it so the next
      // turn's request can echo the signature back.
      if (msg.role === 'assistant' && !msg.content.trim() && !reasoningBlocks) {
        continue;
      }
      llmMessages.push({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: msg.content,
        ...(reasoningBlocks ? { reasoning_blocks: reasoningBlocks } : {}),
      });
    }
  }

  // Prompt Caching: Hermes `system_and_3` strategy. The system message at
  // llmMessages[0] already got its marker above; here we tag up to 3 more
  // non-system messages from the tail. Anthropic caps a request at 4 cache
  // breakpoints, so `system + 3` stays at the limit. Walking backward catches
  // the rolling tail (typically last-user / last-assistant / last-tool-result)
  // where intermediate states from prior rounds become cache-hit candidates
  // on the next turn.
  //
  // Why this re-walks the wire array instead of consuming
  // `transformed.cacheBreakpointIndices` directly: the web wire-build loop
  // above drops empty-content assistant turns mid-iteration (the
  // `msg.role === 'assistant' && !msg.content.trim() && !reasoningBlocks`
  // continue), so the wire `llmMessages` array is NOT 1:1 with
  // `windowedMessages`. The transformer's indices are into `windowedMessages`
  // and can't be safely translated into wire indices without re-running the
  // same drop predicate. A backward walk on the already-built wire array
  // sidesteps that translation. CLI's wire builder doesn't have the same
  // drop behavior, so it consumes the indices directly.
  if (cacheable && llmMessages.length > 0) {
    let tagged = 0;
    for (let i = llmMessages.length - 1; i >= 0 && tagged < 3; i--) {
      const msg = llmMessages[i];
      if (msg.role === 'system') continue;
      if (typeof msg.content === 'string') {
        msg.content = [{ type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } }];
        tagged++;
      } else if (Array.isArray(msg.content)) {
        // Already an array (e.g. from attachments) — tag the last text part.
        const lastPart = msg.content[msg.content.length - 1];
        if (lastPart.type === 'text') {
          lastPart.cache_control = { type: 'ephemeral' };
          tagged++;
        }
      }
    }
  }

  // Final sanitize pass: never send empty assistant messages — except
  // assistant turns that carry signed reasoning blocks (the bridge will
  // emit them as the upstream `content[]`, so the message is not actually
  // empty on the wire).
  return llmMessages.filter((msg) => {
    if (msg.role !== 'assistant') return true;
    if (msg.reasoning_blocks && msg.reasoning_blocks.length > 0) return true;
    return isNonEmptyContent(msg.content);
  });
}

// ---------------------------------------------------------------------------
// Smart Chunking — reduces UI updates on mobile by batching tokens
// ---------------------------------------------------------------------------

/**
 * Creates a chunked emitter that batches tokens for smoother mobile UI.
 *
 * Tokens are buffered and emitted when:
 * 1. A word boundary (space/newline) is encountered
 * 2. Buffer reaches MIN_CHUNK_SIZE characters
 * 3. FLUSH_INTERVAL_MS passes without emission
 *
 * This reduces React setState calls from per-character to per-word,
 * dramatically improving performance on slower mobile devices.
 */
export interface ChunkedEmitter {
  push(token: string): void;
  flush(): void;
}

export function createChunkedEmitter(
  emit: (chunk: string, meta?: ChunkMetadata) => void,
  options?: { minChunkSize?: number; flushIntervalMs?: number },
): ChunkedEmitter {
  const MIN_CHUNK_SIZE = options?.minChunkSize ?? 4; // Min chars before emitting
  const FLUSH_INTERVAL_MS = options?.flushIntervalMs ?? 50; // Max time to hold tokens

  let buffer = '';
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let chunkIndex = 0;

  const doEmit = () => {
    if (buffer) {
      chunkIndex++;
      emit(buffer, { chunkIndex });
      buffer = '';
    }
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
  };

  const scheduleFlush = () => {
    if (!flushTimer) {
      flushTimer = setTimeout(doEmit, FLUSH_INTERVAL_MS);
    }
  };

  return {
    push(token: string) {
      buffer += token;

      // Emit on word boundaries (space, newline) if we have enough content
      const hasWordBoundary = /[\s\n]/.test(token);
      if (hasWordBoundary && buffer.length >= MIN_CHUNK_SIZE) {
        doEmit();
        return;
      }

      // Emit if buffer is getting large (long word without spaces)
      if (buffer.length >= MIN_CHUNK_SIZE * 4) {
        doEmit();
        return;
      }

      // Otherwise, schedule a flush to ensure tokens don't get stuck
      scheduleFlush();
    },

    flush() {
      doEmit();
    },
  };
}
