/**
 * Turn Policy — deterministic per-turn invariants for the agent harness.
 *
 * Consolidates scattered reliability guarantees (drift detection, read-only
 * enforcement, empty-completion guards, mutation tracking) into one composable
 * layer. Each agent role declares a policy; the harness evaluates it at four
 * hook points in every turn:
 *
 *   1. beforeModelCall  — inject pending state, validate readiness
 *   2. afterModelCall   — validate response substance, detect drift/empty output
 *   3. beforeToolExec   — role-based tool gating
 *   4. afterToolExec    — normalize recovery, track failures, attach state
 *
 * Policies are additive: multiple hooks at the same point run in order.
 * A hook can return an action (inject, block, halt) or passthrough (null).
 *
 * Design: this layer does NOT replace tool-hooks.ts — it sits above it.
 * Tool hooks gate individual tool calls; turn policies gate entire turns.
 */

import type { ChatMessage } from '@/types';
import type { ToolHookRegistry } from './tool-hooks';

// ---------------------------------------------------------------------------
// Agent role type — the five locked roles
// ---------------------------------------------------------------------------

export type AgentRole = 'orchestrator' | 'explorer' | 'coder' | 'reviewer' | 'auditor';

// ---------------------------------------------------------------------------
// Turn context — shared state visible to all policy hooks within a turn
// ---------------------------------------------------------------------------

/** Immutable snapshot of the current turn state, passed to every hook. */
export interface TurnContext {
  /** Which agent role is running. */
  role: AgentRole;
  /** Zero-based round index within the current agent run. */
  round: number;
  /** Maximum rounds allowed for this agent run. */
  maxRounds: number;
  /** Sandbox ID, if any. */
  sandboxId: string | null;
  /** Active repo (owner/name). */
  allowedRepo: string;
  /** Active AI provider key. */
  activeProvider?: string;
  /** Active model ID. */
  activeModel?: string;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Hook results — what a policy hook can return
// ---------------------------------------------------------------------------

/**
 * Result from a beforeModelCall hook.
 * - inject: prepend a system/user message before the model sees the conversation
 * - halt:   stop the agent loop immediately with a summary
 * - null:   passthrough, no action
 */
export type BeforeModelResult =
  | { action: 'inject'; message: ChatMessage }
  | { action: 'halt'; summary: string }
  | null;

/**
 * Result from an afterModelCall hook.
 * - inject:  append a corrective user message and continue the loop
 * - halt:    stop the agent loop immediately with a summary
 * - null:    passthrough, response is valid
 */
export type AfterModelResult =
  | { action: 'inject'; message: ChatMessage }
  | { action: 'halt'; summary: string }
  | null;

/**
 * Result from a beforeToolExec hook.
 * - deny:  block the tool call with a reason (matches existing PreToolUseResult shape)
 * - null:  passthrough, allow execution
 */
export type BeforeToolResult =
  | { action: 'deny'; reason: string }
  | null;

/**
 * Result from an afterToolExec hook.
 * - inject:  append an advisory message after the tool result
 * - halt:    stop the loop (e.g., repeated mutation failures)
 * - null:    passthrough
 */
export type AfterToolResult =
  | { action: 'inject'; message: ChatMessage }
  | { action: 'halt'; summary: string }
  | null;

// ---------------------------------------------------------------------------
// Hook signatures
// ---------------------------------------------------------------------------

export type BeforeModelHook = (
  messages: readonly ChatMessage[],
  ctx: TurnContext,
) => BeforeModelResult | Promise<BeforeModelResult>;

export type AfterModelHook = (
  response: string,
  messages: readonly ChatMessage[],
  ctx: TurnContext,
) => AfterModelResult | Promise<AfterModelResult>;

export type BeforeToolHook = (
  toolName: string,
  args: Record<string, unknown>,
  ctx: TurnContext,
) => BeforeToolResult | Promise<BeforeToolResult>;

export type AfterToolHook = (
  toolName: string,
  args: Record<string, unknown>,
  resultText: string,
  hasError: boolean,
  ctx: TurnContext,
) => AfterToolResult | Promise<AfterToolResult>;

// ---------------------------------------------------------------------------
// TurnPolicy — declarative per-role policy
// ---------------------------------------------------------------------------

export interface TurnPolicy {
  /** Human-readable label for logging/telemetry. */
  name: string;
  /** Which role this policy applies to. */
  role: AgentRole;

  /** Hooks at each turn phase. All are optional. */
  beforeModelCall?: BeforeModelHook[];
  afterModelCall?: AfterModelHook[];
  beforeToolExec?: BeforeToolHook[];
  afterToolExec?: AfterToolHook[];
}

// ---------------------------------------------------------------------------
// TurnPolicyRegistry — collects policies and evaluates them
// ---------------------------------------------------------------------------

export class TurnPolicyRegistry {
  private policies: TurnPolicy[] = [];

  /** Register a policy. Multiple policies per role are allowed (additive). */
  register(policy: TurnPolicy): void {
    this.policies.push(policy);
  }

