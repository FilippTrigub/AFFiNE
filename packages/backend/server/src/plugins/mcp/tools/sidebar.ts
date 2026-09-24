import { nanoid } from 'nanoid';
import z from 'zod/v3';

import {
  getOrmRow,
  listOrmRows,
  softDeleteOrmRow,
  upsertOrmRow,
  userdataTableDocId,
} from '../../../core/doc/orm-table';
import {
  fractionalIndexAfterAll,
  fractionalIndexBeforeAll,
} from '../../../core/utils/fractional-index';
import type { McpToolContext } from './context';
import {
  docNotFound,
  errorMessage,
  type McpTool,
  mcpTool,
  sanitizeName,
  toolError,
  toolJson,
} from './define';
import {
  folderRows,
  listCollections,
  listPages,
  listTags,
  loadRoot,
  loadTable,
  mutateTable,
  readTable,
} from './workspace-data';

/**
 * Per-user favorites, explorer icons and custom property definitions.
 * - favorites: `userdata$<uid>$<ws>$favorite`, rows `{key: '<type>:<id>', index}`,
 *   new favorites first (`packages/frontend/core/src/modules/favorite`);
 * - icons: `db$<ws>$explorerIcon`, rows `{id: '<type>:<id>', icon}`;
 * - properties: `db$<ws>$docCustomPropertyInfo`. Removing a property is
 *   deliberately absent.
 */
const TARGET_TYPES = ['doc', 'folder', 'tag', 'collection'] as const;
type TargetType = (typeof TARGET_TYPES)[number];

const PROPERTY_TYPES = ['text', 'number', 'checkbox', 'date'] as const;
const SHOW_MODES = ['always-show', 'always-hide', 'hide-when-empty'] as const;

