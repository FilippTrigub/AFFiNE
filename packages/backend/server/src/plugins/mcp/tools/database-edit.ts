import * as Y from 'yjs';

import {
  type Block,
  type Blocks,
  type CellInput,
  type CellOutput,
  cellsOf,
  childIds,
  type Column,
  columnKeys,
  columnsArray,
  columnsOf,
  DatabaseInputError,
  decodeCell,
  defaultColumnData,
  encodeCell,
  isEmptyOutput,
  newBlock,
  newId,
  outputToText,
  resolveColumn,
  type WritableType,
  yMap,
} from './database-model';

/**
 * Row and column edits on one database block, mirroring the editor's own
 * write paths (`blocks/database/src/utils/block-utils.ts`, `data-source.ts`).
 * Every function runs inside one transaction and throws `DatabaseInputError`
 * before or instead of a partial change, so a call applies all or nothing.
 */

export type RowValues = Record<string, CellInput>;

function blocksOf(database: Block) {
  const doc = database.doc;
  if (!doc) throw new Error('The database is not part of a document.');
  return doc.getMap('blocks') as Blocks;
}

function rowText(block: Block | undefined) {
  const text = block?.get('prop:text');
  return text instanceof Y.Text ? text.toString() : '';
}

// ---------------------------------------------------------------- read

export type RowOutput = { id: string; values: Record<string, CellOutput> };

export function readRows(database: Block) {
  const blocks = blocksOf(database);
  const columns = columnsOf(database);
  const keys = columnKeys(columns);
  const cells = cellsOf(database);
  return childIds(database).map(rowId => {
    const rowCells = cells.get(rowId);
    const values: Record<string, CellOutput> = {};
    for (const column of columns) {
      const value =
        column.type === 'title'
          ? rowText(blocks.get(rowId))
          : decodeCell(column, rowCells?.get(column.id)?.get('value'));
      if (!isEmptyOutput(value))
        values[keys.get(column.id) ?? column.id] = value;
    }
    return { id: rowId, values };
  });
}

export function describeColumns(database: Block) {
  return columnsOf(database).map(column => {
    const info: Record<string, unknown> = {
      id: column.id,
      name: column.name,
      type: column.type,
    };
    if (column.type === 'select' || column.type === 'multi-select') {
      const options = column.data.get('options');
      info.options =
        options instanceof Y.Array
          ? (options.toArray() as unknown[]).map(option =>
              option instanceof Y.Map ? String(option.get('value')) : ''
            )
          : [];
    }
    return info;
  });
}

// ---------------------------------------------------------------- cells

function setTitle(blocks: Blocks, rowId: string, input: CellInput) {
  const block = blocks.get(rowId);
  if (!block) throw new DatabaseInputError(`Row ${rowId} has no block.`);
  const value =
    input === null
      ? ''
      : Array.isArray(input)
        ? input.join(', ')
        : String(input);
  const text = block.get('prop:text');
  if (text instanceof Y.Text) {
    if (text.toString() === value) return;
    text.delete(0, text.length);
    text.insert(0, value);
  } else {
    block.set('prop:text', new Y.Text(value));
  }
}

function setCell(
  database: Block,
  rowId: string,
  column: Column,
  value: unknown
) {
  const cells = cellsOf(database);
  let row = cells.get(rowId);
  if (value === undefined) {
    row?.delete(column.id);
    return;
  }
  if (!row) {
    row = new Y.Map();
    cells.set(rowId, row);
  }
  row.set(column.id, yMap({ columnId: column.id, value }));
}

/** Resolve every column and encode every value before anything is written. */
function planValues(database: Block, values: RowValues) {
  const columns = columnsOf(database);
  return Object.entries(values).map(([key, input]) => {
    const column = resolveColumn(columns, key);
    const value =
      column.type === 'title' ? input : encodeCell(column, input ?? null);
    return { column, input, value };
  });
}

function writeValues(
  database: Block,
  rowId: string,
  planned: ReturnType<typeof planValues>
) {
  const blocks = blocksOf(database);
  for (const { column, input, value } of planned) {
    if (column.type === 'title') setTitle(blocks, rowId, input ?? null);
    else setCell(database, rowId, column, value);
  }
}

