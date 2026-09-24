import * as Y from 'yjs';

/**
 * Real page links without touching the native markdown converter.
 *
 * The native parser stores every markdown link as a plain `link` attribute, and
 * the native reader renders an inline page reference as
 * `[text](/workspace/<ws>/<docId>)`. These helpers bridge both directions:
 *
 * - write: link runs pointing at a page of this workspace become a
 *   `LinkedPage` reference (a single space carrying the `reference` attribute,
 *   exactly what the editor inserts - see `REFERENCE_NODE` and
 *   `blocksuite/affine/blocks/database/src/detail-panel/note-renderer.ts`);
 * - read: those links are rendered as `[<current title>](affine://<docId>)`, a
 *   form the write side accepts again, so read -> edit -> update keeps them.
 */

const REFERENCE_NODE = ' ';
const DOC_ID = '[A-Za-z0-9_-]+';

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The target doc id when `href` points at a page of this workspace. */
export function pageIdFromHref(href: string, workspaceId: string) {
  const trimmed = href.trim();
  const scheme = new RegExp(`^affine://(?:doc/)?(${DOC_ID})/?(?:[?#].*)?$`);
  const workspacePath = new RegExp(
    `^(?:https?://[^/]+)?/workspace/${escapeRegExp(workspaceId)}/(${DOC_ID})/?(?:[?#].*)?$`
  );
  return scheme.exec(trimmed)?.[1] ?? workspacePath.exec(trimmed)?.[1] ?? null;
}

type DeltaOp = {
  insert?: unknown;
  attributes?: Record<string, unknown>;
};

/**
 * Turn link runs that point at existing pages into page references, in place.
 * Returns the number of links converted.
 */
export function linkifyReferences(
  doc: Y.Doc,
  workspaceId: string,
  existingDocIds: Set<string>
) {
  const blocks = doc.getMap<unknown>('blocks');
  let converted = 0;
  for (const block of blocks.values()) {
    if (!(block instanceof Y.Map)) continue;
    const text = block.get('prop:text');
    if (!(text instanceof Y.Text)) continue;

    const targets: { offset: number; length: number; pageId: string }[] = [];
    let offset = 0;
    for (const op of text.toDelta() as DeltaOp[]) {
      const length = typeof op.insert === 'string' ? op.insert.length : 1;
      const link = op.attributes?.link;
      if (typeof link === 'string' && typeof op.insert === 'string') {
        const pageId = pageIdFromHref(link, workspaceId);
        if (pageId && existingDocIds.has(pageId)) {
          targets.push({ offset, length, pageId });
        }
      }
      offset += length;
    }

    // Back to front, so earlier offsets stay valid.
    for (const target of targets.reverse()) {
      text.delete(target.offset, target.length);
      text.insert(target.offset, REFERENCE_NODE, {
        reference: { type: 'LinkedPage', pageId: target.pageId },
      });
      converted++;
    }
  }
  return converted;
}

/**
 * Rewrite page references in reader output to `[<title>](affine://<docId>)`.
 */
export function renderReadReferences(
  markdown: string,
  workspaceId: string,
  titleOf: (docId: string) => string | undefined
) {
  const pattern = new RegExp(
    `\\[([^\\]]*)\\]\\(/workspace/${escapeRegExp(workspaceId)}/(${DOC_ID})\\)`,
    'g'
  );
  return markdown.replace(pattern, (_match, text: string, docId: string) => {
    const title = titleOf(docId) || text.trim() || 'Untitled';
    return `[${title.replace(/[[\]]/g, '')}](affine://${docId})`;
  });
}
