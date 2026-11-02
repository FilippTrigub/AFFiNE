import * as Y from 'yjs';

import { WorkspaceYjsMutator } from '../../../core/doc';
import { DocRole } from '../../../models';
import { app, e2e } from '../test';
import {
  call,
  callTool,
  enableMcp,
  loadYDoc,
  ownedWorkspace,
  referencesIn,
} from './utils';

e2e.before(() => {
  enableMcp();
});

e2e('page links become real references and survive a round-trip', async t => {
  const { owner, workspace } = await ownedWorkspace();
  const target = await call(owner.id, workspace.id, 'create_document', {
    title: 'Guest list',
    content: 'Names go here.',
  });
  const hub = await call(owner.id, workspace.id, 'create_document', {
    title: '26-09',
    content: `- [Guest list](affine://${target.docId})\n- [elsewhere](https://example.com)`,
  });
  t.is(hub.linkedPages, 1);

  t.deepEqual(referencesIn(await loadYDoc(workspace.id, hub.docId)), [
    target.docId,
  ]);

  const read = await call(owner.id, workspace.id, 'read_document', {
    docId: hub.docId,
  });
  t.true(read.includes(`[Guest list](affine://${target.docId})`));
  t.true(read.includes('https://example.com'));
  // A plain page carries no "unsupported blocks" warning.
  t.false(read.includes('<!--'));

  // Writing back what was read keeps the reference.
  await call(owner.id, workspace.id, 'update_document', {
    docId: hub.docId,
    content: read,
  });
  t.deepEqual(referencesIn(await loadYDoc(workspace.id, hub.docId)), [
    target.docId,
  ]);

  // A link to a doc that does not exist stays a plain link.
  const dangling = await call(owner.id, workspace.id, 'create_document', {
    title: 'dangling',
    content: '[nowhere](affine://doesNotExist)',
  });
  t.is(dangling.linkedPages, 0);
});

e2e('list, info, properties and journal', async t => {
  const { owner, workspace } = await ownedWorkspace();
  const created = await call(owner.id, workspace.id, 'create_document', {
    title: 'Board',
    content: 'x',
    mode: 'edgeless',
  });

  const listed = await call(owner.id, workspace.id, 'list_documents', {
    title_contains: 'boa',
  });
  t.is(listed.total, 1);
  t.is(listed.documents[0].id, created.docId);

  await call(owner.id, workspace.id, 'set_document_properties', {
    docId: created.docId,
    is_template: true,
    page_width: 'fullWidth',
  });
  const info = await call(owner.id, workspace.id, 'get_document_info', {
    docId: created.docId,
  });
  t.is(info.mode, 'edgeless');
  t.true(info.isTemplate);
  t.is(info.pageWidth, 'fullWidth');
  t.is(info.createdBy, owner.id);
  t.false(info.trashed);
  t.deepEqual(info.folders, []);

  const unknownProp = await callTool(
    owner.id,
    workspace.id,
    'set_document_properties',
    { docId: created.docId, custom: { nope: 'x' } }
  );
  t.true(unknownProp.isError);

  const first = await call(owner.id, workspace.id, 'open_journal', {
    date: '2026-09-26',
  });
  t.true(first.created);
  const again = await call(owner.id, workspace.id, 'open_journal', {
    date: '2026-09-26',
  });
  t.false(again.created);
  t.is(again.docId, first.docId);
  const journal = await call(owner.id, workspace.id, 'get_document_info', {
    docId: first.docId,
  });
  t.is(journal.journal, '2026-09-26');
  t.is(journal.title, '2026-09-26');
});

e2e('trash and restore round-trip', async t => {
  const { owner, workspace } = await ownedWorkspace();
  const doc = await call(owner.id, workspace.id, 'create_document', {
    title: 'Temporary',
    content: 'x',
  });
  await call(owner.id, workspace.id, 'trash_document', { docId: doc.docId });

  const hidden = await call(owner.id, workspace.id, 'list_documents', {
    title_contains: 'Temporary',
  });
  t.is(hidden.total, 0);
  const shown = await call(owner.id, workspace.id, 'list_documents', {
    title_contains: 'Temporary',
    include_trashed: true,
  });
  t.true(shown.documents[0].trashed);

  await call(owner.id, workspace.id, 'restore_document', { docId: doc.docId });
  const back = await call(owner.id, workspace.id, 'list_documents', {
    title_contains: 'Temporary',
  });
  t.is(back.total, 1);
});

