/**
 * OpenAI-format function schemas for CLI tools.
 * Used by providers that support native function calling (Mistral, OpenRouter).
 * Ollama falls back to prompt-engineered tool protocol.
 */

export const CLI_TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read file content with stable line hash anchors. Only works on files. Use start_line/end_line for large files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path to the file' },
          start_line: { type: 'integer', description: '1-indexed start line for range reads' },
          end_line: { type: 'integer', description: '1-indexed end line for range reads' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List files and directories in a path.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path to list (default: workspace root)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Text search in workspace files using ripgrep/grep.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Search pattern (regex or literal)' },
          path: { type: 'string', description: 'Subdirectory to search in' },
          max_results: { type: 'integer', description: 'Maximum matches to return (default: 120, max: 1000)' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the public web for current information (Tavily when configured, else Ollama native for provider=ollama+key, else DuckDuckGo fallback).',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          max_results: { type: 'integer', description: 'Maximum results to return (default: 5, max: 10)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'exec',
      description: 'Run a shell command in the workspace.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
          timeout_ms: { type: 'integer', description: 'Timeout in milliseconds (default: 90000, max: 180000)' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write full file content. Creates parent directories if needed.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path to write' },
          content: { type: 'string', description: 'Full file content' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Surgical hashline edits using 7-char content hashes. Prefer over full-file rewrites.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path to the file' },
          edits: {
            type: 'array',
            description: 'Array of HashlineOp edits',
            items: {
              type: 'object',
              properties: {
                op: { type: 'string', enum: ['replace_line', 'insert_after', 'insert_before', 'delete_line'], description: 'Edit operation' },
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
    type: 'function',
    function: {
      name: 'undo_edit',
      description: 'Restore a file from its most recent backup (created before each write_file/edit_file).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path to the file to restore' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_symbols',
      description: 'Extract function/class/type/interface declarations from a file with line numbers.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path to the file' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_status',
      description: 'Show workspace git status with structured breakdown (branch, staged, unstaged, untracked files).',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_diff',
      description: 'Show git diff with file-level change summary. Optionally for a specific file or staged changes.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Specific file to diff' },
          staged: { type: 'boolean', description: 'Show staged changes instead of unstaged' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_commit',
      description: 'Stage and commit files. Stages all files if paths not specified.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Commit message' },
          paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Specific files to stage (default: all)',
          },
        },
        required: ['message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_memory',
      description: 'Persist learnings across sessions (stored in .push/memory.md). Save project patterns, build commands, conventions.',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Memory content to save (replaces previous)' },
        },
        required: ['content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'coder_update_state',
      description: 'Update working memory (plan, tasks, files, assumptions, errors). No filesystem action.',
      parameters: {
        type: 'object',
        properties: {
          plan: { type: 'string', description: 'Current plan or approach' },
          openTasks: { type: 'array', items: { type: 'string' }, description: 'Remaining tasks' },
          filesTouched: { type: 'array', items: { type: 'string' }, description: 'Files read or modified' },
          assumptions: { type: 'array', items: { type: 'string' }, description: 'Working assumptions' },
          errorsEncountered: { type: 'array', items: { type: 'string' }, description: 'Errors seen' },
        },
        required: [],
      },
    },
  },
];

/**
 * Behavioral rules for tool use — injected into system prompt when native FC
 * replaces the full TOOL_PROTOCOL (which includes format instructions).
 */
export const TOOL_RULES = `Tool Rules:
- Paths are relative to workspace root unless absolute inside workspace.
- Never attempt paths outside workspace.
- You may emit multiple tool calls in one assistant reply.
- Emit at most one mutating tool call per reply; read-only calls can be batched.
- Prefer edit_file over full-file rewrites when possible.
- If a tool fails, correct the call and retry when appropriate.
- Do not describe tool calls in prose; use tool calls directly.`;
