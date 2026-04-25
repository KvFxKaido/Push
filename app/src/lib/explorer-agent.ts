/**
 * App compatibility wrapper for the shared Explorer agent.
 *
 * The canonical module now lives in `lib/explorer-agent.ts`. This wrapper
 * preserves the Web-side public API so existing call sites — delegation
 * from the Orchestrator, `deep-reviewer-agent.ts` (which re-uses
 * `createExplorerToolHooks`), and `explorer-agent.test.ts` — keep working
 * unchanged. It injects the DI points the lib kernel needs at the call
 * boundary:
 *
 * 1. `userProfile`           — `getUserProfile()` from `@/hooks/useUserProfile`
 * 2. `taskPreamble`          — `buildExplorerDelegationBrief(envelope)` from `./role-context`
 * 3. `symbolSummary`         — `symbolLedger.getSummary()` from `./symbol-persistence-ledger`
 * 4. `toolExec`              — curried `executeReadOnlyTool` over per-run bindings
 * 5. `detectAllToolCalls`    — real function from `./tool-dispatch`
 * 6. `detectAnyToolCall`     — real function from `./tool-dispatch`
 * 7. `webSearchToolProtocol` — `WEB_SEARCH_TOOL_PROTOCOL` from `./web-search-tools`
 * 8. `evaluateAfterModel`    — flattened adapter around `policyRegistry.evaluateAfterModel`
 *
 * The `'demo'` provider guard stays here — the lib kernel assumes a real
 * provider and rejecting demo is a Web-layer concern.
 *
 * `createExplorerToolHooks` / `buildExplorerHooks` / `EXPLORER_ALLOWED_TOOLS`
 * / zero-arg `buildExplorerBaseBuilder` / zero-arg `buildExplorerSystemPrompt`
 * are kept exported from this shim so `deep-reviewer-agent.ts`,
 * `explorer-agent.test.ts`, and other callers can keep importing them
 * from `./explorer-agent` unchanged. Phase 5D step 1 explicitly does not
 * retire `createExplorerToolHooks` — the Explorer run loop no longer uses
 * it (hooks come from `policyRegistry.toToolHookRegistry(turnCtx)`), but
 * the export survives for deep-reviewer and the test suite.
 */

import {
  runExplorerAgent as runExplorerAgentLib,
  buildExplorerBaseBuilder as buildExplorerBaseBuilderLib,
  buildExplorerSystemPrompt as buildExplorerSystemPromptLib,
  type ExplorerAgentOptions as LibExplorerAgentOptions,
  type ExplorerAfterModelResult,
} from '@push/lib/explorer-agent';
import {
  providerStreamFnToPushStream,
  type LlmMessage,
  type ProviderStreamFn,
  type PushStream,
} from '@push/lib/provider-contract';
import type {
  ChatCard,
  ChatMessage,
  ExplorerCallbacks,
  ExplorerDelegationEnvelope,
  ExplorerResult,
} from '@/types';
import { getUserProfile } from '@/hooks/useUserProfile';
import { detectAllToolCalls, detectAnyToolCall, type AnyToolCall } from './tool-dispatch';
import { EXPLORER_ALLOWED_TOOLS } from './explorer-constants';
import { createToolHookRegistry, type ToolHookRegistry } from './tool-hooks';
import { getModelForRole } from './providers';
import { resolveProviderSpecificModel } from './provider-selection';
import {
  getActiveProvider,
  isProviderAvailable,
  getProviderStreamFn,
  type ActiveProvider,
} from './orchestrator';
import { WEB_SEARCH_TOOL_PROTOCOL } from './web-search-tools';
import { executeReadOnlyTool } from './agent-loop-utils';
import { buildExplorerDelegationBrief } from './role-context';
import type { SystemPromptBuilder } from './system-prompt-builder';
import { symbolLedger } from './symbol-persistence-ledger';
import { TurnPolicyRegistry, type TurnContext } from './turn-policy';
import { createExplorerPolicy } from './turn-policies/explorer-policy';
import { CapabilityLedger, ROLE_CAPABILITIES } from './capabilities';

// ---------------------------------------------------------------------------
// Constants — `EXPLORER_ALLOWED_TOOLS` is imported from `explorer-constants.ts`
// and re-exported here to preserve the pre-move public API. Prior to this
// consolidation the set was defined twice with different derivations:
// `explorer-agent.ts` built it from `PARALLEL_READ_ONLY_{GITHUB,SANDBOX}_TOOLS`
// in `tool-dispatch`, while `explorer-constants.ts` built it from
// `getToolCanonicalNames({ readOnly: true })` in `tool-registry`. Both resolved
// to the same set today because `PARALLEL_READ_ONLY_*_TOOLS` themselves wrap
// `getToolCanonicalNames(...)`, so the duplication was tautological — and a
// silent drift hazard if either derivation's inputs changed independently.
// `explorer-constants` is the canonical source because it sits on the
// zero-dependency leaf module (`tool-registry`) and is what the turn-policy
// imports already use.
// ---------------------------------------------------------------------------

export { EXPLORER_ALLOWED_TOOLS };

// ---------------------------------------------------------------------------
// Prompt builder re-exports — zero-arg wrappers that curry
// `WEB_SEARCH_TOOL_PROTOCOL` into the lib builders so existing callers
// (`explorer-agent.test.ts`) keep working unchanged.
// ---------------------------------------------------------------------------

export function buildExplorerBaseBuilder(): SystemPromptBuilder {
  return buildExplorerBaseBuilderLib(WEB_SEARCH_TOOL_PROTOCOL);
}

export function buildExplorerSystemPrompt(): string {
  return buildExplorerSystemPromptLib(WEB_SEARCH_TOOL_PROTOCOL);
}

