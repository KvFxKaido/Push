/**
 * Tests for BrowserScreenshotCardData and BrowserExtractCardData type shapes.
 *
 * These tests validate that the TypeScript interfaces in types/index.ts
 * match the expected field requirements for the browser tool cards.
 * They operate on concrete objects that must satisfy the type at compile time,
 * then verify the runtime shape matches expectations.
 */

import { describe, it, expect } from 'vitest';
import type {
  BrowserScreenshotCardData,
  BrowserExtractCardData,
  BrowserToolError,
  ChatCard,
} from './index';

// ---------------------------------------------------------------------------
// 1. BrowserScreenshotCardData
// ---------------------------------------------------------------------------

describe('BrowserScreenshotCardData shape', () => {
  it('has all required fields', () => {
    const data: BrowserScreenshotCardData = {
      url: 'https://example.com',
      finalUrl: 'https://example.com/',
      title: 'Example Domain',
      statusCode: 200,
      mimeType: 'image/png',
      imageBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAUA',
      truncated: false,
    };

    // All fields must be present and correctly typed
    expect(typeof data.url).toBe('string');
    expect(typeof data.finalUrl).toBe('string');
    expect(typeof data.title).toBe('string');
    expect(typeof data.statusCode).toBe('number');
    expect(typeof data.mimeType).toBe('string');
    expect(typeof data.imageBase64).toBe('string');
    expect(typeof data.truncated).toBe('boolean');
  });

  it('allows null statusCode', () => {
    const data: BrowserScreenshotCardData = {
      url: 'https://example.com',
      finalUrl: 'https://example.com/',
      title: 'Test',
      statusCode: null,
      mimeType: 'image/jpeg',
      imageBase64: '/9j/4AAQ...',
      truncated: false,
    };

    expect(data.statusCode).toBeNull();
  });

  it('has exactly the expected field set (no extra, no missing)', () => {
    const data: BrowserScreenshotCardData = {
      url: 'https://example.com',
      finalUrl: 'https://example.com/',
      title: 'Test',
      statusCode: 200,
      mimeType: 'image/png',
      imageBase64: 'abc',
      truncated: true,
    };

    const keys = Object.keys(data).sort();
    expect(keys).toEqual([
      'finalUrl',
      'imageBase64',
      'mimeType',
      'statusCode',
      'title',
      'truncated',
      'url',
    ]);
  });

  it('allows optional error field with BrowserToolError shape', () => {
    const errorData: BrowserToolError = {
      code: 'NAVIGATION_TIMEOUT',
      message: 'The page took too long to load',
    };

    const data: BrowserScreenshotCardData = {
      url: 'https://example.com',
      finalUrl: 'https://example.com',
      title: '',
      statusCode: null,
      mimeType: '',
      imageBase64: '',
      truncated: false,
      error: errorData,
    };

    expect(data.error).toBeDefined();
    expect(data.error!.code).toBe('NAVIGATION_TIMEOUT');
    expect(data.error!.message).toBe('The page took too long to load');
  });

  it('error field is undefined when not set', () => {
    const data: BrowserScreenshotCardData = {
      url: 'https://example.com',
      finalUrl: 'https://example.com/',
      title: 'Test',
      statusCode: 200,
      mimeType: 'image/png',
      imageBase64: 'data',
      truncated: false,
    };

    expect(data.error).toBeUndefined();
  });

  it('can be used as a ChatCard with type browser-screenshot', () => {
    const card: ChatCard = {
      type: 'browser-screenshot',
      data: {
        url: 'https://example.com',
        finalUrl: 'https://example.com/',
        title: 'Test',
        statusCode: 200,
        mimeType: 'image/png',
        imageBase64: 'data',
        truncated: false,
      },
    };

    expect(card.type).toBe('browser-screenshot');
    expect(card.data).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 2. BrowserExtractCardData
// ---------------------------------------------------------------------------

describe('BrowserExtractCardData shape', () => {
  it('has all required fields', () => {
    const data: BrowserExtractCardData = {
      url: 'https://docs.example.com',
      finalUrl: 'https://docs.example.com/',
      title: 'Documentation',
      statusCode: 200,
      content: 'Page content extracted from the URL.',
      truncated: false,
    };

    expect(typeof data.url).toBe('string');
    expect(typeof data.finalUrl).toBe('string');
    expect(typeof data.title).toBe('string');
    expect(typeof data.statusCode).toBe('number');
    expect(typeof data.content).toBe('string');
    expect(typeof data.truncated).toBe('boolean');
  });

  it('allows null statusCode', () => {
    const data: BrowserExtractCardData = {
      url: 'https://example.com',
      finalUrl: 'https://example.com/',
      title: 'Test',
      statusCode: null,
      content: 'content',
      truncated: false,
    };

    expect(data.statusCode).toBeNull();
  });

  it('allows optional instruction field', () => {
    const data: BrowserExtractCardData = {
      url: 'https://example.com',
      finalUrl: 'https://example.com/',
      title: 'Test',
      statusCode: 200,
      instruction: 'Get the pricing table',
      content: 'content',
      truncated: false,
    };

    expect(data.instruction).toBe('Get the pricing table');
  });

  it('allows instruction to be undefined', () => {
    const data: BrowserExtractCardData = {
      url: 'https://example.com',
      finalUrl: 'https://example.com/',
      title: 'Test',
      statusCode: 200,
      content: 'content',
      truncated: false,
    };

    expect(data.instruction).toBeUndefined();
  });

  it('has required fields plus optional instruction', () => {
    const dataWithInstruction: BrowserExtractCardData = {
      url: 'https://example.com',
      finalUrl: 'https://example.com/',
      title: 'Test',
      statusCode: 200,
      instruction: 'Focus on API endpoints',
      content: 'content',
      truncated: false,
    };

    const keys = Object.keys(dataWithInstruction).sort();
    expect(keys).toEqual([
      'content',
      'finalUrl',
      'instruction',
      'statusCode',
      'title',
      'truncated',
      'url',
    ]);

    const dataWithout: BrowserExtractCardData = {
      url: 'https://example.com',
      finalUrl: 'https://example.com/',
      title: 'Test',
      statusCode: 200,
      content: 'content',
      truncated: false,
    };

    const keysWithout = Object.keys(dataWithout).sort();
    expect(keysWithout).toEqual([
      'content',
      'finalUrl',
      'statusCode',
      'title',
      'truncated',
      'url',
    ]);
  });

  it('allows optional error field with BrowserToolError shape', () => {
    const data: BrowserExtractCardData = {
      url: 'https://example.com',
      finalUrl: 'https://example.com',
      title: '',
      statusCode: null,
      content: '',
      truncated: false,
      error: { code: 'SESSION_CREATE_FAILED', message: 'Could not start browser' },
    };

    expect(data.error).toBeDefined();
    expect(data.error!.code).toBe('SESSION_CREATE_FAILED');
  });

  it('error field is undefined when not set', () => {
    const data: BrowserExtractCardData = {
      url: 'https://example.com',
      finalUrl: 'https://example.com/',
      title: 'Test',
      statusCode: 200,
      content: 'content',
      truncated: false,
    };

    expect(data.error).toBeUndefined();
  });

  it('can be used as a ChatCard with type browser-extract', () => {
    const card: ChatCard = {
      type: 'browser-extract',
      data: {
        url: 'https://example.com',
        finalUrl: 'https://example.com/',
        title: 'Test',
        statusCode: 200,
        content: 'data',
        truncated: false,
      },
    };

    expect(card.type).toBe('browser-extract');
    expect(card.data).toBeDefined();
  });
});
