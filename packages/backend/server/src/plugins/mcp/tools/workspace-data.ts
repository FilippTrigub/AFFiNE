import { nanoid } from 'nanoid';
import * as Y from 'yjs';

import {
  getOrmRow,
  listOrmRows,
  type OrmRow,
  upsertOrmRow,
  workspaceTableDocId,
} from '../../../core/doc/orm-table';
import { fractionalIndexAfterAll } from '../../../core/utils/fractional-index';
import type { McpToolContext } from './context';

/**
 * Readers and writers for workspace-level data that lives in Yjs rather than in
 * Postgres: the root doc (`meta.pages`, tag definitions, collections) and the
 * ORM table docs (`db$<ws>$<table>`). Layouts mirror the client:
 * - pages: `packages/frontend/core/src/modules/doc/stores/docs.ts`
 * - tags: `packages/frontend/core/src/modules/tag/stores/tag.ts`
 * - folders: `packages/frontend/core/src/modules/organize/stores/folder.ts`
 */

export type PageMeta = {
  id: string;
  title: string;
  tags: string[];
  createDate?: number;
  updatedDate?: number;
  trash: boolean;
  trashDate?: number;
};

export type TagOption = {
  id: string;
  value: string;
  color: string;
  createDate?: number;
  updateDate?: number;
  parentId?: string;
};

export type WorkspaceTable =
  | 'folders'
  | 'docProperties'
  | 'docCustomPropertyInfo'
  | 'pinnedCollections'
  | 'explorerIcon';

function plain(value: unknown): unknown {
  return value instanceof Y.AbstractType ? value.toJSON() : value;
}

function toNumber(value: unknown) {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return undefined;
}

function pageFromEntry(entry: unknown): PageMeta | null {
  const raw = plain(entry) as Record<string, unknown> | null;
  if (!raw || typeof raw.id !== 'string') return null;
  const tags = Array.isArray(raw.tags)
    ? raw.tags.filter((tag): tag is string => typeof tag === 'string')
    : [];
  return {
    id: raw.id,
    title: typeof raw.title === 'string' ? raw.title : '',
    tags,
    createDate: toNumber(raw.createDate),
    updatedDate: toNumber(raw.updatedDate),
    trash: raw.trash === true,
    trashDate: toNumber(raw.trashDate),
  };
}

function pagesArray(root: Y.Doc) {
  const pages = root.getMap('meta').get('pages');
  return pages instanceof Y.Array ? (pages as Y.Array<unknown>) : null;
}

export function listPages(root: Y.Doc): PageMeta[] {
  const pages = pagesArray(root);
  if (!pages) return [];
  return pages
    .toArray()
    .map(pageFromEntry)
    .filter((page): page is PageMeta => page !== null);
}

export function findPage(root: Y.Doc, docId: string) {
  return listPages(root).find(page => page.id === docId) ?? null;
}

function findPageMap(root: Y.Doc, docId: string) {
  const pages = pagesArray(root);
  if (!pages) return null;
  for (const entry of pages) {
    if (entry instanceof Y.Map && entry.get('id') === docId) {
      return entry as Y.Map<unknown>;
    }
  }
  return null;
}

function tagOptionsArray(root: Y.Doc, create: boolean) {
  const meta = root.getMap('meta');
  let properties = meta.get('properties');
  if (!(properties instanceof Y.Map)) {
    if (!create) return null;
    if (properties !== undefined) {
      throw new Error('Unsupported legacy workspace properties layout');
    }
    properties = new Y.Map();
    meta.set('properties', properties);
  }
  const props = properties as Y.Map<unknown>;
  let tags = props.get('tags');
  if (!(tags instanceof Y.Map)) {
    if (!create) return null;
    if (tags !== undefined) {
      throw new Error('Unsupported legacy tag layout');
    }
    tags = new Y.Map();
    props.set('tags', tags);
  }
  const tagMap = tags as Y.Map<unknown>;
  let options = tagMap.get('options');
  if (!(options instanceof Y.Array)) {
    if (!create) return null;
    if (options !== undefined) {
      throw new Error('Unsupported legacy tag options layout');
    }
    options = new Y.Array();
    tagMap.set('options', options);
  }
  return options as Y.Array<unknown>;
}

export function listTags(root: Y.Doc): TagOption[] {
  const options = tagOptionsArray(root, false);
  if (!options) return [];
  return options
    .toArray()
    .map(entry => plain(entry) as TagOption)
    .filter(tag => tag && typeof tag.id === 'string');
}

export function findTagMap(root: Y.Doc, tagId: string) {
  const options = tagOptionsArray(root, false);
  if (!options) return null;
  for (const entry of options) {
    if (entry instanceof Y.Map && entry.get('id') === tagId) {
      return entry as Y.Map<unknown>;
    }
  }
  return null;
}

export function insertTag(
  root: Y.Doc,
  tag: { value: string; color: string }
): TagOption {
  const options = tagOptionsArray(root, true);
  if (!options) throw new Error('Tag list could not be created');
  const now = Date.now();
  const created: TagOption = {
    id: nanoid(),
    value: tag.value,
    color: tag.color,
    createDate: now,
    updateDate: now,
  };
  const map = new Y.Map<unknown>();
  for (const [key, value] of Object.entries(created)) map.set(key, value);
  options.push([map]);
  return created;
}

