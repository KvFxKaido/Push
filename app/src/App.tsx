import { useState } from 'react';
import type { AppState, PRInput, PRData, AIProviderType } from '@/types';
import { HomeScreen } from '@/sections/HomeScreen';
import { RunningScreen } from '@/sections/RunningScreen';
import { ResultsScreen } from '@/sections/ResultsScreen';
import { useGitHub } from '@/hooks/useGitHub';
import { useAnalysis } from '@/hooks/useAnalysis';
import { getProvider } from '@/lib/providers';
import './App.css';

function App() {
  const [appState, setAppState] = useState<AppState>('home');
  const [currentInput, setCurrentInput] = useState<PRInput | null>(null);
  const [, setCurrentPRData] = useState<PRData | null>(null);
  const [provider, setProvider] = useState<AIProviderType>('gemini');
  const [modelId, setModelId] = useState('gemini-1.5-flash');

  const { fetchPRData, loading: githubLoading } = useGitHub();
  const { runAnalysis, result: analysisResult, reset: resetAnalysis } = useAnalysis();

  const currentProviderConfig = getProvider(provider);
  const currentModelName =
    currentProviderConfig?.models.find((m) => m.id === modelId)?.name || modelId;

  const handleAnalyze = async (owner: string, repo: string, prNumber: string) => {
    const input: PRInput = { owner, repo, prNumber };
    setCurrentInput(input);
    setAppState('running');

    // Fetch PR data
    const prData = await fetchPRData(input);

    if (!prData) {
      // Error - go back to home
      setAppState('home');
      return;
    }

    setCurrentPRData(prData);

    // Run analysis with selected provider
    const result = await runAnalysis(prData, provider, modelId);

    if (result) {
      setAppState('results');
    } else {
      setAppState('home');
    }
  };

  const handleBack = () => {
    resetAnalysis();
    setCurrentPRData(null);
    setCurrentInput(null);
    setAppState('home');
  };

  // Render based on state
  switch (appState) {
    case 'running':
      return (
        <RunningScreen
          repo={`${currentInput?.owner}/${currentInput?.repo}`}
          prNumber={currentInput?.prNumber || ''}
          providerName={currentProviderConfig?.name || 'AI'}
          modelName={currentModelName}
        />
      );

    case 'results':
      if (analysisResult && currentInput) {
        return (
          <ResultsScreen
            result={analysisResult}
            repo={`${currentInput.owner}/${currentInput.repo}`}
            prNumber={currentInput.prNumber}
            onBack={handleBack}
            providerName={currentProviderConfig?.name || 'AI'}
            modelName={currentModelName}
          />
        );
      }
      // Fallback
      return (
        <HomeScreen
          onAnalyze={handleAnalyze}
          loading={githubLoading}
          provider={provider}
          modelId={modelId}
          onProviderChange={setProvider}
          onModelChange={setModelId}
        />
      );

    case 'home':
    default:
      return (
        <HomeScreen
          onAnalyze={handleAnalyze}
          loading={githubLoading}
          provider={provider}
          modelId={modelId}
          onProviderChange={setProvider}
          onModelChange={setModelId}
        />
      );
  }
}

export default App;
