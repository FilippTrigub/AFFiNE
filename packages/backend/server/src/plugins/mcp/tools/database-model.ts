import { nanoid } from 'nanoid';
import * as Y from 'yjs';

/**
 * Reading and writing database blocks in the editor's own Yjs layout
 * (`blocksuite/affine/model/src/blocks/database`, schema version 3, and the
 * property presets in `blocksuite/affine/data-view` and
 * `blocksuite/affine/blocks/database/src/properties`):
 *
 * - `prop:columns`: Y.Array of Y.Map `{id, type, name, data: Y.Map}`; the
 *   built-in `title` column's values are the row paragraphs' text.
 * - `prop:cells`: Y.Map rowId -> Y.Map columnId -> Y.Map `{columnId, value}`.
 * - Rows are the database's paragraph (or list) children.
 *
 * Cell values per column type: rich-text Y.Text; number and progress (0-100)
 * number; checkbox boolean; date milliseconds; link string; select an option
 * id; multi-select a Y.Array of option ids. Options live in the column's
 * `data.options` as Y.Map `{id, value, color}`.
 */

export type Block = Y.Map<unknown>;
export type Blocks = Y.Map<Block>;

export const TITLE_COLUMN = 'title';
const DATABASE = 'affine:database';

/** Column types MCP can create and write. Others are read as they are. */
export const WRITABLE_TYPES = [
  'rich-text',
  'number',
  'progress',
  'checkbox',
  'date',
  'link',
  'select',
  'multi-select',
] as const;
export type WritableType = (typeof WRITABLE_TYPES)[number];

/** The editor's select tag palette (`data-view/.../tags/colors.ts`). */
const TAG_COLORS = [
  'red',
  'magenta',
  'orange',
  'yellow',
  'green',
  'teal',
  'blue',
  'purple',
  'grey',
  'white',
].map(name => `var(--affine-v2-chip-label-${name})`);

export class DatabaseInputError extends Error {}

export function yMap(entries: Record<string, unknown>) {
  const map = new Y.Map<unknown>();
  for (const [key, value] of Object.entries(entries)) map.set(key, value);
  return map;
}

export function yArray(items: unknown[]) {
  const array = new Y.Array<unknown>();
  array.push(items);
  return array;
}

export function childIds(block: Block | undefined) {
  const children = block?.get('sys:children');
  return children instanceof Y.Array ? (children.toArray() as string[]) : [];
}

export function newBlock(id: string, flavour: string, version: number) {
  return yMap({
    'sys:id': id,
    'sys:flavour': flavour,
    'sys:version': version,
    'sys:children': new Y.Array<string>(),
  });
}

/** Default `data` of a new column, as the editor's property presets create it. */
export function defaultColumnData(type: string) {
  if (type === 'select' || type === 'multi-select') {
    return yMap({ options: new Y.Array() });
  }
  if (type === 'number') return yMap({ decimal: 0, format: 'number' });
  return new Y.Map();
}

export function newId() {
  return nanoid(10);
}

// ---------------------------------------------------------------- lookup

export type DatabaseRef = { id: string; block: Block; title: string };

/** Every database in the doc, in document order. */
export function findDatabases(doc: Y.Doc): DatabaseRef[] {
  const blocks = doc.getMap('blocks') as Blocks;
  const found: DatabaseRef[] = [];
  const seen = new Set<string>();
  const walk = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const block = blocks.get(id);
    if (!block) return;
    if (block.get('sys:flavour') === DATABASE) {
      found.push({ id, block, title: textOf(block.get('prop:title')) });
      return;
    }
    childIds(block).forEach(walk);
  };
  for (const [id, block] of blocks) {
    if (block.get('sys:flavour') === 'affine:page') walk(id);
  }
  return found;
}

/** The database named by id, or the only one in the doc when no id is given. */
export function resolveDatabase(doc: Y.Doc, databaseId?: string) {
  const databases = findDatabases(doc);
  if (databaseId) {
    const found = databases.find(db => db.id === databaseId);
    if (!found) {
      throw new DatabaseInputError(
        `Database ${databaseId} not found in this document.`
      );
    }
    return found;
  }
  if (databases.length === 1) return databases[0];
  if (!databases.length) {
    throw new DatabaseInputError('This document has no database.');
  }
  throw new DatabaseInputError(
    `This document has ${databases.length} databases; pass databaseId (${databases
      .map(db => `${db.id} "${db.title}"`)
      .join(', ')}).`
  );
}

export type Column = {
  id: string;
  type: string;
  name: string;
  map: Block;
  data: Y.Map<unknown>;
  /** The editor's built-in Title, not (yet) stored in `prop:columns`. */
  virtual?: boolean;
};

