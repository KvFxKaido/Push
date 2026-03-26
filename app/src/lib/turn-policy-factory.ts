/**
 * Turn Policy Factory — convenience constructors for the policy registry.
 *
 * Separated from turn-policy.ts to avoid circular imports:
 * explorer-policy.ts → explorer-agent.ts → tool-dispatch.ts would create
 * a cycle if imported at module level from turn-policy.ts.
 */

import { TurnPolicyRegistry } from './turn-policy';
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
