import type { DelegationEnvelope, ExplorerDelegationEnvelope } from '@/types';
import { buildDelegationBrief as buildSharedDelegationBrief } from '@push/lib/delegation-brief';
export {
  buildAuditorContextBlock,
  buildRequestIntentHint,
  buildReviewerContextBlock,
  type AuditorPromptContext,
  type AuditorPromptSource,
  type ReviewerPromptContext,
  type ReviewerPromptSource,
  type RolePromptContextBase,
} from '@push/lib/role-context';

export function buildCoderDelegationBrief(envelope: DelegationEnvelope): string {
  return buildSharedDelegationBrief({
    task: envelope.task,
    intent: envelope.intent,
    deliverable: envelope.deliverable,
    knownContext: envelope.knownContext,
    constraints: envelope.constraints,
    files: envelope.files,
    acceptanceCriteria: envelope.acceptanceCriteria,
    userGoal: envelope.userGoal,
    addresses: envelope.addresses,
    targetRole: 'coder',
  });
}

export function buildExplorerDelegationBrief(envelope: ExplorerDelegationEnvelope): string {
  return buildSharedDelegationBrief({
    task: envelope.task,
    intent: envelope.intent,
    deliverable: envelope.deliverable,
    knownContext: envelope.knownContext,
    constraints: envelope.constraints,
    files: envelope.files,
    userGoal: envelope.userGoal,
    addresses: envelope.addresses,
    targetRole: 'explorer',
  });
}
