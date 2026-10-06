import { randomUUID } from 'node:crypto';

import test from 'ava';

import { Models } from '../../models';
import { createDocWithMarkdown } from '../../native';
import { TranslateModule } from '../../plugins/translate';
import { DocTranslationResolver } from '../../plugins/translate/resolver';
import { createModule } from '../create-module';
import { Mockers } from '../mocks';

// Resolver methods are called directly, so the feature guard is not involved
// and translate.enabled stays off: the cron must not pick up rows mid-test.
const module = await createModule({ imports: [TranslateModule] });
const models = module.get(Models);
const resolver = module.get(DocTranslationResolver);

test.after.always(async () => {
  await module.close();
});

const asUser = (user: { id: string }) => user as any;

async function setup(options = { publish: true }) {
  const owner = await module.create(Mockers.User);
  const workspace = await module.create(Mockers.Workspace, { owner });
  const docId = randomUUID();
  await module.create(Mockers.DocSnapshot, {
    user: owner,
    workspaceId: workspace.id,
    docId,
    blob: createDocWithMarkdown('Title', 'Body', docId),
  });
  if (options.publish) await models.doc.publish(workspace.id, docId);
  return { owner, workspaceId: workspace.id, docId };
}

test('the publisher sets languages and lists them', async t => {
  const { owner, workspaceId, docId } = await setup();

  const rows = await resolver.setDocTranslations(
    asUser(owner),
    workspaceId,
    docId,
    'en',
    ['fr', 'de', 'fr']
  );

  t.deepEqual(
    rows.map(row => [row.lang, row.status]),
    [
      ['de', 'pending'],
      ['fr', 'pending'],
    ]
  );
  const listed = await resolver.docTranslations(
    asUser(owner),
    workspaceId,
    docId
  );
  t.is(listed.length, 2);
});

test('a non-member cannot set translations', async t => {
  const { workspaceId, docId } = await setup();
  const stranger = await module.create(Mockers.User);

  await t.throwsAsync(
    resolver.setDocTranslations(asUser(stranger), workspaceId, docId, 'en', [
      'fr',
    ]),
    { message: /Doc\.Publish|permission/i }
  );
});

test('translations need a published doc', async t => {
  const { owner, workspaceId, docId } = await setup({ publish: false });

  await t.throwsAsync(
    resolver.setDocTranslations(asUser(owner), workspaceId, docId, 'en', [
      'fr',
    ]),
    { message: /not public/i }
  );
});

test('unsupported languages and source-as-target are rejected', async t => {
  const { owner, workspaceId, docId } = await setup();

  await t.throwsAsync(
    resolver.setDocTranslations(asUser(owner), workspaceId, docId, 'en', [
      'it',
    ]),
    { message: /unsupported language/i }
  );
  await t.throwsAsync(
    resolver.setDocTranslations(asUser(owner), workspaceId, docId, 'xx', [
      'fr',
    ]),
    { message: /unsupported language/i }
  );
  await t.throwsAsync(
    resolver.setDocTranslations(asUser(owner), workspaceId, docId, 'en', [
      'en',
    ]),
    { message: /source language/i }
  );
});

test('a translation of an older revision is out of date', async t => {
  const { owner, workspaceId, docId } = await setup();
  await resolver.setDocTranslations(asUser(owner), workspaceId, docId, 'en', [
    'fr',
  ]);
  await models.docTranslation.complete(workspaceId, docId, 'fr', {
    title: 'Titre',
    bin: Buffer.from([1]),
    sourceTimestamp: new Date(0),
  });

  const [row] = await resolver.docTranslations(
    asUser(owner),
    workspaceId,
    docId
  );
  t.is(row.status as string, 'ready');
  t.true(row.outOfDate);
});

test('refresh requeues every language', async t => {
  const { owner, workspaceId, docId } = await setup();
  await resolver.setDocTranslations(asUser(owner), workspaceId, docId, 'en', [
    'fr',
  ]);
  await models.docTranslation.fail(workspaceId, docId, 'fr', 'boom');

  const [row] = await resolver.refreshDocTranslations(
    asUser(owner),
    workspaceId,
    docId
  );
  t.is(row.status as string, 'pending');
  t.is(row.error, null);
});
