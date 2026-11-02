import * as Y from 'yjs';

import { updateDocWithMarkdown } from '../../native';

/**
 * Blocks markdown cannot represent but a markdown update can safely leave
 * alone: leaves the native updater refuses (`affine_doc_loader` knows only the
 * flavours markdown round-trips). Database blocks are deliberately not here:
 * the reader renders them as a markdown table, so writing that back would add
 * a second, plain table next to the database.
 */
export const PRESERVED_FLAVOURS = new Set([
  'affine:attachment',
  'affine:embed-linked-doc',
  'affine:embed-synced-doc',
  'affine:latex',
]);

type Block = Y.Map<unknown>;
type Blocks = Y.Map<Block>;
type Range = { clock: number; len: number };
type DeleteSet = ReturnType<typeof Y.createDeleteSet>;

type Placement = { parentId: string; before: string[] };

type Preserved = {
  id: string;
  /** Immediate parent first, then each ancestor up to the note. */
  placements: Placement[];
};

const flavourOf = (block: Block | undefined) =>
  block?.get('sys:flavour') as string | undefined;

const childArray = (block: Block | undefined) => {
  const children = block?.get('sys:children');
  return children instanceof Y.Array ? (children as Y.Array<string>) : null;
};

const childIds = (block: Block | undefined) =>
  childArray(block)?.toArray() ?? [];

/** The note the native updater edits: the page's first note child. */
function contentNoteId(blocks: Blocks) {
  for (const block of blocks.values()) {
    if (flavourOf(block) !== 'affine:page') continue;
    return childIds(block).find(
      id => flavourOf(blocks.get(id)) === 'affine:note'
    );
  }
  return undefined;
}

/** Preserved blocks under the content note, in document order. */
function collectPreserved(blocks: Blocks, noteId: string) {
  const found: Preserved[] = [];
  const walk = (parentId: string, ancestors: Placement[]) => {
    const ids = childIds(blocks.get(parentId));
    ids.forEach((id, index) => {
      const placement = { parentId, before: ids.slice(0, index).reverse() };
      const block = blocks.get(id);
      if (block && PRESERVED_FLAVOURS.has(flavourOf(block) ?? '')) {
        found.push({ id, placements: [placement, ...ancestors] });
      } else {
        walk(id, [placement, ...ancestors]);
      }
    });
  };
  walk(noteId, []);
  return found;
}

function subtractRanges(ranges: Range[], cut: Range[]) {
  let out = ranges.map(r => [r.clock, r.clock + r.len] as const);
  for (const { clock, len } of cut) {
    const [start, end] = [clock, clock + len];
    out = out.flatMap(([s, e]) =>
      e <= start || s >= end
        ? [[s, e] as const]
        : (
            [
              [s, Math.min(e, start)],
              [Math.max(s, end), e],
            ] as const
          ).filter(([a, b]) => b > a)
    );
  }
  return out.map(([s, e]) => ({ clock: s, len: e - s }));
}

/**
 * Re-encode a v1 update without the deletions in `cut`. Yjs updates always
 * carry the whole delete set, so the native delta would otherwise delete the
 * blocks hidden from it. (In v1, `writeClient`, `writeDsClock` and
 * `writeDsLen` all write a plain varUint, which is also how counts and clocks
 * are encoded.)
 */
function withoutDeletions(update: Uint8Array, cut: DeleteSet) {
  const { structs, ds } = Y.decodeUpdate(update);
  const encoder = new Y.UpdateEncoderV1();
  const varUint = (n: number) => encoder.writeDsLen(n);

  const byClient = new Map<number, typeof structs>();
  for (const struct of structs) {
    const list = byClient.get(struct.id.client) ?? [];
    list.push(struct);
    byClient.set(struct.id.client, list);
  }
  varUint(byClient.size);
  for (const [client, list] of [...byClient].sort((a, b) => b[0] - a[0])) {
    list.sort((a, b) => a.id.clock - b.id.clock);
    varUint(list.length);
    encoder.writeClient(client);
    varUint(list[0].id.clock);
    for (const struct of list) struct.write(encoder, 0);
  }

  const deletes = [...ds.clients]
    .map(
      ([client, items]) =>
        [client, subtractRanges(items, cut.clients.get(client) ?? [])] as const
    )
    .filter(([, ranges]) => ranges.length);
  varUint(deletes.length);
  for (const [client, ranges] of deletes.sort((a, b) => b[0] - a[0])) {
    encoder.resetDsCurVal();
    encoder.writeClient(client);
    varUint(ranges.length);
    for (const range of ranges) {
      encoder.writeDsClock(range.clock);
      encoder.writeDsLen(range.len);
    }
  }
  return encoder.toUint8Array();
}

/**
 * Put a preserved block's id back into a child list when the native updater
 * rebuilt that list without it. Only the id string moves: the block's own map
 * is never touched, so editors that have it open keep a live model.
 */
function relink(blocks: Blocks, { id, placements }: Preserved) {
  for (const { parentId, before } of placements) {
    const children = childArray(blocks.get(parentId));
    if (!children) continue;
    const current = children.toArray();
    if (current.includes(id)) return;
    const anchor = before.find(sibling => current.includes(sibling));
    children.insert(anchor ? current.indexOf(anchor) + 1 : 0, [id]);
    return;
  }
}

/**
 * `updateDocWithMarkdown`, except that blocks in {@link PRESERVED_FLAVOURS}
 * no longer make it refuse the doc: they stay where they are, untouched.
 *
 * The native updater runs on a copy with those blocks removed; the removal is
 * then stripped from its delta. When the updater rebuilt a child list, the
 * preserved ids are put back next to the block that preceded them.
 */
export function updateDocKeepingBlocks(
  existing: Buffer,
  markdown: string,
  docId: string
): Buffer {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, existing);
  try {
    const blocks = doc.getMap('blocks') as Blocks;
    const noteId = contentNoteId(blocks);
    const preserved = noteId ? collectPreserved(blocks, noteId) : [];
    if (!preserved.length) {
      return updateDocWithMarkdown(existing, markdown, docId);
    }

    const masked = new Y.Doc();
    let delta: Buffer;
    let cut: DeleteSet | undefined;
    try {
      Y.applyUpdate(masked, existing);
      const maskedBlocks = masked.getMap('blocks') as Blocks;
      masked.once('afterTransaction', (transaction: Y.Transaction) => {
        cut = transaction.deleteSet;
      });
      masked.transact(() => {
        for (const { id, placements } of preserved) {
          const children = childArray(maskedBlocks.get(placements[0].parentId));
          if (!children) throw new Error(`parent of block ${id} not found`);
          children.delete(children.toArray().indexOf(id), 1);
          maskedBlocks.delete(id);
        }
      });
      delta = updateDocWithMarkdown(
        Buffer.from(Y.encodeStateAsUpdate(masked)),
        markdown,
        docId
      );
    } finally {
      masked.destroy();
    }
    if (!cut) throw new Error('masking transaction did not run');

    const before = Y.encodeStateVector(doc);
    // Separate transactions: applying a remote update inside a local one marks
    // it remote, and Yjs would then reassign this doc's client id.
    Y.applyUpdate(doc, withoutDeletions(delta, cut));
    doc.transact(() => {
      for (const block of preserved) relink(blocks, block);
    });
    return Buffer.from(Y.encodeStateAsUpdate(doc, before));
  } finally {
    doc.destroy();
  }
}
