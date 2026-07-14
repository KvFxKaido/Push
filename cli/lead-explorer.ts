/**
 * CLI lead Explorer fan-out — Agent Runtime Decisions §10.
 *
 * The single conversational lead does its own coding, but it can offload
 * read-only investigation to Explorer sub-agents — the same narrow,
 * Explorer-only delegation arc the web's Inline Foreground Lane wires
 * (`app/src/lib/inline-coder-run.ts:runInlineExplorerDelegation`), assembled
 * with the CLI's local reach: the shared Explorer kernel
 * (`lib/explorer-agent.ts`) over the real filesystem via `executeToolCall`,
 * the CLI provider streams, and the shared capability gate.
 *
 * Two exports matter to callers:
 *
 *   - `runLeadExplorerDelegation` — executes one `delegate_explorer` call
 *     from the lead's tool executor (`cli/lead-turn.ts`). Best-effort and
 *     self-contained: any failure (including abort) becomes a `[Tool Error]`
 *     / cancellation `resultText` the lead sees, never a thrown loop break —
 *     the kernel runs fanned-out Explorers in one `Promise.all` batch, so a
 *     throwing sibling would take down the others.
 *   - `makeCliReadOnlyToolExec` — the capability-gated read-only tool
 *     executor shared with the daemon (`cli/pushd.ts` wraps it as
 *     `makeDaemonExplorerToolExec` for its delegated Explorer / Deep
 *     Reviewer runs), so the lead's fan-out and the daemon's delegations
 *     enforce the read-only contract through one implementation.
 *
 * Deliberately NOT wired here (parity notes vs. the web lane):
 *   - No context-memory enrichment/write — the CLI's delegated Explorer
 *     paths don't do memory either (see `handleDelegateExplorer`); when LCM
 *     lands for CLI delegations both call sites should thread it together.
 *   - Delegation lifecycle still renders from `subagent.*` events; the final
 *     declared card additionally travels on `tool.execution_complete` so
 *     non-TUI consumers receive the same structured outcome.
 */

import { randomBytes } from 'node:crypto';

import { runExplorerAgent, type ExplorerAgentResult } from '../lib/explorer-agent.ts';
import type { DetectedToolCalls } from '../lib/coder-agent.ts';
import { buildDelegationBrief } from '../lib/delegation-brief.ts';
import {
  ROLE_CAPABILITIES,
  getToolCapabilities,
  isCapabilityMapped,
  roleCanUseTool,
} from '../lib/capabilities.ts';
import type { AgentRole } from '../lib/runtime-contract.ts';
import { isToolCard, type ToolCard } from '../lib/tool-cards.ts';
import { buildDelegationResultToolCard } from '../lib/tool-card-producers.ts';
import { getSubagentLabel } from '../lib/role-display.ts';
import { normalizeReasoning } from '../lib/reasoning-tokens.ts';
import type {
  AIProviderType,
  LlmMessage,
  NativeToolCall,
  PushStream,
} from '../lib/provider-contract.ts';
import { createProviderStream, PROVIDER_CONFIGS, resolveApiKey } from './provider.js';
import type { ProviderConfig } from './provider.js';
import { cliProviderModelSupportsNativeToolCalling } from './native-tool-gate.js';
import { getCliReadOnlyNativeToolSchemas } from './tool-function-schemas.js';
import { executeToolCall, READ_ONLY_TOOL_PROTOCOL } from './tools.js';
import type { RoleRoutingEntry } from './session-store.js';

/** Max Explorer sub-agents the CLI lead may fan out in a single turn (web parity). */
export const LEAD_MAX_PARALLEL_EXPLORERS = 2;

/**
 * Tool protocol advertised to the CLI lead for read-only Explorer delegation.
 * Guidance only (the executor and capability gate are the real controls);
 * kept next to the wiring so the advertised shape and the executor can't
 * drift. The `- delegate_explorer(...)` line follows the CLI tool-line
 * grammar (`CLI_TOOL_LINE_RE` in `cli/tool-function-schemas.ts`) so the
 * native function-calling schema is parsed from this block — one definition
 * for both dispatch paths. The CLI advertises the canonical name
 * (`delegate_explorer`), not the web registry's public alias: CLI detection
 * is pass-through (no alias resolution), so the advertised name must be the
 * name the executor matches.
 */