export function buildSidebarTools(ctx: McpToolContext): McpTool[] {
  const { userId, workspaceId, deps } = ctx;
  const favoriteDocId = userdataTableDocId(userId, workspaceId, 'favorite');

  /** Whether the target exists (and, for a doc, is readable). */
  const targetExists = async (type: TargetType, id: string) => {
    if (type === 'folder') {
      const doc = await loadTable(ctx, 'folders');
      const found = folderRows(doc).some(
        row => row.id === id && row.type === 'folder'
      );
      doc.destroy();
      return found;
    }
    const root = await loadRoot(ctx);
    const found =
      type === 'doc'
        ? listPages(root).some(page => page.id === id)
        : type === 'tag'
          ? listTags(root).some(tag => tag.id === id)
          : listCollections(root).some(c => c.id === id);
    root.destroy();
    if (found && type === 'doc') return await ctx.canDoc(id, 'Doc.Read');
    return found;
  };

  const targetSchema = {
    target_type: { type: 'string', enum: [...TARGET_TYPES] },
    target_id: { type: 'string' },
  };

  const listFavorites = mcpTool('read', 'human', {
    name: 'list_favorites',
    title: 'List Favorites',
    description: 'Your own sidebar favorites, in sidebar order.',
    parser: z.object({}),
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    execute: async () => {
      const doc = await deps.yjs.load(workspaceId, favoriteDocId);
      const rows = listOrmRows(doc).sort((a, b) =>
        String(a.index) < String(b.index) ? -1 : 1
      );
      doc.destroy();
      return toolJson({
        favorites: rows.map(row => {
          const [type, ...rest] = String(row.key).split(':');
          return { type, id: rest.join(':') };
        }),
      });
    },
  });

  const favorite = (name: 'add_favorite' | 'remove_favorite') =>
    mcpTool('write', 'human', {
      name,
      title: name === 'add_favorite' ? 'Add Favorite' : 'Remove Favorite',
      description:
        name === 'add_favorite'
          ? 'Add a document, folder, tag or collection to your own sidebar favorites (at the top).'
          : 'Remove an item from your own sidebar favorites. The item itself is untouched.',
      parser: z.object({
        target_type: z.enum(TARGET_TYPES),
        target_id: z.string().min(1),
      }),
      inputSchema: {
        type: 'object',
        properties: targetSchema,
        required: ['target_type', 'target_id'],
        additionalProperties: false,
      },
      execute: async ({ target_type, target_id }) => {
        const key = `${target_type}:${target_id}`;
        try {
          if (
            name === 'add_favorite' &&
            !(await targetExists(target_type, target_id))
          ) {
            return target_type === 'doc'
              ? docNotFound(target_id)
              : toolError(`${target_type} ${target_id} not found.`);
          }
          const { changed } = await deps.yjs.mutate(
            workspaceId,
            favoriteDocId,
            { editorId: userId },
            doc => {
              if (name === 'remove_favorite') {
                softDeleteOrmRow(doc, key, 'key');
                return;
              }
              if (getOrmRow(doc, key)) return;
              upsertOrmRow(doc, key, {
                key,
                index: fractionalIndexBeforeAll(
                  listOrmRows(doc).map(row => String(row.index ?? ''))
                ),
              });
            }
          );
          return toolJson({ success: true, key, changed });
        } catch (error) {
          return toolError(
            `Failed to update favorites: ${errorMessage(error)}`
          );
        }
      },
    });

  const setIcon = mcpTool('write', 'human', {
    name: 'set_icon',
    title: 'Set Icon',
    description:
      'Set the emoji icon shown for a document, folder, tag or collection in the sidebar and page header. Pass an empty emoji to go back to the default icon.',
    parser: z.object({
      target_type: z.enum(TARGET_TYPES),
      target_id: z.string().min(1),
      emoji: z.string().max(32),
    }),
    inputSchema: {
      type: 'object',
      properties: {
        ...targetSchema,
        emoji: { type: 'string', description: 'A single emoji, or ""' },
      },
      required: ['target_type', 'target_id', 'emoji'],
      additionalProperties: false,
    },
    execute: async ({ target_type, target_id, emoji }) => {
      const key = `${target_type}:${target_id}`;
      try {
        if (target_type === 'doc') {
          if (!(await ctx.canDoc(target_id, 'Doc.Update'))) {
            return docNotFound(target_id);
          }
        } else {
          await ctx.assertWorkspace('Workspace.CreateDoc');
          if (!(await targetExists(target_type, target_id))) {
            return toolError(`${target_type} ${target_id} not found.`);
          }
        }
        const unicode = emoji.trim();
        await mutateTable(
          ctx,
          'explorerIcon',
          doc => {
            if (!unicode) {
              softDeleteOrmRow(doc, key, 'id');
              return;
            }
            upsertOrmRow(doc, key, {
              id: key,
              icon: { type: 'emoji', unicode },
            });
          },
          target_type === 'doc' ? target_id : undefined
        );
        return toolJson({ success: true, key, icon: unicode || null });
      } catch (error) {
        return toolError(`Failed to set icon: ${errorMessage(error)}`);
      }
    },
  });

  const listCustomProperties = mcpTool('read', 'all', {
    name: 'list_custom_properties',
    title: 'List Custom Properties',
    description:
      'Custom document properties defined in the workspace (id, name, type). Use the ids with set_document_properties.',
    parser: z.object({}),
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    execute: async () => {
      const rows = (await readTable(ctx, 'docCustomPropertyInfo'))
        .filter(row => row.isDeleted !== true)
        .sort((a, b) =>
          String(a.index ?? '') < String(b.index ?? '') ? -1 : 1
        );
      return toolJson({
        properties: rows.map(row => ({
          id: row.id,
          name: row.name,
          type: row.type,
          show: row.show,
        })),
      });
    },
  });

  const createCustomProperty = mcpTool('write', 'human', {
    name: 'create_custom_property',
    title: 'Create Custom Property',
    description: `Define a custom document property (workspace admins only). type: ${PROPERTY_TYPES.join(', ')}. Returns its id.`,
    parser: z.object({
      name: z.string().min(1).max(100),
      type: z.enum(PROPERTY_TYPES),
      show: z.enum(SHOW_MODES).optional(),
    }),
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        type: { type: 'string', enum: [...PROPERTY_TYPES] },
        show: { type: 'string', enum: [...SHOW_MODES] },
      },
      required: ['name', 'type'],
      additionalProperties: false,
    },
    execute: async ({ name, type, show }) => {
      try {
        await ctx.assertWorkspace('Workspace.Properties.Create');
        const propertyName = sanitizeName(name, 'Property name');
        const { result: id } = await mutateTable(
          ctx,
          'docCustomPropertyInfo',
          doc => {
            const id = nanoid();
            upsertOrmRow(doc, id, {
              id,
              name: propertyName,
              type,
              show: show ?? 'always-show',
              index: fractionalIndexAfterAll(
                listOrmRows(doc)
                  .map(row => row.index)
                  .filter((index): index is string => typeof index === 'string')
              ),
            });
            return id;
          }
        );
        return toolJson({ success: true, propertyId: id });
      } catch (error) {
        return toolError(`Failed to create property: ${errorMessage(error)}`);
      }
    },
  });

  const updateCustomProperty = mcpTool('write', 'human', {
    name: 'update_custom_property',
    title: 'Update Custom Property',
    description:
      'Rename a custom property or change when it is shown (workspace admins only).',
    parser: z.object({
      property_id: z.string().min(1),
      name: z.string().min(1).max(100).optional(),
      show: z.enum(SHOW_MODES).optional(),
    }),
    inputSchema: {
      type: 'object',
      properties: {
        property_id: { type: 'string' },
        name: { type: 'string' },
        show: { type: 'string', enum: [...SHOW_MODES] },
      },
      required: ['property_id'],
      additionalProperties: false,
    },
    execute: async ({ property_id, name, show }) => {
      if (!name && !show) return toolError('Nothing to update.');
      try {
        await ctx.assertWorkspace('Workspace.Properties.Update');
        const propertyName = name
          ? sanitizeName(name, 'Property name')
          : undefined;
        await mutateTable(ctx, 'docCustomPropertyInfo', doc => {
          const row = getOrmRow(doc, property_id);
          if (!row || row.isDeleted === true) {
            throw new Error(`Property ${property_id} not found`);
          }
          upsertOrmRow(doc, property_id, { name: propertyName, show });
        });
        return toolJson({ success: true, propertyId: property_id });
      } catch (error) {
        return toolError(`Failed to update property: ${errorMessage(error)}`);
      }
    },
  });

  return [
    listFavorites,
    favorite('add_favorite'),
    favorite('remove_favorite'),
    setIcon,
    listCustomProperties,
    createCustomProperty,
    updateCustomProperty,
  ];
}
