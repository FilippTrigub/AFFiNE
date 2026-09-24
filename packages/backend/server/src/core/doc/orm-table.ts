import * as Y from 'yjs';

/**
 * Reads and writes rows of a workspace ORM table doc (`db$<ws>$<table>` and
 * `userdata$<uid>$<ws>$<table>`) in the exact layout the client ORM uses
 * (`packages/common/infra/src/orm/core/adapters/yjs/table.ts`):
 *
 * - one Y.Doc per table, one top-level Y.Map per row, keyed by primary key;
 * - fields are plain values;
 * - a row counts as deleted when `$$DELETED === true` or when its map is empty.
 */
export const ORM_DELETED_FLAG = '$$DELETED';

export type OrmRow = Record<string, unknown>;

function isDeleted(row: Y.Map<unknown>) {
  return row.get(ORM_DELETED_FLAG) === true || row.size === 0;
}

function rowToJSON(row: Y.Map<unknown>): OrmRow {
  const out: OrmRow = {};
  for (const [key, value] of row.entries()) {
    if (key === ORM_DELETED_FLAG) continue;
    out[key] = value instanceof Y.AbstractType ? value.toJSON() : value;
  }
  return out;
}

export function listOrmRows(doc: Y.Doc): OrmRow[] {
  const rows: OrmRow[] = [];
  for (const key of Array.from(doc.share.keys())) {
    const row = doc.getMap<unknown>(key);
    if (!isDeleted(row)) rows.push(rowToJSON(row));
  }
  return rows;
}

export function getOrmRow(doc: Y.Doc, key: string): OrmRow | null {
  // Checking `share` first avoids creating an empty map for a missing key.
  if (!doc.share.has(key)) return null;
  const row = doc.getMap<unknown>(key);
  return isDeleted(row) ? null : rowToJSON(row);
}

/**
 * Insert-or-update, matching the ORM's `create`: every field that is not
 * `undefined` is written, and the deleted flag is cleared.
 */
export function upsertOrmRow(doc: Y.Doc, key: string, data: OrmRow) {
  const row = doc.getMap<unknown>(key);
  for (const [field, value] of Object.entries(data)) {
    if (value === undefined) continue;
    row.set(field, value);
  }
  row.delete(ORM_DELETED_FLAG);
}

/**
 * The ORM's delete: every field except the key field is removed and the row is
 * flagged. Used only for rows that can be recreated (folder links, favorites,
 * pins), never for data that would be lost.
 */
export function softDeleteOrmRow(doc: Y.Doc, key: string, keyField: string) {
  if (!doc.share.has(key)) return false;
  const row = doc.getMap<unknown>(key);
  if (isDeleted(row)) return false;
  for (const field of Array.from(row.keys())) {
    if (field !== keyField) row.delete(field);
  }
  row.set(ORM_DELETED_FLAG, true);
  return true;
}

export function workspaceTableDocId(workspaceId: string, table: string) {
  return `db$${workspaceId}$${table}`;
}

export function userdataTableDocId(
  userId: string,
  workspaceId: string,
  table: string
) {
  return `userdata$${userId}$${workspaceId}$${table}`;
}