/** Resolve tag references given as ids or (case-insensitive) names. */
export function resolveTags(root: Y.Doc, refs: string[]) {
  const tags = listTags(root);
  const ids: string[] = [];
  const missing: string[] = [];
  for (const ref of refs) {
    const match =
      tags.find(tag => tag.id === ref) ??
      tags.find(tag => tag.value.toLowerCase() === ref.toLowerCase());
    if (match) ids.push(match.id);
    else missing.push(ref);
  }
  return { ids, missing };
}

/**
 * Edit a page's tag list in place. Returns false when the page is not in the
 * root doc.
 */
export function editPageTags(
  root: Y.Doc,
  docId: string,
  add: string[],
  remove: string[]
) {
  const page = findPageMap(root, docId);
  if (!page) return false;
  let tags = page.get('tags');
  if (!(tags instanceof Y.Array)) {
    const existing = Array.isArray(tags) ? (tags as string[]) : [];
    tags = new Y.Array<string>();
    (tags as Y.Array<string>).push(existing);
    page.set('tags', tags);
  }
  const list = tags as Y.Array<string>;
  const removeSet = new Set(remove);
  for (let i = list.length - 1; i >= 0; i--) {
    if (removeSet.has(list.get(i))) list.delete(i, 1);
  }
  const present = new Set(list.toArray());
  for (const id of add) {
    if (!present.has(id)) {
      list.push([id]);
      present.add(id);
    }
  }
  return true;
}

// ---------------------------------------------------------------- root doc io

export async function loadRoot(ctx: McpToolContext) {
  return await ctx.deps.yjs.load(ctx.workspaceId, ctx.workspaceId);
}

export async function mutateRoot<T>(
  ctx: McpToolContext,
  fn: (root: Y.Doc) => T
) {
  return await ctx.deps.yjs.mutate(
    ctx.workspaceId,
    ctx.workspaceId,
    { editorId: ctx.userId },
    fn
  );
}

// ----------------------------------------------------------------- tables io

export async function loadTable(ctx: McpToolContext, table: WorkspaceTable) {
  return await ctx.deps.yjs.load(
    ctx.workspaceId,
    workspaceTableDocId(ctx.workspaceId, table)
  );
}

export async function readTable(ctx: McpToolContext, table: WorkspaceTable) {
  const doc = await loadTable(ctx, table);
  const rows = listOrmRows(doc);
  doc.destroy();
  return rows;
}

export async function readTableRow(
  ctx: McpToolContext,
  table: WorkspaceTable,
  key: string
) {
  const doc = await loadTable(ctx, table);
  const row = getOrmRow(doc, key);
  doc.destroy();
  return row;
}

export async function mutateTable<T>(
  ctx: McpToolContext,
  table: WorkspaceTable,
  fn: (doc: Y.Doc) => T,
  permissionDocId?: string
) {
  return await ctx.deps.yjs.mutate(
    ctx.workspaceId,
    workspaceTableDocId(ctx.workspaceId, table),
    { editorId: ctx.userId, permissionDocId },
    fn
  );
}

/** Upsert one doc's `docProperties` row, authorized by `Doc.Update` on it. */
export async function writeDocProperties(
  ctx: McpToolContext,
  docId: string,
  fields: OrmRow
) {
  return await mutateTable(
    ctx,
    'docProperties',
    doc => upsertOrmRow(doc, docId, { id: docId, ...fields }),
    docId
  );
}

// ------------------------------------------------------------------- folders

export type FolderRow = {
  id: string;
  parentId: string | null;
  type: 'folder' | 'doc' | 'tag' | 'collection';
  data: string;
  index: string;
};

export function folderRows(doc: Y.Doc): FolderRow[] {
  return listOrmRows(doc).map(row => ({
    id: String(row.id),
    parentId: typeof row.parentId === 'string' ? row.parentId : null,
    type: row.type as FolderRow['type'],
    data: String(row.data ?? ''),
    index: String(row.index ?? ''),
  }));
}

export function childIndexAfterAll(rows: FolderRow[], parentId: string | null) {
  return fractionalIndexAfterAll(
    rows.filter(row => row.parentId === parentId).map(row => row.index)
  );
}

/**
 * Add a doc/tag/collection link under a folder. Mirrors `FolderStore.createLink`:
 * the parent must be a folder, and an existing identical link is reused.
 */
export function addFolderLink(
  doc: Y.Doc,
  parentId: string,
  type: 'doc' | 'tag' | 'collection',
  targetId: string
) {
  const rows = folderRows(doc);
  const parent = rows.find(row => row.id === parentId);
  if (!parent || parent.type !== 'folder') {
    throw new Error(`Folder ${parentId} not found`);
  }
  const existing = rows.find(
    row =>
      row.parentId === parentId && row.type === type && row.data === targetId
  );
  if (existing) return existing.id;
  const id = nanoid();
  upsertOrmRow(doc, id, {
    id,
    parentId,
    type,
    data: targetId,
    index: childIndexAfterAll(rows, parentId),
  });
  return id;
}

/** Folder path names from the root down to (and including) `folderId`. */
export function folderPath(rows: FolderRow[], folderId: string) {
  const byId = new Map(rows.map(row => [row.id, row]));
  const names: string[] = [];
  const seen = new Set<string>();
  let current = byId.get(folderId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.type === 'folder') names.unshift(current.data);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return names;
}
