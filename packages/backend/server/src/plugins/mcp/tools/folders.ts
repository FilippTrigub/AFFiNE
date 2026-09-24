import { nanoid } from 'nanoid';
import z from 'zod/v3';

import { softDeleteOrmRow, upsertOrmRow } from '../../../core/doc/orm-table';
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
  addFolderLink,
  childIndexAfterAll,
  type FolderRow,
  folderRows,
  listCollections,
  listPages,
  listTags,
  loadRoot,
  loadTable,
  mutateTable,
} from './workspace-data';

/**
 * Sidebar folders (`db$<ws>$folders`). Rules mirror
 * `packages/frontend/core/src/modules/organize/stores/folder.ts`: only folders
 * sit at the root, links need a folder parent, and moves must not create
 * cycles. Deleting a folder is deliberately absent: it drops the whole subtree.
 */

type FolderTree = {
  id: string;
  name: string;
  folders: FolderTree[];
  items: { linkId: string; type: string; targetId: string; title?: string }[];
};

function isDescendant(rows: FolderRow[], nodeId: string, ancestorId: string) {
  const byId = new Map(rows.map(row => [row.id, row]));
  const seen = new Set<string>();
  let current = byId.get(nodeId);
  while (current?.parentId && !seen.has(current.id)) {
    if (current.parentId === ancestorId) return true;
    seen.add(current.id);
    current = byId.get(current.parentId);
  }
  return false;
}

