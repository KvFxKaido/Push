/**
 * Run-adoption loop support — Durable Runs (Adopt-on-Silence), Phase 2 loop.
 *
 * The host-agnostic half of continuing an adopted run: everything here is
 * pure (no storage, no fetch, no DO types) so the same pieces work wherever
 * the loop is hosted and the vocabulary can be drift-pinned
 * (`cli/tests/run-adoption-loop.test.mjs`, same discipline as
 * `run-host-adoption.ts` / `run-checkpoint.ts`).
 *
 * An adopted run continues on the coder kernel (`runCoderAgent`) — the one
 * `lib/` role kernel that already runs dual-homed (in-page and in the
 * CoderJob DO). The delegation-collapse precondition means the simplified
 * orchestrator loop and the inline coder loop converge, so the kernel is
 * seeded from the stored `RunCheckpointV1` transcript rather than a fresh
 * task brief:
 *
 *   - `runCheckpointToCoderResumeState` maps checkpoint → kernel resume seed,
 *     appending a model-readable `[RUN_ADOPTED]` note that explains the new
 *     execution context (user away, which tool families are deferred, mode
 *     semantics).
 *   - `createAdoptionToolGate` wraps the kernel's tool executor: chat-hook /
 *     orchestrator-only tool families are DEFERRED with a model-readable
 *     note (never silently dropped — the resolution of the Phase 2 design
 *     question), and supervised runs PAUSE at approval gates
 *     (`lib/approval-gates`) instead of acting.
 *   - `coderStateToRunCheckpoint` maps the kernel's per-round checkpoint
 *     state back into a `RunCheckpointV1` so the host persists server-side
 *     progress in the same schema the client mirrors up — one checkpoint
 *     vocabulary across both homes.
 *
 * Credentials NEVER appear here: this module sees a validated checkpoint
 * (whose schema structurally rejects credential-shaped fields) and returns
 * shapes for a host that provisioned secrets out-of-band.
 */

import type { ToolCard } from './tool-cards.js';
import {
  type ApprovalGateRegistry,
  type ApprovalMode,
  createDefaultApprovalGates,
} from './approval-gates.ts';
import type {
  CoderCheckpointState,
  CoderLoopMessage,
  CoderToolExecResult,
  DetectedToolCalls,
} from './coder-agent.ts';
import { type TaggedCallShape, isCoderInternalToolName } from './coder-agent-bindings.ts';
import type { RunHostResolvedApproval } from './run-host-adoption.ts';
import type {
  RunCheckpointMessage,
  RunCheckpointPendingApproval,
  RunCheckpointV1,
} from './run-checkpoint.ts';
import type { ToolHookContext } from './tool-hooks.ts';

// ---------------------------------------------------------------------------
// Vocabulary — markers + deferred tool families (drift-pinned)
// ---------------------------------------------------------------------------

/** Marker on the context note appended to a resumed transcript. */
export const ADOPTION_RESUME_NOTE_MARKER = '[RUN_ADOPTED]';

/** Marker on every deferred-tool result the model sees while adopted. */
export const ADOPTION_DEFERRED_NOTE_MARKER = '[TOOL_DEFERRED]';

/** Marker on the pause note a supervised approval gate produces. */
export const ADOPTION_PAUSE_NOTE_MARKER = '[RUN_PAUSED_FOR_APPROVAL]';

/** Marker on the note carrying a user's approve/deny decision into a
 * relaunched run (Phase 3 attach controls). */
export const ADOPTION_APPROVAL_RESOLVED_NOTE_MARKER = '[APPROVAL_RESOLVED]';

/**
 * Tool-call sources that cannot execute while the run is hosted server-side.
 * Each gets a model-readable deferral note instead of silent dropping:
 *
 *   - `scratchpad` / `todo` — chat-hook tools execute against in-page stores;
 *     no server-side store exists (the CoderJob memory-tools precedent), so
 *     the call is recorded in the transcript and deferred.
 *   - `delegate` — no nested delegation from an adopted run; the kernel does
 *     the work inline (delegation collapse is the precondition of this loop).
 *   - `ask-user` — there is no user attached. Full-auto/autonomous runs are
 *     told to proceed on best judgment; supervised runs PAUSE instead (see
 *     `createAdoptionToolGate`).
 *   - `artifacts` — in-page artifact store, same deferral as scratchpad.
 *   - `github` — GitHub tools ride the user's session credentials, which are
 *     never provisioned to an adopted run; PR/commit delivery waits for the
 *     user's return.
 */
