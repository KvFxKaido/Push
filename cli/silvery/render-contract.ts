import { displayWidth, stripAnsi } from 'silvery';

export interface TranscriptRenderSnapshot {
  ansi: string;
  contentHeight: number;
}

export interface TranscriptRenderContractInput {
  rowId: string;
  rowKind: string;
  width: number;
  measuredHeight: number;
  rendered: TranscriptRenderSnapshot;
}

export interface TranscriptRenderViolation {
  invariant: 'line_width' | 'measured_height';
  rowId: string;
  rowKind: string;
  lineIndex: number | null;
  expected: number;
  actual: number;
}

interface RenderAssertionEnvironment {
  PUSH_TUI_ASSERT?: string;
  NODE_TEST_CONTEXT?: string;
}

export function tuiRenderAssertionsEnabled(env: RenderAssertionEnvironment = process.env): boolean {
  return env.PUSH_TUI_ASSERT === '1';
}

export function tuiRenderAssertionsThrow(env: RenderAssertionEnvironment = process.env): boolean {
  return Boolean(env.NODE_TEST_CONTEXT);
}

/** Preserve content-area blank rows while ignoring renderString's spare buffer. */
export function transcriptRenderLines(rendered: TranscriptRenderSnapshot): string[] {
  if (rendered.contentHeight <= 0) return [];
  const lines = rendered.ansi.split('\n');
  while (lines.length < rendered.contentHeight) lines.push('');
  return lines.slice(0, rendered.contentHeight);
}

export function inspectTranscriptRenderContract(
  input: TranscriptRenderContractInput,
): TranscriptRenderViolation[] {
  const lines = transcriptRenderLines(input.rendered);
  const violations: TranscriptRenderViolation[] = [];
  lines.forEach((line, lineIndex) => {
    const actual = displayWidth(stripAnsi(line));
    if (actual > input.width) {
      violations.push({
        invariant: 'line_width',
        rowId: input.rowId,
        rowKind: input.rowKind,
        lineIndex,
        expected: input.width,
        actual,
      });
    }
  });
  if (input.measuredHeight !== lines.length) {
    violations.push({
      invariant: 'measured_height',
      rowId: input.rowId,
      rowKind: input.rowKind,
      lineIndex: null,
      expected: lines.length,
      actual: input.measuredHeight,
    });
  }
  return violations;
}

export function assertTranscriptRenderContract(
  input: TranscriptRenderContractInput,
  options: {
    enabled?: boolean;
    throwOnFailure?: boolean;
    writeDiagnostic?: (diagnostic: string) => void;
  } = {},
): TranscriptRenderViolation[] {
  const enabled = options.enabled ?? tuiRenderAssertionsEnabled();
  if (!enabled) return [];

  const violations = inspectTranscriptRenderContract(input);
  const writeDiagnostic =
    options.writeDiagnostic ?? ((diagnostic: string) => console.error(diagnostic));
  for (const violation of violations) {
    writeDiagnostic(
      JSON.stringify({
        level: 'error',
        event: 'tui_render_contract_violation',
        rowId: violation.rowId,
        rowKind: violation.rowKind,
        invariant: violation.invariant,
        lineIndex: violation.lineIndex,
        expected: violation.expected,
        actual: violation.actual,
      }),
    );
  }

  if (violations.length > 0 && (options.throwOnFailure ?? tuiRenderAssertionsThrow())) {
    const first = violations[0];
    throw new Error(
      `TUI render contract failed for ${first.rowKind} row ${first.rowId}: ` +
        `${first.invariant} expected ${first.expected}, got ${first.actual}`,
    );
  }
  return violations;
}
