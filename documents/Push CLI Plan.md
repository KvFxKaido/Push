# Push CLI Plan

Date: 2026-02-16  
Status: Draft  
Owner: Push

## Goal

Build a terminal interface for Push that reuses the existing agent infrastructure (Orchestrator, Coder, Auditor) without duplicating core logic or creating a separate repo.

## Why CLI?

- **Cost reduction** — Reuse existing AI subscriptions (Kimi, Mistral, Ollama, Z.ai, MiniMax) across mobile and desktop contexts
- **Desktop workflows** — Some coding tasks are better suited for terminal/IDE integration
- **No new subscriptions** — Push CLI uses the same backends as the mobile app
- **Faster local operations** — Direct git operations without Worker proxy
- **Offline capability** — Git operations work without network

## Core Insight: This Is NOT a Monorepo Problem

ChatGPT was right: this is just separation of concerns.

**We already have multiple projects in one repo:**
```
Push/
  app/        (mobile UI + worker proxy)
  sandbox/    (Modal backend)
```

Adding CLI is the same pattern — just another frontend for the same engine.

**We don't need:**
- ❌ Turborepo, Nx, or pnpm workspaces (yet)
- ❌ Complex build pipelines
- ❌ Publishing `core` as npm package
- ❌ Separate repos (leads to fragmentation)

**We just need:**
- ✅ Extract UI-agnostic logic to `core/`
- ✅ Use relative imports (no tooling required)
- ✅ Abstract browser dependencies (storage, etc.)

## Current State Analysis

**Good news:** `app/src/lib/` is already mostly UI-agnostic.

Pure logic (no React, no DOM):
- `orchestrator.ts`, `coder-agent.ts`, `auditor-agent.ts`
- `github-tools.ts`, `sandbox-tools.ts`, `scratchpad-tools.ts`, `web-search-tools.ts`
- `tool-dispatch.ts`
- `providers.ts`, `model-catalog.ts`
- `prompts.ts`, `diff-utils.ts`, `file-processing.ts`, `file-utils.ts`
- `types/index.ts`

Browser dependencies (need abstraction):
- `safe-storage.ts` — Uses `localStorage`/`sessionStorage`
- `orchestrator.ts` — Stores context mode in localStorage
- `workspace-context.ts` — May have browser assumptions
- `scratchpad-tools.ts` — References localStorage

All hooks in `app/src/hooks/` are React-specific (stay in app).

## Proposed Structure

```
Push/
├── core/              # NEW: UI-agnostic engine
│   ├── src/
│   │   ├── agents/    # orchestrator, coder, auditor
│   │   ├── tools/     # github, sandbox, scratchpad, web-search, tool-dispatch
│   │   ├── providers/ # AI backend configs, model catalog
│   │   ├── types/     # shared TypeScript types
│   │   └── utils/     # prompts, diff, storage abstraction, file processing
│   ├── package.json
│   └── tsconfig.json
├── app/               # EXISTING: Mobile PWA
│   └── src/
│       ├── lib/       # → Move most to ../core/src/
│       ├── hooks/     # Keep (React-specific)
│       ├── components/
│       └── types/     # → Move to ../core/src/types/
├── cli/               # NEW: Terminal interface
│   ├── src/
│   │   ├── commands/  # chat, code, commit, diff, branch, review
│   │   ├── ui/        # terminal rendering (streams, cards, spinners)
│   │   ├── config/    # ~/.push/config.json management
│   │   └── index.ts   # CLI entry point
│   ├── package.json
│   └── tsconfig.json
└── sandbox/           # EXISTING: Modal backend
```

## Implementation Plan

### Phase 0: Storage Abstraction (30 minutes)

Create `core/src/utils/storage.ts`:

```typescript
// Storage abstraction that CLI can override
export interface Storage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

// Browser implementation (app uses this)
export const browserStorage: Storage = {
  getItem: (key) => localStorage.getItem(key),
  setItem: (key, value) => localStorage.setItem(key, value),
  removeItem: (key) => localStorage.removeItem(key)
};

// CLI implementation (file-based)
export function fileStorage(basePath: string): Storage {
  // Read/write to ~/.push/${key}.json
  return {
    getItem: (key) => {
      const path = join(basePath, `${key}.json`);
      if (!existsSync(path)) return null;
      return readFileSync(path, 'utf-8');
    },
    setItem: (key, value) => {
      const path = join(basePath, `${key}.json`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, value, 'utf-8');
    },
    removeItem: (key) => {
      const path = join(basePath, `${key}.json`);
      if (existsSync(path)) unlinkSync(path);
    }
  };
}
```

