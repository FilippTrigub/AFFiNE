import * as Y from 'yjs';

const CELL_TEXT = /^prop:cells\.[^.]+\.text$/;

/**
 * Turn table cells stored as plain strings into rich text.
 *
 * `affine_doc_loader` 0.1.8 writes each markdown table cell as a string, but
 * the editor's table block expects a `Text` per cell (`TableCell.text`) and
 * renders a string cell as empty. 0.1.10 fixes this upstream
 * (`text_ops_from_plain`); remove this once the crate is bumped.
 */
export function textifyTableCells(doc: Y.Doc) {
  let converted = 0;
  for (const block of doc.getMap<unknown>('blocks').values()) {
    if (!(block instanceof Y.Map)) continue;
    if (block.get('sys:flavour') !== 'affine:table') continue;
    const plain = new Map<string, string>();
    for (const [key, value] of block.entries()) {
      if (CELL_TEXT.test(key) && typeof value === 'string') {
        plain.set(key, value);
      }
    }
    for (const [key, value] of plain) block.set(key, new Y.Text(value));
    converted += plain.size;
  }
  return converted;
}
