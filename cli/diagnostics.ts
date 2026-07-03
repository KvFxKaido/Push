import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const execFileAsync = promisify(execFile);

export interface Diagnostic {
  file: string;
  line: number;
  col: number;
  severity: 'error' | 'warning';
  message: string;
  code?: string;
}

export interface DiagnosticError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface DiagnosticResult {
  diagnostics: Diagnostic[];
  error?: DiagnosticError;
}

interface ProjectDetection {
  type: string | null;
  configPath: string | null;
}

interface ProjectCheck {
  file: string;
  type: string;
  config: string;
}

interface ExecError extends Error {
  code: number | string;
  stdout: string;
  stderr: string;
  /** Set by execFile when the child was killed (e.g. timeout expiry). */
  killed?: boolean;
}

export interface FullDiagnosticResult extends DiagnosticResult {
  projectType: string | null;
}

export interface DiagnosticRunOptions {
  /**
   * Kill the checker subprocess after this many ms. Overrides each
   * runner's built-in default (60s; 120s for cargo). A killed run is
   * classified as DIAGNOSTIC_TIMEOUT so callers with a time budget
   * (post-edit diagnostics) can distinguish "too slow" from "broken".
   */
  timeoutMs?: number;
}

/**
 * True when a killed checker subprocess died to the time budget. execFile
 * also kills the child with `killed: true` on maxBuffer overflow — that is
 * an output-size failure, not a time one, and must fall through to the
 * generic failure handling (transient; must not trip the post-edit loop's
 * adaptive disable). The maxBuffer case is only identifiable by message
 * ("stdout maxBuffer length exceeded"), so match on that.
 */
