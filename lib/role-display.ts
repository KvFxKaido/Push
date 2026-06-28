/**
 * Role display seam — the single source of truth for *user-facing* role
 * vocabulary.
 *
 * Push's runtime is organized as an org chart of agent roles (Orchestrator,
 * Explorer, Coder, Reviewer, Auditor — see `AgentRole` in
 * `runtime-contract.ts`). That structure is correct for the runtime, but
 * humans don't want to read an org chart: they want to know what *phase* the
 * work is in. This module maps each internal role to the phrasing the UI and
 * CLI should show.
 *
 * Layering (see `docs/decisions/Role Display De-emphasis.md`):
 *   1. Runtime role          — `AgentRole`, routing, capability tables. Stable.
 *   2. Event/log attribution — raw role fields in events/logs. Untouched.
 *   3. Display vocabulary     — THIS FILE. Internal role → human phrasing.
 *   4. Presentation           — UI/CLI render phases first, names only for trust.
 *
 * Nothing here changes a runtime contract. It only decides what a human reads.
 * Background-coder display is a *presentation context*, not a new role — it is
 * reached via `getRoleDisplay('coder', { background: true })`, never by adding
 * a role.
 */

import type { AgentRole, RunEventSubagent } from './runtime-contract.js';

/**
 * Presentation context that can shade how a role is displayed without being a
 * distinct runtime role. Today the only axis is whether the Coder is running
 * as a background job, where the UI historically needed a standalone label.
 */
export type RoleDisplayContext = {
  background?: boolean;
};

export type RoleDisplay = {
  /** Workflow phase shown to humans (`'Exploring'`, `'Editing'`, …). `null`
   *  for roles that have no user-visible phase (the Orchestrator is just "the
   *  assistant" from the user's point of view). */
  phase: string | null;
  /** Named actor to surface when attribution improves trust. `null` when the
   *  role should read as a phase, not a named agent. */
  name: string | null;
  /** Whether the UI should foreground `name` instead of `phase`. */
  showActorName: boolean;
};

/**
 * The canonical user-facing vocabulary, keyed by internal `AgentRole`.
 *
 * Phase-first by default. Reviewer and Auditor keep a visible name because
 * their attribution is a trust signal — a user wants to know that an
 * independent gate, not the same agent that wrote the code, reviewed or
 * verified it. Explorer and Coder read as phases. The Orchestrator is the
 * conversational lead and has no phase the user needs to see.
 */
export const ROLE_DISPLAY: Readonly<Record<AgentRole, RoleDisplay>> = {
  orchestrator: { phase: null, name: null, showActorName: false },
  explorer: { phase: 'Exploring', name: null, showActorName: false },
  coder: { phase: 'Editing', name: null, showActorName: false },
  reviewer: { phase: 'Reviewing', name: 'Reviewer', showActorName: true },
  auditor: { phase: 'Verifying', name: 'Auditor', showActorName: true },
};

/**
 * Fallback for roles with no display entry (an unknown or missing role). Per
 * the de-emphasis rules we use neutral *phase* language — never an invented
 * actor name.
 */
const NEUTRAL_DISPLAY: RoleDisplay = { phase: 'Working', name: null, showActorName: false };

/**
 * The user-facing phase shown while a model is streaming on its reasoning
 * channel (native `reasoning_content` deltas or an inline `<think>` block).
 *
 * Reasoning is a *phase*, not a role — like `planner`/`task_graph` in
 * `getSubagentDisplay`, it has no `AgentRole` of its own and so isn't in
 * `ROLE_DISPLAY`. It's surfaced through this seam so the live status bar reads
 * the canonical word instead of hand-spelling "Reasoning..." at the call site
 * (the rule this file exists to enforce). Phase-first, no named actor: the user
 * doesn't need to know *which* agent is thinking, only that thinking is
 * happening.
 */
export const REASONING_PHASE_DISPLAY: RoleDisplay = {
  phase: 'Thinking',
  name: null,
  showActorName: false,
};

