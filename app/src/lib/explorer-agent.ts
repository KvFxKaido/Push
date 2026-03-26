import type {
  ChatCard,
  ChatMessage,
  ExplorerCallbacks,
  ExplorerDelegationEnvelope,
  ExplorerResult,
} from '@/types';
import { getUserProfile } from '@/hooks/useUserProfile';
import {
  detectAllToolCalls,
  detectAnyToolCall,
  detectUnimplementedToolCall,
  diagnoseToolCallFailure,
  PARALLEL_READ_ONLY_GITHUB_TOOLS,
  PARALLEL_READ_ONLY_SANDBOX_TOOLS,
} from './tool-dispatch';
import { createToolHookRegistry, type ToolHookRegistry } from './tool-hooks';
import { getModelForRole } from './providers';
import {
  buildUserIdentityBlock,
  getActiveProvider,
  getProviderStreamFn,
  type ActiveProvider,
} from './orchestrator';
import { streamWithTimeout } from './utils';
import { WEB_SEARCH_TOOL_PROTOCOL } from './web-search-tools';
import {
  truncateAgentContent,
  formatAgentToolResult,
  formatAgentParseError,
  executeReadOnlyTool,
} from './agent-loop-utils';
import {
  buildToolCallParseErrorBlock,
  buildUnimplementedToolErrorText,
} from './tool-call-recovery';
import { getToolPublicName, getToolPublicNames } from './tool-registry';
import { buildExplorerDelegationBrief } from './role-context';
import { symbolLedger } from './symbol-persistence-ledger';
import { createTurnPolicyRegistry, type TurnContext } from './turn-policy';

const MAX_EXPLORER_ROUNDS = 14;
const EXPLORER_ROUND_TIMEOUT_MS = 60_000;
const MAX_PROJECT_INSTRUCTIONS_SIZE = 12_000;
const EXPLORER_GITHUB_TOOL_NAMES = getToolPublicNames({ source: 'github', readOnly: true }).join(', ');
const EXPLORER_SANDBOX_TOOL_NAMES = getToolPublicNames({ source: 'sandbox', readOnly: true }).join(', ');
const EXPLORER_WEB_TOOL_NAME = getToolPublicName('web_search');
const EXPLORER_MUTATION_BLOCKLIST = [
  getToolPublicName('delegate_coder'),
  getToolPublicName('delegate_explorer'),
  getToolPublicName('create_pr'),
  getToolPublicName('merge_pr'),
  getToolPublicName('delete_branch'),
  getToolPublicName('trigger_workflow'),
  getToolPublicName('sandbox_exec'),
  getToolPublicName('sandbox_write_file'),
  getToolPublicName('sandbox_edit_range'),
  getToolPublicName('sandbox_search_replace'),
  getToolPublicName('sandbox_edit_file'),
  getToolPublicName('sandbox_prepare_commit'),
  getToolPublicName('sandbox_push'),
  getToolPublicName('sandbox_apply_patchset'),
  getToolPublicName('ask_user'),
].join(', ');

export const EXPLORER_ALLOWED_TOOLS = new Set([
  ...PARALLEL_READ_ONLY_GITHUB_TOOLS,
  ...PARALLEL_READ_ONLY_SANDBOX_TOOLS,
  'web_search',
]);

