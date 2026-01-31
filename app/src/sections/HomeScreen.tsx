import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { GitPullRequest, Github } from 'lucide-react';

interface HomeScreenProps {
  onAnalyze: (owner: string, repo: string, prNumber: string) => void;
  loading: boolean;
}

export function HomeScreen({ onAnalyze, loading }: HomeScreenProps) {
  const [owner, setOwner] = useState('owner');
  const [repo, setRepo] = useState('repo');
  const [prNumber, setPrNumber] = useState('1');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (owner && repo && prNumber) {
      onAnalyze(owner, repo, prNumber);
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
            Add VITE_GEMINI_API_KEY to enable real analysis.
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
