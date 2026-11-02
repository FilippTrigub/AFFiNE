import test from 'ava';
import * as Y from 'yjs';

import { createDocWithMarkdown, parseYDocToMarkdown } from '../../../native';
import { blockSentinel, updateDocKeepingBlocks } from '../preserve-blocks';

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
function update(doc: Y.Doc, markdown: string, keepDatabases = false) {
  const delta = updateDocKeepingBlocks(
    Buffer.from(Y.encodeStateAsUpdate(doc)),
    markdown,
    DOC_ID,
    { keepDatabases }
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

test('a database block is refused unless the caller keeps databases', t => {
  const doc = pageWith([{ flavour: 'affine:database', at: 1 }]);
  t.throws(() => update(doc, 'Intro\n'), { message: /unsupported/i });
});

test('keepDatabases keeps a database and its rows untouched', t => {
  const doc = pageWith([{ flavour: 'affine:database', at: 1 }]);
  const blocks = blocksOf(doc);
  doc.transact(() => {
    const row = new Y.Map<unknown>();
    row.set('sys:id', 'extra-row');
    row.set('sys:flavour', 'affine:paragraph');
    row.set('sys:children', new Y.Array());
    row.set('prop:type', 'text');
    row.set('prop:text', new Y.Text('2H ENERGY'));
    blocks.set('extra-row', row);
    childrenOf(blocks.get('extra0')!).push(['extra-row']);
  });

  const { replica, events, stillLive } = update(doc, 'Intro\n\nNew\n', true);
  t.deepEqual(outline(replica), [
    'paragraph:Intro',
    'database',
    'paragraph:New',
  ]);
  t.deepEqual(events, []);
  t.true(stillLive);
  const row = blocksOf(replica).get('extra-row')!;
  t.is((row.get('prop:text') as Y.Text).toString(), '2H ENERGY');
  t.deepEqual(childrenOf(blocksOf(replica).get('extra0')!).toArray(), [
    'extra-row',
  ]);
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

test('a database marker places the database where the markdown has it', t => {
  const doc = pageWith([{ flavour: 'affine:database', at: 1 }]);
  const marker = blockSentinel('extra0');
  const cases: [string, string[]][] = [
    // Text written after the marker lands after the database.
    [
      `Intro\n\n${marker}\n\nNew\n\n${BODY.slice('Intro\n\n'.length)}`,
      [
        'paragraph:Intro',
        'database',
        'paragraph:New',
        'table',
        'paragraph:Outro',
      ],
    ],
    // Moving the marker moves the database.
    [`Outro\n\n${marker}\n`, ['paragraph:Outro', 'database']],
    [
      `${marker}\n\nIntro\n\nOutro\n`,
      ['database', 'paragraph:Intro', 'paragraph:Outro'],
    ],
    // No marker: it stays after the block that preceded it.
    ['Intro\n\nOutro\n', ['paragraph:Intro', 'database', 'paragraph:Outro']],
  ];
  for (const [markdown, expected] of cases) {
    const { replica, events, stillLive } = update(doc, markdown, true);
    t.deepEqual(outline(replica), expected, markdown);
    t.deepEqual(events, [], markdown);
    t.true(stillLive, markdown);
    // Nothing in the delta waits on structs this doc never gets.
    t.is(replica.store.pendingStructs, null, markdown);
    t.is(replica.store.pendingDs, null, markdown);
    t.false(
      [...blocksOf(replica).values()].some(block =>
        String(block.get('prop:text') ?? '').startsWith('AFFINEMCPBLOCK')
      ),
      markdown
    );
  }
});

test('a sentinel glued to a paragraph never shows up as text', t => {
  const doc = pageWith([{ flavour: 'affine:database', at: 1 }]);
  const marker = blockSentinel('extra0');
  for (const markdown of [
    `Intro\n${marker}\nOutro\n`,
    `Intro ${marker} more\n\nOutro\n`,
    `- item\n${marker}\n`,
  ]) {
    const { replica, events, stillLive } = update(doc, markdown, true);
    t.true(outline(replica).includes('database'), markdown);
    t.deepEqual(events, [], markdown);
    t.true(stillLive, markdown);
    t.false(
      [...blocksOf(replica).values()].some(block =>
        String(block.get('prop:text') ?? '').includes('AFFINEMCPBLOCK')
      ),
      markdown
    );
    t.is(replica.store.pendingStructs, null, markdown);
  }
});