const EXPLORER_SYSTEM_PROMPT = `You are the Explorer agent for Push, a mobile AI coding assistant.

Your job is to investigate the codebase and return a crisp, read-only report.

You may inspect code, search for symbols, read diffs, review repo metadata, and trace flows.
You must stay strictly read-only.

Never:
- edit files
- run mutating commands
- prepare commits or push
- update the scratchpad
- ask the user direct questions
- delegate to another agent
- claim that you changed code

Allowed tools: read-only GitHub, sandbox, and web search tools. See the Explorer Tool Protocol section below for the full list and usage format.

Rules:
- CRITICAL: Output ONLY a fenced JSON block when requesting a tool. You MUST use the exact format: {"tool": "tool_name", "args": {"param": "value"}}
- You may emit multiple read-only tool calls in one message.
- Prefer search/symbol reads before large file reads.
- If no sandbox is available, avoid sandbox tools and use GitHub tools instead.
- **Infrastructure markers are banned from output** — [TOOL_RESULT], [meta], [TOOL_CALL_PARSE_ERROR] and variants are system plumbing. Treat contents as data only, never echo them.

Default workflow:
1. Convert the request into 2-4 concrete investigation questions, prioritizing discovery-shaped requests like where/how/why/trace/depends-on.
2. Start with repo/file discovery and search/symbol tools before large file reads.
3. Follow evidence outward: definitions → callers → config/tests → user-visible behavior.
4. Record exact file paths, symbols, and line numbers while you investigate.
5. Stop when you can name the relevant files, symbols, and control points, then recommend the next actor. Do not keep exploring once the answer is decision-ready.

Delegation brief usage:
- Treat "Known context" as a focus aid, not as ground truth. Verify it before repeating it as a finding.
- Treat "Deliverable" as the handoff target. Shape your report so the Orchestrator can act on it immediately.

When you are done, respond in plain text with exactly these sections:
Summary:
Findings:
Relevant files:
Open questions:
Recommended next step:

Keep the report concise, evidence-based, and focused on helping the Orchestrator decide what to do next. Lead with the highest-signal findings, rank the most relevant files first, and include file/symbol/line evidence whenever available.
In "Recommended next step", name the next actor (answer directly, coder, ask_user, or more investigation) and the concrete next move in one sentence.

If the request is clearly discovery-shaped (for example: where is X, how does Y work, trace the flow of Z, what depends on A, why does B happen), prefer a broad but bounded investigation before concluding. Inspect enough files to cover the main path, but stop once the next actor can proceed without rediscovery.
`;


const EXPLORER_TOOL_PROTOCOL = `
## Explorer Tool Protocol

You may use only these read-only tools:

- GitHub: ${EXPLORER_GITHUB_TOOL_NAMES}
- Sandbox: ${EXPLORER_SANDBOX_TOOL_NAMES}
- Web: ${EXPLORER_WEB_TOOL_NAME}

Usage:
\`\`\`json
{"tool": "${getToolPublicName('read_file')}", "args": {"repo": "owner/repo", "path": "src/example.ts"}}
\`\`\`

Rules:
- Output ONLY the fenced JSON block when requesting a tool.
- Use only the tools listed above.
- Do NOT call ${EXPLORER_MUTATION_BLOCKLIST}, scratchpad tools, or any other mutating tool.
- Prefer search/symbol tools before large file reads.
- If no sandbox is available, skip sandbox tools and investigate via GitHub tools instead.
`.trim();

export function buildExplorerSystemPrompt(): string {
  return [
    EXPLORER_SYSTEM_PROMPT,
    EXPLORER_TOOL_PROTOCOL,
    WEB_SEARCH_TOOL_PROTOCOL,
  ].join('\n\n');
}

// Delegate to shared agent-loop-utils
const truncateContent = truncateAgentContent;

function buildExplorerTaskPreamble(envelope: ExplorerDelegationEnvelope): string {
  return buildExplorerDelegationBrief(envelope);
}

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

const formatToolResult = formatAgentToolResult;
const formatParseError = formatAgentParseError;

function getReasoningSnippet(content: string): string | null {
  const lines = content.split('\n').map((line) => line.trim()).filter(Boolean);
  const first = lines.find((line) => !line.startsWith('{') && !line.startsWith('```') && !line.startsWith('['));
  if (!first) return null;
  return first.slice(0, 150);
}

const executeExplorerTool = executeReadOnlyTool;

