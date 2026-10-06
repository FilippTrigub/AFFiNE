import { randomUUID } from 'node:crypto';

import test from 'ava';
import * as Y from 'yjs';

import { Models } from '../../models';
import { createDocWithMarkdown, parseYDocToMarkdown } from '../../native';
import { TranslateModule } from '../../plugins/translate';
import {
  GeminiRateLimited,
  GenerateText,
} from '../../plugins/translate/gemini';
import { TranslationProvider } from '../../plugins/translate/provider';
import { DocTranslationWorker } from '../../plugins/translate/worker';
import { createModule } from '../create-module';
import { Mockers } from '../mocks';

let generate: GenerateText | null = null;

const module = await createModule({
  imports: [TranslateModule],
  tapModule: builder =>
    builder
      .overrideProvider(TranslationProvider)
      .useValue({ generator: () => generate }),
});
const models = module.get(Models);
const worker = module.get(DocTranslationWorker);
const owner = await module.create(Mockers.User);

test.after.always(async () => {
  await module.close();
});

const frenchish: GenerateText = async (_system, user) =>
  user
    .replace('Greeting', 'Salutation')
    .replace(/\bone\b/g, 'un')
    .replace(/\btwo\b/g, 'deux')
    .replace('See', 'Voir');

/** A published doc with a snapshot, queued for French. */
async function publishedDoc(
  markdown: string | ((workspaceId: string) => string),
  options = { publish: true }
) {
  const workspace = await module.create(Mockers.Workspace, { owner });
  const docId = randomUUID();
  const body =
    typeof markdown === 'function' ? markdown(workspace.id) : markdown;
  await module.create(Mockers.DocSnapshot, {
    user: owner,
    workspaceId: workspace.id,
    docId,
    blob: createDocWithMarkdown('Greeting', body, docId),
  });
  if (options.publish) await models.doc.publish(workspace.id, docId);
  await models.docTranslation.setLanguages(workspace.id, docId, 'en', ['fr']);
  return { workspaceId: workspace.id, docId };
}

/** Run the worker until our row has been handled. */
async function drain() {
  while (await worker.processNext()) {
    // keep going: other tests' rows may be queued ahead of ours
  }
}

test.serial('translates a published doc into a served snapshot', async t => {
  generate = frenchish;
  const { workspaceId, docId } = await publishedDoc(
    '- one\n- two\n\nSee [docs](https://example.com)'
  );

  await drain();

  const [row] = await models.docTranslation.list(workspaceId, docId);
  t.is(row.status, 'ready');
  t.is(row.title, 'Salutation');
  t.truthy(row.sourceTimestamp);

  const served = await models.docTranslation.getServed(
    workspaceId,
    docId,
    'fr'
  );
  const parsed = parseYDocToMarkdown(Buffer.from(served!.bin), docId, false);
  t.is(parsed.title, 'Salutation');
  t.regex(parsed.markdown, /un/);
  t.regex(parsed.markdown, /deux/);
  t.regex(parsed.markdown, /\[docs\]\(https:\/\/example\.com\)/);
});

test.serial(
  'drops the translations of a doc that is no longer public',
  async t => {
    generate = frenchish;
    const { workspaceId, docId } = await publishedDoc('one', {
      publish: false,
    });

    await drain();

    t.deepEqual(await models.docTranslation.list(workspaceId, docId), []);
  }
);

test.serial('backs off when the provider is rate limited', async t => {
  generate = async () => {
    throw new GeminiRateLimited('quota');
  };
  const { workspaceId, docId } = await publishedDoc('one');

  await drain();

  const [row] = await models.docTranslation.list(workspaceId, docId);
  t.is(row.status, 'pending');
  t.is(row.attempts, 1);
  t.true(row.availableAt.getTime() > Date.now());
});

test.serial('records a provider failure on the row', async t => {
  generate = async () => {
    throw new Error('Gemini request failed (400): bad model');
  };
  const { workspaceId, docId } = await publishedDoc('one');

  await drain();

  const [row] = await models.docTranslation.list(workspaceId, docId);
  t.is(row.status, 'failed');
  t.regex(row.error!, /bad model/);
});

test.serial('fails clearly when translation is not configured', async t => {
  generate = null;
  const { workspaceId, docId } = await publishedDoc('one');

  await drain();

  const [row] = await models.docTranslation.list(workspaceId, docId);
  t.is(row.status, 'failed');
  t.regex(row.error!, /not configured/);
});

test.serial('keeps links to other pages as page references', async t => {
  generate = frenchish;
  const target = randomUUID();
  const { workspaceId, docId } = await publishedDoc(
    workspaceId => `See [other](/workspace/${workspaceId}/${target})`
  );

  await drain();

  const served = await models.docTranslation.getServed(
    workspaceId,
    docId,
    'fr'
  );
  const doc = new Y.Doc();
  Y.applyUpdate(doc, served!.bin);
  const references = [...doc.getMap<unknown>('blocks').values()]
    .map(block => (block instanceof Y.Map ? block.get('prop:text') : null))
    .filter((text): text is Y.Text => text instanceof Y.Text)
    .flatMap(text => text.toDelta() as { attributes?: any }[])
    .filter(op => op.attributes?.reference?.pageId === target);
  t.is(references.length, 1);
});