export const LEAD_EXPLORER_DELEGATION_PROTOCOL = `[DELEGATE_EXPLORER]
Offload read-only investigation to a fresh Explorer sub-agent. The Explorer can read files and search this workspace — it cannot edit, run commands, or commit. Reach for it to trace a flow or map architecture across many files without spending your own context; you remain the lead and do all editing yourself once it reports back.

- delegate_explorer(task, files?, knownContext?, deliverable?) — Delegate read-only investigation to a fresh Explorer sub-agent

Format:
{"tool": "delegate_explorer", "args": {"task": "<precise objective>", "files": ["src/foo.ts"], "knownContext": ["already-validated fact"], "deliverable": "<expected report>"}}

- "task" is required and should be a concrete objective, not a vague prompt.
- "files" / "knownContext" / "deliverable" are optional and sharpen the brief.
- Emit delegate_explorer calls at the start of a turn, alongside read-only calls and before any mutation.
- You may emit up to ${LEAD_MAX_PARALLEL_EXPLORERS} delegate_explorer calls in one turn (write them together) to investigate independent threads in parallel; they run concurrently and report back before your next turn. A third in the same turn is rejected — split it across turns.
[/DELEGATE_EXPLORER]`;

// ─── Read-only tool executor (shared with the daemon) ────────────

export interface CliReadOnlyToolExecOptions {
  /** Workspace root the tools execute against. */
  workspaceRoot: string;
  /** Session id for the structured capability-denial log line (null when unknown). */
  sessionId?: string | null;
  signal?: AbortSignal;
  /**
   * Read-only role that owns this executor (Explorer, or Deep Reviewer via
   * the daemon's `role: 'reviewer'`). The capability gate and executor
   * case-dispatch run under this role so denials attribute correctly.
   */
  role?: AgentRole;
}

/**
 * Build an Explorer-shaped read-only tool executor: `{ resultText, card? }`
 * return shape, no approval gating (the contract is read-only, so high-risk
 * exec is moot), and the shared three-layer capability gate in front of
 * `executeToolCall`.
 *
 * Extracted from `cli/pushd.ts:makeDaemonExplorerToolExec` when the lead's
 * Explorer fan-out became the second consumer — the daemon factory now wraps
 * this, so both surfaces enforce the read-only contract through one
 * implementation. The full gate rationale (fail-closed `isCapabilityMapped`,
 * the divergence from the web runtime's fail-open check, prototype-key
 * defense) lives on the daemon wrapper's doc comment, which predates the
 * extraction and is pinned by `cli/tests/daemon-integration.test.mjs`.
 */
