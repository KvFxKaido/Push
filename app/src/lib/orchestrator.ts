import type { ChatMessage, WorkspaceContext } from '@/types';
import { formatVerificationPolicyBlock } from './verification-policy';
import { TOOL_PROTOCOL } from './github-tools';
import { LOCAL_PC_TOOL_PROTOCOL, getSandboxToolProtocol } from './sandbox-tools';
import { SCRATCHPAD_TOOL_PROTOCOL, buildScratchpadContext } from './scratchpad-tools';
import { TODO_TOOL_PROTOCOL } from './todo-tools';
import { WEB_SEARCH_TOOL_PROTOCOL } from './web-search-tools';
import { MEMORY_TOOL_PROTOCOL } from './memory-tools';
import { getWebSearchMode, isNativeWebSearchEnabled } from './web-search-mode';
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
import {
  type CacheControl,
  EPHEMERAL_CACHE_CONTROL,
  type LlmContentBlock,
} from '@push/lib/provider-contract';
import { materializeToolContentBlocks } from '@push/lib/content-blocks';
import { deriveUserGoalAnchor } from '@push/lib/user-goal-anchor';
import { estimateContextTokens } from './orchestrator-context';
import { estimateTokens as estimateRawTokens } from '@push/lib/context-budget';
import { extractMarkedBlock, type PromptCompositionCost } from '@push/lib/prompt-cost-telemetry';
import {
  PROJECT_INSTRUCTIONS_OPEN_PREFIX,
  PROJECT_INSTRUCTIONS_CLOSE,
} from '@push/lib/project-instructions';
import { isSyntheticDigestMessage, parseSessionDigest } from '@push/lib/session-digest';
import { buildAttachmentContentBlocks } from './attachment-content-parts';
// Whether a `(provider, model)` route needs reasoning replay sidecars. Shared
// with the failover candidate resolver for signed Anthropic blocks; plain
// DeepSeek reasoning_content stays route-gated separately because other
// OpenAI-compatible models reject it.
import {
  routeReplaysReasoningContent,
  routesThroughAnthropicBridge,
} from './orchestrator-provider-routing';
// --- Re-exports from orchestrator-streaming (break circular dependency) ---
export {
  createChunkedEmitter,
  parseProviderError,
  type StreamUsage,
  type ChunkMetadata,
} from './orchestrator-streaming';

import type { ActiveProvider } from './orchestrator-provider-routing';

// --- Imports from extracted modules ---
import { getContextBudget } from './orchestrator-context';

// --- Barrel re-exports (preserve existing consumer import paths) ---
export {
  getContextBudget,
  estimateContextTokens,
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
  /** Byte/token breakdown of the always-on prompt blocks under cost
   *  scrutiny (GitHub protocol + project instructions). Carried alongside
   *  the snapshot so `chat-stream-round` — which owns `round`/`chatId` —
   *  can emit the `prompt_composition_cost` ops log via the same
   *  consume-on-peek path that guards the prompt_snapshot event from
   *  stale-round misattribution. */
  cost: PromptCompositionCost;
  consumed: boolean;
}

const _lastPromptSnapshots = new Map<string, PromptSnapshotEntry>();

function recordPromptSnapshot(
  key: string,
  snapshot: PromptSnapshot,
  totalChars: number,
  cost: PromptCompositionCost,
): void {
  if (_lastPromptSnapshots.has(key)) {
    _lastPromptSnapshots.delete(key);
  } else if (_lastPromptSnapshots.size >= MAX_PROMPT_SNAPSHOT_ENTRIES) {
    const oldestKey = _lastPromptSnapshots.keys().next().value;
    if (oldestKey !== undefined) _lastPromptSnapshots.delete(oldestKey);
  }
  _lastPromptSnapshots.set(key, { snapshot, totalChars, cost, consumed: false });
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
): { snapshot: PromptSnapshot; totalChars: number; cost: PromptCompositionCost } | null {
  const key = getPromptSnapshotKey(messages, workspaceContext);
  const entry = _lastPromptSnapshots.get(key);
  if (!entry || entry.consumed) return null;
  entry.consumed = true;
  return { snapshot: entry.snapshot, totalChars: entry.totalChars, cost: entry.cost };
}

