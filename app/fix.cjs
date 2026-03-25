const fs = require('fs');

// 1. Fix useAgentDelegation.ts
let d = fs.readFileSync('src/hooks/useAgentDelegation.ts', 'utf8');
d = d.replace(
  "import { streamChat, getActiveProvider } from '@/lib/orchestrator';",
  "import { getActiveProvider, type ActiveProvider } from '@/lib/orchestrator';"
);
d = d.replace(
  "import { BranchInfo } from '@/hooks/useBranchManager';",
  "import type { BranchInfo } from '@/hooks/useBranchManager';"
);
d = d.replace(
  "updateAgentStatus: (status: Partial<AgentStatus>, meta?: { chatId: string; source?: AgentStatusSource }) => void;",
  "updateAgentStatus: (status: AgentStatus, meta?: { chatId?: string; source?: AgentStatusSource; log?: boolean }) => void;"
);
d = d.replace(
  "branchInfoRef: React.MutableRefObject<BranchInfo | null>;",
  "branchInfoRef: React.MutableRefObject<{ currentBranch?: string; defaultBranch?: string } | null>;"
);
d = d.replace(
  "provider: lockedProviderForChat,",
  "provider: lockedProviderForChat as AIProviderType,"
);
d = d.replace(
  "providerOverride: lockedProviderForChat,",
  "providerOverride: lockedProviderForChat as ActiveProvider | undefined,"
);
d = d.replace(
  "lockedProviderForChat,",
  "lockedProviderForChat as ActiveProvider | undefined,"
);
d = d.replace(
  "lockedProviderForChat,",
  "lockedProviderForChat as ActiveProvider | undefined,"
);
d = d.replace(
  "providerOverride: lockedProviderForChat,",
  "providerOverride: lockedProviderForChat as ActiveProvider | undefined,"
);
fs.writeFileSync('src/hooks/useAgentDelegation.ts', d);

// 2. Fix useChat.ts
let c = fs.readFileSync('src/hooks/useChat.ts', 'utf8');
c = c.replace(/import \{ streamChat, getActiveProvider, estimateContextTokens, getContextBudget, type ActiveProvider \} from '@\/lib\/orchestrator';\nimport \{ detectAnyToolCall, executeAnyToolCall, detectAllToolCalls \} from '@\/lib\/tool-dispatch';\nimport \{ generateCheckpointAnswer, summarizeCoderStateForHandoff \} from '@\/lib\/coder-agent';/s, 
  "import { streamChat, getActiveProvider, estimateContextTokens, getContextBudget, type ActiveProvider } from '@/lib/orchestrator';\nimport { detectAnyToolCall, executeAnyToolCall, detectAllToolCalls } from '@/lib/tool-dispatch';"
);
c = c.replace(/import \{ formatElapsedTime \} from '@\/lib\/utils';\n/, '');
c = c.replace(/import \{ useAgentDelegation \} from '@\/hooks\/useAgentDelegation';\n/, '');
c = c.replace(/\/\*\*[\s\S]*?function getTaskStatusLabel[\s\S]*?\}\n/m, '');
fs.writeFileSync('src/hooks/useChat.ts', c);

// 3. Fix test file
let t = fs.readFileSync('src/lib/file-awareness-ledger.test.ts', 'utf8');
t = t.replace(/expect\(result\.reason\)/g, 'expect((result as any).reason)');
t = t.replace(/expect\(r1\.reason\)/g, 'expect((r1 as any).reason)');
t = t.replace(/expect\(r2\.reason\)/g, 'expect((r2 as any).reason)');
fs.writeFileSync('src/lib/file-awareness-ledger.test.ts', t);
