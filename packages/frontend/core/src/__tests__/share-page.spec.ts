// @vitest-environment happy-dom

import { UserFriendlyError } from '@affine/error';
import type * as AffineI18n from '@affine/i18n';
import type { WorkerInitOptions } from '@affine/nbstore/worker/client';
import { act, render, waitFor } from '@testing-library/react';
import type * as Infra from '@toeverything/infra';
import { createElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { TimeoutError } from 'rxjs';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { SharePage } from '../desktop/pages/workspace/share/share-page';
import {
  fetchSharedPublishMode,
  fetchSharedTranslations,
  getResolvedPublishMode,
  getSearchWithLang,
  getSearchWithMode,
  isSharePagePermissionError,
  isSharePageTimeoutError,
  parsePublishMode,
} from '../desktop/pages/workspace/share/share-page.utils';

const sharePageMocks = vi.hoisted(() => ({
  services: new Map<string, unknown>(),
}));

vi.mock('@affine/core/desktop/components/app-container', () => ({
  AppContainer: ({ children }: { children: unknown }) => children,
}));

vi.mock('@affine/core/components/hooks/use-block-suite-editor', () => ({
  useActiveBlocksuiteEditor: () => [null, vi.fn()],
}));

vi.mock('@affine/core/components/hooks/use-navigate-helper', () => ({
  useNavigateHelper: () => ({
    jumpToPageBlock: vi.fn(),
    openPage: vi.fn(),
  }),
}));

vi.mock('@affine/i18n', async importOriginal => ({
  ...(await importOriginal<typeof AffineI18n>()),
  useI18n: () => new Proxy({}, { get: () => () => '' }),
}));

vi.mock('@toeverything/infra', async importOriginal => ({
  ...(await importOriginal<typeof Infra>()),
  useLiveData: () => undefined,
  useService: (token: { name: string }) =>
    sharePageMocks.services.get(token.name),
}));

describe('getResolvedPublishMode', () => {
  test.each([
    ['edgeless', 'page', 'edgeless'],
    ['page', 'edgeless', 'page'],
    [null, 'edgeless', 'edgeless'],
    [null, 'page', 'page'],
    [null, null, 'page'],
    [null, undefined, 'page'],
  ] as const)(
    'resolves query %s and published mode %s',
    (query, published, expected) => {
      expect(getResolvedPublishMode(query, published)).toBe(expected);
    }
  );
});

describe('parsePublishMode', () => {
  test.each([
    ['page', 'page'],
    ['edgeless', 'edgeless'],
    ['invalid', null],
    [null, null],
  ] as const)('parses %s', (input, expected) => {
    expect(parsePublishMode(input)).toBe(expected);
  });
});

describe('fetchSharedPublishMode', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('reads publish mode from the HEAD response', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(null, {
        status: 200,
        headers: { 'publish-mode': 'edgeless' },
      })
    );

    await expect(
      fetchSharedPublishMode({
        serverBaseUrl: 'https://app.affine.pro',
        workspaceId: 'workspace-id',
        docId: 'doc-id',
      })
    ).resolves.toBe('edgeless');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL(
        '/api/workspaces/workspace-id/public-docs/doc-id',
        'https://app.affine.pro'
      ),
      expect.objectContaining({ method: 'HEAD' })
    );
  });

  test('falls back to GET when HEAD misses the header', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(
        new Response(null, {
          status: 200,
          headers: { 'publish-mode': 'page' },
        })
      );

    await expect(
      fetchSharedPublishMode({
        serverBaseUrl: 'https://app.affine.pro',
        workspaceId: 'workspace-id',
        docId: 'doc-id',
      })
    ).resolves.toBe('page');
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });
});

describe('fetchSharedTranslations', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('reads the languages a reader can switch to', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        Response.json({ sourceLang: 'en', languages: ['fr', 'de'] })
      );

    await expect(
      fetchSharedTranslations({
        serverBaseUrl: 'https://app.affine.pro',
        workspaceId: 'workspace-id',
        docId: 'doc-id',
      })
    ).resolves.toEqual({ sourceLang: 'en', languages: ['fr', 'de'] });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL(
        '/api/workspaces/workspace-id/public-docs/doc-id/translations',
        'https://app.affine.pro'
      ),
      expect.anything()
    );
  });

  test.each([
    ['an error status', new Response(null, { status: 404 })],
    ['a malformed body', Response.json({ languages: 'fr' })],
  ])('offers nothing on %s', async (_case, response) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response);
    await expect(
      fetchSharedTranslations({
        serverBaseUrl: 'https://app.affine.pro',
        workspaceId: 'workspace-id',
        docId: 'doc-id',
      })
    ).resolves.toEqual({ sourceLang: null, languages: [] });
  });
});

describe('getSearchWithLang', () => {
  test.each([
    ['', 'fr', '?lang=fr'],
    ['?mode=page', 'de', '?mode=page&lang=de'],
    ['?mode=page&lang=de', null, '?mode=page'],
    ['?lang=de', null, ''],
  ] as const)('projects %s with lang %s', (search, lang, expected) => {
    expect(getSearchWithLang(search, lang)).toBe(expected);
  });
});

describe('getSearchWithMode', () => {
  test.each([
    ['', 'edgeless', '?mode=edgeless'],
    ['?foo=1&mode=page&bar=2', 'edgeless', '?foo=1&mode=edgeless&bar=2'],
  ] as const)('projects %s with mode %s', (search, mode, expected) => {
    expect(getSearchWithMode(search, mode)).toBe(expected);
  });
});

