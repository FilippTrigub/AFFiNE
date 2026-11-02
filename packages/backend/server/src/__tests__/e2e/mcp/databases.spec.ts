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

  // The reader renders it, so the agent can read back what it wrote.
  const read = await call(agent.id, ws, 'read_document', { docId: doc.docId });
  t.true(read.includes('2H ENERGY'));
  t.true(read.includes('https://www.2henergy.fr'));
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
