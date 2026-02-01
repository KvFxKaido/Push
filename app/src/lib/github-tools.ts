/**
 * Prompt-engineered tool protocol for GitHub API access.
 *
 * The LLM outputs a JSON block when it wants to call a tool.
 * We detect it, execute against the GitHub API, and inject the
 * result back into the conversation as a synthetic message.
 */

const OAUTH_STORAGE_KEY = 'github_access_token';
const GITHUB_TOKEN = import.meta.env.VITE_GITHUB_TOKEN || '';

// --- Tool types ---

export type ToolCall =
  | { tool: 'fetch_pr'; args: { repo: string; pr: number } }
  | { tool: 'list_prs'; args: { repo: string; state?: string } };

// --- Auth helper (mirrors useGitHub / useRepos pattern) ---

function getGitHubHeaders(): Record<string, string> {
  const oauthToken = localStorage.getItem(OAUTH_STORAGE_KEY) || '';
  const authToken = oauthToken || GITHUB_TOKEN;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
  };
  if (authToken) {
    headers['Authorization'] = `token ${authToken}`;
  }
  return headers;
}

// --- Detection ---

/**
 * Scans the assistant's response for a JSON tool-call block.
 * Expects the format:
 * ```json
 * {"tool": "fetch_pr", "args": {"repo": "owner/repo", "pr": 42}}
 * ```
 */
export function detectToolCall(text: string): ToolCall | null {
  // Match fenced JSON blocks: ```json ... ``` or ``` ... ```
  const fenceRegex = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/g;
  let match;

  while ((match = fenceRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (parsed.tool && parsed.args) {
        // Validate known tools
        if (parsed.tool === 'fetch_pr' && parsed.args.repo && parsed.args.pr) {
          return { tool: 'fetch_pr', args: { repo: parsed.args.repo, pr: Number(parsed.args.pr) } };
        }
        if (parsed.tool === 'list_prs' && parsed.args.repo) {
          return { tool: 'list_prs', args: { repo: parsed.args.repo, state: parsed.args.state } };
        }
      }
    } catch {
      // Not valid JSON, skip this block
    }
  }

  // Also try bare JSON (no fences) — model sometimes omits backticks
  const bareRegex = /\{[\s\S]*?"tool"\s*:\s*"[^"]+?"[\s\S]*?\}/g;
  while ((match = bareRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[0]);
      if (parsed.tool && parsed.args) {
        if (parsed.tool === 'fetch_pr' && parsed.args.repo && parsed.args.pr) {
          return { tool: 'fetch_pr', args: { repo: parsed.args.repo, pr: Number(parsed.args.pr) } };
        }
        if (parsed.tool === 'list_prs' && parsed.args.repo) {
          return { tool: 'list_prs', args: { repo: parsed.args.repo, state: parsed.args.state } };
        }
      }
    } catch {
      // Not valid JSON
    }
  }

  return null;
}

// --- Execution ---

