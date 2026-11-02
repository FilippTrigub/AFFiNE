import test from 'ava';
import * as Y from 'yjs';

import { createDocWithMarkdown, parseYDocToMarkdown } from '../../../native';
import { updateDocKeepingBlocks } from '../preserve-blocks';

const DOC_ID = 'preserve-blocks-doc';
const BODY = 'Intro\n\n|a|b|\n|---|---|\n|1|2|\n\nOutro\n';

type Blocks = Y.Map<Y.Map<unknown>>;

function blocksOf(doc: Y.Doc) {
  return doc.getMap('blocks') as Blocks;
}

function noteOf(doc: Y.Doc) {
  for (const block of blocksOf(doc).values()) {
    if (block.get('sys:flavour') === 'affine:note') return block;
  }
  throw new Error('no note');
}

function childrenOf(block: Y.Map<unknown>) {
  return block.get('sys:children') as Y.Array<string>;
}

/** A page built from markdown, plus blocks markdown cannot represent. */
function pageWith(
  extras: { flavour: string; at: number; props?: Record<string, unknown> }[]
) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, createDocWithMarkdown('T', BODY, DOC_ID));
  const blocks = blocksOf(doc);
  const note = noteOf(doc);
  doc.transact(() => {
    extras.forEach(({ flavour, at, props }, i) => {
      const id = `extra${i}`;
      const block = new Y.Map<unknown>();
      block.set('sys:id', id);
      block.set('sys:flavour', flavour);
      block.set('sys:version', 1);
      block.set('sys:children', new Y.Array());
      for (const [key, value] of Object.entries(props ?? {})) {
        block.set(key, value);
      }
      blocks.set(id, block);
      childrenOf(note).insert(at, [id]);
    });
  });
  return doc;
}

/** Note children as `flavour` or `flavour:text`, from a fresh replica. */
function outline(doc: Y.Doc) {
  const blocks = blocksOf(doc);
  return childrenOf(noteOf(doc))
    .toArray()
    .map(id => {
      const block = blocks.get(id);
      if (!block) return `missing:${id}`;
      const flavour = String(block.get('sys:flavour')).replace('affine:', '');
      const text = block.get('prop:text');
      return text instanceof Y.Text ? `${flavour}:${text.toString()}` : flavour;
    });
}

/**
 * Apply the update to a replica that already has the doc open, as another
 * client would, and record what it saw happen to the extra blocks.
 */
function update(doc: Y.Doc, markdown: string) {
  const delta = updateDocKeepingBlocks(
    Buffer.from(Y.encodeStateAsUpdate(doc)),
    markdown,
    DOC_ID
  );
  const replica = new Y.Doc();
  Y.applyUpdate(replica, Y.encodeStateAsUpdate(doc));
  const blocks = blocksOf(replica);
  const live = new Map([...blocks].filter(([id]) => id.startsWith('extra')));
  const events: string[] = [];
  blocks.observe(event => {
    event.keys.forEach((change, id) => {
      if (id.startsWith('extra')) events.push(`${id}:${change.action}`);
    });
  });
  Y.applyUpdate(replica, delta);
  const stillLive = [...live].every(([id, block]) => blocks.get(id) === block);
  return { replica, events, stillLive };
}

const ATTACHMENT = {
  flavour: 'affine:attachment',
  at: 1,
  props: { 'prop:name': 'list.csv', 'prop:sourceId': 'blob-key' },
};

test('a doc without such blocks updates exactly as before', t => {
  const doc = pageWith([]);
  const { replica: result } = update(doc, 'Intro\n\nChanged\n');
  t.deepEqual(outline(result), ['paragraph:Intro', 'paragraph:Changed']);
});

test('replacing the table keeps the attachment, its id and props', t => {
  const doc = pageWith([ATTACHMENT]);
  const { replica: result } = update(
    doc,
    'Intro\n\n|x|y|z|\n|---|---|---|\n|1|2|3|\n\nOutro\n'
  );
  t.deepEqual(outline(result), [
    'paragraph:Intro',
    'attachment',
    'table',
    'paragraph:Outro',
  ]);
  const attachment = blocksOf(result).get('extra0')!;
  t.is(attachment.get('prop:name'), 'list.csv');
  t.is(attachment.get('prop:sourceId'), 'blob-key');
  t.is(attachment.get('sys:id'), 'extra0');

  const read = parseYDocToMarkdown(
    Buffer.from(Y.encodeStateAsUpdate(result)),
    DOC_ID
  );
  t.true(read.markdown.includes('|x|y|z|'));
});

