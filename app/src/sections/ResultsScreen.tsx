import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  ChevronDown,
  ChevronUp,
  AlertTriangle,
  FileText,
  Flame,
  ArrowLeft,
} from 'lucide-react';
import type { AnalysisResult, RiskItem, DiffNote } from '@/types';

interface ResultsScreenProps {
  result: AnalysisResult;
  repo: string;
  prNumber: string;
  onBack: () => void;
  providerName: string;
  modelName: string;
}

function RiskBadge({ level }: { level: RiskItem['level'] }) {
  const colors = {
    low: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
    medium: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
    high: 'bg-red-500/20 text-red-400 border-red-500/30',
  };

  return (
    <span className={`px-2 py-0.5 text-xs font-medium rounded border ${colors[level]}`}>
      {level}
    </span>
  );
}

function TypeBadge({ type }: { type: DiffNote['type'] }) {
  const colors = {
    logic: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
    mechanical: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
    style: 'bg-slate-500/20 text-slate-400 border-slate-500/30',
  };

  return (
    <span className={`px-2 py-0.5 text-xs font-medium rounded border ${colors[type]}`}>
      {type}
    </span>
  );
}

function CollapsibleSection({
  title,
  icon: Icon,
  children,
  defaultOpen = false,
}: {
  title: string;
  icon: React.ElementType;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger className="w-full">
        <div className="flex items-center justify-between p-4 bg-slate-900 rounded-xl border border-slate-800">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-slate-800 rounded-lg flex items-center justify-center">
              <Icon className="w-4 h-4 text-slate-400" />
            </div>
            <span className="font-medium text-white">{title}</span>
          </div>
          {isOpen ? (
            <ChevronUp className="w-5 h-5 text-slate-500" />
          ) : (
            <ChevronDown className="w-5 h-5 text-slate-500" />
          )}
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-2 p-4 bg-slate-900/50 rounded-xl border border-slate-800/50">
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function ResultsScreen({ result, repo, prNumber, onBack, providerName, modelName }: ResultsScreenProps) {
  return (
    <div className="min-h-screen bg-slate-950 flex flex-col">
      {/* Header */}
      <div className="bg-slate-900 border-b border-slate-800 px-4 py-4 sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={onBack}
            className="w-10 h-10 rounded-xl bg-slate-800 hover:bg-slate-700"
          >
            <ArrowLeft className="w-5 h-5 text-slate-400" />
          </Button>
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-semibold text-white truncate">
              PR #{prNumber}
            </h1>
            <p className="text-xs text-slate-400 truncate">{repo} &middot; {providerName} &middot; {modelName}</p>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 px-4 py-4 space-y-3">
        {/* Summary */}
        <CollapsibleSection title="Summary" icon={FileText} defaultOpen={true}>
          <p className="text-sm text-slate-300 leading-relaxed">
            {result.summary}
          </p>
        </CollapsibleSection>

        {/* Risks */}
        <CollapsibleSection title={`Risks (${result.risks.length})`} icon={AlertTriangle}>
          <div className="space-y-3">
            {result.risks.map((risk, index) => (
              <div
                key={index}
                className="p-3 bg-slate-800/50 rounded-lg border border-slate-700/50"
              >
                <div className="flex items-center gap-2 mb-1">
                  <RiskBadge level={risk.level} />
                  <span className="text-xs text-slate-500">{risk.category}</span>
                </div>
                <p className="text-sm text-slate-300">{risk.description}</p>
              </div>
            ))}
          </div>
        </CollapsibleSection>

        {/* Diff Notes */}
        <CollapsibleSection title={`Diff Notes (${result.diffNotes.length})`} icon={FileText}>
          <div className="space-y-3">
            {result.diffNotes.map((note, index) => (
              <div
                key={index}
                className="p-3 bg-slate-800/50 rounded-lg border border-slate-700/50"
              >
                <div className="flex items-center gap-2 mb-1">
                  <TypeBadge type={note.type} />
                  <span className="text-xs text-slate-500 font-mono truncate">
                    {note.file}
                  </span>
                </div>
                <p className="text-sm text-slate-300">{note.note}</p>
              </div>
            ))}
          </div>
        </CollapsibleSection>

        {/* Hotspots */}
        {result.hotspots && result.hotspots.length > 0 && (
          <CollapsibleSection title={`Hotspots (${result.hotspots.length})`} icon={Flame}>
            <div className="space-y-3">
              {result.hotspots.map((hotspot, index) => (
                <div
                  key={index}
                  className="p-3 bg-slate-800/50 rounded-lg border border-slate-700/50"
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-mono text-slate-400">
                      {hotspot.file}
                    </span>
                    <span className="ml-auto text-xs text-orange-400">
                      Complexity: {hotspot.complexity}/10
                    </span>
                  </div>
                  <p className="text-sm text-slate-300">{hotspot.reason}</p>
                </div>
              ))}
            </div>
          </CollapsibleSection>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-4 border-t border-slate-800 bg-slate-900">
        <Button
          onClick={onBack}
          className="w-full h-12 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-xl"
        >
          Analyze Another PR
        </Button>
      </div>
    </div>
  );
}
