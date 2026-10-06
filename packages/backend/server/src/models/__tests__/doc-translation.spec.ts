import { randomUUID } from 'node:crypto';

import test from 'ava';

import { createModule } from '../../__tests__/create-module';
import { Mockers } from '../../__tests__/mocks';
import { Models } from '../index';

const module = await createModule();
const models = module.get(Models);

test.after.always(async () => {
  await module.close();
});

const newDoc = async () => {
  const workspace = await module.create(Mockers.Workspace);
  return { workspaceId: workspace.id, docId: randomUUID() };
};

const langs = (rows: { lang: string }[]) => rows.map(row => row.lang).sort();

test('setLanguages creates pending rows and drops deselected ones', async t => {
  const { workspaceId, docId } = await newDoc();

  await models.docTranslation.setLanguages(workspaceId, docId, 'en', [
    'fr',
    'de',
  ]);
  let rows = await models.docTranslation.list(workspaceId, docId);
  t.deepEqual(langs(rows), ['de', 'fr']);
  t.true(
    rows.every(row => row.status === 'pending' && row.sourceLang === 'en')
  );

  await models.docTranslation.setLanguages(workspaceId, docId, 'en', ['fr']);
  rows = await models.docTranslation.list(workspaceId, docId);
  t.deepEqual(langs(rows), ['fr']);
});

test('setLanguages keeps finished rows of the same source language', async t => {
  const { workspaceId, docId } = await newDoc();
  await models.docTranslation.setLanguages(workspaceId, docId, 'en', ['fr']);
  await models.docTranslation.complete(workspaceId, docId, 'fr', {
    title: 'Bonjour',
    bin: Buffer.from([1]),
    sourceTimestamp: new Date(),
  });

  await models.docTranslation.setLanguages(workspaceId, docId, 'en', [
    'fr',
    'pl',
  ]);
  const rows = await models.docTranslation.list(workspaceId, docId);
  t.is(rows.find(row => row.lang === 'fr')!.status, 'ready');
  t.is(rows.find(row => row.lang === 'pl')!.status, 'pending');
});

test('changing the source language requeues every row', async t => {
  const { workspaceId, docId } = await newDoc();
  await models.docTranslation.setLanguages(workspaceId, docId, 'en', ['fr']);
  await models.docTranslation.complete(workspaceId, docId, 'fr', {
    title: 'Bonjour',
    bin: Buffer.from([1]),
    sourceTimestamp: new Date(),
  });

  await models.docTranslation.setLanguages(workspaceId, docId, 'de', ['fr']);
  const [row] = await models.docTranslation.list(workspaceId, docId);
  t.is(row.status, 'pending');
  t.is(row.sourceLang, 'de');
});

test('claimNext hands out each due row once', async t => {
  const { workspaceId, docId } = await newDoc();
  await models.docTranslation.setLanguages(workspaceId, docId, 'en', ['nl']);

  const claimed = await models.docTranslation.claimNext();
  t.truthy(claimed);
  const again = await models.docTranslation.claimNext();
  t.false(again?.docId === docId && again?.lang === 'nl');
});

test('postpone hides a row until it is due', async t => {
  const { workspaceId, docId } = await newDoc();
  await models.docTranslation.setLanguages(workspaceId, docId, 'en', ['es']);
  await models.docTranslation.postpone(
    workspaceId,
    docId,
    'es',
    new Date(Date.now() + 60_000)
  );

  for (let row; (row = await models.docTranslation.claimNext());) {
    t.false(row.docId === docId, 'a postponed row must not be claimed');
  }
  const [row] = await models.docTranslation.list(workspaceId, docId);
  t.is(row.status, 'pending');
  t.is(row.attempts, 1);
});

test('getServed returns the last finished translation, also while requeued', async t => {
  const { workspaceId, docId } = await newDoc();
  await models.docTranslation.setLanguages(workspaceId, docId, 'en', ['pt']);
  t.is(await models.docTranslation.getServed(workspaceId, docId, 'pt'), null);

  await models.docTranslation.complete(workspaceId, docId, 'pt', {
    title: 'Olá',
    bin: Buffer.from([7]),
    sourceTimestamp: new Date(),
  });
  await models.docTranslation.requeue(workspaceId, docId);

  const served = await models.docTranslation.getServed(
    workspaceId,
    docId,
    'pt'
  );
  t.is(served?.title, 'Olá');
  t.deepEqual([...served!.bin], [7]);
});

test('fail records the error and deleteForDoc removes everything', async t => {
  const { workspaceId, docId } = await newDoc();
  await models.docTranslation.setLanguages(workspaceId, docId, 'en', ['de']);
  await models.docTranslation.fail(workspaceId, docId, 'de', 'boom');
  let [row] = await models.docTranslation.list(workspaceId, docId);
  t.is(row.status, 'failed');
  t.is(row.error, 'boom');

  await models.docTranslation.deleteForDoc(workspaceId, docId);
  t.deepEqual(await models.docTranslation.list(workspaceId, docId), []);
});
