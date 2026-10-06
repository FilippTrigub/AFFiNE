import { randomUUID } from 'node:crypto';

import { HttpStatus } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import ava, { TestFn } from 'ava';

import { ConfigFactory } from '../../base';
import { Models } from '../../models';
import { Mockers } from '../mocks';
import { createTestingApp, TestingApp } from '../utils';

const test = ava as TestFn<{ app: TestingApp }>;

test.before(async t => {
  t.context.app = await createTestingApp();
});

test.beforeEach(async t => {
  await t.context.app.initTestingDB();
  t.context.app.get(ConfigFactory).override({ translate: { enabled: true } });
});

test.after.always(async t => {
  await t.context.app.close();
});

/** A doc with a finished French translation, inserted without the queue. */
async function translatedDoc(app: TestingApp, options = { publish: true }) {
  const owner = await app.create(Mockers.User);
  const workspace = await app.create(Mockers.Workspace, { owner });
  const docId = randomUUID();
  if (options.publish) await app.get(Models).doc.publish(workspace.id, docId);
  await app.get(PrismaClient).docTranslation.create({
    data: {
      workspaceId: workspace.id,
      docId,
      lang: 'fr',
      sourceLang: 'en',
      status: 'ready',
      title: 'Bonjour',
      bin: Buffer.from([4, 5, 6]),
    },
  });
  return { workspaceId: workspace.id, docId };
}

const base = (workspaceId: string, docId: string) =>
  `/api/workspaces/${workspaceId}/public-docs/${docId}/translations`;

test('lists the languages a reader can switch to', async t => {
  const { app } = t.context;
  const { workspaceId, docId } = await translatedDoc(app);

  const res = await app.GET(base(workspaceId, docId));

  t.is(res.status, HttpStatus.OK);
  t.deepEqual(res.body, { sourceLang: 'en', languages: ['fr'] });
});

test('serves the translated snapshot to anonymous readers', async t => {
  const { app } = t.context;
  const { workspaceId, docId } = await translatedDoc(app);

  const res = await app.GET(`${base(workspaceId, docId)}/fr`);

  t.is(res.status, HttpStatus.OK);
  t.is(res.get('content-type'), 'application/octet-stream');
  t.is(res.get('publish-mode'), 'page');
  t.deepEqual(res.body, Buffer.from([4, 5, 6]));
});

test('a language without a translation is not found', async t => {
  const { app } = t.context;
  const { workspaceId, docId } = await translatedDoc(app);

  const res = await app.GET(`${base(workspaceId, docId)}/de`);

  t.is(res.status, HttpStatus.NOT_FOUND);
});

test('translations of a private doc stay private', async t => {
  const { app } = t.context;
  const { workspaceId, docId } = await translatedDoc(app, { publish: false });

  t.is((await app.GET(base(workspaceId, docId))).status, HttpStatus.FORBIDDEN);
  t.is(
    (await app.GET(`${base(workspaceId, docId)}/fr`)).status,
    HttpStatus.FORBIDDEN
  );
});

test('nothing is offered while the feature is off', async t => {
  const { app } = t.context;
  const { workspaceId, docId } = await translatedDoc(app);
  app.get(ConfigFactory).override({ translate: { enabled: false } });

  const list = await app.GET(base(workspaceId, docId));
  t.deepEqual(list.body, { sourceLang: null, languages: [] });
  t.is(
    (await app.GET(`${base(workspaceId, docId)}/fr`)).status,
    HttpStatus.NOT_FOUND
  );
});
