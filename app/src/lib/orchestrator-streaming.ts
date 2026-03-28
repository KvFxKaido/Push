import { extractProviderErrorDetail } from './provider-error-utils';
import { asRecord } from './utils';

// ---------------------------------------------------------------------------
// Types shared across orchestrator modules
// ---------------------------------------------------------------------------

export interface StreamUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ChunkMetadata {
  chunkIndex: number;
}

export interface StreamProviderConfig {
  name: string;
  apiUrl: string;
  apiKey: string;
  authHeader?: string | null;
  model: string;
  connectTimeoutMs: number;
  idleTimeoutMs: number;
  stallTimeoutMs?: number;
  totalTimeoutMs?: number;
  errorMessages: {
    keyMissing: string;
    connect: (seconds: number) => string;
    idle: (seconds: number) => string;
    stall?: (seconds: number) => string;
    total?: (seconds: number) => string;
    network: string;
  };
  parseError: (parsed: unknown, fallback: string) => string;
  checkFinishReason: (choice: unknown) => boolean;
  shouldResetStallOnReasoning?: boolean;
  /** Provider identity — used to conditionally inject provider-specific tool protocols */
  providerType?: 'ollama' | 'openrouter' | 'zen' | 'nvidia' | 'blackbox' | 'kilocode' | 'openadapter' | 'azure' | 'bedrock' | 'vertex';
  /** Override the fetch URL (e.g., for providers with alternate endpoints) */
  apiUrlOverride?: string;
  /** Transform the request body before sending (e.g., swap model for agent_id) */
  bodyTransform?: (body: Record<string, unknown>) => Record<string, unknown>;
  /** Extra headers required by proxy adapters. */
  extraHeaders?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Shared helper functions
// ---------------------------------------------------------------------------

export function parseProviderError(parsed: unknown, fallback: string, includeTopLevelMessage = false): string {
  return extractProviderErrorDetail(parsed, fallback, includeTopLevelMessage);
}

export function hasFinishReason(choice: unknown, reasons: string[]): boolean {
  const record = asRecord(choice);
  const finishReason = record?.finish_reason;
  return typeof finishReason === 'string' && reasons.includes(finishReason);
}
