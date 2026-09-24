import { nanoid } from 'nanoid';
import z from 'zod/v3';

import { backendRuntimeErrorCode } from '../../../core/backend-runtime';
import { publishCommentChanged } from '../../../core/comment/realtime';
import { parseDocToMarkdownFromDocSnapshot } from '../../../core/utils/blocksuite';
import type { McpToolContext } from './context';
import {
  docNotFound,
  errorMessage,
  type McpTool,
  mcpTool,
  toolError,
  toolJson,
  toolText,
} from './define';
import { findPage, loadRoot, readTableRow } from './workspace-data';

/**
 * Comments, version history and publishing, through the same services and
 * domain commands the GraphQL resolvers use (`core/comment/resolver.ts`,
 * `core/workspaces/resolvers/history.ts`, `core/workspaces/resolvers/doc.ts`).
 * Deleting comments or replies is deliberately absent.
 */

const TEXT = '$blocksuite:internal:text$';

type SnapshotBlock = {
  flavour?: string;
  props?: Record<string, any>;
  children?: SnapshotBlock[];
};

/**
 * A minimal Blocksuite doc snapshot (page -> note -> paragraphs), the shape
 * the client stores as comment content
 * (`packages/frontend/core/src/modules/comment/services/snapshot-helper.ts`).
 */
export function commentSnapshot(text: string) {
  const paragraph = (line: string) => ({
    type: 'block',
    id: nanoid(),
    flavour: 'affine:paragraph',
    version: 1,
    props: {
      type: 'text',
      text: { [TEXT]: true, delta: line ? [{ insert: line }] : [] },
    },
    children: [],
  });
  return {
    type: 'page',
    meta: { id: nanoid(), title: '', createDate: Date.now(), tags: [] },
    blocks: {
      type: 'block',
      id: nanoid(),
      flavour: 'affine:page',
      version: 2,
      props: { title: { [TEXT]: true, delta: [] } },
      children: [
        {
          type: 'block',
          id: nanoid(),
          flavour: 'affine:note',
          version: 1,
          props: {},
          children: text.split('\n').map(paragraph),
        },
      ],
    },
  };
}

/** Plain text of a stored comment, whatever blocks it holds. */
export function commentText(content: unknown) {
  const lines: string[] = [];
  const walk = (block: SnapshotBlock | undefined) => {
    if (!block) return;
    const delta = block.props?.text?.delta;
    if (Array.isArray(delta)) {
      lines.push(
        delta
          .map((op: { insert?: unknown }) =>
            typeof op.insert === 'string' ? op.insert : ''
          )
          .join('')
      );
    }
    block.children?.forEach(walk);
  };
  walk(
    (content as { snapshot?: { blocks?: SnapshotBlock } })?.snapshot?.blocks
  );
  return lines.join('\n').trim();
}

