import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { OnEvent } from '../../base';
import { Models } from '../../models';
import { TranslateFeatureService } from './feature';
import { DocTranslationWorker } from './worker';

/** Stop picking new rows after this, so one tick stays inside its slot. */
const TICK_BUDGET_MS = 25_000;

@Injectable()
export class DocTranslationJob {
  constructor(
    private readonly feature: TranslateFeatureService,
    private readonly worker: DocTranslationWorker,
    private readonly models: Models
  ) {}

  @Cron(CronExpression.EVERY_30_SECONDS, { waitForCompletion: true })
  async run() {
    if (!this.feature.enabled) return;
    const deadline = Date.now() + TICK_BUDGET_MS;
    while (Date.now() < deadline && (await this.worker.processNext())) {
      // one row per iteration; the free tier is rate limited per minute
    }
  }

  @OnEvent('doc.public_state.changed', { suppressError: true })
  async onPublicStateChanged({
    workspaceId,
    docId,
  }: Events['doc.public_state.changed']) {
    if (!(await this.models.doc.isPublic(workspaceId, docId))) {
      await this.models.docTranslation.deleteForDoc(workspaceId, docId);
    }
  }
}
