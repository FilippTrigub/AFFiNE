import z from 'zod/v3';

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
  editPageTags,
  findPage,
  findTagMap,
  insertTag,
  listPages,
  listTags,
  loadRoot,
  mutateRoot,
  resolveTags,
} from './workspace-data';

/**
 * Workspace tags. Definitions live in the root doc's
 * `meta.properties.tags.options`; a page's tags are ids in
 * `meta.pages[i].tags`. Colours are the client palette
 * (`packages/frontend/core/src/modules/tag/service/tag.ts`). Deleting a tag
 * definition is deliberately absent: it strips the tag from every document.
 */
export const TAG_COLORS = [
  'red',
  'magenta',
  'orange',
  'yellow',
  'green',
  'teal',
  'blue',
  'purple',
  'grey',
] as const;

const colorVar = (name: (typeof TAG_COLORS)[number]) =>
  `var(--affine-palette-line-${name})`;

function colorName(value: string) {
  const match = /--affine-(?:palette-line|tag)-([a-z]+)/.exec(value);
  return match?.[1] ?? value;
}

export function buildTagTools(ctx: McpToolContext): McpTool[] {
  const assertOrganize = () => ctx.assertWorkspace('Workspace.CreateDoc');

  const createTagIn = (root: Parameters<typeof insertTag>[0], name: string) => {
    const existing = listTags(root).find(
      tag => tag.value.toLowerCase() === name.toLowerCase()
    );
    if (existing) return { tag: existing, created: false };
    const color = TAG_COLORS[listTags(root).length % TAG_COLORS.length];
    return {
      tag: insertTag(root, { value: name, color: colorVar(color) }),
      created: true,
    };
  };

  const listTagsTool = mcpTool('read', 'human', {
    name: 'list_tags',
    title: 'List Tags',
    description: 'All workspace tags with id, name, colour and document count.',
    parser: z.object({}),
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    execute: async () => {
      const root = await loadRoot(ctx);
      const tags = listTags(root);
      const pages = listPages(root).filter(page => !page.trash);
      root.destroy();
      return toolJson({
        tags: tags.map(tag => ({
          id: tag.id,
          name: tag.value,
          color: colorName(tag.color),
          documents: pages.filter(page => page.tags.includes(tag.id)).length,
        })),
      });
    },
  });

  const createTag = mcpTool('write', 'human', {
    name: 'create_tag',
    title: 'Create Tag',
    description: `Create a workspace tag. Returns the existing tag if one with the same name (case-insensitive) exists. color: one of ${TAG_COLORS.join(', ')}.`,
    parser: z.object({
      name: z.string().min(1).max(100),
      color: z.enum(TAG_COLORS).optional(),
    }),
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        color: { type: 'string', enum: [...TAG_COLORS] },
      },
      required: ['name'],
      additionalProperties: false,
    },
    execute: async ({ name, color }) => {
      try {
        await assertOrganize();
        const tagName = sanitizeName(name, 'Tag name');
        const { result } = await mutateRoot(ctx, root => {
          const outcome = createTagIn(root, tagName);
          if (outcome.created && color) {
            findTagMap(root, outcome.tag.id)?.set('color', colorVar(color));
          }
          return outcome;
        });
        return toolJson({
          success: true,
          tagId: result.tag.id,
          name: result.tag.value,
          created: result.created,
        });
      } catch (error) {
        return toolError(`Failed to create tag: ${errorMessage(error)}`);
      }
    },
  });

  const updateTag = mcpTool('write', 'human', {
    name: 'update_tag',
    title: 'Update Tag',
    description: 'Rename or recolour a workspace tag.',
    parser: z.object({
      tag_id: z.string().min(1),
      name: z.string().min(1).max(100).optional(),
      color: z.enum(TAG_COLORS).optional(),
    }),
    inputSchema: {
      type: 'object',
      properties: {
        tag_id: { type: 'string' },
        name: { type: 'string' },
        color: { type: 'string', enum: [...TAG_COLORS] },
      },
      required: ['tag_id'],
      additionalProperties: false,
    },
    execute: async ({ tag_id, name, color }) => {
      if (!name && !color) return toolError('Nothing to update.');
      try {
        await assertOrganize();
        const tagName = name ? sanitizeName(name, 'Tag name') : undefined;
        await mutateRoot(ctx, root => {
          const tag = findTagMap(root, tag_id);
          if (!tag) throw new Error(`Tag ${tag_id} not found`);
          if (tagName) tag.set('value', tagName);
          if (color) tag.set('color', colorVar(color));
          tag.set('updateDate', Date.now());
        });
        return toolJson({ success: true, tagId: tag_id });
      } catch (error) {
        return toolError(`Failed to update tag: ${errorMessage(error)}`);
      }
    },
  });

  const setDocumentTags = mcpTool('write', 'human', {
    name: 'set_document_tags',
    title: 'Set Document Tags',
    description:
      'Add and/or remove tags on a document. Tags are given by id or name. With create_missing, unknown names in `add` are created as new tags.',
    parser: z.object({
      docId: z.string(),
      add: z.array(z.string().min(1)).max(50).optional(),
      remove: z.array(z.string().min(1)).max(50).optional(),
      create_missing: z.boolean().optional(),
    }),
    inputSchema: {
      type: 'object',
      properties: {
        docId: { type: 'string' },
        add: { type: 'array', items: { type: 'string' } },
        remove: { type: 'array', items: { type: 'string' } },
        create_missing: { type: 'boolean' },
      },
      required: ['docId'],
      additionalProperties: false,
    },
    execute: async ({ docId, add = [], remove = [], create_missing }) => {
      if (!(await ctx.canDoc(docId, 'Doc.Update'))) return docNotFound(docId);
      try {
        const { result } = await mutateRoot(ctx, root => {
          if (!findPage(root, docId)) return null;
          const added = resolveTags(root, add);
          if (added.missing.length && !create_missing) {
            throw new Error(
              `Unknown tags: ${added.missing.join(', ')}. Pass create_missing: true or use create_tag.`
            );
          }
          const createdIds = added.missing.map(
            name => createTagIn(root, sanitizeName(name, 'Tag name')).tag.id
          );
          const removed = resolveTags(root, remove);
          editPageTags(root, docId, [...added.ids, ...createdIds], removed.ids);
          const names = new Map(listTags(root).map(t => [t.id, t.value]));
          return (findPage(root, docId)?.tags ?? []).map(
            id => names.get(id) ?? id
          );
        });
        if (!result) return docNotFound(docId);
        return toolJson({ success: true, docId, tags: result });
      } catch (error) {
        return toolError(`Failed to set tags: ${errorMessage(error)}`);
      }
    },
  });

  return [listTagsTool, createTag, updateTag, setDocumentTags];
}
