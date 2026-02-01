export type AppState = 'home' | 'running' | 'results' | 'repos';

export type AgentRole = 'orchestrator' | 'coder' | 'auditor';

export type AIProviderType = 'ollama-cloud';

export interface AIModel {
  id: string;
  name: string;
  provider: AIProviderType;
  role?: AgentRole;
  context?: number;
}

export interface AIProviderConfig {
  type: AIProviderType;
  name: string;
  description: string;
  models: AIModel[];
  envKey: string;
  envUrl?: string;
}

export interface PRInput {
  owner: string;
  repo: string;
  prNumber: string;
}

export interface PRData {
  title: string;
  author: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  diff: string;
  files: PRFile[];
  _demo?: boolean;
}

export interface PRFile {
  filename: string;
  status: 'added' | 'removed' | 'modified' | 'renamed';
  additions: number;
  deletions: number;
  patch?: string;
}

export interface AnalysisResult {
  summary: string;
  risks: RiskItem[];
  diffNotes: DiffNote[];
  hotspots?: Hotspot[];
  _demo?: boolean;
}

export interface RiskItem {
  level: 'low' | 'medium' | 'high';
  category: string;
  description: string;
}

export interface DiffNote {
  file: string;
  line?: number;
  type: 'logic' | 'mechanical' | 'style';
  note: string;
}

export interface Hotspot {
  file: string;
  reason: string;
  complexity: number;
}

// Phase 1 — Repo Awareness

export interface RepoSummary {
  id: number;
  name: string;
  full_name: string;
  owner: string;
  private: boolean;
  description: string | null;
  open_issues_count: number;
  pushed_at: string;
  default_branch: string;
  language: string | null;
  avatar_url: string;
}

export interface RepoActivity {
  open_prs: number;
  recent_commits: number;
  has_new_activity: boolean;
  last_synced: string | null;
}

export interface RepoWithActivity extends RepoSummary {
  activity: RepoActivity;
}

// Chat types

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  status?: 'sending' | 'streaming' | 'done' | 'error';
  thinking?: string;
  cards?: ChatCard[];
  isToolCall?: boolean;    // Assistant message that requested a tool
  isToolResult?: boolean;  // Synthetic user message carrying tool data
}

export interface ChatCard {
  type: 'repo' | 'pr' | 'analysis' | 'pipeline' | 'demo' | 'error';
  data: any;
}

export interface AgentStatus {
  active: boolean;
  phase: string;
  detail?: string;
}

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  lastMessageAt: number;
}
