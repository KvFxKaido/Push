import { isValidElement, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { MultiStepLoader, type MultiStepLoaderStep } from './multi-step-loader';
import { deriveStepStatus } from './multi-step-loader-status';

const STEPS: readonly MultiStepLoaderStep[] = [
  { key: 'a', label: 'Alpha', doneLabel: 'Alpha done' },
  { key: 'b', label: 'Beta' },
  { key: 'c', label: 'Gamma' },
];

function textContent(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textContent).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textContent(node.props.children);
  return '';
}

describe('deriveStepStatus', () => {
  it('marks prior steps done, current active, later pending while running', () => {
    expect(deriveStepStatus(0, 1, 'running')).toBe('done');
    expect(deriveStepStatus(1, 1, 'running')).toBe('active');
    expect(deriveStepStatus(2, 1, 'running')).toBe('pending');
  });

  it('marks every step done on success regardless of currentStep', () => {
    expect(deriveStepStatus(0, 0, 'success')).toBe('done');
    expect(deriveStepStatus(2, 0, 'success')).toBe('done');
  });

  it('flags the failed step on error and leaves later steps pending', () => {
    expect(deriveStepStatus(0, 2, 'error')).toBe('done');
    expect(deriveStepStatus(2, 2, 'error')).toBe('error');
    // A step skipped before the failure still reads as done (jumped past).
    expect(deriveStepStatus(1, 2, 'error')).toBe('done');
  });
});

describe('MultiStepLoader', () => {
  it('uses doneLabel for completed steps and the running label otherwise', () => {
    const running = MultiStepLoader({ steps: STEPS, currentStep: 1, state: 'running' });
    const text = textContent(running);
    expect(text).toContain('Alpha done'); // step 0 is done
    expect(text).toContain('Beta'); // step 1 is active
    expect(text).toContain('Gamma'); // step 2 pending
  });

  it('renders the error message only in the error state', () => {
    const ok = MultiStepLoader({ steps: STEPS, currentStep: 3, state: 'success' });
    expect(textContent(ok)).not.toContain('boom');

    const failed = MultiStepLoader({
      steps: STEPS,
      currentStep: 1,
      state: 'error',
      errorMessage: 'boom',
    });
    expect(textContent(failed)).toContain('boom');
  });
});
