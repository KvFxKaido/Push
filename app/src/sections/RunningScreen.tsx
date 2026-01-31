import { useEffect, useState } from 'react';
import { GitPullRequest, FileCode, Brain } from 'lucide-react';

interface RunningScreenProps {
  repo: string;
  prNumber: string;
  providerName: string;
  modelName: string;
}

const STEPS = [
  { icon: GitPullRequest, text: 'Fetching PR data...' },
  { icon: FileCode, text: 'Reading diff...' },
  { icon: Brain, text: 'Running analysis...' },
];

export function RunningScreen({ repo, prNumber, providerName, modelName }: RunningScreenProps) {
  const [stepIndex, setStepIndex] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setStepIndex((prev) => (prev + 1) % STEPS.length);
    }, 1500);
    return () => clearInterval(interval);
  }, []);

  const CurrentIcon = STEPS[stepIndex].icon;

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center px-6">
      {/* Spinner */}
      <div className="relative mb-8">
        <div className="w-20 h-20 border-4 border-slate-800 rounded-full" />
        <div className="absolute inset-0 w-20 h-20 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
        <div className="absolute inset-0 flex items-center justify-center">
          <CurrentIcon className="w-8 h-8 text-blue-500 animate-pulse" />
        </div>
      </div>

      {/* Text */}
      <h2 className="text-xl font-semibold text-white mb-2">
        Analyzing PR #{prNumber}
      </h2>
      <p className="text-slate-400 text-sm mb-1">{repo}</p>
      <p className="text-slate-500 text-xs mb-8">
        {providerName} &middot; {modelName}
      </p>

      {/* Progress Steps */}
      <div className="w-full max-w-xs space-y-3">
        {STEPS.map((step, index) => {
          const Icon = step.icon;
          const isActive = index === stepIndex;
          const isPast = index < stepIndex;

          return (
            <div
              key={index}
              className={`flex items-center gap-3 p-3 rounded-lg transition-all duration-300 ${
                isActive
                  ? 'bg-slate-800/80'
                  : isPast
                  ? 'bg-slate-900/50 opacity-50'
                  : 'bg-slate-900/30 opacity-30'
              }`}
            >
              <Icon
                className={`w-4 h-4 ${
                  isActive ? 'text-blue-500' : 'text-slate-500'
                }`}
              />
              <span
                className={`text-sm ${
                  isActive ? 'text-white' : 'text-slate-500'
                }`}
              >
                {step.text}
              </span>
              {isPast && (
                <span className="ml-auto text-xs text-green-500">Done</span>
              )}
            </div>
          );
        })}
      </div>

      {/* No interaction hint */}
      <p className="mt-12 text-xs text-slate-600">
        This may take a few moments...
      </p>
    </div>
  );
}
