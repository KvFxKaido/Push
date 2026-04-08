import { describe, expect, it, beforeEach } from 'vitest';
import {
  setOpenRouterSessionId,
  getOpenRouterSessionId,
  buildOpenRouterTrace,
} from './openrouter-session';

describe('openrouter-session', () => {
  beforeEach(() => {
    // Clear any leftover state
    getOpenRouterSessionId();
  });

  describe('setOpenRouterSessionId / getOpenRouterSessionId', () => {
    it('returns null when no session has been set', () => {
      expect(getOpenRouterSessionId()).toBeNull();
    });

    it('returns the session ID after it is set', () => {
      setOpenRouterSessionId('chat_abc123');
      expect(getOpenRouterSessionId()).toBe('chat_abc123');
    });

    it('consumes the value (get-and-clear): second call returns null', () => {
      setOpenRouterSessionId('chat_abc123');
      expect(getOpenRouterSessionId()).toBe('chat_abc123');
      expect(getOpenRouterSessionId()).toBeNull();
    });

    it('truncates IDs longer than 256 characters', () => {
      const longId = 'x'.repeat(300);
      setOpenRouterSessionId(longId);
      const result = getOpenRouterSessionId();
      expect(result).toHaveLength(256);
      expect(result).toBe('x'.repeat(256));
    });

    it('treats empty string as null', () => {
      setOpenRouterSessionId('');
      expect(getOpenRouterSessionId()).toBeNull();
    });

    it('allows resetting to null explicitly', () => {
      setOpenRouterSessionId('chat_abc123');
      setOpenRouterSessionId(null);
      expect(getOpenRouterSessionId()).toBeNull();
    });

    it('overwrites a previous value when set again', () => {
      setOpenRouterSessionId('chat_1');
      setOpenRouterSessionId('chat_2');
      expect(getOpenRouterSessionId()).toBe('chat_2');
    });
  });

  describe('buildOpenRouterTrace', () => {
    it('returns default trace metadata', () => {
      expect(buildOpenRouterTrace()).toEqual({
        generation_name: 'push-chat',
        trace_name: 'push',
      });
    });

    it('accepts a custom generation name', () => {
      expect(buildOpenRouterTrace('push-auditor')).toEqual({
        generation_name: 'push-auditor',
        trace_name: 'push',
      });
    });
  });
});
