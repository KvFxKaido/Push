import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SandboxCardData } from '@/types';
import { SandboxCard } from './SandboxCard';

function baseData(overrides: Partial<SandboxCardData> = {}): SandboxCardData {
  return {
    command: 'npm run build',
    stdout: '',
    stderr: '',
    exitCode: 0,
    truncated: false,
    ...overrides,
  };
}

describe('SandboxCard', () => {
  it('renders the command and a success badge when exitCode is 0', () => {
    const html = renderToStaticMarkup(
      <SandboxCard data={baseData({ command: 'npm test', exitCode: 0, durationMs: 420 })} />,
    );

    expect(html).toContain('npm test');
    expect(html).toContain('420ms');
    // Success badge renders "0" next to CheckCircle2 icon.
    expect(html).toContain('>0<');
  });

  it('shows the error exit code badge for a non-zero exit', () => {
    const html = renderToStaticMarkup(
      <SandboxCard
        data={baseData({
          command: 'npm test',
          stderr: 'boom',
          exitCode: 2,
          durationMs: 2500,
        })}
      />,
    );

    expect(html).toContain('>2<');
    // Duration formatted with one decimal place when >= 1000ms.
    expect(html).toContain('2.5s');
    // Failure case auto-expands so stderr is rendered.
    expect(html).toContain('boom');
  });

  it('renders stdout and a truncation notice when truncated', () => {
    const html = renderToStaticMarkup(
      <SandboxCard
        data={baseData({
          stdout: 'hello from the sandbox',
          exitCode: 1,
          truncated: true,
        })}
      />,
    );

    expect(html).toContain('hello from the sandbox');
    expect(html).toContain('Output truncated');
  });

  it('shows a "No output" placeholder when there is no stdout or stderr', () => {
    const html = renderToStaticMarkup(<SandboxCard data={baseData({ exitCode: 1 })} />);

    expect(html).toContain('No output');
  });

  it('does not render a duration when durationMs is undefined', () => {
    const html = renderToStaticMarkup(<SandboxCard data={baseData()} />);

    expect(html).not.toMatch(/\dms<|\ds</);
  });
});
