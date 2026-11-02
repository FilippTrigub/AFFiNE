import * as Y from 'yjs';
import z from 'zod/v3';

import type { McpToolContext } from './context';
import {
  addRows,
  applyColumnOps,
  type ColumnOp,
  describeColumns,
  readRows,
  removeRows,
  type RowValues,
  updateRows,
} from './database-edit';
import {
  type Block,
  type Blocks,
  type CellInput,
  type Column,
  DatabaseInputError,
  defaultColumnData,
  encodeCell,
  findDatabases,
  newBlock,
  newId,
  resolveDatabase,
  TITLE_COLUMN,
  WRITABLE_TYPES,
  type WritableType,
  yArray,
  yMap,
} from './database-model';
import {
  docNotFound,
  errorMessage,
  type McpTool,
  mcpTool,
  toolError,
  toolJson,
} from './define';

/**
 * Database blocks over MCP, written in the editor's own Yjs layout (see
 * `database-model.ts`). The first column of a new database is the built-in
 * `title` column, whose value is each row's paragraph text.
 */

const MAX_COLUMNS = 50;
const MAX_ROWS = 5000;
const MAX_ROWS_PER_CALL = 1000;
const MAX_CELL_CHARS = 10_000;
const READ_LIMIT = 100;
const MAX_READ_LIMIT = 500;
const TITLE_WIDTH = 260;
const COLUMN_WIDTH = 180;

export type DatabaseColumnSpec = { name: string; type?: WritableType };

export type DatabaseSpec = {
  title: string;
  columns: (string | DatabaseColumnSpec)[];
  rows: CellInput[][];
};

/** The note the editor shows as the page body: the page's first note. */
function contentNote(blocks: Blocks) {
  for (const block of blocks.values()) {
    if (block.get('sys:flavour') !== 'affine:page') continue;
    const children = block.get('sys:children') as Y.Array<string> | undefined;
    for (const id of children?.toArray() ?? []) {
      const child = blocks.get(id);
      if (child?.get('sys:flavour') === 'affine:note') return child;
    }
  }
  throw new DatabaseInputError(
    'The document has no page body to add a database to.'
  );
}