e2e(
  'duplicate copies content and properties under a numbered title',
  async t => {
    const { owner, workspace } = await ownedWorkspace();
    const source = await call(owner.id, workspace.id, 'create_document', {
      title: 'Plan',
      content: '# ignored\n\nSome **bold** text.',
      mode: 'edgeless',
    });
    const copy = await call(owner.id, workspace.id, 'duplicate_document', {
      docId: source.docId,
    });
    t.is(copy.title, 'Plan (1)');
    // Structural blocks every page has are not reported as lost.
    t.deepEqual(copy.notCopied, []);
    const info = await call(owner.id, workspace.id, 'get_document_info', {
      docId: copy.docId,
    });
    t.is(info.mode, 'edgeless');
    const body = await call(owner.id, workspace.id, 'read_document', {
      docId: copy.docId,
    });
    t.true(body.includes('**bold**'));
  }
);

e2e('an uploaded image can be embedded by blob key', async t => {
  const { owner, workspace } = await ownedWorkspace();
  // 1x1 transparent PNG
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const uploaded = await call(owner.id, workspace.id, 'upload_image', {
    data_base64: png,
    mime_type: 'image/png',
  });
  t.truthy(uploaded.key);
  const blob = await app.models.blob.get(workspace.id, uploaded.key);
  t.truthy(blob);

  const doc = await call(owner.id, workspace.id, 'create_document', {
    title: 'With image',
    content: `Before\n\n${uploaded.markdown}\n\nAfter`,
  });
  const body = await call(owner.id, workspace.id, 'read_document', {
    docId: doc.docId,
  });
  t.true(body.includes(`blob://${uploaded.key}`));

  // Uploading the same bytes again is idempotent.
  const again = await call(owner.id, workspace.id, 'upload_image', {
    data_base64: png,
    mime_type: 'image/png',
  });
  t.is(again.key, uploaded.key);
});

e2e(
  'update_document keeps an attachment in place, also for an agent',
  async t => {
    const { owner, workspace } = await ownedWorkspace();
    const ws = workspace.id;
    const doc = await call(owner.id, ws, 'create_document', {
      title: 'Target List',
      content: '### List\n\n|Column|Title|\n|---|---|\n\nEnd',
    });

    // Put an attachment between the heading and the table, as the editor would.
    await app
      .get(WorkspaceYjsMutator)
      .mutate(ws, doc.docId, { editorId: owner.id }, ydoc => {
        const blocks = ydoc.getMap<Y.Map<unknown>>('blocks');
        const note = [...blocks.values()].find(
          block => block.get('sys:flavour') === 'affine:note'
        )!;
        const attachment = new Y.Map<unknown>();
        attachment.set('sys:id', 'csv-attachment');
        attachment.set('sys:flavour', 'affine:attachment');
        attachment.set('sys:version', 1);
        attachment.set('sys:children', new Y.Array());
        attachment.set('prop:name', 'companies.csv');
        attachment.set('prop:sourceId', 'blob-key');
        blocks.set('csv-attachment', attachment);
        (note.get('sys:children') as Y.Array<string>).insert(1, [
          'csv-attachment',
        ]);
      });

    const agent = await app.models.workspace.provisionAgent(ws);
    await app.models.docUser.set(ws, doc.docId, agent.id, DocRole.Editor);

    const read = await call(agent.id, ws, 'read_document', {
      docId: doc.docId,
    });
    t.true(read.includes('affine:attachment'));
    t.true(read.includes('update_document keeps them where they are'));

    await call(agent.id, ws, 'update_document', {
      docId: doc.docId,
      content:
        '### List\n\n|Name|Country|\n|---|---|\n|2H ENERGY|France|\n\nEnd',
    });

    const ydoc = await loadYDoc(ws, doc.docId);
    const blocks = ydoc.getMap<Y.Map<unknown>>('blocks');
    const attachment = blocks.get('csv-attachment');
    t.is(attachment?.get('prop:name'), 'companies.csv');
    t.is(attachment?.get('prop:sourceId'), 'blob-key');
    const note = [...blocks.values()].find(
      block => block.get('sys:flavour') === 'affine:note'
    )!;
    t.deepEqual(
      (note.get('sys:children') as Y.Array<string>)
        .toArray()
        .map(id => blocks.get(id)?.get('sys:flavour')),
      [
        'affine:paragraph',
        'affine:attachment',
        'affine:table',
        'affine:paragraph',
      ]
    );

    const after = await call(owner.id, ws, 'read_document', {
      docId: doc.docId,
    });
    t.true(after.includes('2H ENERGY'));
  }
);
