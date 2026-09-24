import { e2e } from '../test';
import { call, callTool, enableMcp, loadYDoc, ownedWorkspace } from './utils';

e2e.before(() => {
  enableMcp();
});

e2e('folders: build, file, move and unlink', async t => {
  const { owner, workspace } = await ownedWorkspace();
  const ws = workspace.id;
  const workshops = await call(owner.id, ws, 'create_folder', {
    name: 'Workshops',
  });
  const day = await call(owner.id, ws, 'create_folder', {
    name: '26-09',
    parent_id: workshops.folderId,
  });
  const again = await call(owner.id, ws, 'create_folder', {
    name: 'Workshops',
  });
  t.is(again.folderId, workshops.folderId);
  t.false(again.created);

  const doc = await call(owner.id, ws, 'create_document', {
    title: 'Guest list',
    content: 'x',
    folder_id: day.folderId,
  });

  // The raw row is in the client ORM layout.
  const raw = (await loadYDoc(ws, `db$${ws}$folders`)).getMap(
    workshops.folderId
  );
  t.is(raw.get('type'), 'folder');
  t.is(raw.get('data'), 'Workshops');
  t.is(raw.get('parentId'), null);
  t.regex(String(raw.get('index')), /0[1-9A-Za-z]{32}$/);

  let tree = await call(owner.id, ws, 'list_folders', {});
  t.is(tree.folders.length, 1);
  t.is(tree.folders[0].name, 'Workshops');
  const sub = tree.folders[0].folders[0];
  t.is(sub.name, '26-09');
  t.is(sub.items[0].targetId, doc.docId);
  t.is(sub.items[0].title, 'Guest list');

  const info = await call(owner.id, ws, 'get_document_info', {
    docId: doc.docId,
  });
  t.deepEqual(info.folders, [['Workshops', '26-09']]);

  // Moves obey the sidebar rules.
  t.true(
    (
      await callTool(owner.id, ws, 'move_folder_item', {
        item_id: workshops.folderId,
        parent_id: day.folderId,
      })
    ).isError
  );
  t.true(
    (
      await callTool(owner.id, ws, 'move_folder_item', {
        item_id: sub.items[0].linkId,
      })
    ).isError
  );
  await call(owner.id, ws, 'move_folder_item', {
    item_id: sub.items[0].linkId,
    parent_id: workshops.folderId,
    position: 'first',
  });
  tree = await call(owner.id, ws, 'list_folders', {});
  t.is(tree.folders[0].items[0].targetId, doc.docId);
  t.is(tree.folders[0].folders[0].items.length, 0);

  await call(owner.id, ws, 'rename_folder', {
    folder_id: day.folderId,
    name: '2026-09-26',
  });
  await call(owner.id, ws, 'remove_from_folder', {
    link_id: tree.folders[0].items[0].linkId,
  });
  tree = await call(owner.id, ws, 'list_folders', {});
  t.is(tree.folders[0].items.length, 0);
  t.is(tree.folders[0].folders[0].name, '2026-09-26');

  // Folders themselves cannot be unlinked.
  t.true(
    (
      await callTool(owner.id, ws, 'remove_from_folder', {
        link_id: day.folderId,
      })
    ).isError
  );
});

e2e('tags: create, assign, filter, rename', async t => {
  const { owner, workspace } = await ownedWorkspace();
  const ws = workspace.id;
  const tag = await call(owner.id, ws, 'create_tag', {
    name: 'Security',
    color: 'red',
  });
  const dup = await call(owner.id, ws, 'create_tag', { name: 'security' });
  t.is(dup.tagId, tag.tagId);

  const doc = await call(owner.id, ws, 'create_document', {
    title: 'Screening',
    content: 'x',
    tags: ['Security'],
  });
  const other = await call(owner.id, ws, 'create_document', {
    title: 'Other',
    content: 'x',
  });

  const unknown = await callTool(owner.id, ws, 'set_document_tags', {
    docId: other.docId,
    add: ['GDPR'],
  });
  t.true(unknown.isError);
  const tagged = await call(owner.id, ws, 'set_document_tags', {
    docId: other.docId,
    add: ['GDPR', tag.tagId],
    create_missing: true,
  });
  t.deepEqual(
    tagged.tags.sort((x: string, y: string) => x.localeCompare(y)),
    ['GDPR', 'Security']
  );

  const filtered = await call(owner.id, ws, 'list_documents', {
    tag: 'security',
  });
  t.deepEqual(
    filtered.documents
      .map((d: { id: string }) => d.id)
      .sort((x: string, y: string) => x.localeCompare(y)),
    [doc.docId, other.docId].sort((x: string, y: string) => x.localeCompare(y))
  );

  await call(owner.id, ws, 'set_document_tags', {
    docId: other.docId,
    remove: ['Security'],
  });
  await call(owner.id, ws, 'update_tag', {
    tag_id: tag.tagId,
    name: 'Event security',
    color: 'blue',
  });
  const tags = await call(owner.id, ws, 'list_tags', {});
  const renamed = tags.tags.find((t: { id: string }) => t.id === tag.tagId);
  t.is(renamed.name, 'Event security');
  t.is(renamed.color, 'blue');
  t.is(renamed.documents, 1);

  // Duplicates carry tags over.
  const copy = await call(owner.id, ws, 'duplicate_document', {
    docId: doc.docId,
  });
  const copyInfo = await call(owner.id, ws, 'get_document_info', {
    docId: copy.docId,
  });
  t.deepEqual(
    copyInfo.tags.map((t: { name: string }) => t.name),
    ['Event security']
  );
});