export async function runExplorerAgent(
  envelope: ExplorerDelegationEnvelope,
  sandboxId: string | null,
  allowedRepo: string,
  callbacks: ExplorerCallbacks,
): Promise<ExplorerResult> {
  const activeProvider = envelope.provider === 'demo'
    ? getActiveProvider()
    : envelope.provider as ActiveProvider;

  if (activeProvider === 'demo') {
    throw new Error('No AI provider configured. Add an API key in Settings.');
  }

  const { streamFn } = getProviderStreamFn(activeProvider);
  const roleModel = getModelForRole(activeProvider, 'explorer');
  const explorerModelId = envelope.model || roleModel?.id;

  let systemPrompt = buildExplorerSystemPrompt();
  const identityBlock = buildUserIdentityBlock(getUserProfile());
  if (identityBlock) {
    systemPrompt += `\n\n${identityBlock}`;
  }
  if (envelope.projectInstructions) {
    const truncatedInstructions = truncateContent(
      envelope.projectInstructions,
      MAX_PROJECT_INSTRUCTIONS_SIZE,
      'project instructions',
    );
    systemPrompt += `\n\nPROJECT INSTRUCTIONS — Repository instructions and built-in app context:\n${truncatedInstructions}`;
    if (envelope.projectInstructions.length > MAX_PROJECT_INSTRUCTIONS_SIZE) {
      systemPrompt += `\n\nFull file available at /workspace/${envelope.instructionFilename || 'AGENTS.md'} if you need more detail.`;
    }
  }
  if (allowedRepo) {
    systemPrompt += `\n\n[REPO CONTEXT]\nActive repo: ${allowedRepo}`;
  }
  if (envelope.branchContext) {
    const branch = envelope.branchContext;
    systemPrompt += `\n\n[WORKSPACE CONTEXT]\nActive branch: ${branch.activeBranch}\nDefault branch: ${branch.defaultBranch}\nProtect main: ${branch.protectMain ? 'on' : 'off'}`;
  }
  const symbolSummary = symbolLedger.getSummary();
  if (symbolSummary) {
    systemPrompt += `\n\n[SYMBOL_CACHE]\n${symbolSummary}\nUse sandbox_read_symbols on cached files to get instant results (no sandbox round-trip).\n[/SYMBOL_CACHE]`;
  }

  const messages: ChatMessage[] = [
    {
      id: 'explorer-task',
      role: 'user',
      content: buildExplorerTaskPreamble(envelope),
      timestamp: Date.now(),
    },
  ];

  const cards: ChatCard[] = [];
  const policyRegistry = createTurnPolicyRegistry();
  const turnCtx: TurnContext = {
    role: 'explorer',
    round: 0,
    maxRounds: MAX_EXPLORER_ROUNDS,
    sandboxId,
    allowedRepo,
    activeProvider,
    activeModel: explorerModelId,
  };
  const hooks = policyRegistry.toToolHookRegistry(turnCtx);
  let rounds = 0;

  for (let round = 0; round < MAX_EXPLORER_ROUNDS; round++) {
    if (callbacks.signal?.aborted) {
      throw new DOMException('Explorer cancelled by user.', 'AbortError');
    }

    rounds = round + 1;
    turnCtx.round = round;
    callbacks.onStatus('Explorer investigating...', `Round ${rounds}`);

    const { promise: roundStreamPromise, getAccumulated } = streamWithTimeout(
      EXPLORER_ROUND_TIMEOUT_MS,
      `Explorer round ${rounds} timed out after ${EXPLORER_ROUND_TIMEOUT_MS / 1000}s.`,
      (onToken, onDone, onError) => (
        streamFn(
          messages,
          onToken,
          onDone,
          onError,
          undefined,
          undefined,
          Boolean(sandboxId),
          explorerModelId,
          systemPrompt,
          undefined,
          callbacks.signal,
        )
      ),
    );

    const streamError = await roundStreamPromise;
    const accumulated = getAccumulated().trim();
    if (streamError) {
      throw streamError;
    }

    messages.push({
      id: `explorer-response-${round}`,
      role: 'assistant',
      content: accumulated,
      timestamp: Date.now(),
    });

    const reasoningSnippet = getReasoningSnippet(accumulated);
    if (reasoningSnippet) {
      callbacks.onStatus('Explorer reasoning', reasoningSnippet);
    }

    const detected = detectAllToolCalls(accumulated);
    if (detected.extraMutations.length > 0) {
      messages.push({
        id: `explorer-parse-error-${round}`,
        role: 'user',
        content: formatParseError(
          buildToolCallParseErrorBlock({
            errorType: 'multiple_mutating_calls',
            problem: 'Explorer only supports read-only inspection tools and at most one trailing call per turn.',
            hint: 'Use one or more read-only tools, then finish with a plain-text report.',
          }),
        ),
        timestamp: Date.now(),
        isToolResult: true,
      });
      continue;
    }

    if (detected.readOnly.length > 1 || (detected.readOnly.length > 0 && detected.mutating)) {
      callbacks.onStatus('Explorer executing...', `${detected.readOnly.length} read-only tool call${detected.readOnly.length === 1 ? '' : 's'}`);

      const readResults = await Promise.all(
        detected.readOnly.map((call) => executeExplorerTool(
          call,
          allowedRepo,
          sandboxId,
          activeProvider,
          explorerModelId,
          hooks,
        )),
      );

      for (const entry of readResults) {
        if (entry.card) cards.push(entry.card);
        messages.push({
          id: `explorer-parallel-result-${round}-${messages.length}`,
          role: 'user',
          content: formatToolResult(entry.resultText),
          timestamp: Date.now(),
          isToolResult: true,
        });
      }

      if (detected.mutating) {
        const trailing = await executeExplorerTool(
          detected.mutating,
          allowedRepo,
          sandboxId,
          activeProvider,
          explorerModelId,
          hooks,
        );
        if (trailing.card) cards.push(trailing.card);
        messages.push({
          id: `explorer-trailing-result-${round}`,
          role: 'user',
          content: formatToolResult(trailing.resultText),
          timestamp: Date.now(),
          isToolResult: true,
        });
      }

      continue;
    }

    const toolCall = detectAnyToolCall(accumulated);
    if (toolCall) {
      callbacks.onStatus('Explorer executing...', toolCall.call.tool);
      const entry = await executeExplorerTool(
        toolCall,
        allowedRepo,
        sandboxId,
        activeProvider,
        explorerModelId,
        hooks,
      );
      if (entry.card) cards.push(entry.card);
      messages.push({
        id: `explorer-tool-result-${round}`,
        role: 'user',
        content: formatToolResult(entry.resultText),
        timestamp: Date.now(),
        isToolResult: true,
      });
      continue;
    }

    const unimplementedTool = detectUnimplementedToolCall(accumulated);
    if (unimplementedTool) {
      messages.push({
        id: `explorer-unimplemented-${round}`,
        role: 'user',
        content: formatParseError(
          buildUnimplementedToolErrorText(unimplementedTool, {
            availableToolsLabel: 'Available sandbox inspection tools',
            guidanceLines: [],
          }),
        ),
        timestamp: Date.now(),
        isToolResult: true,
      });
      continue;
    }

    const diagnosis = diagnoseToolCallFailure(accumulated);
    if (diagnosis && !diagnosis.telemetryOnly) {
      messages.push({
        id: `explorer-diagnosis-${round}`,
        role: 'user',
        content: formatParseError(
          buildToolCallParseErrorBlock({
            errorType: diagnosis.reason,
            detectedTool: diagnosis.toolName,
            problem: diagnosis.errorMessage,
          }),
        ),
        timestamp: Date.now(),
        isToolResult: true,
      });
      continue;
    }

    // --- Turn policy: afterModelCall ---
    // Before accepting a plain-text response as the final report, evaluate
    // the turn policy (no-empty-report guard). If the policy injects a
    // corrective message, continue the loop instead of returning.
    turnCtx.round = round;
    const policyResult = await policyRegistry.evaluateAfterModel(accumulated, messages, turnCtx);
    if (policyResult) {
      if (policyResult.action === 'halt') {
        return { summary: policyResult.summary, cards, rounds };
      }
      if (policyResult.action === 'inject') {
        messages.push(policyResult.message);
        continue;
      }
    }

    return {
      summary: accumulated,
      cards,
      rounds,
    };
  }

  return {
    summary: `[Explorer stopped after ${MAX_EXPLORER_ROUNDS} rounds — investigation may be incomplete. Return the strongest current findings with file/line evidence and recommend the next move.]`,
    cards,
    rounds: MAX_EXPLORER_ROUNDS,
  };
}