export function isTimeoutKill(execErr: {
  killed?: boolean;
  code?: number | string;
  message?: string;
}): boolean {
  if (!execErr.killed) return false;
  if (execErr.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return false;
  if (/maxBuffer/i.test(execErr.message ?? '')) return false;
  return true;
}

/**
 * Classify a killed checker subprocess as a timeout. Exit-code checks in
 * the runners' catch arms must run after this (a killed child reports
 * `code: null`, but may carry partial stdout that would otherwise be
 * parsed as a truncated — and therefore wrong — diagnostics set).
 */
function classifyTimeout(execErr: ExecError, checker: string): DiagnosticResult | null {
  if (!isTimeoutKill(execErr)) return null;
  return {
    diagnostics: [],
    error: {
      code: 'DIAGNOSTIC_TIMEOUT',
      message: `${checker} was killed after exceeding its time budget`,
      retryable: false,
    },
  };
}

/**
 * Detect project language/type based on file presence at workspace root
 */
export async function detectProjectType(workspaceRoot: string): Promise<ProjectDetection> {
  const checks: ProjectCheck[] = [
    { file: 'tsconfig.json', type: 'typescript', config: 'tsconfig.json' },
    { file: 'package.json', type: 'node', config: 'package.json' },
    { file: 'pyproject.toml', type: 'python', config: 'pyproject.toml' },
    { file: 'Cargo.toml', type: 'rust', config: 'Cargo.toml' },
    { file: 'go.mod', type: 'go', config: 'go.mod' },
  ];

  for (const check of checks) {
    try {
      const configPath: string = path.join(workspaceRoot, check.file);
      await fs.access(configPath);
      return { type: check.type, configPath: check.config };
    } catch {
      // Continue to next check
    }
  }

  return { type: null, configPath: null };
}

/**
 * Run TypeScript diagnostics via tsc --noEmit
 */
async function runTypeScriptDiagnostics(
  workspaceRoot: string,
  specificPath: string | null,
  opts: DiagnosticRunOptions = {},
): Promise<DiagnosticResult> {
  try {
    // Always run the project-level check so tsconfig.json is honored. Passing a
    // file path on the command line makes tsc ignore tsconfig (error TS5112
    // since TypeScript 6.0; an isolated default-config compile before that),
    // producing spurious results instead of real project diagnostics. Filter to
    // the requested file after parsing instead — same as the Rust path below.
    const args: string[] = ['--noEmit', '--pretty', 'false'];

    const { stdout, stderr } = await execFileAsync('tsc', args, {
      cwd: workspaceRoot,
      maxBuffer: 4_000_000,
      timeout: opts.timeoutMs ?? 60_000,
    });

    // tsc returns 0 on success, 1 on type errors (but we still get output)
    // stderr may contain parse errors or config errors
    const output: string = stdout || stderr;
    if (!output.trim()) {
      return { diagnostics: [] };
    }

    // Filter to the specific path if requested (project check reports all files)
    let diagnostics: Diagnostic[] = parseTscOutput(output, workspaceRoot);
    if (specificPath) {
      const relativeSpecific: string = path.relative(workspaceRoot, specificPath);
      diagnostics = diagnostics.filter((d: Diagnostic) => d.file === relativeSpecific);
    }

    return { diagnostics };
  } catch (err) {
    const execErr = err as ExecError;
    const timedOut = classifyTimeout(execErr, 'tsc');
    if (timedOut) return timedOut;
    // tsc exits with code 1 on type errors — this is expected
    if (execErr.code === 1 && (execErr.stdout || execErr.stderr)) {
      const output: string = execErr.stdout || execErr.stderr;
      let diagnostics: Diagnostic[] = parseTscOutput(output, workspaceRoot);
      if (specificPath) {
        const relativeSpecific: string = path.relative(workspaceRoot, specificPath);
        diagnostics = diagnostics.filter((d: Diagnostic) => d.file === relativeSpecific);
      }
      return { diagnostics };
    }

    // Check for "command not found"
    if (execErr.code === 'ENOENT' || execErr.message?.includes('ENOENT')) {
      return {
        diagnostics: [],
        error: {
          code: 'DIAGNOSTIC_TOOL_NOT_FOUND',
          message: 'TypeScript compiler (tsc) not found. Install with: npm install -g typescript',
          retryable: false,
        },
      };
    }

    return {
      diagnostics: [],
      error: {
        code: 'DIAGNOSTIC_FAILED',
        message: `TypeScript diagnostics failed: ${execErr.message}`,
        retryable: true,
      },
    };
  }
}

/**
 * Parse TypeScript compiler output into normalized diagnostics
 * Sample tsc output:
 * src/foo.ts(42,7): error TS2322: Type 'X' is not assignable to type 'Y'.
 * src/bar.ts(10,1): warning TS6133: 'unused' is declared but never read.
 */
function parseTscOutput(output: string, workspaceRoot: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const lines: string[] = output.split('\n');

  // Pattern: file(line,col): severity CODE: message
  const pattern: RegExp = /^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+(\w+):\s*(.+)$/;

  for (const line of lines) {
    const match: RegExpExecArray | null = pattern.exec(line);
    if (match) {
      const [, file, lineStr, colStr, severity, code, message] = match;
      diagnostics.push({
        file: path.relative(workspaceRoot, path.resolve(workspaceRoot, file.trim())),
        line: parseInt(lineStr, 10),
        col: parseInt(colStr, 10),
        severity: severity === 'error' ? 'error' : 'warning',
        message: message.trim(),
        code,
      });
    }
  }

  return diagnostics;
}

/**
 * Run Python diagnostics via pyright or ruff
 */
async function runPythonDiagnostics(
  workspaceRoot: string,
  specificPath: string | null,
  opts: DiagnosticRunOptions = {},
): Promise<DiagnosticResult> {
  // Try pyright first, then fall back to ruff
  const pyrightResult: DiagnosticResult | null = await tryPyright(
    workspaceRoot,
    specificPath,
    opts,
  );
  if (pyrightResult) return pyrightResult;

  const ruffResult: DiagnosticResult | null = await tryRuff(workspaceRoot, specificPath, opts);
  if (ruffResult) return ruffResult;

  return {
    diagnostics: [],
    error: {
      code: 'DIAGNOSTIC_TOOL_NOT_FOUND',
      message:
        'No Python type checker found. Install pyright (npm install -g pyright) or ruff (pip install ruff)',
      retryable: false,
    },
  };
}

async function tryPyright(
  workspaceRoot: string,
  specificPath: string | null,
  opts: DiagnosticRunOptions = {},
): Promise<DiagnosticResult | null> {
  try {
    const args: string[] = ['--outputjson'];
    if (specificPath) {
      args.push(specificPath);
    }

    const { stdout } = await execFileAsync('pyright', args, {
      cwd: workspaceRoot,
      maxBuffer: 4_000_000,
      timeout: opts.timeoutMs ?? 60_000,
    });

    return { diagnostics: parsePyrightOutput(stdout, workspaceRoot) };
  } catch (err) {
    const execErr = err as ExecError;
    const timedOut = classifyTimeout(execErr, 'pyright');
    if (timedOut) return timedOut;
    // pyright exits with code 1 on type errors
    if (execErr.code === 1 && execErr.stdout) {
      return { diagnostics: parsePyrightOutput(execErr.stdout, workspaceRoot) };
    }
    if (execErr.code === 'ENOENT') return null;

    return {
      diagnostics: [],
      error: {
        code: 'DIAGNOSTIC_FAILED',
        message: `Pyright failed: ${execErr.message}`,
        retryable: true,
      },
    };
  }
}

interface PyrightDiagnostic {
  file?: string;
  range?: { start?: { line?: number; character?: number } };
  severity?: string;
  message: string;
  rule?: string;
}

interface PyrightOutput {
  generalDiagnostics?: PyrightDiagnostic[];
}

function parsePyrightOutput(jsonOutput: string, workspaceRoot: string): Diagnostic[] {
  try {
    const data: PyrightOutput = JSON.parse(jsonOutput);
    const diagnostics: Diagnostic[] = [];

    for (const diag of data.generalDiagnostics || []) {
      diagnostics.push({
        file: diag.file
          ? path.relative(workspaceRoot, path.resolve(workspaceRoot, diag.file))
          : '<unknown>',
        line: diag.range?.start?.line ?? 0,
        col: diag.range?.start?.character ?? 0,
        severity: diag.severity === 'error' ? 'error' : 'warning',
        message: diag.message,
        code: diag.rule || undefined,
      });
    }

    return diagnostics;
  } catch {
    return [];
  }
}

interface RuffViolation {
  filename: string;
  location?: { row?: number; column?: number };
  message: string;
  code: string;
}

async function tryRuff(
  workspaceRoot: string,
  specificPath: string | null,
  opts: DiagnosticRunOptions = {},
): Promise<DiagnosticResult | null> {
  try {
    const args: string[] = ['check', '--output-format', 'json'];
    if (specificPath) {
      args.push(specificPath);
    } else {
      args.push('.');
    }

    const { stdout } = await execFileAsync('ruff', args, {
      cwd: workspaceRoot,
      maxBuffer: 4_000_000,
      timeout: opts.timeoutMs ?? 60_000,
    });

    return { diagnostics: parseRuffOutput(stdout, workspaceRoot) };
  } catch (err) {
    const execErr = err as ExecError;
    const timedOut = classifyTimeout(execErr, 'ruff');
    if (timedOut) return timedOut;
    // ruff exits with code 1 on violations
    if (execErr.code === 1 && execErr.stdout) {
      return { diagnostics: parseRuffOutput(execErr.stdout, workspaceRoot) };
    }
    if (execErr.code === 'ENOENT') return null;

    return {
      diagnostics: [],
      error: {
        code: 'DIAGNOSTIC_FAILED',
        message: `Ruff failed: ${execErr.message}`,
        retryable: true,
      },
    };
  }
}

function parseRuffOutput(jsonOutput: string, workspaceRoot: string): Diagnostic[] {
  try {
    const data: RuffViolation[] = JSON.parse(jsonOutput);
    const diagnostics: Diagnostic[] = [];

    for (const violation of data || []) {
      diagnostics.push({
        file: path.relative(workspaceRoot, path.resolve(workspaceRoot, violation.filename)),
        line: violation.location?.row ?? 0,
        col: violation.location?.column ?? 0,
        severity: 'warning', // ruff doesn't distinguish error vs warning
        message: violation.message,
        code: violation.code,
      });
    }

    return diagnostics;
  } catch {
    return [];
  }
}

/**
 * Run Rust diagnostics via cargo check
 */
async function runRustDiagnostics(
  workspaceRoot: string,
  specificPath: string | null,
  opts: DiagnosticRunOptions = {},
): Promise<DiagnosticResult> {
  try {
    // cargo check doesn't support single-file checks well
    // so we run workspace-level check but filter results
    const args: string[] = ['check', '--message-format=json'];

    const { stdout, stderr } = await execFileAsync('cargo', args, {
      cwd: workspaceRoot,
      maxBuffer: 4_000_000,
      timeout: opts.timeoutMs ?? 120_000,
    });

    // Filter to specific path if requested
    let diagnostics: Diagnostic[] = parseCargoOutput(stdout, workspaceRoot);
    if (specificPath) {
      const relativeSpecific: string = path.relative(workspaceRoot, specificPath);
      diagnostics = diagnostics.filter((d: Diagnostic) => d.file === relativeSpecific);
    }

    return { diagnostics };
  } catch (err) {
    const execErr = err as ExecError;
    const timedOut = classifyTimeout(execErr, 'cargo check');
    if (timedOut) return timedOut;
    // cargo check exits with code 101 on compile errors
    if (execErr.stdout) {
      let diagnostics: Diagnostic[] = parseCargoOutput(execErr.stdout, workspaceRoot);
      if (specificPath) {
        const relativeSpecific: string = path.relative(workspaceRoot, specificPath);
        diagnostics = diagnostics.filter((d: Diagnostic) => d.file === relativeSpecific);
      }
      return { diagnostics };
    }

    if (execErr.code === 'ENOENT') {
      return {
        diagnostics: [],
        error: {
          code: 'DIAGNOSTIC_TOOL_NOT_FOUND',
          message: 'Rust toolchain not found. Install from https://rustup.rs',
          retryable: false,
        },
      };
    }

    return {
      diagnostics: [],
      error: {
        code: 'DIAGNOSTIC_FAILED',
        message: `Cargo check failed: ${execErr.message}`,
        retryable: true,
      },
    };
  }
}

interface CargoMessage {
  reason: string;
  message?: {
    spans?: Array<{ file_name: string; line_start: number; column_start: number }>;
    level?: string;
    message: string;
    code?: { code: string };
  };
}

function parseCargoOutput(output: string, workspaceRoot: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const lines: string[] = output.split('\n');

  for (const line of lines) {
    try {
      const msg: CargoMessage = JSON.parse(line);
      if (msg.reason === 'compiler-message' && msg.message) {
        const span = msg.message.spans?.[0];
        if (span) {
          diagnostics.push({
            file: path.relative(workspaceRoot, path.resolve(workspaceRoot, span.file_name)),
            line: span.line_start,
            col: span.column_start,
            severity: msg.message.level === 'error' ? 'error' : 'warning',
            message: msg.message.message,
            code: msg.message.code?.code,
          });
        }
      }
    } catch {
      // Skip non-JSON lines
    }
  }

  return diagnostics;
}

/**
 * Run Go diagnostics via go vet
 */
async function runGoDiagnostics(
  workspaceRoot: string,
  specificPath: string | null,
  opts: DiagnosticRunOptions = {},
): Promise<DiagnosticResult> {
  try {
    const args: string[] = ['vet'];
    if (specificPath) {
      args.push(specificPath);
    } else {
      args.push('./...');
    }

    const { stdout, stderr } = await execFileAsync('go', args, {
      cwd: workspaceRoot,
      maxBuffer: 4_000_000,
      timeout: opts.timeoutMs ?? 60_000,
    });

    const output: string = stdout || stderr;
    return { diagnostics: parseGoVetOutput(output, workspaceRoot) };
  } catch (err) {
    const execErr = err as ExecError;
    const timedOut = classifyTimeout(execErr, 'go vet');
    if (timedOut) return timedOut;
    // go vet exits with code 1 on issues
    if (execErr.code === 1 && (execErr.stdout || execErr.stderr)) {
      const output: string = execErr.stdout || execErr.stderr;
      return { diagnostics: parseGoVetOutput(output, workspaceRoot) };
    }

    if (execErr.code === 'ENOENT') {
      return {
        diagnostics: [],
        error: {
          code: 'DIAGNOSTIC_TOOL_NOT_FOUND',
          message: 'Go toolchain not found. Install from https://go.dev',
          retryable: false,
        },
      };
    }

    return {
      diagnostics: [],
      error: {
        code: 'DIAGNOSTIC_FAILED',
        message: `Go vet failed: ${execErr.message}`,
        retryable: true,
      },
    };
  }
}

function parseGoVetOutput(output: string, workspaceRoot: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const lines: string[] = output.split('\n');

  // go vet output: file:line:col: message
  const pattern: RegExp = /^(.+?):(\d+):(\d+):\s*(.+)$/;

  for (const line of lines) {
    const match: RegExpExecArray | null = pattern.exec(line);
    if (match) {
      const [, file, lineStr, colStr, message] = match;
      diagnostics.push({
        file: path.relative(workspaceRoot, path.resolve(workspaceRoot, file.trim())),
        line: parseInt(lineStr, 10),
        col: parseInt(colStr, 10),
        severity: 'warning', // go vet only reports issues, not compile errors
        message: message.trim(),
        code: undefined,
      });
    }
  }

  return diagnostics;
}

/**
 * Run diagnostics for the workspace or a specific file
 */
export async function runDiagnostics(
  workspaceRoot: string,
  specificPath: string | null = null,
  opts: DiagnosticRunOptions = {},
): Promise<FullDiagnosticResult> {
  const { type: projectType } = await detectProjectType(workspaceRoot);

  if (!projectType) {
    return {
      diagnostics: [],
      projectType: null,
      error: {
        code: 'UNSUPPORTED_PROJECT_TYPE',
        message:
          'No supported project type detected (tsconfig.json, pyproject.toml, Cargo.toml, go.mod)',
        retryable: false,
      },
    };
  }

  let result: DiagnosticResult;
  switch (projectType) {
    case 'typescript':
    case 'node':
      result = await runTypeScriptDiagnostics(workspaceRoot, specificPath, opts);
      break;
    case 'python':
      result = await runPythonDiagnostics(workspaceRoot, specificPath, opts);
      break;
    case 'rust':
      result = await runRustDiagnostics(workspaceRoot, specificPath, opts);
      break;
    case 'go':
      result = await runGoDiagnostics(workspaceRoot, specificPath, opts);
      break;
    default:
      return {
        diagnostics: [],
        projectType,
        error: {
          code: 'UNSUPPORTED_PROJECT_TYPE',
          message: `Project type "${projectType}" detected but not yet supported for diagnostics`,
          retryable: false,
        },
      };
  }

  return {
    diagnostics: result.diagnostics,
    projectType,
    error: result.error,
  };
}