Update functions that use localStorage to accept `storage` parameter.

### Phase 1: Extract Core (1 hour)

Create `core/` directory and move files:

```bash
mkdir -p core/src/{agents,tools,providers,types,utils}

# Agents
mv app/src/lib/orchestrator.ts      core/src/agents/
mv app/src/lib/coder-agent.ts       core/src/agents/
mv app/src/lib/auditor-agent.ts     core/src/agents/

# Tools
mv app/src/lib/github-tools.ts      core/src/tools/
mv app/src/lib/sandbox-tools.ts     core/src/tools/
mv app/src/lib/scratchpad-tools.ts  core/src/tools/
mv app/src/lib/web-search-tools.ts  core/src/tools/
mv app/src/lib/tool-dispatch.ts     core/src/tools/

# Providers
mv app/src/lib/providers.ts         core/src/providers/
mv app/src/lib/model-catalog.ts     core/src/providers/

# Types
mv app/src/types/index.ts           core/src/types/

# Utils
mv app/src/lib/prompts.ts           core/src/utils/
mv app/src/lib/diff-utils.ts        core/src/utils/
mv app/src/lib/file-processing.ts   core/src/utils/
mv app/src/lib/file-utils.ts        core/src/utils/
mv app/src/lib/safe-storage.ts      core/src/utils/storage.ts  # Rename + update
```

Update all internal imports within `core/` to use relative paths.

**Files that stay in `app/src/lib/`:**
- `codemirror-*` — Editor-specific
- `browser-metrics.ts` — Browser-specific
- `feature-flags.ts` — May reference env vars specific to Vite
- `sandbox-start-mode.ts` — May have UI coupling
- `snapshot-manager.ts` — May have UI coupling
- `workspace-context.ts` — Needs review (may be portable)
- `edit-metrics.ts` — Metrics specific to UI interactions
- `utils.ts` — General utils (may split portable parts to core)
- `worker-routes.test.ts` — Worker-specific

### Phase 2: Update App Imports (15 minutes)

Update imports in `app/src/` to point to `../../core/src/`:

Example in `app/src/hooks/useChat.ts`:
```typescript
// Before:
import { runOrchestrator } from '../lib/orchestrator';
import { executeGitHubToolCall } from '../lib/github-tools';

// After:
import { runOrchestrator } from '../../../core/src/agents/orchestrator';
import { executeGitHubToolCall } from '../../../core/src/tools/github-tools';
import { browserStorage } from '../../../core/src/utils/storage';

// Inject storage:
runOrchestrator({ 
  storage: browserStorage,
  // ... other params
})
```

### Phase 3: CLI Skeleton (2 hours)

Create CLI structure:

```bash
mkdir -p cli/src/{commands,ui,config}
cd cli && npm init -y
npm install commander chalk ora@5 node-fetch
npm install -D typescript @types/node
```

#### `cli/package.json`

```json
{
  "name": "push-cli",
  "version": "0.1.0",
  "type": "module",
  "bin": {
    "push": "./dist/index.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "link": "npm link"
  },
  "dependencies": {
    "commander": "^12.0.0",
    "chalk": "^5.3.0",
    "ora": "^5.4.1",
    "node-fetch": "^3.3.2"
  },
  "devDependencies": {
    "typescript": "~5.9.3",
    "@types/node": "^24.10.1"
  }
}
```

#### `cli/src/index.ts`

```typescript
#!/usr/bin/env node
import { Command } from 'commander';
import { chatCommand } from './commands/chat.js';
import { codeCommand } from './commands/code.js';
import { diffCommand } from './commands/diff.js';

const program = new Command();

program
  .name('push')
  .description('AI coding agent for your repos')
  .version('0.1.0');

program
  .command('chat <message>')
  .description('Start a conversation about your code')
  .option('-p, --provider <name>', 'AI provider (kimi, mistral, ollama, zai, minimax)')
  .action(chatCommand);

program
  .command('code <task>')
  .description('Delegate a coding task to the Coder agent')
  .option('-p, --provider <name>', 'AI provider')
  .action(codeCommand);

program
  .command('diff [base] [head]')
  .description('Show diff with AI analysis')
  .action(diffCommand);

program
  .command('branch <name>')
  .description('Create a new branch')
  .action((name) => {
    console.log(`Creating branch: ${name}`);
    // TODO: Use git + sandbox
  });

program
  .command('commit <message>')
  .description('Commit changes with AI review')
  .action((message) => {
    console.log(`Committing with: ${message}`);
    // TODO: Run Auditor before commit
  });

program.parse();
```

