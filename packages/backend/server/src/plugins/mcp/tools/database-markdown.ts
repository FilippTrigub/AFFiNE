import * as Y from 'yjs';

import { blockSentinel } from '../../../core/doc/preserve-blocks';
import {
  type DocMarkdownContent,
  parseDocToMarkdownFromDocSnapshot,
} from '../../../core/utils/blocksuite';
import {
  type Blocks,
  childIds,
  columnsOf,
  findDatabases,
  newBlock,
} from './database-model';

/**
 * Databases in MCP markdown. The plain reader prints a database as a heading
 * and a markdown table; written back, that table would become a second, plain
 * table. So read_document shows each database as one marker line instead, and
 * update_document keeps the databases: a marker left in place keeps its
 * database there (text around it lands around it), a moved marker moves it,
 * and a dropped one leaves it where it was.
 */

const MARKER_LINE =
  /^[ \t]*<!-- database id=([A-Za-z0-9_-]+)[^\n]*-->[ \t]*$/gm;

function inline(text: string) {
  return text
    .replace(/\s+/g, ' ')
    .replace(/--+/g, '-')
    .replace(/"/g, "'")
    .trim();
}

export function databaseMarker(info: {
  id: string;
  title: string;
  rows: number;
  columns: number;
}) {
  return `<!-- database id=${info.id} "${inline(info.title) || 'Database'}" (${info.rows} rows, ${info.columns} columns): read it with read_database and edit it with the database tools. update_document keeps it in place. -->`;
}

/**
 * Markdown for a doc that holds databases, each one replaced by its marker.
 * `null` when the doc has none, so the caller keeps the plain reader's output.
 */
export function markdownWithDatabaseMarkers(
  workspaceId: string,
  docId: string,
  doc: Y.Doc
): DocMarkdownContent | null {
  const databases = findDatabases(doc);
  if (!databases.length) return null;

  const copy = new Y.Doc();
  try {
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
    const blocks = copy.getMap('blocks') as Blocks;
    const markers = new Map(
      databases.map(({ id, block, title }) => {
        return [
          blockSentinel(id),
          databaseMarker({
            id,
            title,
            rows: childIds(block).length,
            columns: columnsOf(block).length,
          }),
        ];
      })
    );
    copy.transact(() => {
      databases.forEach(({ id, block }) => {
        const drop = (blockId: string) => {
          childIds(blocks.get(blockId)).forEach(drop);
          blocks.delete(blockId);
        };
        childIds(block).forEach(drop);
        // Same id, so the sentinel sits exactly where the database was.
        const sentinel = newBlock(id, 'affine:paragraph', 1);
        sentinel.set('prop:type', 'text');
        sentinel.set('prop:text', new Y.Text(blockSentinel(id)));
        blocks.set(id, sentinel);
      });
    });
    const content = parseDocToMarkdownFromDocSnapshot(
      workspaceId,
      docId,
      Y.encodeStateAsUpdate(copy)
    );
    return {
      ...content,
      markdown: content.markdown.replace(
        /^AFFINEMCPBLOCK[0-9a-f]+X[ \t]*$/gm,
        line => markers.get(line.trim()) ?? ''
      ),
    };
  } finally {
    copy.destroy();
  }
}

/** Markdown for update_document: each marker becomes its database's sentinel. */
export function markersToSentinels(markdown: string) {
  // Blank lines around it, so it never joins the paragraph next to it.
  return markdown.replace(
    MARKER_LINE,
    (_, id: string) => `\n${blockSentinel(id)}\n`
  );
}
