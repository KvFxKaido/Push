import { useMemo, useState } from 'react';
import { CheckCircle2, HelpCircle } from 'lucide-react';
import type { AskUserCardData, CardAction } from '@/types';
import {
  CARD_SHELL_CLASS,
  CARD_BUTTON_CLASS,
  CARD_INPUT_CLASS,
  CARD_PANEL_CLASS,
  CARD_PANEL_SUBTLE_CLASS,
  CARD_HEADER_BG_INFO,
} from '@/lib/utils';
import { SendLiftIcon } from '@/components/icons/push-custom-icons';

interface AskUserCardProps {
  data: AskUserCardData;
  messageId: string;
  cardIndex: number;
  onAction?: (action: CardAction) => void;
}

const OTHER_OPTION_ID = '__other__';

export function AskUserCard({ data, messageId, cardIndex, onAction }: AskUserCardProps) {
  const baseOptions = useMemo(
    () => data.options.filter((option) => option.label.trim().length > 0),
    [data.options],
  );
  const options = useMemo(() => {
    if (baseOptions.some((option) => option.id === OTHER_OPTION_ID)) return baseOptions;
    return [
      ...baseOptions,
      { id: OTHER_OPTION_ID, label: 'Other...', description: 'Write your own response.' },
    ];
  }, [baseOptions]);

  const [selectedIds, setSelectedIds] = useState<string[]>(data.selectedOptionIds ?? []);
  const [otherText, setOtherText] = useState('');

  if (!data.question.trim() || baseOptions.length === 0) {
    return null;
  }

  const hasResponse = Boolean(data.responseText?.trim());
  const otherSelected = selectedIds.includes(OTHER_OPTION_ID);

  const submit = (optionIds: string[], freeform?: string) => {
    if (!onAction) return;

    const responseParts = optionIds
      .map((id) => {
        if (id === OTHER_OPTION_ID) {
          return (freeform || '').trim();
        }
        return options.find((option) => option.id === id)?.label || '';
      })
      .filter((part) => part.trim().length > 0);

    const responseText = responseParts.join(', ').trim();
    if (!responseText) return;

    onAction({
      type: 'ask-user-submit',
      messageId,
      cardIndex,
      responseText,
      selectedOptionIds: optionIds,
    });
  };

  const toggleMulti = (optionId: string) => {
    setSelectedIds((prev) => (
      prev.includes(optionId)
        ? prev.filter((id) => id !== optionId)
        : [...prev, optionId]
    ));
  };

  return (
    <div className={CARD_SHELL_CLASS}>
      <div className={`px-3 py-2.5 flex items-center gap-2 ${CARD_HEADER_BG_INFO}`}>
        {hasResponse ? (
          <CheckCircle2 className="h-4 w-4 shrink-0 text-push-status-success" />
        ) : (
          <HelpCircle className="h-4 w-4 shrink-0 text-push-link" />
        )}
        <span className={`text-sm font-medium ${hasResponse ? 'text-push-status-success' : 'text-push-fg'}`}>
          {hasResponse ? 'Response recorded' : 'Input needed'}
        </span>
      </div>

      <div className="px-3 py-3">
        <div className={`${CARD_PANEL_CLASS} px-3 py-3`}>
          <p className="text-push-base leading-relaxed text-push-fg">{data.question}</p>
        </div>
      </div>

      {hasResponse ? (
        <div className="px-3 pb-3">
          <div className={`${CARD_PANEL_SUBTLE_CLASS} px-3 py-3`}>
            <p className="text-push-sm text-push-fg-secondary">{data.responseText}</p>
          </div>
        </div>
      ) : (
        <>
          <div className="px-3 pb-3 space-y-2">
            {options.map((option) => {
              const selected = selectedIds.includes(option.id);
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => {
                    if (data.multiSelect) {
                      toggleMulti(option.id);
                      return;
                    }
                    if (option.id === OTHER_OPTION_ID) {
                      setSelectedIds([OTHER_OPTION_ID]);
                      return;
                    }
                    submit([option.id]);
                  }}
                  className={`${CARD_BUTTON_CLASS} h-auto w-full justify-start px-3 py-3 text-left ${
                    selected ? 'border-push-edge-hover text-push-fg brightness-110' : ''
                  }`}
                  style={{ minHeight: '44px' }}
                >
                  <div className="flex min-w-0 flex-1 items-start gap-3">
                    <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${selected ? 'bg-push-accent' : 'bg-push-fg-dim/50'}`} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-push-sm text-inherit">{option.label}</span>
                      {option.description && (
                        <span className="mt-0.5 block text-push-xs text-push-fg-dim">{option.description}</span>
                      )}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>

          {otherSelected && (
            <div className="px-3 pb-3">
              <textarea
                value={otherText}
                onChange={(event) => setOtherText(event.target.value)}
                rows={3}
                placeholder="Write your response..."
                className={`${CARD_INPUT_CLASS} resize-none leading-relaxed`}
              />
            </div>
          )}

          {(data.multiSelect || otherSelected) && (
            <div className="px-3 pb-3">
              <button
                type="button"
                onClick={() => submit(selectedIds, otherText)}
                disabled={selectedIds.length === 0 || (otherSelected && !otherText.trim())}
                className={`${CARD_BUTTON_CLASS} h-11 w-full`}
                style={{ minHeight: '44px' }}
              >
                <SendLiftIcon className="h-4 w-4" />
                Submit response
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