#### `cli/src/commands/chat.ts`

```typescript
import { runOrchestrator } from '../../../core/src/agents/orchestrator.js';
import { fileStorage } from '../../../core/src/utils/storage.js';
import { renderStream } from '../ui/stream.js';
import { loadConfig } from '../config/index.js';

export async function chatCommand(message: string, options: any) {
  const config = loadConfig();
  const storage = fileStorage(config.dataDir);
  const provider = options.provider || config.defaultProvider || 'kimi';

  console.log(`Using provider: ${provider}\n`);

  const stream = runOrchestrator({
    storage,
    provider,
    messages: [{ role: 'user', content: message }],
    repoContext: {
      owner: 'current',  // TODO: Read from git
      repo: 'current',
      branch: 'main'     // TODO: Read from git
    },
    // ... other config
  });

  await renderStream(stream);
}
```

#### `cli/src/ui/stream.ts`

```typescript
import chalk from 'chalk';
import ora from 'ora';

export async function renderStream(stream: AsyncIterable<any>) {
  let spinner: any = null;
  
  for await (const chunk of stream) {
    switch (chunk.type) {
      case 'think':
        if (!spinner) spinner = ora('Thinking...').start();
        spinner.text = chalk.dim(chunk.content);
        break;
        
      case 'text':
        if (spinner) { 
          spinner.stop(); 
          spinner = null; 
        }
        process.stdout.write(chunk.content);
        break;
        
      case 'tool_call':
        if (spinner) spinner.stop();
        console.log(chalk.cyan(`\n🔧 ${chunk.tool}`));
        console.log(chalk.dim(JSON.stringify(chunk.args, null, 2)));
        spinner = ora('Executing...').start();
        break;
        
      case 'tool_result':
        spinner?.succeed(chalk.green('✓ Done'));
        // Optionally show brief summary
        if (chunk.summary) {
          console.log(chalk.dim(chunk.summary));
        }
        spinner = null;
        break;
        
      case 'error':
        if (spinner) spinner.fail();
        console.error(chalk.red(`\n❌ Error: ${chunk.message}`));
        break;
    }
  }
  
  if (spinner) spinner.stop();
  console.log(); // Final newline
}
```

#### `cli/src/config/index.ts`

```typescript
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

interface Config {
  dataDir: string;
  defaultProvider: string;
  apiKeys: {
    moonshot?: string;
    mistral?: string;
    ollama?: string;
    zai?: string;
    minimax?: string;
  };
}

const CONFIG_PATH = join(homedir(), '.push', 'config.json');

export function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) {
    return {
      dataDir: join(homedir(), '.push'),
      defaultProvider: 'kimi',
      apiKeys: {}
    };
  }
  
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
}

export function saveConfig(config: Config): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}
```

### Phase 4: Testing (1 hour)

```bash
# Build CLI
cd cli
npm run build
npm link

# Test basic chat
push chat "what changed in the last commit"

# Test with provider selection
push chat "review this code" --provider mistral

# Test code delegation
push code "add error handling to auth flow"
```

### Phase 5: Git Integration (2 hours)

Add git awareness to CLI:

```bash
npm install simple-git
```

Read current repo/branch context:
```typescript
import simpleGit from 'simple-git';

export async function getGitContext() {
  const git = simpleGit();
  const status = await git.status();
  const remote = await git.remote(['get-url', 'origin']);
  
  // Parse owner/repo from remote URL
  const match = remote.match(/github\.com[:/]([^/]+)\/([^.]+)/);
  
  return {
    owner: match?.[1] || 'unknown',
    repo: match?.[2] || 'unknown',
    branch: status.current || 'main',
    isClean: status.files.length === 0
  };
}
```

## MVP Commands

### Essential (Phase 3)
- `push chat <message>` — Start conversation with repo context
- `push code <task>` — Delegate coding task to Coder agent

### Git Operations (Phase 5)
- `push diff [base] [head]` — Show diff with AI context
- `push branch <name>` — Create branch
- `push commit <message>` — Commit with Auditor review

### Later Enhancements
- `push review <pr-number>` — Review PR
- `push merge` — Merge current branch (with Auditor gate)
- `push status` — Show repo status + active background jobs
- `push config` — Manage ~/.push/config.json
- `push watch` — File watcher + auto-commit on save

## Configuration

