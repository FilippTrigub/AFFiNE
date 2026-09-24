import { generateKeyBetween } from 'fractional-indexing';

/**
 * Server-side port of `generateFractionalIndexingKeyBetween` from
 * `packages/common/infra/src/utils/fractional-indexing.ts`. The sidebar
 * (folders, favorites, pinned collections) orders rows by comparing these keys
 * as plain strings, so keys written by the server must come from the same
 * algorithm as keys written by the client: a fractional key, a `'0'`
 * separator, then 32 random base62 characters.
 */
const RANDOM_SIZE = 32;
const POSTFIX_CHARS =
  '123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function postfix(length = RANDOM_SIZE) {
  const values = new Uint8Array(length);
  crypto.getRandomValues(values);
  let result = '';
  for (let i = 0; i < length; i++) {
    result += POSTFIX_CHARS.charAt(values[i] % POSTFIX_CHARS.length);
  }
  return result;
}

function hasSamePrefix(a: string, b: string) {
  return a.startsWith(b) || b.startsWith(a);
}

function subkey(key: string | null) {
  if (key === null) return null;
  if (key.length <= RANDOM_SIZE + 1) return key;
  return key.substring(0, key.length - RANDOM_SIZE - 1);
}

export function generateFractionalIndexingKeyBetween(
  a: string | null,
  b: string | null
) {
  if (a !== null && b !== null && a >= b) {
    throw new Error('a should be smaller than b');
  }

  const aSubkey = subkey(a);
  const bSubkey = subkey(b);

  if (aSubkey === null && bSubkey === null) {
    return generateKeyBetween(null, null) + '0' + postfix();
  }
  if (aSubkey === null) {
    return generateKeyBetween(null, bSubkey) + '0' + postfix();
  }
  if (bSubkey === null) {
    return generateKeyBetween(aSubkey, null) + '0' + postfix();
  }
  if (hasSamePrefix(aSubkey, bSubkey) && a !== null && b !== null) {
    return generateKeyBetween(a, b) + '0' + postfix();
  }
  return generateKeyBetween(aSubkey, bSubkey) + '0' + postfix();
}

/** A key that sorts after every key in `existing`. */
export function fractionalIndexAfterAll(existing: Iterable<string>) {
  let max: string | null = null;
  for (const key of existing) {
    if (max === null || key > max) max = key;
  }
  return generateFractionalIndexingKeyBetween(max, null);
}

/** A key that sorts before every key in `existing`. */
export function fractionalIndexBeforeAll(existing: Iterable<string>) {
  let min: string | null = null;
  for (const key of existing) {
    if (min === null || key < min) min = key;
  }
  return generateFractionalIndexingKeyBetween(null, min);
}
