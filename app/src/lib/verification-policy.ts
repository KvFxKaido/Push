/**
 * App compatibility wrapper for the shared verification policy helpers.
 *
 * The canonical module now lives in `lib/verification-policy.ts`. Keep this
 * file as the app-local import surface so existing Web call sites using
 * `@/lib/verification-policy` do not need to churn during the extraction.
 */

export {
  VERIFICATION_PRESET_MINIMAL,
  VERIFICATION_PRESET_STANDARD,
  VERIFICATION_PRESET_STRICT,
  VERIFICATION_PRESETS,
  cloneVerificationPolicy,
  extractCommandRules,
  formatVerificationPolicyBlock,
  getDefaultVerificationPolicy,
  getVerificationPreset,
  getVerificationPresetNames,
  policyRequiresGate,
  resolveVerificationPolicy,
} from '@push/lib/verification-policy';

export type { VerificationPolicy, VerificationRule } from '@push/lib/verification-policy';
