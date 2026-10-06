import { Injectable, Logger } from '@nestjs/common';
import * as Y from 'yjs';

import { DocReader } from '../../core/doc';
import { Models } from '../../models';
import { createDocWithMarkdown } from '../../native';
import { unrepresentableBlocks } from '../mcp/tools/documents';
import { linkifyReferences, pageIdFromHref } from '../mcp/tools/references';
import { GeminiRateLimited } from './gemini';
import { isTranslationLanguage } from './languages';
import { TranslationProvider } from './provider';
import { translateMarkdown } from './translator';

/** Rate-limit retries before a row is marked failed. */
const MAX_RATE_LIMIT_RETRIES = 6;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 60 * 60_000;

const LINK_TARGET = /\]\(\s*([^)\s]+)[^)]*\)/g;

/**
 * The native writer stores every link as a plain URL. Turn the ones that point
 * at pages of this workspace back into page references, as the editor does.
 */
function withPageReferences(
  bin: Uint8Array,
  markdown: string,
  workspaceId: string
) {
  const pageIds = new Set(
    [...markdown.matchAll(LINK_TARGET)]
      .map(match => pageIdFromHref(match[1], workspaceId))
      .filter((id): id is string => !!id)
  );
  if (!pageIds.size) return bin;

  const doc = new Y.Doc();
  Y.applyUpdate(doc, bin);
  linkifyReferences(doc, workspaceId, pageIds);
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

@Injectable()
export class DocTranslationWorker {
  private readonly logger = new Logger(DocTranslationWorker.name);

  constructor(
    private readonly models: Models,
    private readonly reader: DocReader,
    private readonly provider: TranslationProvider
  ) {}

  /** Handle one due translation. False when the queue is empty. */
  async processNext() {
    const row = await this.models.docTranslation.claimNext();
    if (!row) return false;

    const { workspaceId, docId, lang } = row;
    if (!(await this.models.doc.isPublic(workspaceId, docId))) {
      await this.models.docTranslation.deleteForDoc(workspaceId, docId);
      return true;
    }

    try {
      await this.translate(row);
    } catch (error) {
      if (
        error instanceof GeminiRateLimited &&
        row.attempts < MAX_RATE_LIMIT_RETRIES
      ) {
        const delay = Math.min(
          BACKOFF_BASE_MS * 2 ** row.attempts,
          BACKOFF_MAX_MS
        );
        await this.models.docTranslation.postpone(
          workspaceId,
          docId,
          lang,
          new Date(Date.now() + delay)
        );
        return true;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Translation of ${workspaceId}/${docId} to ${lang} failed: ${message}`
      );
      await this.models.docTranslation.fail(workspaceId, docId, lang, message);
    }
    return true;
  }

  private async translate(row: {
    workspaceId: string;
    docId: string;
    lang: string;
    sourceLang: string;
  }) {
    const { workspaceId, docId, lang, sourceLang } = row;
    const generate = this.provider.generator();
    if (!generate) {
      throw new Error(
        'Translation is not configured: set translate.gemini.apiKey in the admin panel.'
      );
    }
    if (!isTranslationLanguage(lang) || !isTranslationLanguage(sourceLang)) {
      throw new Error(`Unsupported language pair ${sourceLang} -> ${lang}.`);
    }

    const content = await this.reader.getDocMarkdown(workspaceId, docId, false);
    if (!content) {
      throw new Error('The document has no saved content yet.');
    }
    const unsupported = unrepresentableBlocks(content);
    if (unsupported.length) {
      throw new Error(
        `The document contains blocks that cannot be translated: ${unsupported.join(', ')}.`
      );
    }

    const result = await translateMarkdown({
      title: content.title,
      markdown: content.markdown,
      from: sourceLang,
      to: lang,
      generate,
    });
    const bin = withPageReferences(
      createDocWithMarkdown(result.title, result.markdown, docId),
      result.markdown,
      workspaceId
    );
    await this.models.docTranslation.complete(workspaceId, docId, lang, {
      title: result.title,
      bin,
      sourceTimestamp: new Date(Number(content.revision)),
    });
  }
}
