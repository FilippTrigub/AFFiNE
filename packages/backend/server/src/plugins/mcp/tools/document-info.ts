import z from 'zod/v3';

import { backendRuntimeErrorCode } from '../../../core/backend-runtime';
import { listOrmRows } from '../../../core/doc/orm-table';
import type { McpToolContext } from './context';
import {
  docNotFound,
  errorMessage,
  type McpTool,
  mcpTool,
  toolError,
  toolJson,
} from './define';
import { createDocument } from './document-write';
import {
  findPage,
  folderPath,
  folderRows,
  listPages,
  listTags,
  loadRoot,
  loadTable,
  readTable,
  readTableRow,
  writeDocProperties,
} from './workspace-data';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function isoDate(value: number | undefined) {
  return value === undefined ? undefined : new Date(value).toISOString();
}

export function buildDocumentInfoTools(ctx: McpToolContext): McpTool[] {
  const { workspaceId, deps } = ctx;

  const listDocuments = mcpTool('read', 'all', {
    name: 'list_documents',
    title: 'List Documents',
    description:
      'List documents in the workspace with id, title, tags, dates and trash state. Filter by tag (id or name) or by a title substring. Trashed documents are hidden unless include_trashed is true.',
    parser: z.object({
      title_contains: z.string().min(1).optional(),
      tag: z.string().min(1).optional(),
      include_trashed: z.boolean().optional(),
      limit: z.number().int().min(1).max(500).optional(),
      offset: z.number().int().min(0).optional(),
    }),
    inputSchema: {
      type: 'object',
      properties: {
        title_contains: { type: 'string' },
        tag: { type: 'string', description: 'Tag id or name' },
        include_trashed: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 500 },
        offset: { type: 'integer', minimum: 0 },
      },
      additionalProperties: false,
    },
    execute: async ({
      title_contains,
      tag,
      include_trashed,
      limit,
      offset,
    }) => {
      const root = await loadRoot(ctx);
      const tags = listTags(root);
      const pages = listPages(root);
      root.destroy();

      const tagName = new Map(tags.map(t => [t.id, t.value]));
      const tagFilter = tag
        ? (tags.find(t => t.id === tag) ??
          tags.find(t => t.value.toLowerCase() === tag.toLowerCase()))
        : undefined;
      if (tag && !tagFilter) return toolError(`Tag "${tag}" not found.`);

      const needle = title_contains?.toLowerCase();
      const visible = pages.filter(
        page =>
          ctx.agentMayRead(page.id) &&
          (include_trashed || !page.trash) &&
          (!needle || page.title.toLowerCase().includes(needle)) &&
          (!tagFilter || page.tags.includes(tagFilter.id))
      );
      const start = offset ?? 0;
      const slice = visible.slice(start, start + (limit ?? 100));
      return toolJson({
        total: visible.length,
        offset: start,
        documents: slice.map(page => ({
          id: page.id,
          title: page.title,
          tags: page.tags.map(id => tagName.get(id) ?? id),
          createdAt: isoDate(page.createDate),
          updatedAt: isoDate(page.updatedDate),
          trashed: page.trash || undefined,
        })),
      });
    },
  });

  const getDocumentInfo = mcpTool('read', 'all', {
    name: 'get_document_info',
    title: 'Get Document Info',
    description:
      'Metadata of one document: title, tags, mode, properties (journal date, template flag, custom properties), creator, trash and publish state, and the sidebar folders it is filed in.',
    parser: z.object({ docId: z.string() }),
    inputSchema: {
      type: 'object',
      properties: { docId: { type: 'string' } },
      required: ['docId'],
      additionalProperties: false,
    },
    execute: async ({ docId }) => {
      if (!(await ctx.canDoc(docId, 'Doc.Read'))) return docNotFound(docId);
      const root = await loadRoot(ctx);
      const page = findPage(root, docId);
      const tags = listTags(root);
      root.destroy();
      if (!page) return docNotFound(docId);

      const properties =
        (await readTableRow(ctx, 'docProperties', docId)) ?? {};
      const custom = Object.fromEntries(
        Object.entries(properties)
          .filter(([key]) => key.startsWith('custom:'))
          .map(([key, value]) => [key.slice('custom:'.length), value])
      );
      const meta = await deps.models.doc.getMeta(workspaceId, docId);

      let folders: string[][] | undefined;
      if (!ctx.isAgent) {
        const doc = await loadTable(ctx, 'folders');
        const rows = folderRows(doc);
        doc.destroy();
        folders = rows
          .filter(row => row.type === 'doc' && row.data === docId)
          .map(row => (row.parentId ? folderPath(rows, row.parentId) : []));
      }

      return toolJson({
        id: docId,
        title: page.title,
        tags: page.tags.map(id => ({
          id,
          name: tags.find(tag => tag.id === id)?.value ?? id,
        })),
        mode: properties.primaryMode ?? 'page',
        journal: properties.journal || undefined,
        isTemplate: properties.isTemplate === true,
        pageWidth: properties.pageWidth,
        customProperties: custom,
        createdBy: properties.createdBy,
        updatedBy: properties.updatedBy,
        createdAt: isoDate(page.createDate),
        updatedAt: isoDate(page.updatedDate),
        trashed: page.trash,
        public: meta?.public ?? false,
        publicMode: meta?.public
          ? meta.mode === 1
            ? 'edgeless'
            : 'page'
          : undefined,
        folders,
      });
    },
  });

  const setDocumentProperties = mcpTool('write', 'all', {
    name: 'set_document_properties',
    title: 'Set Document Properties',
    description:
      'Set page-level properties of a document: mode (page/edgeless), page width, edgeless colour theme, template flag, journal date (YYYY-MM-DD, or "" to clear), and custom property values keyed by property id (see list_custom_properties; values are strings, checkboxes "true"/"false", dates YYYY-MM-DD). Omitted fields are left unchanged.',
    parser: z.object({
      docId: z.string(),
      mode: z.enum(['page', 'edgeless']).optional(),
      page_width: z.enum(['standard', 'fullWidth']).optional(),
      edgeless_color_theme: z.enum(['system', 'light', 'dark']).optional(),
      is_template: z.boolean().optional(),
      journal: z
        .string()
        .refine(
          value => value === '' || DATE.test(value),
          'Expected YYYY-MM-DD'
        )
        .optional(),
      custom: z.record(z.string().max(10_000)).optional(),
    }),
    inputSchema: {
      type: 'object',
      properties: {
        docId: { type: 'string' },
        mode: { type: 'string', enum: ['page', 'edgeless'] },
        page_width: { type: 'string', enum: ['standard', 'fullWidth'] },
        edgeless_color_theme: {
          type: 'string',
          enum: ['system', 'light', 'dark'],
        },
        is_template: { type: 'boolean' },
        journal: { type: 'string', description: 'YYYY-MM-DD or ""' },
        custom: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Custom property id -> value',
        },
      },
      required: ['docId'],
      additionalProperties: false,
    },
    execute: async args => {
      const { docId } = args;
      if (!(await ctx.canDoc(docId, 'Doc.Properties.Update'))) {
        return docNotFound(docId);
      }
      const fields: Record<string, unknown> = {
        primaryMode: args.mode,
        pageWidth: args.page_width,
        edgelessColorTheme: args.edgeless_color_theme,
        isTemplate: args.is_template,
        journal: args.journal,
      };
      if (args.custom && Object.keys(args.custom).length) {
        const known = new Set(
          (await readTable(ctx, 'docCustomPropertyInfo'))
            .filter(row => row.isDeleted !== true)
            .map(row => String(row.id))
        );
        const unknown = Object.keys(args.custom).filter(id => !known.has(id));
        if (unknown.length) {
          return toolError(
            `Unknown custom properties: ${unknown.join(', ')}. See list_custom_properties.`
          );
        }
        for (const [id, value] of Object.entries(args.custom)) {
          fields[`custom:${id}`] = value;
        }
      }
      if (Object.values(fields).every(value => value === undefined)) {
        return toolError('Nothing to update.');
      }
      try {
        await writeDocProperties(ctx, docId, fields);
        return toolJson({ success: true, docId });
      } catch (error) {
        return toolError(`Failed to set properties: ${errorMessage(error)}`);
      }
    },
  });

  const openJournal = mcpTool('write', 'all', {
    name: 'open_journal',
    title: 'Open Journal',
    description:
      'Return the journal document for a date (YYYY-MM-DD, default today in UTC), creating it if it does not exist yet. The new journal is titled with the date and shows up in the AFFiNE journal view.',
    parser: z.object({
      date: z.string().regex(DATE, 'Expected YYYY-MM-DD').optional(),
    }),
    inputSchema: {
      type: 'object',
      properties: { date: { type: 'string', description: 'YYYY-MM-DD' } },
      additionalProperties: false,
    },
    execute: async ({ date }) => {
      const day = date ?? new Date().toISOString().slice(0, 10);
      try {
        const root = await loadRoot(ctx);
        const active = new Set(
          listPages(root)
            .filter(page => !page.trash && ctx.agentMayRead(page.id))
            .map(page => page.id)
        );
        root.destroy();
        const table = await loadTable(ctx, 'docProperties');
        const existing = listOrmRows(table).find(
          row => row.journal === day && active.has(String(row.id))
        );
        table.destroy();
        if (existing) {
          return toolJson({ docId: existing.id, date: day, created: false });
        }
        const created = await createDocument(ctx, {
          title: day,
          markdown: '',
          properties: { journal: day },
        });
        return toolJson({ docId: created.docId, date: day, created: true });
      } catch (error) {
        return toolError(`Failed to open journal: ${errorMessage(error)}`);
      }
    },
  });

  const lifecycle = (
    name: 'trash_document' | 'restore_document',
    lifecycle: 'trash' | 'restore'
  ) =>
    mcpTool('write', 'human', {
      name,
      title: lifecycle === 'trash' ? 'Trash Document' : 'Restore Document',
      description:
        lifecycle === 'trash'
          ? 'Move a document to the trash. It stays restorable with restore_document; permanent deletion is not available through MCP.'
          : 'Restore a document from the trash.',
      parser: z.object({ docId: z.string() }),
      inputSchema: {
        type: 'object',
        properties: { docId: { type: 'string' } },
        required: ['docId'],
        additionalProperties: false,
      },
      execute: async ({ docId }) => {
        const action = lifecycle === 'trash' ? 'Doc.Trash' : 'Doc.Restore';
        if (!(await ctx.canDoc(docId, action))) return docNotFound(docId);
        try {
          const output = await deps.runtime.executeDomainCommandV1({
            command: 'apply_doc_lifecycle',
            actorUserId: ctx.userId,
            workspaceId,
            docId,
            lifecycle,
          });
          const update = Buffer.from(output.rootUpdate as string, 'base64');
          deps.event.emit('doc.updates.pushed', {
            spaceType: 'workspace',
            spaceId: workspaceId,
            docId: workspaceId,
            updates: [update],
            timestamp: new Date(output.timestamp as string).getTime(),
            editor: ctx.userId,
          });
          return toolJson({ success: true, docId, state: lifecycle });
        } catch (error) {
          if (backendRuntimeErrorCode(error) === 'domain_permission_denied') {
            return docNotFound(docId);
          }
          return toolError(
            `Failed to ${lifecycle} document: ${errorMessage(error)}`
          );
        }
      },
    });

  return [
    listDocuments,
    getDocumentInfo,
    setDocumentProperties,
    openJournal,
    lifecycle('trash_document', 'trash'),
    lifecycle('restore_document', 'restore'),
  ];
}
