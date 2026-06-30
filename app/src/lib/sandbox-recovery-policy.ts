import { isReadOnlyToolCall, type AnyToolCall } from '@/lib/tool-dispatch';

export type SandboxUnreachableRecoveryPolicy =
  | {
      action: 'safe-read-retry';
      toolName: string;
      toolSource: AnyToolCall['source'];
      reason: 'read_only_tool';
    }
  | {
      action: 'recover-inspect';
      toolName: string;
      toolSource: AnyToolCall['source'];
      reason: 'mutation_may_have_dispatched';
    };

export function classifySandboxUnreachableRecovery(
  call: AnyToolCall,
): SandboxUnreachableRecoveryPolicy {
  const toolName = call.call.tool;
  const toolSource = call.source;
  if (isReadOnlyToolCall(call)) {
    return {
      action: 'safe-read-retry',
      toolName,
      toolSource,
      reason: 'read_only_tool',
    };
  }
  return {
    action: 'recover-inspect',
    toolName,
    toolSource,
    reason: 'mutation_may_have_dispatched',
  };
}
