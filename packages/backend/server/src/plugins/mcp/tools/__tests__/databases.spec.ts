import test from 'ava';
import * as Y from 'yjs';

import { blockSentinel } from '../../../../core/doc/preserve-blocks';
import { createDocWithMarkdown } from '../../../../native';
import {
  addRows,
  applyColumnOps,
  describeColumns,
  readRows,
  removeRows,
  updateRows,
} from '../database-edit';
import {
  markdownWithDatabaseMarkers,
  markersToSentinels,
} from '../database-markdown';
import {
  type Block,
  DatabaseInputError,
  findDatabases,
  resolveDatabase,
} from '../database-model';
import { appendDatabase, type DatabaseSpec } from '../databases';

const DOC_ID = 'database-doc';

function docWith(spec: DatabaseSpec, body = 'Intro\n\nOutro\n') {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, createDocWithMarkdown('T', body, DOC_ID));
  let id = '';
  doc.transact(() => {
    id = appendDatabase(doc, spec).databaseId;
  });
  return { doc, database: resolveDatabase(doc, id).block };
}

function edit<T>(database: Block, fn: (db: Block) => T) {
  let result!: T;
  database.doc!.transact(() => {
    result = fn(database);
  });
  return result;
}

const SPEC: DatabaseSpec = {
  title: 'Companies',
  columns: [
    'Name',
    'Country',
    { name: 'Staff', type: 'number' },
    { name: 'Status', type: 'select' },
    { name: 'Tags', type: 'multi-select' },
    { name: 'Met', type: 'date' },
    { name: 'Active', type: 'checkbox' },
  ],
  rows: [
    [
      '2H ENERGY',
      'France',
      '120',
      'Lead',
      ['drones', 'energy'],
      '2026-11-02',
      true,
    ],
    ['3M', 'USA', 90000, 'lead', 'energy', null, 'no'],
  ],
};

function cell(database: Block, rowId: string, columnName: string) {
  const column = (database.get('prop:columns') as Y.Array<Block>)
    .toArray()
    .find(c => c.get('name') === columnName)!;
  const cells = database.get('prop:cells') as Y.Map<Y.Map<Block>>;
  return cells
    .get(rowId)
    ?.get(column.get('id') as string)
    ?.get('value');
}

