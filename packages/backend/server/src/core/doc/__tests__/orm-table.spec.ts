import test from 'ava';
import * as Y from 'yjs';

import {
  fractionalIndexAfterAll,
  fractionalIndexBeforeAll,
  generateFractionalIndexingKeyBetween,
} from '../../utils/fractional-index';
import {
  getOrmRow,
  listOrmRows,
  ORM_DELETED_FLAG,
  softDeleteOrmRow,
  upsertOrmRow,
} from '../orm-table';

test('rows round-trip through an encoded update in the client layout', t => {
  const doc = new Y.Doc();
  upsertOrmRow(doc, 'a', {
    id: 'a',
    parentId: null,
    type: 'folder',
    data: 'Workshops',
    index: 'a0',
    ignored: undefined,
  });

  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));

  // One top-level map per row, keyed by primary key, plain field values.
  const raw = copy.getMap('a');
  t.is(raw.get('data'), 'Workshops');
  t.is(raw.get('parentId'), null);
  t.false(raw.has('ignored'));
  t.deepEqual(getOrmRow(copy, 'a'), {
    id: 'a',
    parentId: null,
    type: 'folder',
    data: 'Workshops',
    index: 'a0',
  });
});

test('soft delete follows the ORM: key kept, fields cleared, flag set', t => {
  const doc = new Y.Doc();
  upsertOrmRow(doc, 'link', { id: 'link', type: 'doc', data: 'd1' });
  upsertOrmRow(doc, 'other', { id: 'other', type: 'doc', data: 'd2' });

  t.true(softDeleteOrmRow(doc, 'link', 'id'));
  const raw = doc.getMap('link');
  t.is(raw.get('id'), 'link');
  t.false(raw.has('data'));
  t.is(raw.get(ORM_DELETED_FLAG), true);

  t.is(getOrmRow(doc, 'link'), null);
  t.deepEqual(
    listOrmRows(doc).map(row => row.id),
    ['other']
  );
  // Deleting again is a no-op, and a missing key is not created.
  t.false(softDeleteOrmRow(doc, 'link', 'id'));
  t.false(softDeleteOrmRow(doc, 'missing', 'id'));
  t.false(doc.share.has('missing'));
});

test('upsert revives a soft-deleted row', t => {
  const doc = new Y.Doc();
  upsertOrmRow(doc, 'fav', { key: 'fav', index: 'a0' });
  softDeleteOrmRow(doc, 'fav', 'key');
  upsertOrmRow(doc, 'fav', { key: 'fav', index: 'a1' });
  t.deepEqual(getOrmRow(doc, 'fav'), { key: 'fav', index: 'a1' });
});

test('an empty row map counts as deleted', t => {
  const doc = new Y.Doc();
  doc.getMap('ghost');
  t.is(getOrmRow(doc, 'ghost'), null);
  t.deepEqual(listOrmRows(doc), []);
});

test('fractional keys carry the client suffix and sort as strings', t => {
  const first = generateFractionalIndexingKeyBetween(null, null);
  t.regex(first, /^[A-Za-z0-9]+0[1-9A-Za-z]{32}$/);

  const after = fractionalIndexAfterAll([first]);
  const before = fractionalIndexBeforeAll([first]);
  const between = generateFractionalIndexingKeyBetween(first, after);

  const sorted = [after, between, first, before].sort();
  t.deepEqual(sorted, [before, first, between, after]);
  t.throws(() => generateFractionalIndexingKeyBetween(after, first));
});
