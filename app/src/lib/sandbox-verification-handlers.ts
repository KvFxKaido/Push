/**
 * Sandbox verification tool handlers.
 *
 * Step 4 of the Architecture Remediation Plan — the first extraction out
 * of the 4,112-line `sandbox-tools.ts` dispatcher. This module owns the
 * three verification-family tools:
 *
 *   - `sandbox_run_tests`       → {@link handleRunTests}
 *   - `sandbox_check_types`     → {@link handleCheckTypes}
 *   - `sandbox_verify_workspace` → {@link handleVerifyWorkspace}
 *
 * ## Design
 *
 * The handlers accept a {@link VerificationHandlerContext} carrying the
 * sandboxId and four injected infrastructure functions. They return a
 * `ToolExecutionResult` identical in shape to what the inline `case`
 * arms in the dispatcher used to return. Behavior is preserved byte for
 * byte — the step-2 characterization tests
 * (`sandbox-tools-verification.test.ts`) are the regression gate.
 *
 * ## Fitness rules (from the remediation plan)
 *
 *   - **Boundary:** this module imports no React hooks, no orchestrator,
 *     no dispatcher (`sandbox-tools.ts`), and no sibling tool handlers.
 *     All sandbox/platform functions enter through the handler context.
 *   - **API:** the dispatcher's `executeSandboxToolCall` remains the
 *     public entry point. This module exports the three handler
 *     functions plus the `VerificationHandlerContext` and
 *     `VerificationExecInSandbox` types; nothing else.
 *   - **Dependency:** no import cycles. No barrel masking. No import
 *     from `./sandbox-tools`.
 *   - **Locality:** a future verification change should touch only this
 *     file and its tests.
 *
 * Types are the only cross-module imports that are allowed: `@/types`
 * for card/result shapes, and type-only imports from `./sandbox-client`
 * for the `ExecResult` / `SandboxEnvironment` shapes the context
 * functions deal in.
 */

import type { TestResultsCardData, ToolExecutionResult, TypeCheckCardData } from '@/types';
import type { ExecResult, SandboxEnvironment } from './sandbox-client';

// ---------------------------------------------------------------------------
// Handler context
// ---------------------------------------------------------------------------

/** Signature of the exec-in-sandbox primitive the handlers call through. */
export type VerificationExecInSandbox = (
  sandboxId: string,
  command: string,
  workdir?: string,
  options?: { markWorkspaceMutated?: boolean },
) => Promise<ExecResult>;

/**
 * The ambient context passed to every verification handler.
 *
 * All sandbox/platform primitives enter through this shape so the
 * module itself has zero runtime coupling to the infrastructure layer.
 * The dispatcher (`sandbox-tools.ts:executeSandboxToolCall`) is the one
 * place that wires up the real implementations.
 */
export interface VerificationHandlerContext {
  /** The sandbox to execute against. */
  sandboxId: string;
  /** Execute a shell command in the sandbox. */
  execInSandbox: VerificationExecInSandbox;
  /** Read the sandbox's environment readiness data (for verify_workspace). */
  getSandboxEnvironment: (sandboxId?: string) => SandboxEnvironment | null;
  /** Clear the file-version cache for a sandbox after a workspace mutation. */
  clearFileVersionCache: (sandboxId: string) => void;
  /** Clear the prefetched-edit-file cache for a sandbox after a workspace mutation. */
  clearPrefetchedEditFileCache: (sandboxId: string) => void;
}

// ---------------------------------------------------------------------------
// Pure helpers (moved verbatim from sandbox-tools.ts)
// ---------------------------------------------------------------------------

interface WorkspaceVerifyStep {
  id: 'install' | 'typecheck' | 'test';
  label: string;
  command: string;
  markWorkspaceMutated: boolean;
}

function getWorkspaceInstallCommand(packageManager: string | undefined): string | null {
  switch (packageManager) {
    case 'npm':
      return 'npm install';
    case 'yarn':
      return 'yarn install';
    case 'pnpm':
      return 'pnpm install';
    case 'bun':
      return 'bun install';
    default:
      return null;
  }
}