test('typed columns store values in the editor layout', t => {
  const { database } = docWith(SPEC);
  const [first, second] = (
    database.get('sys:children') as Y.Array<string>
  ).toArray();

  t.true(cell(database, first, 'Country') instanceof Y.Text);
  t.is(cell(database, first, 'Staff'), 120);
  t.is(cell(database, second, 'Staff'), 90000);
  t.is(cell(database, first, 'Met'), Date.parse('2026-11-02'));
  t.is(cell(database, first, 'Active'), true);
  t.is(cell(database, second, 'Active'), undefined);

  // "Lead" and "lead" share one option; ids, not labels, are stored.
  const status = describeColumns(database).find(c => c.name === 'Status')!;
  t.deepEqual(status.options, ['Lead']);
  t.is(cell(database, first, 'Status'), cell(database, second, 'Status'));
  const tags = cell(database, first, 'Tags');
  t.true(tags instanceof Y.Array);
  t.is((tags as Y.Array<string>).length, 2);

  const option = (
    (database.get('prop:columns') as Y.Array<Block>)
      .toArray()
      .find(c => c.get('name') === 'Status')!
      .get('data') as Y.Map<Y.Array<Block>>
  )
    .get('options')!
    .get(0);
  t.regex(option.get('color') as string, /^var\(--affine-v2-chip-label-/);
});

test('rows read back as the agent wrote them, empty values left out', t => {
  const { database } = docWith(SPEC);
  const rows = readRows(database);
  t.deepEqual(rows[0].values, {
    Name: '2H ENERGY',
    Country: 'France',
    Staff: 120,
    Status: 'Lead',
    Tags: ['drones', 'energy'],
    Met: '2026-11-02',
    Active: true,
  });
  t.deepEqual(rows[1].values, {
    Name: '3M',
    Country: 'USA',
    Staff: 90000,
    Status: 'Lead',
    Tags: ['energy'],
  });
});

test('a bad value is refused with the row and column named', t => {
  t.throws(
    () =>
      docWith({
        ...SPEC,
        rows: [['x', 'y', 'many']],
      }),
    { instanceOf: DatabaseInputError, message: /Row 1: Column "Staff"/ }
  );
});

test('update changes only the given cells and edits the title in place', t => {
  const { doc, database } = docWith(SPEC);
  const [first, second] = readRows(database).map(row => row.id);
  const blocks = doc.getMap('blocks') as Y.Map<Block>;
  const titleText = blocks.get(first)!.get('prop:text');

  edit(database, db =>
    updateRows(db, [
      {
        rowId: first,
        values: { name: '2H Energy SAS', Status: 'Won', Tags: null },
      },
      { rowId: second, values: { Staff: '91000' } },
    ])
  );
  t.is(blocks.get(first)!.get('prop:text'), titleText);
  const rows = readRows(database);
  t.is(rows[0].values.Name, '2H Energy SAS');
  t.is(rows[0].values.Status, 'Won');
  t.false('Tags' in rows[0].values);
  t.is(rows[0].values.Country, 'France');
  t.is(rows[1].values.Staff, 91000);
  t.deepEqual(
    describeColumns(database).find(c => c.name === 'Status')!.options,
    ['Lead', 'Won']
  );
});

test('update refuses unknown rows and columns', t => {
  const { database } = docWith(SPEC);
  const [first] = readRows(database).map(row => row.id);
  t.throws(
    () => edit(database, db => updateRows(db, [{ rowId: 'nope', values: {} }])),
    {
      instanceOf: DatabaseInputError,
      message: /Not rows of this database: nope/,
    }
  );
  t.throws(
    () =>
      edit(database, db =>
        updateRows(db, [{ rowId: first, values: { Revenue: 1 } }])
      ),
    { instanceOf: DatabaseInputError, message: /Unknown column "Revenue"/ }
  );
});

test('add appends rows; delete removes rows, blocks and cells', t => {
  const { doc, database } = docWith(SPEC);
  const [added] = edit(database, db =>
    addRows(db, [{ Name: 'Airbus', Staff: 1000 }])
  );
  const blocks = doc.getMap('blocks') as Y.Map<Block>;
  t.is(readRows(database).at(-1)!.id, added);
  t.is(blocks.get(added)!.get('sys:flavour'), 'affine:paragraph');

  const [first] = readRows(database).map(row => row.id);
  t.is(
    edit(database, db => removeRows(db, [first, first])),
    1
  );
  t.false(blocks.has(first));
  t.false((database.get('prop:cells') as Y.Map<unknown>).has(first));
  t.deepEqual(
    readRows(database).map(row => row.values.Name),
    ['3M', 'Airbus']
  );
  t.throws(() => edit(database, db => removeRows(db, ['gone'])), {
    instanceOf: DatabaseInputError,
  });
});

test('column ops: add, rename, delete; the title column is protected', t => {
  const { database } = docWith(SPEC);
  const results = edit(database, db =>
    applyColumnOps(db, [
      { op: 'add', name: 'Website', type: 'link' },
      { op: 'rename', column: 'Country', name: 'Pays' },
      { op: 'remove', column: 'Tags' },
      { op: 'rename', column: 'title', name: 'Exposant' },
    ])
  );
  t.is(results.length, 4);
  t.deepEqual(
    describeColumns(database).map(c => `${c.name}:${c.type}`),
    [
      'Exposant:title',
      'Pays:rich-text',
      'Staff:number',
      'Status:select',
      'Met:date',
      'Active:checkbox',
      'Website:link',
    ]
  );
  for (const op of [
    { op: 'remove' as const, column: 'Exposant' },
    { op: 'set_type' as const, column: 'title', type: 'number' as const },
    { op: 'add' as const, name: 'pays', type: 'rich-text' as const },
  ]) {
    t.throws(() => edit(database, db => applyColumnOps(db, [op])), {
      instanceOf: DatabaseInputError,
    });
  }
});

test('set_type converts values as the editor does', t => {
  const { database } = docWith({
    title: 'D',
    columns: ['Name', 'Phase', 'Size', 'Flag', 'Kind'],
    rows: [
      ['a', 'Lead, Hot', '12 people', 'yes', 'x'],
      ['b', 'Won', 'unknown', 'no', ''],
      ['c', 'Lead', '', '', 'y'],
    ],
  });
  const results = edit(database, db =>
    applyColumnOps(db, [
      { op: 'set_type', column: 'Phase', type: 'select' },
      { op: 'set_type', column: 'Size', type: 'number' },
      { op: 'set_type', column: 'Flag', type: 'checkbox' },
      { op: 'set_type', column: 'Kind', type: 'multi-select' },
    ])
  );
  t.is(results[1].valuesThatDidNotConvert, 1);
  const rows = readRows(database).map(row => row.values);
  // Text to select keeps the first comma-separated value.
  t.deepEqual(
    rows.map(r => r.Phase),
    ['Lead', 'Won', 'Lead']
  );
  t.deepEqual(
    describeColumns(database).find(c => c.name === 'Phase')!.options,
    ['Lead', 'Won']
  );
  t.deepEqual(
    rows.map(r => r.Size),
    [12, undefined, undefined]
  );
  t.deepEqual(
    rows.map(r => r.Flag),
    [true, undefined, undefined]
  );
  t.deepEqual(
    rows.map(r => r.Kind),
    [['x'], undefined, ['y']]
  );

  edit(database, db =>
    applyColumnOps(db, [
      { op: 'set_type', column: 'Phase', type: 'multi-select' },
      { op: 'set_type', column: 'Flag', type: 'rich-text' },
    ])
  );
  const after = readRows(database).map(row => row.values);
  t.deepEqual(after[0].Phase, ['Lead']);
  t.deepEqual(
    after.map(r => r.Flag),
    ['Yes', 'No', 'No']
  );
});

test('read_document markdown shows a marker where each database is', t => {
  const { doc } = docWith(SPEC);
  const content = markdownWithDatabaseMarkers('ws', DOC_ID, doc)!;
  const [db] = findDatabases(doc);
  t.false(content.markdown.includes('2H ENERGY'));
  t.false(content.markdown.includes('|'));
  const lines = content.markdown.split('\n').filter(Boolean);
  t.deepEqual(lines.slice(0, 2), ['Intro', 'Outro']);
  t.true(
    lines[2].startsWith(
      `<!-- database id=${db.id} "Companies" (2 rows, 7 columns)`
    )
  );
  // The doc itself is untouched.
  t.is(readRows(db.block).length, 2);

  t.is(
    markersToSentinels(`Intro\n${lines[2]}\nOutro\n`),
    `Intro\n\n${blockSentinel(db.id)}\n\nOutro\n`
  );
  t.is(markdownWithDatabaseMarkers('ws', DOC_ID, docWithout()), null);
});

function docWithout() {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, createDocWithMarkdown('T', 'Plain\n', DOC_ID));
  return doc;
}

