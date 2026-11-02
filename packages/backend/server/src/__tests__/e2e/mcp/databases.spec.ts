import * as Y from 'yjs';

import { DocRole } from '../../../models';
import { app, e2e } from '../test';
import { call, callTool, enableMcp, loadYDoc, ownedWorkspace } from './utils';

e2e.before(() => {
  enableMcp();
});

type Block = Y.Map<unknown>;

function blocksOf(ydoc: Y.Doc) {
  return ydoc.getMap<Block>('blocks');
}

function databaseOf(ydoc: Y.Doc) {
  return [...blocksOf(ydoc).values()].find(
    block => block.get('sys:flavour') === 'affine:database'
  );
}

e2e('create_database builds a database the editor can load', async t => {
  const { owner, workspace } = await ownedWorkspace();
  const ws = workspace.id;
  const doc = await call(owner.id, ws, 'create_document', {
    title: 'Target List',
    content: 'Intro',
  });
  const agent = await app.models.workspace.provisionAgent(ws);
  await app.models.docUser.set(ws, doc.docId, agent.id, DocRole.Editor);

  const created = await call(agent.id, ws, 'create_database', {
    docId: doc.docId,
    title: 'Companies',
    columns: ['Exposant', 'Pays', 'Site web'],
    rows: [
      ['2H ENERGY', 'France', 'https://www.2henergy.fr'],
      ['3M', 'France'],
    ],
  });
  t.is(created.rows, 2);
  t.is(created.columns, 3);

  const ydoc = await loadYDoc(ws, doc.docId);
  const blocks = blocksOf(ydoc);
  const database = databaseOf(ydoc)!;
  t.truthy(database);
  t.is(database.get('sys:version'), 3);
  t.is((database.get('prop:title') as Y.Text).toString(), 'Companies');

  // The database sits in the note, after the existing content.
  const note = [...blocks.values()].find(
    block => block.get('sys:flavour') === 'affine:note'
  )!;
  const noteChildren = (note.get('sys:children') as Y.Array<string>).toArray();
  t.is(noteChildren.at(-1), database.get('sys:id') as string);

  // Columns: the built-in title column plus one rich-text column per header.
  const columns = (database.get('prop:columns') as Y.Array<Block>)
    .toArray()
    .map(column => column.toJSON());
  t.deepEqual(
    columns.map(c => [c.type, c.name]),
    [
      ['title', 'Exposant'],
      ['rich-text', 'Pays'],
      ['rich-text', 'Site web'],
    ]
  );
  t.is(columns[0].id, 'title');

  // One table view showing every column, title first.
  const views = (database.get('prop:views') as Y.Array<Block>).toArray();
  t.is(views.length, 1);
  const view = views[0].toJSON();
  t.is(view.mode, 'table');
  t.deepEqual(
    view.columns.map((c: { id: string }) => c.id),
    columns.map(c => c.id)
  );
  t.deepEqual(view.header, { titleColumn: 'title', iconColumn: 'type' });
  t.true(views[0].get('filter') instanceof Y.Map);

  // Rows are paragraphs holding the title; other values are Y.Text cells.
  const rowIds = (database.get('sys:children') as Y.Array<string>).toArray();
  t.deepEqual(
    rowIds.map(id => (blocks.get(id)!.get('prop:text') as Y.Text).toString()),
    ['2H ENERGY', '3M']
  );
  const cells = database.get('prop:cells') as Y.Map<Y.Map<Block>>;
  const site = cells.get(rowIds[0])!.get(columns[2].id)!;
  t.is(site.get('columnId'), columns[2].id);
  t.true(site.get('value') instanceof Y.Text);
  t.is((site.get('value') as Y.Text).toString(), 'https://www.2henergy.fr');
  // An empty value leaves no cell.
  t.false(cells.get(rowIds[1])!.has(columns[2].id));

  // read_document shows a marker; read_database shows the rows.
  const read = await call(agent.id, ws, 'read_document', { docId: doc.docId });
  t.true(
    read.includes(
      `<!-- database id=${created.databaseId} "Companies" (2 rows, 3 columns)`
    )
  );
  t.false(read.includes('2H ENERGY'));
  const rows = await call(agent.id, ws, 'read_database', { docId: doc.docId });
  t.deepEqual(
    rows.rows.map((row: { values: unknown }) => row.values),
    [
      {
        Exposant: '2H ENERGY',
        Pays: 'France',
        'Site web': 'https://www.2henergy.fr',
      },
      { Exposant: '3M', Pays: 'France' },
    ]
  );
});

