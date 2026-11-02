import * as Y from 'yjs';

import { updateDocWithMarkdown } from '../../native';

/**
 * Blocks markdown cannot represent but a markdown update can safely leave
 * alone: leaves the native updater refuses (`affine_doc_loader` knows only the
 * flavours markdown round-trips). Database blocks are not here by default:
 * the plain reader renders them as a markdown table, so writing that back
 * would add a second, plain table next to the database. Callers whose reader
 * leaves databases out of the markdown (MCP) opt in with `keepDatabases`.
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

export const DATABASE_FLAVOUR = 'affine:database';

export type KeepBlocksOptions = { keepDatabases?: boolean };

/** Preserved blocks under the content note, in document order. */
function collectPreserved(
  blocks: Blocks,
  noteId: string,
  flavours: Set<string>
) {
  const found: Preserved[] = [];
  const walk = (parentId: string, ancestors: Placement[]) => {
    const ids = childIds(blocks.get(parentId));
    ids.forEach((id, index) => {
      const placement = { parentId, before: ids.slice(0, index).reverse() };
      const block = blocks.get(id);
      if (block && flavours.has(flavourOf(block) ?? '')) {
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

type Struct = ReturnType<typeof Y.decodeUpdate>['structs'][number];

/**
 * Structs that build on something only `client` made (the stand-ins of the
 * masked copy), directly or through another such struct. An item names its
 * parent only through its origins when it has them, so all three count.
 */
function tiedTo(structs: Struct[], client: number) {
  const tied = new Set<Struct>();
  const ranges: Range[] = [];
  const isTied = (id: unknown) =>
    id instanceof Y.ID &&
    (id.client === client ||
      ranges.some(
        r =>
          (r as Range & { client: number }).client === id.client &&
          id.clock >= r.clock &&
          id.clock < r.clock + r.len
      ));
  let changed = true;
  while (changed) {
    changed = false;
    for (const struct of structs) {
      if (tied.has(struct) || !(struct instanceof Y.Item)) continue;
      if ([struct.parent, struct.origin, struct.rightOrigin].some(isTied)) {
        tied.add(struct);
        ranges.push({
          client: struct.id.client,
          clock: struct.id.clock,
          len: struct.length,
        } as Range & { client: number });
        changed = true;
      }
    }
  }
  return tied;
}

/**
 * Re-encode a v1 update without the deletions in `cut`, nor any of
 * `maskClient`'s, and with the structs tied to `maskClient` (edits the native
 * updater made to a stand-in, which the real doc does not have) turned into
 * garbage-collected placeholders. Yjs updates always
 * carry the whole delete set, so the native delta would otherwise delete the
 * blocks hidden from it. (In v1, `writeClient`, `writeDsClock` and
 * `writeDsLen` all write a plain varUint, which is also how counts and clocks
 * are encoded.)
 */
function withoutDeletions(
  update: Uint8Array,
  cut: DeleteSet,
  maskClient: number
) {
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
  const tied = tiedTo(structs, maskClient);
  for (const [client, list] of [...byClient].sort((a, b) => b[0] - a[0])) {
    list.sort((a, b) => a.id.clock - b.id.clock);
    varUint(list.length);
    encoder.writeClient(client);
    varUint(list[0].id.clock);
    for (const struct of list) {
      // Same length, so the client's clock range stays whole.
      const out = tied.has(struct)
        ? new Y.GC(struct.id, struct.length)
        : struct;
      out.write(encoder, 0);
    }
  }

  const deletes = [...ds.clients]
    // The stand-ins exist only in the masked copy.
    .filter(([client]) => client !== maskClient)
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

/** A block and everything under it (a database's rows), deepest first. */
function subtree(blocks: Blocks, id: string): string[] {
  return [...childIds(blocks.get(id)).flatMap(c => subtree(blocks, c)), id];
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
 * A line that stands for a kept block in the markdown, so text written before
 * or after it lands before or after the block. Letters and digits only, so
 * markdown never escapes or formats it.
 */
export function blockSentinel(id: string) {
  return `AFFINEMCPBLOCK${Buffer.from(id).toString('hex')}X`;
}
const SENTINEL_TEXT = /^AFFINEMCPBLOCK[0-9a-f]+X$/;
const SENTINEL_ANYWHERE = /AFFINEMCPBLOCK[0-9a-f]+X/g;
const SENTINEL_LINE = /^[ \t]*AFFINEMCPBLOCK[0-9a-f]+X[ \t]*(?:\r?\n|$)/gm;

function sentinelParagraph(id: string) {
  const block = new Y.Map<unknown>();
  block.set('sys:id', id);
  block.set('sys:flavour', 'affine:paragraph');
  block.set('sys:version', 1);
  block.set('sys:children', new Y.Array());
  block.set('prop:type', 'text');
  block.set('prop:text', new Y.Text(blockSentinel(id)));
  return block;
}

const textOf = (block: Block | undefined) => {
  const text = block?.get('prop:text');
  return text instanceof Y.Text ? text.toString() : '';
};

/**
 * Where the markdown put an anchored block's sentinel in a new paragraph (the
 * marker moved), put the block there instead and drop the paragraph. Then drop
 * every sentinel paragraph left over, e.g. one naming a block that is gone.
 */
function settleSentinels(blocks: Blocks, anchored: Set<string>) {
  const parents = new Map<string, string>();
  for (const [id, block] of blocks) {
    for (const child of childIds(block)) parents.set(child, id);
  }
  const strays = new Map<string, string>();
  for (const [id, block] of blocks) {
    const text = textOf(block);
    if (!anchored.has(id) && SENTINEL_TEXT.test(text)) strays.set(id, text);
  }
  for (const [id, text] of strays) {
    const parentId = parents.get(id) ?? '';
    const parent = blocks.get(parentId);
    const children = childArray(parent);
    const target = [...anchored].find(kept => blockSentinel(kept) === text);
    if (children) {
      const index = children.toArray().indexOf(id);
      children.delete(index, 1);
      // A database may only sit in a note; elsewhere relink() places it.
      const fits = flavourOf(parent) === 'affine:note';
      if (target && fits && !parents.has(target)) {
        children.insert(index, [target]);
        parents.set(target, parentId);
      }
    }
    for (const hidden of subtree(blocks, id)) blocks.delete(hidden);
  }
}

/**
 * `updateDocWithMarkdown`, except that blocks in {@link PRESERVED_FLAVOURS}
 * (and databases, with `keepDatabases`) no longer make it refuse the doc:
 * they stay, untouched.
 *
 * The native updater runs on a copy with those blocks removed; the removal is
 * then stripped from its delta. When the updater rebuilt a child list, the
 * preserved ids are put back next to the block that preceded them.
 *
 * A database whose {@link blockSentinel} line is in the markdown is instead
 * stood in for by a paragraph of that text under the database's own id, so the
 * native diff places new text around it exactly as written, and moving the
 * line moves the database. Should the diff edit that stand-in, the update is
 * redone without stand-ins.
 */
export function updateDocKeepingBlocks(
  existing: Buffer,
  markdown: string,
  docId: string,
  options: KeepBlocksOptions = {},
  anchors = true
): Buffer {
  const flavours = options.keepDatabases
    ? new Set([...PRESERVED_FLAVOURS, DATABASE_FLAVOUR])
    : PRESERVED_FLAVOURS;
  const doc = new Y.Doc();
  Y.applyUpdate(doc, existing);
  try {
    const blocks = doc.getMap('blocks') as Blocks;
    const noteId = contentNoteId(blocks);
    const preserved = noteId ? collectPreserved(blocks, noteId, flavours) : [];
    const lines = new Set(markdown.split(/\r?\n/).map(line => line.trim()));
    const anchored = new Set(
      anchors
        ? preserved
            .filter(({ id }) => flavourOf(blocks.get(id)) === DATABASE_FLAVOUR)
            .filter(({ id }) => lines.has(blockSentinel(id)))
            .map(({ id }) => id)
        : []
    );
    if (!anchored.size) {
      markdown = markdown
        .replace(SENTINEL_LINE, '')
        .replace(SENTINEL_ANYWHERE, '');
    }
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
          for (const hidden of subtree(maskedBlocks, id)) {
            maskedBlocks.delete(hidden);
          }
          if (anchored.has(id)) {
            // Keeps the parent's own child-list entry, which the real doc has
            // too, so the delta's positions are valid there.
            maskedBlocks.set(id, sentinelParagraph(id));
          } else {
            children.delete(children.toArray().indexOf(id), 1);
          }
        }
      });
      delta = updateDocWithMarkdown(
        Buffer.from(Y.encodeStateAsUpdate(masked)),
        markdown,
        docId
      );
      // The diff may re-set a stand-in's props, which is harmless, but if it
      // rewrote a stand-in's text into other content, that content would be
      // lost with the stand-in: redo without stand-ins.
      if (anchored.size) {
        Y.applyUpdate(masked, delta);
        const rewritten =
          [...anchored].some(id => {
            const block = maskedBlocks.get(id);
            return block && textOf(block) !== blockSentinel(id);
          }) ||
          // A sentinel merged into other text would stay visible in the doc.
          [...maskedBlocks.values()].some(block => {
            const text = textOf(block);
            return text.includes('AFFINEMCPBLOCK') && !SENTINEL_TEXT.test(text);
          });
        if (rewritten) {
          return updateDocKeepingBlocks(
            existing,
            markdown,
            docId,
            options,
            false
          );
        }
      }
    } finally {
      masked.destroy();
    }
    if (!cut) throw new Error('masking transaction did not run');

    const before = Y.encodeStateVector(doc);
    // Separate transactions: applying a remote update inside a local one marks
    // it remote, and Yjs would then reassign this doc's client id.
    Y.applyUpdate(doc, withoutDeletions(delta, cut, masked.clientID));
    doc.transact(() => {
      settleSentinels(blocks, anchored);
      for (const block of preserved) relink(blocks, block);
    });
    return Buffer.from(Y.encodeStateAsUpdate(doc, before));
  } finally {
    doc.destroy();
  }
}
