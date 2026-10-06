/**
 * Minimal client for the Gemini `generateContent` REST endpoint. Only what
 * translation needs: one system instruction, one user turn, text back.
 */

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Gemini returned HTTP 429: the free-tier quota is used up for now. */
export class GeminiRateLimited extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeminiRateLimited';
  }
}

export type GenerateText = (system: string, user: string) => Promise<string>;

type GenerateContentResponse = {
  candidates?: Array<{
    finishReason?: string;
    content?: { parts?: Array<{ text?: string }> };
  }>;
  promptFeedback?: { blockReason?: string };
  error?: { message?: string };
};

export function createGeminiClient(options: {
  apiKey: string;
  model: string;
  fetch?: typeof globalThis.fetch;
}): GenerateText {
  const fetch = options.fetch ?? globalThis.fetch;
  const url = `${API_BASE}/${encodeURIComponent(options.model)}:generateContent`;

  return async (system, user) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': options.apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { temperature: 0.2 },
      }),
    });
    const body = (await response
      .json()
      .catch(() => ({}))) as GenerateContentResponse;

    if (response.status === 429) {
      throw new GeminiRateLimited(
        `Gemini rate limit: ${body.error?.message ?? 'quota exceeded'}`
      );
    }
    if (!response.ok) {
      throw new Error(
        `Gemini request failed (${response.status}): ${body.error?.message ?? 'no details'}`
      );
    }

    const candidate = body.candidates?.[0];
    if (!candidate) {
      throw new Error(
        `Gemini returned no candidate (${body.promptFeedback?.blockReason ?? 'unknown reason'})`
      );
    }
    if (candidate.finishReason !== 'STOP') {
      throw new Error(
        `Gemini stopped early: ${candidate.finishReason ?? 'unknown'}`
      );
    }
    const text = (candidate.content?.parts ?? [])
      .map(part => part.text ?? '')
      .join('');
    if (!text.trim()) {
      throw new Error('Gemini returned an empty response');
    }
    return text;
  };
}
