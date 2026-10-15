import * as Y from 'yjs';

import { WorkspaceYjsMutator } from '../../../core/doc';
import { DocRole, WorkspaceRole } from '../../../models';
import { app, e2e, Mockers } from '../test';
import { call, callTool, enableMcp, ownedWorkspace, toolNames } from './utils';

e2e.before(() => {
  enableMcp();
});

/** Tools that act on the whole workspace or need more than Editor. */
/** Folder tools: open to agents, which only handle links to granted docs. */
const AGENT_FOLDER_TOOLS = [
  'list_folders',
  'create_folder',
  'rename_folder',
  'move_folder_item',
  'add_to_folder',
  'remove_from_folder',
];

const HUMAN_ONLY = [
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
  for (const name of AGENT_FOLDER_TOOLS) {
    t.true(agentTools.includes(name), `${name} is listed for agents`);
  }
  // A read-only agent credential still cannot create anything.
  const readOnly = await toolNames(agent.id, workspace.id, 'READ_ONLY');
  t.false(readOnly.includes('create_document'));
  t.false(readOnly.includes('create_folder'));
  t.true(readOnly.includes('list_folders'));
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

  // Tags are refused rather than silently ignored, and an unknown folder
  // fails before any doc exists.
  const withTags = await callTool(agent.id, ws, 'create_document', {
    title: 'Mine',
    content: 'x',
    tags: ['anything'],
  });
  t.true(withTags.isError);
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

  const listedAfter = await call(agent.id, ws, 'list_documents', {});
  t.deepEqual(
    listedAfter.documents.map((d: { id: string }) => d.id),
    [granted.docId]
  );
});

e2e('an agent creates documents and gets Editor on them', async t => {
  const owner = await app.signup();
  const workspace = await app.create(Mockers.Workspace, {
    owner: { id: owner.id },
    snapshot: true,
  });
  const ws = workspace.id;
  const agent = await app.models.workspace.provisionAgent(ws);

  const created = await call(agent.id, ws, 'create_document', {
    title: 'Minutes',
    content: 'First draft.',
  });
  t.truthy(created.docId);

  // Registered in the workspace like any other doc: the owner sees it.
  const ownerList = await call(owner.id, ws, 'list_documents', {});
  t.true(
    ownerList.documents.some((d: { id: string }) => d.id === created.docId)
  );

  // The agent holds Editor on what it created, and only that.
  const grants = await app.models.docUser.findGrantsByUser(ws, agent.id);
  t.deepEqual(
    grants.map(grant => [grant.docId, grant.role]),
    [[created.docId, DocRole.Editor]]
  );

  await call(agent.id, ws, 'update_document', {
    docId: created.docId,
    content: 'Second draft.',
  });
  const read = await call(agent.id, ws, 'read_document', {
    docId: created.docId,
  });
  t.true(read.includes('Second draft.'));
  const info = await call(agent.id, ws, 'get_document_info', {
    docId: created.docId,
  });
  t.is(info.createdBy, agent.id);

  // Duplicating its own doc goes through the same path.
  const copy = await call(agent.id, ws, 'duplicate_document', {
    docId: created.docId,
  });
  t.truthy(copy.docId);
});

e2e('an agent uploads an image and embeds it in its own doc', async t => {
  const owner = await app.signup();
  const workspace = await app.create(Mockers.Workspace, {
    owner: { id: owner.id },
    snapshot: true,
  });
  const ws = workspace.id;
  const agent = await app.models.workspace.provisionAgent(ws);
  t.true((await toolNames(agent.id, ws)).includes('upload_image'));
  t.false(
    (await toolNames(agent.id, ws, 'READ_ONLY')).includes('upload_image')
  );

  // 1x1 transparent PNG
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const uploaded = await call(agent.id, ws, 'upload_image', {
    data_base64: png,
    mime_type: 'image/png',
  });
  t.truthy(uploaded.key);
  t.truthy(await app.models.blob.get(ws, uploaded.key));

  const doc = await call(agent.id, ws, 'create_document', {
    title: 'Imported',
    content: `Before\n\n${uploaded.markdown}\n\nAfter`,
  });
  const body = await call(agent.id, ws, 'read_document', {
    docId: doc.docId,
  });
  t.true(body.includes(`blob://${uploaded.key}`));
});