async function executeFetchPR(repo: string, pr: number): Promise<string> {
  const headers = getGitHubHeaders();

  // Fetch PR details
  const prRes = await fetch(`https://api.github.com/repos/${repo}/pulls/${pr}`, { headers });
  if (!prRes.ok) {
    throw new Error(`GitHub API returned ${prRes.status} for PR #${pr} on ${repo}`);
  }
  const prData = await prRes.json();

  // Fetch diff
  const diffRes = await fetch(`https://api.github.com/repos/${repo}/pulls/${pr}`, {
    headers: { ...headers, Accept: 'application/vnd.github.v3.diff' },
  });
  let diff = '';
  if (diffRes.ok) {
    diff = await diffRes.text();
    // Truncate large diffs to stay within context
    if (diff.length > 10_000) {
      diff = diff.slice(0, 10_000) + '\n\n[...diff truncated at 10K chars]';
    }
  }

  // Fetch files
  const filesRes = await fetch(`https://api.github.com/repos/${repo}/pulls/${pr}/files`, { headers });
  let filesSummary = '';
  if (filesRes.ok) {
    const files = await filesRes.json();
    filesSummary = files
      .slice(0, 20)
      .map((f: any) => `  ${f.status} ${f.filename} (+${f.additions} -${f.deletions})`)
      .join('\n');
    if (files.length > 20) {
      filesSummary += `\n  ...and ${files.length - 20} more files`;
    }
  }

  const lines: string[] = [
    `[Tool Result — fetch_pr]`,
    `Title: ${prData.title}`,
    `Author: ${prData.user.login}`,
    `State: ${prData.state}${prData.merged ? ' (merged)' : ''}`,
    `+${prData.additions} -${prData.deletions} across ${prData.changed_files} files`,
    `Created: ${new Date(prData.created_at).toLocaleDateString()}`,
    `Branch: ${prData.head.ref} → ${prData.base.ref}`,
  ];

  if (prData.body) {
    const desc = prData.body.length > 500 ? prData.body.slice(0, 500) + '...' : prData.body;
    lines.push(`\nDescription:\n${desc}`);
  }

  if (filesSummary) {
    lines.push(`\nFiles:\n${filesSummary}`);
  }

  if (diff) {
    lines.push(`\n--- Diff ---\n${diff}`);
  }

  return lines.join('\n');
}

async function executeListPRs(repo: string, state: string = 'open'): Promise<string> {
  const headers = getGitHubHeaders();

  const res = await fetch(
    `https://api.github.com/repos/${repo}/pulls?state=${state}&per_page=20&sort=updated&direction=desc`,
    { headers },
  );

  if (!res.ok) {
    throw new Error(`GitHub API returned ${res.status} for PRs on ${repo}`);
  }

  const prs = await res.json();

  if (prs.length === 0) {
    return `[Tool Result — list_prs]\nNo ${state} PRs found on ${repo}.`;
  }

  const lines: string[] = [
    `[Tool Result — list_prs]`,
    `${prs.length} ${state} PR${prs.length > 1 ? 's' : ''} on ${repo}:\n`,
  ];

  for (const pr of prs) {
    const age = new Date(pr.created_at).toLocaleDateString();
    lines.push(`  #${pr.number} — ${pr.title}`);
    lines.push(`    by ${pr.user.login} | +${pr.additions || '?'} -${pr.deletions || '?'} | ${age}`);
  }

  return lines.join('\n');
}

/**
 * Execute a detected tool call against the GitHub API.
 * Returns a formatted string result to inject into the conversation.
 */
export async function executeToolCall(call: ToolCall): Promise<string> {
  try {
    switch (call.tool) {
      case 'fetch_pr':
        return await executeFetchPR(call.args.repo, call.args.pr);
      case 'list_prs':
        return await executeListPRs(call.args.repo, call.args.state);
      default:
        return `[Tool Error] Unknown tool: ${(call as any).tool}`;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Diff] Tool execution error:`, msg);
    return `[Tool Error] ${msg}`;
  }
}

/**
 * Tool protocol instructions to include in the system prompt.
 * Tells the LLM what tools are available and how to call them.
 */
export const TOOL_PROTOCOL = `
TOOLS — You can request GitHub data by outputting a fenced JSON block:

\`\`\`json
{"tool": "fetch_pr", "args": {"repo": "owner/repo", "pr": 42}}
\`\`\`

Available tools:
- fetch_pr(repo, pr) — Fetch full PR details with diff
- list_prs(repo, state?) — List PRs (default state: "open")

Rules:
- Output ONLY the JSON block when requesting a tool — no other text in the same message
- Wait for the tool result before continuing your response
- The repo field should use "owner/repo" format matching the workspace context
- If the user asks about a PR or repo, use the appropriate tool to get real data
- Never fabricate PR data — always use a tool to fetch it`;
