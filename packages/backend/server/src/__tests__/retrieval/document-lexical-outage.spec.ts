import test from 'ava';

import {
  SearchIndexFailed,
  SearchIndexNotReady,
  SearchPermissionSyncing,
  SearchProviderUnavailable,
} from '../../base';
import type { DocReader } from '../../core/doc';
import type { PermissionAccess } from '../../core/permission';
import type { Models } from '../../models';
import type { IndexerService } from '../../plugins/indexer/service';
import type { SearchDoc } from '../../plugins/indexer/types';
import { NullDocumentVectorSearch } from '../../plugins/mcp/vector-search';
import { DocumentRetrievalService } from '../../plugins/retrieval';

const options = { user: 'user-1', workspace: 'workspace-1' };

const lexicalHit = {
  docId: 'doc-1',
  blockId: 'block-1',
  unitId: 'block:doc-1:block-1',
  projectionVersion: 1,
  sourceHash: 'hash-1',
  visibility: 'page',
  title: 'Lexical title',
  highlight: 'lexical passage',
  createdAt: new Date(1),
  updatedAt: new Date(1),
} as unknown as SearchDoc;

/**
 * The MCP module binds DOCUMENT_VECTOR_SEARCH to `NullDocumentVectorSearch`, so
 * the vector channel is permanently absent there and every degradation decision
 * hangs off the lexical channel alone. The real stub is used rather than a
 * hand-rolled one so `canEmbedding === false` stays honest.
 */
function buildService(
  searchDocsByKeyword: () => Promise<SearchDoc[]>,
  readDocIds: string[] = []
) {
  const ac = {
    user: () => ({
      workspace: () => ({
        docs: async <T extends { docId: string }>(candidates: T[]) =>
          candidates,
      }),
    }),
  } as unknown as PermissionAccess;
  const indexer = { searchDocsByKeyword } as unknown as IndexerService;
  const models = {
    doc: { findMetas: async () => [] },
  } as unknown as Models;
  const docReader = {
    getDocMarkdown: async (_workspaceId: string, docId: string) => {
      readDocIds.push(docId);
      return { title: docId, markdown: `${docId} content`, revision: '1' };
    },
  } as unknown as DocReader;
  return new DocumentRetrievalService(
    ac,
    indexer,
    new NullDocumentVectorSearch(),
    models,
    docReader
  );
}

function rejectingService(error: unknown, readDocIds: string[] = []) {
  return buildService(async () => {
    throw error;
  }, readDocIds);
}

for (const [name, error, degradedReason] of [
  [
    'index building',
    new SearchIndexNotReady({ spaceId: 'workspace-1' }),
    'INDEX_BUILDING',
  ],
  ['permission syncing', new SearchPermissionSyncing(), 'PERMISSION_SYNCING'],
] as const) {
  test(`self-healing lexical outage (${name}) degrades instead of throwing`, async t => {
    const readDocIds: string[] = [];
    const service = rejectingService(error, readDocIds);
    const result = await service.search(options, 'query', undefined, 10);
    t.deepEqual(result, {
      retrievalMode: 'none',
      degradedReason,
      hits: [],
    });
    // the scoped fallback must not have been entered
    t.deepEqual(readDocIds, []);
  });
}

test('an unavailable provider keeps its upstream hard-error handling', async t => {
  // `SearchProviderUnavailable` is indistinguishable from a *misconfigured*
  // provider, which never heals, so it is deliberately excluded from the
  // self-healing set: it still resolves to null and, with no vector channel and
  // no docIds, still surfaces as a bare `SEARCH_UNAVAILABLE`.
  const readDocIds: string[] = [];
  const service = rejectingService(new SearchProviderUnavailable(), readDocIds);
  const error = await t.throwsAsync(() =>
    service.search(options, 'query', undefined, 10)
  );
  t.is(error?.message, 'SEARCH_UNAVAILABLE');
  t.deepEqual(readDocIds, []);
});

test('a failed index stays a hard error and keeps its identity', async t => {
  // `available_at = 'infinity'` parks the workspace forever, so it needs an
  // operator: it must never be softened into a degraded empty result, and must
  // not be flattened into a bare `SEARCH_UNAVAILABLE` either.
  const failure = new SearchIndexFailed({ diagnosticId: 'diag-1' });
  const service = rejectingService(failure);
  const error = await t.throwsAsync(
    service.search(options, 'query', undefined, 10),
    { instanceOf: SearchIndexFailed }
  );
  t.is(error, failure);
  t.not(error?.message, 'SEARCH_UNAVAILABLE');
});

test('an unrecognised lexical error propagates unchanged', async t => {
  const failure = new Error('boom');
  const service = rejectingService(failure);
  const error = await t.throwsAsync(
    service.search(options, 'query', undefined, 10),
    { message: 'boom' }
  );
  t.is(error, failure);
});

test('lexical hits report a vector-only degradation', async t => {
  const service = buildService(async () => [lexicalHit]);
  const result = await service.search(options, 'query', undefined, 10);
  t.is(result.retrievalMode, 'lexical');
  t.is(result.degradedReason, 'VECTOR_UNAVAILABLE');
  t.deepEqual(
    result.hits.map(hit => hit.docId),
    ['doc-1']
  );
});

test('an empty lexical result is a successful search, not an outage', async t => {
  const readDocIds: string[] = [];
  const service = buildService(async () => [], readDocIds);
  const result = await service.search(options, 'query', undefined, 10);
  t.deepEqual(result, {
    retrievalMode: 'lexical',
    degradedReason: 'VECTOR_UNAVAILABLE',
    hits: [],
  });
  t.deepEqual(readDocIds, []);
});

test('a fatal lexical error with docIds still takes the scoped fallback', async t => {
  const readDocIds: string[] = [];
  const service = rejectingService(
    new SearchIndexFailed({ diagnosticId: 'diag-1' }),
    readDocIds
  );
  const result = await service.search(options, 'query', ['doc-1'], 10);
  t.is(result.retrievalMode, 'scoped');
  t.is(result.degradedReason, 'SEARCH_UNAVAILABLE');
  t.deepEqual(
    result.hits.map(hit => [hit.docId, hit.excerpt]),
    [['doc-1', 'doc-1 content']]
  );
  t.deepEqual(readDocIds, ['doc-1']);
});