// Multimodal content types (OpenAI-compatible)
interface LLMMessageContentText {
  type: 'text';
  text: string;
  cache_control?: CacheControl;
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
  contentBlocks?: LlmContentBlock[];
  intentHint?: string | null;
  reasoning_blocks?: LLMReasoningBlock[];
  reasoning_content?: string;
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

function tagLastContentBlock(blocks: LlmContentBlock[]): boolean {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (block.type === 'thinking' || block.type === 'redacted_thinking') continue;
    block.cache_control = EPHEMERAL_CACHE_CONTROL;
    return true;
  }
  return false;
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

/** Optional inputs for {@link toLLMMessages}. Bagged into one object so adding
 *  a per-turn input is a named field rather than another trailing positional
 *  (the signature had grown to a dozen). All fields are optional; the gateways
 *  forward the matching `PushStreamRequest` fields verbatim. */
export interface ToLLMMessagesOptions {
  workspaceContext?: WorkspaceContext;
  hasSandbox?: boolean;
  systemPromptOverride?: string;
  scratchpadContent?: string;
  providerType?: Exclude<ActiveProvider, 'demo'>;
  providerModel?: string;
  onPreCompact?: (event: import('@/types').PreCompactEvent) => void;
  intentHint?: string | null;
  todoContent?: string;
  sessionDigestOptions?: SessionDigestOptions;
  linkedLibraryContent?: string;
  /** True only for neutral request shapes whose worker-side serializers consume
   *  `LlmMessage.contentBlocks`. Strict OpenAI-shaped transports must leave it
   *  off or upstreams may reject the unknown message field. */
  emitContentBlocks?: boolean;
}

export function toLLMMessages(
  messages: ChatMessage[],
  options: ToLLMMessagesOptions = {},
): LLMMessage[] {
  const {
    workspaceContext,
    hasSandbox,
    systemPromptOverride,
    scratchpadContent,
    providerType,
    providerModel,
    onPreCompact,
    intentHint,
    todoContent,
    sessionDigestOptions,
    linkedLibraryContent,
    emitContentBlocks = false,
  } = options;
  // When a systemPromptOverride is provided (Auditor, Coder), the caller has already
  // composed a complete system prompt — don't append Orchestrator-specific protocols.
  let systemContent: string;
  // Stable/volatile split for the cache breakpoint, populated only on the
  // sectioned-builder path. Null for systemPromptOverride callers (Auditor/
  // Coder compose a complete prompt), which fall back to a single cached block.
  let systemSegments: { stable: string; volatile: string } | null = null;
  const promptSnapshotKey = getPromptSnapshotKey(messages, workspaceContext);

  if (systemPromptOverride) {
    systemContent = systemPromptOverride;
    _lastPromptSnapshots.delete(promptSnapshotKey);
  } else {
    // Build the full orchestrator prompt using the sectioned builder.
    // Start from the shared base and layer in runtime-dependent blocks.
    //
    // LOAD-BEARING (not test-only): this runs on every turn that stays on the
    // foreground Orchestrator role/loop — no-repo workspaces (chat / scratch /
    // local-pc), the `delegated` opt-out, and the conversational-inline escape
    // hatch while Phase 3 bakes. See the routing in delegation-mode-settings.ts
    // (`resolveTurnEngineTrigger` → `null`). The inline Coder/Explorer lanes
    // pass their own `systemPromptOverride` and skip this path; don't mistake
    // that for the Orchestrator builder being dead.
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

    // The user's web-search mode pref gates whether `web_search` is in
    // the model's vocabulary at all. Hoisted above the environment block
    // so we can also strip the matching tool hint from the chat-mode
    // description (set once at session setup by `useProjectInstructions`
    // and otherwise stale when the user later flips the menu to off).
    const webSearchEnabled = getWebSearchMode() !== 'off';
    // When the active provider's native server-side search is enabled,
    // skip the prompt-engineered `web_search` tool protocol. Anthropic's
    // native tool is also literally named `web_search`, so leaving both
    // active would create a name collision and a duplicate tool surface
    // for the model; OpenRouter's `openrouter:web_search` and the
    // Responses providers' (OpenAI/Sakana/Fireworks) `web_search` server
    // tool would likewise run a parallel search behind the model's back.
    // Providers without a native tool (Ollama, legacy ones) still get the
    // prompt-engineered protocol as their only path.
    const nativeWebSearchActive =
      webSearchEnabled && isNativeWebSearchEnabled(providerType ?? '', providerModel);
    const promptEngineeredWebSearchEnabled = webSearchEnabled && !nativeWebSearchActive;

    // Workspace description + GitHub tool protocol
    if (workspaceContext) {
      let envContent = workspaceContext.description;
      if (workspaceContext.mode === 'chat' && !webSearchEnabled) {
        envContent =
          'You are in chat mode — a plain conversation with no repository context and no sandbox.' +
          ' Web search is turned off; no tools are available for this conversation.' +
          ' Focus on being a helpful conversational partner: answer questions, brainstorm ideas, explain concepts, and think through problems together.';
      }
      const capabilityBlock = buildSessionCapabilityBlock(workspaceContext, hasSandbox);
      if (capabilityBlock) {
        envContent += '\n\n' + capabilityBlock;
      }
      builder.set('environment', envContent);

      // GitHub tool protocol is a large, session-stable block — its presence
      // depends only on whether GitHub tools are configured, not on per-turn
      // state. Set it in the stable `github_tool_instructions` section instead
      // of concatenating it into the volatile `environment` block (every other
      // tool protocol already rides the stable `tool_instructions` section).
      // Folding it into `environment` dragged it into the uncached volatile
      // tail, so workspace/git-status churn forced this constant to be re-read
      // every turn; in its own stable section it joins the cached prefix.
      if (workspaceContext.includeGitHubTools) {
        builder.set('github_tool_instructions', TOOL_PROTOCOL);
      }

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
    //
    // `webSearchEnabled` (hoisted above) drops the protocol from the
    // prompt so the model can't call a tool it doesn't know about.
    if (workspaceContext?.mode === 'chat') {
      builder.set(
        'tool_instructions',
        promptEngineeredWebSearchEnabled ? WEB_SEARCH_TOOL_PROTOCOL : '',
      );
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
      if (promptEngineeredWebSearchEnabled) toolProtocols.push(WEB_SEARCH_TOOL_PROTOCOL);
      // Memory recall is repo-scoped, so it only rides the non-chat branch.
      toolProtocols.push(MEMORY_TOOL_PROTOCOL);
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

    // Linked-library content (v2b) — user-managed bundles linked to
    // this chat, pre-rendered by the caller. Applies in every
    // *non-override* mode (chat, repo, scratch, local-pc); delegated
    // roles that pass a `systemPromptOverride` (Auditor / Coder)
    // intentionally skip the orchestrator builder entirely, so linked
    // libraries don't reach those backgrounded prompts — they're
    // user-explicit context for the chat surface, not for
    // delegated workers. Placed before the turn-volatile `memory`
    // section so Anthropic prompt caching (`cache_control` on the
    // whole system message) can amortize the canon across turns.
    if (linkedLibraryContent && linkedLibraryContent.length > 0) {
      builder.set('library_context', linkedLibraryContent);
    }

    // Intent hint (last so it overrides)
    builder.set('last_instructions', intentHint);

    systemSegments = builder.buildSegments();
    systemContent = builder.build();

    // Always capture the snapshot (dev + prod). The accessor
    // `peekLastPromptSnapshot` reads this entry to emit per-turn
    // `assistant.prompt_snapshot` run events for debug surfaces.
    // Read the previous entry *before* recordPromptSnapshot overwrites
    // it so the DEV diff log still shows previous-vs-current sections.
    const currentSnap = builder.snapshot();
    const previousEntry = _lastPromptSnapshots.get(promptSnapshotKey);

    // Isolate the cost of the two always-injected blocks the schema-deferral
    // decision (Claude Code In-App Patterns §5) is weighing. The GitHub
    // protocol is a constant block gated on `includeGitHubTools`; the project-
    // instructions block is folded into the environment section upstream and
    // recovered here by its markers. Both bytes are exact; tokens are the
    // provider-agnostic estimate (same heuristic the budget uses).
    const githubProtocolText = workspaceContext?.includeGitHubTools ? TOOL_PROTOCOL : '';
    const projectInstructionsText =
      extractMarkedBlock(
        workspaceContext?.description ?? '',
        PROJECT_INSTRUCTIONS_OPEN_PREFIX,
        PROJECT_INSTRUCTIONS_CLOSE,
      ) ?? '';
    const cost: PromptCompositionCost = {
      systemPromptBytes: systemContent.length,
      githubProtocolBytes: githubProtocolText.length,
      projectInstructionsBytes: projectInstructionsText.length,
      systemPromptTokens: estimateRawTokens(systemContent),
      githubProtocolTokens: githubProtocolText ? estimateRawTokens(githubProtocolText) : 0,
      projectInstructionsTokens: projectInstructionsText
        ? estimateRawTokens(projectInstructionsText)
        : 0,
    };
    recordPromptSnapshot(promptSnapshotKey, currentSnap, systemContent.length, cost);

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
  // for providers that support it. OpenRouter passes the field through to its
  // upstream Anthropic models verbatim; direct Anthropic consumes it natively
  // via the anthropic-bridge. Other providers harmlessly ignore it.
  //
  // Place the breakpoint at the stable/volatile boundary, not around the whole
  // prompt: the stable block (identity/tools/delegation/guidelines) becomes a
  // cached prefix that survives a turn where only a volatile section changed
  // (e.g. environment git status). The volatile tail follows as a second,
  // uncached text block. The leading separator rides the volatile block so the
  // cached stable bytes stay clean, and the two blocks concatenate to exactly
  // `systemContent`. Single breakpoint here keeps within Anthropic's 4-marker
  // budget alongside the trailing-message tags below.
  const cacheable = providerType === 'openrouter' || providerType === 'anthropic';
  let systemMessage: LLMMessage;
  if (cacheable && systemSegments && systemSegments.stable && systemSegments.volatile) {
    systemMessage = {
      role: 'system',
      content: [
        { type: 'text', text: systemSegments.stable, cache_control: EPHEMERAL_CACHE_CONTROL },
        { type: 'text', text: `\n\n${systemSegments.volatile}` },
      ] as LLMMessageContent[],
    };
  } else if (cacheable) {
    // Override prompt, or an all-stable / all-volatile build with no boundary —
    // one cached block over the whole system content.
    systemMessage = {
      role: 'system',
      content: [
        { type: 'text', text: systemContent, cache_control: EPHEMERAL_CACHE_CONTROL },
      ] as LLMMessageContent[],
    };
  } else {
    systemMessage = { role: 'system', content: systemContent };
  }
  const llmMessages: LLMMessage[] = [systemMessage];

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
  const materializedMessages: Array<ChatMessage & { contentBlocks?: LlmContentBlock[] }> =
    emitContentBlocks ? materializeToolContentBlocks(windowedMessages) : windowedMessages;

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
  const emitReasoningContent = routeReplaysReasoningContent(providerType, providerModel);

  for (const msg of materializedMessages) {
    // Anthropic requires signed thinking blocks to be re-sent verbatim on
    // the assistant turn that produced them, ahead of any text/tool_use.
    // The wire field rides as a sidecar on the assistant LLMMessage; the
    // bridge layer (worker → anthropic-bridge.ts) prepends them to
    // the upstream `content[]`.
    const reasoningBlocks =
      emitReasoningBlocks &&
      msg.role === 'assistant' &&
      msg.reasoningBlocks &&
      msg.reasoningBlocks.length > 0
        ? msg.reasoningBlocks
        : undefined;
    // Reasoning replay (DeepSeek `reasoning_content`). The orchestrator lane carries
    // the round's plain reasoning on ChatMessage `.thinking`; the inline/CLI kernel
    // lane hands its own `LlmMessage`s to the provider stream through the documented
    // `PushStream<LlmMessage>` cast seam (chat-send-inline.ts), and those carry it on
    // `reasoningContent`. Read either — a kernel tool-call turn that replays bare 400s
    // DeepSeek thinking mode ("the `reasoning_content` ... must be passed back").
    const kernelReasoning = (msg as { reasoningContent?: unknown }).reasoningContent;
    const reasoningReplay =
      typeof msg.thinking === 'string' && msg.thinking.length > 0
        ? msg.thinking
        : typeof kernelReasoning === 'string' && kernelReasoning.length > 0
          ? kernelReasoning
          : '';
    const reasoningContent =
      emitReasoningContent && msg.role === 'assistant' && reasoningReplay.length > 0
        ? reasoningReplay
        : undefined;

    // Prefer pre-converted `contentParts` (the Coder kernel's surface-agnostic
    // multimodal turn — it has no `AttachmentData`); fall back to rebuilding
    // Anthropic-canonical `contentBlocks` from `attachments` for
    // Orchestrator-loop messages. Without honoring `contentParts` here,
    // kernel-lane image turns serialize text-only and the attachment is
    // silently dropped (Codex P1, #937).
    const contentParts =
      msg.contentParts && msg.contentParts.length > 0 ? msg.contentParts : undefined;
    const existingContentBlocks =
      msg.contentBlocks && msg.contentBlocks.length > 0 ? msg.contentBlocks : undefined;
    const attachmentContentBlocks =
      contentParts || existingContentBlocks
        ? undefined
        : buildAttachmentContentBlocks(msg.content, msg.attachments);
    const contentBlocks = existingContentBlocks ?? attachmentContentBlocks;
    if (contentBlocks && contentBlocks.length > 0) {
      llmMessages.push({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: contentParts ?? msg.content,
        contentBlocks,
        ...(reasoningBlocks ? { reasoning_blocks: reasoningBlocks } : {}),
        ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
      });
    } else if (contentParts) {
      llmMessages.push({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: contentParts,
        ...(reasoningBlocks ? { reasoning_blocks: reasoningBlocks } : {}),
        ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
      });
    } else {
      // Simple text message (existing behavior)
      // Guard against provider-side validation errors:
      // some OpenAI-compatible backends reject empty assistant turns.
      // Exception: an assistant turn with no text but with signed
      // reasoning blocks is legitimate (Anthropic returns this when the
      // model thinks then immediately tool_uses) — keep it so the next
      // turn's request can echo the signature back.
      if (
        msg.role === 'assistant' &&
        !msg.content.trim() &&
        !reasoningBlocks &&
        !reasoningContent
      ) {
        continue;
      }
      llmMessages.push({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: msg.content,
        ...(reasoningBlocks ? { reasoning_blocks: reasoningBlocks } : {}),
        ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
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
  // above drops empty-content assistant turns mid-iteration (unless they carry
  // replayable reasoning), so the wire `llmMessages` array is NOT 1:1 with
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
      if (msg.contentBlocks && msg.contentBlocks.length > 0) {
        if (tagLastContentBlock(msg.contentBlocks)) tagged++;
      } else if (typeof msg.content === 'string') {
        msg.content = [{ type: 'text', text: msg.content, cache_control: EPHEMERAL_CACHE_CONTROL }];
        tagged++;
      } else if (Array.isArray(msg.content)) {
        // Already an array (e.g. from attachments) — tag the last text part.
        const lastPart = msg.content[msg.content.length - 1];
        if (lastPart.type === 'text') {
          lastPart.cache_control = EPHEMERAL_CACHE_CONTROL;
          tagged++;
        }
      }
    }
  }

  // Final sanitize pass: never send empty assistant messages — except
  // assistant turns that carry replayable reasoning sidecars (signed blocks
  // become Anthropic `content[]`; DeepSeek plain text becomes OpenAI
  // `reasoning_content`, so the message is not actually empty on the wire).
  return llmMessages.filter((msg) => {
    if (msg.role !== 'assistant') return true;
    if (msg.contentBlocks && msg.contentBlocks.length > 0) return true;
    if (msg.reasoning_blocks && msg.reasoning_blocks.length > 0) return true;
    if (msg.reasoning_content && msg.reasoning_content.length > 0) return true;
    return isNonEmptyContent(msg.content);
  });
}
