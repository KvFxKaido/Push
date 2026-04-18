/**
 * Shared postcondition formatters for the mutation-family handlers
 * (sandbox_edit_file, sandbox_write_file, sandbox_apply_patchset).
 *
 * These used to be module-private helpers inside `sandbox-tools.ts`. Pulling
 * them into a neutral module lets the extracted edit-handler and write-handler
 * modules both import them without pulling in the dispatcher, preserving the
 * one-way extraction boundary.
 */

import type { ToolMutationDiagnostic, ToolMutationPostconditions, ToolMutationSpan } from '@/types';
import type { HashlineOp } from './hashline';

const POSTCONDITION_OUTPUT_LIMIT = 1200;
const SUPPORTED_PER_EDIT_DIAGNOSTIC_EXT_RE = /\.(ts|tsx|js|jsx|py)$/i;
const SUPPORTED_PATCHSET_DIAGNOSTIC_EXT_RE = /\.(ts|tsx)$/i;

export function buildLineRanges(
  lineNumbers: readonly number[],
): Array<{ startLine: number; endLine: number }> {
  const sorted = [
    ...new Set(lineNumbers.filter((lineNo) => Number.isFinite(lineNo) && lineNo > 0)),
  ].sort((a, b) => a - b);
  if (sorted.length === 0) return [];

  const ranges: Array<{ startLine: number; endLine: number }> = [];
  let startLine = sorted[0];
  let endLine = sorted[0];

  for (let i = 1; i < sorted.length; i += 1) {
    const lineNo = sorted[i];
    if (lineNo === endLine + 1) {
      endLine = lineNo;
      continue;
    }
    ranges.push({ startLine, endLine });
    startLine = lineNo;
    endLine = lineNo;
  }

  ranges.push({ startLine, endLine });
  return ranges;
}

export function buildHashlineChangedSpans(
  ops: readonly HashlineOp[],
  resolvedLines: readonly number[],
): ToolMutationSpan[] {
  const refs = [...new Set(ops.map((op) => op.ref))];
  const opNames = [...new Set(ops.map((op) => op.op))];
  const ranges = buildLineRanges(resolvedLines);

  if (ranges.length === 0) {
    return [{ kind: 'hashline', refs, ops: opNames }];
  }

  return ranges.map(({ startLine, endLine }) => ({
    kind: 'hashline',
    startLine,
    endLine,
    lineNumbers: resolvedLines.filter((lineNo) => lineNo >= startLine && lineNo <= endLine),
    refs,
    ops: opNames,
  }));
}

export function buildPerEditDiagnosticSummary(
  filePath: string,
  output: string | null,
): ToolMutationDiagnostic {
  return {
    scope: 'single-file',
    label: 'syntax check',
    path: filePath,
    status: output
      ? 'issues'
      : SUPPORTED_PER_EDIT_DIAGNOSTIC_EXT_RE.test(filePath)
        ? 'clean'
        : 'skipped',
    ...(output ? { output } : {}),
  };
}

export function buildPatchsetDiagnosticSummary(
  changedFiles: readonly string[],
  enabled: boolean,
  output: string | null,
): ToolMutationDiagnostic {
  const hasSupportedFile = changedFiles.some((filePath) =>
    SUPPORTED_PATCHSET_DIAGNOSTIC_EXT_RE.test(filePath),
  );
  return {
    scope: 'project',
    label: 'project typecheck',
    status: !enabled ? 'skipped' : output ? 'issues' : hasSupportedFile ? 'clean' : 'skipped',
    ...(output ? { output } : {}),
  };
}

function truncatePostconditionOutput(output?: string): string | undefined {
  const trimmed = output?.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= POSTCONDITION_OUTPUT_LIMIT) return trimmed;
  return `${trimmed.slice(0, POSTCONDITION_OUTPUT_LIMIT)}\n[truncated]`;
}

function formatVersionTransition(before?: string | null, after?: string | null): string | null {
  if (!before && !after) return null;
  return `${before ?? 'unknown'}→${after ?? 'unknown'}`;
}

