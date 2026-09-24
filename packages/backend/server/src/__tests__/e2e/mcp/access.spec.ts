import { DocRole, WorkspaceRole } from '../../../models';
import { app, e2e, Mockers } from '../test';
import { call, callTool, enableMcp, ownedWorkspace, toolNames } from './utils';

e2e.before(() => {
  enableMcp();
});

/** Tools that act on the whole workspace or need more than Editor. */
const HUMAN_ONLY = [
  'list_folders',
  'create_folder',
  'rename_folder',
  'move_folder_item',
  'add_to_folder',
  'remove_from_folder',
  'list_tags',
  'create_tag',
  'update_tag',
  'set_document_tags',
  'list_collections',
  'create_collection',
  'update_collection',
  'pin_collection',
  'unpin_collection',
  'list_favorites',
  'add_favorite',
  'remove_favorite',
  'set_icon',
  'create_custom_property',
  'update_custom_property',
  'trash_document',
  'restore_document',
  'publish_document',
  'unpublish_document',
  'upload_image',
];

e2e('no tool can delete anything permanently', async t => {
  const { owner, workspace } = await ownedWorkspace();
  const names = await toolNames(owner.id, workspace.id, 'READ_WRITE');
  t.is(names.length, new Set(names).size, 'tool names are unique');
  t.deepEqual(
    names.filter(name => /delete|destroy|purge|erase/i.test(name)),
    []
  );
});

e2e('read-only credentials list no write tools', async t => {
  const { owner, workspace } = await ownedWorkspace();
  const readOnly = await toolNames(owner.id, workspace.id, 'READ_ONLY');
  t.deepEqual(
    readOnly.sort((a, b) => a.localeCompare(b)),
    [
      'doc_search',
      'get_document_info',
      'list_collections',
      'list_comments',
      'list_custom_properties',
      'list_documents',
      'list_favorites',
      'list_folders',
      'list_history',
      'list_tags',
      'read_document',
      'read_version',
    ]
  );
});

e2e('agents never see humans-only tools', async t => {
  const owner = await app.signup();
  const workspace = await app.create(Mockers.Workspace, {
    owner: { id: owner.id },
    snapshot: true,
  });
  const agent = await app.models.workspace.provisionAgent(workspace.id);

  const human = await toolNames(owner.id, workspace.id);
  const agentTools = await toolNames(agent.id, workspace.id);
  for (const name of HUMAN_ONLY) {
    t.true(human.includes(name), `${name} is listed for humans`);
    t.false(agentTools.includes(name), `${name} is hidden from agents`);
  }
});

e2e('an agent stays inside its grants', async t => {
  const owner = await app.signup();
  const workspace = await app.create(Mockers.Workspace, {
    owner: { id: owner.id },
    snapshot: true,
  });
  const ws = workspace.id;
  const agent = await app.models.workspace.provisionAgent(ws);

  const granted = await call(owner.id, ws, 'create_document', {
    title: 'Granted',
    content: 'x',
  });
  const hidden = await call(owner.id, ws, 'create_document', {
    title: 'Hidden',
    content: 'x',
  });
  await app.models.docUser.set(ws, granted.docId, agent.id, DocRole.Reader);

  const listed = await call(agent.id, ws, 'list_documents', {});
  t.deepEqual(
    listed.documents.map((d: { id: string }) => d.id),
    [granted.docId]
  );
  for (const tool of ['get_document_info', 'list_comments', 'list_history']) {
    t.true(
      (await callTool(agent.id, ws, tool, { docId: hidden.docId })).isError,
      `${tool} hides ungranted docs`
    );
  }

  // Reader: no comments, no properties, no edits.
  t.true(
    (
      await callTool(agent.id, ws, 'create_comment', {
        docId: granted.docId,
        text: 'hi',
      })
    ).isError
  );
  t.true(
    (
      await callTool(agent.id, ws, 'set_document_properties', {
        docId: granted.docId,
        mode: 'edgeless',
      })
    ).isError
  );

  await app.models.docUser.set(ws, granted.docId, agent.id, DocRole.Commenter);
  await call(agent.id, ws, 'create_comment', {
    docId: granted.docId,
    text: 'hi',
  });

  // Organisation options are refused rather than silently ignored.
  const withFolder = await callTool(agent.id, ws, 'create_document', {
    title: 'Mine',
    content: 'x',
    folder_id: 'anything',
  });
  t.true(withFolder.isError);

  // With Editor it can rewrite the doc. Links resolve only to docs it may
  // read, so linking cannot reveal whether an ungranted doc exists.
  await app.models.docUser.set(ws, granted.docId, agent.id, DocRole.Editor);
  const updated = await call(agent.id, ws, 'update_document', {
    docId: granted.docId,
    content: `See [Hidden](affine://${hidden.docId}) and [me](affine://${granted.docId}).`,
  });
  t.is(updated.linkedPages, 1);
  await call(agent.id, ws, 'set_document_properties', {
    docId: granted.docId,
    mode: 'edgeless',
  });

  // Known limitation, pre-dating these tools: the native runtime refuses
  // CreateDoc for an agent, which is deliberately not a workspace member.
  const created = await callTool(agent.id, ws, 'create_document', {
    title: 'Mine',
    content: 'x',
  });
  t.true(created.isError);
});

e2e('a plain collaborator cannot define custom properties', async t => {
  const { owner, workspace } = await ownedWorkspace();
  const member = await app.signup();
  await app.create(Mockers.WorkspaceUser, {
    workspaceId: workspace.id,
    userId: member.id,
    type: WorkspaceRole.Collaborator,
  });

  const denied = await callTool(
    member.id,
    workspace.id,
    'create_custom_property',
    { name: 'x', type: 'text' }
  );
  t.true(denied.isError);

  // Organising the sidebar is an ordinary member action.
  await call(member.id, workspace.id, 'create_folder', { name: 'Mine' });
  await call(owner.id, workspace.id, 'create_custom_property', {
    name: 'x',
    type: 'text',
  });
});