export const ADOPTION_DEFERRED_TOOL_SOURCES = [
  'scratchpad',
  'todo',
  'delegate',
  'ask-user',
  'artifacts',
  'github',
] as const;

const DEFERRED_SOURCES: ReadonlySet<string> = new Set(ADOPTION_DEFERRED_TOOL_SOURCES);

/** Extra rounds an adopted continuation gets beyond the checkpointed round,
 * so a run adopted late in a long session isn't instantly round-capped. */
export const ADOPTION_EXTRA_ROUNDS = 30;

// ---------------------------------------------------------------------------
// Checkpoint → kernel resume seed
// ---------------------------------------------------------------------------

function toCoderLoopMessage(msg: RunCheckpointMessage, index: number): CoderLoopMessage {
  return {
    id: `adopted-${index}`,
    // `LlmMessage` has no `tool` role; checkpointed tool turns become user
    // turns flagged `isToolResult`, the same wire shape the web loop uses.
    role: msg.role === 'tool' ? 'user' : msg.role,
    content: msg.content,
    ...(msg.contentBlocks ? { contentBlocks: msg.contentBlocks } : {}),
    ...(msg.contentParts ? { contentParts: msg.contentParts } : {}),
    ...(msg.reasoningBlocks ? { reasoningBlocks: msg.reasoningBlocks } : {}),
    ...(msg.toolUses ? { toolUses: msg.toolUses } : {}),
    ...(msg.toolResults ? { toolResults: msg.toolResults } : {}),
    ...(msg.isToolCall ? { isToolCall: true } : {}),
    ...(msg.isToolResult || msg.role === 'tool' ? { isToolResult: true } : {}),
    timestamp: 0,
  };
}

/**
 * The model-readable context note appended to the resumed transcript. This
 * surfaces hard runtime boundaries the model cannot infer (which tools are
 * deferred, what supervised mode means here) — prompt-as-documentation, not
 * prompt-as-control-plane: every boundary described is also enforced in code
 * by `createAdoptionToolGate`.
 */
export function buildAdoptionResumeNote(checkpoint: RunCheckpointV1): string {
  const lines = [
    `${ADOPTION_RESUME_NOTE_MARKER} The user's device went silent mid-run, so this run now continues server-side from its last checkpoint. The user is away and cannot respond.`,
    '',
    `Original goal: ${checkpoint.userGoal || '(see transcript above)'}`,
    `Active branch: ${checkpoint.branch} (repo ${checkpoint.repoFullName}).`,
    '',
    'While running server-side:',
    '- Sandbox tools (exec, read, write, list, diff) and web search keep working.',
    '- Scratchpad, todo, delegation, artifact, and GitHub tools are DEFERRED: calls are recorded in the transcript and answered with a deferral note. Do the work inline with sandbox tools and leave delivery steps (commits, PRs) for when the user returns.',
    checkpoint.approvalMode === 'supervised'
      ? '- This run is SUPERVISED: any action that needs user approval pauses the run instead of acting. Prefer non-destructive work.'
      : '- This run continues uninterrupted; use your best judgment in place of user input.',
    '',
    'Continue the task from where the transcript leaves off, then summarize what you did and what remains.',
  ];
  return lines.join('\n');
}

/**
 * The model-readable note carrying a user's decision on the gate the run
 * paused at. Appended to the resume seed AFTER the adoption note when a
 * relaunch was triggered by `/run/approval` (Phase 3): the transcript already
 * ends with the pause note, so this is the answer the model was told to wait
 * for. The enforcement half lives in `createAdoptionToolGate`'s
 * `resolvedApproval` option — the note documents it, code enforces it.
 */
export function buildApprovalResolutionNote(resolution: RunHostResolvedApproval): string {
  if (resolution.decision === 'approve') {
    return (
      `${ADOPTION_APPROVAL_RESOLVED_NOTE_MARKER} The user APPROVED the pending action ` +
      `(${resolution.tool}, ${resolution.kind}). You may now perform that action once — retry the ` +
      `tool call that paused the run, then continue the task.`
    );
  }
  return (
    `${ADOPTION_APPROVAL_RESOLVED_NOTE_MARKER} The user DENIED the pending action ` +
    `(${resolution.tool}, ${resolution.kind}). Do not retry it. Continue the task another way, or ` +
    `summarize what you completed and what remains.`
  );
}