e2e('collections: create, update, pin', async t => {
  const { owner, workspace } = await ownedWorkspace();
  const ws = workspace.id;
  const a = await call(owner.id, ws, 'create_document', {
    title: 'A',
    content: 'x',
  });
  const b = await call(owner.id, ws, 'create_document', {
    title: 'B',
    content: 'x',
  });
  const created = await call(owner.id, ws, 'create_collection', {
    name: 'Event',
    doc_ids: [a.docId],
    filters: [
      { type: 'system', key: 'title', method: 'match', value: 'Event' },
    ],
  });
  t.true(
    (
      await callTool(owner.id, ws, 'create_collection', {
        name: 'Bad',
        doc_ids: ['missing'],
      })
    ).isError
  );
  const updated = await call(owner.id, ws, 'update_collection', {
    collection_id: created.collectionId,
    add_docs: [b.docId],
    remove_docs: [a.docId],
    name: 'Event 26-09',
  });
  t.deepEqual(updated.documents, [b.docId]);

  await call(owner.id, ws, 'pin_collection', {
    collection_id: created.collectionId,
  });
  let list = await call(owner.id, ws, 'list_collections', {});
  t.is(list.collections[0].name, 'Event 26-09');
  t.true(list.collections[0].pinned);
  t.is(list.collections[0].filters[0].key, 'title');

  await call(owner.id, ws, 'unpin_collection', {
    collection_id: created.collectionId,
  });
  list = await call(owner.id, ws, 'list_collections', {});
  t.false(list.collections[0].pinned);

  // A collection can be filed into a folder.
  const folder = await call(owner.id, ws, 'create_folder', { name: 'Views' });
  await call(owner.id, ws, 'add_to_folder', {
    folder_id: folder.folderId,
    type: 'collection',
    target_id: created.collectionId,
  });
  const tree = await call(owner.id, ws, 'list_folders', {});
  t.is(tree.folders[0].items[0].title, 'Event 26-09');
});

e2e('favorites, icons and custom properties', async t => {
  const { owner, workspace } = await ownedWorkspace();
  const ws = workspace.id;
  const doc = await call(owner.id, ws, 'create_document', {
    title: 'Fav',
    content: 'x',
  });

  await call(owner.id, ws, 'add_favorite', {
    target_type: 'doc',
    target_id: doc.docId,
  });
  let favorites = await call(owner.id, ws, 'list_favorites', {});
  t.deepEqual(favorites.favorites, [{ type: 'doc', id: doc.docId }]);
  await call(owner.id, ws, 'remove_favorite', {
    target_type: 'doc',
    target_id: doc.docId,
  });
  favorites = await call(owner.id, ws, 'list_favorites', {});
  t.deepEqual(favorites.favorites, []);

  await call(owner.id, ws, 'set_icon', {
    target_type: 'doc',
    target_id: doc.docId,
    emoji: '🛡️',
  });
  const icons = await loadYDoc(ws, `db$${ws}$explorerIcon`);
  t.deepEqual(icons.getMap(`doc:${doc.docId}`).get('icon'), {
    type: 'emoji',
    unicode: '🛡️',
  });

  const property = await call(owner.id, ws, 'create_custom_property', {
    name: 'Screened',
    type: 'checkbox',
  });
  await call(owner.id, ws, 'update_custom_property', {
    property_id: property.propertyId,
    name: 'Screened by security',
  });
  const props = await call(owner.id, ws, 'list_custom_properties', {});
  t.is(props.properties[0].name, 'Screened by security');

  await call(owner.id, ws, 'set_document_properties', {
    docId: doc.docId,
    custom: { [property.propertyId]: 'true' },
  });
  const info = await call(owner.id, ws, 'get_document_info', {
    docId: doc.docId,
  });
  t.deepEqual(info.customProperties, { [property.propertyId]: 'true' });
});
