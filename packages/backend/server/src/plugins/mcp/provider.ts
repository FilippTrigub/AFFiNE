import { Injectable } from '@nestjs/common';
import { McpAccessMode } from '@prisma/client';
import z from 'zod/v3';

import { DocReader, DocWriter } from '../../core/doc';
import { PermissionAccess } from '../../core/permission';
import { DocRole, Models } from '../../models';
import { DocumentRetrievalService } from '../retrieval/document';

type McpTextContent = {
  type: 'text';
  text: string;
};

export type WorkspaceMcpToolResult = {
  content: McpTextContent[];
  isError?: boolean;
};

export type WorkspaceMcpToolDefinition = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (
    args: Record<string, unknown>,
    options: { signal: AbortSignal }
  ) => Promise<WorkspaceMcpToolResult>;
};

export type WorkspaceMcpServer = {
  name: string;
  version: string;
  tools: WorkspaceMcpToolDefinition[];
};

type ToolExecutorInput<T extends z.ZodTypeAny> = {
  name: string;
  title: string;
  description: string;
  parser: T;
  inputSchema: Record<string, unknown>;
  execute: (
    args: z.infer<T>,
    options: { signal: AbortSignal }
  ) => Promise<WorkspaceMcpToolResult>;
};

function toolText(text: string): WorkspaceMcpToolResult {
  return {
    content: [{ type: 'text', text }],
  };
}

function toolError(message: string): WorkspaceMcpToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
  };
}

