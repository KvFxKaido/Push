/**
 * Todo tools — the model's own task list for the current effort.
 *
 * Sibling to the scratchpad, but different purpose:
 *   - Scratchpad is long-lived user-facing memory (notes, decisions, context).
 *   - Todo is ephemeral model-facing step tracking ("do A, then B, then C").
 *
 * Persistence mirrors the scratchpad (repo-scoped localStorage on the Web
 * shell) so a task list survives a chat restart, but the model is encouraged
 * to treat it as working state for the current effort and clear it when the
 * task ships.
 *
 * Tools:
 *   - todo_write: replace the entire list (atomic snapshot — matches the
 *     Claude Code TodoWrite convention).
 *   - todo_read:  read the current list (usually redundant since the list is
 *     already rendered into the system prompt every turn).
 *   - todo_clear: wipe the list — call after shipping so the next effort
 *     starts fresh.
 *
 * Security notes:
 *   - Content is escaped to prevent breaking out of the [TODO] delimiter.
 *   - Item count and per-item content length are capped.
 */

import { detectToolFromText } from './tool-call-parsing.js';
import { getToolArgHint, getToolPublicName, resolveToolName } from './tool-registry.js';

// Caps — keep the list focused and bound context cost. A longer list is a
// smell: either break the work down or ship what's done and reset.
export const MAX_TODO_ITEMS = 30;
export const MAX_TODO_CONTENT_LENGTH = 500;

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  id: string;
  /** Imperative form: "Fix the auth bug". */
  content: string;
  /** Present continuous form shown while the item is active: "Fixing the auth bug". */
  activeForm: string;
  status: TodoStatus;
}

export interface TodoWriteArgs {
  todos: TodoItem[];
}

export type TodoToolCall =
  | { tool: 'todo_write'; todos: TodoItem[] }
  | { tool: 'todo_read' }
  | { tool: 'todo_clear' };

/**
 * Protocol prompt for the orchestrator system prompt.
 *
 * Framed as working memory for the current effort so the model reaches for
 * this tool instead of narrating planned steps in prose.
 */
export const TODO_TOOL_PROTOCOL = `
## Todo Tools

You have a structured todo list for the current effort. It is separate from the scratchpad: the scratchpad is for notes, decisions, and context; the todo list is for the concrete steps you are executing right now.

The current list is rendered in the [TODO] block above on every turn — read it there rather than calling ${getToolPublicName('todo_read')}. Update it with ${getToolPublicName('todo_write')} as you plan, progress, and finish work.

### ${getToolPublicName('todo_write')}
Replace the entire list with a new snapshot. Each item has:
- \`id\` — short stable identifier (e.g. "fix-auth")
- \`content\` — imperative form ("Fix the auth bug in useAuth.ts:42")
- \`activeForm\` — present continuous form ("Fixing the auth bug in useAuth.ts:42")
- \`status\` — one of \`pending\`, \`in_progress\`, \`completed\`

\`\`\`json
${getToolArgHint('todo_write')}
\`\`\`

### ${getToolPublicName('todo_read')}
Read the current list (usually unnecessary — it's already in context above):
\`\`\`json
${getToolArgHint('todo_read')}
\`\`\`

### ${getToolPublicName('todo_clear')}
Wipe the list. Call this after you ship so the next effort starts clean:
\`\`\`json
${getToolArgHint('todo_clear')}
\`\`\`

**When to use:**
- Any task that needs 3+ distinct steps — plan it up-front with ${getToolPublicName('todo_write')}.
- Before starting work on a step, mark exactly one item \`in_progress\`.
- As soon as a step is actually done (code written, tests green, etc.), mark it \`completed\` and move on — do not batch completions.
- If you discover new work, add it to the list rather than carrying it in prose.

**Discipline:**
- At most one item is \`in_progress\` at a time.
- Never mark an item \`completed\` if it's blocked, partially done, or failing verification — keep it \`in_progress\` and log the blocker in the scratchpad.
- Keep the list tight. Remove items that turned out to be irrelevant rather than leaving them pending forever.
`;

/**
 * Detect a todo tool call in text. Handles both flat and args-wrapped forms.
 */
export function detectTodoToolCall(text: string): TodoToolCall | null {
  return detectToolFromText<TodoToolCall>(text, (parsed) => {
    if (typeof parsed !== 'object' || parsed === null || !('tool' in parsed)) {
      return null;
    }
    const rawTool = (parsed as { tool?: unknown }).tool;
    const resolved = resolveToolName(typeof rawTool === 'string' ? rawTool : undefined);
    if (resolved === 'todo_read') {
      return { tool: 'todo_read' };
    }
    if (resolved === 'todo_clear') {
      return { tool: 'todo_clear' };
    }
    if (resolved !== 'todo_write') return null;

    // Accept both flat `{tool, todos}` and wrapped `{tool, args: {todos}}`.
    const record = parsed as Record<string, unknown>;
    const wrapped =
      typeof record.args === 'object' && record.args !== null
        ? (record.args as Record<string, unknown>)
        : null;
    const rawTodos = Array.isArray(record.todos)
      ? record.todos
      : wrapped && Array.isArray(wrapped.todos)
        ? (wrapped.todos as unknown[])
        : null;
    if (!rawTodos) return null;

    const todos = rawTodos
      .map((entry) => normalizeTodoItem(entry))
      .filter((entry): entry is TodoItem => entry !== null);
    return { tool: 'todo_write', todos };
  });
}

