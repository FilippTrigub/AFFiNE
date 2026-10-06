import type { GenerateText } from './gemini';
import { LANGUAGE_NAMES, type TranslationLanguage } from './languages';
import { joinChunks, sameStructure, splitMarkdown } from './markdown';

/** Keeps each request well inside one model response. */
const DEFAULT_MAX_CHUNK_CHARS = 4000;
const ATTEMPTS_PER_CHUNK = 2;

export class TranslationStructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranslationStructureError';
  }
}

function systemPrompt(from: TranslationLanguage, to: TranslationLanguage) {
  return [
    `You translate Markdown documents from ${LANGUAGE_NAMES[from]} to ${LANGUAGE_NAMES[to]}.`,
    'Translate only the human-readable prose. Return only the translated Markdown, with no commentary and no surrounding code fence.',
    'Keep every Markdown construct exactly as it is: headings, list markers and nesting, block quotes, tables, emphasis, line breaks.',
    'Keep link targets and image URLs unchanged, including affine:// links; translate only the link text.',
    'Do not translate code blocks or inline code.',
    'Never translate the name "DroneAid".',
  ].join('\n');
}

const WRAPPING_FENCE = /^\s*```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/;

/** Models sometimes wrap their whole answer in a ```markdown fence. */
function unwrap(source: string, output: string) {
  if (WRAPPING_FENCE.test(source)) return output.trim();
  return output.replace(WRAPPING_FENCE, '$1').trim();
}

async function translateChunk(
  chunk: string,
  system: string,
  generate: GenerateText
) {
  for (let attempt = 1; attempt <= ATTEMPTS_PER_CHUNK; attempt++) {
    const output = unwrap(chunk, await generate(system, chunk));
    if (sameStructure(chunk, output)) return output;
  }
  throw new TranslationStructureError(
    `The translation changed the document structure twice in a row near: ${chunk.slice(0, 80)}`
  );
}

/**
 * Translate a document's title and markdown body. The title travels as a
 * leading H1 of the first chunk, so it costs no extra request.
 */
export async function translateMarkdown(options: {
  title: string;
  markdown: string;
  from: TranslationLanguage;
  to: TranslationLanguage;
  generate: GenerateText;
  maxChunkChars?: number;
}) {
  const title = options.title.trim();
  const source = title ? `# ${title}\n\n${options.markdown}` : options.markdown;
  const system = systemPrompt(options.from, options.to);

  const translated: string[] = [];
  const chunks = splitMarkdown(
    source,
    options.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS
  );
  // Sequential on purpose: the free tier is rate limited per minute.
  for (const chunk of chunks) {
    translated.push(await translateChunk(chunk, system, options.generate));
  }

  const markdown = joinChunks(translated);
  if (!title) return { title: '', markdown };

  const match = /^#\s+([^\n]*)\n*/.exec(markdown);
  return {
    title: match ? match[1].trim() : title,
    markdown: match ? markdown.slice(match[0].length) : markdown,
  };
}
