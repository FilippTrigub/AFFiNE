import test from 'ava';

import {
  createGeminiClient,
  GeminiRateLimited,
} from '../../plugins/translate/gemini';
import { isTranslationLanguage } from '../../plugins/translate/languages';
import {
  translateMarkdown,
  TranslationStructureError,
} from '../../plugins/translate/translator';

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

test('isTranslationLanguage accepts only the seven supported codes', t => {
  for (const lang of ['en', 'fr', 'es', 'pt', 'de', 'pl', 'nl']) {
    t.true(isTranslationLanguage(lang));
  }
  t.false(isTranslationLanguage('it'));
  t.false(isTranslationLanguage('EN'));
});

test('gemini client posts to generateContent and returns the text', async t => {
  let seen: { url: string; init: RequestInit } | undefined;
  const generate = createGeminiClient({
    apiKey: 'k',
    model: 'gemini-test',
    fetch: async (url, init) => {
      seen = { url: String(url), init: init! };
      return jsonResponse(200, {
        candidates: [
          { finishReason: 'STOP', content: { parts: [{ text: 'Bonjour' }] } },
        ],
      });
    },
  });

  t.is(await generate('system', 'Hello'), 'Bonjour');
  t.is(
    seen!.url,
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent'
  );
  t.is((seen!.init.headers as Record<string, string>)['x-goog-api-key'], 'k');
  const body = JSON.parse(seen!.init.body as string);
  t.is(body.systemInstruction.parts[0].text, 'system');
  t.is(body.contents[0].parts[0].text, 'Hello');
});

test('gemini client maps 429 to GeminiRateLimited', async t => {
  const generate = createGeminiClient({
    apiKey: 'k',
    model: 'm',
    fetch: async () => jsonResponse(429, { error: { message: 'quota' } }),
  });
  await t.throwsAsync(generate('s', 'u'), { instanceOf: GeminiRateLimited });
});

test('gemini client rejects truncated or blocked output', async t => {
  const generate = createGeminiClient({
    apiKey: 'k',
    model: 'm',
    fetch: async () =>
      jsonResponse(200, {
        candidates: [
          { finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'Bon' }] } },
        ],
      }),
  });
  await t.throwsAsync(generate('s', 'u'), { message: /MAX_TOKENS/ });
});

test('gemini client surfaces API errors without the key', async t => {
  const generate = createGeminiClient({
    apiKey: 'secret-key',
    model: 'm',
    fetch: async () => jsonResponse(400, { error: { message: 'bad model' } }),
  });
  const error = await t.throwsAsync(generate('s', 'u'));
  t.regex(error!.message, /400.*bad model/);
  t.notRegex(error!.message, /secret-key/);
});

const upper = async (_system: string, user: string) => user.toUpperCase();

test('translateMarkdown translates title and body chunk by chunk', async t => {
  const calls: string[] = [];
  const result = await translateMarkdown({
    title: 'Hello',
    markdown: 'para one\n\npara two',
    from: 'en',
    to: 'fr',
    maxChunkChars: 12,
    generate: async (system, user) => {
      calls.push(user);
      t.regex(system, /from English to French/);
      return upper(system, user);
    },
  });
  t.deepEqual(result, { title: 'HELLO', markdown: 'PARA ONE\n\nPARA TWO' });
  t.true(calls.length > 1);
});

test('translateMarkdown unwraps a markdown code fence the model added', async t => {
  const result = await translateMarkdown({
    title: '',
    markdown: '- one',
    from: 'en',
    to: 'de',
    generate: async () => '```markdown\n- eins\n```',
  });
  t.is(result.markdown, '- eins');
});

test('translateMarkdown retries once when structure changes', async t => {
  let attempt = 0;
  const result = await translateMarkdown({
    title: '',
    markdown: '- one\n- two',
    from: 'en',
    to: 'nl',
    generate: async () => (++attempt === 1 ? '- een' : '- een\n- twee'),
  });
  t.is(attempt, 2);
  t.is(result.markdown, '- een\n- twee');
});

test('translateMarkdown fails after two structurally broken attempts', async t => {
  await t.throwsAsync(
    translateMarkdown({
      title: '',
      markdown: 'See [docs](https://e.com)',
      from: 'en',
      to: 'pl',
      generate: async () => 'Zobacz dokumentację',
    }),
    { instanceOf: TranslationStructureError }
  );
});