function buildWorkspaceVerifySteps(ctx: VerificationHandlerContext): {
  steps: WorkspaceVerifyStep[];
  warnings: string[];
} {
  const readiness = ctx.getSandboxEnvironment(ctx.sandboxId)?.readiness;
  const steps: WorkspaceVerifyStep[] = [];
  const warnings: string[] = [];

  if (readiness?.dependencies === 'missing') {
    const installCommand = getWorkspaceInstallCommand(readiness.package_manager);
    if (installCommand) {
      steps.push({
        id: 'install',
        label: 'Install dependencies',
        command: installCommand,
        markWorkspaceMutated: true,
      });
    } else if (readiness.test_command || readiness.typecheck_command) {
      warnings.push('Dependencies appear to be missing, but no install command could be inferred.');
    }
  }

  if (readiness?.typecheck_command) {
    steps.push({
      id: 'typecheck',
      label: 'Typecheck',
      command: readiness.typecheck_command,
      markWorkspaceMutated: false,
    });
  }

  if (readiness?.test_command) {
    steps.push({
      id: 'test',
      label: 'Test',
      command: readiness.test_command,
      markWorkspaceMutated: true,
    });
  }

  return { steps, warnings };
}

function summarizeWorkspaceVerifyOutput(output: string, maxChars = 4000): string {
  const trimmed = output.trim();
  if (!trimmed) return '(no output)';
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}\n[output truncated]`;
}

// ---------------------------------------------------------------------------
// sandbox_run_tests
// ---------------------------------------------------------------------------

export async function handleRunTests(
  ctx: VerificationHandlerContext,
  args: { framework?: string },
): Promise<ToolExecutionResult> {
  const { sandboxId, execInSandbox, clearFileVersionCache, clearPrefetchedEditFileCache } = ctx;
  const start = Date.now();

  // Auto-detect test framework if not specified
  let command = '';
  let framework: TestResultsCardData['framework'] = 'unknown';

  if (args.framework) {
    // User specified framework
    switch (args.framework.toLowerCase()) {
      case 'npm':
      case 'jest':
      case 'vitest':
      case 'mocha':
        command = 'npm test';
        framework = 'npm';
        break;
      case 'pytest':
      case 'python':
        command = 'pytest -v';
        framework = 'pytest';
        break;
      case 'cargo':
      case 'rust':
        command = 'cargo test';
        framework = 'cargo';
        break;
      case 'go':
        command = 'go test ./...';
        framework = 'go';
        break;
      default:
        command = args.framework;
        framework = 'unknown';
    }
  } else {
    // Auto-detect by checking for config files
    const detectResult = await execInSandbox(
      sandboxId,
      'cd /workspace && ls -1 package.json Cargo.toml go.mod pytest.ini pyproject.toml setup.py 2>/dev/null | head -1',
    );
    const detected = detectResult.stdout.trim();

    if (detected === 'package.json') {
      command = 'npm test';
      framework = 'npm';
    } else if (detected === 'Cargo.toml') {
      command = 'cargo test';
      framework = 'cargo';
    } else if (detected === 'go.mod') {
      command = 'go test ./...';
      framework = 'go';
    } else if (['pytest.ini', 'pyproject.toml', 'setup.py'].includes(detected)) {
      command = 'pytest -v';
      framework = 'pytest';
    } else {
      // Fallback: try npm test
      command = 'npm test';
      framework = 'npm';
    }
  }

  const result = await execInSandbox(sandboxId, `cd /workspace && ${command}`, undefined, {
    markWorkspaceMutated: true,
  });
  const durationMs = Date.now() - start;
  // Tests can generate artifacts, coverage files, snapshots, etc.
  clearFileVersionCache(sandboxId);
  clearPrefetchedEditFileCache(sandboxId);

  // Parse test results from output
  const output = result.stdout + '\n' + result.stderr;
  let passed = 0,
    failed = 0,
    skipped = 0,
    total = 0;

  // npm/jest/vitest patterns
  const jestMatch =
    output.match(/Tests:\s*(\d+)\s*passed.*?(\d+)\s*failed.*?(\d+)\s*total/i) ||
    output.match(/(\d+)\s*passing.*?(\d+)\s*failing/i);
  // pytest patterns
  const pytestMatch =
    output.match(/(\d+)\s*passed.*?(\d+)\s*failed/i) ||
    output.match(/passed:\s*(\d+).*?failed:\s*(\d+)/i);
  // cargo patterns
  const cargoMatch = output.match(/test result:.*?(\d+)\s*passed.*?(\d+)\s*failed/i);
  // go patterns — count both passing and failing packages
  const goPassMatch = output.match(/ok\s+.*?\s+(\d+\.\d+)s/g);
  const goFailMatch = output.match(/FAIL\s+.*?\s+(\d+\.\d+)s/g);

  if (jestMatch) {
    passed = parseInt(jestMatch[1]) || 0;
    failed = parseInt(jestMatch[2]) || 0;
    total = jestMatch[3] ? parseInt(jestMatch[3]) || 0 : passed + failed;
  } else if (pytestMatch) {
    passed = parseInt(pytestMatch[1]) || 0;
    failed = parseInt(pytestMatch[2]) || 0;
    total = passed + failed;
  } else if (cargoMatch) {
    passed = parseInt(cargoMatch[1]) || 0;
    failed = parseInt(cargoMatch[2]) || 0;
    total = passed + failed;
  } else if (goPassMatch || goFailMatch) {
    passed = goPassMatch ? goPassMatch.length : 0;
    failed = goFailMatch ? goFailMatch.length : 0;
    total = passed + failed;
  }

  // Check for skipped tests
  const skipMatch = output.match(/(\d+)\s*skipped/i);
  if (skipMatch) {
    skipped = parseInt(skipMatch[1]) || 0;
    total += skipped;
  }

  const truncated = output.length > 8000;
  const truncatedOutput = truncated ? output.slice(0, 8000) + '\n\n[...output truncated]' : output;

  const statusIcon = result.exitCode === 0 ? '✓' : '✗';
  const lines: string[] = [
    `[Tool Result — sandbox_run_tests]`,
    `${statusIcon} Tests ${result.exitCode === 0 ? 'PASSED' : 'FAILED'} (${framework})`,
    `Command: ${command}`,
    `Duration: ${(durationMs / 1000).toFixed(1)}s`,
    total > 0
      ? `Results: ${passed} passed, ${failed} failed${skipped > 0 ? `, ${skipped} skipped` : ''}`
      : '',
    `\nOutput:\n${truncatedOutput}`,
  ].filter(Boolean);

  const cardData: TestResultsCardData = {
    framework,
    passed,
    failed,
    skipped,
    total,
    durationMs,
    exitCode: result.exitCode,
    output: truncatedOutput,
    truncated,
  };

  return { text: lines.join('\n'), card: { type: 'test-results', data: cardData } };
}

// ---------------------------------------------------------------------------
// sandbox_check_types
// ---------------------------------------------------------------------------

export async function handleCheckTypes(
  ctx: VerificationHandlerContext,
): Promise<ToolExecutionResult> {
  const { sandboxId, execInSandbox, clearFileVersionCache, clearPrefetchedEditFileCache } = ctx;
  const start = Date.now();

  // Auto-detect type checker
  let command = '';
  let tool: TypeCheckCardData['tool'] = 'unknown';

  // Explicit priority order: TypeScript checkers first, then Python.
  // A bare `ls` would alphabetize and return `mypy.ini` ahead of `tsconfig.json`.
  const detectResult = await execInSandbox(
    sandboxId,
    'cd /workspace && for f in tsconfig.json tsconfig.app.json tsconfig.node.json pyrightconfig.json mypy.ini; do [ -f "$f" ] && echo "$f" && break; done',
  );
  const detected = detectResult.stdout.trim();

  if (
    detected === 'tsconfig.json' ||
    detected === 'tsconfig.app.json' ||
    detected === 'tsconfig.node.json'
  ) {
    // Check if node_modules exists, install if missing
    const nodeModulesCheck = await execInSandbox(
      sandboxId,
      'cd /workspace && ls -d node_modules 2>/dev/null',
    );
    if (nodeModulesCheck.exitCode !== 0) {
      const installResult = await execInSandbox(
        sandboxId,
        'cd /workspace && npm install',
        undefined,
        { markWorkspaceMutated: true },
      );
      if (installResult.exitCode !== 0) {
        return {
          text: `[Tool Result — sandbox_check_types]\nFailed to install dependencies:\n${installResult.stderr}`,
        };
      }
      // npm install modifies node_modules, package-lock.json, etc.
      clearFileVersionCache(sandboxId);
      clearPrefetchedEditFileCache(sandboxId);
    }

    // Check if tsc is available and run type check
    const tscCheck = await execInSandbox(
      sandboxId,
      'cd /workspace && npx tsc --version 2>/dev/null',
    );
    if (tscCheck.exitCode === 0) {
      command = 'npx tsc --noEmit';
      tool = 'tsc';
    }
  } else if (detected === 'pyrightconfig.json') {
    // Check if pyright is available
    const pyrightCheck = await execInSandbox(
      sandboxId,
      'cd /workspace && pyright --version 2>/dev/null',
    );
    if (pyrightCheck.exitCode === 0) {
      command = 'pyright';
      tool = 'pyright';
    }
  } else if (detected === 'mypy.ini') {
    // Check if mypy is available
    const mypyCheck = await execInSandbox(sandboxId, 'cd /workspace && mypy --version 2>/dev/null');
    if (mypyCheck.exitCode === 0) {
      // Use 'mypy' without args to respect mypy.ini config paths
      command = 'mypy';
      tool = 'mypy';
    }
  }

  if (!command) {
    // Fallback: try tsc if package.json exists
    const pkgCheck = await execInSandbox(
      sandboxId,
      'cd /workspace && cat package.json 2>/dev/null',
    );
    if (pkgCheck.stdout.includes('typescript')) {
      command = 'npx tsc --noEmit';
      tool = 'tsc';
    } else {
      return {
        text: '[Tool Result — sandbox_check_types]\nNo type checker detected. Supported: TypeScript (tsc), Pyright, mypy.',
      };
    }
  }

  const result = await execInSandbox(sandboxId, `cd /workspace && ${command}`, undefined, {
    markWorkspaceMutated: true,
  });
  const durationMs = Date.now() - start;

  const output = result.stdout + '\n' + result.stderr;
  const errors: TypeCheckCardData['errors'] = [];
  let errorCount = 0;
  let warningCount = 0;

  // Parse TypeScript errors: file.ts(line,col): error TS1234: message
  if (tool === 'tsc') {
    const tsErrorRegex = /(.+?)\((\d+),(\d+)\):\s*(error|warning)\s*(TS\d+):\s*(.+)/g;
    let match;
    while ((match = tsErrorRegex.exec(output)) !== null && errors.length < 50) {
      const isError = match[4] === 'error';
      if (isError) errorCount++;
      else warningCount++;
      errors.push({
        file: match[1],
        line: parseInt(match[2]),
        column: parseInt(match[3]),
        message: match[6],
        code: match[5],
      });
    }
    // Also check for "Found N errors" summary
    const summaryMatch = output.match(/Found (\d+) errors?/);
    if (summaryMatch) {
      errorCount = Math.max(errorCount, parseInt(summaryMatch[1]));
    }
  }

  // Parse Pyright errors: file.py:line:col - error: message
  if (tool === 'pyright') {
    const pyrightRegex = /(.+?):(\d+):(\d+)\s*-\s*(error|warning):\s*(.+)/g;
    let match;
    while ((match = pyrightRegex.exec(output)) !== null && errors.length < 50) {
      const isError = match[4] === 'error';
      if (isError) errorCount++;
      else warningCount++;
      errors.push({
        file: match[1],
        line: parseInt(match[2]),
        column: parseInt(match[3]),
        message: match[5],
      });
    }
  }

  // Parse mypy errors: file.py:line: error: message
  if (tool === 'mypy') {
    const mypyRegex = /(.+?):(\d+):\s*(error|warning):\s*(.+)/g;
    let match;
    while ((match = mypyRegex.exec(output)) !== null && errors.length < 50) {
      const isError = match[3] === 'error';
      if (isError) errorCount++;
      else warningCount++;
      errors.push({
        file: match[1],
        line: parseInt(match[2]),
        column: 0,
        message: match[4],
      });
    }
  }

  const truncated = output.length > 8000;
  const statusIcon = result.exitCode === 0 ? '✓' : '✗';
  const lines: string[] = [
    `[Tool Result — sandbox_check_types]`,
    `${statusIcon} Type check ${result.exitCode === 0 ? 'PASSED' : 'FAILED'} (${tool})`,
    `Command: ${command}`,
    `Duration: ${(durationMs / 1000).toFixed(1)}s`,
    errorCount > 0 || warningCount > 0
      ? `Found: ${errorCount} error${errorCount !== 1 ? 's' : ''}${warningCount > 0 ? `, ${warningCount} warning${warningCount !== 1 ? 's' : ''}` : ''}`
      : '',
  ].filter(Boolean);

  if (errors.length > 0) {
    lines.push('\nErrors:');
    for (const err of errors.slice(0, 10)) {
      lines.push(`  ${err.file}:${err.line}${err.column ? `:${err.column}` : ''} — ${err.message}`);
    }
    if (errors.length > 10) {
      lines.push(`  ...and ${errors.length - 10} more`);
    }
  }

  const cardData: TypeCheckCardData = {
    tool,
    errors,
    errorCount,
    warningCount,
    exitCode: result.exitCode,
    truncated,
  };

  return { text: lines.join('\n'), card: { type: 'type-check', data: cardData } };
}

// ---------------------------------------------------------------------------
// sandbox_verify_workspace
// ---------------------------------------------------------------------------

export async function handleVerifyWorkspace(
  ctx: VerificationHandlerContext,
): Promise<ToolExecutionResult> {
  const { sandboxId, execInSandbox, clearFileVersionCache, clearPrefetchedEditFileCache } = ctx;
  const start = Date.now();
  const { steps, warnings } = buildWorkspaceVerifySteps(ctx);

  if (steps.length === 0) {
    const hint =
      warnings[0] ??
      'No install, typecheck, or test command could be inferred from the workspace readiness probe.';
    return {
      text: [
        '[Tool Result — sandbox_verify_workspace]',
        hint,
        'Use test(), typecheck(), or exec() directly if you need a custom verification command.',
      ].join('\n'),
    };
  }

  const lines: string[] = ['[Tool Result — sandbox_verify_workspace]'];
  if (warnings.length > 0) {
    for (const warning of warnings) lines.push(`Warning: ${warning}`);
  }

  type StepResult = WorkspaceVerifyStep & {
    exitCode: number;
    durationMs: number;
    output: string;
  };

  const stepResults: StepResult[] = [];
  let failedStep: StepResult | null = null;

  for (const step of steps) {
    const stepStart = Date.now();
    const result = await execInSandbox(sandboxId, `cd /workspace && ${step.command}`, undefined, {
      markWorkspaceMutated: step.markWorkspaceMutated,
    });
    const durationMs = Date.now() - stepStart;

    if (step.markWorkspaceMutated) {
      clearFileVersionCache(sandboxId);
      clearPrefetchedEditFileCache(sandboxId);
    }

    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    const recorded: StepResult = {
      ...step,
      exitCode: result.exitCode,
      durationMs,
      output,
    };
    stepResults.push(recorded);

    if (result.exitCode !== 0) {
      failedStep = recorded;
      break;
    }
  }

  const overallPassed = !failedStep;
  lines.push(
    `${overallPassed ? '✓' : '✗'} Workspace verification ${overallPassed ? 'PASSED' : `FAILED at ${failedStep?.id}`}`,
    `Duration: ${((Date.now() - start) / 1000).toFixed(1)}s`,
    '',
    'Steps:',
  );

  for (const step of stepResults) {
    lines.push(
      `- ${step.exitCode === 0 ? '✓' : '✗'} ${step.label}: ${step.command} (${(step.durationMs / 1000).toFixed(1)}s)`,
    );
  }

  if (failedStep) {
    lines.push(
      '',
      `Output from failed step (${failedStep.label}):`,
      summarizeWorkspaceVerifyOutput(failedStep.output),
    );
    if (failedStep.id !== 'install') {
      lines.push('', 'Tip: rerun test() or typecheck() directly if you need more detailed output.');
    }
  }

  return { text: lines.join('\n') };
}
