/**
 * OpenAI-format function schemas for web app tools.
 * Used by providers that support native function calling (Mistral, OpenRouter).
 * Ollama falls back to prompt-engineered tool protocol.
 */

// ---------------------------------------------------------------------------
// GitHub tools
// ---------------------------------------------------------------------------

const GITHUB_TOOL_SCHEMAS = [
  {
    type: 'function' as const,
    function: {
      name: 'fetch_pr',
      description: 'Fetch full PR details with diff.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository in owner/repo format' },
          pr: { type: 'integer', description: 'PR number' },
        },
        required: ['repo', 'pr'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_prs',
      description: 'List pull requests.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository in owner/repo format' },
          state: { type: 'string', description: 'Filter by state: open, closed, all (default: open)' },
        },
        required: ['repo'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_commits',
      description: 'List recent commits.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository in owner/repo format' },
          count: { type: 'integer', description: 'Number of commits (default: 10, max: 30)' },
        },
        required: ['repo'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_file',
      description: 'Read a single file from the repo. Only works on files. Use start_line/end_line for large files.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository in owner/repo format' },
          path: { type: 'string', description: 'File path within the repo' },
          branch: { type: 'string', description: 'Branch name (default: repo default branch)' },
          start_line: { type: 'integer', description: '1-indexed start line for range reads' },
          end_line: { type: 'integer', description: '1-indexed end line for range reads' },
        },
        required: ['repo', 'path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'grep_file',
      description: 'Search within a single file for a pattern. Returns matching lines with context.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository in owner/repo format' },
          path: { type: 'string', description: 'File path within the repo' },
          pattern: { type: 'string', description: 'Search pattern (regex or substring)' },
          branch: { type: 'string', description: 'Branch name' },
        },
        required: ['repo', 'path', 'pattern'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_directory',
      description: 'List files and folders in a directory.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository in owner/repo format' },
          path: { type: 'string', description: 'Directory path (default: repo root)' },
          branch: { type: 'string', description: 'Branch name' },
        },
        required: ['repo'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_branches',
      description: 'List branches with default/protected status.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository in owner/repo format' },
        },
        required: ['repo'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'delegate_coder',
      description: 'Delegate coding to the Coder agent (requires sandbox). Use "task" for one task, or "tasks" array for batch.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'Single task description' },
          tasks: { type: 'array', items: { type: 'string' }, description: 'Array of independent tasks for batch execution' },
          files: { type: 'array', items: { type: 'string' }, description: 'Relevant file paths for context' },
          acceptanceCriteria: {
            type: 'array',
            description: 'Machine-checkable acceptance checks run after the Coder finishes',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Check identifier' },
                check: { type: 'string', description: 'Shell command to run' },
                exitCode: { type: 'integer', description: 'Expected exit code (default: 0)' },
                description: { type: 'string', description: 'Human-readable description' },
              },
              required: ['id', 'check'],
            },
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'fetch_checks',
      description: 'Get CI/CD status for a commit.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository in owner/repo format' },
          ref: { type: 'string', description: 'Commit SHA or branch (default: HEAD of default branch)' },
        },
        required: ['repo'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'search_files',
      description: 'Search for code/text across the repo.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository in owner/repo format' },
          query: { type: 'string', description: 'Search query' },
          path: { type: 'string', description: 'Path to limit scope (e.g., "src/")' },
          branch: { type: 'string', description: 'Branch name (best-effort)' },
        },
        required: ['repo', 'query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_commit_files',
      description: 'List files changed in a commit without the full diff.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository in owner/repo format' },
          ref: { type: 'string', description: 'Commit SHA, branch, or tag' },
        },
        required: ['repo', 'ref'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'trigger_workflow',
      description: 'Trigger a workflow_dispatch event.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository in owner/repo format' },
          workflow: { type: 'string', description: 'Workflow filename (e.g. "deploy.yml") or ID' },
          ref: { type: 'string', description: 'Git ref to trigger on (default: default branch)' },
          inputs: {
            type: 'object',
            description: 'Workflow input key-value pairs',
            additionalProperties: { type: 'string' },
          },
        },
        required: ['repo', 'workflow'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_workflow_runs',
      description: 'List recent GitHub Actions runs.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository in owner/repo format' },
          workflow: { type: 'string', description: 'Filter by workflow name or file' },
          branch: { type: 'string', description: 'Filter by branch' },
          status: { type: 'string', description: 'Filter by status: completed, in_progress, queued' },
          count: { type: 'integer', description: 'Number of runs (default: 10, max: 20)' },
        },
        required: ['repo'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_workflow_logs',
      description: 'Get job-level and step-level details for a workflow run.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository in owner/repo format' },
          run_id: { type: 'integer', description: 'Workflow run ID' },
        },
        required: ['repo', 'run_id'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'create_branch',
      description: 'Create a new branch.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository in owner/repo format' },
          branch_name: { type: 'string', description: 'New branch name' },
          from_ref: { type: 'string', description: 'Base ref (default: default branch)' },
        },
        required: ['repo', 'branch_name'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'create_pr',
      description: 'Create a pull request.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository in owner/repo format' },
          title: { type: 'string', description: 'PR title' },
          body: { type: 'string', description: 'PR description' },
          head: { type: 'string', description: 'Source branch' },
          base: { type: 'string', description: 'Target branch (e.g., "main")' },
        },
        required: ['repo', 'title', 'body', 'head', 'base'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'merge_pr',
      description: 'Merge a pull request.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository in owner/repo format' },
          pr_number: { type: 'integer', description: 'PR number' },
          merge_method: { type: 'string', description: 'merge, squash, or rebase (default: merge)' },
        },
        required: ['repo', 'pr_number'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'delete_branch',
      description: 'Delete a branch.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository in owner/repo format' },
          branch_name: { type: 'string', description: 'Branch to delete' },
        },
        required: ['repo', 'branch_name'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'check_pr_mergeable',
      description: 'Check if a PR can be merged. Returns mergeable status, conflicts, and CI results.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository in owner/repo format' },
          pr_number: { type: 'integer', description: 'PR number' },
        },
        required: ['repo', 'pr_number'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'find_existing_pr',
      description: 'Find an open PR for a branch.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository in owner/repo format' },
          head_branch: { type: 'string', description: 'Source branch to look for' },
          base_branch: { type: 'string', description: 'Target branch (default: main)' },
        },
        required: ['repo', 'head_branch'],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Sandbox tools