/** Append a database to the doc's body. Call inside a transaction. */
export function appendDatabase(
  doc: Y.Doc,
  spec: DatabaseSpec,
  makeId: () => string = newId
) {
  const blocks = doc.getMap('blocks') as Blocks;
  const note = contentNote(blocks);
  const databaseId = makeId();
  const columns = spec.columns.map((column, i) => {
    const { name, type = 'rich-text' } =
      typeof column === 'string' ? { name: column } : column;
    const id = i === 0 ? TITLE_COLUMN : makeId();
    const columnType = i === 0 ? 'title' : type;
    const data = defaultColumnData(columnType);
    const map = yMap({ id, type: columnType, name, data });
    return { id, type: columnType, name, map, data } satisfies Column;
  });

  const database = newBlock(databaseId, 'affine:database', 3);
  database.set('prop:title', new Y.Text(spec.title));
  database.set('prop:columns', yArray(columns.map(column => column.map)));
  database.set(
    'prop:views',
    yArray([
      yMap({
        id: makeId(),
        name: 'Table View',
        mode: 'table',
        columns: yArray(
          columns.map(({ id }) =>
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
  spec.rows.forEach((row, r) => {
    const rowId = makeId();
    rowIds.push(rowId);
    const paragraph = newBlock(rowId, 'affine:paragraph', 1);
    paragraph.set('prop:type', 'text');
    paragraph.set('prop:text', new Y.Text(String(row[0] ?? '')));
    paragraph.set('prop:collapsed', false);
    blocks.set(rowId, paragraph);

    const rowCells = new Y.Map<unknown>();
    for (let i = 1; i < columns.length; i++) {
      let value: unknown;
      try {
        value = encodeCell(columns[i], row[i] ?? null);
      } catch (error) {
        throw new DatabaseInputError(`Row ${r + 1}: ${errorMessage(error)}`);
      }
      if (value === undefined) continue;
      rowCells.set(columns[i].id, yMap({ columnId: columns[i].id, value }));
    }
    cells.set(rowId, rowCells);
  });
  database.set('prop:cells', cells);
  (database.get('sys:children') as Y.Array<string>).push(rowIds);
  (note.get('sys:children') as Y.Array<string>).push([databaseId]);
  return { databaseId, rows: rowIds.length, columns: columns.length };
}

// ---------------------------------------------------------------- schemas

const cellInput = z.union([
  z.string().max(MAX_CELL_CHARS),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.string().max(200)).max(100),
]);
const rowValues = z
  .record(cellInput)
  .refine(values => Object.keys(values).length <= MAX_COLUMNS, {
    message: `at most ${MAX_COLUMNS} values per row`,
  });
const columnType = z.enum(WRITABLE_TYPES);
const columnName = z.string().trim().min(1).max(200);

const CELL_SCHEMA = {
  description:
    'Text, number, true/false, a list of labels (multi-select), or null to clear',
  anyOf: [
    { type: 'string' },
    { type: 'number' },
    { type: 'boolean' },
    { type: 'null' },
    { type: 'array', items: { type: 'string' } },
  ],
};
const ROW_SCHEMA = {
  type: 'object',
  description: 'Values by column name (or column id)',
  additionalProperties: CELL_SCHEMA,
};
const TYPE_SCHEMA = { type: 'string', enum: [...WRITABLE_TYPES] };
const DB_PROPS = {
  docId: { type: 'string' },
  databaseId: {
    type: 'string',
    description: 'Needed only when the document has more than one database',
  },
};

const VALUE_HELP =
  'Values: text for text and link columns; a number (progress 0-100); true/false for checkbox; a date as YYYY-MM-DD for date; an option label for select and a list of labels for multi-select (new labels become new options); null clears a cell. Rows and columns are named by column name or id.';

const createParser = z
  .object({
    docId: z.string(),
    title: z.string().max(200).optional(),
    columns: z
      .array(
        z.union([
          z.string().trim().max(200),
          z.object({ name: z.string().trim().max(200), type: columnType }),
        ])
      )
      .min(1, 'Give at least one column')
      .max(MAX_COLUMNS),
    rows: z.array(z.array(cellInput)).max(MAX_ROWS),
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

const columnOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), name: columnName, type: columnType }),
  z.object({ op: z.literal('rename'), column: z.string(), name: columnName }),
  z.object({ op: z.literal('remove'), column: z.string() }),
  z.object({ op: z.literal('set_type'), column: z.string(), type: columnType }),
]);

// ---------------------------------------------------------------- tools

export function buildDatabaseTools(ctx: McpToolContext): McpTool[] {
  /** Run `fn` on one database in a single all-or-nothing write. */
  async function editDatabase(
    docId: string,
    databaseId: string | undefined,
    fn: (database: Block) => Record<string, unknown>
  ) {
    if (!(await ctx.canDoc(docId, 'Doc.Update'))) return docNotFound(docId);
    try {
      const { result } = await ctx.deps.yjs.mutate(
        ctx.workspaceId,
        docId,
        { editorId: ctx.userId },
        doc => {
          const database = resolveDatabase(doc, databaseId);
          return { databaseId: database.id, ...fn(database.block) };
        }
      );
      return toolJson({ success: true, docId, ...result });
    } catch (error) {
      if (error instanceof DatabaseInputError) {
        return toolError(`Nothing was changed. ${error.message}`);
      }
      return toolError(`Failed to edit the database: ${errorMessage(error)}`);
    }
  }

  const createDatabase = mcpTool('write', 'all', {
    name: 'create_database',
    title: 'Create Database',
    description: `Append a database (a sortable, filterable table) to the end of a document. \`columns\` are column names, or \`{name, type}\` for a typed column (types: ${WRITABLE_TYPES.join(', ')}; default rich-text). The first column is the row title. \`rows\` holds one list of values per row, in column order; missing values stay empty. ${VALUE_HELP} Up to ${MAX_ROWS} rows and ${MAX_COLUMNS} columns.`,
    parser: createParser,
    inputSchema: {
      type: 'object',
      properties: {
        docId: { type: 'string' },
        title: {
          type: 'string',
          description: 'Database name shown above it. Default: "Database"',
        },
        columns: {
          type: 'array',
          items: {
            anyOf: [
              { type: 'string' },
              {
                type: 'object',
                properties: { name: { type: 'string' }, type: TYPE_SCHEMA },
                required: ['name', 'type'],
                additionalProperties: false,
              },
            ],
          },
        },
        rows: { type: 'array', items: { type: 'array', items: CELL_SCHEMA } },
      },
      required: ['docId', 'columns', 'rows'],
      additionalProperties: false,
    },
    execute: async ({ docId, title, columns, rows }) => {
      if (!(await ctx.canDoc(docId, 'Doc.Update'))) return docNotFound(docId);
      const spec = {
        title: title?.trim() || 'Database',
        columns: columns.map((column, i) => {
          const name = typeof column === 'string' ? column : column.name;
          const fallback = name || `Column ${i + 1}`;
          return typeof column === 'string'
            ? fallback
            : { ...column, name: fallback };
        }),
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

  const readDatabase = mcpTool('read', 'all', {
    name: 'read_database',
    title: 'Read Database',
    description: `Read a database in a document: its columns (id, name, type, select options) and a page of rows, each \`{id, values}\` with values by column name (empty values left out). Use the row ids with update_database_rows and remove_database_rows. \`search\` keeps rows where any value contains the text (case-insensitive). Without databaseId and with several databases in the document, lists them instead.`,
    parser: z.object({
      docId: z.string(),
      databaseId: z.string().optional(),
      search: z.string().max(200).optional(),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(MAX_READ_LIMIT).optional(),
    }),
    inputSchema: {
      type: 'object',
      properties: {
        ...DB_PROPS,
        search: { type: 'string' },
        offset: { type: 'integer', description: 'Rows to skip. Default 0' },
        limit: {
          type: 'integer',
          description: `Rows to return. Default ${READ_LIMIT}, at most ${MAX_READ_LIMIT}`,
        },
      },
      required: ['docId'],
      additionalProperties: false,
    },
    execute: async ({ docId, databaseId, search, offset = 0, limit }) => {
      if (!(await ctx.canDoc(docId, 'Doc.Read'))) return docNotFound(docId);
      const doc = await ctx.deps.yjs.load(ctx.workspaceId, docId);
      try {
        const databases = findDatabases(doc);
        if (!databaseId && databases.length > 1) {
          return toolJson({
            docId,
            databases: databases.map(db => ({
              id: db.id,
              title: db.title,
              rows: (db.block.get('sys:children') as Y.Array<string>).length,
            })),
          });
        }
        const { id, block, title } = resolveDatabase(doc, databaseId);
        let rows = readRows(block);
        const totalRows = rows.length;
        const needle = search?.trim().toLowerCase();
        if (needle) {
          rows = rows.filter(row =>
            Object.values(row.values).some(value =>
              String(value).toLowerCase().includes(needle)
            )
          );
        }
        const page = rows.slice(offset, offset + (limit ?? READ_LIMIT));
        const next = offset + page.length;
        return toolJson({
          docId,
          databaseId: id,
          title,
          columns: describeColumns(block),
          totalRows,
          ...(needle ? { matchingRows: rows.length } : {}),
          offset,
          rows: page,
          ...(next < rows.length ? { nextOffset: next } : {}),
        });
      } catch (error) {
        if (error instanceof DatabaseInputError)
          return toolError(error.message);
        throw error;
      } finally {
        doc.destroy();
      }
    },
  });

  const addDatabaseRows = mcpTool('write', 'all', {
    name: 'add_database_rows',
    title: 'Add Database Rows',
    description: `Add rows to the end of a database. Each row is an object of values by column name; columns left out stay empty. ${VALUE_HELP} All rows are added, or none if any value is invalid. Up to ${MAX_ROWS_PER_CALL} rows per call.`,
    parser: z.object({
      docId: z.string(),
      databaseId: z.string().optional(),
      rows: z.array(rowValues).min(1).max(MAX_ROWS_PER_CALL),
    }),
    inputSchema: {
      type: 'object',
      properties: { ...DB_PROPS, rows: { type: 'array', items: ROW_SCHEMA } },
      required: ['docId', 'rows'],
      additionalProperties: false,
    },
    execute: async ({ docId, databaseId, rows }) =>
      await editDatabase(docId, databaseId, database => ({
        rowIds: addRows(database, rows as RowValues[]),
      })),
  });

  const updateDatabaseRows = mcpTool('write', 'all', {
    name: 'update_database_rows',
    title: 'Update Database Rows',
    description: `Change cells of existing rows (row ids from read_database). Only the columns given change. ${VALUE_HELP} All changes apply, or none if any row or value is invalid. Up to ${MAX_ROWS_PER_CALL} rows per call.`,
    parser: z.object({
      docId: z.string(),
      databaseId: z.string().optional(),
      updates: z
        .array(z.object({ rowId: z.string(), values: rowValues }))
        .min(1)
        .max(MAX_ROWS_PER_CALL),
    }),
    inputSchema: {
      type: 'object',
      properties: {
        ...DB_PROPS,
        updates: {
          type: 'array',
          items: {
            type: 'object',
            properties: { rowId: { type: 'string' }, values: ROW_SCHEMA },
            required: ['rowId', 'values'],
            additionalProperties: false,
          },
        },
      },
      required: ['docId', 'updates'],
      additionalProperties: false,
    },
    execute: async ({ docId, databaseId, updates }) =>
      await editDatabase(docId, databaseId, database => ({
        updatedRows: updateRows(
          database,
          updates as { rowId: string; values: RowValues }[]
        ),
      })),
  });

  const removeDatabaseRows = mcpTool('write', 'all', {
    name: 'remove_database_rows',
    title: 'Remove Database Rows',
    description: `Remove rows from a database by row id (from read_database). Removes all of them, or none if any id is not a row of the database. Up to ${MAX_ROWS_PER_CALL} rows per call. The document history keeps the previous version (restore_version brings rows back).`,
    parser: z.object({
      docId: z.string(),
      databaseId: z.string().optional(),
      rowIds: z.array(z.string()).min(1).max(MAX_ROWS_PER_CALL),
    }),
    inputSchema: {
      type: 'object',
      properties: {
        ...DB_PROPS,
        rowIds: { type: 'array', items: { type: 'string' } },
      },
      required: ['docId', 'rowIds'],
      additionalProperties: false,
    },
    execute: async ({ docId, databaseId, rowIds }) =>
      await editDatabase(docId, databaseId, database => ({
        removedRows: removeRows(database, rowIds),
      })),
  });

  const updateDatabaseColumns = mcpTool('write', 'all', {
    name: 'update_database_columns',
    title: 'Update Database Columns',
    description: `Change a database's columns. \`ops\` run in order: \`{op:"add", name, type}\` adds a column at the end; \`{op:"rename", column, name}\`; \`{op:"remove", column}\`; \`{op:"set_type", column, type}\` converts the existing values as the editor does (text to select creates one option per distinct value; values that do not fit the new type are cleared and counted). Types: ${WRITABLE_TYPES.join(', ')}. The title column can be renamed, not removed or retyped. All ops apply, or none.`,
    parser: z.object({
      docId: z.string(),
      databaseId: z.string().optional(),
      ops: z.array(columnOp).min(1).max(MAX_COLUMNS),
    }),
    inputSchema: {
      type: 'object',
      properties: {
        ...DB_PROPS,
        ops: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              op: {
                type: 'string',
                enum: ['add', 'rename', 'remove', 'set_type'],
              },
              column: { type: 'string', description: 'Column name or id' },
              name: { type: 'string', description: 'New name (add, rename)' },
              type: TYPE_SCHEMA,
            },
            required: ['op'],
            additionalProperties: false,
          },
        },
      },
      required: ['docId', 'ops'],
      additionalProperties: false,
    },
    execute: async ({ docId, databaseId, ops }) =>
      await editDatabase(docId, databaseId, database => ({
        columns: applyColumnOps(database, ops as ColumnOp[]),
      })),
  });

  return [
    createDatabase,
    readDatabase,
    addDatabaseRows,
    updateDatabaseRows,
    removeDatabaseRows,
    updateDatabaseColumns,
  ];
}
