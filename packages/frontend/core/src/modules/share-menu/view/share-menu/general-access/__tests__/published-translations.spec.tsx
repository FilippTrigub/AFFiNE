// @vitest-environment happy-dom

import type * as AffineI18n from '@affine/i18n';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type * as Infra from '@toeverything/infra';
import { LiveData } from '@toeverything/infra';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { PublishedTranslations } from '../published-translations';

const mocks = vi.hoisted(() => ({ service: null as unknown }));

vi.mock('@affine/i18n', async importOriginal => ({
  ...(await importOriginal<typeof AffineI18n>()),
  useI18n: () => new Proxy({}, { get: (_target, key) => () => String(key) }),
}));

vi.mock('@toeverything/infra', async importOriginal => ({
  ...(await importOriginal<typeof Infra>()),
  useService: () => mocks.service,
}));

function fakeService(options: {
  available: boolean;
  rows?: { lang: string; sourceLang: string; status: string }[];
}) {
  const translations$ = new LiveData(
    (options.rows ?? []).map(row => ({
      title: null,
      error: null,
      sourceTimestamp: null,
      outOfDate: false,
      ...row,
    }))
  );
  const service = {
    available$: new LiveData(options.available),
    translations$,
    inProgress$: new LiveData(false),
    revalidate: vi.fn().mockResolvedValue(undefined),
    setLanguages: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
  };
  mocks.service = service;
  return service;
}

describe('PublishedTranslations', () => {
  afterEach(() => {
    cleanup();
    mocks.service = null;
  });

  test('renders nothing while the server has translation off', () => {
    fakeService({ available: false });
    const { container } = render(<PublishedTranslations />);
    expect(container.textContent).toBe('');
  });

  test('ticking a language adds it to the published set', async () => {
    const service = fakeService({
      available: true,
      rows: [{ lang: 'fr', sourceLang: 'en', status: 'ready' }],
    });
    render(<PublishedTranslations />);

    fireEvent.click(
      screen
        .getByTestId('share-menu-translation-de')
        .querySelector('input') as HTMLInputElement
    );

    await waitFor(() =>
      expect(service.setLanguages).toHaveBeenCalledWith('en', ['fr', 'de'])
    );
  });

  test('clicking a language name ticks it', async () => {
    const service = fakeService({
      available: true,
      rows: [{ lang: 'fr', sourceLang: 'en', status: 'ready' }],
    });
    render(<PublishedTranslations />);

    fireEvent.click(screen.getByText('Deutsch'));

    await waitFor(() =>
      expect(service.setLanguages).toHaveBeenCalledWith('en', ['fr', 'de'])
    );
  });

  test('the source picker names the source language', () => {
    fakeService({
      available: true,
      rows: [{ lang: 'fr', sourceLang: 'en', status: 'ready' }],
    });
    render(<PublishedTranslations />);

    expect(
      screen.getByTestId('share-menu-translations-source').textContent
    ).toContain('English');
  });

  test('the source language is not offered as a target', () => {
    fakeService({
      available: true,
      rows: [{ lang: 'fr', sourceLang: 'de', status: 'ready' }],
    });
    render(<PublishedTranslations />);

    expect(screen.queryByTestId('share-menu-translation-de')).toBeNull();
    expect(screen.getByTestId('share-menu-translation-en')).toBeTruthy();
  });
});
