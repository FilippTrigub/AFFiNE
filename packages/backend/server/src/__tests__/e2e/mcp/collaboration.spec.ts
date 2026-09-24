import { PgWorkspaceDocStorageAdapter } from '../../../core/doc';
import { app, e2e } from '../test';
import { call, callTool, enableMcp, ownedWorkspace } from './utils';

e2e.before(() => {
  enableMcp();
});

e2e('comments: create, reply, resolve and reopen', async t => {
  const { owner, workspace } = await ownedWorkspace();
  const ws = workspace.id;
  const doc = await call(owner.id, ws, 'create_document', {
    title: 'Guest list',
    content: 'x',
  });

  const comment = await call(owner.id, ws, 'create_comment', {
    docId: doc.docId,
    text: 'Please verify Hamdoun.\nSecond line.',
  });
  await call(owner.id, ws, 'reply_comment', {
    comment_id: comment.commentId,
    text: 'Asked at the door.',
  });

  let list = await call(owner.id, ws, 'list_comments', { docId: doc.docId });
  t.is(list.comments.length, 1);
  t.is(list.comments[0].text, 'Please verify Hamdoun.\nSecond line.');
  t.is(list.comments[0].author.id, owner.id);
  t.is(list.comments[0].replies[0].text, 'Asked at the door.');
  t.false(list.comments[0].resolved);

  await call(owner.id, ws, 'resolve_comment', {
    comment_id: comment.commentId,
  });
  list = await call(owner.id, ws, 'list_comments', {
    docId: doc.docId,
    include_resolved: false,
  });
  t.is(list.comments.length, 0);

  await call(owner.id, ws, 'resolve_comment', {
    comment_id: comment.commentId,
    resolved: false,
  });
  list = await call(owner.id, ws, 'list_comments', { docId: doc.docId });
  t.false(list.comments[0].resolved);

  // A comment id from another workspace is invisible.
  const other = await ownedWorkspace();
  const foreign = await callTool(
    other.owner.id,
    other.workspace.id,
    'resolve_comment',
    { comment_id: comment.commentId }
  );
  t.true(foreign.isError);
});

e2e('history: list, read and restore a version', async t => {
  const { owner, workspace } = await ownedWorkspace();
  const ws = workspace.id;
  const doc = await call(owner.id, ws, 'create_document', {
    title: 'Versioned',
    content: 'First version.',
  });

  // Save the current state as a history entry, as the snapshot job would.
  const storage = app.get(PgWorkspaceDocStorageAdapter);
  const current = await storage.getDoc(ws, doc.docId);
  const timestamp = Date.now() - 60_000;
  await app.models.history.create(
    {
      spaceId: ws,
      docId: doc.docId,
      blob: Buffer.from(current!.bin),
      timestamp,
      editorId: owner.id,
    },
    24 * 60 * 60 * 1000
  );

  await call(owner.id, ws, 'update_document', {
    docId: doc.docId,
    content: 'Second version.',
  });

  const history = await call(owner.id, ws, 'list_history', {
    docId: doc.docId,
  });
  const version = history.versions.find(
    (v: { timestamp: string }) =>
      v.timestamp === new Date(timestamp).toISOString()
  );
  t.truthy(version);

  const old = await call(owner.id, ws, 'read_version', {
    docId: doc.docId,
    timestamp: version.timestamp,
  });
  t.true(old.includes('First version.'));

  await call(owner.id, ws, 'restore_version', {
    docId: doc.docId,
    timestamp: version.timestamp,
  });
  const body = await call(owner.id, ws, 'read_document', { docId: doc.docId });
  t.true(body.includes('First version.'));
  t.false(body.includes('Second version.'));
});

e2e('publish and unpublish', async t => {
  const { owner, workspace } = await ownedWorkspace();
  const ws = workspace.id;
  const doc = await call(owner.id, ws, 'create_document', {
    title: 'Public',
    content: 'x',
  });
  await call(owner.id, ws, 'publish_document', {
    docId: doc.docId,
    mode: 'edgeless',
  });
  let info = await call(owner.id, ws, 'get_document_info', {
    docId: doc.docId,
  });
  t.true(info.public);
  t.is(info.publicMode, 'edgeless');

  await call(owner.id, ws, 'unpublish_document', { docId: doc.docId });
  info = await call(owner.id, ws, 'get_document_info', { docId: doc.docId });
  t.false(info.public);

  const again = await callTool(owner.id, ws, 'unpublish_document', {
    docId: doc.docId,
  });
  t.true(again.isError);
});
