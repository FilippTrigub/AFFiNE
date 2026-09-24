import { Injectable } from '@nestjs/common';
import { McpAccessMode } from '@prisma/client';

import { EventBus } from '../../base';
import { BackendRuntimeProvider } from '../../core/backend-runtime';
import { CommentService } from '../../core/comment';
import {
  DocReader,
  DocWriter,
  PgWorkspaceDocStorageAdapter,
  WorkspaceYjsMutator,
} from '../../core/doc';
import { NotificationService } from '../../core/notification/service';
import { PermissionAccess } from '../../core/permission';
import { RealtimePublisher } from '../../core/realtime';
import { WorkspaceBlobStorage } from '../../core/storage';
import { Models } from '../../models';
import { DocumentRetrievalService } from '../retrieval/document';
import { buildBlobTools } from './tools/blobs';
import { buildCollaborationTools } from './tools/collaboration';
import { buildCollectionTools } from './tools/collections';
import { McpToolContext, type McpToolDeps } from './tools/context';
import type { McpTool, WorkspaceMcpToolDefinition } from './tools/define';
import { buildDocumentInfoTools } from './tools/document-info';
import { buildDocumentTools } from './tools/documents';
import { buildFolderTools } from './tools/folders';
import { buildSidebarTools } from './tools/sidebar';
import { buildTagTools } from './tools/tags';

export type {
  WorkspaceMcpToolDefinition,
  WorkspaceMcpToolResult,
} from './tools/define';

export type WorkspaceMcpServer = {
  name: string;
  version: string;
  tools: WorkspaceMcpToolDefinition[];
};

@Injectable()
export class WorkspaceMcpProvider {
  private readonly deps: McpToolDeps;

  constructor(
    ac: PermissionAccess,
    models: Models,
    reader: DocReader,
    writer: DocWriter,
    retrieval: DocumentRetrievalService,
    yjs: WorkspaceYjsMutator,
    storage: PgWorkspaceDocStorageAdapter,
    runtime: BackendRuntimeProvider,
    comments: CommentService,
    notifications: NotificationService,
    realtime: RealtimePublisher,
    blobs: WorkspaceBlobStorage,
    event: EventBus
  ) {
    this.deps = {
      ac,
      models,
      reader,
      writer,
      retrieval,
      yjs,
      storage,
      runtime,
      comments,
      notifications,
      realtime,
      blobs,
      event,
    };
  }

  async for(
    userId: string,
    workspaceId: string,
    accessMode: McpAccessMode = McpAccessMode.READ_ONLY
  ): Promise<WorkspaceMcpServer> {
    const agentGrants = await this.agentGrants(userId, workspaceId);

    // An agent is not a workspace member, so it cannot satisfy a workspace-level
    // action. Its right to be here is the credential the controller already
    // verified, which is bound to this workspace; what it may reach is decided
    // per document by `McpToolContext`.
    //
    // The permission engine cannot express that containment: a member with no
    // grant falls through to the workspace's `member_default_doc_role`, which is
    // a property of the doc, not of the user. Enforcing it at this boundary is
    // safe because an agent identity is refused on every other surface
    // (`core/auth/guard.ts`), so MCP is the only way it can act.
    if (!agentGrants) {
      await this.deps.ac
        .user(userId)
        .workspace(workspaceId)
        .assert('Workspace.Read');
    }

    const ctx = new McpToolContext(userId, workspaceId, agentGrants, this.deps);
    const all: McpTool[] = [
      ...buildDocumentTools(ctx),
      ...buildDocumentInfoTools(ctx),
      ...buildBlobTools(ctx),
      ...buildFolderTools(ctx),
      ...buildTagTools(ctx),
      ...buildCollectionTools(ctx),
      ...buildSidebarTools(ctx),
      ...buildCollaborationTools(ctx),
    ];

    const tools = all
      .filter(
        tool =>
          tool.access === 'read' || accessMode === McpAccessMode.READ_WRITE
      )
      .filter(tool => tool.audience === 'all' || !agentGrants)
      .map(tool => tool.definition);

    return {
      name: `AFFiNE MCP Server for Workspace ${workspaceId}`,
      version: '1.0.1',
      tools,
    };
  }

  /**
   * A doc id -> granted role map when the credential belongs to this
   * workspace's agent, `null` when it belongs to a person.
   */
  private async agentGrants(userId: string, workspaceId: string) {
    const agent = await this.deps.models.workspace.getAgent(workspaceId);
    if (!agent || agent.id !== userId) {
      return null;
    }
    const grants = await this.deps.models.docUser.findGrantsByUser(
      workspaceId,
      userId
    );
    return new Map(grants.map(grant => [grant.docId, grant.role]));
  }
}
