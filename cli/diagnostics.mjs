import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const execFileAsync = promisify(execFile);

/**
 * Detect project language/type based on file presence at workspace root
 * @param {string} workspaceRoot
 * @returns {Promise<{type: string|null, configPath: string|null}>}
 */
export async function detectProjectType(workspaceRoot) {
  const checks = [
    { file: 'tsconfig.json', type: 'typescript', config: 'tsconfig.json' },
    { file: 'package.json', type: 'node', config: 'package.json' },
    { file: 'pyproject.toml', type: 'python', config: 'pyproject.toml' },
    { file: 'Cargo.toml', type: 'rust', config: 'Cargo.toml' },
    { file: 'go.mod', type: 'go', config: 'go.mod' },
  ];

  for (const check of checks) {
    try {
      const configPath = path.join(workspaceRoot, check.file);
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
 * @param {string} workspaceRoot
 * @param {string|null} specificPath - Optional file path to filter results
 * @returns {Promise<{diagnostics: Diagnostic[], error?: {code: string, message: string, retryable: boolean}}>}
 */
async function runTypeScriptDiagnostics(workspaceRoot, specificPath) {
  try {
    const args = ['--noEmit', '--pretty', 'false'];
    if (specificPath) {
      // tsc can filter by file when given specific paths
      args.push(specificPath);
    }

    const { stdout, stderr } = await execFileAsync('tsc', args, {
      cwd: workspaceRoot,
      maxBuffer: 4_000_000,
      timeout: 60_000,
    });

    // tsc returns 0 on success, 1 on type errors (but we still get output)
    // stderr may contain parse errors or config errors
    const output = stdout || stderr;
    if (!output.trim()) {
      return { diagnostics: [] };
    }

    return { diagnostics: parseTscOutput(output, workspaceRoot) };
  } catch (err) {
    // tsc exits with code 1 on type errors — this is expected
    if (err.code === 1 && (err.stdout || err.stderr)) {
      const output = err.stdout || err.stderr;
      return { diagnostics: parseTscOutput(output, workspaceRoot) };
    }

    // Check for "command not found"
    if (err.code === 'ENOENT' || err.message?.includes('ENOENT')) {
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
        message: `TypeScript diagnostics failed: ${err.message}`,
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
function parseTscOutput(output, workspaceRoot) {
  const diagnostics = [];
  const lines = output.split('\n');

  // Pattern: file(line,col): severity CODE: message
  const pattern = /^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+(\w+):\s*(.+)$/;

  for (const line of lines) {
    const match = pattern.exec(line);
    if (match) {
      const [, file, lineStr, colStr, severity, code, message] = match;
      diagnostics.push({
        file: path.relative(workspaceRoot, file.trim()),
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
 * @param {string} workspaceRoot
 * @param {string|null} specificPath
 * @returns {Promise<{diagnostics: Diagnostic[], error?: {code: string, message: string, retryable: boolean}}>}
 */
async function runPythonDiagnostics(workspaceRoot, specificPath) {
  // Try pyright first, then fall back to ruff
  const pyrightResult = await tryPyright(workspaceRoot, specificPath);
  if (pyrightResult) return pyrightResult;

  const ruffResult = await tryRuff(workspaceRoot, specificPath);
  if (ruffResult) return ruffResult;

  return {
    diagnostics: [],
    error: {
      code: 'DIAGNOSTIC_TOOL_NOT_FOUND',
      message: 'No Python type checker found. Install pyright (npm install -g pyright) or ruff (pip install ruff)',
      retryable: false,
    },
  };
}

async function tryPyright(workspaceRoot, specificPath) {
  try {
    const args = ['--outputjson'];
    if (specificPath) {
      args.push(specificPath);
    }

    const { stdout } = await execFileAsync('pyright', args, {
      cwd: workspaceRoot,
      maxBuffer: 4_000_000,
      timeout: 60_000,
    });

    return { diagnostics: parsePyrightOutput(stdout, workspaceRoot) };
  } catch (err) {
    // pyright exits with code 1 on type errors
    if (err.code === 1 && err.stdout) {
      return { diagnostics: parsePyrightOutput(err.stdout, workspaceRoot) };
    }
    if (err.code === 'ENOENT') return null;

    return {
      diagnostics: [],
      error: {
        code: 'DIAGNOSTIC_FAILED',
        message: `Pyright failed: ${err.message}`,
        retryable: true,
      },
    };
  }
}

function parsePyrightOutput(jsonOutput, workspaceRoot) {
  try {
    const data = JSON.parse(jsonOutput);
    const diagnostics = [];

    for (const diag of data.generalDiagnostics || []) {
      diagnostics.push({
        file: diag.file ? path.relative(workspaceRoot, diag.file) : '<unknown>',
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

async function tryRuff(workspaceRoot, specificPath) {
  try {
    const args = ['check', '--output-format', 'json'];
    if (specificPath) {
      args.push(specificPath);
    } else {
      args.push('.');
    }

    const { stdout } = await execFileAsync('ruff', args, {
      cwd: workspaceRoot,
      maxBuffer: 4_000_000,
      timeout: 60_000,
    });

    return { diagnostics: parseRuffOutput(stdout, workspaceRoot) };
  } catch (err) {
    // ruff exits with code 1 on violations
    if (err.code === 1 && err.stdout) {
      return { diagnostics: parseRuffOutput(err.stdout, workspaceRoot) };
    }
    if (err.code === 'ENOENT') return null;

    return {
      diagnostics: [],
      error: {
        code: 'DIAGNOSTIC_FAILED',
        message: `Ruff failed: ${err.message}`,
        retryable: true,
      },
    };
  }
}

function parseRuffOutput(jsonOutput, workspaceRoot) {
  try {
    const data = JSON.parse(jsonOutput);
    const diagnostics = [];

    for (const violation of data || []) {
      diagnostics.push({
        file: path.relative(workspaceRoot, violation.filename),
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
 * @param {string} workspaceRoot
 * @param {string|null} specificPath
 * @returns {Promise<{diagnostics: Diagnostic[], error?: {code: string, message: string, retryable: boolean}}>}
 */
async function runRustDiagnostics(workspaceRoot, specificPath) {
  try {
    // cargo check doesn't support single-file checks well
    // so we run workspace-level check but filter results
    const args = ['check', '--message-format=json'];

    const { stdout, stderr } = await execFileAsync('cargo', args, {
      cwd: workspaceRoot,
      maxBuffer: 4_000_000,
      timeout: 120_000,
    });

    // Filter to specific path if requested
    let diagnostics = parseCargoOutput(stdout, workspaceRoot);
    if (specificPath) {
      const relativeSpecific = path.relative(workspaceRoot, specificPath);
      diagnostics = diagnostics.filter(d => d.file === relativeSpecific);
    }

    return { diagnostics };
  } catch (err) {
    // cargo check exits with code 101 on compile errors
    if (err.stdout) {
      let diagnostics = parseCargoOutput(err.stdout, workspaceRoot);
      if (specificPath) {
        const relativeSpecific = path.relative(workspaceRoot, specificPath);
        diagnostics = diagnostics.filter(d => d.file === relativeSpecific);
      }
      return { diagnostics };
    }

    if (err.code === 'ENOENT') {
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
        message: `Cargo check failed: ${err.message}`,
        retryable: true,
      },
    };
  }
}

function parseCargoOutput(output, workspaceRoot) {
  const diagnostics = [];
  const lines = output.split('\n');

  for (const line of lines) {
    try {
      const msg = JSON.parse(line);
      if (msg.reason === 'compiler-message' && msg.message) {
        const span = msg.message.spans?.[0];
        if (span) {
          diagnostics.push({
            file: path.relative(workspaceRoot, span.file_name),
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
 * @param {string} workspaceRoot
 * @param {string|null} specificPath
 * @returns {Promise<{diagnostics: Diagnostic[], error?: {code: string, message: string, retryable: boolean}}>}
 */
async function runGoDiagnostics(workspaceRoot, specificPath) {
  try {
    const args = ['vet'];
    if (specificPath) {
      args.push(specificPath);
    } else {
      args.push('./...');
    }

    const { stdout, stderr } = await execFileAsync('go', args, {
      cwd: workspaceRoot,
      maxBuffer: 4_000_000,
      timeout: 60_000,
    });

    const output = stdout || stderr;
    return { diagnostics: parseGoVetOutput(output, workspaceRoot) };
  } catch (err) {
    // go vet exits with code 1 on issues
    if (err.code === 1 && (err.stdout || err.stderr)) {
      const output = err.stdout || err.stderr;
      return { diagnostics: parseGoVetOutput(output, workspaceRoot) };
    }

    if (err.code === 'ENOENT') {
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
        message: `Go vet failed: ${err.message}`,
        retryable: true,
      },
    };
  }
}

function parseGoVetOutput(output, workspaceRoot) {
  const diagnostics = [];
  const lines = output.split('\n');

  // go vet output: file:line:col: message
  const pattern = /^(.+?):(\d+):(\d+):\s*(.+)$/;

  for (const line of lines) {
    const match = pattern.exec(line);
    if (match) {
      const [, file, lineStr, colStr, message] = match;
      diagnostics.push({
        file: path.relative(workspaceRoot, file.trim()),
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
 * @param {string} workspaceRoot
 * @param {string|null} specificPath - Optional relative path to filter diagnostics
 * @returns {Promise<{diagnostics: Diagnostic[], projectType: string|null, error?: {code: string, message: string, retryable: boolean}}>}
 */
export async function runDiagnostics(workspaceRoot, specificPath = null) {
  const { type: projectType } = await detectProjectType(workspaceRoot);

  if (!projectType) {
    return {
      diagnostics: [],
      projectType: null,
      error: {
        code: 'UNSUPPORTED_PROJECT_TYPE',
        message: 'No supported project type detected (tsconfig.json, pyproject.toml, Cargo.toml, go.mod)',
        retryable: false,
      },
    };
  }

  let result;
  switch (projectType) {
    case 'typescript':
    case 'node':
      result = await runTypeScriptDiagnostics(workspaceRoot, specificPath);
      break;
    case 'python':
      result = await runPythonDiagnostics(workspaceRoot, specificPath);
      break;
    case 'rust':
      result = await runRustDiagnostics(workspaceRoot, specificPath);
      break;
    case 'go':
      result = await runGoDiagnostics(workspaceRoot, specificPath);
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

/**
 * @typedef {Object} Diagnostic
 * @property {string} file - Relative path to file
 * @property {number} line - 1-indexed line number
 * @property {number} col - 1-indexed column number
 * @property {'error'|'warning'} severity - Severity level
 * @property {string} message - Human-readable message
 * @property {string} [code] - Optional error code (e.g., 'TS2322')
 */
