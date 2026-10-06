import { Controller, Get, Param, Res } from '@nestjs/common';
import type { Response } from 'express';

import { CallMetric, DocActionDenied, DocNotFound } from '../../base';
import { CurrentUser, Public } from '../../core/auth';
import { PermissionAccess } from '../../core/permission';
import { Models } from '../../models';
import { TranslateFeatureService } from './feature';

/**
 * Translations of a public doc, readable by anyone who may read the doc
 * itself. Sits beside the core `/public-docs/:docId` routes.
 */
@Controller('/api/workspaces')
export class DocTranslationController {
  constructor(
    private readonly models: Models,
    private readonly ac: PermissionAccess,
    private readonly feature: TranslateFeatureService
  ) {}

  private async assertCanReadDoc(
    user: CurrentUser | undefined,
    workspaceId: string,
    docId: string
  ) {
    const canRead = await this.ac
      .user(user?.id ?? 'anonymous')
      .doc(workspaceId, docId)
      .can('Doc.Read');
    if (!canRead) {
      throw new DocActionDenied({
        docId,
        spaceId: workspaceId,
        action: 'Doc.Read',
      });
    }
  }

  @Public()
  @Get('/:id/public-docs/:docId/translations')
  @CallMetric('controllers', 'workspace_get_public_doc_translations')
  async languages(
    @CurrentUser() user: CurrentUser | undefined,
    @Param('id') workspaceId: string,
    @Param('docId') docId: string
  ) {
    await this.assertCanReadDoc(user, workspaceId, docId);
    if (!this.feature.enabled) return { sourceLang: null, languages: [] };

    const rows = await this.models.docTranslation.servedLanguages(
      workspaceId,
      docId
    );
    return {
      sourceLang: rows[0]?.sourceLang ?? null,
      languages: rows.map(row => row.lang),
    };
  }

  @Public()
  @Get('/:id/public-docs/:docId/translations/:lang')
  @CallMetric('controllers', 'workspace_get_public_doc_translation')
  async translation(
    @CurrentUser() user: CurrentUser | undefined,
    @Param('id') workspaceId: string,
    @Param('docId') docId: string,
    @Param('lang') lang: string,
    @Res() res: Response
  ) {
    await this.assertCanReadDoc(user, workspaceId, docId);
    const served = this.feature.enabled
      ? await this.models.docTranslation.getServed(workspaceId, docId, lang)
      : null;
    if (!served) {
      throw new DocNotFound({ spaceId: workspaceId, docId });
    }

    // A translation is always a page, whatever mode the source is shared in.
    res.setHeader('publish-mode', 'page');
    res.setHeader('content-type', 'application/octet-stream');
    res.send(served.bin);
  }
}
