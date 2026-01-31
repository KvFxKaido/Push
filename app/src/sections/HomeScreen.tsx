import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { GitPullRequest, Github } from 'lucide-react';
import { useGitHubAuth } from '@/hooks/useGitHubAuth';
import type { AIProviderType } from '@/types';
import { PROVIDERS, getProvider } from '@/lib/providers';

interface HomeScreenProps {
  onAnalyze: (owner: string, repo: string, prNumber: string) => void;
  loading: boolean;
  provider: AIProviderType;
  modelId: string;
  onProviderChange: (provider: AIProviderType) => void;
  onModelChange: (modelId: string) => void;
}

export function HomeScreen({
  onAnalyze,
  loading,
  provider,
  modelId,
  onProviderChange,
  onModelChange,
}: HomeScreenProps) {
  const [owner, setOwner] = useState('owner');
  const [repo, setRepo] = useState('repo');
  const [prNumber, setPrNumber] = useState('1');
  const {
    token,
    login,
    logout,
    loading: authLoading,
    error: authError,
    configured: authConfigured,
  } = useGitHubAuth();

  const currentProvider = getProvider(provider);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (owner && repo && prNumber) {
      onAnalyze(owner, repo, prNumber);
    }
  };

  const handleProviderChange = (value: string) => {
    const newProvider = value as AIProviderType;
    onProviderChange(newProvider);
    const prov = getProvider(newProvider);
    if (prov && prov.models.length > 0) {
      onModelChange(prov.models[0].id);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col">
      {/* Header */}
      <div className="bg-slate-900 border-b border-slate-800 px-4 py-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center">
            <GitPullRequest className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-white">PR Analyzer</h1>
            <p className="text-xs text-slate-400">GitHub code review on the go</p>
          </div>
        </div>
      </div>

      {/* Form */}
      <div className="flex-1 px-4 py-6">
        <form onSubmit={handleSubmit} className="space-y-5">
          {/* GitHub OAuth */}
          <div className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/60 p-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-slate-200">GitHub OAuth</p>
                <p className="text-xs text-slate-500">
                  Connect GitHub to analyze private repositories and avoid rate limits.
                </p>
              </div>
              {token ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={logout}
                  className="border-slate-700 text-slate-200 hover:bg-slate-800"
                >
                  Disconnect
                </Button>
              ) : (
                <Button
                  type="button"
                  onClick={login}
                  disabled={!authConfigured || authLoading}
                  className="bg-slate-800 text-slate-100 hover:bg-slate-700"
                >
                  {authLoading ? 'Connecting...' : 'Connect GitHub'}
                </Button>
              )}
            </div>
            {!authConfigured && (
              <p className="text-xs text-slate-500">
                Add VITE_GITHUB_CLIENT_ID and VITE_GITHUB_OAUTH_PROXY to enable OAuth.
              </p>
            )}
            {authError && <p className="text-xs text-rose-400">{authError}</p>}
          </div>

          {/* AI Provider Selection */}
          <div className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/60 p-4">
            <p className="text-sm font-medium text-slate-200">AI Provider</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs text-slate-400">Provider</Label>
                <Select value={provider} onValueChange={handleProviderChange}>
                  <SelectTrigger className="h-10 bg-slate-900 border-slate-700 text-white">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-slate-900 border-slate-700">
                    {PROVIDERS.map((p) => (
                      <SelectItem
                        key={p.type}
                        value={p.type}
                        className="text-slate-200 focus:bg-slate-800 focus:text-white"
                      >
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-slate-400">Model</Label>
                <Select value={modelId} onValueChange={onModelChange}>
                  <SelectTrigger className="h-10 bg-slate-900 border-slate-700 text-white">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-slate-900 border-slate-700">
                    {currentProvider?.models.map((m) => (
                      <SelectItem
                        key={m.id}
                        value={m.id}
                        className="text-slate-200 focus:bg-slate-800 focus:text-white"
                      >
                        {m.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <p className="text-xs text-slate-500">
              {currentProvider?.description}
              {' — '}
              Set <code className="text-slate-400">{currentProvider?.envKey}</code> to enable.
            </p>
          </div>

          {/* Repo Input */}
          <div className="space-y-2">
            <Label className="text-sm font-medium text-slate-300">
              Repository
            </Label>
            <div className="relative">
              <Github className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
              <Input
                value={`${owner}/${repo}`}
                onChange={(e) => {
                  const parts = e.target.value.split('/');
                  setOwner(parts[0] || '');
                  setRepo(parts[1] || '');
                }}
                placeholder="owner/repo"
                className="pl-10 h-12 bg-slate-900 border-slate-700 text-white placeholder:text-slate-600"
                disabled={loading}
              />
            </div>
            <p className="text-xs text-slate-500">Format: owner/repository</p>
          </div>

          {/* PR Number */}
          <div className="space-y-2">
            <Label className="text-sm font-medium text-slate-300">
              Pull Request Number
            </Label>
            <Input
              type="number"
              value={prNumber}
              onChange={(e) => setPrNumber(e.target.value)}
              placeholder="123"
              className="h-12 bg-slate-900 border-slate-700 text-white placeholder:text-slate-600"
              disabled={loading}
            />
          </div>

          {/* Analyze Button */}
          <Button
            type="submit"
            disabled={loading || !owner || !repo || !prNumber}
            className="w-full h-14 bg-blue-600 hover:bg-blue-700 text-white font-semibold text-base rounded-xl mt-4"
          >
            {loading ? (
              <span className="flex items-center gap-2">
                <span className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Analyzing...
              </span>
            ) : (
              <span className="flex items-center gap-2">
                <GitPullRequest className="w-5 h-5" />
                Analyze PR
              </span>
            )}
          </Button>
        </form>

        {/* Demo Mode Notice */}
        <div className="mt-6 p-4 bg-blue-900/20 rounded-xl border border-blue-800/50">
          <h3 className="text-sm font-medium text-blue-300 mb-2">Demo Mode</h3>
          <p className="text-xs text-blue-400/80">
            No API key configured. Click "Analyze PR" to see sample output.
            Add <code className="text-blue-300">{currentProvider?.envKey}</code> to enable real analysis with {currentProvider?.name}. GitHub OAuth is optional.
          </p>
        </div>

        {/* Quick Tips */}
        <div className="mt-4 p-4 bg-slate-900/50 rounded-xl border border-slate-800">
          <h3 className="text-sm font-medium text-slate-300 mb-2">Quick Tips</h3>
          <ul className="text-xs text-slate-500 space-y-1">
            <li>• Enter a public GitHub repository</li>
            <li>• PR number is in the URL: /pull/123</li>
            <li>• Analysis takes 5-10 seconds</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
