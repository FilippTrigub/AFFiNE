import z from 'zod/v3';

import {
  getOrmRow,
  listOrmRows,
  softDeleteOrmRow,
  upsertOrmRow,
} from '../../../core/doc/orm-table';
import { fractionalIndexAfterAll } from '../../../core/utils/fractional-index';
import type { McpToolContext } from './context';
import {
  errorMessage,
  type McpTool,
  mcpTool,
  sanitizeName,
  toolError,
  toolJson,
} from './define';
import {
  insertCollection,
  listCollections,
  listPages,
  loadRoot,
  mutateRoot,
  mutateTable,
  readTable,
  replaceCollection,
} from './workspace-data';

/**
 * Collections: saved views of documents, either hand-picked (`allowList`) or
 * rule-based (`rules.filters`, `FilterParams` from
 * `packages/frontend/core/src/modules/collection-rules/types.ts`). Deleting a
 * collection is deliberately absent.
 */
const filterSchema = z.object({
  type: z.string().min(1),
  key: z.string().min(1),
  method: z.string().min(1),
  value: z.string().optional(),
});

const filterJsonSchema = {
  type: 'array',
  description:
    'Rule filters, e.g. {"type":"system","key":"tags","method":"include-any-of","value":"<tagId>,<tagId>"} or {"type":"system","key":"title","method":"match","value":"plan"}',
  items: {
    type: 'object',
    properties: {
      type: { type: 'string' },
      key: { type: 'string' },
      method: { type: 'string' },
      value: { type: 'string' },
    },
    required: ['type', 'key', 'method'],
  },
};

export function buildCollectionTools(ctx: McpToolContext): McpTool[] {
  const assertOrganize = () => ctx.assertWorkspace('Workspace.CreateDoc');

  const existingDocIds = async (ids: string[]) => {
    if (!ids.length) return;
    const root = await loadRoot(ctx);
    const pages = new Set(listPages(root).map(page => page.id));
    root.destroy();
    const unknown = ids.filter(id => !pages.has(id));
    if (unknown.length)
      throw new Error(`Unknown documents: ${unknown.join(', ')}`);
  };

  const listCollectionsTool = mcpTool('read', 'human', {
    name: 'list_collections',
    title: 'List Collections',
    description:
      'Workspace collections with their hand-picked documents, rule filters and whether they are pinned to the sidebar.',
    parser: z.object({}),
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    execute: async () => {
      const root = await loadRoot(ctx);
      const collections = listCollections(root);
      root.destroy();
      const pinned = new Set(
        (await readTable(ctx, 'pinnedCollections')).map(row =>
          String(row.collectionId)
        )
      );
      return toolJson({
        collections: collections.map(c => ({
          id: c.id,
          name: c.name,
          documents: c.allowList,
          filters: c.rules.filters,
          pinned: pinned.has(c.id),
        })),
      });
    },
  });

  const createCollection = mcpTool('write', 'human', {
    name: 'create_collection',
    title: 'Create Collection',
    description:
      'Create a collection from hand-picked document ids and/or rule filters. Returns the collection id.',
    parser: z.object({
      name: z.string().min(1).max(200),
      doc_ids: z.array(z.string().min(1)).max(1000).optional(),
      filters: z.array(filterSchema).max(50).optional(),
    }),
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        doc_ids: { type: 'array', items: { type: 'string' } },
        filters: filterJsonSchema,
      },
      required: ['name'],
      additionalProperties: false,
    },
    execute: async ({ name, doc_ids = [], filters = [] }) => {
      try {
        await assertOrganize();
        await existingDocIds(doc_ids);
        const { result } = await mutateRoot(ctx, root =>
          insertCollection(root, {
            name: sanitizeName(name, 'Collection name'),
            rules: { filters },
            allowList: [...new Set(doc_ids)],
          })
        );
        return toolJson({ success: true, collectionId: result.id });
      } catch (error) {
        return toolError(`Failed to create collection: ${errorMessage(error)}`);
      }
    },
  });

  const updateCollection = mcpTool('write', 'human', {
    name: 'update_collection',
    title: 'Update Collection',
    description:
      'Rename a collection, add or remove hand-picked documents, or replace its rule filters (pass [] to clear them).',
    parser: z.object({
      collection_id: z.string().min(1),
      name: z.string().min(1).max(200).optional(),
      add_docs: z.array(z.string().min(1)).max(1000).optional(),
      remove_docs: z.array(z.string().min(1)).max(1000).optional(),
      filters: z.array(filterSchema).max(50).optional(),
    }),
    inputSchema: {
      type: 'object',
      properties: {
        collection_id: { type: 'string' },
        name: { type: 'string' },
        add_docs: { type: 'array', items: { type: 'string' } },
        remove_docs: { type: 'array', items: { type: 'string' } },
        filters: filterJsonSchema,
      },
      required: ['collection_id'],
      additionalProperties: false,
    },
    execute: async ({
      collection_id,
      name,
      add_docs = [],
      remove_docs = [],
      filters,
    }) => {
      try {
        await assertOrganize();
        await existingDocIds(add_docs);
        const newName = name
          ? sanitizeName(name, 'Collection name')
          : undefined;
        const { result } = await mutateRoot(ctx, root =>
          replaceCollection(root, collection_id, current => {
            const removeSet = new Set(remove_docs);
            const allowList = [
              ...new Set([...current.allowList, ...add_docs]),
            ].filter(id => !removeSet.has(id));
            return {
              ...current,
              name: newName ?? current.name,
              rules: filters ? { filters } : current.rules,
              allowList,
            };
          })
        );
        if (!result) return toolError(`Collection ${collection_id} not found.`);
        return toolJson({
          success: true,
          collectionId: collection_id,
          documents: result.allowList,
        });
      } catch (error) {
        return toolError(`Failed to update collection: ${errorMessage(error)}`);
      }
    },
  });

  const pin = (name: 'pin_collection' | 'unpin_collection') =>
    mcpTool('write', 'human', {
      name,
      title: name === 'pin_collection' ? 'Pin Collection' : 'Unpin Collection',
      description:
        name === 'pin_collection'
          ? 'Pin a collection to the sidebar.'
          : 'Unpin a collection from the sidebar. The collection itself is kept.',
      parser: z.object({ collection_id: z.string().min(1) }),
      inputSchema: {
        type: 'object',
        properties: { collection_id: { type: 'string' } },
        required: ['collection_id'],
        additionalProperties: false,
      },
      execute: async ({ collection_id }) => {
        try {
          await assertOrganize();
          const root = await loadRoot(ctx);
          const exists = listCollections(root).some(
            c => c.id === collection_id
          );
          root.destroy();
          if (!exists)
            return toolError(`Collection ${collection_id} not found.`);
          const { changed } = await mutateTable(
            ctx,
            'pinnedCollections',
            doc => {
              if (name === 'unpin_collection') {
                softDeleteOrmRow(doc, collection_id, 'collectionId');
                return;
              }
              if (getOrmRow(doc, collection_id)) return;
              const indexes = listOrmRows(doc).map(row =>
                String(row.index ?? '')
              );
              upsertOrmRow(doc, collection_id, {
                collectionId: collection_id,
                index: fractionalIndexAfterAll(indexes),
              });
            }
          );
          return toolJson({
            success: true,
            collectionId: collection_id,
            changed,
          });
        } catch (error) {
          return toolError(
            `Failed to ${name.split('_')[0]} collection: ${errorMessage(error)}`
          );
        }
      },
    });

  return [
    listCollectionsTool,
    createCollection,
    updateCollection,
    pin('pin_collection'),
    pin('unpin_collection'),
  ];
}