function summarizeChangedSpans(spans?: readonly ToolMutationSpan[]): string | null {
  if (!spans || spans.length === 0) return null;
  const lineNumbers = new Set<number>();
  for (const span of spans) {
    if (typeof span.startLine === 'number' && typeof span.endLine === 'number') {
      for (let line = span.startLine; line <= span.endLine; line += 1) lineNumbers.add(line);
      continue;
    }
    for (const line of span.lineNumbers ?? []) lineNumbers.add(line);
  }
  if (lineNumbers.size === 0) return `${spans.length} span${spans.length === 1 ? '' : 's'}`;
  const ordered = [...lineNumbers].sort((a, b) => a - b);
  const ranges = buildLineRanges(ordered).map(({ startLine, endLine }) =>
    startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`,
  );
  return `lines ${ranges.join(', ')}`;
}

export function appendMutationPostconditions(
  lines: string[],
  postconditions?: ToolMutationPostconditions,
): void {
  if (!postconditions || postconditions.touchedFiles.length === 0) return;

  lines.push('', '[POSTCONDITIONS]');

  const touchedFiles = postconditions.touchedFiles.slice(0, 6);
  lines.push(`touched files: ${postconditions.touchedFiles.length}`);
  for (const touched of touchedFiles) {
    const details = [
      summarizeChangedSpans(touched.changedSpans),
      touched.bytesWritten !== undefined ? `${touched.bytesWritten}B` : null,
      formatVersionTransition(touched.versionBefore, touched.versionAfter),
    ].filter(Boolean);
    lines.push(
      `- ${touched.mutation} ${touched.path}${details.length > 0 ? ` (${details.join(' · ')})` : ''}`,
    );
  }
  if (postconditions.touchedFiles.length > touchedFiles.length) {
    lines.push(
      `- …and ${postconditions.touchedFiles.length - touchedFiles.length} more touched file(s)`,
    );
  }

  if (postconditions.diagnostics?.length) {
    lines.push(`diagnostics: ${postconditions.diagnostics.length}`);
    for (const diagnostic of postconditions.diagnostics.slice(0, 4)) {
      const target = diagnostic.path ? ` ${diagnostic.path}` : '';
      lines.push(`- ${diagnostic.label}: ${diagnostic.status}${target}`);
      const output =
        diagnostic.status === 'issues' ? truncatePostconditionOutput(diagnostic.output) : undefined;
      if (output) {
        lines.push(output);
      }
    }
    if (postconditions.diagnostics.length > 4) {
      lines.push(`- …and ${postconditions.diagnostics.length - 4} more diagnostic result(s)`);
    }
  }

  if (postconditions.checks?.length) {
    lines.push(`checks: ${postconditions.checks.length}`);
    for (const check of postconditions.checks.slice(0, 4)) {
      lines.push(
        `- ${check.passed ? 'passed' : 'failed'} exit=${check.exitCode}: ${check.command}`,
      );
      const output = check.passed ? undefined : truncatePostconditionOutput(check.output);
      if (output) {
        lines.push(output);
      }
    }
    if (postconditions.checks.length > 4) {
      lines.push(`- …and ${postconditions.checks.length - 4} more check result(s)`);
    }
  }

  if (postconditions.guardWarnings?.length) {
    lines.push(`guard warnings: ${postconditions.guardWarnings.length}`);
    for (const warning of postconditions.guardWarnings.slice(0, 3)) {
      lines.push(`- ${warning}`);
    }
    if (postconditions.guardWarnings.length > 3) {
      lines.push(`- …and ${postconditions.guardWarnings.length - 3} more guard warning(s)`);
    }
  }

  if (typeof postconditions.writeVerified === 'boolean') {
    lines.push(`write verified: ${postconditions.writeVerified ? 'yes' : 'no'}`);
  }
  if (postconditions.rollbackApplied) {
    lines.push('rollback applied: yes');
  }

  lines.push('[/POSTCONDITIONS]');
}