/**
 * Map a stored RunCheckpointV1 into the coder kernel's resume seed. The
 * transcript is taken verbatim (plus the adoption note appended as the
 * latest user turn, plus the approval-resolution note when this relaunch
 * carries one); working memory carries over; cards start empty — the
 * client that owns the original cards is gone, and a reclaiming client
 * rebuilds UI state from its own store.
 */
export function runCheckpointToCoderResumeState<TCard extends ToolCard = ToolCard>(
  checkpoint: RunCheckpointV1,
  opts?: { resolvedApproval?: RunHostResolvedApproval | null },
): CoderCheckpointState<TCard> {
  const messages = checkpoint.messages.map(toCoderLoopMessage);
  messages.push({
    id: 'adopted-resume-note',
    role: 'user',
    content: buildAdoptionResumeNote(checkpoint),
    timestamp: 0,
  });
  if (opts?.resolvedApproval) {
    messages.push({
      id: 'adopted-approval-resolution',
      role: 'user',
      content: buildApprovalResolutionNote(opts.resolvedApproval),
      timestamp: 0,
    });
  }
  return {
    round: checkpoint.round,
    messages,
    workingMemory: checkpoint.workingMemory ? { ...checkpoint.workingMemory } : {},
    cards: [],
  };
}

// ---------------------------------------------------------------------------
// Kernel state → RunCheckpointV1 (per-round server-side persistence)
// ---------------------------------------------------------------------------

function toRunCheckpointMessage(msg: CoderLoopMessage): RunCheckpointMessage {
  return {
    role: msg.role,
    content: msg.content,
    ...(msg.contentBlocks ? { contentBlocks: msg.contentBlocks } : {}),
    ...(msg.contentParts ? { contentParts: msg.contentParts } : {}),
    ...(msg.reasoningBlocks ? { reasoningBlocks: msg.reasoningBlocks } : {}),
    ...(msg.toolUses ? { toolUses: msg.toolUses } : {}),
    ...(msg.toolResults ? { toolResults: msg.toolResults } : {}),
    ...(msg.isToolCall ? { isToolCall: true } : {}),
    ...(msg.isToolResult ? { isToolResult: true } : {}),
  };
}

/**
 * Build the checkpoint the host persists for an adopted run's progress.
 * Identity, scope, and the provider lock carry over from the adoption-source
 * checkpoint; transcript and round come from the kernel's snapshot. Same
 * schema both homes write — a reclaim or a later adoption resumes from this
 * exactly as it would from a client-mirrored checkpoint.
 */
export function coderStateToRunCheckpoint<TCard extends ToolCard = ToolCard>(
  base: RunCheckpointV1,
  state: Pick<CoderCheckpointState<TCard>, 'round' | 'messages' | 'workingMemory'>,
  opts: { savedAt: number; pendingApproval?: RunCheckpointPendingApproval | null },
): RunCheckpointV1 {
  return {
    ...base,
    round: state.round,
    phase: 'executing_tools',
    savedAt: opts.savedAt,
    reason: 'turn',
    messages: state.messages.map(toRunCheckpointMessage),
    accumulated: '',
    thinkingAccumulated: '',
    workingMemory:
      state.workingMemory && Object.keys(state.workingMemory).length > 0
        ? state.workingMemory
        : base.workingMemory,
    pendingApproval: opts.pendingApproval ?? null,
  };
}

// ---------------------------------------------------------------------------
// Deferral notes
// ---------------------------------------------------------------------------

/** Model-readable deferral for a tool family that can't run server-side. */
export function buildAdoptionDeferralNote(source: string, tool: string): string {
  const head = `${ADOPTION_DEFERRED_NOTE_MARKER} ${tool} is deferred while this run executes server-side (the user's device is away).`;
  switch (source) {
    case 'scratchpad':
    case 'todo':
    case 'artifacts':
      return `${head} The call was recorded in the transcript and will surface when the user returns. Continue without it.`;
    case 'delegate':
      return `${head} Delegation isn't available here — do the work inline with sandbox tools instead.`;
    case 'ask-user':
      return `${head} No user is attached; your question was recorded and will surface when they return. Proceed with your best judgment.`;
    case 'github':
      return `${head} GitHub tools ride the user's session and aren't provisioned to a server-side run. Finish the local work with sandbox tools and leave commits/PRs for the user's return.`;
    default:
      return `${head} Continue with sandbox tools.`;
  }
}

// ---------------------------------------------------------------------------
// Approval-grant binding
// ---------------------------------------------------------------------------

