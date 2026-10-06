import { describe, expect, test, vi } from 'vitest';

import { StaticCloudDocStorage } from '../impls/cloud/doc-static';

function storage(publicDocLang?: string) {
  const store = new StaticCloudDocStorage({
    id: 'ws',
    serverBaseUrl: 'https://example.com',
    publicRootDocId: 'doc',
    publicDocLang,
  });
  const fetchArrayBuffer = vi
    .spyOn(store.connection, 'fetchArrayBuffer')
    .mockResolvedValue(new Uint8Array([1]).buffer);
  return { store, fetchArrayBuffer };
}

const requestedPath = (spy: ReturnType<typeof storage>['fetchArrayBuffer']) =>
  spy.mock.calls[0][0];

describe('StaticCloudDocStorage', () => {
  test('loads the shared doc from the public route', async () => {
    const { store, fetchArrayBuffer } = storage();
    await store.getDoc('doc');
    expect(requestedPath(fetchArrayBuffer)).toBe(
      '/api/workspaces/ws/public-docs/doc'
    );
  });

  test('loads the translation of the shared doc when a language is set', async () => {
    const { store, fetchArrayBuffer } = storage('fr');
    await store.getDoc('doc');
    expect(requestedPath(fetchArrayBuffer)).toBe(
      '/api/workspaces/ws/public-docs/doc/translations/fr'
    );
  });

  test('keeps other docs and the root doc untranslated', async () => {
    const { store, fetchArrayBuffer } = storage('fr');
    await store.getDoc('other');
    await store.getDoc('ws');
    expect(fetchArrayBuffer.mock.calls.map(call => call[0])).toEqual([
      '/api/workspaces/ws/public-docs/other',
      '/api/workspaces/ws/public-docs/doc/root-doc',
    ]);
  });
});
