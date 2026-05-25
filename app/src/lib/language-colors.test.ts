import { describe, expect, it } from 'vitest';
import { getLanguageColor, LANGUAGE_COLOR_FALLBACK, LANGUAGE_COLORS } from './language-colors';

describe('getLanguageColor', () => {
  it('returns the mapped color for a known language', () => {
    expect(getLanguageColor('TypeScript')).toBe(LANGUAGE_COLORS.TypeScript);
    expect(getLanguageColor('Python')).toBe('#3572a5');
  });

  it('returns the fallback for an unknown language', () => {
    expect(getLanguageColor('Brainfuck')).toBe(LANGUAGE_COLOR_FALLBACK);
  });

  it('returns the fallback for null/undefined/empty input', () => {
    expect(getLanguageColor(null)).toBe(LANGUAGE_COLOR_FALLBACK);
    expect(getLanguageColor(undefined)).toBe(LANGUAGE_COLOR_FALLBACK);
    expect(getLanguageColor('')).toBe(LANGUAGE_COLOR_FALLBACK);
  });

  it('does not resolve inherited Object keys to a prototype member', () => {
    expect(getLanguageColor('toString')).toBe(LANGUAGE_COLOR_FALLBACK);
    expect(getLanguageColor('hasOwnProperty')).toBe(LANGUAGE_COLOR_FALLBACK);
  });
});
