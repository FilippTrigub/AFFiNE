import z from 'zod/v3';

import type { McpToolContext } from './context';
import {
  abortIfNeeded,
  docNotFound,
  errorMessage,
  type McpTool,
  mcpTool,
  sanitizeName,
  toolError,
  toolJson,
  toolText,
} from './define';

export function buildDocumentTools(ctx: McpToolContext): McpTool[] {
  const { userId, workspaceId, deps } = ctx;

  const readDocument = mcpTool('read', 'all', {
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
      if (!(await ctx.canDoc(docId, 'Doc.Read'))) return docNotFound(docId);

      const abortedAfterPermission = abortIfNeeded(options.signal);
      if (abortedAfterPermission) return abortedAfterPermission;

      const content = await deps.reader.getDocMarkdown(
        workspaceId,
        docId,
        false
      );
      if (!content) return docNotFound(docId);

      const abortedAfterRead = abortIfNeeded(options.signal);
      if (abortedAfterRead) return abortedAfterRead;

      return toolText(content.markdown);
    },
  });

  const docSearch = mcpTool('read', 'all', {
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
      const grants = ctx.agentGrants;
      // Narrowing the candidate set before retrieval, so a hit on an
      // ungranted doc cannot reach the agent even as an excerpt.
      const scopedDocIds = grants
        ? (doc_ids ?? [...grants.keys()]).filter(id => grants.has(id))
        : doc_ids;
      if (grants && scopedDocIds?.length === 0) {
        return toolJson({ retrieval_mode: 'none', hits: [] });
      }

      const result = await deps.retrieval.search(
        { user: userId, workspace: workspaceId },
        query,
        scopedDocIds,
        limit ?? 10,
        options.signal
      );
      return toolJson({
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
      });
    },
  });

  const createDocument = mcpTool('write', 'all', {
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
        if (!ctx.isAgent) {
          await ctx.assertWorkspace('Workspace.CreateDoc');
        }
        const abortedBeforeWrite = abortIfNeeded(options.signal);
        if (abortedBeforeWrite) return abortedBeforeWrite;

        const sanitizedTitle = sanitizeName(title, 'Title');
        const strippedContent = content.replace(
          /^[ \t]{0,3}#\s+[^\n]*#*\s*\n*/,
          ''
        );
        const result = await deps.writer.createDoc(
          workspaceId,
          sanitizedTitle,
          strippedContent,
          userId
        );
        await ctx.grantAgentCreatedDoc(result.docId);

        return toolJson({
          success: true,
          docId: result.docId,
          message: `Document "${title}" created successfully`,
        });
      } catch (error) {
        return toolError(`Failed to create document: ${errorMessage(error)}`);
      }
    },
  });

  const updateDocument = mcpTool('write', 'all', {
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
      if (!(await ctx.canDoc(docId, 'Doc.Update'))) return docNotFound(docId);
      const abortedBeforeWrite = abortIfNeeded(options.signal);
      if (abortedBeforeWrite) return abortedBeforeWrite;

      try {
        await deps.writer.updateDoc(workspaceId, docId, content, userId);
        return toolJson({
          success: true,
          docId,
          message: 'Document updated successfully',
        });
      } catch {
        return docNotFound(docId);
      }
    },
  });

  const updateDocumentMeta = mcpTool('write', 'all', {
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
      if (!(await ctx.canDoc(docId, 'Doc.Update'))) return docNotFound(docId);
      const abortedBeforeWrite = abortIfNeeded(options.signal);
      if (abortedBeforeWrite) return abortedBeforeWrite;

      try {
        await deps.writer.updateDocMeta(
          workspaceId,
          docId,
          { title: sanitizeName(title, 'Title') },
          userId
        );
        return toolJson({
          success: true,
          docId,
          message: 'Document title updated successfully',
        });
      } catch {
        return docNotFound(docId);
      }
    },
  });

  return [
    readDocument,
    docSearch,
    createDocument,
    updateDocument,
    updateDocumentMeta,
  ];
}
