/**
 * Default web-side `PreToolUse` hook registry — the per-surface wiring
 * for the lib factories in `lib/default-pre-hooks.ts`.
 *
 * Hooks here apply to every tool call dispatched through
 * `WebToolExecutionRuntime`, regardless of whether the caller passed
 * their own `ToolHookRegistry`. Caller-supplied registries layer on top
 * (see `WebToolExecutionRuntime.execute`).
 */

import { createGitGuardPreHook, createProtectMainPreHook } from '@push/lib/default-pre-hooks';
import { createToolHookRegistry, type ToolHookRegistry } from '@push/lib/tool-hooks';
import { getApprovalMode } from './approval-mode';

let cached: ToolHookRegistry | null = null;

/**
 * Lazy-built singleton registry holding Push's default web pre-hooks.
 * Built once per page load — hooks read live state via injected
 * providers (e.g. `getApprovalMode` reads safeStorage at call time),
 * so the registry doesn't need to be rebuilt when settings change.
 */
export function getDefaultWebHookRegistry(): ToolHookRegistry {
  if (cached) return cached;
  const registry = createToolHookRegistry();
  registry.pre.push(createGitGuardPreHook({ modeProvider: getApprovalMode }));
  registry.pre.push(createProtectMainPreHook());
  cached = registry;
  return registry;
}

/**
 * Test-only: drop the cached registry so the next call rebuilds it.
 * Production code never invalidates the cache — providers read state
 * at evaluation time, not at registry-build time.
 */
export function resetDefaultWebHookRegistryForTests(): void {
  cached = null;
}