/** Canonical JSON: stable key order at every depth, so two emissions of the
 * same arguments fingerprint identically regardless of property order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Deterministic fingerprint of a gated call's arguments (FNV-1a 64-bit over
 * the canonical JSON). An approval grant is bound to tool + fingerprint so
 * the user approves a specific action, not a tool family: a same-tool call
 * with different arguments after the resolution note re-pauses instead of
 * riding the grant. Not a cryptographic commitment — the gate is a consent
 * boundary for a cooperating-but-fallible model, and the enforcement that
 * matters (delivery rules, git blocks, capability gating) stays in the
 * executor underneath.
 */
export function fingerprintApprovalArgs(args: Record<string, unknown>): string {
  const canonical = canonicalJson(args);
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= BigInt(canonical.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}

// ---------------------------------------------------------------------------
// The adoption tool gate
// ---------------------------------------------------------------------------

export interface AdoptionToolGateOptions<
  TCall extends TaggedCallShape,
  TCard extends ToolCard = ToolCard,
> {
  /** The run's locked approval mode (from the host record / checkpoint). */
  mode: ApprovalMode;
  /** The real executor for sandbox / web-search / memory calls (the wrapped
   * `buildCoderToolExec` closure). */
  execute: (
    call: TCall,
    execCtx: { round: number; phase?: string },
  ) => Promise<CoderToolExecResult<TCard>>;
  /** Hook context for the approval-gate rules (capability ledger rides here). */
  hookContext: ToolHookContext;
  /**
   * Called once when a supervised run hits an approval gate. The host
   * persists the pending approval and stops the loop cleanly; the gate's
   * return value carries the model-readable pause note in the same turn.
   */
  onPause: (pending: RunCheckpointPendingApproval) => void;
  /**
   * A user decision on the gate this relaunch resumes from (Phase 3 attach
   * controls). `approve` grants ONE matching execution of the gated tool —
   * consumed on first use, so the user approved an action, not a category.
   * `deny` is sticky for this adoption: matching gate hits return a
   * model-readable denial instead of pausing again.
   */
  resolvedApproval?: RunHostResolvedApproval | null;
  /** Override the default gate registry (tests). */
  gates?: ApprovalGateRegistry;
}

/**
 * Wrap the kernel's tool executor with adopted-run semantics:
 *
 *   1. Deferred sources → model-readable deferral note (executed, no error)
 *      — except `ask-user` in supervised mode, which pauses (asking is the
 *      approval interaction supervised mode exists for).
 *   2. Supervised approval gates (destructive exec, direct-git override,
 *      remote side effects, capability violations) → `ask_user` decisions
 *      PAUSE the run with `onPause` + a halting pause note; hard `blocked`
 *      decisions stay model-readable denials.
 *   3. Everything else → the real executor.
 *
 * Pause mechanics: the result carries `policyPost: { kind: 'halt' }`, so the
 * kernel records the note in the transcript and the next round's checkpoint
 * persists it before the host's abort lands — the pause is durable and
 * model-readable, and no further side effects execute (the gate keeps
 * pausing/denying until a client reclaims the run).
 */
export function createAdoptionToolGate<
  TCall extends TaggedCallShape,
  TCard extends ToolCard = ToolCard,
>(
  options: AdoptionToolGateOptions<TCall, TCard>,
): (
  call: TCall,
  execCtx: { round: number; phase?: string },
) => Promise<CoderToolExecResult<TCard>> {
  const gates = options.gates ?? createDefaultApprovalGates({ modeProvider: () => options.mode });
  let pauseIssued = false;
  // One-shot approve grant: consumed by the first gate hit matching BOTH the
  // tool and the argument fingerprint the user approved — a same-tool call
  // with different arguments is a different action and re-pauses (a grant
  // missing its fingerprint predates fingerprinting and degrades to
  // tool-level matching). Deny stays sticky at tool level (conservative:
  // repeat denials execute nothing and stay model-readable).
  let approveGrant =
    options.resolvedApproval?.decision === 'approve' ? options.resolvedApproval : null;
  const denied = options.resolvedApproval?.decision === 'deny' ? options.resolvedApproval : null;
  const grantMatches = (tool: string, argsFingerprint: string): boolean =>
    approveGrant !== null &&
    approveGrant.tool === tool &&
    (approveGrant.argsFingerprint === undefined ||
      approveGrant.argsFingerprint === argsFingerprint);

  const pause = (
    tool: string,
    round: number,
    kind: string,
    summary: string,
    argsFingerprint: string,
  ): CoderToolExecResult<TCard> => {
    const pending: RunCheckpointPendingApproval = {
      approvalId: `adopt-${tool}-r${round}`,
      kind,
      tool,
      argsFingerprint,
      title: `Approval required: ${tool}`,
      summary,
    };
    if (!pauseIssued) {
      pauseIssued = true;
      options.onPause(pending);
    }
    const note =
      `${ADOPTION_PAUSE_NOTE_MARKER} ${tool} needs user approval (${kind}) and this supervised ` +
      `run is executing server-side with the user away. The run is pausing here; the pending ` +
      `approval was recorded and the user will resolve it when they return. Do not retry the action.`;
    return {
      kind: 'executed',
      resultText: note,
      policyPost: { kind: 'halt', summary: note },
    };
  };

  return async (call, execCtx) => {
    const source = call.source;
    const tool = call.call.tool;
    const args = (call.call.args ?? {}) as Record<string, unknown>;
    const argsFingerprint = fingerprintApprovalArgs(args);

    if (source === 'ask-user' && options.mode === 'supervised') {
      // A resolved ask_user gate is its own answer: approve means "proceed
      // on best judgment", deny means "don't" — either way the resolution
      // note in the seed carries it; answer once instead of re-pausing.
      // Tool-level match is deliberate here: the answer is to the pause
      // itself and executes nothing, so argument binding adds no safety.
      if (approveGrant && approveGrant.tool === tool) {
        approveGrant = null;
        return {
          kind: 'executed',
          resultText: `${ADOPTION_APPROVAL_RESOLVED_NOTE_MARKER} The user already answered this pause: proceed on your best judgment.`,
        };
      }
      if (denied && denied.tool === tool) {
        return {
          kind: 'executed',
          resultText: `${ADOPTION_APPROVAL_RESOLVED_NOTE_MARKER} The user declined this request for input. Proceed without it or wrap up.`,
        };
      }
      return pause(
        tool,
        execCtx.round,
        'ask_user',
        'The model asked for user input mid-run while the run was executing server-side.',
        argsFingerprint,
      );
    }
    if (DEFERRED_SOURCES.has(source)) {
      return { kind: 'executed', resultText: buildAdoptionDeferralNote(source, tool) };
    }

    const gateResult = await gates.evaluate(tool, args, options.hookContext);
    if (gateResult) {
      if (gateResult.decision === 'ask_user') {
        if (grantMatches(tool, argsFingerprint)) {
          approveGrant = null;
          return options.execute(call, execCtx);
        }
        if (denied && denied.tool === tool) {
          return {
            kind: 'denied',
            reason: `The user denied this action (${denied.kind}). Do not retry it.`,
          };
        }
        // Same tool but different arguments than the user approved lands
        // here too: it's a different action, so it pauses with a fresh
        // fingerprint rather than riding the grant.
        return pause(tool, execCtx.round, gateResult.category, gateResult.reason, argsFingerprint);
      }
      return { kind: 'denied', reason: gateResult.reason };
    }

    return options.execute(call, execCtx);
  };
}

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

/**
 * Detector pair for an adopted run. Unlike `buildCoderDetectors` (which
 * filters non-sandbox sources out of the batch — correct for a delegated
 * Coder, but silent dropping here), the adoption detectors keep EVERY
 * detected call so the tool gate can answer deferred families with a
 * model-readable note. Only the Coder-internal pseudo-tools
 * (`coder_update_state` / `coder_checkpoint`, handled inside the kernel) are
 * filtered from `droppedCandidates`, mirroring the bindings.
 */
export function buildAdoptionDetectors<TCall extends TaggedCallShape>(raw: {
  detectAllToolCalls: (text: string) => DetectedToolCalls<TCall>;
  detectAnyToolCall: (text: string) => TCall | null;
}): {
  detectAllToolCalls: (text: string) => DetectedToolCalls<TCall>;
  detectAnyToolCall: (text: string) => TCall | null;
} {
  return {
    detectAllToolCalls: (text) => {
      const detected = raw.detectAllToolCalls(text);
      return {
        ...detected,
        droppedCandidates: detected.droppedCandidates.filter(
          (c) => !isCoderInternalToolName(c.rawToolName),
        ),
      };
    },
    detectAnyToolCall: raw.detectAnyToolCall,
  };
}
