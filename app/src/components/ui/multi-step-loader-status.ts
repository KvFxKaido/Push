export type MultiStepLoaderState = 'running' | 'success' | 'error';

export type StepStatus = 'done' | 'active' | 'error' | 'pending';

/**
 * Pure status derivation for {@link MultiStepLoader}, in its own module so the
 * component file only exports components (react-refresh) and the logic stays
 * unit-testable without rendering. Prior steps are done, the current step
 * reflects the overall state, later steps are pending. On success every step is
 * done regardless of `currentStep`.
 */
export function deriveStepStatus(
  index: number,
  currentStep: number,
  state: MultiStepLoaderState,
): StepStatus {
  if (state === 'success') return 'done';
  if (index < currentStep) return 'done';
  if (index > currentStep) return 'pending';
  return state === 'error' ? 'error' : 'active';
}