test('deleting the block before the attachment keeps the attachment first', t => {
  const doc = pageWith([ATTACHMENT]);
  const { replica: result } = update(doc, '|a|b|\n|---|---|\n|1|2|\n\nOutro\n');
  t.deepEqual(outline(result), ['attachment', 'table', 'paragraph:Outro']);
});

test('a block inserted after the anchor lands after the attachment', t => {
  const doc = pageWith([ATTACHMENT]);
  const { replica: result } = update(
    doc,
    `Intro\n\nNew\n\n${BODY.slice('Intro\n\n'.length)}`
  );
  t.deepEqual(outline(result), [
    'paragraph:Intro',
    'attachment',
    'paragraph:New',
    'table',
    'paragraph:Outro',
  ]);
});

test('replacing everything keeps every preserved block, in order', t => {
  const doc = pageWith([
    ATTACHMENT,
    {
      flavour: 'affine:embed-linked-doc',
      at: 2,
      props: { 'prop:pageId': 'p' },
    },
    { flavour: 'affine:latex', at: 4, props: { 'prop:latex': 'x^2' } },
  ]);
  const { replica: result } = update(doc, 'Only this\n');
  t.deepEqual(outline(result), [
    'attachment',
    'embed-linked-doc',
    'latex',
    'paragraph:Only this',
  ]);
  t.is(blocksOf(result).get('extra2')!.get('prop:latex'), 'x^2');
});

test('open editors keep the same live block: it is never re-created', t => {
  const caption = new Y.Text();
  caption.insert(0, 'a caption');
  const doc = pageWith([
    { ...ATTACHMENT, props: { 'prop:caption': caption } },
    { flavour: 'affine:latex', at: 3, props: { 'prop:latex': 'x^2' } },
  ]);
  for (const markdown of [
    'Intro\n\nOutro\n',
    'Only this\n',
    'Intro\n\nNew\n\n|a|b|\n|---|---|\n|1|2|\n\nOutro\n',
    BODY,
  ]) {
    const { replica, events, stillLive } = update(doc, markdown);
    t.deepEqual(events, [], markdown);
    t.true(stillLive, markdown);
    const kept = blocksOf(replica).get('extra0')!.get('prop:caption');
    t.is((kept as Y.Text).toString(), 'a caption');
  }
});

test('a no-op update changes nothing', t => {
  const doc = pageWith([ATTACHMENT]);
  const { replica } = update(doc, BODY);
  t.deepEqual(outline(replica), [
    'paragraph:Intro',
    'attachment',
    'table',
    'paragraph:Outro',
  ]);
});

test('a database block is still refused', t => {
  const doc = pageWith([{ flavour: 'affine:database', at: 1 }]);
  t.throws(() => update(doc, 'Intro\n'), { message: /unsupported/i });
});

test('an attachment inside a deleted list item moves up to the note', t => {
  const doc = new Y.Doc();
  Y.applyUpdate(
    doc,
    createDocWithMarkdown('T', 'Intro\n\n- item\n\nOutro\n', DOC_ID)
  );
  const blocks = blocksOf(doc);
  const item = [...blocks.values()].find(
    block => block.get('sys:flavour') === 'affine:list'
  )!;
  doc.transact(() => {
    const attachment = new Y.Map<unknown>();
    attachment.set('sys:id', 'extra0');
    attachment.set('sys:flavour', 'affine:attachment');
    attachment.set('sys:children', new Y.Array());
    blocks.set('extra0', attachment);
    childrenOf(item).insert(0, ['extra0']);
  });

  const { replica, events, stillLive } = update(doc, 'Intro\n\nOutro\n');
  t.deepEqual(outline(replica), [
    'paragraph:Intro',
    'attachment',
    'paragraph:Outro',
  ]);
  t.deepEqual(events, []);
  t.true(stillLive);
});