export function makeCliReadOnlyToolExec({
  workspaceRoot,
  sessionId = null,
  signal,
  role = 'explorer',
}: CliReadOnlyToolExecOptions) {
  // The deep-reviewer runs under the `reviewer` role but is tagged
  // distinctly in events, so map it to the `deep_reviewer` subagent for
  // display; the plain read-only role is the Explorer. User-facing label
  // comes from the shared display seam (`lib/role-display.ts`).
  const roleLabel = getSubagentLabel(role === 'reviewer' ? 'deep_reviewer' : role);
  return async (
    toolCall: unknown,
    _execCtx?: { round: number; phase?: string },
  ): Promise<{ resultText: string; card?: ToolCard }> => {
    // Unwrap the `{ source, call: { tool, args } }` shape produced by
    // `wrapCliDetectAllToolCalls` / `wrapCliDetectAnyToolCall`. Tests
    // that hand in a bare CLI call fall through unchanged.
    const wrapped = toolCall as { call?: { tool?: unknown; args?: unknown } } | null;
    const rawCall = (
      wrapped && typeof wrapped === 'object' && wrapped.call ? wrapped.call : toolCall
    ) as { tool?: unknown; args?: Record<string, unknown> };

    // Three-layer gate (deny if ANY layer says no): non-empty string name,
    // fail-closed `isCapabilityMapped`, then the role grant. See the daemon
    // wrapper's doc comment for the full rationale (Gap 2 / PR #331).
    const toolName = typeof rawCall?.tool === 'string' ? rawCall.tool : null;
    if (!toolName || !isCapabilityMapped(toolName) || !roleCanUseTool(role, toolName)) {
      // Phrasing note: we deliberately do NOT name `delegate_coder` here —
      // the read-only roles cannot invoke it as a tool, and naming it sends
      // the model down a dead-end loop (Copilot review on PR #284).
      if (toolName) {
        const required = getToolCapabilities(toolName);
        const granted = Array.from(ROLE_CAPABILITIES[role] ?? []);
        try {
          // console.warn (stderr) — CLI stdout is reserved for user output
          // and `--json` payloads (see CLAUDE.md "Symmetric structured
          // logs"); same stream the daemon factory used before extraction.
          console.warn(
            JSON.stringify({
              level: 'warn',
              event: 'role_capability_denied',
              type: 'ROLE_CAPABILITY_DENIED',
              role,
              tool: toolName,
              required,
              granted,
              sessionId,
            }),
          );
        } catch {
          // JSON.stringify cycle guard — don't let a malformed log
          // crash the executor.
        }
      }
      return {
        resultText: `[pushd] tool "${toolName ?? '(unknown)'}" is not available to ${roleLabel}. ${roleLabel} is read-only; if mutation is needed, report it in your summary and the orchestrator will request a Coder delegation after you finish.`,
      };
    }

    try {
      const result = await executeToolCall(rawCall, workspaceRoot, {
        // Read-only roles never gate on approvals.
        approvalFn: null,
        signal,
        // `allowExec: false` keeps the tool surface genuinely read-only even
        // if the capability table ever accidentally grants an exec-family
        // tool. Defense in depth behind `roleCanUseTool`.
        allowExec: false,
        execMode: 'auto',
        // Pass the actual role so capability-gated executor cases deny
        // correctly rather than defaulting to orchestrator. Written
        // `role: role` (not shorthand) so the role-required drift detector
        // (cli/tests/role-required-drift.test.mjs) sees the `role:` key.
        role: role,
      });
      const resultText = typeof result?.text === 'string' ? result.text : '';
      const meta = result?.meta as Record<string, unknown> | null | undefined;
      const card = isToolCard(meta?.card) ? meta.card : undefined;
      return { resultText, ...(card ? { card } : {}) };
    } catch (err) {
      // `executeToolCall` throwing is the rare exception path (abort during
      // read, catastrophic I/O). Surface the message so the kernel can see
      // what went wrong rather than crashing the delegation.
      const message = err instanceof Error ? err.message : String(err);
      return { resultText: `[pushd] ${roleLabel} tool executor error: ${message}` };
    }
  };
}

// ─── Lead Explorer delegation runner ─────────────────────────────

/** Raw `delegate_explorer` args as the model emitted them (unvalidated). */
export interface LeadExplorerDelegationArgs {
  task?: unknown;
  files?: unknown;
  intent?: unknown;
  deliverable?: unknown;
  knownContext?: unknown;
  constraints?: unknown;
}

/** Detector slots for the Explorer kernel — injected by the caller (the
 * lead lane already holds them) so this module doesn't import
 * `cli/lead-turn.ts` back. The Explorer run always uses the default
 * (no parallel-delegation bucket) detectors: an Explorer cannot fan out
 * further Explorers. */
export interface LeadExplorerDetectors<TCall> {
  detectAllToolCalls: (text: string) => DetectedToolCalls<TCall>;
  detectNativeToolCalls?: (calls: readonly NativeToolCall[]) => DetectedToolCalls<TCall>;
  detectAnyToolCall: (text: string) => TCall | null;
}

export interface LeadExplorerRunContext<TCall> {
  cwd: string;
  sessionId: string;
  /** The lead turn's locked provider — the delegation inherits it unless role routing overrides. */
  providerConfig: ProviderConfig;
  apiKey: string;
  /** The lead's model (`state.model`), if set. */
  model?: string | null;
  /** Session role routing (`configure_role_routing`) — `explorer` entry wins over the lead's lock. */
  roleRouting?: Record<string, RoleRoutingEntry> | null;
  projectInstructions?: string;
  instructionFilename?: string;
  signal?: AbortSignal;
  detectors: LeadExplorerDetectors<TCall>;
  onStatus?: (phase: string, detail?: string) => void;
  /**
   * Event sink — the caller wires this to its persist + dispatch pair so
   * `subagent.started` / `subagent.completed` / `subagent.failed` land in
   * the session log and on attached clients (the TUI/REPL delegation
   * renderers key on these).
   */
  emitEvent: (type: string, payload: Record<string, unknown>) => void;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === 'string' && !!item.trim());
  return items.length > 0 ? items : undefined;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Execute one `delegate_explorer` call from the CLI lead. Emits the
 * `subagent.*` lifecycle events, runs the shared Explorer kernel against the
 * local workspace, and returns the compact `resultText` the lead reads.
 * Never throws (see module doc).
 */
