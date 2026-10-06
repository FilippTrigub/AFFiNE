import type { DocTranslationStatus } from '@affine/graphql';
import { Framework } from '@toeverything/infra';
import { describe, expect, test, vi } from 'vitest';

import {
  type DocTranslation,
  DocTranslationsService,
} from '../services/doc-translations';
import type { DocTranslationsStore } from '../stores/doc-translations';

const row = (
  lang: string,
  status: `${DocTranslationStatus}` = 'pending'
): DocTranslation => ({
  lang,
  sourceLang: 'en',
  status: status as DocTranslationStatus,
  title: null,
  error: null,
  sourceTimestamp: null,
  outOfDate: false,
});

function service(store: Partial<DocTranslationsStore>) {
  const framework = new Framework();
  framework.service(
    DocTranslationsService,
    () =>
      new DocTranslationsService(
        { workspace: { id: 'ws' } } as never,
        { doc: { id: 'doc' } } as never,
        store as DocTranslationsStore
      )
  );
  return framework.provider().get(DocTranslationsService);
}

describe('DocTranslationsService', () => {
  test('loads the rows of the current doc', async () => {
    const list = vi.fn().mockResolvedValue([row('fr', 'ready')]);
    const translations = service({ list });

    await translations.revalidate();

    expect(list).toHaveBeenCalledWith('ws', 'doc');
    expect(translations.translations$.value).toEqual([row('fr', 'ready')]);
    expect(translations.available$.value).toBe(true);
  });

  test('marks the feature unavailable when the server refuses', async () => {
    const translations = service({
      list: vi
        .fn()
        .mockRejectedValue(new Error('Doc translation is disabled.')),
    });

    await translations.revalidate();

    expect(translations.available$.value).toBe(false);
    expect(translations.translations$.value).toEqual([]);
  });

  test('setLanguages stores what the server returns', async () => {
    const set = vi.fn().mockResolvedValue([row('de'), row('fr')]);
    const translations = service({ set });

    await translations.setLanguages('en', ['fr', 'de']);

    expect(set).toHaveBeenCalledWith('ws', 'doc', 'en', ['fr', 'de']);
    expect(translations.translations$.value.map(r => r.lang)).toEqual([
      'de',
      'fr',
    ]);
  });

  test('inProgress$ is true while any language is queued or running', async () => {
    const translations = service({
      refresh: vi
        .fn()
        .mockResolvedValue([row('fr', 'running'), row('de', 'ready')]),
    });

    await translations.refresh();
    expect(translations.inProgress$.value).toBe(true);

    translations.translations$.value = [row('fr', 'ready')];
    expect(translations.inProgress$.value).toBe(false);
  });
});