export function buildCollaborationTools(ctx: McpToolContext): McpTool[] {
  const { userId, workspaceId, deps } = ctx;

  const docContext = async (docId: string) => {
    const root = await loadRoot(ctx);
    const title = findPage(root, docId)?.title ?? '';
    root.destroy();
    const props = await readTableRow(ctx, 'docProperties', docId);
    const mode = props?.primaryMode === 'edgeless' ? 'edgeless' : 'page';
    return { title, mode };
  };

  const afterCommentWrite = async (item: object, docId: string) => {
    const ids = (item as { notificationIds?: string[] }).notificationIds ?? [];
    await Promise.allSettled(
      ids.map(id => deps.notifications.deliverComment(id))
    );
    publishCommentChanged(deps.realtime, workspaceId, docId);
  };

  const mentionsSchema = z.array(z.string().min(1)).max(20).optional();

  const listComments = mcpTool('read', 'all', {
    name: 'list_comments',
    title: 'List Comments',
    description:
      'Comments on a document, newest first, with their replies, authors and resolved state.',
    parser: z.object({
      docId: z.string(),
      include_resolved: z.boolean().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    inputSchema: {
      type: 'object',
      properties: {
        docId: { type: 'string' },
        include_resolved: { type: 'boolean', description: 'Default true' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      required: ['docId'],
      additionalProperties: false,
    },
    execute: async ({ docId, include_resolved = true, limit }) => {
      if (!(await ctx.canDoc(docId, 'Doc.Comments.Read'))) {
        return docNotFound(docId);
      }
      const comments = await deps.comments.listComments(workspaceId, docId, {
        take: limit ?? 50,
      });
      const author = (user?: { id: string; name?: string | null }) =>
        user ? { id: user.id, name: user.name ?? undefined } : undefined;
      return toolJson({
        comments: comments
          .filter(comment => include_resolved || !comment.resolved)
          .map(comment => ({
            id: comment.id,
            author: author(comment.user),
            text: commentText(comment.content),
            resolved: comment.resolved,
            createdAt: comment.createdAt,
            replies: comment.replies.map(reply => ({
              id: reply.id,
              author: author(reply.user),
              text: commentText(reply.content),
              createdAt: reply.createdAt,
            })),
          })),
      });
    },
  });

  const createComment = mcpTool('write', 'all', {
    name: 'create_comment',
    title: 'Create Comment',
    description:
      'Add a document-level comment (plain text, newlines allowed). `mentions` are user ids to notify.',
    parser: z.object({
      docId: z.string(),
      text: z.string().trim().min(1).max(10_000),
      mentions: mentionsSchema,
    }),
    inputSchema: {
      type: 'object',
      properties: {
        docId: { type: 'string' },
        text: { type: 'string' },
        mentions: { type: 'array', items: { type: 'string' } },
      },
      required: ['docId', 'text'],
      additionalProperties: false,
    },
    execute: async ({ docId, text, mentions }) => {
      if (
        !(await ctx.canDoc(docId, 'Doc.Read')) ||
        !(await ctx.canDoc(docId, 'Doc.Comments.Create'))
      ) {
        return docNotFound(docId);
      }
      try {
        const { title, mode } = await docContext(docId);
        const comment = await deps.comments.createComment(userId, {
          workspaceId,
          docId,
          content: { snapshot: commentSnapshot(text), mode, attachments: [] },
          docTitle: title,
          docMode: mode,
          mentions,
        });
        await afterCommentWrite(comment, docId);
        return toolJson({ success: true, commentId: comment.id });
      } catch (error) {
        return toolError(`Failed to create comment: ${errorMessage(error)}`);
      }
    },
  });

  const replyComment = mcpTool('write', 'all', {
    name: 'reply_comment',
    title: 'Reply To Comment',
    description:
      'Reply to a comment (plain text). `mentions` are user ids to notify.',
    parser: z.object({
      comment_id: z.string().min(1),
      text: z.string().trim().min(1).max(10_000),
      mentions: mentionsSchema,
    }),
    inputSchema: {
      type: 'object',
      properties: {
        comment_id: { type: 'string' },
        text: { type: 'string' },
        mentions: { type: 'array', items: { type: 'string' } },
      },
      required: ['comment_id', 'text'],
      additionalProperties: false,
    },
    execute: async ({ comment_id, text, mentions }) => {
      const comment = await deps.comments.getComment(comment_id);
      const notFound = toolError(`Comment ${comment_id} not found.`);
      if (!comment || comment.workspaceId !== workspaceId) return notFound;
      if (!(await ctx.canDoc(comment.docId, 'Doc.Comments.Create'))) {
        return notFound;
      }
      try {
        const { title, mode } = await docContext(comment.docId);
        const reply = await deps.comments.createReply(userId, {
          commentId: comment_id,
          content: { snapshot: commentSnapshot(text), mode, attachments: [] },
          docTitle: title,
          docMode: mode,
          mentions,
        });
        await afterCommentWrite(reply, comment.docId);
        return toolJson({ success: true, replyId: reply.id });
      } catch (error) {
        return toolError(`Failed to reply: ${errorMessage(error)}`);
      }
    },
  });

  const resolveComment = mcpTool('write', 'all', {
    name: 'resolve_comment',
    title: 'Resolve Comment',
    description:
      'Mark a comment thread resolved, or reopen it with resolved: false.',
    parser: z.object({
      comment_id: z.string().min(1),
      resolved: z.boolean().optional(),
    }),
    inputSchema: {
      type: 'object',
      properties: {
        comment_id: { type: 'string' },
        resolved: { type: 'boolean', description: 'Default true' },
      },
      required: ['comment_id'],
      additionalProperties: false,
    },
    execute: async ({ comment_id, resolved = true }) => {
      const comment = await deps.comments.getComment(comment_id);
      const notFound = toolError(`Comment ${comment_id} not found.`);
      if (!comment || comment.workspaceId !== workspaceId) return notFound;
      // The author may always resolve their own thread, as in the resolver.
      const isAuthor = comment.userId === userId;
      if (
        !(await ctx.canDoc(comment.docId, 'Doc.Comments.Read')) ||
        (!isAuthor &&
          !(await ctx.canDoc(comment.docId, 'Doc.Comments.Moderate')))
      ) {
        return notFound;
      }
      try {
        await deps.comments.resolveComment(userId, {
          id: comment_id,
          resolved,
        });
        publishCommentChanged(deps.realtime, workspaceId, comment.docId);
        return toolJson({ success: true, commentId: comment_id, resolved });
      } catch (error) {
        return toolError(`Failed to resolve comment: ${errorMessage(error)}`);
      }
    },
  });

  const listHistory = mcpTool('read', 'all', {
    name: 'list_history',
    title: 'List Document History',
    description:
      'Saved versions of a document, newest first, with timestamp and editor. Use a timestamp with read_version or restore_version.',
    parser: z.object({
      docId: z.string(),
      before: z.string().datetime().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    inputSchema: {
      type: 'object',
      properties: {
        docId: { type: 'string' },
        before: { type: 'string', description: 'ISO timestamp' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      required: ['docId'],
      additionalProperties: false,
    },
    execute: async ({ docId, before, limit }) => {
      if (!(await ctx.canDoc(docId, 'Doc.History.Read'))) {
        return docNotFound(docId);
      }
      const histories = await deps.storage.listDocHistories(
        workspaceId,
        docId,
        {
          before: before ? new Date(before).getTime() : Date.now(),
          limit: limit ?? 20,
        }
      );
      return toolJson({
        versions: histories.map(history => ({
          timestamp: new Date(history.timestamp).toISOString(),
          editor: history.editor
            ? { id: history.editor.id, name: history.editor.name }
            : undefined,
        })),
      });
    },
  });

  const readVersion = mcpTool('read', 'all', {
    name: 'read_version',
    title: 'Read Document Version',
    description:
      'Read a saved version of a document as markdown (timestamp from list_history), e.g. to compare before restoring it.',
    parser: z.object({ docId: z.string(), timestamp: z.string().datetime() }),
    inputSchema: {
      type: 'object',
      properties: {
        docId: { type: 'string' },
        timestamp: { type: 'string', description: 'ISO timestamp' },
      },
      required: ['docId', 'timestamp'],
      additionalProperties: false,
    },
    execute: async ({ docId, timestamp }) => {
      if (!(await ctx.canDoc(docId, 'Doc.History.Read'))) {
        return docNotFound(docId);
      }
      const history = await deps.storage.getDocHistory(
        workspaceId,
        docId,
        new Date(timestamp).getTime()
      );
      if (!history) return toolError(`No version of ${docId} at ${timestamp}.`);
      const content = parseDocToMarkdownFromDocSnapshot(
        workspaceId,
        docId,
        history.bin
      );
      return toolText(content.markdown);
    },
  });

  const restoreVersion = mcpTool('write', 'all', {
    name: 'restore_version',
    title: 'Restore Document Version',
    description:
      'Restore a document to a saved version (timestamp from list_history). The current state is saved as a new version first, so this can be undone.',
    parser: z.object({ docId: z.string(), timestamp: z.string().datetime() }),
    inputSchema: {
      type: 'object',
      properties: {
        docId: { type: 'string' },
        timestamp: { type: 'string', description: 'ISO timestamp' },
      },
      required: ['docId', 'timestamp'],
      additionalProperties: false,
    },
    execute: async ({ docId, timestamp }) => {
      if (
        !(await ctx.canDoc(docId, 'Doc.History.Read')) ||
        !(await ctx.canDoc(docId, 'Doc.Update'))
      ) {
        return docNotFound(docId);
      }
      try {
        await deps.runtime.executeDomainCommandV1({
          command: 'recover_doc',
          actorUserId: userId,
          workspaceId,
          docId,
          timestamp: new Date(timestamp).toISOString(),
        });
        return toolJson({ success: true, docId, restoredTo: timestamp });
      } catch (error) {
        return toolError(`Failed to restore version: ${errorMessage(error)}`);
      }
    },
  });

  const publish = (name: 'publish_document' | 'unpublish_document') =>
    mcpTool('write', 'human', {
      name,
      title:
        name === 'publish_document' ? 'Publish Document' : 'Unpublish Document',
      description:
        name === 'publish_document'
          ? 'Make a document readable by anyone with its link (mode: page or edgeless). Revert with unpublish_document.'
          : 'Take a published document offline again.',
      parser: z.object({
        docId: z.string(),
        mode: z.enum(['page', 'edgeless']).optional(),
      }),
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
          ...(name === 'publish_document'
            ? { mode: { type: 'string', enum: ['page', 'edgeless'] } }
            : {}),
        },
        required: ['docId'],
        additionalProperties: false,
      },
      execute: async ({ docId, mode }) => {
        const action =
          name === 'publish_document' ? 'Doc.Publish' : 'Doc.Unpublish';
        if (docId === workspaceId || !(await ctx.canDoc(docId, action))) {
          return docNotFound(docId);
        }
        try {
          await deps.runtime.executeDomainCommandV1(
            name === 'publish_document'
              ? {
                  command: 'publish_doc',
                  actorUserId: userId,
                  workspaceId,
                  docId,
                  mode: mode === 'edgeless' ? 1 : 0,
                }
              : {
                  command: 'unpublish_doc',
                  actorUserId: userId,
                  workspaceId,
                  docId,
                }
          );
          deps.event.emit('doc.public_state.changed', { workspaceId, docId });
          return toolJson({
            success: true,
            docId,
            public: name === 'publish_document',
          });
        } catch (error) {
          const code = backendRuntimeErrorCode(error);
          if (code === 'doc_not_found' || code === 'domain_permission_denied') {
            return docNotFound(docId);
          }
          if (code === 'doc_is_not_public') {
            return toolError(`Document ${docId} is not published.`);
          }
          return toolError(
            `Failed to ${name.split('_')[0]} document: ${errorMessage(error)}`
          );
        }
      },
    });

  return [
    listComments,
    createComment,
    replyComment,
    resolveComment,
    listHistory,
    readVersion,
    restoreVersion,
    publish('publish_document'),
    publish('unpublish_document'),
  ];
}
