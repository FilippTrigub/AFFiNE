/**
 * Markdown helpers for translation: cut a document into chunks small enough
 * for one model call, and check that a translated chunk kept the structure of
 * its source. Pure functions; no I/O.
 */

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^ {0,3}#{1,6}\s/;
const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s/;
const QUOTE = /^\s*>\s*\S/;
const TABLE_ROW = /^\s*\|/;
const LINK_TARGET = /\[[^\]]*\]\(\s*([^)\s]+)[^)]*\)/g;

export type MarkdownStructure = {
  headings: number;
  listItems: number;
  quotes: number;
  links: number;
  fences: number;
  tableRows: number;
};

/** Lines of `markdown` that sit outside code fences, plus the fence count. */
function scan(markdown: string) {
  const prose: string[] = [];
  let fenceLines = 0;
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (FENCE.test(line)) {
      fenceLines += 1;
      inFence = !inFence;
    } else if (!inFence) {
      prose.push(line);
    }
  }
  return { prose, fences: Math.floor(fenceLines / 2) };
}

function linkTargets(prose: string[]) {
  return prose
    .flatMap(line => [...line.matchAll(LINK_TARGET)].map(match => match[1]))
    .sort();
}

const count = (lines: string[], pattern: RegExp) =>
  lines.filter(line => pattern.test(line)).length;

export function structureOf(markdown: string): MarkdownStructure {
  const { prose, fences } = scan(markdown);
  return {
    headings: count(prose, HEADING),
    listItems: count(prose, LIST_ITEM),
    quotes: count(prose, QUOTE),
    links: linkTargets(prose).length,
    fences,
    tableRows: count(prose, TABLE_ROW),
  };
}

/**
 * True when `translated` has the same block structure as `source` and every
 * link still points where it did. Text inside the links may change.
 */
export function sameStructure(source: string, translated: string) {
  const a = structureOf(source);
  const b = structureOf(translated);
  const keys = Object.keys(a) as (keyof MarkdownStructure)[];
  if (keys.some(key => a[key] !== b[key])) return false;

  const targetsA = linkTargets(scan(source).prose);
  const targetsB = linkTargets(scan(translated).prose);
  return targetsA.every((target, i) => target === targetsB[i]);
}

/** Top-level blocks: separated by blank lines that are not inside a fence. */
function blocksOf(markdown: string) {
  const blocks: string[] = [];
  let current: string[] = [];
  let inFence = false;
  const flush = () => {
    if (current.length) blocks.push(current.join('\n'));
    current = [];
  };
  for (const line of markdown.split('\n')) {
    if (FENCE.test(line)) inFence = !inFence;
    if (!inFence && line.trim() === '' && !FENCE.test(line)) {
      flush();
    } else {
      current.push(line);
    }
  }
  flush();
  return blocks;
}

/**
 * Greedily pack blocks into chunks of at most `maxChars`. A block is never
 * cut, so one larger than the limit becomes a chunk of its own. Blank-line
 * runs between blocks are normalised to one.
 */
export function splitMarkdown(markdown: string, maxChars: number) {
  const chunks: string[] = [];
  let current = '';
  for (const block of blocksOf(markdown)) {
    if (!current) {
      current = block;
    } else if (current.length + 2 + block.length <= maxChars) {
      current = `${current}\n\n${block}`;
    } else {
      chunks.push(current);
      current = block;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export const joinChunks = (chunks: string[]) => chunks.join('\n\n');