export function buildFolderTools(ctx: McpToolContext): McpTool[] {
  const assertOrganize = () => ctx.assertWorkspace('Workspace.CreateDoc');

  const listFolders = mcpTool('read', 'human', {
    name: 'list_folders',
    title: 'List Folders',
    description:
      'The sidebar folder tree ("Organize"): folders with their subfolders and the documents, tags and collections filed in them, in sidebar order.',
    parser: z.object({}),
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    execute: async () => {
      await ctx.assertWorkspace('Workspace.Organize.Read');
      const doc = await loadTable(ctx, 'folders');
      const rows = folderRows(doc).sort((a, b) =>
        a.index < b.index ? -1 : a.index > b.index ? 1 : 0
      );
      doc.destroy();
      const root = await loadRoot(ctx);
      const titles = new Map<string, string>([
        ...listPages(root).map(p => [`doc:${p.id}`, p.title] as const),
        ...listTags(root).map(t => [`tag:${t.id}`, t.value] as const),
        ...listCollections(root).map(
          c => [`collection:${c.id}`, c.name] as const
        ),
      ]);
      root.destroy();

      const build = (parentId: string | null): FolderTree[] =>
        rows
          .filter(row => row.type === 'folder' && row.parentId === parentId)
          .map(folder => ({
            id: folder.id,
            name: folder.data,
            folders: build(folder.id),
            items: rows
              .filter(
                row => row.parentId === folder.id && row.type !== 'folder'
              )
              .map(row => ({
                linkId: row.id,
                type: row.type,
                targetId: row.data,
                title: titles.get(`${row.type}:${row.data}`),
              })),
          }));
      return toolJson({ folders: build(null) });
    },
  });

  const createFolder = mcpTool('write', 'human', {
    name: 'create_folder',
    title: 'Create Folder',
    description:
      'Create a sidebar folder, at the top level or inside parent_id. Returns the folder id. If a folder with the same name already exists at that level it is returned instead.',
    parser: z.object({
      name: z.string().min(1).max(200),
      parent_id: z.string().min(1).optional(),
    }),
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        parent_id: { type: 'string', description: 'Parent folder id' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    execute: async ({ name, parent_id }) => {
      try {
        await assertOrganize();
        const folderName = sanitizeName(name, 'Folder name');
        const parentId = parent_id ?? null;
        const { result } = await mutateTable(ctx, 'folders', doc => {
          const rows = folderRows(doc);
          if (parentId) {
            const parent = rows.find(row => row.id === parentId);
            if (!parent || parent.type !== 'folder') {
              throw new Error(`Folder ${parentId} not found`);
            }
          }
          const existing = rows.find(
            row =>
              row.type === 'folder' &&
              row.parentId === parentId &&
              row.data === folderName
          );
          if (existing) return { id: existing.id, created: false };
          const id = nanoid();
          upsertOrmRow(doc, id, {
            id,
            parentId,
            type: 'folder',
            data: folderName,
            index: childIndexAfterAll(rows, parentId),
          });
          return { id, created: true };
        });
        return toolJson({ success: true, folderId: result.id, ...result });
      } catch (error) {
        return toolError(`Failed to create folder: ${errorMessage(error)}`);
      }
    },
  });

  const renameFolder = mcpTool('write', 'human', {
    name: 'rename_folder',
    title: 'Rename Folder',
    description: 'Rename a sidebar folder.',
    parser: z.object({
      folder_id: z.string().min(1),
      name: z.string().min(1).max(200),
    }),
    inputSchema: {
      type: 'object',
      properties: { folder_id: { type: 'string' }, name: { type: 'string' } },
      required: ['folder_id', 'name'],
      additionalProperties: false,
    },
    execute: async ({ folder_id, name }) => {
      try {
        await assertOrganize();
        const folderName = sanitizeName(name, 'Folder name');
        await mutateTable(ctx, 'folders', doc => {
          const folder = folderRows(doc).find(row => row.id === folder_id);
          if (!folder || folder.type !== 'folder') {
            throw new Error(`Folder ${folder_id} not found`);
          }
          upsertOrmRow(doc, folder_id, { data: folderName });
        });
        return toolJson({ success: true, folderId: folder_id });
      } catch (error) {
        return toolError(`Failed to rename folder: ${errorMessage(error)}`);
      }
    },
  });

  const moveFolderItem = mcpTool('write', 'human', {
    name: 'move_folder_item',
    title: 'Move Folder Item',
    description:
      'Move a folder, or a document/tag/collection link (by its linkId from list_folders), into another folder, or a folder to the top level (parent_id omitted). position: "first" or "last" (default) among its new siblings.',
    parser: z.object({
      item_id: z.string().min(1),
      parent_id: z.string().min(1).optional(),
      position: z.enum(['first', 'last']).optional(),
    }),
    inputSchema: {
      type: 'object',
      properties: {
        item_id: { type: 'string', description: 'Folder id or linkId' },
        parent_id: { type: 'string', description: 'Target folder id' },
        position: { type: 'string', enum: ['first', 'last'] },
      },
      required: ['item_id'],
      additionalProperties: false,
    },
    execute: async ({ item_id, parent_id, position }) => {
      try {
        await assertOrganize();
        const parentId = parent_id ?? null;
        await mutateTable(ctx, 'folders', doc => {
          const rows = folderRows(doc);
          const node = rows.find(row => row.id === item_id);
          if (!node) throw new Error(`Item ${item_id} not found`);
          if (parentId) {
            if (parentId === item_id) {
              throw new Error('Cannot move a folder into itself');
            }
            const parent = rows.find(row => row.id === parentId);
            if (!parent || parent.type !== 'folder') {
              throw new Error(`Folder ${parentId} not found`);
            }
            if (isDescendant(rows, parentId, item_id)) {
              throw new Error('Cannot move a folder into its own subfolder');
            }
          } else if (node.type !== 'folder') {
            throw new Error('Only folders can sit at the top level');
          }
          const siblings = rows
            .filter(row => row.parentId === parentId && row.id !== item_id)
            .map(row => row.index);
          upsertOrmRow(doc, item_id, {
            parentId,
            index:
              position === 'first'
                ? fractionalIndexBeforeAll(siblings)
                : fractionalIndexAfterAll(siblings),
          });
        });
        return toolJson({ success: true, itemId: item_id, parentId });
      } catch (error) {
        return toolError(`Failed to move item: ${errorMessage(error)}`);
      }
    },
  });

  const addToFolder = mcpTool('write', 'human', {
    name: 'add_to_folder',
    title: 'Add To Folder',
    description:
      'File a document (default), tag or collection into a sidebar folder. A document can live in several folders. Returns the linkId; adding the same target twice returns the existing link.',
    parser: z.object({
      folder_id: z.string().min(1),
      target_id: z.string().min(1),
      type: z.enum(['doc', 'tag', 'collection']).optional(),
    }),
    inputSchema: {
      type: 'object',
      properties: {
        folder_id: { type: 'string' },
        target_id: { type: 'string', description: 'Doc, tag or collection id' },
        type: { type: 'string', enum: ['doc', 'tag', 'collection'] },
      },
      required: ['folder_id', 'target_id'],
      additionalProperties: false,
    },
    execute: async ({ folder_id, target_id, type = 'doc' }) => {
      try {
        await assertOrganize();
        const root = await loadRoot(ctx);
        const exists =
          type === 'doc'
            ? listPages(root).some(page => page.id === target_id)
            : type === 'tag'
              ? listTags(root).some(tag => tag.id === target_id)
              : listCollections(root).some(c => c.id === target_id);
        root.destroy();
        if (type === 'doc') {
          if (!exists || !(await ctx.canDoc(target_id, 'Doc.Read'))) {
            return docNotFound(target_id);
          }
        } else if (!exists) {
          return toolError(`${type} ${target_id} not found.`);
        }
        const { result: linkId } = await mutateTable(ctx, 'folders', doc =>
          addFolderLink(doc, folder_id, type, target_id)
        );
        return toolJson({ success: true, linkId });
      } catch (error) {
        return toolError(`Failed to add to folder: ${errorMessage(error)}`);
      }
    },
  });

  const removeFromFolder = mcpTool('write', 'human', {
    name: 'remove_from_folder',
    title: 'Remove From Folder',
    description:
      'Take a document/tag/collection link out of its folder (by linkId from list_folders). The document itself is untouched and can be added back. Folders themselves cannot be removed through MCP.',
    parser: z.object({ link_id: z.string().min(1) }),
    inputSchema: {
      type: 'object',
      properties: { link_id: { type: 'string' } },
      required: ['link_id'],
      additionalProperties: false,
    },
    execute: async ({ link_id }) => {
      try {
        await assertOrganize();
        await mutateTable(ctx, 'folders', doc => {
          const link = folderRows(doc).find(row => row.id === link_id);
          if (!link || link.type === 'folder') {
            throw new Error(`Link ${link_id} not found`);
          }
          softDeleteOrmRow(doc, link_id, 'id');
        });
        return toolJson({ success: true, linkId: link_id });
      } catch (error) {
        return toolError(
          `Failed to remove from folder: ${errorMessage(error)}`
        );
      }
    },
  });

  return [
    listFolders,
    createFolder,
    renameFolder,
    moveFolderItem,
    addToFolder,
    removeFromFolder,
  ];
}