function normalizeTodoItem(entry: unknown): TodoItem | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const record = entry as Record<string, unknown>;
  const content = typeof record.content === 'string' ? record.content.trim() : '';
  if (!content) return null;
  const activeForm =
    typeof record.activeForm === 'string' && record.activeForm.trim().length > 0
      ? record.activeForm.trim()
      : content;
  const status = normalizeStatus(record.status);
  const rawId = typeof record.id === 'string' ? record.id.trim() : '';
  const id = rawId || fallbackId(content);
  return { id, content, activeForm, status };
}

function normalizeStatus(value: unknown): TodoStatus {
  if (value === 'in_progress' || value === 'completed') return value;
  return 'pending';
}

function fallbackId(content: string): string {
  return content
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export interface TodoExecuteHandlers {
  replace: (todos: TodoItem[]) => void;
  clear: () => void;
}

/**
 * Execute a todo tool call. Mirrors executeScratchpadToolCall's shape.
 */
export function executeTodoToolCall(
  call: TodoToolCall,
  currentTodos: readonly TodoItem[],
  handlers: TodoExecuteHandlers,
): { text: string; ok: boolean } {
  if (call.tool === 'todo_read') {
    if (currentTodos.length === 0) {
      return { text: '[Todo list is empty — call todo_write to populate it]', ok: true };
    }
    return {
      text: `[Todo list (${currentTodos.length} items)]\n${renderTodoList(currentTodos)}`,
      ok: true,
    };
  }

  if (call.tool === 'todo_clear') {
    try {
      handlers.clear();
      return { text: '[Todo list cleared]', ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { text: `[Todo error: failed to clear — ${msg}]`, ok: false };
    }
  }

  if (call.tool === 'todo_write') {
    if (call.todos.length > MAX_TODO_ITEMS) {
      return {
        text: `[Todo error: list exceeds ${MAX_TODO_ITEMS} items (got ${call.todos.length}). Ship what's done, clear, and restart with a smaller plan.]`,
        ok: false,
      };
    }
    for (const item of call.todos) {
      if (item.content.length > MAX_TODO_CONTENT_LENGTH) {
        return {
          text: `[Todo error: item "${item.id}" content exceeds ${MAX_TODO_CONTENT_LENGTH} chars. Break it into smaller items.]`,
          ok: false,
        };
      }
    }
    const inProgressCount = call.todos.filter((t) => t.status === 'in_progress').length;
    if (inProgressCount > 1) {
      return {
        text: `[Todo error: only one item may be in_progress at a time (got ${inProgressCount}). Mark the others pending or completed.]`,
        ok: false,
      };
    }

    // Stabilise ids so duplicate-id updates replace rather than append.
    const deduped = dedupeTodoIds(call.todos);

    try {
      handlers.replace(deduped);
      return {
        text: `[Todo updated — ${deduped.length} items (${countByStatus(deduped)})]`,
        ok: true,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { text: `[Todo error: failed to update — ${msg}]`, ok: false };
    }
  }

  return { text: '[Todo tool error: unknown action]', ok: false };
}

function dedupeTodoIds(todos: TodoItem[]): TodoItem[] {
  const seen = new Set<string>();
  const out: TodoItem[] = [];
  for (const todo of todos) {
    let id = todo.id;
    let suffix = 1;
    while (seen.has(id)) {
      id = `${todo.id}-${suffix++}`;
    }
    seen.add(id);
    out.push({ ...todo, id });
  }
  return out;
}

function countByStatus(todos: readonly TodoItem[]): string {
  let done = 0;
  let active = 0;
  let pending = 0;
  for (const t of todos) {
    if (t.status === 'completed') done++;
    else if (t.status === 'in_progress') active++;
    else pending++;
  }
  return `${done} done, ${active} in progress, ${pending} pending`;
}

function renderTodoList(todos: readonly TodoItem[]): string {
  return todos
    .map((todo) => {
      const marker = todo.status === 'completed' ? 'x' : todo.status === 'in_progress' ? '~' : ' ';
      const label = todo.status === 'in_progress' ? todo.activeForm : todo.content;
      return `- [${marker}] ${label}`;
    })
    .join('\n');
}

/**
 * Build the todo context block for the system prompt.
 *
 * Escapes delimiter sequences (mirror of buildScratchpadContext) to prevent
 * a malicious todo entry from breaking out of the [TODO] block.
 */
export function buildTodoContext(todos: readonly TodoItem[]): string {
  if (todos.length === 0) {
    return '[TODO]\n(empty — call todo_write with a plan when you start a multi-step task)\n[/TODO]';
  }

  const rendered = todos
    .map((todo) => {
      const marker = todo.status === 'completed' ? 'x' : todo.status === 'in_progress' ? '~' : ' ';
      const label = todo.status === 'in_progress' ? todo.activeForm : todo.content;
      const escaped = label.replace(/\[TODO\]/gi, '[TODO​]').replace(/\[\/TODO\]/gi, '[/TODO​]');
      return `- [${marker}] ${escaped}`;
    })
    .join('\n');

  return `[TODO]\n${rendered}\n[/TODO]`;
}
