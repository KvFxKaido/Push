export interface ToolExecutionStartEvent {
  toolName: string;
  source: string;
  toolCallId: string;
}

export interface ToolExecutionCompleteEvent {
  toolName: string;
  durationMs: number;
  error?: unknown; // StructuredToolError
}

export interface ToolCallMalformedEvent {
  diagnosis: unknown; // ToolCallDiagnosis
}

export interface ToolEventEmitter {
  toolExecutionStart(event: ToolExecutionStartEvent): void;
  toolExecutionComplete(event: ToolExecutionCompleteEvent): void;
  toolCallMalformed(event: ToolCallMalformedEvent): void;
}

export type ApprovalCallback = (
  toolName: string,
  reason: string,
  recoveryPath: string,
) => Promise<boolean>;

export interface AnyToolCall {
  source: string;
  [key: string]: unknown;
}

export interface ToolExecutionResult {
  text: string;
  isError?: boolean;
  [key: string]: unknown;
}

export interface ToolExecutionContext {
  allowedRepo: string;
  sandboxId: string | null;
  isMainProtected: boolean;
  defaultBranch?: string;
  activeProvider: unknown; // ActiveProvider
  activeModel?: string;
  hooks: unknown; // ToolHookRegistry
  approvalGates: unknown; // ApprovalGateRegistry
  capabilityLedger?: unknown; // CapabilityLedger
  approvalCallback?: ApprovalCallback;
  emit?: ToolEventEmitter;
}

export interface ToolExecutionRuntime {
  execute(toolCall: AnyToolCall, context: ToolExecutionContext): Promise<ToolExecutionResult>;
  getSandboxBranch(sandboxId: string): Promise<string | null>;
}