e2e('an agent files only its granted docs into folders', async t => {
  const owner = await app.signup();
  const workspace = await app.create(Mockers.Workspace, {
    owner: { id: owner.id },
    snapshot: true,
  });
  const ws = workspace.id;
  const agent = await app.models.workspace.provisionAgent(ws);

  const hidden = await call(owner.id, ws, 'create_document', {
    title: 'Hidden',
    content: 'x',
  });
  const readable = await call(owner.id, ws, 'create_document', {
    title: 'Readable',
    content: 'x',
  });
  await app.models.docUser.set(ws, readable.docId, agent.id, DocRole.Reader);
  const ownerFolder = await call(owner.id, ws, 'create_folder', {
    name: 'Board',
  });
  const hiddenLink = await call(owner.id, ws, 'add_to_folder', {
    folder_id: ownerFolder.folderId,
    target_id: hidden.docId,
  });

  const events = await call(agent.id, ws, 'create_folder', { name: 'Events' });
  const workshop = await call(agent.id, ws, 'create_folder', {
    name: 'Workshop',
    parent_id: events.folderId,
  });
  const mine = await call(agent.id, ws, 'create_document', {
    title: 'Programme',
    content: 'x',
    folder_id: workshop.folderId,
  });
  await call(agent.id, ws, 'add_to_folder', {
    folder_id: workshop.folderId,
    target_id: readable.docId,
  });

  // Ungranted docs: cannot be filed, moved or unfiled, and are never listed.
  t.true(
    (
      await callTool(agent.id, ws, 'add_to_folder', {
        folder_id: workshop.folderId,
        target_id: hidden.docId,
      })
    ).isError
  );
  t.true(
    (
      await callTool(agent.id, ws, 'move_folder_item', {
        item_id: hiddenLink.linkId,
        parent_id: workshop.folderId,
      })
    ).isError
  );
  t.true(
    (
      await callTool(agent.id, ws, 'remove_from_folder', {
        link_id: hiddenLink.linkId,
      })
    ).isError
  );
  const tree = await call(agent.id, ws, 'list_folders', {});
  const text = JSON.stringify(tree);
  t.false(text.includes(hidden.docId));
  t.false(text.includes('Hidden'));
  t.true(text.includes('Board'), 'folder names are visible');
  t.true(text.includes(mine.docId));

  // Folders themselves are free to rename and move.
  await call(agent.id, ws, 'rename_folder', {
    folder_id: workshop.folderId,
    name: '2026-11 Workshop',
  });
  await call(agent.id, ws, 'move_folder_item', {
    item_id: workshop.folderId,
  });
  type Tree = {
    folders: Tree[];
    items: { linkId: string; targetId: string }[];
  };
  const links = (nodes: Tree[]): Tree['items'] =>
    nodes.flatMap(node => [...node.items, ...links(node.folders)]);
  const mineLink = links(tree.folders).find(
    item => item.targetId === mine.docId
  );
  t.truthy(mineLink, 'the new doc was filed at creation');
  await call(agent.id, ws, 'remove_from_folder', {
    link_id: mineLink!.linkId,
  });

  // The owner's view is intact: the hidden link is still filed.
  const ownerTree = JSON.stringify(
    await call(owner.id, ws, 'list_folders', {})
  );
  t.true(ownerTree.includes(hidden.docId));
  t.true(ownerTree.includes('2026-11 Workshop'));
});

e2e('a non-member human still cannot create documents', async t => {
  const { workspace } = await ownedWorkspace();
  const outsider = await app.signup();
  const result = await callTool(outsider.id, workspace.id, 'create_document', {
    title: 'Nope',
    content: 'x',
  }).catch(() => ({ isError: true }));
  t.true(result.isError);
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

e2e('titles of ungranted docs never reach an agent', async t => {
  const owner = await app.signup();
  const workspace = await app.create(Mockers.Workspace, {
    owner: { id: owner.id },
    snapshot: true,
  });
  const ws = workspace.id;
  const agent = await app.models.workspace.provisionAgent(ws);

  const secret = await call(owner.id, ws, 'create_document', {
    title: 'Secret board minutes',
    content: 'x',
  });
  const shared = await call(owner.id, ws, 'create_document', {
    title: 'Shared',
    content: `See [Secret board minutes](affine://${secret.docId}).`,
  });
  t.is(shared.linkedPages, 1);
  // Give the reference an alias, as the editor does when a link is renamed;
  // the native reader prints the alias as the link text.
  await app
    .get(WorkspaceYjsMutator)
    .mutate(ws, shared.docId, { editorId: owner.id }, doc => {
      for (const block of doc.getMap<unknown>('blocks').values()) {
        const text = block instanceof Y.Map ? block.get('prop:text') : null;
        if (!(text instanceof Y.Text)) continue;
        let offset = 0;
        for (const op of text.toDelta() as {
          insert: string;
          attributes?: { reference?: Record<string, unknown> };
        }[]) {
          if (op.attributes?.reference) {
            text.format(offset, op.insert.length, {
              reference: { ...op.attributes.reference, title: 'Secret alias' },
            });
          }
          offset += op.insert.length;
        }
      }
    });
  await app.models.docUser.set(ws, shared.docId, agent.id, DocRole.Reader);

  // The owner sees the title...
  const ownerRead = await call(owner.id, ws, 'read_document', {
    docId: shared.docId,
  });
  t.true(ownerRead.includes('Secret board minutes'));

  // ...the agent does not, not even through the reader's own link text.
  const agentRead = await call(agent.id, ws, 'read_document', {
    docId: shared.docId,
  });
  t.false(agentRead.includes('Secret'));
  t.true(agentRead.includes(`[Untitled](affine://${secret.docId})`));
});
