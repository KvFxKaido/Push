export type AppState = 'home' | 'running' | 'results';

export type AIProviderType = 'gemini' | 'ollama-cloud';

export interface AIModel {
  id: string;
  name: string;
  provider: AIProviderType;
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