### `~/.push/config.json`

```json
{
  "dataDir": "~/.push",
  "defaultProvider": "kimi",
  "apiKeys": {
    "moonshot": "sk-...",
    "mistral": "...",
    "ollama": "...",
    "zai": "...",
    "minimax": "..."
  },
  "github": {
    "token": "ghp_..."
  }
}
```

### Per-Repo Config

`.pushrc` (optional):
```json
{
  "provider": "mistral",
  "defaultBranch": "main",
  "protectMain": true
}
```

## Authentication

Two approaches:

1. **Reuse app config** — Read API keys from `app/.env`
2. **Separate CLI config** — Store in `~/.push/config.json`

Start with #2 (simpler, no coupling).

## Terminal UI Guidelines

### Stream Rendering
- **Think tokens** — Gray, dimmed, with spinner
- **Text output** — Normal, streaming character-by-character feel
- **Tool calls** — Cyan, with tool name + collapsed args
- **Tool results** — Green checkmark, optional summary
- **Errors** — Red, with clear error message

### Card Rendering
Convert rich UI cards to terminal-friendly output:

**DiffPreviewCard** → Syntax-highlighted diff
```bash
📄 src/auth.ts
  + Added error handling
  + Retry logic for token refresh

  @@ -45,3 +45,8 @@
  +  try {
  +    await refreshToken();
  +  } catch (err) {
  +    console.error('Token refresh failed', err);
  +  }
```

**PRCard** → Compact PR summary
```bash
PR #123: Add background jobs
  ✓ CI passing
  ⚠ 2 reviews required
  📝 12 files changed (+450, -120)
```

**SandboxCard** → Execution summary
```bash
🐚 Sandbox
  ✓ npm test (247 passed)
  ✓ npm run build (0.8s)
  📦 Workspace ready at /workspace
```

## Distribution

### Development
```bash
cd cli
npm link
push chat "hello"
```

### npm Package (later)
```bash
npm install -g @push/cli
```

### Standalone Binary (much later)
Use `pkg` or `nexe` to bundle Node.js + CLI into single binary.

## Cost Comparison

**Before:**
- ❌ $125/mo Claude Pro (canceled)
- ✅ Pay-as-you-go for Kimi/Mistral/Ollama/Z.ai/MiniMax

**With Push CLI:**
- ✅ Reuse same AI subscriptions (no new cost)
- ✅ Reuse same Worker/Modal infrastructure
- ✅ No desktop IDE subscription needed
- ✅ Can work offline for git operations

## Open Questions

1. **Should CLI hit Worker endpoints or call providers directly?**
   - Option A: Direct provider calls (lower latency, works offline)
   - Option B: Proxy via Worker (unified logging, rate limiting)
   - **Recommendation:** Start with A, add B as opt-in

2. **Should CLI reuse Modal sandbox or run local Docker?**
   - Option A: Reuse Modal (consistency with app)
   - Option B: Local Docker (faster, no API roundtrip)
   - **Recommendation:** Start with A, detect local Docker as optimization

3. **Should CLI support all providers or subset?**
   - **Recommendation:** Support all 5 (same as app)

4. **Should CLI have interactive mode or command-only?**
   - **Recommendation:** Start command-only, add interactive REPL later

5. **Should background jobs be CLI-compatible?**
   - **Recommendation:** Yes! `push code --background <task>` can poll DO for job status

## Success Metrics

- [ ] `push chat` works end-to-end
- [ ] Streaming output feels native
- [ ] Tool calls render clearly in terminal
- [ ] Can switch providers via flag
- [ ] Reads current repo/branch from git
- [ ] Zero new AI subscription cost
- [ ] Reuses 100% of core agent logic
- [ ] `npm link` workflow is smooth

## Timeline Estimate

- **Phase 0:** Storage abstraction — 30 minutes
- **Phase 1:** Extract core — 1 hour
- **Phase 2:** Update app imports — 15 minutes
- **Phase 3:** CLI skeleton — 2 hours
- **Phase 4:** Testing — 1 hour
- **Phase 5:** Git integration — 2 hours

**Total MVP: ~7 hours**

## Next Actions

1. Validate storage abstraction approach
2. Decide on direct provider calls vs Worker proxy
3. Start with Phase 0 (storage abstraction)
4. Test with single command (`push chat`) before expanding

## References

- Claude Code CLI — Reference for str_replace edit tool pattern
- Codex CLI — Reference for background job architecture
- GitHub Copilot CLI — Reference for streaming UX and task tool pattern
