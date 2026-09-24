import './config';

import { Module } from '@nestjs/common';

import { CommentRealtimeModule } from '../../core/comment';
import { DocStorageModule } from '../../core/doc';
import { NotificationModule } from '../../core/notification';
import { PermissionModule } from '../../core/permission';
import { StorageModule } from '../../core/storage';
import { IndexerModule } from '../indexer';
import { DOCUMENT_VECTOR_SEARCH, DocumentRetrievalService } from '../retrieval';
import { WorkspaceMcpController } from './controller';
import { McpCredentialService } from './credential';
import { McpFeatureGuard, McpFeatureService } from './feature';
import { WorkspaceMcpProvider } from './provider';
import { McpCredentialResolver } from './resolver';
import { NullDocumentVectorSearch } from './vector-search';

@Module({
  imports: [
    DocStorageModule,
    PermissionModule,
    IndexerModule,
    StorageModule,
    CommentRealtimeModule,
    NotificationModule,
  ],
  providers: [
    McpFeatureService,
    McpFeatureGuard,
    NullDocumentVectorSearch,
    { provide: DOCUMENT_VECTOR_SEARCH, useExisting: NullDocumentVectorSearch },
    DocumentRetrievalService,
    WorkspaceMcpProvider,
    McpCredentialService,
    McpCredentialResolver,
  ],
  controllers: [WorkspaceMcpController],
})
export class McpModule {}

export { McpEnabled, McpFeatureGuard, McpFeatureService } from './feature';