e2e('an agent edits a database and the text around it', async t => {
  const { owner, workspace } = await ownedWorkspace();
  const ws = workspace.id;
  const doc = await call(owner.id, ws, 'create_document', {
    title: 'Pipeline',
    content: 'Intro',
  });
  const agent = await app.models.workspace.provisionAgent(ws);
  await app.models.docUser.set(ws, doc.docId, agent.id, DocRole.Editor);
  const docId = doc.docId;

  await call(agent.id, ws, 'create_database', {
    docId,
    title: 'Leads',
    columns: ['Company', 'Country', { name: 'Stage', type: 'select' }],
    rows: [
      ['2H ENERGY', 'France', 'Lead'],
      ['3M', 'USA', 'Lead'],
      ['Airbus', 'France'],
    ],
  });
  const read = async (args: Record<string, unknown> = {}) =>
    await call(agent.id, ws, 'read_database', { docId, ...args });
  const ids = (await read()).rows.map((row: { id: string }) => row.id);

  await call(agent.id, ws, 'update_database_rows', {
    docId,
    updates: [{ rowId: ids[2], values: { Stage: 'Won', Country: null } }],
  });
  await call(agent.id, ws, 'add_database_rows', {
    docId,
    rows: [{ Company: 'Safran', Stage: 'lead' }],
  });
  await call(agent.id, ws, 'remove_database_rows', {
    docId,
    rowIds: [ids[1]],
  });
  const columns = await call(agent.id, ws, 'update_database_columns', {
    docId,
    ops: [
      { op: 'set_type', column: 'Country', type: 'select' },
      { op: 'add', name: 'Met', type: 'date' },
    ],
  });
  t.is(columns.columns.length, 2);

  const after = await read();
  t.deepEqual(
    after.columns.map(
      (c: { name: string; type: string }) => `${c.name}:${c.type}`
    ),
    ['Company:title', 'Country:select', 'Stage:select', 'Met:date']
  );
  t.deepEqual(
    after.rows.map((row: { values: unknown }) => row.values),
    [
      { Company: '2H ENERGY', Country: 'France', Stage: 'Lead' },
      { Company: 'Airbus', Stage: 'Won' },
      { Company: 'Safran', Stage: 'Lead' },
    ]
  );
  const found = await read({ search: 'airbus' });
  t.is(found.matchingRows, 1);
  const paged = await read({ limit: 2 });
  t.is(paged.rows.length, 2);
  t.is(paged.nextOffset, 2);

  // update_document edits the text and keeps the database where it was.
  const markdown = await call(agent.id, ws, 'read_document', { docId });
  await call(agent.id, ws, 'update_document', {
    docId,
    content: markdown.replace('Intro', 'New intro') + '\nOutro\n',
  });
  const text = await call(agent.id, ws, 'read_document', { docId });
  t.true(text.startsWith('New intro'));
  t.true(text.indexOf('<!-- database id=') < text.indexOf('Outro'));
  t.is((await read()).rows.length, 3);

  // Dropping the marker line keeps the database too.
  await call(agent.id, ws, 'update_document', {
    docId,
    content: 'Only text\n',
  });
  t.is((await read()).rows.length, 3);
});

e2e('a failed database edit changes nothing', async t => {
  const { owner, workspace } = await ownedWorkspace();
  const ws = workspace.id;
  const doc = await call(owner.id, ws, 'create_document', {
    title: 'D',
    content: 'x',
  });
  const created = await call(owner.id, ws, 'create_database', {
    docId: doc.docId,
    columns: ['Name', { name: 'Staff', type: 'number' }],
    rows: [['a', 1]],
  });
  const [row] = (
    await call(owner.id, ws, 'read_database', { docId: doc.docId })
  ).rows;
  const before = Y.encodeStateVector(await loadYDoc(ws, doc.docId));

  const bad = await callTool(owner.id, ws, 'update_database_rows', {
    docId: doc.docId,
    databaseId: created.databaseId,
    updates: [
      { rowId: row.id, values: { Name: 'renamed' } },
      { rowId: row.id, values: { Staff: 'lots' } },
    ],
  });
  t.true(bad.isError);
  t.regex(bad.text, /Nothing was changed.*Column "Staff"/);
  const missing = await callTool(owner.id, ws, 'remove_database_rows', {
    docId: doc.docId,
    rowIds: [row.id, 'gone'],
  });
  t.true(missing.isError);
  t.deepEqual(Y.encodeStateVector(await loadYDoc(ws, doc.docId)), before);

  // A reader grant may read the database, not change it.
  const agent = await app.models.workspace.provisionAgent(ws);
  await app.models.docUser.set(ws, doc.docId, agent.id, DocRole.Reader);
  t.false(
    (await callTool(agent.id, ws, 'read_database', { docId: doc.docId }))
      .isError
  );
  t.true(
    (
      await callTool(agent.id, ws, 'add_database_rows', {
        docId: doc.docId,
        rows: [{ Name: 'b' }],
      })
    ).isError
  );
});

e2e('create_database needs edit rights and sane input', async t => {
  const { owner, workspace } = await ownedWorkspace();
  const ws = workspace.id;
  const doc = await call(owner.id, ws, 'create_document', {
    title: 'Locked',
    content: 'x',
  });
  const agent = await app.models.workspace.provisionAgent(ws);
  await app.models.docUser.set(ws, doc.docId, agent.id, DocRole.Reader);

  const args = { docId: doc.docId, columns: ['A'], rows: [['1']] };
  t.true((await callTool(agent.id, ws, 'create_database', args)).isError);
  t.true(
    (
      await callTool(owner.id, ws, 'create_database', {
        ...args,
        columns: [],
      })
    ).isError
  );
  t.true(
    (
      await callTool(owner.id, ws, 'create_database', {
        ...args,
        rows: [['1', '2']],
      })
    ).isError
  );
  t.falsy(databaseOf(await loadYDoc(ws, doc.docId)));
});