  /** Remove all policies for a given role. Used to reset stateful policies. */
  deregister(role: AgentRole): void {
    this.policies = this.policies.filter((p) => p.role !== role);
  }

  /** Get all policies for a given role, in registration order. */
  private forRole(role: AgentRole): TurnPolicy[] {
    return this.policies.filter((p) => p.role === role);
  }

  /**
   * Evaluate all beforeModelCall hooks for a role.
   * First non-null result wins (short-circuit).
   */
  async evaluateBeforeModel(
    messages: readonly ChatMessage[],
    ctx: TurnContext,
  ): Promise<BeforeModelResult> {
    for (const policy of this.forRole(ctx.role)) {
      if (!policy.beforeModelCall) continue;
      for (const hook of policy.beforeModelCall) {
        const result = await hook(messages, ctx);
        if (result) return result;
      }
    }
    return null;
  }

  /**
   * Evaluate all afterModelCall hooks for a role.
   * First non-null result wins.
   */
  async evaluateAfterModel(
    response: string,
    messages: readonly ChatMessage[],
    ctx: TurnContext,
  ): Promise<AfterModelResult> {
    for (const policy of this.forRole(ctx.role)) {
      if (!policy.afterModelCall) continue;
      for (const hook of policy.afterModelCall) {
        const result = await hook(response, messages, ctx);
        if (result) return result;
      }
    }
    return null;
  }

  /**
   * Evaluate all beforeToolExec hooks for a role.
   * First deny wins.
   */
  async evaluateBeforeTool(
    toolName: string,
    args: Record<string, unknown>,
    ctx: TurnContext,
  ): Promise<BeforeToolResult> {
    for (const policy of this.forRole(ctx.role)) {
      if (!policy.beforeToolExec) continue;
      for (const hook of policy.beforeToolExec) {
        const result = await hook(toolName, args, ctx);
        if (result) return result;
      }
    }
    return null;
  }

  /**
   * Evaluate all afterToolExec hooks for a role.
   * First non-null result wins.
   */
  async evaluateAfterTool(
    toolName: string,
    args: Record<string, unknown>,
    resultText: string,
    hasError: boolean,
    ctx: TurnContext,
  ): Promise<AfterToolResult> {
    for (const policy of this.forRole(ctx.role)) {
      if (!policy.afterToolExec) continue;
      for (const hook of policy.afterToolExec) {
        const result = await hook(toolName, args, resultText, hasError, ctx);
        if (result) return result;
      }
    }
    return null;
  }

  /**
   * Bridge: convert beforeToolExec hooks into a ToolHookRegistry that the
   * existing tool-dispatch.ts can consume. This lets roles migrate gradually
   * from raw ToolHookRegistry to TurnPolicy without a big-bang refactor.
   *
   * Uses ctx.role to scope policy lookup — the role is always derived from
   * the TurnContext to avoid mismatches.
   *
   * Limitation: afterToolExec policies are not bridged here because
   * PostToolUseResult cannot express 'inject' or 'halt' actions. Those
   * must be evaluated directly via evaluateAfterTool() in the agent loop.
   */
  toToolHookRegistry(ctx: TurnContext): ToolHookRegistry {
    const policies = this.forRole(ctx.role);
    const hasBeforeTool = policies.some((p) => p.beforeToolExec?.length);

    return {
      pre: hasBeforeTool
        ? [
            {
              matcher: /.*/,
              hook: async (
                toolName: string,
                args: Record<string, unknown>,
              ) => {
                const result = await this.evaluateBeforeTool(toolName, args, ctx);
                if (result?.action === 'deny') {
                  return { decision: 'deny' as const, reason: result.reason };
                }
                return { decision: 'passthrough' as const };
              },
            },
          ]
        : [],
      post: [],
    };
  }
}

// ---------------------------------------------------------------------------
// Factory — build a registry with all role policies pre-registered
// ---------------------------------------------------------------------------

import { createExplorerPolicy } from './turn-policies/explorer-policy';
import { createCoderPolicy } from './turn-policies/coder-policy';
import { createOrchestratorPolicy } from './turn-policies/orchestrator-policy';

/**
 * Create a fully-loaded TurnPolicyRegistry with all role policies.
 * Call once per agent session. For stateful policies (Coder), call
 * resetCoderPolicy() at each delegation boundary to isolate state.
 */
export function createTurnPolicyRegistry(): TurnPolicyRegistry {
  const registry = new TurnPolicyRegistry();
  registry.register(createExplorerPolicy());
  registry.register(createCoderPolicy());
  registry.register(createOrchestratorPolicy());
  // Auditor and Reviewer are single-shot (no multi-turn loop to guard),
  // so they don't need turn policies — their invariants are structural.
  return registry;
}

/**
 * Replace the Coder policy in an existing registry with a fresh instance.
 * Call at the start of each delegate_coder task to prevent drift/failure
 * state from leaking across delegations within the same session.
 */
export function resetCoderPolicy(registry: TurnPolicyRegistry): void {
  registry.deregister('coder');
  registry.register(createCoderPolicy());
}
