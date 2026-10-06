import {
  Args,
  Field,
  Mutation,
  ObjectType,
  Query,
  registerEnumType,
  Resolver,
} from '@nestjs/graphql';

import { BadRequest, DocIsNotPublic } from '../../base';
import { CurrentUser } from '../../core/auth';
import { DocReader } from '../../core/doc';
import { PermissionAccess } from '../../core/permission';
import { Models } from '../../models';
import { TranslateEnabled } from './feature';
import { isTranslationLanguage } from './languages';

enum DocTranslationStatus {
  pending = 'pending',
  running = 'running',
  ready = 'ready',
  failed = 'failed',
}

registerEnumType(DocTranslationStatus, { name: 'DocTranslationStatus' });

@ObjectType()
export class DocTranslationType {
  @Field()
  lang!: string;

  @Field()
  sourceLang!: string;

  @Field(() => DocTranslationStatus)
  status!: DocTranslationStatus;

  @Field(() => String, { nullable: true })
  title!: string | null;

  @Field(() => String, { nullable: true })
  error!: string | null;

  @Field(() => Date, {
    nullable: true,
    description: 'Source revision the served translation was made from',
  })
  sourceTimestamp!: Date | null;

  @Field({ description: 'The source doc changed after this translation' })
  outOfDate!: boolean;
}

@TranslateEnabled()
@Resolver(() => DocTranslationType)
export class DocTranslationResolver {
  constructor(
    private readonly models: Models,
    private readonly ac: PermissionAccess,
    private readonly reader: DocReader
  ) {}

  @Query(() => [DocTranslationType])
  async docTranslations(
    @CurrentUser() user: CurrentUser,
    @Args('workspaceId') workspaceId: string,
    @Args('docId') docId: string
  ) {
    await this.ac.user(user.id).doc(workspaceId, docId).assert('Doc.Read');
    return await this.present(workspaceId, docId);
  }

  @Mutation(() => [DocTranslationType], {
    description:
      'Choose the languages a published doc is translated into. Languages left out are deleted.',
  })
  async setDocTranslations(
    @CurrentUser() user: CurrentUser,
    @Args('workspaceId') workspaceId: string,
    @Args('docId') docId: string,
    @Args('sourceLang') sourceLang: string,
    @Args({ name: 'languages', type: () => [String] }) languages: string[]
  ) {
    await this.assertCanPublish(user, workspaceId, docId);
    const targets = [...new Set(languages)];
    for (const lang of [sourceLang, ...targets]) {
      if (!isTranslationLanguage(lang)) {
        throw new BadRequest(`Unsupported language: ${lang}`);
      }
    }
    if (targets.includes(sourceLang)) {
      throw new BadRequest('The source language cannot also be a target.');
    }

    await this.models.docTranslation.setLanguages(
      workspaceId,
      docId,
      sourceLang,
      targets
    );
    return await this.present(workspaceId, docId);
  }

  @Mutation(() => [DocTranslationType], {
    description: 'Translate every language of a published doc again.',
  })
  async refreshDocTranslations(
    @CurrentUser() user: CurrentUser,
    @Args('workspaceId') workspaceId: string,
    @Args('docId') docId: string
  ) {
    await this.assertCanPublish(user, workspaceId, docId);
    await this.models.docTranslation.requeue(workspaceId, docId);
    return await this.present(workspaceId, docId);
  }

  /** Translations belong to publishing: same permission, public docs only. */
  private async assertCanPublish(
    user: CurrentUser,
    workspaceId: string,
    docId: string
  ) {
    await this.ac.user(user.id).doc(workspaceId, docId).assert('Doc.Publish');
    if (!(await this.models.doc.isPublic(workspaceId, docId))) {
      throw new DocIsNotPublic();
    }
  }

  private async present(
    workspaceId: string,
    docId: string
  ): Promise<DocTranslationType[]> {
    const rows = await this.models.docTranslation.list(workspaceId, docId);
    if (!rows.length) return [];
    const source = await this.reader.getDoc(workspaceId, docId);
    const current = source?.timestamp ?? 0;
    return rows.map(row => ({
      lang: row.lang,
      sourceLang: row.sourceLang,
      status: row.status as DocTranslationStatus,
      title: row.title,
      error: row.error,
      sourceTimestamp: row.sourceTimestamp,
      outOfDate:
        !!row.sourceTimestamp && row.sourceTimestamp.getTime() < current,
    }));
  }
}
