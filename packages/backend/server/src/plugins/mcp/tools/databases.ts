import { nanoid } from 'nanoid';
import * as Y from 'yjs';
import z from 'zod/v3';

import type { McpToolContext } from './context';
import {
  docNotFound,
  errorMessage,
  type McpTool,
  mcpTool,
  toolError,
  toolJson,
} from './define';

/**
 * Database blocks written in the editor's own Yjs layout, as the editor
 * creates them (`blocksuite/affine/model/src/blocks/database`, schema
 * version 3): every nested value is a Y.Map / Y.Array, never plain JSON, and
 * text values are Y.Text. The first column is the built-in `title` column,
 * whose value is each row's paragraph text; the others are `rich-text`.
 */

const MAX_COLUMNS = 50;
const MAX_ROWS = 5000;
const MAX_CELL_CHARS = 10_000;
const TITLE_COLUMN = 'title';
const TITLE_WIDTH = 260;
const COLUMN_WIDTH = 180;

export type DatabaseSpec = {
  title: string;
  columns: string[];
  rows: string[][];
};

function yMap(entries: Record<string, unknown>) {
  const map = new Y.Map<unknown>();
  for (const [key, value] of Object.entries(entries)) map.set(key, value);
  return map;
}

function yArray(items: unknown[]) {
  const array = new Y.Array<unknown>();
  array.push(items);
  return array;
}

/** The note the editor shows as the page body: the page's first note. */
function contentNote(blocks: Y.Map<Y.Map<unknown>>) {
  for (const block of blocks.values()) {
    if (block.get('sys:flavour') !== 'affine:page') continue;
    const children = block.get('sys:children') as Y.Array<string> | undefined;
    for (const id of children?.toArray() ?? []) {
      const child = blocks.get(id);
      if (child?.get('sys:flavour') === 'affine:note') return child;
    }
  }
  throw new Error('The document has no page body to add a database to.');
}

function block(id: string, flavour: string, version: number) {
  return yMap({
    'sys:id': id,
    'sys:flavour': flavour,
    'sys:version': version,
    'sys:children': new Y.Array<string>(),
  });
}

/** Append a database to the doc's body. Call inside a transaction. */
export function appendDatabase(
  doc: Y.Doc,
  spec: DatabaseSpec,
  newId: () => string = () => nanoid(10)
) {
  const blocks = doc.getMap<Y.Map<unknown>>('blocks');
  const note = contentNote(blocks);
  const databaseId = newId();
  const columnIds = spec.columns.map((_, i) =>
    i === 0 ? TITLE_COLUMN : newId()
  );

  const database = block(databaseId, 'affine:database', 3);
  database.set('prop:title', new Y.Text(spec.title));
  database.set(
    'prop:columns',
    yArray(
      spec.columns.map((name, i) =>
        yMap({
          id: columnIds[i],
          type: i === 0 ? 'title' : 'rich-text',
          name,
          data: new Y.Map(),
        })
      )
    )
  );
  database.set(
    'prop:views',
    yArray([
      yMap({
        id: newId(),
        name: 'Table View',
        mode: 'table',
        columns: yArray(
          columnIds.map(id =>
            yMap({
              id,
              hide: false,
              width: id === TITLE_COLUMN ? TITLE_WIDTH : COLUMN_WIDTH,
            })
          )
        ),
        filter: yMap({ type: 'group', op: 'and', conditions: new Y.Array() }),
        header: yMap({ titleColumn: TITLE_COLUMN, iconColumn: 'type' }),
      }),
    ])
  );

  const cells = new Y.Map<Y.Map<unknown>>();
  const rowIds: string[] = [];
  blocks.set(databaseId, database);
  for (const row of spec.rows) {
    const rowId = newId();
    rowIds.push(rowId);
    const paragraph = block(rowId, 'affine:paragraph', 1);
    paragraph.set('prop:type', 'text');
    paragraph.set('prop:text', new Y.Text(row[0] ?? ''));
    paragraph.set('prop:collapsed', false);
    blocks.set(rowId, paragraph);

    const rowCells = new Y.Map<unknown>();
    for (let i = 1; i < columnIds.length; i++) {
      const value = row[i] ?? '';
      if (!value) continue;
      rowCells.set(
        columnIds[i],
        yMap({ columnId: columnIds[i], value: new Y.Text(value) })
      );
    }
    cells.set(rowId, rowCells);
  }
  database.set('prop:cells', cells);
  (database.get('sys:children') as Y.Array<string>).push(rowIds);
  (note.get('sys:children') as Y.Array<string>).push([databaseId]);
  return { databaseId, rows: rowIds.length, columns: columnIds.length };
}

const parser = z
  .object({
    docId: z.string(),
    title: z.string().max(200).optional(),
    columns: z
      .array(z.string().trim().max(200))
      .min(1, 'Give at least one column')
      .max(MAX_COLUMNS),
    rows: z.array(z.array(z.string().max(MAX_CELL_CHARS))).max(MAX_ROWS),
  })
  .superRefine(({ columns, rows }, issues) => {
    const wide = rows.findIndex(row => row.length > columns.length);
    if (wide >= 0) {
      issues.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rows', wide],
        message: `row has more values than the ${columns.length} columns`,
      });
    }
  });

export function buildDatabaseTools(ctx: McpToolContext): McpTool[] {
  const createDatabase = mcpTool('write', 'all', {
    name: 'create_database',
    title: 'Create Database',
    description: `Append a database (a sortable, filterable table) to the end of a document. \`columns\` are the column names; the first one is the row title. \`rows\` holds one list of values per row, in column order; missing values stay empty. All columns are text. Up to ${MAX_ROWS} rows and ${MAX_COLUMNS} columns. Note: update_document refuses documents that contain a database, so write the rest of the document first.`,
    parser,
    inputSchema: {
      type: 'object',
      properties: {
        docId: { type: 'string' },
        title: {
          type: 'string',
          description: 'Database name shown above it. Default: "Database"',
        },
        columns: { type: 'array', items: { type: 'string' } },
        rows: {
          type: 'array',
          items: { type: 'array', items: { type: 'string' } },
        },
      },
      required: ['docId', 'columns', 'rows'],
      additionalProperties: false,
    },
    execute: async ({ docId, title, columns, rows }) => {
      if (!(await ctx.canDoc(docId, 'Doc.Update'))) return docNotFound(docId);
      const spec = {
        title: title?.trim() || 'Database',
        columns: columns.map((name, i) => name || `Column ${i + 1}`),
        rows,
      };
      try {
        const { result } = await ctx.deps.yjs.mutate(
          ctx.workspaceId,
          docId,
          { editorId: ctx.userId },
          doc => appendDatabase(doc, spec)
        );
        return toolJson({ success: true, docId, ...result });
      } catch (error) {
        return toolError(`Failed to create database: ${errorMessage(error)}`);
      }
    },
  });

  return [createDatabase];
}
