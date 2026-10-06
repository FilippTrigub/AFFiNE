import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';

import { BaseModel } from './base';

export type DocTranslationStatus = 'pending' | 'running' | 'ready' | 'failed';

/** A row left `running` this long belongs to a worker that died. */
const STALE_RUN_MS = 10 * 60 * 1000;

/** Every column except the snapshot, which only the public route needs. */
const SUMMARY = {
  workspaceId: true,
  docId: true,
  lang: true,
  sourceLang: true,
  status: true,
  title: true,
  error: true,
  sourceTimestamp: true,
  attempts: true,
  availableAt: true,
  updatedAt: true,
} as const;

const key = (workspaceId: string, docId: string, lang: string) => ({
  workspaceId_docId_lang: { workspaceId, docId, lang },
});

@Injectable()
export class DocTranslationModel extends BaseModel {
  list(workspaceId: string, docId: string) {
    return this.db.docTranslation.findMany({
      where: { workspaceId, docId },
      select: SUMMARY,
      orderBy: { lang: 'asc' },
    });
  }

  /**
   * Make the doc's translation set exactly `langs`. New languages, and every
   * language when the source language changed, are queued; finished rows of
   * an unchanged source language are kept as they are.
   */
  @Transactional()
  async setLanguages(
    workspaceId: string,
    docId: string,
    sourceLang: string,
    langs: string[]
  ) {
    await this.db.docTranslation.deleteMany({
      where: { workspaceId, docId, lang: { notIn: langs } },
    });
    await this.db.docTranslation.updateMany({
      where: { workspaceId, docId, sourceLang: { not: sourceLang } },
      data: {
        sourceLang,
        status: 'pending',
        attempts: 0,
        error: null,
        availableAt: new Date(),
      },
    });
    await this.db.docTranslation.createMany({
      data: langs.map(lang => ({ workspaceId, docId, lang, sourceLang })),
      skipDuplicates: true,
    });
  }

  /** Queue every language of the doc again; served snapshots stay. */
  async requeue(workspaceId: string, docId: string) {
    await this.db.docTranslation.updateMany({
      where: { workspaceId, docId },
      data: {
        status: 'pending',
        attempts: 0,
        error: null,
        availableAt: new Date(),
      },
    });
  }

  /**
   * Take the next due row for translation. The conditional update makes the
   * claim safe when several server instances poll at once.
   */
  async claimNext() {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - STALE_RUN_MS);
    const candidates = await this.db.docTranslation.findMany({
      where: {
        OR: [
          { status: 'pending', availableAt: { lte: now } },
          { status: 'running', updatedAt: { lt: staleBefore } },
        ],
      },
      select: SUMMARY,
      orderBy: { availableAt: 'asc' },
      take: 5,
    });
    for (const row of candidates) {
      const { count } = await this.db.docTranslation.updateMany({
        where: {
          workspaceId: row.workspaceId,
          docId: row.docId,
          lang: row.lang,
          status: row.status,
          updatedAt: row.updatedAt,
        },
        data: { status: 'running' },
      });
      if (count === 1) return row;
    }
    return null;
  }

  async complete(
    workspaceId: string,
    docId: string,
    lang: string,
    result: { title: string; bin: Uint8Array; sourceTimestamp: Date }
  ) {
    await this.db.docTranslation.update({
      where: key(workspaceId, docId, lang),
      data: {
        status: 'ready',
        error: null,
        title: result.title,
        bin: Buffer.from(result.bin),
        sourceTimestamp: result.sourceTimestamp,
      },
    });
  }

  async fail(workspaceId: string, docId: string, lang: string, error: string) {
    await this.db.docTranslation.update({
      where: key(workspaceId, docId, lang),
      data: { status: 'failed', error: error.slice(0, 1000) },
    });
  }

  /** Put a row back in the queue, not before `until`. */
  async postpone(
    workspaceId: string,
    docId: string,
    lang: string,
    until: Date
  ) {
    await this.db.docTranslation.update({
      where: key(workspaceId, docId, lang),
      data: {
        status: 'pending',
        availableAt: until,
        attempts: { increment: 1 },
      },
    });
  }

  /** The last finished translation, even while a newer one is in progress. */
  async getServed(workspaceId: string, docId: string, lang: string) {
    const row = await this.db.docTranslation.findUnique({
      where: key(workspaceId, docId, lang),
      select: { title: true, bin: true },
    });
    return row?.bin ? { title: row.title, bin: row.bin } : null;
  }

  /** Languages a reader can switch to right now. */
  async servedLanguages(workspaceId: string, docId: string) {
    const rows = await this.db.docTranslation.findMany({
      where: { workspaceId, docId, bin: { not: null } },
      select: { lang: true, sourceLang: true },
      orderBy: { lang: 'asc' },
    });
    return rows;
  }

  async deleteForDoc(workspaceId: string, docId: string) {
    await this.db.docTranslation.deleteMany({ where: { workspaceId, docId } });
  }
}
