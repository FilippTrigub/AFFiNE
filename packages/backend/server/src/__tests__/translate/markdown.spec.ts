import test from 'ava';

import {
  joinChunks,
  sameStructure,
  splitMarkdown,
  structureOf,
} from '../../plugins/translate/markdown';

test('splitMarkdown keeps short documents in one chunk', t => {
  t.deepEqual(splitMarkdown('# Title\n\nHello.', 1000), ['# Title\n\nHello.']);
});

test('splitMarkdown splits on blank lines between top-level blocks', t => {
  const md = ['a'.repeat(30), 'b'.repeat(30), 'c'.repeat(30)].join('\n\n');
  const chunks = splitMarkdown(md, 70);
  t.is(chunks.length, 2);
  t.is(joinChunks(chunks), md);
});

test('splitMarkdown never cuts inside a code fence', t => {
  const fence = '```js\nconst a = 1;\n\nconst b = 2;\n```';
  const md = `${'x'.repeat(40)}\n\n${fence}\n\n${'y'.repeat(40)}`;
  const chunks = splitMarkdown(md, 50);
  t.true(chunks.some(chunk => chunk.includes(fence)));
  for (const chunk of chunks) {
    t.is((chunk.match(/^```/gm) ?? []).length % 2, 0);
  }
  t.is(joinChunks(chunks), md);
});

test('splitMarkdown keeps an oversized block whole', t => {
  const big = 'z'.repeat(200);
  t.deepEqual(splitMarkdown(big, 50), [big]);
});

test('structureOf counts the markdown features a translation must keep', t => {
  const md = [
    '# One',
    '## Two',
    '- a',
    '- b',
    '1. c',
    '> quote',
    '[x](https://e.com) and [y](affine://abc)',
    '```',
    'code',
    '```',
    '|a|b|',
    '|---|---|',
    '|1|2|',
  ].join('\n');
  t.deepEqual(structureOf(md), {
    headings: 2,
    listItems: 3,
    quotes: 1,
    links: 2,
    fences: 1,
    tableRows: 3,
  });
});

test('sameStructure accepts a faithful translation', t => {
  const src = '# Hello\n\n- one\n- two\n\nSee [docs](https://e.com).';
  const out = '# Bonjour\n\n- un\n- deux\n\nVoir [la doc](https://e.com).';
  t.true(sameStructure(src, out));
});

test('sameStructure rejects dropped or added structure', t => {
  const src = '# Hello\n\n- one\n- two\n\nSee [docs](https://e.com).';
  t.false(
    sameStructure(src, '# Bonjour\n\n- un\n\nVoir [la doc](https://e.com).')
  );
  t.false(sameStructure(src, '# Bonjour\n\n- un\n- deux\n\nVoir la doc.'));
});

test('sameStructure rejects a changed link target', t => {
  const src = 'See [docs](https://e.com).';
  t.false(sameStructure(src, 'Voir [la doc](https://evil.com).'));
});