// ---------------------------------------------------------------------------

const SANDBOX_TOOL_SCHEMAS = [
  {
    type: 'function' as const,
    function: {
      name: 'sandbox_exec',
      description: 'Run a shell command in the sandbox.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
          workdir: { type: 'string', description: 'Working directory (default: /workspace)' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'sandbox_read_file',
      description: 'Read a file from the sandbox filesystem. Use start_line/end_line for large files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path in sandbox' },
          start_line: { type: 'integer', description: '1-indexed start line' },
          end_line: { type: 'integer', description: '1-indexed end line' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'sandbox_search',
      description: 'Search file contents in the sandbox (uses rg/grep).',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search pattern' },
          path: { type: 'string', description: 'Directory to search in' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'sandbox_edit_file',
      description: 'Edit a file using 7-char content hashes (hashline edits).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path in sandbox' },
          edits: {
            type: 'array',
            description: 'Array of HashlineOp edits',
            items: {
              type: 'object',
              properties: {
                op: { type: 'string', enum: ['replace_line', 'insert_after', 'insert_before', 'delete_line'] },
                ref: { type: 'string', description: '7-char content hash of the target line' },
                content: { type: 'string', description: 'New content (not needed for delete_line)' },
              },
              required: ['op', 'ref'],
            },
          },
          expected_version: { type: 'string', description: 'Content version hash for staleness detection' },
        },
        required: ['path', 'edits'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'sandbox_write_file',
      description: 'Write or overwrite a file in the sandbox.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path in sandbox' },
          content: { type: 'string', description: 'Full file content' },
          expected_version: { type: 'string', description: 'Content version hash for staleness detection' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'sandbox_list_dir',
      description: 'List files and folders in a sandbox directory.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path (default: /workspace)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'sandbox_diff',
      description: 'Get the git diff of all uncommitted changes.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'sandbox_prepare_commit',
      description: 'Prepare a commit for review. Runs Auditor for safety check. User must approve via UI.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Commit message (conventional commit format)' },
        },
        required: ['message'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'sandbox_push',
      description: 'Retry a failed push. Use only if a push failed after approval.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'sandbox_run_tests',
      description: 'Run the test suite. Auto-detects framework if not specified.',
      parameters: {
        type: 'object',
        properties: {
          framework: { type: 'string', description: 'Test framework: npm, pytest, cargo, go' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'sandbox_check_types',
      description: 'Run type checker (tsc, pyright, mypy). Auto-detects from config files.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'sandbox_browser_screenshot',
      description: 'Take a screenshot of a URL in the sandbox browser.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to screenshot' },
          fullPage: { type: 'boolean', description: 'Capture full page (default: false)' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'sandbox_browser_extract',
      description: 'Extract content from a URL using the sandbox browser.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to extract from' },
          instruction: { type: 'string', description: 'What to extract' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'sandbox_download',
      description: 'Download workspace files as a compressed archive (tar.gz).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to download (default: /workspace)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'sandbox_save_draft',
      description: 'Quick-save uncommitted changes to a draft branch. Skips Auditor review.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Commit message (default: "WIP: draft save")' },
          branch_name: { type: 'string', description: 'Draft branch name (auto-created if needed)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'promote_to_github',
      description: 'Create a new GitHub repo, set remote, and push current branch.',
      parameters: {
        type: 'object',
        properties: {
          repo_name: { type: 'string', description: 'New repository name' },
          description: { type: 'string', description: 'Repository description' },
          private: { type: 'boolean', description: 'Private repo (default: true)' },
        },
        required: ['repo_name'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'sandbox_read_symbols',
      description: 'Extract symbol index from a source file (functions, classes, types with line numbers).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path in sandbox' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'sandbox_apply_patchset',
      description: 'Apply hashline edits to multiple files with all-or-nothing validation.',
      parameters: {
        type: 'object',
        properties: {
          edits: {
            type: 'array',
            description: 'Array of per-file edits',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string', description: 'File path' },
                ops: {
                  type: 'array',
                  description: 'HashlineOp edits for this file',
                  items: {
                    type: 'object',
                    properties: {
                      op: { type: 'string', enum: ['replace_line', 'insert_after', 'insert_before', 'delete_line'] },
                      ref: { type: 'string', description: '7-char content hash' },
                      content: { type: 'string' },
                    },
                    required: ['op', 'ref'],
                  },
                },
              },
              required: ['path', 'ops'],
            },
          },
          dryRun: { type: 'boolean', description: 'Validate without writing (default: false)' },
        },
        required: ['edits'],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Scratchpad tools
// ---------------------------------------------------------------------------

const SCRATCHPAD_TOOL_SCHEMAS = [
  {
    type: 'function' as const,
    function: {
      name: 'set_scratchpad',
      description: 'Replace the entire scratchpad content.',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'New scratchpad content (replaces existing)' },
        },
        required: ['content'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'append_scratchpad',
      description: 'Append to the existing scratchpad content.',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Content to append' },
        },
        required: ['content'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_scratchpad',
      description: 'Read the current scratchpad content.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Web search tool
// ---------------------------------------------------------------------------

const WEB_SEARCH_TOOL_SCHEMA = {
  type: 'function' as const,
  function: {
    name: 'web_search',
    description: 'Search the web for current information.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
    },
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

interface GetToolSchemasOptions {
  hasSandbox?: boolean;
  hasGitHub?: boolean;
  providerType?: 'ollama' | 'mistral' | 'openrouter';
}

type NativeToolSchema =
  | (typeof GITHUB_TOOL_SCHEMAS)[number]
  | (typeof SANDBOX_TOOL_SCHEMAS)[number]
  | (typeof SCRATCHPAD_TOOL_SCHEMAS)[number]
  | typeof WEB_SEARCH_TOOL_SCHEMA;

/**
 * Returns filtered tool schemas based on what's available in the current session.
 * GitHub tools are included when a repo is connected, sandbox tools when sandbox is active.
 * Scratchpad tools are always included.
 */
export function getToolSchemas(options: GetToolSchemasOptions = {}): NativeToolSchema[] {
  const schemas: NativeToolSchema[] = [];

  if (options.hasGitHub) {
    schemas.push(...GITHUB_TOOL_SCHEMAS);
  }

  if (options.hasSandbox) {
    schemas.push(...SANDBOX_TOOL_SCHEMAS);
  }

  schemas.push(...SCRATCHPAD_TOOL_SCHEMAS);

  // Web search — Mistral handles it natively via its web_search tool type,
  // OpenRouter models generally support it as a function schema
  if (options.providerType === 'openrouter') {
    schemas.push(WEB_SEARCH_TOOL_SCHEMA);
  }

  return schemas;
}

/** Sandbox-only schemas for the Coder agent (no GitHub tools, no scratchpad). */
export function getCoderToolSchemas(): typeof SANDBOX_TOOL_SCHEMAS {
  return [...SANDBOX_TOOL_SCHEMAS];
}