/** `prop:columns`, created when the block has none yet. */
export function columnsArray(database: Block) {
  let columns = database.get('prop:columns');
  if (!(columns instanceof Y.Array)) {
    columns = new Y.Array();
    database.set('prop:columns', columns);
  }
  return columns as Y.Array<unknown>;
}

/**
 * The database's columns, title first. The editor treats Title as a fixed
 * column: a database made in the editor starts with no columns stored, and
 * Title (id `title`, named "Title") is only stored once someone changes it
 * (`data-source.ts`, `properties$`). So it is added here when missing.
 */
export function columnsOf(database: Block): Column[] {
  const stored = database.get('prop:columns');
  const columns = (stored instanceof Y.Array ? stored.toArray() : [])
    .filter((c): c is Block => c instanceof Y.Map)
    .map(map => {
      let data = map.get('data');
      if (!(data instanceof Y.Map)) data = new Y.Map();
      return {
        id: String(map.get('id')),
        type: String(map.get('type')),
        name: String(map.get('name') ?? ''),
        map,
        data: data as Y.Map<unknown>,
      };
    });
  if (columns.some(c => c.type === 'title')) return columns;
  return [
    {
      id: TITLE_COLUMN,
      type: 'title',
      name: 'Title',
      map: new Y.Map(),
      data: new Y.Map(),
      virtual: true,
    },
    ...columns,
  ];
}

/** A column by id, exact name, or case-insensitive name; never ambiguous. */
export function resolveColumn(columns: Column[], key: string) {
  const byId = columns.find(c => c.id === key);
  if (byId) return byId;
  for (const match of [
    (c: Column) => c.name === key,
    (c: Column) => c.name.toLowerCase() === key.toLowerCase(),
  ]) {
    const found = columns.filter(match);
    if (found.length === 1) return found[0];
    if (found.length > 1) {
      throw new DatabaseInputError(
        `Several columns are named "${key}"; use the column id (${found
          .map(c => c.id)
          .join(', ')}).`
      );
    }
  }
  throw new DatabaseInputError(
    `Unknown column "${key}". Columns: ${columns.map(c => c.name).join(', ')}.`
  );
}

/** Keys rows are reported under: the column name, or its id when shared. */
export function columnKeys(columns: Column[]) {
  const counts = new Map<string, number>();
  for (const c of columns) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
  return new Map(
    columns.map(c => [c.id, (counts.get(c.name) ?? 0) > 1 ? c.id : c.name])
  );
}

export function cellsOf(database: Block) {
  let cells = database.get('prop:cells');
  if (!(cells instanceof Y.Map)) {
    cells = new Y.Map();
    database.set('prop:cells', cells);
  }
  return cells as Y.Map<Y.Map<Block>>;
}

// ---------------------------------------------------------------- options

type Option = { id: string; value: string };

function optionsArray(column: Column) {
  let options = column.data.get('options');
  if (!(options instanceof Y.Array)) {
    options = new Y.Array();
    column.data.set('options', options);
  }
  return options as Y.Array<unknown>;
}

export function optionsOf(column: Column): Option[] {
  const options = column.data.get('options');
  if (!(options instanceof Y.Array)) return [];
  return (options.toArray() as unknown[]).flatMap(option => {
    const json =
      option instanceof Y.Map
        ? (option.toJSON() as Record<string, unknown>)
        : option;
    if (!json || typeof json !== 'object') return [];
    const { id, value } = json as Record<string, unknown>;
    return typeof id === 'string' ? [{ id, value: String(value ?? '') }] : [];
  });
}

/** The id of the option with this label, created (as the editor does) if new. */
function optionId(column: Column, label: string) {
  const options = optionsOf(column);
  const found =
    options.find(o => o.value === label) ??
    options.find(o => o.value.toLowerCase() === label.toLowerCase());
  if (found) return found.id;
  const id = nanoid();
  const array = optionsArray(column);
  array.push([
    yMap({
      id,
      value: label,
      color: TAG_COLORS[array.length % TAG_COLORS.length],
    }),
  ]);
  return id;
}

// ---------------------------------------------------------------- values

export type CellInput = string | number | boolean | null | string[];
export type CellOutput = string | number | boolean | string[] | null;

function textOf(value: unknown) {
  if (value instanceof Y.Text) return value.toString();
  if (typeof value === 'string') return value;
  return '';
}

function labelsOf(value: unknown) {
  if (value instanceof Y.Array) return value.toArray() as unknown[];
  return Array.isArray(value) ? (value as unknown[]) : [];
}

