import { describe, expect, it } from 'vitest';

import type { OpenAIChatRequest } from './chat-request-guardrails';
import {
  buildGeminiGenerateContentRequest,
  createGeminiTranslatedStream,
} from './openai-gemini-bridge';

function createEventStreamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
  );
}

async function collectChunks(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

describe('buildGeminiGenerateContentRequest', () => {
  it('renames assistant -> model, hoists system into systemInstruction', () => {
    const request: OpenAIChatRequest = {
      model: 'gemini-3.1-pro-preview',
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'developer', content: [{ type: 'text', text: 'Use markdown.' }] },
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello back' },
        { role: 'user', content: 'Continue' },
      ],
      max_completion_tokens: 1024,
      temperature: 0.3,
      top_p: 0.95,
      stream: true,
    };

    expect(buildGeminiGenerateContentRequest(request)).toEqual({
      contents: [
        { role: 'user', parts: [{ text: 'Hi' }] },
        { role: 'model', parts: [{ text: 'Hello back' }] },
        { role: 'user', parts: [{ text: 'Continue' }] },
      ],
      systemInstruction: { parts: [{ text: 'Be concise.\n\nUse markdown.' }] },
      generationConfig: { maxOutputTokens: 1024, temperature: 0.3, topP: 0.95 },
    });
  });

  it('falls back to max_tokens when max_completion_tokens is absent', () => {
    expect(
      buildGeminiGenerateContentRequest({
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'x' }],
        max_tokens: 256,
      } as OpenAIChatRequest),
    ).toMatchObject({ generationConfig: { maxOutputTokens: 256 } });
  });

  it('pads contents with an empty user turn when only system messages are present', () => {
    expect(
      buildGeminiGenerateContentRequest({
        model: 'gemini-3.1-pro-preview',
        messages: [{ role: 'system', content: 'preamble only' }],
      } as OpenAIChatRequest),
    ).toEqual({
      contents: [{ role: 'user', parts: [{ text: '' }] }],
      systemInstruction: { parts: [{ text: 'preamble only' }] },
    });
  });

  it('translates inline image_url data URLs into Gemini inline_data parts', () => {
    const body = buildGeminiGenerateContentRequest({
      model: 'gemini-2.5-pro',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe' },
            {
              type: 'image_url',
              image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' },
            },
          ],
        },
      ],
    } as OpenAIChatRequest);

    expect(body).toEqual({
      contents: [
        {
          role: 'user',
          parts: [
            { text: 'Describe' },
            { inline_data: { mime_type: 'image/png', data: 'iVBORw0KGgo=' } },
          ],
        },
      ],
    });
  });

  it('omits generationConfig when no sampling params are set', () => {
    const body = buildGeminiGenerateContentRequest({
      model: 'gemini-3.1-pro-preview',
      messages: [{ role: 'user', content: 'x' }],
    } as OpenAIChatRequest);
    expect(body).not.toHaveProperty('generationConfig');
  });
});

describe('createGeminiTranslatedStream', () => {
  it('forwards candidate text as OpenAI-shaped content deltas', async () => {
    const frames = [
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Hello' }] } }] })}\n\n`,
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: ', world' }] } }] })}\n\n`,
      `data: ${JSON.stringify({
        candidates: [{ content: { parts: [{ text: '!' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 3, totalTokenCount: 7 },
      })}\n\n`,
    ];

    const translated = createGeminiTranslatedStream(
      createEventStreamResponse(frames),
      'gemini-3.1-pro-preview',
    );
    const out = await collectChunks(translated);

    // Three content deltas + one terminal frame with finish_reason + usage,
    // then the OpenAI [DONE] sentinel.
    expect(out).toContain('"content":"Hello"');
    expect(out).toContain('"content":", world"');
    expect(out).toContain('"content":"!"');
    expect(out).toContain('"finish_reason":"stop"');
    expect(out).toContain('"prompt_tokens":4');
    expect(out).toContain('"completion_tokens":3');
    expect(out).toContain('"total_tokens":7');
    expect(out.endsWith('data: [DONE]\n\n')).toBe(true);
  });

  it('maps Gemini MAX_TOKENS to OpenAI length finish reason', async () => {
    const frame = `data: ${JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'cut' }] }, finishReason: 'MAX_TOKENS' }],
    })}\n\n`;

    const out = await collectChunks(
      createGeminiTranslatedStream(createEventStreamResponse([frame]), 'gemini-3.1-pro-preview'),
    );

    expect(out).toContain('"finish_reason":"length"');
  });

  it('ignores malformed JSON frames without breaking the stream', async () => {
    const frames = [
      `data: { not valid json\n\n`,
      `data: ${JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      })}\n\n`,
    ];

    const out = await collectChunks(
      createGeminiTranslatedStream(createEventStreamResponse(frames), 'gemini-3.1-pro-preview'),
    );

    expect(out).toContain('"content":"ok"');
    expect(out.endsWith('data: [DONE]\n\n')).toBe(true);
  });

  it('closes cleanly when upstream has no body', async () => {
    const empty = new Response(null);
    const out = await collectChunks(createGeminiTranslatedStream(empty, 'gemini-2.5-flash'));
    expect(out).toContain('"finish_reason":"stop"');
    expect(out.endsWith('data: [DONE]\n\n')).toBe(true);
  });
});
