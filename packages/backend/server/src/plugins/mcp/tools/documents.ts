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
import {
  createDocument,
  presentMarkdown,
  stripLeadingTitle,
  updateDocumentContent,
} from './document-write';
import {
  editPageTags,
  findPage,
  listPages,
  loadRoot,
  mutateRoot,
  readTableRow,
} from './workspace-data';

const PAGE_LINK_HINT =
  'Link to another page with `[Title](affine://<docId>)`; such links are stored as real page references.';

const UNSUPPORTED_NOTE =
  'This document contains blocks that markdown cannot represent';

const modeSchema = z.enum(['page', 'edgeless']);

export function buildDocumentTools(ctx: McpToolContext): McpTool[] {
  const { userId, workspaceId, deps } = ctx;

  const readDocument = mcpTool('read', 'all', {
    name: 'read_document',
    title: 'Read Document',
    description: `Read a document with given ID as markdown. Page references are rendered as \`[Title](affine://<docId>)\`. If the document holds blocks markdown cannot represent (database, attachment, embedded page, ...), a note at the end lists them: update_document refuses such documents.`,
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

      let markdown = await presentMarkdown(ctx, content.markdown);
      const unsupported = [
        ...new Set(
          [...content.knownUnsupportedBlocks, ...content.unknownBlocks].map(
            entry => entry.split(':').slice(1).join(':') || entry
          )
        ),
      ];
      if (unsupported.length) {
        markdown += `\n\n<!-- ${UNSUPPORTED_NOTE}: ${unsupported.join(', ')}. update_document will refuse it; use the AFFiNE editor. -->\n`;
      }
      return toolText(markdown);
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

  const createDocumentTool = mcpTool('write', 'all', {
    name: 'create_document',
    title: 'Create Document',
    description: `Create a new document with the given title and markdown content. Returns the ID of the created document. ${PAGE_LINK_HINT} Images: upload with upload_image, then use \`![alt](blob://<key>)\`. Optional: \`mode\` (page or edgeless), \`tags\` (existing tag ids or names) and \`folder_id\` (file it into a sidebar folder). Database blocks and attachments are not supported.`,
    parser: z.object({
      title: z.string().min(1),
      content: z.string(),
      mode: modeSchema.optional(),
      tags: z.array(z.string().min(1)).max(50).optional(),
      folder_id: z.string().min(1).optional(),
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
        mode: { type: 'string', enum: ['page', 'edgeless'] },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Existing tag ids or names (see list_tags)',
        },
        folder_id: {
          type: 'string',
          description:
            'Sidebar folder to add the document to (see list_folders)',
        },
      },
      required: ['title', 'content'],
      additionalProperties: false,
    },
    execute: async ({ title, content, mode, tags, folder_id }, options) => {
      const abortedBeforeWrite = abortIfNeeded(options.signal);
      if (abortedBeforeWrite) return abortedBeforeWrite;
      try {
        const result = await createDocument(ctx, {
          title,
          markdown: content,
          mode,
          tags,
          folderId: folder_id,
        });
        return toolJson({
          success: true,
          docId: result.docId,
          linkedPages: result.linkedPages,
          message: `Document "${result.title}" created successfully`,
        });
      } catch (error) {
        return toolError(`Failed to create document: ${errorMessage(error)}`);
      }
    },
  });

  const updateDocument = mcpTool('write', 'all', {
    name: 'update_document',
    title: 'Update Document',
    description: `Replace a document body with new markdown (body only, not the title). Uses structural diffing, so unchanged blocks keep their identity and history. ${PAGE_LINK_HINT} Refuses documents that contain blocks markdown cannot represent (read_document notes these).`,
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
        const linkedPages = await updateDocumentContent(ctx, docId, content);
        return toolJson({
          success: true,
          docId,
          linkedPages,
          message: 'Document updated successfully',
        });
      } catch (error) {
        const message = errorMessage(error);
        if (/unsupported/i.test(message)) {
          return toolError(
            `Document ${docId} contains blocks markdown cannot represent, so it cannot be updated through MCP: ${message}`
          );
        }
        return docNotFound(docId);
      }
    },
  });

  const updateDocumentMeta = mcpTool('write', 'all', {
    name: 'update_document_meta',
    title: 'Update Document Metadata',
    description:
      'Rename a document. For mode, template flag and other properties use set_document_properties.',
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

  const duplicateDocument = mcpTool('write', 'all', {
    name: 'duplicate_document',
    title: 'Duplicate Document',
    description:
      'Copy a document into a new one titled "<title> (n)", with its tags and properties. Only markdown-representable content is copied: database blocks, attachments and embedded pages are left out (the result lists them).',
    parser: z.object({
      docId: z.string(),
      title: z.string().min(1).optional(),
    }),
    inputSchema: {
      type: 'object',
      properties: {
        docId: { type: 'string', description: 'The document to copy' },
        title: {
          type: 'string',
          description: 'Title for the copy (default: "<title> (n)")',
        },
      },
      required: ['docId'],
      additionalProperties: false,
    },
    execute: async ({ docId, title }) => {
      if (!(await ctx.canDoc(docId, 'Doc.Duplicate'))) {
        return docNotFound(docId);
      }
      const content = await deps.reader.getDocMarkdown(
        workspaceId,
        docId,
        false
      );
      if (!content) return docNotFound(docId);

      try {
        const root = await loadRoot(ctx);
        const source = findPage(root, docId);
        const titles = new Set(listPages(root).map(page => page.title));
        root.destroy();
        const baseTitle = source?.title || content.title || 'Untitled';

        const properties = await readTableRow(ctx, 'docProperties', docId);
        const copied = Object.fromEntries(
          Object.entries(properties ?? {}).filter(
            ([key]) =>
              ![
                'id',
                'isTemplate',
                'journal',
                'createdBy',
                'updatedBy',
              ].includes(key)
          )
        );

        const created = await createDocument(ctx, {
          title: title ?? duplicatedTitle(baseTitle, titles),
          markdown: stripLeadingTitle(
            await presentMarkdown(ctx, content.markdown)
          ),
          properties: copied,
        });
        // Tags live in the root doc, which an agent cannot write.
        if (!ctx.isAgent && source?.tags.length) {
          await mutateRoot(ctx, r =>
            editPageTags(r, created.docId, source.tags, [])
          );
        }
        return toolJson({
          success: true,
          docId: created.docId,
          title: created.title,
          notCopied: [
            ...content.knownUnsupportedBlocks,
            ...content.unknownBlocks,
          ],
        });
      } catch (error) {
        return toolError(
          `Failed to duplicate document: ${errorMessage(error)}`
        );
      }
    },
  });

  return [
    readDocument,
    docSearch,
    createDocumentTool,
    updateDocument,
    updateDocumentMeta,
    duplicateDocument,
  ];
}

/** Mirrors the client's `getDuplicatedDocTitle`: "Title (1)", "Title (2)", ... */
function duplicatedTitle(title: string, existing: Set<string>) {
  const base = title.replace(/\s\(\d+\)$/, '');
  let n = 1;
  while (existing.has(`${base} (${n})`)) n++;
  return `${base} (${n})`;
}