// ---------------------------------------------------------------------------
// Tool hooks — the legacy Explorer pre-hook registry. Kept for deep-reviewer
// and the test suite; the Explorer run loop itself now builds hooks from the
// turn-policy registry.
// ---------------------------------------------------------------------------

function buildExplorerHooks(): ToolHookRegistry {
  const hooks = createToolHookRegistry();
  hooks.pre.push({
    matcher: /.*/,
    hook: (toolName) => {
      if (EXPLORER_ALLOWED_TOOLS.has(toolName)) {
        return { decision: 'passthrough' };
      }
      return {
        decision: 'deny',
        reason: `Explorer is read-only. "${toolName}" is not allowed. Use only inspection/search tools such as ${Array.from(EXPLORER_ALLOWED_TOOLS).sort().join(', ')}.`,
      };
    },
  });
  return hooks;
}

export function createExplorerToolHooks(): ToolHookRegistry {
  return buildExplorerHooks();
}

// Bridged-PushStream cache, keyed by underlying `ProviderStreamFn` identity.
// Mirrors the Auditor / Reviewer wrapper pattern so concurrent Explorer runs
// against the same provider see the same `PushStream` object.
const pushStreamCache = new WeakMap<ProviderStreamFn, PushStream<LlmMessage>>();
function bridgeStreamFn(streamFn: ProviderStreamFn): PushStream<LlmMessage> {
  let push = pushStreamCache.get(streamFn);
  if (!push) {
    push = providerStreamFnToPushStream(streamFn as ProviderStreamFn<LlmMessage>);
    pushStreamCache.set(streamFn, push);
  }
  return push;
}

// ---------------------------------------------------------------------------
// Main entry point — preserves the original Web-facing signature.
// ---------------------------------------------------------------------------

export async function runExplorerAgent(
  envelope: ExplorerDelegationEnvelope,
  sandboxId: string | null,
  allowedRepo: string,
  callbacks: ExplorerCallbacks,
): Promise<ExplorerResult> {
  const requestedProvider =
    envelope.provider !== 'demo' && isProviderAvailable(envelope.provider as ActiveProvider)
      ? (envelope.provider as ActiveProvider)
      : null;
  const activeProvider = requestedProvider || getActiveProvider();

  if (activeProvider === 'demo') {
    throw new Error('No AI provider configured. Add an API key in Settings.');
  }

  const { streamFn } = getProviderStreamFn(activeProvider);
  const roleModel = getModelForRole(activeProvider, 'explorer');
  const explorerModelId =
    resolveProviderSpecificModel(activeProvider, envelope.model, envelope.provider) ||
    roleModel?.id;

  // --- Capability ledger ---
  const capabilityLedger = new CapabilityLedger(ROLE_CAPABILITIES.explorer);

  // Explorer-only registry — avoids pulling Coder/Orchestrator policies.
  const policyRegistry = new TurnPolicyRegistry();
  policyRegistry.register(createExplorerPolicy());
  const turnCtx: TurnContext = {
    role: 'explorer',
    round: 0,
    maxRounds: 14, // MAX_EXPLORER_ROUNDS from lib — kept inline to avoid re-export
    sandboxId,
    allowedRepo,
    activeProvider,
    activeModel: explorerModelId,
    signal: callbacks.signal,
  };
  const hooks = policyRegistry.toToolHookRegistry(turnCtx);

  const libOptions: LibExplorerAgentOptions<AnyToolCall, ChatCard> = {
    provider: activeProvider,
    stream: bridgeStreamFn(streamFn as unknown as ProviderStreamFn),
    modelId: explorerModelId,
    sandboxId,
    allowedRepo,
    branchContext: envelope.branchContext,
    projectInstructions: envelope.projectInstructions,
    instructionFilename: envelope.instructionFilename,
    userProfile: getUserProfile(),
    taskPreamble: buildExplorerDelegationBrief(envelope),
    symbolSummary: symbolLedger.getSummary(),
    toolExec: async (call) => {
      // Opt in to the runtime-level capability check in
      // WebToolExecutionRuntime. With role='explorer', a mutating
      // tool gets refused at the runtime seam even if the Explorer
      // turn policy hook was never registered and the read-only
      // registry was built incorrectly for this call site.
      const entry = await executeReadOnlyTool(
        call,
        allowedRepo,
        sandboxId,
        activeProvider,
        explorerModelId,
        hooks,
        { capabilityLedger, role: 'explorer' },
      );
      capabilityLedger.recordToolUse(call.call.tool);
      return entry;
    },
    detectAllToolCalls,
    detectAnyToolCall,
    webSearchToolProtocol: WEB_SEARCH_TOOL_PROTOCOL,
    evaluateAfterModel: async (response, round): Promise<ExplorerAfterModelResult> => {
      turnCtx.round = round;
      // The Explorer turn policy's `noEmptyReport` afterModelCall hook
      // ignores the `messages` argument (see
      // app/src/lib/turn-policies/explorer-policy.ts), so passing an empty
      // array keeps the lib kernel free of ChatMessage coupling. If a
      // future Explorer policy adds a messages-dependent afterModelCall
      // hook, switch to passing the real buffer via a structural cast.
      const emptyMessages: ChatMessage[] = [];
      const result = await policyRegistry.evaluateAfterModel(response, emptyMessages, turnCtx);
      if (!result) return null;
      if (result.action === 'halt') {
        return { action: 'halt', summary: result.summary };
      }
      return { action: 'inject', content: result.message.content };
    },
  };

  const result = await runExplorerAgentLib(libOptions, {
    onStatus: callbacks.onStatus,
    signal: callbacks.signal,
  });

  return {
    summary: result.summary,
    cards: result.cards,
    rounds: result.rounds,
    capabilitySnapshot: capabilityLedger.snapshot(),
  };
}
