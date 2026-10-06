export {
  type DocTranslation,
  DocTranslationsService,
} from './services/doc-translations';
export { ShareDocsListService } from './services/share-docs-list';
export { ShareInfoService } from './services/share-info';
export {
  TRANSLATION_LANGUAGES,
  translationLanguageName,
} from './translation-languages';

import { type Framework } from '@toeverything/infra';

import { WorkspaceServerService } from '../cloud';
import { DocScope, DocService } from '../doc';
import { NbstoreService } from '../storage';
import {
  WorkspaceLocalCache,
  WorkspaceScope,
  WorkspaceService,
} from '../workspace';
import { ShareDocsList } from './entities/share-docs-list';
import { ShareInfo } from './entities/share-info';
import { DocTranslationsService } from './services/doc-translations';
import { ShareDocsListService } from './services/share-docs-list';
import { ShareInfoService } from './services/share-info';
import { DocTranslationsStore } from './stores/doc-translations';
import { ShareStore } from './stores/share';
import { ShareDocsStore } from './stores/share-docs';

export function configureShareDocsModule(framework: Framework) {
  framework
    .scope(WorkspaceScope)
    .service(ShareDocsListService, [WorkspaceService])
    .store(ShareDocsStore, [WorkspaceServerService])
    .entity(ShareDocsList, [
      WorkspaceService,
      ShareDocsStore,
      WorkspaceLocalCache,
    ])
    .scope(DocScope)
    .service(ShareInfoService)
    .entity(ShareInfo, [WorkspaceService, DocService, ShareStore])
    .store(ShareStore, [WorkspaceServerService, NbstoreService])
    .service(DocTranslationsService, [
      WorkspaceService,
      DocService,
      DocTranslationsStore,
    ])
    .store(DocTranslationsStore, [WorkspaceServerService]);
}