/** A database as the editor makes it: no columns stored, Title is implied. */
function editorDatabase() {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, createDocWithMarkdown('T', 'Intro\n', DOC_ID));
  const blocks = doc.getMap('blocks') as Y.Map<Block>;
  const note = [...blocks.values()].find(
    b => b.get('sys:flavour') === 'affine:note'
  )!;
  doc.transact(() => {
    const db = new Y.Map<unknown>();
    db.set('sys:id', 'db');
    db.set('sys:flavour', 'affine:database');
    db.set('sys:version', 3);
    db.set('sys:children', Y.Array.from(['r1']));
    db.set('prop:title', new Y.Text('Guests'));
    db.set('prop:columns', new Y.Array());
    db.set('prop:views', new Y.Array());
    db.set('prop:cells', new Y.Map());
    blocks.set('db', db);
    const row = new Y.Map<unknown>();
    row.set('sys:id', 'r1');
    row.set('sys:flavour', 'affine:paragraph');
    row.set('sys:children', new Y.Array());
    row.set('prop:type', 'text');
    row.set('prop:text', new Y.Text('Alice'));
    blocks.set('r1', row);
    (note.get('sys:children') as Y.Array<string>).push(['db']);
  });
  return resolveDatabase(doc, 'db').block;
}

test('an editor-made database has its implied Title column', t => {
  const database = editorDatabase();
  t.deepEqual(describeColumns(database), [
    { id: 'title', name: 'Title', type: 'title' },
  ]);
  t.deepEqual(readRows(database)[0].values, { Title: 'Alice' });

  edit(database, db => {
    addRows(db, [{ Title: 'Bob' }]);
    applyColumnOps(db, [
      { op: 'add', name: 'Met', type: 'date' },
      { op: 'rename', column: 'Title', name: 'Guest' },
    ]);
  });
  t.deepEqual(
    readRows(database).map(row => row.values.Guest),
    ['Alice', 'Bob']
  );
  const stored = (database.get('prop:columns') as Y.Array<Block>)
    .toArray()
    .map(c => `${c.get('id')}:${c.get('type')}:${c.get('name')}`);
  t.is(stored[0], 'title:title:Guest');
  t.is(stored.length, 2);
  t.throws(
    () =>
      edit(database, db =>
        applyColumnOps(db, [{ op: 'remove', column: 'Guest' }])
      ),
    {
      instanceOf: DatabaseInputError,
    }
  );
});

test('dates read as the calendar day the editor shows', t => {
  const database = editorDatabase();
  const [met] = edit(database, db =>
    applyColumnOps(db, [{ op: 'add', name: 'Met', type: 'date' }])
  );
  const cells = database.get('prop:cells') as Y.Map<Y.Map<unknown>>;
  edit(database, () => {
    const row = new Y.Map<unknown>();
    // Local midnight in Paris (UTC+1), as the editor's date picker stores it.
    const cell = new Y.Map<unknown>();
    cell.set('columnId', met.id);
    cell.set('value', Date.UTC(2026, 10, 1, 23));
    row.set(met.id as string, cell);
    cells.set('r1', row);
  });
  t.is(readRows(database)[0].values.Met, '2026-11-02');
  edit(database, db =>
    updateRows(db, [{ rowId: 'r1', values: { Met: '2026-12-24' } }])
  );
  t.is(readRows(database)[0].values.Met, '2026-12-24');
});
