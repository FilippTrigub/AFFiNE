import type { McpToolContext } from './context';
import { sanitizeName } from './define';
import { linkifyReferences, renderReadReferences } from './references';
import {
  addFolderLink,
  editPageTags,
  folderRows,
  listPages,
  loadRoot,
  loadTable,
  mutateRoot,
  mutateTable,
  resolveTags,
  writeDocProperties,
} from './workspace-data';

/**
 * Shared write paths for tools that create or rewrite page content, so page
 * links, tags and folder placement behave the same everywhere.
 */

export type DocMode = 'page' | 'edgeless';

export type CreateDocOptions = {
  title: string;
  markdown: string;
  mode?: DocMode;
  /** Tag ids or names; humans only (the tag list lives in the root doc). */
  tags?: string[];
  /** Folder to file the new doc under; humans only. */
  folderId?: string;
  /** Extra `docProperties` fields, e.g. `journal`. */
  properties?: Record<string, unknown>;
};

const LEADING_H1 = /^[ \t]{0,3}#\s+[^\n]*#*\s*\n*/;

export function stripLeadingTitle(markdown: string) {
  return markdown.replace(LEADING_H1, '');
}

/**
 * Convert links to pages of this workspace into real page references. Runs
 * after the native writer, which stores every link as a plain URL.
 */
export async function linkifyDoc(ctx: McpToolContext, docId: string) {
  const root = await loadRoot(ctx);
  // Only pages the caller may read: otherwise an agent could probe for the
  // existence of documents it was not granted by linking to them.
  const existing = new Set(
    listPages(root)
      .map(page => page.id)
      .filter(id => ctx.agentMayRead(id))
  );
  root.destroy();
  const { result } = await ctx.deps.yjs.mutate(
    ctx.workspaceId,
    docId,
    { editorId: ctx.userId },
    doc => linkifyReferences(doc, ctx.workspaceId, existing)
  );
  return result;
}

/**
 * Validate everything that could fail before the doc exists, so a bad tag or
 * folder never leaves a half-configured document behind.
 */
async function preflight(ctx: McpToolContext, options: CreateDocOptions) {
  const wantsOrganize = !!options.tags?.length || !!options.folderId;
  if (wantsOrganize && ctx.isAgent) {
    throw new Error(
      'Tags and folders are not available to workspace agent credentials'
    );
  }
  let tagIds: string[] = [];
  if (options.tags?.length) {
    const root = await loadRoot(ctx);
    const { ids, missing } = resolveTags(root, options.tags);
    root.destroy();
    if (missing.length) {
      throw new Error(
        `Unknown tags: ${missing.join(', ')}. Create them with create_tag first.`
      );
    }
    tagIds = ids;
  }
  if (options.folderId) {
    const doc = await loadTable(ctx, 'folders');
    const folder = folderRows(doc).find(row => row.id === options.folderId);
    doc.destroy();
    if (!folder || folder.type !== 'folder') {
      throw new Error(`Folder ${options.folderId} not found`);
    }
  }
  return { tagIds };
}

export async function createDocument(
  ctx: McpToolContext,
  options: CreateDocOptions
) {
  if (!ctx.isAgent) {
    await ctx.assertWorkspace('Workspace.CreateDoc');
  }
  const title = sanitizeName(options.title, 'Title');
  const { tagIds } = await preflight(ctx, options);

  const { docId } = await ctx.deps.writer.createDoc(
    ctx.workspaceId,
    title,
    stripLeadingTitle(options.markdown),
    ctx.userId
  );
  await ctx.grantAgentCreatedDoc(docId);

  const linked = await linkifyDoc(ctx, docId);

  const properties = {
    ...(options.mode ? { primaryMode: options.mode } : {}),
    ...options.properties,
  };
  if (Object.keys(properties).length) {
    await writeDocProperties(ctx, docId, properties);
  }
  if (tagIds.length) {
    await mutateRoot(ctx, root => editPageTags(root, docId, tagIds, []));
  }
  let folderLinkId: string | undefined;
  if (options.folderId) {
    const folderId = options.folderId;
    ({ result: folderLinkId } = await mutateTable(ctx, 'folders', doc =>
      addFolderLink(doc, folderId, 'doc', docId)
    ));
  }
  return { docId, title, linkedPages: linked, folderLinkId };
}

export async function updateDocumentContent(
  ctx: McpToolContext,
  docId: string,
  markdown: string
) {
  await ctx.deps.writer.updateDoc(ctx.workspaceId, docId, markdown, ctx.userId);
  return await linkifyDoc(ctx, docId);
}

/**
 * Reader markdown made safe to hand to the caller: page references become
 * `[Title](affine://<docId>)` with titles only for pages the caller may read.
 * Every tool that returns or copies document markdown must go through this.
 */
export async function presentMarkdown(ctx: McpToolContext, markdown: string) {
  const root = await loadRoot(ctx);
  const titles = new Map(
    listPages(root)
      .filter(page => ctx.agentMayRead(page.id))
      .map(page => [page.id, page.title])
  );
  root.destroy();
  return renderReadReferences(markdown, ctx.workspaceId, docId =>
    titles.get(docId)
  );
}
