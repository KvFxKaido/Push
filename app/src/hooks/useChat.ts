import { useState, useCallback, useRef } from 'react';
import type { ChatMessage, AgentStatus } from '@/types';
import { streamChat } from '@/lib/orchestrator';

const STORAGE_KEY = 'diff_chat_history';

function loadMessages(): ChatMessage[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch {
    // Ignore parse errors
  }
  return [];
}

function saveMessages(messages: ChatMessage[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
  } catch {
    // Ignore quota errors
  }
}

function createId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>(loadMessages);
  const [isStreaming, setIsStreaming] = useState(false);
  const [agentStatus, setAgentStatus] = useState<AgentStatus>({
    active: false,
    phase: '',
  });
  const abortRef = useRef(false);

  const sendMessage = useCallback(
    async (text: string) => {
      if (!text.trim() || isStreaming) return;

      const userMessage: ChatMessage = {
        id: createId(),
        role: 'user',
        content: text.trim(),
        timestamp: Date.now(),
        status: 'done',
      };

      const assistantMessage: ChatMessage = {
        id: createId(),
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        status: 'streaming',
      };

      const updatedWithUser = [...messages, userMessage];
      setMessages([...updatedWithUser, assistantMessage]);
      saveMessages(updatedWithUser);

      setIsStreaming(true);
      setAgentStatus({ active: true, phase: 'Thinking...' });
      abortRef.current = false;

      let accumulated = '';

      await streamChat(
        [...updatedWithUser],
        (token) => {
          if (abortRef.current) return;
          accumulated += token;
          setAgentStatus({ active: true, phase: 'Responding...', detail: undefined });
          setMessages((prev) => {
            const updated = [...prev];
            const lastIdx = updated.length - 1;
            if (updated[lastIdx]?.role === 'assistant') {
              updated[lastIdx] = {
                ...updated[lastIdx],
                content: accumulated,
                status: 'streaming',
              };
            }
            return updated;
          });
        },
        () => {
          if (abortRef.current) return;
          setMessages((prev) => {
            const updated = [...prev];
            const lastIdx = updated.length - 1;
            if (updated[lastIdx]?.role === 'assistant') {
              updated[lastIdx] = {
                ...updated[lastIdx],
                content: accumulated,
                status: 'done',
              };
            }
            saveMessages(updated);
            return updated;
          });
          setIsStreaming(false);
          setAgentStatus({ active: false, phase: '' });
        },
        (error) => {
          if (abortRef.current) return;
          setMessages((prev) => {
            const updated = [...prev];
            const lastIdx = updated.length - 1;
            if (updated[lastIdx]?.role === 'assistant') {
              updated[lastIdx] = {
                ...updated[lastIdx],
                content: `Something went wrong: ${error.message}`,
                status: 'error',
              };
            }
            saveMessages(updated);
            return updated;
          });
          setIsStreaming(false);
          setAgentStatus({ active: false, phase: '' });
        },
      );
    },
    [messages, isStreaming],
  );

  const clearHistory = useCallback(() => {
    setMessages([]);
    localStorage.removeItem(STORAGE_KEY);
  }, []);

  return {
    messages,
    sendMessage,
    clearHistory,
    agentStatus,
    isStreaming,
  };
}