export async function runLeadExplorerDelegation<TCall>(
  args: LeadExplorerDelegationArgs,
  ctx: LeadExplorerRunContext<TCall>,
): Promise<{ resultText: string; card?: ToolCard }> {
  const task = asOptionalString(args.task);
  if (!task) {
    return {
      resultText: '[Tool Error] delegate_explorer requires a non-empty "task" string.',
    };
  }
  // Already-aborted short-circuit: if the turn was cancelled before this
  // delegation ran (e.g. a sibling in the same parallel fan-out already saw
  // the abort), don't spin up an Explorer just to await a rejection. Checked
  // before emitting `subagent.started` so no started event goes unpaired.
  if (ctx.signal?.aborted) {
    return { resultText: '[Explorer cancelled by user.]' };
  }

  // Same id shape as the daemon's delegated Explorer runs so log readers see
  // one vocabulary for "an Explorer ran in this session".
  const executionId = `sub_explorer_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
  const startMs = Date.now();

  // Best-effort lifecycle emission: the caller's sink dispatches to
  // client-supplied emit callbacks synchronously, so a throwing sink here
  // would break this function's never-throw contract — the started emit runs
  // before the try, and a throw from the failed emit inside the catch would
  // re-propagate — rejecting the kernel's whole fan-out Promise.all batch.
  // A dropped event is logged (stderr — CLI stdout is reserved) instead of
  // vanishing; the delegation itself proceeds.
  const emitLifecycle = (type: string, payload: Record<string, unknown>): void => {
    try {
      ctx.emitEvent(type, payload);
    } catch (err) {
      try {
        console.error(
          JSON.stringify({
            level: 'warn',
            event: 'lead_explorer_event_emit_failed',
            type,
            executionId,
            sessionId: ctx.sessionId,
            message: err instanceof Error ? err.message : String(err),
          }),
        );
      } catch {
        // JSON.stringify cycle guard — never let logging break the contract.
      }
    }
  };

  // Provider/model resolution with role-routing precedence, mirroring the
  // daemon's `handleDelegateExplorer`: an `explorer` role route overrides the
  // lead's locked provider; otherwise the delegation inherits the lock
  // (provider routing contract — delegated Explorer runs inherit the chat
  // lock). The inherited path reuses the lead's live config + key verbatim —
  // it must NOT re-derive from `PROVIDER_CONFIGS`, which would drop
  // runtime overrides (e.g. a test-injected base URL).
  const route = ctx.roleRouting?.explorer;
  const routedProvider = asOptionalString(route?.provider);
  let providerId = ctx.providerConfig.id;
  let streamConfig = ctx.providerConfig;
  let streamKey = ctx.apiKey;
  let modelId =
    asOptionalString(route?.model) ||
    asOptionalString(ctx.model) ||
    ctx.providerConfig.defaultModel;
  if (routedProvider && routedProvider !== ctx.providerConfig.id) {
    const routedConfig = PROVIDER_CONFIGS[routedProvider];
    if (!routedConfig) {
      return {
        resultText: `[Tool Error] Explorer role routing names unknown provider "${routedProvider}" — fix it with configure_role_routing or clear the route.`,
      };
    }
    try {
      streamKey = resolveApiKey(routedConfig);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { resultText: `[Tool Error] Explorer delegation failed: ${message}` };
    }
    providerId = routedProvider;
    streamConfig = routedConfig;
    modelId =
      asOptionalString(route?.model) || asOptionalString(ctx.model) || routedConfig.defaultModel;
  }

  const providerStream = createProviderStream(streamConfig, streamKey, {
    sessionId: ctx.sessionId,
  });
  const stream: PushStream<LlmMessage> = (req) =>
    normalizeReasoning(providerStream({ ...req, provider: providerId as AIProviderType }));

  emitLifecycle('subagent.started', {
    executionId,
    subagentId: executionId,
    agent: 'explorer',
    role: 'explorer',
    detail: task.slice(0, 280),
  });

  try {
    const taskPreamble = buildDelegationBrief({
      task,
      intent: asOptionalString(args.intent),
      deliverable: asOptionalString(args.deliverable),
      knownContext: asStringArray(args.knownContext),
      constraints: asStringArray(args.constraints),
      files: asStringArray(args.files),
      targetRole: 'explorer',
    });
    const nativeToolSchemas = cliProviderModelSupportsNativeToolCalling(providerId, modelId)
      ? getCliReadOnlyNativeToolSchemas()
      : undefined;
    const toolExec = makeCliReadOnlyToolExec({
      workspaceRoot: ctx.cwd,
      sessionId: ctx.sessionId,
      signal: ctx.signal,
    });

    const result: ExplorerAgentResult<unknown> = await runExplorerAgent<TCall, unknown>(
      {
        provider: providerId as AIProviderType,
        stream,
        modelId,
        sandboxId: null,
        allowedRepo: '',
        userProfile: null,
        taskPreamble,
        symbolSummary: null,
        toolExec,
        detectAllToolCalls: ctx.detectors.detectAllToolCalls,
        detectNativeToolCalls: ctx.detectors.detectNativeToolCalls,
        detectAnyToolCall: ctx.detectors.detectAnyToolCall,
        webSearchToolProtocol: '',
        // The kernel's default `EXPLORER_TOOL_PROTOCOL` advertises web-side
        // public tool names the CLI executor doesn't recognize; override with
        // the CLI-named read-only block (same as the daemon entrypoints).
        sandboxToolProtocol: READ_ONLY_TOOL_PROTOCOL,
        nativeToolSchemas,
        projectInstructions: ctx.projectInstructions,
        instructionFilename: ctx.instructionFilename,
        evaluateAfterModel: async () => null,
      },
      {
        onStatus: ctx.onStatus ?? (() => {}),
        signal: ctx.signal,
      },
    );

    const summary = result.summary.trim();
    const status = result.hitRoundCap
      ? 'incomplete'
      : result.rounds > 0 && summary
        ? 'complete'
        : 'inconclusive';
    const elapsedMs = Date.now() - startMs;
    emitLifecycle('subagent.completed', {
      executionId,
      subagentId: executionId,
      agent: 'explorer',
      role: 'explorer',
      // Schema requires a non-empty summary (lib/protocol-schema.ts).
      summary: (summary || '(no findings)').slice(0, 500),
      rounds: result.rounds,
      status,
      elapsedMs,
    });

    const capNote = result.hitRoundCap
      ? '\n\n[Investigation hit the round cap — re-delegate with a narrower scope or proceed with partial findings.]'
      : '';
    return {
      resultText: `[EXPLORER_RESULT status=${status} rounds=${result.rounds}]\n${summary || '(no findings)'}${capNote}`,
      card: buildDelegationResultToolCard({
        status,
        summary: summary || '(no findings)',
        rounds: result.rounds,
        checkpoints: 0,
        elapsedMs,
        gateVerdicts: [],
        missingRequirements: result.hitRoundCap ? ['Investigation exceeded its round cap.'] : [],
        nextRequiredAction: result.hitRoundCap
          ? 'Re-delegate with a narrower scope or proceed with the partial findings.'
          : null,
      }),
    };
  } catch (err) {
    const isAbort =
      (err instanceof Error && err.name === 'AbortError') || (ctx.signal?.aborted ?? false);
    const message = err instanceof Error ? err.message : String(err);
    emitLifecycle('subagent.failed', {
      executionId,
      subagentId: executionId,
      agent: 'explorer',
      role: 'explorer',
      error: (isAbort ? 'Explorer cancelled by user.' : message).slice(0, 500) || '(unknown error)',
    });
    if (isAbort) {
      return { resultText: '[Explorer cancelled by user.]' };
    }
    return { resultText: `[Tool Error] Explorer delegation failed: ${message}` };
  }
}