describe('share page error helpers', () => {
  const permissionError = new UserFriendlyError({
    status: 403,
    code: 'DOC_ACTION_DENIED',
    type: 'DOC_ACTION_DENIED',
    name: 'DOC_ACTION_DENIED',
    message: 'forbidden',
  });
  test.each([
    [permissionError, true, false],
    [new TimeoutError(), false, true],
    [new Error('x'), false, false],
  ])('classifies %s', (error, permission, timeout) => {
    expect(isSharePagePermissionError(error)).toBe(permission);
    expect(isSharePageTimeoutError(error)).toBe(timeout);
  });
});

describe('share workspace lifecycle', () => {
  afterEach(() => {
    sharePageMocks.services.clear();
    vi.restoreAllMocks();
  });

  test.each([
    ['fr', 'fr'],
    ['it', undefined],
  ])(
    '?lang=%s opens the shared doc with translation %s',
    async (lang, expected) => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        Response.json({ sourceLang: 'en', languages: ['fr'] })
      );
      const open = vi.fn(
        (_options: unknown, _engineOptions?: WorkerInitOptions) => ({
          workspace: {
            id: 'workspace-id',
            scope: {
              get: (token: { name: string }) =>
                token.name === 'WorkbenchService'
                  ? { workbench: { updateBasename: vi.fn() } }
                  : undefined,
            },
            // Never loads: only the options passed to open matter here.
            engine: { doc: { waitForDocLoaded: () => new Promise(() => {}) } },
          },
          dispose: vi.fn(),
        })
      );
      sharePageMocks.services.set('ServerService', {
        server: { baseUrl: 'https://app.affine.pro' },
      });
      sharePageMocks.services.set('WorkspacesService', { open });

      const view = render(
        createElement(
          MemoryRouter,
          {
            initialEntries: [
              `/share/workspace-id/doc-id?mode=page&lang=${lang}`,
            ],
          },
          createElement(SharePage, {
            workspaceId: 'workspace-id',
            docId: 'doc-id',
          })
        )
      );
      await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
      const docOptions = open.mock.calls[0]?.[1]?.local.doc?.opts as {
        publicDocLang?: string;
      };
      expect(docOptions.publicDocLang).toBe(expected);
      view.unmount();
    }
  );

  test.each(['workspace-id', 'doc-id'])(
    'aborts %s loading before disposing after unmount',
    async pendingDocId => {
      const lifecycle: string[] = [];
      let resolvePending!: () => void;
      let rejectPending!: (reason: unknown) => void;
      const pending = new Promise<void>((resolve, reject) => {
        resolvePending = resolve;
        rejectPending = reject;
      });
      const settled = pending.catch(error => error);
      const dispose = vi.fn(() => lifecycle.push('dispose'));
      const scopeGet = vi.fn((token: { name: string }) => {
        if (token.name === 'WorkbenchService') {
          return { workbench: { updateBasename: vi.fn() } };
        }
        if (token.name === 'DocsService') {
          return {
            list: { doc$: () => ({ value: { id: 'doc-id' } }) },
            open: () => ({
              doc: { blockSuiteDoc: { load: vi.fn(), readonly: false } },
            }),
          };
        }
        throw new Error(`Unexpected scope service: ${token.name}`);
      });
      const sharedWorkspace = {
        id: 'workspace-id',
        scope: { get: scopeGet },
        engine: {
          doc: {
            waitForDocLoaded: vi.fn((docId: string, signal?: AbortSignal) => {
              if (docId !== pendingDocId) return Promise.resolve();
              signal?.addEventListener(
                'abort',
                () => {
                  lifecycle.push('abort');
                  rejectPending(signal.reason);
                },
                { once: true }
              );
              return pending;
            }),
          },
        },
      };
      const open = vi.fn(
        (_options: unknown, _engineOptions?: WorkerInitOptions) => ({
          workspace: sharedWorkspace,
          dispose,
        })
      );
      sharePageMocks.services.set('ServerService', {
        server: { baseUrl: 'https://app.affine.pro' },
      });
      sharePageMocks.services.set('WorkspacesService', { open });

      const view = render(
        createElement(
          MemoryRouter,
          { initialEntries: ['/share/workspace-id/doc-id?mode=page'] },
          createElement(SharePage, {
            workspaceId: 'workspace-id',
            docId: 'doc-id',
          })
        )
      );
      await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(
          sharedWorkspace.engine.doc.waitForDocLoaded
        ).toHaveBeenCalledWith(pendingDocId, expect.any(AbortSignal))
      );
      view.unmount();
      await act(async () => {
        resolvePending();
        await settled;
      });
      expect(lifecycle).toEqual(['abort', 'dispose']);
      const signals =
        sharedWorkspace.engine.doc.waitForDocLoaded.mock.calls.map(
          call => call[1]
        );
      expect(
        signals.every(signal => signal === signals[0] && signal?.aborted)
      ).toBe(true);
      expect(
        scopeGet.mock.calls.filter(([token]) => token.name === 'DocsService')
      ).toHaveLength(pendingDocId === 'doc-id' ? 1 : 0);

      const engineOptions = open.mock.calls[0]?.[1];
      if (!engineOptions) {
        throw new Error('Expected custom workspace engine options');
      }
      expect({
        disposeCalls: dispose.mock.calls.length,
        blob: {
          local: engineOptions.local.blob,
          remote: engineOptions.remotes.cloud.blob,
        },
      }).toMatchInlineSnapshot(`
      {
        "blob": {
          "local": {
            "name": "IndexedDBBlobStorage",
            "opts": {
              "flavour": "affine-cloud",
              "id": "workspace-id",
              "type": "workspace",
            },
          },
          "remote": {
            "name": "CloudBlobStorage",
            "opts": {
              "id": "workspace-id",
              "serverBaseUrl": "https://app.affine.pro",
            },
          },
        },
        "disposeCalls": 1,
      }
    `);
    }
  );
});