function withRow<T>(index: number, rowId: string | undefined, fn: () => T) {
  try {
    return fn();
  } catch (error) {
    if (error instanceof DatabaseInputError) {
      throw new DatabaseInputError(
        `${rowId ? `Row ${rowId}` : `Row ${index + 1}`}: ${error.message}`
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------- rows

export function addRows(database: Block, rows: RowValues[]) {
  const blocks = blocksOf(database);
  // Encoding may add select options; that is fine to keep only because a
  // failure throws and the whole transaction is discarded by the caller.
  const planned = rows.map((values, i) =>
    withRow(i, undefined, () => planValues(database, values))
  );
  const ids = planned.map(plan => {
    const rowId = newId();
    const paragraph = newBlock(rowId, 'affine:paragraph', 1);
    paragraph.set('prop:type', 'text');
    paragraph.set('prop:text', new Y.Text());
    paragraph.set('prop:collapsed', false);
    blocks.set(rowId, paragraph);
    cellsOf(database).set(rowId, new Y.Map<Block>());
    writeValues(database, rowId, plan);
    return rowId;
  });
  (database.get('sys:children') as Y.Array<string>).push(ids);
  return ids;
}

function assertRows(database: Block, rowIds: string[]) {
  const rows = new Set(childIds(database));
  const missing = rowIds.filter(id => !rows.has(id));
  if (missing.length) {
    throw new DatabaseInputError(
      `Not rows of this database: ${missing.join(', ')}. Read it again with read_database.`
    );
  }
}

export function updateRows(
  database: Block,
  updates: { rowId: string; values: RowValues }[]
) {
  assertRows(
    database,
    updates.map(u => u.rowId)
  );
  const planned = updates.map((update, i) =>
    withRow(i, update.rowId, () => planValues(database, update.values))
  );
  planned.forEach((plan, i) => writeValues(database, updates[i].rowId, plan));
  return updates.length;
}

function deleteSubtree(blocks: Blocks, id: string) {
  for (const child of childIds(blocks.get(id))) deleteSubtree(blocks, child);
  blocks.delete(id);
}

export function removeRows(database: Block, rowIds: string[]) {
  const unique = [...new Set(rowIds)];
  assertRows(database, unique);
  const blocks = blocksOf(database);
  const children = database.get('sys:children') as Y.Array<string>;
  const doomed = new Set(unique);
  const ids = children.toArray();
  for (let i = ids.length - 1; i >= 0; i--) {
    if (doomed.has(ids[i])) children.delete(i, 1);
  }
  const cells = cellsOf(database);
  for (const id of unique) {
    deleteSubtree(blocks, id);
    cells.delete(id);
  }
  return unique.length;
}

// ---------------------------------------------------------------- columns

export type ColumnOp =
  | { op: 'add'; name: string; type: WritableType }
  | { op: 'rename'; column: string; name: string }
  | { op: 'remove'; column: string }
  | { op: 'set_type'; column: string; type: WritableType };

function assertNewName(columns: Column[], name: string, except?: Column) {
  const taken = columns.find(
    c => c !== except && c.name.toLowerCase() === name.toLowerCase()
  );
  if (taken) {
    throw new DatabaseInputError(`A column named "${taken.name}" exists.`);
  }
}

function editable(columns: Column[], key: string, what: string) {
  const column = resolveColumn(columns, key);
  if (column.type === 'title') {
    throw new DatabaseInputError(`The title column cannot be ${what}.`);
  }
  return column;
}

function convertInput(from: string, to: string, value: CellOutput): CellInput {
  // The editor writes "Yes" / "No" for every row when a checkbox becomes text.
  if (from === 'checkbox') {
    if (to === 'rich-text' || to === 'link')
      return value === true ? 'Yes' : 'No';
    return value === true ? 'yes' : null;
  }
  if (Array.isArray(value) && to === 'multi-select') return value;
  return isEmptyOutput(value) ? null : outputToText(value);
}

/** Convert every value of a column, as the editor's converters do. */
function setType(database: Block, column: Column, type: WritableType) {
  if (column.type === type) return 0;
  const cells = cellsOf(database);
  const before = childIds(database).map(rowId => ({
    rowId,
    value: decodeCell(column, cells.get(rowId)?.get(column.id)?.get('value')),
  }));
  const data = defaultColumnData(type);
  column.map.set('type', type);
  column.map.set('data', data);
  const converted: Column = { ...column, type, data };
  let lost = 0;
  for (const { rowId, value } of before) {
    const next = encodeCell(
      converted,
      convertInput(column.type, type, value),
      true
    );
    if (next === undefined && !isEmptyOutput(value) && type !== 'checkbox') {
      lost++;
    }
    setCell(database, rowId, converted, next);
  }
  return lost;
}

export function applyColumnOps(database: Block, ops: ColumnOp[]) {
  const results: Record<string, unknown>[] = [];
  for (const op of ops) {
    const columns = columnsOf(database);
    const array = columnsArray(database);
    switch (op.op) {
      case 'add': {
        assertNewName(columns, op.name);
        const id = newId();
        array.push([
          yMap({
            id,
            type: op.type,
            name: op.name,
            data: defaultColumnData(op.type),
          }),
        ]);
        results.push({ op: 'add', id, name: op.name, type: op.type });
        break;
      }
      case 'rename': {
        const column = resolveColumn(columns, op.column);
        assertNewName(columns, op.name, column);
        if (column.virtual) {
          // Stored on first change, as the editor's updateProperty does.
          array.insert(0, [
            yMap({
              id: column.id,
              type: 'title',
              name: op.name,
              data: new Y.Map(),
            }),
          ]);
        } else {
          column.map.set('name', op.name);
        }
        results.push({ op: 'rename', id: column.id, name: op.name });
        break;
      }
      case 'remove': {
        const column = editable(columns, op.column, 'removed');
        array.delete(array.toArray().indexOf(column.map), 1);
        results.push({ op: 'remove', id: column.id, name: column.name });
        break;
      }
      case 'set_type': {
        const column = editable(columns, op.column, 'retyped');
        const from = column.type;
        const lost = setType(database, column, op.type);
        results.push({
          op: 'set_type',
          id: column.id,
          name: column.name,
          from,
          to: op.type,
          valuesThatDidNotConvert: lost,
        });
        break;
      }
    }
  }
  return results;
}