/** A stored cell value as the agent sees it. */
export function decodeCell(column: Column, value: unknown): CellOutput {
  switch (column.type) {
    case 'rich-text':
    case 'link':
      return textOf(value);
    case 'number':
    case 'progress':
      return typeof value === 'number' ? value : null;
    case 'checkbox':
      return value === true;
    case 'date':
      // The editor stores local midnight (23:00 UTC the day before, in
      // Paris); the nearest UTC midnight is the calendar day it shows.
      return typeof value === 'number' && Number.isFinite(value)
        ? new Date(Math.round(value / DAY) * DAY).toISOString().slice(0, 10)
        : null;
    case 'select': {
      const option = optionsOf(column).find(o => o.id === value);
      return option ? option.value : null;
    }
    case 'multi-select': {
      const options = new Map(optionsOf(column).map(o => [o.id, o.value]));
      return labelsOf(value).flatMap(id => {
        const label = options.get(String(id));
        return label === undefined ? [] : [label];
      });
    }
    default: {
      if (value instanceof Y.Text) return value.toString();
      if (value instanceof Y.AbstractType) {
        return JSON.stringify(value.toJSON());
      }
      if (value === undefined) return null;
      return typeof value === 'object'
        ? JSON.stringify(value)
        : (value as CellOutput);
    }
  }
}

export function isEmptyOutput(value: CellOutput) {
  return (
    value === null ||
    value === '' ||
    value === false ||
    (Array.isArray(value) && !value.length)
  );
}

/** Plain text for a value, as the editor shows it in a text column. */
export function outputToText(value: CellOutput) {
  if (value === null) return '';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

function fail(column: Column, message: string): never {
  throw new DatabaseInputError(`Column "${column.name}": ${message}`);
}

function asText(column: Column, input: CellInput) {
  if (Array.isArray(input)) return input.join(', ');
  if (typeof input === 'string') return input;
  if (typeof input === 'number' || typeof input === 'boolean') {
    return String(input);
  }
  return fail(column, 'expected text');
}

function asNumber(column: Column, input: CellInput, lenient: boolean) {
  if (typeof input === 'number' && Number.isFinite(input)) return input;
  if (typeof input === 'string' && input.trim()) {
    const text = input.trim();
    const parsed = lenient ? parseFloat(text) : Number(text);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (lenient) return undefined;
  return fail(column, `"${String(input)}" is not a number`);
}

const DAY = 24 * 60 * 60 * 1000;

const TRUE = new Set(['true', 'yes', '1', 'x', 'checked']);
const FALSE = new Set(['false', 'no', '0', '', 'unchecked']);

/**
 * The value to store for an input, or `undefined` to leave the cell empty.
 * `lenient` is for converting a whole column: a value that does not fit
 * becomes empty instead of failing, as the editor's converters do.
 */
export function encodeCell(
  column: Column,
  input: CellInput,
  lenient = false
): unknown {
  if (input === null) return undefined;
  switch (column.type) {
    case 'rich-text': {
      const text = asText(column, input);
      return text ? new Y.Text(text) : undefined;
    }
    case 'link':
      return asText(column, input) || undefined;
    case 'number':
      return asNumber(column, input, lenient);
    case 'progress': {
      const value = asNumber(column, input, lenient);
      if (value === undefined) return undefined;
      if (lenient) return Math.min(100, Math.max(0, Math.round(value)));
      if (value < 0 || value > 100) fail(column, 'progress is 0 to 100');
      return Math.round(value);
    }
    case 'checkbox': {
      if (typeof input === 'boolean') return input || undefined;
      const text = asText(column, input).trim().toLowerCase();
      if (TRUE.has(text)) return true;
      if (FALSE.has(text) || lenient) return undefined;
      return fail(column, `"${text}" is not yes or no`);
    }
    case 'date': {
      if (typeof input === 'number' && Number.isFinite(input)) return input;
      const text = asText(column, input).trim();
      if (!text) return undefined;
      const time = Date.parse(text);
      if (Number.isFinite(time)) return time;
      if (lenient) return undefined;
      return fail(column, `"${text}" is not a date (use YYYY-MM-DD)`);
    }
    case 'select': {
      const label = (
        Array.isArray(input)
          ? (input[0] ?? '')
          : asText(column, input).split(',')[0]
      ).trim();
      return label ? optionId(column, label) : undefined;
    }
    case 'multi-select': {
      const labels = (
        Array.isArray(input) ? input : asText(column, input).split(',')
      )
        .map(label => String(label).trim())
        .filter(Boolean);
      if (!labels.length) return undefined;
      return yArray([...new Set(labels.map(label => optionId(column, label)))]);
    }
    default:
      return fail(column, `${column.type} columns cannot be written over MCP`);
  }
}