/**
 * Resolve the user-facing display for the reasoning phase. A function (not just
 * the const) so call sites match the `getRoleDisplay` / `getSubagentDisplay`
 * shape and a future context axis can be threaded without churn.
 */
export function getReasoningPhaseDisplay(): RoleDisplay {
  return REASONING_PHASE_DISPLAY;
}

function isAgentRole(value: unknown): value is AgentRole {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ROLE_DISPLAY, value);
}

/**
 * Resolve the user-facing display for an internal role.
 *
 * Defensive on input: an unknown/missing role falls back to neutral phase
 * language (`'Working'`), so a stale or out-of-band role string can never
 * surface a raw internal identifier to the user.
 *
 * Background context: a background Coder may carry actor attribution where the
 * UI previously needed a standalone label. The "Background Coder" label lives
 * here — it must not be re-spelled at call sites.
 */
export function getRoleDisplay(
  role: AgentRole | string | null | undefined,
  options?: RoleDisplayContext,
): RoleDisplay {
  const base = isAgentRole(role) ? ROLE_DISPLAY[role] : NEUTRAL_DISPLAY;
  if (options?.background && role === 'coder') {
    return { phase: base.phase, name: 'Background Coder', showActorName: true };
  }
  return base;
}

/**
 * A non-null user-facing label for a role: its trust-name when it has one,
 * else its phase, else neutral `'Working'`.
 *
 * Use this anywhere a label is interpolated directly into UI text. Reaching for
 * `.name` at a call site is a footgun — it is `string | null`, so a future
 * vocabulary change that nulls a name would silently render an empty label
 * (`": passed"`, `" commit gate"`). This always resolves to a string while
 * staying seam-sourced. Accepts the same background context as `getRoleDisplay`.
 */
export function getRoleLabel(
  role: AgentRole | string | null | undefined,
  options?: RoleDisplayContext,
): string {
  const d = getRoleDisplay(role, options);
  return d.name ?? d.phase ?? 'Working';
}

/**
 * Console/log *source attribution* label. A source view names the emitter, so
 * its needs differ from phase-first chrome: the Orchestrator reads as the
 * "Assistant" (the user's mental model of the main loop — see the design doc),
 * not a phase; `system` stays "System"; every other source resolves via
 * `getRoleLabel`. Keeps the console's source vocabulary inside the seam.
 */
export function getSourceLabel(
  source: AgentRole | 'system' | string,
  _prefix: string,
): string {
  if (source === 'system') return 'System';
  if (source === 'orchestrator') return 'Assistant';
  return getRoleLabel(source);
}

/**
 * Resolve the display for a `RunEventSubagent` — a superset of `AgentRole`
 * used in run-event streams (it also carries `planner`, `deep_reviewer`, and
 * the structural `task_graph`). Keeps the subagent → vocabulary mapping in the
 * seam so console/transcript views never spell role labels directly.
 */
export function getSubagentDisplay(
  subagent: RunEventSubagent | string | null | undefined,
): RoleDisplay {
  switch (subagent) {
    case 'planner':
      // Planner is a Coder sub-seam, not an `AgentRole`. Read it as a phase.
      return { phase: 'Planning', name: null, showActorName: false };
    case 'deep_reviewer':
      // Runs under the reviewer role; same trust-bearing name.
      return ROLE_DISPLAY.reviewer;
    case 'task_graph':
      // A workflow construct, not an agent identity. "Task Graph" is the
      // construct's own name, not an org-chart role label.
      return { phase: null, name: 'Task Graph', showActorName: true };
    case 'coder':
    case 'explorer':
    case 'reviewer':
    case 'auditor':
      return getRoleDisplay(subagent);
    default:
      return NEUTRAL_DISPLAY;
  }
}

/**
 * Single user-facing label for a subagent lifecycle line. Phase-first; named
 * actors (Reviewer/Auditor) keep their name; unknown → neutral `'Working'`.
 * This is the only place a subagent label string is composed.
 */
export function getSubagentLabel(subagent: RunEventSubagent | string | null | undefined): string {
  const d = getSubagentDisplay(subagent);
  if (d.showActorName && d.name) return d.name;
  return d.phase ?? 'Working';
}