function toInputError(error: z.ZodError) {
  const details = error.issues
    .map(issue => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
  return toolError(`Invalid arguments: ${details || 'Invalid input'}`);
}

function abortIfNeeded(
  signal: AbortSignal
): WorkspaceMcpToolResult | undefined {
  if (signal.aborted) return toolError('Request aborted.');
  return;
}

function defineTool<T extends z.ZodTypeAny>(
  config: ToolExecutorInput<T>
): WorkspaceMcpToolDefinition {
  return {
    name: config.name,
    title: config.title,
    description: config.description,
    inputSchema: config.inputSchema,
    execute: async (args, options) => {
      const aborted = abortIfNeeded(options.signal);
      if (aborted) return aborted;

      const parsed = config.parser.safeParse(args ?? {});
      if (!parsed.success) return toInputError(parsed.error);
      return await config.execute(parsed.data, options);
    },
  };
}

@Injectable()
export class WorkspaceMcpProvider {
  constructor(
    private readonly ac: PermissionAccess,
    private readonly models: Models,
    private readonly reader: DocReader,
    private readonly writer: DocWriter,
    private readonly retrieval: DocumentRetrievalService
  ) {}

  async for(
    userId: string,
    workspaceId: string,
    accessMode: McpAccessMode = McpAccessMode.READ_ONLY
  ): Promise<WorkspaceMcpServer> {
    const agentGrants = await this.agentGrants(userId, workspaceId);

    // An agent is not a workspace member, so it cannot satisfy a workspace-level
    // action. Its right to be here is the credential the controller already
    // verified, which is bound to this workspace; what it may reach is decided
    // per document below.
    if (!agentGrants) {
      await this.ac
        .user(userId)
        .workspace(workspaceId)
        .assert('Workspace.Read');
    }

    /**
     * For a workspace agent, its explicit `doc_grants` rows are the exhaustive
     * list of what it may touch, and a doc with no grant is invisible to it.
     *
     * The permission engine cannot express this: a member with no grant falls
     * through to the workspace's `member_default_doc_role`, which is a property
     * of the doc, not of the user -- so containing the agent there would mean
     * setting the workspace to deny-by-default and stripping every human member
     * at the same time. Enforcing it at this boundary is safe because an agent
     * identity is refused on every other surface (`core/auth/guard.ts`), so MCP
     * is the only way it can act.
     *
     * `null` for a human: their own permissions govern, exactly as before.
     */
    const grantedRole = (docId: string) => agentGrants?.get(docId) ?? null;
    const agentMayRead = (docId: string) =>
      !agentGrants || agentGrants.has(docId);
    const agentMayWrite = (docId: string) =>
      !agentGrants || (grantedRole(docId) ?? DocRole.None) >= DocRole.Editor;

    const readDocument = defineTool({
      name: 'read_document',
      title: 'Read Document',
      description: 'Read a document with given ID',
      parser: z.object({ docId: z.string() }),
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
        },
        required: ['docId'],
        additionalProperties: false,
      },
      execute: async ({ docId }, options) => {
        const notFoundError = toolError(`Doc with id ${docId} not found.`);

        // "Not found" rather than "forbidden", so an agent cannot probe for the
        // existence of documents it was not granted.
        if (!agentMayRead(docId)) return notFoundError;

        const accessible = await this.ac
          .user(userId)
          .workspace(workspaceId)
          .doc(docId)
          .can('Doc.Read');
        if (!accessible) return notFoundError;

        const abortedAfterPermission = abortIfNeeded(options.signal);
        if (abortedAfterPermission) return abortedAfterPermission;

        const content = await this.reader.getDocMarkdown(
          workspaceId,
          docId,
          false
        );
        if (!content) return notFoundError;

        const abortedAfterRead = abortIfNeeded(options.signal);
        if (abortedAfterRead) return abortedAfterRead;

        return toolText(content.markdown);
      },
    });

    const docSearch = defineTool({
      name: 'doc_search',
      title: 'Document Search',
      description:
        'Search persisted workspace documents and return bounded passages with Page or canvas locators. Retrieval strategy is selected by the server and never includes files, blobs, attachments, or the web.',
      parser: z.object({
        query: z.string().trim().min(1).max(2000),
        doc_ids: z.array(z.string().min(1).max(128)).max(50).optional(),
        limit: z.number().int().min(1).max(20).optional(),
      }),
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          doc_ids: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 50,
          },
          limit: { type: 'integer', minimum: 1, maximum: 20 },
        },
        required: ['query'],
        additionalProperties: false,
      },
      execute: async ({ query, doc_ids, limit }, options) => {
        // Narrowing the candidate set before retrieval, so a hit on an
        // ungranted doc cannot reach the agent even as an excerpt.
        const scopedDocIds = agentGrants
          ? (doc_ids ?? [...agentGrants.keys()]).filter(id =>
              agentGrants.has(id)
            )
          : doc_ids;
        if (agentGrants && scopedDocIds?.length === 0) {
          return toolText(JSON.stringify({ retrieval_mode: 'none', hits: [] }));
        }

        const result = await this.retrieval.search(
          { user: userId, workspace: workspaceId },
          query,
          scopedDocIds,
          limit ?? 10,
          options.signal
        );
        return toolText(
          JSON.stringify({
            retrieval_mode: result.retrievalMode,
            degraded_reason: result.degradedReason,
            hits: result.hits.map(hit => ({
              doc_id: hit.docId,
              title: hit.title,
              excerpt: hit.excerpt,
              visibility: hit.visibility,
              block_id: hit.blockId,
              element_id: hit.elementId,
              frame_id: hit.frameId,
            })),
          })
        );
      },
    });

    const tools = [readDocument, docSearch];

    if (accessMode === McpAccessMode.READ_WRITE) {
      const createDocument = defineTool({
        name: 'create_document',
        title: 'Create Document',
        description:
          'Create a new document in the workspace with the given title and markdown content. Returns the ID of the created document. This tool not support insert or update database block and image yet.',
        parser: z.object({
          title: z.string().min(1),
          content: z.string(),
        }),
        inputSchema: {
          type: 'object',
          properties: {
            title: {
              type: 'string',
              description: 'The title of the new document',
            },
            content: {
              type: 'string',
              description: 'The markdown content for the document body',
            },
          },
          required: ['title', 'content'],
          additionalProperties: false,
        },
        execute: async ({ title, content }, options) => {
          try {
            if (!agentGrants) {
              await this.ac
                .user(userId)
                .workspace(workspaceId)
                .assert('Workspace.CreateDoc');
            }
            const abortedBeforeWrite = abortIfNeeded(options.signal);
            if (abortedBeforeWrite) return abortedBeforeWrite;

            const sanitizedTitle = title.replace(/[\r\n]+/g, ' ').trim();
            if (!sanitizedTitle) throw new Error('Title cannot be empty');
            const strippedContent = content.replace(
              /^[ \t]{0,3}#\s+[^\n]*#*\s*\n*/,
              ''
            );
            const result = await this.writer.createDoc(
              workspaceId,
              sanitizedTitle,
              strippedContent,
              userId
            );

            // An agent sees only what it holds a grant on, so without this it
            // could not read back the document it just wrote. Editor, not
            // Manager: it may revise its own work, not administer it.
            if (agentGrants) {
              await this.models.docUser.set(
                workspaceId,
                result.docId,
                userId,
                DocRole.Editor
              );
              agentGrants.set(result.docId, DocRole.Editor);
            }

            return toolText(
              JSON.stringify({
                success: true,
                docId: result.docId,
                message: `Document "${title}" created successfully`,
              })
            );
          } catch (error) {
            return toolError(
              `Failed to create document: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
          }
        },
      });

      const updateDocument = defineTool({
        name: 'update_document',
        title: 'Update Document',
        description:
          'Update an existing document with new markdown content (body only). Uses structural diffing to apply minimal changes, preserving document history and enabling real-time collaboration. This does NOT update the document title. This tool not support insert or update database block and image yet.',
        parser: z.object({
          docId: z.string(),
          content: z.string(),
        }),
        inputSchema: {
          type: 'object',
          properties: {
            docId: {
              type: 'string',
              description: 'The ID of the document to update',
            },
            content: {
              type: 'string',
              description:
                'The complete new markdown content for the document body (do NOT include a title H1)',
            },
          },
          required: ['docId', 'content'],
          additionalProperties: false,
        },
        execute: async ({ docId, content }, options) => {
          const notFoundError = toolError(`Doc with id ${docId} not found.`);

          if (!agentMayWrite(docId)) return notFoundError;

          const canUpdate = await this.ac
            .user(userId)
            .workspace(workspaceId)
            .doc(docId)
            .can('Doc.Update');
          if (!canUpdate) return notFoundError;
          const abortedBeforeWrite = abortIfNeeded(options.signal);
          if (abortedBeforeWrite) return abortedBeforeWrite;

          try {
            await this.writer.updateDoc(workspaceId, docId, content, userId);
            return toolText(
              JSON.stringify({
                success: true,
                docId,
                message: 'Document updated successfully',
              })
            );
          } catch {
            return notFoundError;
          }
        },
      });

      const updateDocumentMeta = defineTool({
        name: 'update_document_meta',
        title: 'Update Document Metadata',
        description: 'Update document metadata (currently title only).',
        parser: z.object({
          docId: z.string(),
          title: z.string().min(1),
        }),
        inputSchema: {
          type: 'object',
          properties: {
            docId: {
              type: 'string',
              description: 'The ID of the document to update',
            },
            title: {
              type: 'string',
              description: 'The new document title',
            },
          },
          required: ['docId', 'title'],
          additionalProperties: false,
        },
        execute: async ({ docId, title }, options) => {
          const notFoundError = toolError(`Doc with id ${docId} not found.`);

          if (!agentMayWrite(docId)) return notFoundError;

          const canUpdate = await this.ac
            .user(userId)
            .workspace(workspaceId)
            .doc(docId)
            .can('Doc.Update');
          if (!canUpdate) return notFoundError;
          const abortedBeforeWrite = abortIfNeeded(options.signal);
          if (abortedBeforeWrite) return abortedBeforeWrite;

          try {
            const sanitizedTitle = title.replace(/[\r\n]+/g, ' ').trim();
            if (!sanitizedTitle) throw new Error('Title cannot be empty');

            await this.writer.updateDocMeta(
              workspaceId,
              docId,
              { title: sanitizedTitle },
              userId
            );

            return toolText(
              JSON.stringify({
                success: true,
                docId,
                message: 'Document title updated successfully',
              })
            );
          } catch {
            return notFoundError;
          }
        },
      });

      tools.push(createDocument, updateDocument, updateDocumentMeta);
    }

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
    const agent = await this.models.workspace.getAgent(workspaceId);
    if (!agent || agent.id !== userId) {
      return null;
    }
    const grants = await this.models.docUser.findGrantsByUser(
      workspaceId,
      userId
    );
    return new Map(grants.map(grant => [grant.docId, grant.role]));
  }
}
