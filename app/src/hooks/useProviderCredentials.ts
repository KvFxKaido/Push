/**
 * useProviderCredentials — React view of the provider capability snapshot
 * (`lib/provider-engine-capability.ts`): per-provider engine capability,
 * credential provenance (gateway BYOK / Workers AI binding / Worker secret /
 * user key), and whether the AI Gateway is active.
 *
 * Reading subscribes the component to snapshot changes and kicks the module's
 * own staleness-gated background refresh — no polling here.
 */

import { useSyncExternalStore } from 'react';
import {
  getProviderCapabilitySnapshot,
  subscribeProviderCapabilities,
  type ProviderCapabilitySnapshot,
} from '../lib/provider-engine-capability';

export type { ProviderCapabilitySnapshot };

export function useProviderCredentials(): ProviderCapabilitySnapshot {
  return useSyncExternalStore(
    subscribeProviderCapabilities,
    getProviderCapabilitySnapshot,
    getProviderCapabilitySnapshot,
  );
}
